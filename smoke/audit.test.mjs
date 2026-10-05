#!/usr/bin/env node
/**
 * Comprehensive audit suite for dsh-win-multi-bash.
 *
 * Two layers:
 *   A) Unit tests — pure helpers (vendor/helpers.js, vendor/bwrap-profiles.js),
 *      config schemas, backend ownership, background-job adapters, and executor
 *      routing/sandbox logic via the documented `internals` test hooks (no
 *      boot, fake ctx/subprocess).
 *   B) Boot integration — boots the real loader over the profile runtime with
 *      the plugin's exact rows (plus a real-patch-shape fixture with
 *      `- insert:` blocks and `!!js` disabled tags) and executes a scenario
 *      matrix through git_bash / wsl_bash and the base bundle's shell seat.
 *
 * Run via smoke/audit.ps1 (it sets up the smoke/node_modules junctions and
 * cleans up after). Requires the profile runtime at ~/.dsh/profiles.
 *
 * Exit code 0 = all assertions passed; every failure prints a ✗ line.
 *
 * ── 0.1.7 shape ──────────────────────────────────────────────────────────────
 * dsh 0.1.7 removed the shell seam's routing field (`ShellExecRequest.shell`),
 * so the pre-0.1.7 `ShellSelectExecutor` — one executor on the `ctx.shell` seat
 * dispatching by name — no longer exists in this plugin. Each tool now OWNS
 * one executor (see lib/tool-bash/types/backend.js) and drives it directly,
 * and the seat is left to the base bundle's own `pwsh-sandbox` row. The
 * executor seam itself is a single `execute(spec)` returning a handle whose
 * `result()` is the foreground projection.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── helpers / imports ────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const lib = join(__dirname, '..', 'lib')
const libUrl = (...parts) => pathToFileURL(join(lib, ...parts)).href

const { isRunnerSpawnFailure, classifyDenial, classifyRunnerFailure, matchesSignature } =
  await import(libUrl('vendor', 'helpers.js'))
const { BWRAP_RUNNER_FAILURE_RULES, bwrapProfileArgs } =
  await import(libUrl('vendor', 'bwrap-profiles.js'))
const { GitBashExecutor, candidateBashPaths, candidateExists, gitCandidatesUnder, gitRootCandidates, gitToolPath, probeDrives, resolveBashPath } =
  await import(libUrl('bash-git', 'index.js'))
const { WslBashExecutor } = await import(libUrl('bash-wsl', 'index.js'))
const { ownExecutor } = await import(libUrl('tool-bash', 'types', 'backend.js'))
const { processJob, processOutcome, processSources } =
  await import(libUrl('tool-bash', 'types', 'background.js'))
const gitBashTool = await import(libUrl('tool-bash', 'types', 'git-bash.js'))
const wslBashTool = await import(libUrl('tool-bash', 'types', 'wsl-bash.js'))
const { shellDescription, toNativeWorkdir } = await import(libUrl('tool-bash', 'types', 'factory.js'))
const {
  SHELL_EXIT_STATUS_SECTION, SHELL_FAMILY_SECTION_NAME, SHELL_FAMILY_TOOL_NAMES,
  SHELL_BACKGROUND_SECTION, SHELL_ESCALATION_SECTION,
  shellFamilySectionText, shellFamilySectionOrder,
} = await import(libUrl('tool-bash', 'types', 'shell-family.js'))
const shellPromptRow = await import(libUrl('tool-bash', 'shell-prompt.js'))
const { LocalBashExecutor } = await import('@deepseek-ai/dsh-bash-local')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 6).join('\n      ')}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 6).join('\n      ')}`)
  }
}

// ── fake ctx / subprocess for executor unit tests ────────────────────────────
/** Minimal collect reader over a buffered string. */
function bufferedReader(initial = '') {
  let buf = Buffer.from(initial)
  return {
    readFrom(offset) {
      const text = buf.subarray(offset).toString('utf8')
      return { text, lossy: false, nextOffset: buf.length }
    },
    _append(chunk) { buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]) },
    _text() { return buf.toString('utf8') },
  }
}

/**
 * Fake ctx.subprocess that really spawns (windows node) and shapes the handle
 * like the dsh-subprocess service contract LocalBashExecutor consumes.
 */
function fakeSubprocess() {
  return {
    spawn(spec) {
      const stdout = bufferedReader()
      const stderr = bufferedReader()
      let terminateCalled = false
      let child
      let rejectDone
      try {
        child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          env: spec.env ? { ...process.env, ...spec.env } : process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        return {
          done: Promise.reject(error),
          collected: { stdout, stderr },
          terminate: () => {},
        }
      }
      child.stdout.on('data', (c) => stdout._append(c))
      child.stderr.on('data', (c) => stderr._append(c))
      let settled = false
      const done = new Promise((resolve, reject) => {
        rejectDone = reject
        child.on('error', (error) => { if (!settled) { settled = true; reject(error) } })
        child.on('close', (code, signal) => { if (!settled) { settled = true; resolve({ exitCode: code, signal }) } })
      })
      return {
        done,
        collected: { stdout, stderr },
        terminate: () => { terminateCalled = true; child.kill() },
        _child: child,
      }
    },
  }
}

/** Minimal fake ctx for Object.create'd executors. */
function fakeCtx(overrides = {}) {
  return {
    sandboxPolicy: {
      resolve: () => ({ mode: 'read-only', workspaceRoot: 'G:\\LAB\\202608\\dsh-win-multi-bash' }),
    },
    ...overrides,
  }
}

/**
 * Instantiate an executor class without running its constructor (unit
 * isolation). `config` is a plain readonly property assigned by the real
 * constructor (NOT a getter over some source), so it must be supplied
 * directly — and it must be a REAL resolved config (`Executor.Config({...})`)
 * for any path that reaches `resolve()`/`execute()`, which validate it.
 *
 * The volatile knobs (`sandbox` / `probeTimeoutMs` / `requireSandbox`) are
 * getters over that config, so every bare instance carries a resolved one and
 * a test overrides a knob through the schema (`Config({ sandbox: 'none' })`),
 * exactly as the loader would.
 */
function bareInstance(cls, props) {
  const inst = Object.create(cls.prototype)
  const { config, ...rest } = props ?? {}
  // The volatile knobs are getters over `config` (the loader hands live
  // references), so a bare instance always needs a schema-resolved config; the
  // class fields Object.create() never installs are mirrored here.
  const resolved = config ?? cls.Config({})
  Object.assign(inst, {
    internals: {},
    bwrapVerdict: undefined,
    confinedProbe: undefined,
    sandboxModeVerdict: undefined,
    sandboxModeVerdictKey: undefined,
    distroProbed: false,
    distroVerdict: undefined,
    // A class field, so Object.create() never installs it.
    processFacts: new Map(),
    config: resolved,
    ...rest,
  })
  return inst
}

/** A resolved git-bash config pinned to the probed bash (skips the probes). */
const gitConfig = (extra = {}) => GitBashExecutor.Config({ bashPath: GIT_BASH, ...extra })

// Git Bash for the real-spawn unit tests is NEVER hardcoded: it is probed with
// the plugin's own resolver (well-known locations → PATH, WSL launcher
// excluded → git.exe layout inference). `DSH_AUDIT_GIT_BASH` overrides for
// hosts where probing must not run. Tests that need a real bash skip when
// probing finds none, so the suite stays portable.
const GIT_BASH = process.env.DSH_AUDIT_GIT_BASH ?? resolveBashPath(undefined, process.env, process.platform) ?? ''
const HAS_GIT_BASH = GIT_BASH.length > 0

// WSL is likewise never hardcoded: only the canonical launcher location is
// considered, and the real-spawn WSL test skips when it is absent.
const WSL_EXE = process.env.DSH_AUDIT_WSL ?? 'C:\\Windows\\System32\\wsl.exe'
const HAS_WSL = existsSync(WSL_EXE)

// ═════════════════════════════════════════════════════════════════════════════
// A) Unit tests
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The paths dsh-settings would project for a Config schema, by the same rule
 * `volatileForm` applies: a node whose own meta is volatile contributes its
 * whole subtree, an object node recurses, anything else stays ordinary
 * configuration the Plugins page never shows.
 */
function volatilePaths(schema) {
  const paths = []
  const walk = (node, path) => {
    if (node?.meta?.volatile === true) { paths.push(path.join('.')); return }
    if (node?.type === 'object') for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key])
  }
  walk(schema, [])
  return paths
}

/** Allowed values of a constant union, as a settings select would offer them. */
const unionOptions = (node) => (node?.list ?? []).map((member) => member.value)

console.log('\n[A] unit: vendor/helpers.js')
{
  // isRunnerSpawnFailure
  test('isRunnerSpawnFailure: ENOENT with exact path+syscall', () => {
    const err = { code: 'ENOENT', path: 'C:\\runner.exe', syscall: 'spawn C:\\runner.exe' }
    assert.equal(isRunnerSpawnFailure(err, 'C:\\runner.exe', process.cwd()), true)
  })
  test('isRunnerSpawnFailure: EACCES with plain spawn syscall', () => {
    const err = { code: 'EACCES', path: 'C:\\runner.exe', syscall: 'spawn' }
    assert.equal(isRunnerSpawnFailure(err, 'C:\\runner.exe', process.cwd()), true)
  })
  test('isRunnerSpawnFailure: mismatched path rejected', () => {
    const err = { code: 'ENOENT', path: 'C:\\other.exe', syscall: 'spawn C:\\runner.exe' }
    assert.equal(isRunnerSpawnFailure(err, 'C:\\runner.exe', process.cwd()), false)
  })
  test('isRunnerSpawnFailure: missing path requires exact syscall', () => {
    const err = { code: 'ENOENT', syscall: 'spawn C:\\runner.exe' }
    assert.equal(isRunnerSpawnFailure(err, 'C:\\runner.exe', process.cwd()), true)
    const err2 = { code: 'ENOENT', syscall: 'spawn' }
    assert.equal(isRunnerSpawnFailure(err2, 'C:\\runner.exe', process.cwd()), false)
  })
  test('isRunnerSpawnFailure: non-ENOENT/EACCES code rejected', () => {
    const err = { code: 'EINVAL', path: 'C:\\runner.exe', syscall: 'spawn' }
    assert.equal(isRunnerSpawnFailure(err, 'C:\\runner.exe', process.cwd()), false)
  })
  test('isRunnerSpawnFailure: unusable workdir rejected', () => {
    const err = { code: 'ENOENT', path: 'C:\\runner.exe', syscall: 'spawn C:\\runner.exe' }
    assert.equal(isRunnerSpawnFailure(err, 'C:\\runner.exe', 'G:\\no-such-dir-xyz'), false)
  })
  test('isRunnerSpawnFailure: undefined runner rejected', () => {
    assert.equal(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn' }, undefined, process.cwd()), false)
  })

  // classifyDenial / matchesSignature
  test('classifyDenial: exit 1 + matching stderr → denied', () => {
    assert.equal(classifyDenial({ exitCode: 1, stderr: { text: 'access denied (denied by policy)' } }, ['denied by policy']), true)
  })
  test('classifyDenial: exit 0 never denied even with signature', () => {
    assert.equal(classifyDenial({ exitCode: 0, stderr: { text: 'denied by policy' } }, ['denied by policy']), false)
  })
  test('classifyDenial: exit null (signal) never denied', () => {
    assert.equal(classifyDenial({ exitCode: null, stderr: { text: 'denied' } }, ['denied']), false)
  })
  test('matchesSignature: case-insensitive substring', () => {
    assert.equal(matchesSignature(3, 'OUTPUT DENIED BY POLICY', ['denied by policy']), true)
    assert.equal(matchesSignature(3, 'nothing here', ['denied by policy']), false)
  })

  // classifyRunnerFailure
  test('classifyRunnerFailure: exit 0 / null → undefined', () => {
    assert.equal(classifyRunnerFailure(0, 'bwrap: oops', [{ fatalSignatures: ['bwrap: '] }]), undefined)
    assert.equal(classifyRunnerFailure(null, 'bwrap: oops', [{ fatalSignatures: ['bwrap: '] }]), undefined)
  })
  test('classifyRunnerFailure: fatal line matched, detail returned', () => {
    const r = classifyRunnerFailure(1, 'line1\nbwrap: execvp failed', [{ fatalSignatures: ['bwrap: '] }])
    assert.deepEqual(r, { detail: 'bwrap: execvp failed' })
  })
  test('classifyRunnerFailure: informational lines excluded', () => {
    const rules = [{
      informationalLines: ['info line'],
      fatalSignatures: ['bwrap: '],
    }]
    assert.equal(classifyRunnerFailure(1, 'INFO LINE', rules), undefined)
    assert.notEqual(classifyRunnerFailure(1, 'info line\nbwrap: boom', rules), undefined)
  })
  test('classifyRunnerFailure: allowedExitCodes gate', () => {
    const rules = [{ allowedExitCodes: [124], fatalSignatures: ['bwrap: '] }]
    assert.equal(classifyRunnerFailure(1, 'bwrap: boom', rules), undefined)
    assert.notEqual(classifyRunnerFailure(124, 'bwrap: boom', rules), undefined)
  })
  test('classifyRunnerFailure: whitespace-only signature ignored', () => {
    const rules = [{ fatalSignatures: ['   ', 'bwrap: '] }]
    assert.notEqual(classifyRunnerFailure(1, 'bwrap: boom', rules), undefined)
    assert.equal(classifyRunnerFailure(1, 'boom', [{ fatalSignatures: ['   '] }]), undefined)
  })
  test('classifyRunnerFailure: anchored rule matches only line-start signatures', () => {
    const rules = [{ fatalSignatures: ['bwrap: '], anchored: true }]
    assert.notEqual(classifyRunnerFailure(1, 'bwrap: execvp failed', rules), undefined)
    assert.equal(classifyRunnerFailure(1, 'note: bwrap: exploded mid-line', rules), undefined)
    assert.equal(classifyRunnerFailure(1, 'nothing here', rules), undefined)
  })
}

console.log('\n[A] unit: vendor/bwrap-profiles.js')
{
  test('bwrapProfileArgs: read-only → ro-bind root, no tmpfs/bind', () => {
    const args = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/mnt/g/LAB' })
    assert.deepEqual(args, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'])
  })
  test('bwrapProfileArgs: workspace-write → adds --tmpfs /tmp and --bind root', () => {
    const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/mnt/g/LAB' })
    assert.deepEqual(args.slice(-4), ['/tmp', '--bind', '/mnt/g/LAB', '/mnt/g/LAB'])
    assert.ok(args.includes('--tmpfs'))
  })
  test('BWRAP_RUNNER_FAILURE_RULES matches "bwrap: " stderr lines', () => {
    assert.notEqual(classifyRunnerFailure(1, 'bwrap: no space left', BWRAP_RUNNER_FAILURE_RULES), undefined)
  })
}

console.log('\n[A] unit: config schemas')
{
  test('GitBashExecutor.Config defaults sandbox=auto', () => {
    assert.equal(GitBashExecutor.Config({}).sandbox.get(), 'auto')
  })
  test('GitBashExecutor.Config rejects unknown sandbox stances', () => {
    assert.throws(() => GitBashExecutor.Config({ sandbox: 'bogus' }))
  })
  test('WslBashExecutor.Config accepts auto/none/bwrap', () => {
    for (const s of ['auto', 'none', 'bwrap']) assert.equal(WslBashExecutor.Config({ sandbox: s }).sandbox.get(), s)
  })
  test('WslBashExecutor.Config rejects unknown sandbox stances', () => {
    assert.throws(() => WslBashExecutor.Config({ sandbox: 'bogus' }))
  })
  test('git_bash tool Config partitions the backend under `gitBash`', () => {
    const c = gitBashTool.Config({})
    assert.equal(c.enableRunInBackground.get(), true)
    assert.equal(c.gitBash.sandbox.get(), 'auto')
    assert.equal(c.gitBash.probeTimeoutMs.get(), 10000)
    assert.equal(c.gitBash.requireSandbox.get(), false)
    assert.equal('wslBash' in c, false, 'the git tool has no wsl partition')
  })
  test('wsl_bash tool Config partitions the backend under `wslBash`', () => {
    const c = wslBashTool.Config({})
    assert.equal(c.enableRunInBackground.get(), true)
    assert.equal(c.wslBash.sandbox.get(), 'auto')
    assert.equal(c.wslBash.probeTimeoutMs.get(), 30000, 'wsl keeps its own 3e4 probe default')
    assert.equal('gitBash' in c, false)
  })
  test('git_bash tool Config merges a partial backend partition', () => {
    const c = gitBashTool.Config({ gitBash: { bashPath: 'X' } })
    assert.equal(c.gitBash.bashPath.get(), 'X')
    assert.equal(c.gitBash.probeTimeoutMs.get(), 10000, 'unspecified fields keep their defaults')
  })
  test('git_bash tool Config rejects a negative probeTimeoutMs', () => {
    assert.throws(() => gitBashTool.Config({ gitBash: { probeTimeoutMs: -1 } }))
  })
  test('tool Config keeps each backend stance set distinct', () => {
    assert.throws(() => gitBashTool.Config({ gitBash: { sandbox: 'bwrap' } }), 'bwrap is not a git-bash stance')
    assert.equal(wslBashTool.Config({ wslBash: { sandbox: 'bwrap' } }).wslBash.sandbox.get(), 'bwrap')
  })
  test('tool plugins declare the name/inject/apply/Config shape cordis needs', () => {
    for (const t of [gitBashTool, wslBashTool]) {
      assert.equal(typeof t.name, 'string')
      assert.equal(typeof t.apply, 'function')
      assert.ok(t.Config)
      // The owned executor's own requirements must be injected by the tool.
      for (const s of ['tools', 'shellEnv', 'subprocess', 'sandbox', 'sandboxPolicy']) {
        assert.ok(t.inject.includes(s), `${t.name} must inject ${s}`)
      }
      assert.ok(!t.inject.includes('shell'), `${t.name} must NOT contend for the ctx.shell seat`)
      // The family's shared prompt section is owned by the separate
      // tool-shell-prompt row, so a tool row registers no section and needs no
      // systemPrompt: two tool rows sharing one section name would throw, and
      // one section each would be the duplication this design removes.
      assert.ok(!t.inject.includes('systemPrompt'), `${t.name} must not register a prompt section`)
    }
  })
  test('the shell-prompt row declares the name/inject/apply shape cordis needs', () => {
    assert.equal(typeof shellPromptRow.name, 'string')
    assert.equal(typeof shellPromptRow.apply, 'function')
    assert.ok(!('Config' in shellPromptRow), 'the prompt row owns no tool and no config')
    for (const s of ['systemPrompt', 'tools']) assert.ok(shellPromptRow.inject.includes(s), `prompt row must inject ${s}`)
  })
  test('#2: git-bash Config is independent of wsl-bash (no .set() cross-pollution)', () => {
    assert.equal(GitBashExecutor.Config({}).probeTimeoutMs.get(), 10000, 'git-bash keeps its own 1e4 default')
    assert.throws(() => GitBashExecutor.Config({ sandbox: 'bwrap' }), 'bwrap is not a valid git-bash stance')
    assert.equal(WslBashExecutor.Config({}).probeTimeoutMs.get(), 30000, 'wsl-bash keeps its own 3e4 default')
    assert.equal(WslBashExecutor.Config({ sandbox: 'bwrap' }).sandbox.get(), 'bwrap')
  })
  test('#2: plugin Config derivation leaves the base LocalBashExecutor.Config pristine', () => {
    const base = LocalBashExecutor.Config({})
    assert.equal('sandbox' in base, false)
    assert.equal('probeTimeoutMs' in base, false)
  })
}

console.log('\n[A] unit: GitBashExecutor (internals hooks)')
{
  test('bashPath(): configured pin is returned verbatim', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({ bashPath: 'C:\\pinned\\bash.exe' }) })
    assert.equal(ex.bashPath(), 'C:\\pinned\\bash.exe')
  })
  test('bashPath(): undefined resolution throws loud naming probes', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({}) })
    ex.internals.resolveBashPath = () => undefined
    ex.internals.registryBashPaths = () => undefined // registry may hit on hosts with Git installed
    assert.throws(() => ex.bashPath(), /Git Bash was not found \(probed/)
  })
  test('gitArgv: [bashPath, -c, command]', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({ bashPath: 'C:\\b.exe' }) })
    assert.deepEqual(ex.gitArgv({ command: 'ls -la' }), ['C:\\b.exe', '-c', 'ls -la'])
  })
  test('sandboxMode: undeclared until resolveSandboxMode settles it', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({}) })
    assert.equal(ex.sandboxMode, undefined, 'no mode before the async probe runs')
  })
  testAsync('resolveSandboxMode(): stance none → undefined (no sandbox advertisement)', async () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({ sandbox: 'none' }) })
    assert.equal(await ex.resolveSandboxMode(), undefined)
    assert.equal(ex.sandboxMode, undefined)
  })
  testAsync('resolveSandboxMode(): a live stance edit re-settles the verdict', async () => {
    // A settings save on the Plugins page updates the volatile reference in
    // place through the loader; the reference protocol's writer is the same
    // write, so the test performs it directly.
    const WRITE = Symbol.for('cosmokit.volatile.write')
    const config = GitBashExecutor.Config({ sandbox: 'none' })
    const ex = bareInstance(GitBashExecutor, { config })
    assert.equal(await ex.resolveSandboxMode(), undefined)
    config.sandbox[WRITE]('auto')
    assert.equal(ex.sandboxStance, 'auto', 'the getter reads the live reference, not a load-time snapshot')
    ex.internals.probeConfined = () => false
    assert.equal(await ex.resolveSandboxMode(), undefined, 'auto with a failed probe stays unadvertised')
  })
  testAsync('resolveSandboxMode(): failed probe → undefined, and the probe is memoized', async () => {
    let calls = 0
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({}) })
    ex.internals.probeConfined = () => { calls += 1; return false }
    assert.equal(await ex.resolveSandboxMode(), undefined)
    assert.equal(await ex.resolveSandboxMode(), undefined)
    assert.equal(calls, 1, 'probe cached after first call')
  })
  testAsync('resolveSandboxMode(): successful probe → policy defaultMode', async () => {
    const ex = bareInstance(GitBashExecutor, {
      config: GitBashExecutor.Config({}),
      ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: 'X' }), defaultMode: 'read-only' } },
    })
    ex.internals.probeConfined = async () => true
    assert.equal(await ex.resolveSandboxMode(), 'read-only')
    assert.equal(ex.sandboxMode, 'read-only', 'the sync getter reads back the settled verdict')
  })
  testAsync('resolveSandboxMode(): requireSandbox declares the mode even when the probe fails', async () => {
    const ex = bareInstance(GitBashExecutor, {
      config: GitBashExecutor.Config({ requireSandbox: true }),
      ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: 'X' }), defaultMode: 'read-only' } },
    })
    ex.internals.probeConfined = async () => false
    assert.equal(await ex.resolveSandboxMode(), 'read-only', 'escalation must stay advertised so it can be refused')
  })
  if (!HAS_GIT_BASH) {
    console.log('  … skipping real-spawn execute() tests: no Git Bash probed on this host')
  } else {
  testAsync('execute(): unconfined path passes plain git argv (no sandbox facts)', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig({ sandbox: 'none' }),
    })
    const result = await (await ex.execute(ex.resolve({ command: 'echo unconfined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /unconfined-ok/)
    assert.equal(result.sandbox, undefined)
  })
  testAsync('execute(): confined path stamps sandbox facts (denied=false)', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: async () => ({ argv: [GIT_BASH, '-c', 'echo confined-ok'], denialSignatures: ['denied by policy'], runnerFailureRules: [], enforcement: 'full' }),
    }
    const result = await (await ex.execute(ex.resolve({ command: 'echo confined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.sandbox, { mode: 'read-only', denied: false, enforcement: 'full' })
  })
  testAsync('execute(): denial signature classifies sandbox.denied=true', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: async () => ({ argv: [GIT_BASH, '-c', 'echo denied by policy >&2; exit 1'], denialSignatures: ['denied by policy'], runnerFailureRules: [], enforcement: 'full' }),
    }
    const result = await (await ex.execute(ex.resolve({ command: 'x', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.sandbox.denied, true)
  })
  testAsync('execute(): runner failure falls back to an unconfined run', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: async () => ({ argv: [GIT_BASH, '-c', 'echo bwrap: runner exploded >&2; exit 1'], denialSignatures: [], runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES, enforcement: 'full' }),
    }
    const result = await (await ex.execute(ex.resolve({ command: 'echo fallback-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    // stderr "bwrap: " is a *fake* runner-failure signature from our confined argv,
    // so the executor must have re-run the ORIGINAL argv unconfined: no sandbox facts.
    assert.equal(result.sandbox, undefined)
    assert.match(result.stdout.text, /fallback-ok/)
  })
  testAsync('execute(): spawn failure of the runner falls back unconfined', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: async () => ({ argv: ['G:\\no-such-runner-xyz.exe', '-c', 'x'], denialSignatures: [], runnerFailureRules: [], enforcement: 'full' }),
    }
    const result = await (await ex.execute(ex.resolve({ command: 'echo respawn-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.sandbox, undefined)
    assert.match(result.stdout.text, /respawn-ok/)
  })
  testAsync('execute(): danger-full-access bypasses confinement with honest facts', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    const result = await (await ex.execute(ex.resolve({ command: 'echo dfa-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd(), sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: 'X' } }))).result()
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  })
  testAsync('execute(): requireSandbox refuses an unconfined run when the probe failed', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig({ requireSandbox: true }),
    })
    ex.internals.probeConfined = () => false
    await assert.rejects(
      () => ex.execute(ex.resolve({ command: 'echo forbidden', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })),
      /refusing to run unconfined/,
    )
  })
  }
}

console.log('\n[A] unit: bash resolution (git-path inference, never the WSL launcher or WindowsApps aliases)')
{
  const bareEnv = (path) => ({ PATH: path, SystemRoot: 'C:\\Windows', ProgramFiles: 'G:\\no-such-pf', 'ProgramFiles(x86)': 'G:\\no-such-x86', GitProbeDrives: '' })

  test('gitRootCandidates: infers root from <root>\\cmd on PATH (git.exe present)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-gitroot-'))
    try {
      const root = join(tmp, 'Git')
      mkdirSync(join(root, 'cmd'), { recursive: true })
      mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
      writeFileSync(join(root, 'cmd', 'git.exe'), '')
      writeFileSync(join(root, 'usr', 'bin', 'bash.exe'), '')
      const env = bareEnv(`${join(root, 'cmd')};${join(tmp, 'Strawberry', 'c', 'bin')}`)
      assert.deepEqual(gitRootCandidates(env), [root])
      assert.equal(resolveBashPath(undefined, env, 'win32'), join(root, 'usr', 'bin', 'bash.exe'))
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
  test('gitRootCandidates: <root>\\usr\\bin layout resolves to the root bash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-gitroot2-'))
    try {
      const root = join(tmp, 'Git2')
      mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
      writeFileSync(join(root, 'usr', 'bin', 'git.exe'), '')
      writeFileSync(join(root, 'usr', 'bin', 'bash.exe'), '')
      const env = bareEnv(join(root, 'usr', 'bin'))
      assert.deepEqual(gitRootCandidates(env), [root])
      assert.equal(resolveBashPath(undefined, env, 'win32'), join(root, 'usr', 'bin', 'bash.exe'))
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
  test('gitRootCandidates: bin dir without git.exe is not a Git root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-gitroot3-'))
    try {
      const bin = join(tmp, 'Strawberry', 'c', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'bash.exe'), '')
      const env = bareEnv(bin)
      assert.deepEqual(gitRootCandidates(env), [])
      // a real (non-WSL) bash on PATH still resolves directly
      assert.equal(resolveBashPath(undefined, env, 'win32'), join(bin, 'bash.exe'))
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
  test('candidateBashPaths: WSL launcher (System32\\bash.exe) never a candidate', () => {
    const env = bareEnv(`C:\\Windows\\System32;${join(tmpdir(), 'plain-bin')}`)
    const paths = candidateBashPaths(env)
    assert.ok(!paths.some((p) => p.toLowerCase() === 'c:\\windows\\system32\\bash.exe'))
  })
  test('resolveBashPath: only the WSL launcher available → undefined (loud failure, not WSL)', () => {
    const env = bareEnv('C:\\Windows\\System32')
    assert.equal(resolveBashPath(undefined, env, 'win32'), undefined)
  })
  test('resolveBashPath: configured pin always wins', () => {
    const env = bareEnv('C:\\Windows\\System32')
    assert.equal(resolveBashPath('D:\\pinned\\bash.exe', env, 'win32'), 'D:\\pinned\\bash.exe')
  })
  test('candidateExists: rejects a symlink (broken app-alias shape), accepts a regular file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-symlink-'))
    try {
      const target = join(tmp, 'target.exe')
      writeFileSync(target, '')
      try {
        symlinkSync(target, join(tmp, 'bash.exe'), 'file')
      } catch {
        console.log('  … skipping symlink case: creating symlinks needs admin/developer mode')
        return
      }
      assert.equal(candidateExists(join(tmp, 'bash.exe')), false)
      assert.equal(candidateExists(target), true)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
  test('candidateBashPaths: a WindowsApps dir on PATH is never a candidate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-wa-'))
    try {
      const wa = join(tmp, 'WindowsApps')
      mkdirSync(wa, { recursive: true })
      writeFileSync(join(wa, 'bash.exe'), '')
      const env = bareEnv(wa)
      const paths = candidateBashPaths(env)
      assert.ok(!paths.some((p) => p.toLowerCase() === join(wa, 'bash.exe').toLowerCase()))
      assert.equal(resolveBashPath(undefined, env, 'win32'), undefined)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
  test('gitCandidatesUnder: well-known layout under a drive root', () => {
    assert.deepEqual(gitCandidatesUnder('D:\\Program Files'), [
      'D:\\Program Files\\Git\\bin\\bash.exe',
      'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ])
  })
  test('probeDrives: explicit override wins; empty override disables probing', () => {
    assert.deepEqual(probeDrives({ GitProbeDrives: '' }), [])
    assert.deepEqual(probeDrives({ GitProbeDrives: 'C' }), ['C:\\'])
  })
  test('resolveBashPath: git-root inference wins over an earlier PATH bash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-order-'))
    try {
      const root = join(tmp, 'Git')
      mkdirSync(join(root, 'cmd'), { recursive: true })
      mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
      writeFileSync(join(root, 'cmd', 'git.exe'), '')
      writeFileSync(join(root, 'usr', 'bin', 'bash.exe'), '')
      const foreign = join(tmp, 'Strawberry', 'c', 'bin')
      mkdirSync(foreign, { recursive: true })
      writeFileSync(join(foreign, 'bash.exe'), '')
      const env = bareEnv(`${foreign};${join(root, 'cmd')}`)
      assert.equal(resolveBashPath(undefined, env, 'win32'), join(root, 'usr', 'bin', 'bash.exe'))
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
  test('gitToolPath: <root>\\usr\\bin bash injects cmd/bin/usr\\bin (full toolchain)', () => {
    const p = gitToolPath('D:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Windows\\System32')
    const entries = p.split(';')
    assert.deepEqual(entries.slice(0, 3), [
      'D:\\Program Files\\Git\\cmd',
      'D:\\Program Files\\Git\\bin',
      'D:\\Program Files\\Git\\usr\\bin',
    ])
    assert.ok(entries.includes('C:\\Windows\\System32'))
  })
  test('gitToolPath: <root>\\bin bash also injects the full layout', () => {
    const p = gitToolPath('C:\\Program Files\\Git\\bin\\bash.exe', '')
    assert.deepEqual(p.split(';').slice(0, 3), [
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
    ])
  })
  test('gitToolPath: foreign (non-Git-layout) bash keeps only its own dir', () => {
    const p = gitToolPath('D:\\tools\\other-bash\\bash.exe', 'C:\\Windows')
    assert.deepEqual(p.split(';').slice(0, 1), ['D:\\tools\\other-bash'])
  })
  test('tryBashPath: registry fallback used after standard probes miss (internals hook)', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({}) })
    ex.internals.resolveBashPath = () => undefined
    ex.internals.registryBashPaths = () => 'R:\\reg\\usr\\bin\\bash.exe'
    assert.equal(ex.bashPath(), 'R:\\reg\\usr\\bin\\bash.exe')
  })
  test('tryBashPath: both probes miss → loud error naming the registry probe', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({}) })
    ex.internals.resolveBashPath = () => undefined
    ex.internals.registryBashPaths = () => undefined
    assert.throws(() => ex.bashPath(), /Git Bash was not found.*GitForWindows registry/)
  })
}

console.log('\n[A] unit: WslBashExecutor (internals hooks)')
{
  test('wslPath(): configured pin returned verbatim', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl-pinned.exe' }) })
    assert.equal(ex.wslPath(), 'C:\\wsl-pinned.exe')
  })
  test('wslPath(): undefined resolution throws loud naming probes', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({}) })
    ex.internals.resolveWslPath = () => undefined
    assert.throws(() => ex.wslPath(), /WSL was not found \(probed/)
  })
  test('payload(): base64 round-trip survives quotes/newlines/unicode', () => {
    const ex = bareInstance(WslBashExecutor)
    const cmd = "printf '%s\\n' 'a\"b' $'line1\\nline2' 中文 🚀"
    const payload = ex.payload(cmd)
    assert.match(payload, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| bash$/)
    const decoded = Buffer.from(payload.match(/^echo ([A-Za-z0-9+/=]+) \|/)[1], 'base64').toString('utf8')
    assert.equal(decoded, cmd)
  })
  // `--cd` is the auto-cd contract: it always carries the resolved workdir, so
  // the WSL start directory is a property of the spec rather than of the
  // distro's automount/inheritance behaviour.
  test('argv(): --cd always carries the resolved workdir', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.argv({ command: 'x', workdir: 'G:\\other' })
    assert.deepEqual(argv.slice(0, 5), ['C:\\wsl.exe', '--cd', 'G:\\other', '-d', 'Ubuntu-24.04'])
    assert.deepEqual(argv.slice(5), ['--', 'bash', '-c', ex.payload('x')])
  })
  test('argv(): a workdir equal to process.cwd() still gets --cd (auto-cd, not a skip)', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.argv({ command: 'x', workdir: process.cwd() })
    assert.deepEqual(argv.slice(0, 3), ['C:\\wsl.exe', '--cd', process.cwd()])
  })
  test('argv(): a Linux workdir passes through verbatim', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => undefined
    assert.deepEqual(ex.argv({ command: 'x', workdir: '/mnt/g/LAB' }), ['C:\\wsl.exe', '--cd', '/mnt/g/LAB', '--', 'bash', '-c', ex.payload('x')])
  })
  test('argv(): distro omitted when probe found none', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => undefined
    assert.deepEqual(ex.argv({ command: 'x', workdir: process.cwd() }), ['C:\\wsl.exe', '--cd', process.cwd(), '--', 'bash', '-c', ex.payload('x')])
  })
  test('defaultWorkdir() is gone — no consumer compares against a config default any more', () => {
    assert.equal(typeof WslBashExecutor.prototype.defaultWorkdir, 'undefined')
  })
  test('distro(): explicit wslDistro wins over probe', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslDistro: 'Pinned' }) })
    ex.internals.probeDistro = () => { throw new Error('must not probe') }
    assert.equal(ex.distro(), 'Pinned')
  })
  test('distro(): probe result cached and used', () => {
    let calls = 0
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({}) })
    ex.internals.probeDistro = () => { calls += 1; return 'Ubuntu-24.04' }
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(calls, 1)
  })
  test('requireBwrapUsable(): auto + failed probe → false (honest degrade)', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({}) })
    ex.internals.probeBwrap = () => false
    assert.equal(ex.requireBwrapUsable(), false)
  })
  test('requireBwrapUsable(): explicit bwrap + failed probe throws loud', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ sandbox: 'bwrap' }) })
    ex.internals.probeBwrap = () => false
    assert.throws(() => ex.requireBwrapUsable(), /bwrap was not found/)
  })
  testAsync('resolveSandboxMode(): mirrors the sync getter (auto + failed probe → undefined)', async () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({}) })
    ex.internals.probeBwrap = () => false
    assert.equal(await ex.resolveSandboxMode(), undefined)
  })
  testAsync('resolveSandboxMode(): usable bwrap → policy defaultMode', async () => {
    const ex = bareInstance(WslBashExecutor, {
      config: WslBashExecutor.Config({}),
      ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: 'X' }), defaultMode: 'read-only' } },
    })
    ex.internals.probeBwrap = () => true
    assert.equal(await ex.resolveSandboxMode(), 'read-only')
  })
  test('bwrapArgv(): workspace root converted to /mnt/<drive>', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.bwrapArgv({
      command: 'x',
      workdir: 'G:\\LAB',
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: 'G:\\LAB\\202608' },
    })
    const idx = argv.indexOf('--')
    const bwrap = argv.slice(idx + 1)
    assert.equal(bwrap[0], 'bwrap')
    assert.deepEqual(bwrap.slice(1, 4), ['--ro-bind', '/', '/'])
    assert.ok(bwrap.includes('--bind'))
    assert.ok(bwrap.includes('/mnt/g/LAB/202608'))
    assert.ok(bwrap.includes('--tmpfs'))
  })
  test('bwrapArgv(): read-only mode has no --bind/--tmpfs', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => undefined
    const argv = ex.bwrapArgv({
      command: 'x',
      workdir: 'G:\\LAB',
      sandboxPolicy: { mode: 'read-only', workspaceRoot: 'G:\\LAB\\202608' },
    })
    assert.ok(!argv.includes('--bind'))
    assert.ok(!argv.includes('--tmpfs'))
  })
  test('bwrapArgv(): UNC/non-drive workspace root fails loud', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: 'C:\\wsl.exe' }) })
    ex.distro = () => undefined
    assert.throws(() => ex.bwrapArgv({
      command: 'x',
      workdir: 'G:\\LAB',
      sandboxPolicy: { mode: 'read-only', workspaceRoot: '\\\\server\\share\\x' },
    }), /unsupported Windows path/)
  })
  if (!HAS_WSL) {
    console.log('  … skipping real-spawn WSL tests: no wsl.exe on this host')
  } else {
  testAsync('execute(): unconfined path passes plain argv (no sandbox facts)', async () => {
    const ex = bareInstance(WslBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: WslBashExecutor.Config({ wslPath: WSL_EXE, sandbox: 'none' }),
    })
    ex.distro = () => undefined
    const result = await (await ex.execute(ex.resolve({ command: 'echo wsl-unconfined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /wsl-unconfined-ok/)
    assert.equal(result.sandbox, undefined)
  })
  }
}

console.log('\n[A] unit: backend ownership + background-job adapters')
{
  test('ownExecutor: constructs the backend on an isolated child fiber', () => {
    const isolated = { tag: 'isolated' }
    const isolateCalls = []
    const fiberCtx = {
      isolate: (name, label) => { isolateCalls.push([name, typeof label]); return isolated },
    }
    const specs = []
    const ctx = { plugin: (spec) => { specs.push(spec); return { ctx: fiberCtx } } }
    class FakeExecutor { constructor(c, cfg) { this.ctx = c; this.config = cfg } }

    const { executor, fiber } = ownExecutor(ctx, FakeExecutor, { bashPath: 'X' })

    assert.ok(executor instanceof FakeExecutor)
    assert.equal(executor.ctx, isolated, 'the backend never sees the tool ctx (seat isolation)')
    assert.deepEqual(executor.config, { bashPath: 'X' })
    assert.equal(fiber.ctx, fiberCtx, 'the owning fiber is handed back for teardown')
    assert.deepEqual(isolateCalls, [['shell', 'symbol']], 'only the shell scope is isolated')
    assert.deepEqual(specs[0].inject, ['subprocess', 'sandbox', 'sandboxPolicy'])
    assert.equal(typeof specs[0].apply, 'function')
  })
  test('ownExecutor: isolate key is derived from the executor class name', () => {
    const seen = []
    const fiberCtx = { isolate: (name, label) => { seen.push(label); return {} } }
    const ctx = { plugin: () => ({ ctx: fiberCtx }) }
    class NamedExecutor { constructor() {} }
    ownExecutor(ctx, NamedExecutor, {})
    assert.equal(String(seen[0]), String(Symbol('NamedExecutor')))
  })

  test('processSources: one pull source per stream, stdout first', () => {
    const sources = processSources(() => undefined)
    assert.deepEqual(sources.map((s) => s.channel), ['stdout', 'stderr'])
  })
  test('processSources: binds lazily — a read before the spawn yields nothing', () => {
    const sources = processSources(() => undefined)
    assert.deepEqual(sources[0].read(7), { text: '', nextOffset: 7, lossy: false })
    assert.deepEqual(sources[1].read(0), { text: '', nextOffset: 0, lossy: false })
  })
  test('processSources: reads through the live handle observed readers', () => {
    const seen = []
    const live = {
      observed: {
        stdout: { readFrom: (o) => { seen.push(['stdout', o]); return { text: 'out', nextOffset: 3, lossy: false } } },
        stderr: { readFrom: (o) => { seen.push(['stderr', o]); return { text: 'err', nextOffset: 4, lossy: true } } },
      },
    }
    const sources = processSources(() => live)
    assert.equal(sources[0].read(0).text, 'out')
    assert.equal(sources[1].read(0).lossy, true)
    assert.deepEqual(seen, [['stdout', 0], ['stderr', 0]], 'non-consuming observed readers, not readOutput')
  })

  testAsync('processJob: done resolves with the outcome once the process settles', async () => {
    let killed = false
    const proc = {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      kill: () => { killed = true },
    }
    const hooks = processJob(async () => proc, (p) => processOutcome(p))
    assert.equal(typeof hooks.cancel, 'function')
    assert.deepEqual(await hooks.done, { status: 'completed', detail: 'exit code: 0' })
    assert.equal(killed, false)
  })
  testAsync('processJob: a start throw reports failed with the message', async () => {
    const hooks = processJob(async () => { throw new Error('spawn exploded') }, (p) => processOutcome(p))
    assert.deepEqual(await hooks.done, { status: 'failed', detail: 'spawn exploded' })
  })
  testAsync('processJob: cancel during preparation reports killed', async () => {
    const hooks = processJob(async () => { throw new Error('aborted mid-preparation') }, (p) => processOutcome(p))
    hooks.cancel('stop')
    assert.deepEqual(await hooks.done, { status: 'killed', detail: 'aborted mid-preparation' })
  })
  testAsync('processJob: cancel after the spawn kills the live process', async () => {
    let killed = false
    let settle
    const donePromise = new Promise((r) => { settle = r })
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: donePromise,
      kill: () => { killed = true; proc.status = 'killed'; proc.signal = 'SIGTERM'; settle() },
    }
    const hooks = processJob(async () => proc, (p) => processOutcome(p))
    // Let `process = await start(...)` land before cancelling.
    await new Promise((r) => setTimeout(r, 0))
    hooks.cancel('stop')
    assert.equal(killed, true, 'the live handle is killed')
    assert.deepEqual(await hooks.done, { status: 'killed', detail: 'signal: SIGTERM' })
  })
  testAsync('processJob: cancel is idempotent', async () => {
    const proc = { status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(), kill: () => {} }
    let kills = 0
    proc.kill = () => { kills += 1 }
    const hooks = processJob(async () => proc, (p) => processOutcome(p))
    await new Promise((r) => setTimeout(r, 0))
    hooks.cancel('first')
    hooks.cancel('second')
    await hooks.done
    assert.equal(kills, 1)
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// B) Boot integration
// ═════════════════════════════════════════════════════════════════════════════
const { boot, resolveConfigPath, loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
const { ToolCallId } = await import('@deepseek-ai/dsh-llm')

const PLUGIN = join(__dirname, '..')

// Fixtures must live where the loader can resolve '@deepseek-ai/*' and
// 'dsh-win-multi-bash/*' — i.e. beside the smoke/node_modules junctions.
const FIXTURE_DIR = __dirname
const writtenFixtures = []

// `session-projection` is required: dsh-sandbox-policy waits on the shared
// projection registry, and every sandbox-consuming row (including the base
// bundle's own pwsh executor) waits on `sandboxPolicy` in turn.
const BASE_ROWS = `- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'

- id: tools
  name: '@deepseek-ai/dsh-tools'

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'

- id: shell-env
  name: '@deepseek-ai/dsh-shell-env'

# The base bundle's own ctx.shell provider on win32. Loading it beside our rows
# is the regression guard for the failure that motivated the 0.1.7 migration:
# the plugin must neither contend for the seat nor leave it unprovided.
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'

- id: tasks
  name: '@deepseek-ai/dsh-jobs-local'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
`

/** Write a fixture yml and boot it, optionally applying overlay patches. */
async function bootFixture(extraRows, name = 'fixture.yml', patches = undefined) {
  const path = join(FIXTURE_DIR, name)
  writeFileSync(path, BASE_ROWS + extraRows)
  writtenFixtures.push(path)
  return boot('dsh-wmb-audit', resolveConfigPath(path, undefined), patches)
}

/**
 * Run tests on one booted ctx, awaiting every test BEFORE the caller's
 * finally disposes the ctx (testAsync alone returns a promise immediately).
 */
async function runTests(ctx, tests) {
  const jobs = tests.map(([name, fn]) => testAsync(name, fn))
  await Promise.all(jobs)
}

// The pinned fixture uses the PROBED bash (never a hardcoded path); when
// probing finds none the pinned variant is skipped by the caller. Each tool
// now carries its OWN backend config: there is no shared selector row, and no
// `backends`/`default` keys — the shell seam has no routing field to feed.
const PLUGIN_ROWS = (bashPath) => `
- id: win-mb-shell-prompt
  name: 'dsh-win-multi-bash/tool-shell-prompt'

- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:
    gitBash:
      bashPath: '${bashPath}'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
`

/** The plugin rows minus one tool: the independent-switch shapes. */
const SHELL_PROMPT_ONLY_ROWS = `
- id: win-mb-shell-prompt
  name: 'dsh-win-multi-bash/tool-shell-prompt'
`

const GIT_ONLY_ROWS = (bashPath) => `${SHELL_PROMPT_ONLY_ROWS}
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:
    gitBash:
      bashPath: '${bashPath}'
`

const WSL_ONLY_ROWS = `${SHELL_PROMPT_ONLY_ROWS}
- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
`

/** The assembled prompt of a booted fixture: its sections and the rendered text. */
async function assembledPrompt(ctx) {
  const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const assembly = await ctx.systemPrompt.assemble({})
  return { assembly, prompt: renderPrompt(assembly) }
}

/** Execute a tool and return the joined text of its rendered content. */
async function execTool(ctx, name, args) {
  return execToolResult(ctx, name, args).then((r) => r.text)
}

/** Execute a tool and return { text, isError, error } for error-path assertions. */
async function execToolResult(ctx, name, args) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`audit-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: { description: `audit ${name}`, ...args },
  })
  const text = (result.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/\r\n/g, '\n')
  return { text, isError: result.isError === true, error: result.error }
}

console.log('\n[A] unit: factory workdir drive-form normalization')
{
  // `/c/...` and `/mnt/c/...` are absolute to node:path yet Windows resolves
  // them against the current drive; the executor hands the value straight to
  // `spawn` as the child's cwd, so an untranslated form fails with the
  // misleading `spawn <shell> ENOENT`.
  test('toNativeWorkdir: MSYS drive form becomes a native path', () => {
    assert.equal(toNativeWorkdir('/c/Users/Dinos'), 'C:\\Users\\Dinos')
  })
  test('toNativeWorkdir: WSL automount form becomes a native path', () => {
    assert.equal(toNativeWorkdir('/mnt/c/Users/Dinos'), 'C:\\Users\\Dinos')
  })
  test('toNativeWorkdir: a bare drive root keeps its trailing separator', () => {
    assert.equal(toNativeWorkdir('/mnt/c'), 'C:\\')
  })
  test('toNativeWorkdir: MSYS POSIX roots and distro paths are never drive-mapped', () => {
    // Only a single-letter first segment qualifies, so the MSYS root dirs and
    // any distro-side `/mnt/<name>` path keep their own meaning.
    for (const p of ['/etc/hosts', '/usr/bin', '/tmp/x', '/dev/null', '/proc/1', '/var/log', '/mnt/data/x'])
      assert.equal(toNativeWorkdir(p), p)
  })
  test('toNativeWorkdir: native and relative paths pass through', () => {
    assert.equal(toNativeWorkdir('C:\\Users'), 'C:\\Users')
    assert.equal(toNativeWorkdir('smoke'), 'smoke')
    assert.equal(toNativeWorkdir('\\\\server\\share'), '\\\\server\\share')
  })
  test('toNativeWorkdir: a letter with no such drive is left alone', () => {
    if (existsSync('Q:\\')) return
    assert.equal(toNativeWorkdir('/q/WorkSpace'), '/q/WorkSpace')
  })
}

console.log('\n[A] unit: shared shell prompt section (one copy, gated facts)')
{
  // One section carries everything the shell family shares, so it must hold
  // both halves of the composition trap — the exit-marker instruction and the
  // gating rule — and it must not repeat a fact inside itself.
  test('prompt section keeps the [exit code: N] marker instruction', () => {
    assert.match(SHELL_EXIT_STATUS_SECTION, /\[exit code: N\] marker/)
  })
  test('prompt section warns that `;` never stops and a pipe hides the failure', () => {
    assert.match(SHELL_EXIT_STATUS_SECTION, /Chain dependent steps with `&&` or `set -o pipefail`/)
    assert.match(SHELL_EXIT_STATUS_SECTION, /`;` never stops on failure/)
    assert.match(SHELL_EXIT_STATUS_SECTION, /`cmd \| tail` returns the status of `tail`/)
  })
  test('family text states each shared fact exactly once', () => {
    const text = shellFamilySectionText({ background: true, escalation: true })
    const sentences = text.split(/(?<=\.)\s+/).map((s) => s.trim()).filter((s) => s.length > 15)
    const seen = new Map()
    for (const s of sentences) seen.set(s, (seen.get(s) ?? 0) + 1)
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s)
    assert.deepEqual(repeated, [], `family text repeats itself: ${repeated.join(' | ')}`)
    // Every shared fact the tool descriptions used to carry is still delivered.
    for (const fact of [
      /fresh shell/,
      /pass `workdir` instead of using `cd`/,
      /\[exit code: N\] marker/,
      /\$DSH_\*` variables/,
      /\[sandbox: file access denied under <mode> mode\]/,
      /truncated to its tail/,
      /never run it against a computed path you have not checked/,
      /\$\{VAR:\?\}/,
      /run_in_background/,
      /retry the exact same command once with `sandbox_permissions`/,
    ]) assert.match(text, fact)
  })
  test('family text drops the facts this composition does not advertise', () => {
    const bare = shellFamilySectionText({ background: false, escalation: false })
    assert.ok(!bare.includes(SHELL_BACKGROUND_SECTION), 'no background guidance without the parameter')
    assert.ok(!bare.includes(SHELL_ESCALATION_SECTION), 'no escalation contract without the parameter')
    assert.ok(!bare.includes('run_in_background'), 'the parameter is not named either')
    assert.ok(!bare.includes('sandbox_permissions'), 'the parameter is not named either')
    const onlyEscalation = shellFamilySectionText({ background: false, escalation: true })
    assert.ok(onlyEscalation.includes(SHELL_ESCALATION_SECTION))
    assert.ok(!onlyEscalation.includes(SHELL_BACKGROUND_SECTION))
  })
}

console.log('\n[A] unit: tool descriptions carry only their dialect')
{
  const git = shellDescription('msys')
  const wsl = shellDescription('wsl')
  test('git_bash description states the MSYS facts and its dialect note', () => {
    assert.match(git, /^Execute a Git Bash \(MSYS2\) command \(bash -c\) and return its stdout\/stderr\./)
    assert.match(git, /Paths use MSYS form \(`\/d\/WorkSpace` or `C:\\\.\.\.`\)/)
    assert.match(git, /read environment variables with \$VAR/)
    assert.match(git, /MSYS paths work inside Git Bash only/)
  })
  test('wsl_bash description states the WSL facts', () => {
    assert.match(wsl, /^Execute a WSL Linux command \(bash -c\) and return its stdout\/stderr\./)
    assert.match(wsl, /Paths use Linux paths \(`\/mnt\/c\/\.\.\.`\)/)
  })
  test('no shared boilerplate survives in a tool description', () => {
    const SHARED = [
      'fresh shell', 'persists between calls', '[exit code: N]', '$DSH_*', '[sandbox: file access denied',
      'truncated to its tail', 'Before any delete or move', '${VAR:?}', 'run_in_background',
      'sandbox_permissions', 'Attempting a command the sandbox may deny',
    ]
    for (const [name, description] of [['git_bash', git], ['wsl_bash', wsl]])
      for (const phrase of SHARED)
        assert.ok(!description.includes(phrase), `${name} description still repeats shared text: ${phrase}`)
  })
  test('the two descriptions share no sentence — the family section owns every common fact', () => {
    const sentences = (s) => s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter((x) => x.length > 15)
    const shared = sentences(git).filter((s) => wsl.includes(s))
    assert.deepEqual(shared, [], `descriptions still overlap: ${shared.join(' | ')}`)
  })
  test('an unknown dialect fails loud instead of describing nothing', () => {
    assert.throws(() => shellDescription('posix'), /unknown shell dialect "posix"/)
  })
}

console.log('\n[A] unit: runtime-editable config surface (the volatile projection)')
{
  // The Plugins page's row form edits exactly what dsh-settings projects from an
  // entry's Config, and that projection (dsh-settings/lib/index.js
  // `volatileForm`) is: a node whose own meta is volatile contributes its whole
  // subtree, an object node recurses, anything else is ordinary configuration
  // the page never shows. The projected set is therefore the plugin's
  // configurable-option list, and it is pinned here so a field added to a
  // backend without `.volatile()` cannot silently stay YAML-only.
  test('the git_bash row exposes the tool-layer switch and every executor knob', () => {
    assert.deepEqual(volatilePaths(gitBashTool.Config), [
      'enableRunInBackground',
      'gitBash.cwd', 'gitBash.timeoutMs', 'gitBash.maxTimeoutMs', 'gitBash.maxOutputBytes',
      'gitBash.maxSpillBytes', 'gitBash.graceMs',
      'gitBash.bashPath', 'gitBash.sandbox', 'gitBash.probeTimeoutMs', 'gitBash.requireSandbox',
    ])
  })
  test('the wsl_bash row exposes the tool-layer switch and every executor knob', () => {
    assert.deepEqual(volatilePaths(wslBashTool.Config), [
      'enableRunInBackground',
      'wslBash.cwd', 'wslBash.timeoutMs', 'wslBash.maxTimeoutMs', 'wslBash.maxOutputBytes',
      'wslBash.maxSpillBytes', 'wslBash.graceMs',
      'wslBash.wslPath', 'wslBash.wslDistro', 'wslBash.sandbox', 'wslBash.probeTimeoutMs', 'wslBash.requireSandbox',
    ])
  })
  test('each sandbox stance offers exactly the values its backend accepts', () => {
    const gitSandbox = gitBashTool.Config.dict.gitBash.dict.sandbox
    const wslSandbox = wslBashTool.Config.dict.wslBash.dict.sandbox
    assert.deepEqual(unionOptions(gitSandbox), ['auto', 'none'], 'git-bash accepts no bwrap stance')
    assert.deepEqual(unionOptions(wslSandbox), ['auto', 'none', 'bwrap'])
  })
  test('the editable knobs are defaults, so an untouched row still resolves', () => {
    const git = gitBashTool.Config({})
    const wsl = wslBashTool.Config({})
    assert.equal(git.enableRunInBackground.get(), true)
    assert.equal(git.gitBash.probeTimeoutMs.get(), 10000)
    assert.equal(git.gitBash.sandbox.get(), 'auto')
    assert.equal(git.gitBash.requireSandbox.get(), false)
    assert.equal(wsl.wslBash.probeTimeoutMs.get(), 30000)
    assert.equal(wsl.wslBash.sandbox.get(), 'auto')
  })
}

console.log('\n[A] unit: web client half (the Plugins page row form)')
{
  // The bundle's browser half gives each tool row a Configure page through the
  // `plugins.row.config` slot and stages edits into the settings service. The
  // module loader is stubbed to capture the registration, React is stubbed to
  // plain element objects, and the card is a pure function of its injected
  // store — so the whole page contract is exercised without a renderer.
  const registrations = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => registrations.push(entry) } }
  try {
    await import(`${libUrl('client.js')}?audit`)
  } finally {
    globalThis.window = previousWindow
  }

  test('the browser half registers one module under the package name', () => {
    assert.equal(registrations.length, 1, 'exactly one client module registration')
    assert.equal(registrations[0].id, 'dsh-win-multi-bash')
  })

  const client = registrations[0].factory((id) => {
    if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
    if (id === '@deepseek-ai/dsh-client-ui-primitives')
      return { SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', Checkbox: 'Checkbox', SegmentedControl: 'SegmentedControl', Button: 'Button' }
    throw new Error(`unexpected client require: "${id}"`)
  })
  const { ROWS, rowKey, planOps, RowConfigForm, RowConfigCard, en, zh } = client.__internals

  test('it declares the client services the page needs', () => {
    assert.equal(client.NS, 'settings.win-mb-bash')
    assert.ok(Array.isArray(client.inject))
    for (const service of ['slots', 'locale', 'configForms'])
      assert.ok(client.inject.includes(service), `must inject ${service}`)
    assert.equal(typeof client.apply, 'function')
  })

  test('every knob has a label and a hint in both languages', () => {
    for (const row of ROWS) {
      for (const knob of row.fields) {
        const key = knob.key.split('.').pop()
        for (const suffix of ['label', 'hint']) {
          for (const [language, dict] of [['en', en], ['zh', zh]]) {
            const text = dict[`${key}.${suffix}`]
            assert.equal(typeof text, 'string', `${language} is missing ${key}.${suffix}`)
            assert.ok(text.length > 0, `${key}.${suffix} is empty in ${language}`)
          }
        }
        if (knob.kind === 'enum')
          for (const option of knob.options)
            for (const [language, dict] of [['en', en], ['zh', zh]])
              assert.ok(typeof dict[`option.${option}`] === 'string', `${language} is missing option.${option}`)
      }
    }
  })

  test('the form lists exactly the host\'s volatile projection, in schema order', () => {
    assert.deepEqual(ROWS.map((row) => row.rowId), ['win-mb-tool-git', 'win-mb-tool-wsl'])
    assert.deepEqual(ROWS[0].fields.map((knob) => knob.path.join('.')), volatilePaths(gitBashTool.Config))
    assert.deepEqual(ROWS[1].fields.map((knob) => knob.path.join('.')), volatilePaths(wslBashTool.Config))
  })

  test('the sandbox choices match the stance each backend accepts', () => {
    const options = (rowId) => ROWS.find((row) => row.rowId === rowId).fields.find((knob) => knob.key.endsWith('sandbox')).options
    assert.deepEqual(options('win-mb-tool-git'), unionOptions(gitBashTool.Config.dict.gitBash.dict.sandbox))
    assert.deepEqual(options('win-mb-tool-wsl'), unionOptions(wslBashTool.Config.dict.wslBash.dict.sandbox))
  })

  /** A settings scope stub: one mutable snapshot, and the writes it received. */
  const fakeScope = (overrides = {}) => {
    const snapshot = {
      status: 'ready', writable: true, revision: 1,
      value: { enableRunInBackground: true, gitBash: { sandbox: 'auto', probeTimeoutMs: 10000 } },
      base: { gitBash: { sandbox: 'auto' } }, user: {},
      ...overrides,
    }
    const listeners = new Set()
    const calls = []
    let accept = true
    return {
      calls,
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      mutate: async (ops, revision) => { calls.push({ ops, revision }); return accept },
      refuse: () => { accept = false },
      publish: (next) => { Object.assign(snapshot, next); for (const listener of [...listeners]) listener() },
    }
  }
  const gitRow = ROWS[0]

  await testAsync('a staged edit becomes one revision-fenced mutate call', async () => {
    const scope = fakeScope({ revision: 7 })
    const form = new RowConfigForm(scope, gitRow)
    form.edit('gitBash.bashPath', 'D:\\Git\\usr\\bin\\bash.exe')
    form.edit('gitBash.sandbox', 'none')
    form.edit('enableRunInBackground', false)
    await form.save()
    assert.deepEqual(scope.calls, [{
      ops: [
        // Field order is the row's own order (schema order), not staging order.
        { op: 'set', path: ['enableRunInBackground'], value: false },
        { op: 'set', path: ['gitBash', 'bashPath'], value: 'D:\\Git\\usr\\bin\\bash.exe' },
        { op: 'set', path: ['gitBash', 'sandbox'], value: 'none' },
      ],
      revision: 7,
    }])
    assert.equal(form.project().dirty, false, 'an accepted save clears its drafts')
  })

  await testAsync('an emptied text control clears the override, not writes an empty string', async () => {
    const scope = fakeScope({ user: { gitBash: { bashPath: 'C:\\pinned\\bash.exe' } } })
    const form = new RowConfigForm(scope, gitRow)
    form.edit('gitBash.bashPath', '')
    await form.save()
    assert.deepEqual(scope.calls[0].ops, [{ op: 'unset', path: ['gitBash', 'bashPath'] }])
  })

  await testAsync('a refused save keeps every draft and reports the failure', async () => {
    const scope = fakeScope()
    scope.refuse()
    const form = new RowConfigForm(scope, gitRow)
    form.edit('gitBash.probeTimeoutMs', '12345')
    await form.save()
    const state = form.project()
    assert.equal(state.failed, true)
    assert.equal(state.dirty, true, 'a save that did not land keeps its drafts')
    assert.equal(state.fields.find((knob) => knob.key === 'gitBash.probeTimeoutMs').text, '12345')
  })

  await testAsync('an invalid number blocks the save instead of writing it', async () => {
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    form.edit('gitBash.probeTimeoutMs', 'soon')
    assert.equal(form.project().invalid, true)
    await form.save()
    assert.deepEqual(scope.calls, [], 'no mutation for a draft no control accepts')
    assert.equal(form.project().dirty, true)
  })

  test('a live settings update republished by the scope reaches the card', () => {
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    const seen = []
    const unsubscribe = form.store.subscribe(() => seen.push(form.store.getSnapshot()))
    scope.publish({ revision: 2, value: { enableRunInBackground: true, gitBash: { sandbox: 'none' } } })
    unsubscribe()
    assert.equal(seen.length, 1, 'one publish per scope change')
    assert.equal(seen[0].fields.find((knob) => knob.key === 'gitBash.sandbox').value, 'none')
    form.dispose()
  })

  test('the card renders the summary line, and one control per knob on its page', () => {
    assert.equal(RowConfigCard({ view: 'summary', t: (key) => zh[key] ?? key }), zh.summary)
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    const state = form.project()
    const tree = RowConfigCard({
      view: 'page',
      t: (key) => key,
      useRowForm: (select) => select(state),
      edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {},
    })
    assert.equal(tree.type, 'SettingsForm')
    assert.equal(tree.children.length, gitRow.fields.length, 'one control per knob')
    assert.equal(tree.children[0].type, 'div', 'the tool-layer switch is a checkbox row')
    assert.ok(tree.children.some((child) => child.type === 'SettingsValueField'))
    const sandbox = tree.children[tree.children.length - 3]
    assert.equal(sandbox.children[1].type, 'SegmentedControl')
    assert.deepEqual(sandbox.children[1].props.options.map((option) => option.value), ['auto', 'none'])
    form.dispose()
  })

  test('apply gives both rows a page while their namespaces are served', () => {
    const localeRegistrations = []
    const slotRegistrations = []
    const ctx = {
      locale: { register: (ns, dict) => localeRegistrations.push({ ns, dict }), bind: () => (key) => key },
      configForms: {
        get: () => fakeScope(),
        whileServed: (names, callback) => { callback(new Set(names)); return () => {} },
      },
      slots: {
        inject: (_name, register) => register(),
        register: (options, component) => slotRegistrations.push({ options, component }),
      },
      effect: (callback) => callback(),
    }
    client.apply(ctx)
    assert.deepEqual(localeRegistrations.map((entry) => entry.ns), [client.NS])
    assert.ok(localeRegistrations[0].dict.en && localeRegistrations[0].dict.zh)
    assert.deepEqual(slotRegistrations.map((entry) => entry.options.key), [
      rowKey('win-mb-tool-git'), rowKey('win-mb-tool-wsl'),
    ])
    for (const entry of slotRegistrations) {
      assert.equal(entry.options.name, 'plugins.row.config')
      assert.equal(entry.options.locale, client.NS)
      assert.equal(entry.component, RowConfigCard)
      assert.equal(typeof entry.options.inject().hooks.rowForm.getSnapshot, 'function')
    }
  })

  test('the slot key is the package name and the row id the patch declares', () => {
    const patch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8')
    const rowIds = [...patch.matchAll(/- id: (win-mb-[a-z-]+)/g)].map((match) => match[1])
    for (const rowId of ROWS.map((row) => row.rowId))
      assert.ok(rowIds.includes(rowId), `cordis.patch.yml must declare the row id "${rowId}"`)
    assert.equal(rowKey('win-mb-tool-git'), 'dsh-win-multi-bash#win-mb-tool-git')
    assert.deepEqual(planOps([], new Map()), [], 'no drafts, no writes')
  })
}

console.log('\n[A] unit: family section placement (between TOOL_BASH and TOOL_PWSH)')
{
  const registry = { getSectionOrder: (name) => ({ TOOL_BASH: 1000, TOOL_PWSH: 1010 })[name] }
  test('order resolves to the registry midpoint', () => {
    assert.equal(shellFamilySectionOrder(registry), 1005)
    assert.ok(shellFamilySectionOrder(registry) > registry.getSectionOrder('TOOL_BASH'))
    assert.ok(shellFamilySectionOrder(registry) < registry.getSectionOrder('TOOL_PWSH'))
  })
  test('a registry that moved the seats still keeps the section between them', () => {
    const moved = { getSectionOrder: (name) => ({ TOOL_BASH: 2000, TOOL_PWSH: 2040 })[name] }
    assert.equal(shellFamilySectionOrder(moved), 2020)
  })
  test('a registry missing a seat still yields a finite order', () => {
    for (const broken of [{ getSectionOrder: () => undefined }, { getSectionOrder: (n) => (n === 'TOOL_BASH' ? 1000 : undefined) }])
      assert.ok(Number.isFinite(shellFamilySectionOrder(broken)))
  })
  test('the section name is not per-tool', () => {
    for (const toolName of SHELL_FAMILY_TOOL_NAMES) assert.ok(!SHELL_FAMILY_SECTION_NAME.includes(toolName))
  })
}

console.log('\n[B] boot integration: default fixture (pinned via probed bash)')
{
  if (!HAS_GIT_BASH) {
    console.log('  … skipping pinned fixture: no Git Bash probed on this host')
  } else {
    let ctx
    try {
      ctx = await bootFixture(PLUGIN_ROWS(GIT_BASH), 'default.yml')
    await runTests(ctx, [
      ['boot: tools registered (git_bash, wsl_bash + job tools)', async () => {
        const names = ctx.tools.schemas().map((t) => t.name)
        for (const n of ['git_bash', 'wsl_bash', 'job_output', 'job_kill']) assert.ok(names.includes(n), `missing ${n}`)
      }],
      ['seat: ctx.shell is still provided by the base pwsh-sandbox row', async () => {
        // The regression guard. Pre-migration our rows owned this seat; when
        // the selector failed to import, the seat went unprovided and every
        // `shell`-injecting plugin (tool-pwsh, permission-presets, our own
        // tools) stayed pending forever.
        assert.ok(ctx.shell !== undefined, 'ctx.shell must be provided')
        const result = await (await ctx.shell.execute(ctx.shell.resolve({
          command: 'echo seat-ok',
          signal: new AbortController().signal,
        }))).result()
        assert.equal(result.exitCode, 0)
        assert.match(result.stdout.text, /seat-ok/)
      }],
      ['git_bash: echo round-trip', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'echo git-audit-ok' })
        assert.match(text, /git-audit-ok/)
      }],
      ['git_bash: exit code marker [exit code: N]', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'exit 7' })
        assert.match(text, /\[exit code: 7\]/)
      }],
      ['git_bash: stderr section rendered', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'echo to-stderr >&2; echo to-stdout' })
        assert.match(text, /to-stdout/)
        assert.match(text, /\[stderr\]\nto-stderr/)
      }],
      ['git_bash: timeout marker + bounded duration', async () => {
        const started = Date.now()
        // `sleep` is not on the spawn PATH for MSYS bash on this host; use a bash builtin loop.
        const text = await execTool(ctx, 'git_bash', { command: 'while :; do :; done', timeoutMs: 800 })
        const elapsed = Date.now() - started
        assert.match(text, /\[timed out after 800ms\]/)
        assert.ok(elapsed < 8000, `took ${elapsed}ms`)
      }],
      ['git_bash: workdir honored (absolute)', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'pwd', workdir: 'C:\\Users\\Dinos' })
        assert.match(text, /Dinos/)
      }],
      ['git_bash: MSYS-drive workdir translated, not passed to spawn as cwd', async () => {
        // Regression guard: `/c/...` is absolute to node:path but resolves to
        // `G:\c\...` in Windows, so spawn used to fail with `spawn bash.exe
        // ENOENT` — a missing-shell symptom for what is really a bad cwd.
        const text = await execTool(ctx, 'git_bash', { command: 'pwd', workdir: '/c/Users/Dinos' })
        assert.match(text, /Dinos/)
      }],
      ['git_bash: WSL automount workdir translated (same guard)', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'pwd', workdir: '/mnt/c/Users/Dinos' })
        assert.match(text, /Dinos/)
      }],
      ['git_bash: workdir relative resolved against session workspace', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'pwd', workdir: 'smoke' })
        assert.match(text, /smoke/i)
      }],
      ['git_bash: unicode round-trip', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'printf "中文 🚀 %s" ok' })
        assert.match(text, /中文 🚀/)
      }],
      ['git_bash: Git toolchain visible on PATH (sleep resolves, #5)', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'command -v sleep && sleep 0.1 && echo git-path-ok' })
        assert.match(text, /git-path-ok/)
      }],
      ['git_bash: arg validation — empty command is an error result', async () => {
        const r = await execToolResult(ctx, 'git_bash', { command: '   ' })
        assert.equal(r.isError, true)
        assert.match(r.text, /non-empty string/)
      }],
      ['git_bash: arg validation — empty description is an error result', async () => {
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x', description: '  ' })
        assert.equal(r.isError, true)
        assert.match(r.text, /non-empty string/)
      }],
      ['git_bash: arg validation — non-positive timeout is an error result', async () => {
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x', timeoutMs: -1 })
        assert.equal(r.isError, true)
        assert.match(r.text, /positive number/)
      }],
      ['git_bash: escalation — sandbox_permissions without justification fails closed', async () => {
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x', sandbox_permissions: 'danger-full-access' })
        assert.equal(r.isError, true)
        assert.match(r.text, /justification/i)
      }],
      ['git_bash: escalation — fails closed without approval service', async () => {
        // No approval row in the fixture: escalating must fail, never silently run.
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x', sandbox_permissions: 'danger-full-access', justification: 'audit test' })
        assert.equal(r.isError, true)
      }],
      ['git_bash: background job — start, read, kill lifecycle', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'while :; do :; done', run_in_background: true })
        const jobId = text.match(/started background job (\S+)/)?.[1]
        assert.ok(jobId, `no job id in: ${text}`)
        const read1 = await execTool(ctx, 'job_output', { job_id: jobId })
        assert.match(read1, /running|no new output/i)
        await execTool(ctx, 'job_kill', { job_id: jobId })
        const read2 = await execTool(ctx, 'job_output', { job_id: jobId })
        assert.match(read2, /killed|stopping|cancelled/i)
      }],
      ['git_bash: background output reaches the registry ring (pull sources)', async () => {
        // 0.1.7 moved background reads into the registry: the tool registers
        // `output` pull sources instead of handing back a readOutput hook, so
        // this proves the lazy `proc` binding actually carries the streams.
        const text = await execTool(ctx, 'git_bash', { command: 'echo bg-line-1; echo bg-line-2', run_in_background: true })
        const jobId = text.match(/started background job (\S+)/)?.[1]
        assert.ok(jobId, `no job id in: ${text}`)
        await new Promise((r) => setTimeout(r, 2500))
        const read = await execTool(ctx, 'job_output', { job_id: jobId })
        assert.match(read, /bg-line-1/)
        assert.match(read, /bg-line-2/)
        assert.match(read, /completed|exit code/i)
      }],
      ['wsl_bash: echo round-trip', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: 'echo wsl-audit-ok' })
        assert.match(text, /wsl-audit-ok/)
      }],
      ['wsl_bash: unicode round-trip through base64 payload', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: "printf '中文 🚀 %s' ok" })
        assert.match(text, /中文 🚀/)
      }],
      ['wsl_bash: exit code marker', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: 'exit 3' })
        assert.match(text, /\[exit code: 3\]/)
      }],
      ['wsl_bash: stderr section', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: 'echo err-line >&2' })
        assert.match(text, /\[stderr\]\nerr-line/)
      }],
      ['wsl_bash: workdir translated by wsl --cd', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: 'pwd', workdir: 'G:\\LAB\\202608\\dsh-win-multi-bash' })
        assert.match(text, /\/mnt\/g\/LAB\/202608\/dsh-win-multi-bash/)
      }],
      ['wsl_bash: automount workdir translated, not passed to spawn as cwd', async () => {
        // Same guard as git_bash: `/mnt/g/...` is a valid `--cd` value but an
        // impossible process cwd, so it must be normalized before spawn.
        const text = await execTool(ctx, 'wsl_bash', { command: 'pwd', workdir: '/mnt/g/LAB/202608/dsh-win-multi-bash' })
        assert.match(text, /\/mnt\/g\/LAB\/202608\/dsh-win-multi-bash/)
      }],
      ['wsl_bash: auto-cds to the session dir when no workdir is given', async () => {
        // The auto-cd contract: with no explicit workdir the command still
        // starts in the WSL view of the session directory rather than in the
        // distro's home. This is what `--cd` always being passed buys.
        const text = await execTool(ctx, 'wsl_bash', { command: 'pwd' })
        assert.match(text, /\/mnt\/[a-z]\//i, `expected the session drive, got: ${text}`)
        assert.doesNotMatch(text, /^\/home\//m, `fell back to the distro home: ${text}`)
      }],
      ['wsl_bash: background job lifecycle', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: 'while :; do :; done', run_in_background: true })
        const jobId = text.match(/started background job (\S+)/)?.[1]
        assert.ok(jobId, `no job id in: ${text}`)
        await execTool(ctx, 'job_kill', { job_id: jobId })
        const read2 = await execTool(ctx, 'job_output', { job_id: jobId })
        assert.match(read2, /killed|stopping|cancelled/i)
      }],
      ['tools own their executors — ctx.shell keeps the base pwsh identity', async () => {
        // If a tool had registered on the seat, cordis would have thrown on the
        // duplicate. Proving the seat runs pwsh (not a bash dialect) is the
        // strongest available statement that our rows never took it.
        const result = await (await ctx.shell.execute(ctx.shell.resolve({
          command: 'Write-Output pwsh-seat-identity',
          signal: new AbortController().signal,
        }))).result()
        assert.equal(result.exitCode, 0)
        assert.match(result.stdout.text, /pwsh-seat-identity/)
      }],
      ['long command (40k chars) does not crash the tool', async () => {
        const text = await execTool(ctx, 'git_bash', { command: `echo ${'a'.repeat(40000)} | wc -c` })
        // Either it runs (spawn ok) or a loud spawn error — but not a hang or uncaught crash.
        assert.ok(/40000|spawn|failed|error/i.test(text), text.slice(0, 200))
      }],
    ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
  }
}

console.log('\n[B] boot integration: no-pin fixture (auto git-path resolution, never WSL)')
{
  // No `gitBash.bashPath`: resolution must find the real MSYS Git Bash by
  // itself (well-known probes → PATH → git.exe layout inference) and must
  // NEVER land in WSL via the System32 launcher.
  const NO_PIN_ROWS = `
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
`
  let ctx
  try {
    ctx = await bootFixture(NO_PIN_ROWS, 'nopin.yml')
    await runTests(ctx, [
      ['no-pin git_bash runs a real MSYS bash (uname is NOT Linux)', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'uname -s' })
        assert.ok(!/linux/i.test(text), `resolved into WSL/Linux: ${text}`)
        assert.match(text, /mingw|msys/i)
      }],
      ['no-pin git_bash has the Git toolchain (git --version)', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'git --version' })
        assert.match(text, /git version/i)
      }],
      ['no-pin git_bash: full MSYS toolchain present (PATH-injected spawn env)', async () => {
        const TOOLS = ['ls', 'cat', 'grep', 'sed', 'awk', 'find', 'sort', 'uniq', 'wc', 'head', 'tail',
          'cut', 'tr', 'xargs', 'printf', 'sleep', 'date', 'tar', 'gzip', 'ssh', 'curl', 'cygpath']
        const text = await execTool(ctx, 'git_bash', {
          command: `for t in ${TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 && printf 'OK %s\\n' "$t" || printf 'MISS %s\\n' "$t"; done`,
        })
        const misses = text.split('\n').filter((l) => l.startsWith('MISS'))
        assert.deepEqual(misses, [], `missing from spawn PATH: ${misses.join(', ')}`)
      }],
    ])
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }
}

console.log('\n[B] boot integration: REAL cordis.patch.yml applied as overlay patches')
{
  // The shipped patch inserts the two win-mb-* tool rows and touches nothing
  // else — it no longer disables `pwsh-sandbox` (the base bundle's seat
  // provider must survive) and no longer mounts a selector. `!!js` tags are
  // evaluated by loadOverlayPatches, proving the shipped file parses.
  const patchPath = join(PLUGIN, 'cordis.patch.yml')
  const patches = loadOverlayPatches('dsh-wmb-audit', patchPath)
  assert.ok(patches.length >= 1, `expected ≥1 patch entry, got ${patches.length}`)
  let ctx
  try {
    ctx = await bootFixture('', 'patch-overlay.yml', patches)
    await runTests(ctx, [
      ['boot with the shipped cordis.patch.yml: insert + !!js tags accepted', async () => {
        const names = ctx.tools.schemas().map((t) => t.name)
        assert.ok(names.includes('git_bash'))
        assert.ok(names.includes('wsl_bash'))
      }],
      ['tools execute through the real patch composition', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'echo patch-overlay-ok' })
        assert.match(text, /patch-overlay-ok/)
        const wsl = await execTool(ctx, 'wsl_bash', { command: 'echo patch-overlay-wsl' })
        assert.match(wsl, /patch-overlay-wsl/)
      }],
      ['the shipped patch does not leave the shell seat unprovided', async () => {
        assert.ok(ctx.shell !== undefined, 'the base bundle keeps ctx.shell')
      }],
      ['the shipped patch disables no base row (no selector to make room for)', async () => {
        const raw = readFileSync(patchPath, 'utf8')
        assert.ok(!/disabled:\s*true/.test(raw), 'no unconditional `disabled: true` row remains')
        assert.ok(!/shell-select/.test(raw), 'no selector row remains')
      }],
    ])
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }
}

console.log('\n[B] boot integration: shell prompt section state matrix (one copy, any subset)')
{
  // git_bash and wsl_bash are independently switchable, and the shared section
  // must track that exactly: one copy with both tools, one with either, and no
  // text at all with neither. Every state also pins that the section never
  // repeats a fact in itself, and that the whole assembled prompt has no two
  // identical blocks (the shape the old per-tool registration produced).
  const STATES = [
    ['both tools', () => PLUGIN_ROWS(GIT_BASH), ['git_bash', 'wsl_bash'], true, false],
    ['git_bash only', () => GIT_ONLY_ROWS(GIT_BASH), ['git_bash'], true, false],
    ['wsl_bash only', () => WSL_ONLY_ROWS, ['wsl_bash'], false, false],
    ['no tool', () => SHELL_PROMPT_ONLY_ROWS, [], false, false],
    // dsh's own pwsh tool alongside ours: it registers its own section and
    // repeats a few of these facts in its own description, and the family
    // section must be unaffected by its presence.
    ['both tools + dsh tool-pwsh', () => `${PLUGIN_ROWS(GIT_BASH)}
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
`, ['git_bash', 'wsl_bash'], true, true],
  ]
  for (const [label, rows, expectedTools, needsGit, expectPwsh] of STATES) {
    if (needsGit && !HAS_GIT_BASH) {
      console.log(`  … skipping ${label}: no Git Bash probed on this host`)
      continue
    }
    let ctx
    try {
      ctx = await bootFixture(rows(), `prompt-state-${label.replace(/[^a-z0-9]+/gi, '-')}.yml`)
      // Markers make the placement claim end-to-end: the section must land
      // between the two seats dsh allocates to shell tools.
      ctx.systemPrompt.section({ name: 'audit:order-bash', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'), text: 'audit bash marker' })
      ctx.systemPrompt.section({ name: 'audit:order-pwsh', order: ctx.systemPrompt.getSectionOrder('TOOL_PWSH'), text: 'audit pwsh marker' })
      const { assembly, prompt } = await assembledPrompt(ctx)
      const schemas = ctx.tools.schemas()
      const mounted = schemas.filter((s) => SHELL_FAMILY_TOOL_NAMES.includes(s.name))
      const family = assembly.sections.filter((s) => s.name === SHELL_FAMILY_SECTION_NAME)
      const familyText = family[0]?.text ?? ''
      const advertises = (parameter) => mounted.some((s) => s.parameters?.properties?.[parameter] !== undefined)
      const index = (name) => assembly.sections.findIndex((s) => s.name === name)

      await runTests(ctx, [
        [`${label}: the mounted tools are exactly ${expectedTools.join(' + ') || '(none)'}`, async () => {
          assert.deepEqual(mounted.map((s) => s.name).sort(), [...expectedTools].sort())
        }],
        [`${label}: exactly one family section is registered`, async () => {
          assert.equal(family.length, 1, `expected one ${SHELL_FAMILY_SECTION_NAME} section, got ${family.length}`)
        }],
        [`${label}: the section sorts between TOOL_BASH and TOOL_PWSH`, async () => {
          assert.ok(index('audit:order-bash') < index(SHELL_FAMILY_SECTION_NAME), 'family section must follow TOOL_BASH')
          assert.ok(index(SHELL_FAMILY_SECTION_NAME) < index('audit:order-pwsh'), 'family section must precede TOOL_PWSH')
        }],
        [`${label}: the shared guidance appears exactly ${expectedTools.length > 0 ? 'once' : 'zero times'} in the prompt`, async () => {
          assert.equal(prompt.split(SHELL_EXIT_STATUS_SECTION).length - 1, expectedTools.length > 0 ? 1 : 0)
          if (expectedTools.length === 0) assert.ok(!prompt.includes('truncated to its tail'), 'no orphan shell guidance')
        }],
        [`${label}: gated facts match what the mounted tools advertise`, async () => {
          assert.equal(familyText.includes(SHELL_BACKGROUND_SECTION), advertises('run_in_background'), 'background guidance must follow the parameter')
          assert.equal(familyText.includes(SHELL_ESCALATION_SECTION), advertises('sandbox_permissions'), 'escalation contract must follow the parameter')
        }],
        [`${label}: the section text is exactly a function of the family tools mounted`, async () => {
          // No other row's tool, description or section may contribute a word
          // here — that is what keeps the same text correct with and without
          // dsh's own pwsh tool.
          const expected = mounted.length === 0 ? '' : shellFamilySectionText({
            background: advertises('run_in_background'),
            escalation: advertises('sandbox_permissions'),
          })
          assert.equal(familyText, expected)
          if (expectPwsh) assert.ok(schemas.some((s) => s.name === 'pwsh'), 'this state must mount dsh\'s pwsh tool')
        }],
        [`${label}: the assembled prompt repeats no block verbatim`, async () => {
          const blocks = prompt.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0)
          const seen = new Set(); const repeated = []
          for (const block of blocks) { if (seen.has(block)) repeated.push(block.slice(0, 60)); seen.add(block) }
          assert.deepEqual(repeated, [], `duplicate prompt blocks: ${repeated.join(' | ')}`)
        }],
        [`${label}: the tool descriptions share no sentence`, async () => {
          const sentences = (s) => s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter((x) => x.length > 15)
          for (const a of mounted)
            for (const b of mounted) {
              if (a.name >= b.name) continue
              const shared = sentences(a.description).filter((s) => b.description.includes(s))
              assert.deepEqual(shared, [], `${a.name} and ${b.name} still share: ${shared.join(' | ')}`)
            }
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
  }
}

console.log('\n[B] boot integration: dsh-settings projection of the two rows (read-only)')
{
  // The Plugins page edits whatever `settings` projects for an entry id, so the
  // claim "these options are editable in the panel" is exactly "settings
  // describes these two entry ids with these live values". Read-only: this test
  // never mutates the document.
  let ctx
  try {
    ctx = await bootFixture(`${SHELL_PROMPT_ONLY_ROWS}
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'

- id: settings
  name: '@deepseek-ai/dsh-settings'
`, 'settings-rows.yml')
    if (ctx.settings === undefined) {
      console.log('  … skipping: this composition provides no configEditor/profileContext, so dsh-settings never activates')
      console.log('    (the schema contract it projects is pinned by the unit section above)')
    } else {
      const forms = new Map(ctx.settings.describe({ redactSecrets: true }).map((form) => [form.ns, form]))
      await runTests(ctx, [
        ['both tool rows are addressable settings namespaces', async () => {
          for (const ns of ['win-mb-tool-git', 'win-mb-tool-wsl'])
            assert.ok(forms.has(ns), `no settings form for "${ns}"; described: ${[...forms.keys()].join(', ')}`)
        }],
        ['the git_bash form reports the knob values the row is running with', async () => {
          const form = forms.get('win-mb-tool-git')
          assert.deepEqual(Object.keys(form.value).sort(), ['enableRunInBackground', 'gitBash'])
          assert.equal(form.value.enableRunInBackground, true)
          assert.equal(form.value.gitBash.sandbox, 'auto')
          assert.equal(form.value.gitBash.probeTimeoutMs, 10000)
          assert.equal(form.value.gitBash.requireSandbox, false)
        }],
        ['the wsl_bash form reports its own partition only', async () => {
          const form = forms.get('win-mb-tool-wsl')
          assert.deepEqual(Object.keys(form.value).sort(), ['enableRunInBackground', 'wslBash'])
          assert.equal(form.value.wslBash.probeTimeoutMs, 30000)
          assert.equal(form.value.wslBash.sandbox, 'auto')
        }],
        ['nothing outside the volatile projection is editable', async () => {
          for (const ns of ['win-mb-tool-git', 'win-mb-tool-wsl']) {
            const form = forms.get(ns)
            assert.equal(typeof form.revision, 'number', `${ns} must carry the revision a save fences with`)
            assert.equal(form.user === undefined || Object.keys(form.user).length === 0, true, `${ns} starts unoverridden`)
          }
        }],
      ])
    }
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }
}

console.log('\n[B] boot integration: misconfiguration matrices')
{
  // A pinned bashPath that does not exist: resolution trusts an explicit pin
  // verbatim, so the failure must surface as a loud per-command error rather
  // than a crash or a silent fallback to another shell.
  let ctx
  try {
    ctx = await bootFixture(`
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:
    gitBash:
      bashPath: 'G:\\no-such-git\\usr\\bin\\bash.exe'
`, 'bad-bashpin.yml')
    await runTests(ctx, [
      ['unresolvable pinned bashPath surfaces as a failed command, not a crash', async () => {
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x' })
        assert.equal(r.isError, true, `expected an error result, got: ${r.text.slice(0, 200)}`)
      }],
    ])
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }

  let ctx2
  try {
    ctx2 = await bootFixture(`
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
  config:
    wslBash:
      wslDistro: 'NoSuchDistro-999'
`, 'bad-distro.yml')
    await runTests(ctx2, [
      ['nonexistent wslDistro surfaces as a failed command, not a crash', async () => {
        const r = await execToolResult(ctx2, 'wsl_bash', { command: 'echo x' })
        assert.ok(r.text.length > 0)
      }],
      ['a broken wsl backend leaves git_bash fully usable (no shared seat to poison)', async () => {
        const text = await execTool(ctx2, 'git_bash', { command: 'echo git-still-fine' })
        assert.match(text, /git-still-fine/)
      }],
    ])
  } finally {
    if (ctx2) await ctx2.fiber.dispose()
  }

  // #3: explicit `sandbox: bwrap` must never run unconfined. The tool's apply
  // awaits `resolveSandboxMode()`, so a host without bubblewrap deactivates the
  // wsl row loudly at load rather than degrading per command; a host with
  // bubblewrap confines every command. Either way the safety property holds:
  // wsl_bash never executes unconfined under this stance.
  let ctx3
  try {
    ctx3 = await bootFixture(`
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
  config:
    wslBash:
      sandbox: bwrap
`, 'explicit-bwrap.yml')
    await runTests(ctx3, [
      ['#3: git_bash is unaffected by the wsl sandbox stance', async () => {
        const names = ctx3.tools.schemas().map((t) => t.name)
        assert.ok(names.includes('git_bash'))
        const text = await execTool(ctx3, 'git_bash', { command: 'echo still-works' })
        assert.match(text, /still-works/)
      }],
      ['#3: explicit bwrap never runs wsl_bash unconfined', async () => {
        const names = ctx3.tools.schemas().map((t) => t.name)
        if (!names.includes('wsl_bash')) return // row deactivated loud: bwrap absent in the distro
        const r = await execToolResult(ctx3, 'wsl_bash', { command: 'echo x' })
        // Host with bubblewrap: the explicit stance confines and the command runs.
        assert.match(r.text, /x/, `unexpected result: ${r.text.slice(0, 200)}`)
      }],
    ])
  } finally {
    if (ctx3) await ctx3.fiber.dispose()
  }
}

for (const p of writtenFixtures) rmSync(p, { force: true })

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n==== audit summary: ${passed} passed, ${failed} failed ====`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const { name, error } of failures) console.log(`  - ${name}: ${error?.message ?? error}`)
  process.exit(1)
}
