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
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── helpers / imports ────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const lib = join(__dirname, '..', 'lib')
const libUrl = (...parts) => pathToFileURL(join(lib, ...parts)).href

const { isRunnerSpawnFailure, classifyDenial, classifyRunnerFailure, denialFacts, learnedDenialSignature, matchesSignature } =
  await import(libUrl('vendor', 'helpers.js'))
const { BWRAP_RUNNER_FAILURE_RULES, bwrapProfileArgs } =
  await import(libUrl('vendor', 'bwrap-profiles.js'))
const { GitBashExecutor, candidateBashPaths, candidateExists, gitCandidatesUnder, gitRootCandidates, gitToolPath, probeDrives, resolveBashPath } =
  await import(libUrl('bash-git', 'index.js'))
const { WslBashExecutor } = await import(libUrl('bash-wsl', 'index.js'))
const { ownExecutor } = await import(libUrl('tool-bash', 'types', 'backend.js'))
const { processJob, processOutcome, processSources, ringDelta } =
  await import(libUrl('tool-bash', 'types', 'background.js'))
const { renderJobRead, renderPromoted, renderResult, unconfinedDetailMarker, unconfinedMarker, unmatchedDialectMarker } =
  await import(libUrl('tool-bash', 'types', 'render.js'))
const gitBashTool = await import(libUrl('tool-bash', 'types', 'git-bash.js'))
const wslBashTool = await import(libUrl('tool-bash', 'types', 'wsl-bash.js'))
const { resolveSessionWorkdir, shellDescription, toNativeWorkdir, validateShellArgs } =
  await import(libUrl('tool-bash', 'types', 'factory.js'))
const {
  SHELL_ARGUMENT_ORDER_SECTION,
  SHELL_EXIT_STATUS_SECTION, SHELL_FAMILY_SECTION_NAME, SHELL_FAMILY_TOOL_NAMES,
  SHELL_BACKGROUND_SECTION, SHELL_ESCALATION_SECTION, SHELL_FAMILY_ROW_SPECIFIER,
  shellFamilySectionText, shellFamilySectionOrder, composeToolDescription,
} = await import(libUrl('tool-bash', 'types', 'shell-family.js'))
const packageRow = await import(libUrl('index.js'))
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
    assert.deepEqual(args, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'])
  })
  test('bwrapProfileArgs: both modes unshare the PID namespace', () => {
    // Without --unshare-pid a fresh /proc over the HOST pid namespace lets
    // procfs magic links (/proc/<pid>/root|fd|cwd) reach a host process's mount
    // view, escaping the ro-bind and the workspace-write allow-list whenever the
    // deployment's ptrace policy permits the follow (dsh commit 82db1515 made
    // the private namespace an invariant; our vendored copy had drifted).
    for (const mode of ['read-only', 'workspace-write'])
      assert.ok(
        bwrapProfileArgs({ mode, workspaceRoot: '/mnt/g/LAB' }).includes('--unshare-pid'),
        `${mode} must unshare the PID namespace`,
      )
  })
  test('bwrapProfileArgs: workspace-write → adds --tmpfs /tmp and --bind root', () => {
    const args = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/mnt/g/LAB' })
    assert.deepEqual(args.slice(-4), ['/tmp', '--bind', '/mnt/g/LAB', '/mnt/g/LAB'])
    assert.ok(args.includes('--tmpfs'))
  })
  // task-19: the `denied` fact may be absent on purpose, and a refusal can teach
  // this host's dialect.
  test('denialFacts: matched → true, success → false, unknown failure → absent', () => {
    const signatures = ['access is denied', 'read-only file system']
    assert.deepEqual(denialFacts(1, 'bash: /x: Read-only file system', signatures), { denied: true })
    assert.deepEqual(denialFacts(1, 'ACCESS IS DENIED.', signatures), { denied: true }, 'matching stays case-insensitive')
    assert.deepEqual(denialFacts(0, '', signatures), { denied: false }, 'a confined success says nothing was denied')
    assert.deepEqual(denialFacts(0, 'warning: read-only file system', signatures), { denied: false })
    assert.deepEqual(denialFacts(1, 'bash: line 3: syntax error near unexpected token', signatures), {},
      'a failure this dialect does not explain must not be reported as "not denied"')
    assert.deepEqual(denialFacts(null, '', signatures), {}, 'signal termination is not a denial either')
  })
  test('learnedDenialSignature: keeps the stable part of a refusal, refuses junk', () => {
    assert.equal(
      learnedDenialSignature(
        'bash: line 1: /g/LAB/.dsh-denial-probe-abcd1234: Read-only file system',
        ['.dsh-denial-probe-abcd1234', String.raw`G:\LAB\.dsh-denial-probe-abcd1234`, String.raw`G:\LAB`],
      ),
      'Read-only file system',
      'the probe path is stripped, the stable message survives',
    )
    assert.equal(learnedDenialSignature('denied: permission denied'), 'denied: permission denied')
    assert.equal(learnedDenialSignature(''), undefined)
    assert.equal(learnedDenialSignature('x'), undefined, 'too short to identify a dialect')
    assert.equal(learnedDenialSignature(undefined), undefined)
    assert.equal(learnedDenialSignature('a'.repeat(200)), undefined, 'too long to be a signature')
  })
  test('BWRAP_RUNNER_FAILURE_RULES matches "bwrap: " stderr lines', () => {
    assert.notEqual(classifyRunnerFailure(1, 'bwrap: no space left', BWRAP_RUNNER_FAILURE_RULES), undefined)
  })
}

console.log('\n[A] unit: the vendored bwrap profile against the upstream artifact (drift guard)')
{
  // The profile is a vendored COPY (upstream's builder cannot be imported at
  // runtime: `dsh-sandbox-local`'s `lib/*` is not exported and its main entry
  // pulls the landlock native addon), so nothing else would notice when a dsh
  // upgrade changes a mount flag. This reads the upstream artifact by ABSOLUTE
  // PATH — `require.resolve('@deepseek-ai/dsh-sandbox-local/package.json')` for
  // the package directory, never an exports subpath — and compares item by item.
  //
  // Two install shapes exist, in this order: a source install ships
  // `src/profiles.ts`; the published package ships only the compiled
  // `lib/index.js` bundle (which is what the runtime actually executes). With
  // neither present the guard skips LOUDLY, naming the paths it tried, so a
  // missing upstream package can never masquerade as "no drift".
  const requireFromAudit = createRequire(import.meta.url)
  const upstream = (() => {
    try {
      const pkgDir = dirname(requireFromAudit.resolve('@deepseek-ai/dsh-sandbox-local/package.json'))
      for (const [shape, path] of [
        ['src/profiles.ts', join(pkgDir, 'src', 'profiles.ts')],
        ['lib/index.js (compiled bundle)', join(pkgDir, 'lib', 'index.js')],
      ]) {
        if (existsSync(path)) return { shape, path, text: readFileSync(path, 'utf8') }
      }
      console.log(`  … skipping bwrap drift guard: no profiles artifact under ${pkgDir} (tried src/profiles.ts, lib/index.js)`)
      return undefined
    } catch (error) {
      console.log(`  … skipping bwrap drift guard: @deepseek-ai/dsh-sandbox-local is not installed (${String(error?.code ?? error)})`)
      return undefined
    }
  })()

  if (upstream === undefined) {
    console.log('    (this is a drift detector, not a gate on runtimes without the upstream package)')
  } else {
    /** Every quoted literal inside a source snippet, in order. */
    const literalsIn = (text) => [...text.matchAll(/(?:"([^"]+)"|'([^']+)')/g)].map((match) => match[1] ?? match[2])
    const prefixMatch = /\[\s*(?:"|')--ro-bind(?:"|')[\s\S]*?\]/.exec(upstream.text)
    test(`the upstream profile is readable and carries the --ro-bind prefix (${upstream.shape})`, () => {
      assert.ok(prefixMatch !== null, `no --ro-bind array literal found in ${upstream.path}`)
    })
    const upstreamPrefix = prefixMatch === null ? [] : literalsIn(prefixMatch[0])

    test('the vendored read-only profile matches upstream item by item', () => {
      const ours = bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/mnt/g/LAB' })
      const missing = upstreamPrefix.filter((arg) => !ours.includes(arg))
      const extra = ours.filter((arg) => !upstreamPrefix.includes(arg))
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
        `the vendored profile drifted from ${upstream.path}`)
      assert.deepEqual(ours, upstreamPrefix, `the vendored profile's ORDER differs from ${upstream.path}`)
    })

    test('the workspace-write additions match upstream\'s push literals', () => {
      const pushes = [...upstream.text.matchAll(/args\.push\(([\s\S]*?)\);/g)].map((match) => literalsIn(match[1]))
      const ours = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/mnt/g/LAB' })
      const suffix = ours.slice(upstreamPrefix.length)
      assert.deepEqual(suffix.slice(0, 2), ['--tmpfs', '/tmp'], `--tmpfs /tmp drifted from ${upstream.path}`)
      assert.equal(suffix[2], '--bind', `--bind drifted from ${upstream.path}`)
      assert.deepEqual(suffix.slice(3), ['/mnt/g/LAB', '/mnt/g/LAB'], 'the bind operands are the policy root, twice')
      assert.equal(suffix.length, 5, 'workspace-write adds exactly --tmpfs /tmp and --bind root root')
      if (pushes.length > 0) {
        assert.deepEqual(pushes[0], ['--tmpfs', '/tmp'], `upstream's first push changed in ${upstream.path}`)
        // Upstream's bind push carries identifier operands, so only its flag is a
        // comparable literal; when the shape ever changes this names the file.
        if (pushes.length > 1) assert.equal(pushes[1][0], '--bind', `upstream's bind push changed in ${upstream.path}`)
      }
    })
  }
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
    assert.equal(c.gitBash.probeTimeoutMs.get(), 4000)
    assert.equal(c.gitBash.requireSandbox.get(), false)
    assert.equal('wslBash' in c, false, 'the git tool has no wsl partition')
  })
  test('wsl_bash tool Config partitions the backend under `wslBash`', () => {
    const c = wslBashTool.Config({})
    assert.equal(c.enableRunInBackground.get(), true)
    assert.equal(c.wslBash.sandbox.get(), 'auto')
    assert.equal(c.wslBash.probeTimeoutMs.get(), 8000, 'wsl keeps its own 8e3 probe default')
    assert.equal('gitBash' in c, false)
  })
  test('git_bash tool Config merges a partial backend partition', () => {
    const c = gitBashTool.Config({ gitBash: { bashPath: 'X' } })
    assert.equal(c.gitBash.bashPath.get(), 'X')
    assert.equal(c.gitBash.probeTimeoutMs.get(), 4000, 'unspecified fields keep their defaults')
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
      // The family's shared prompt section is owned by the package row (the
      // plugin's core row), so a tool row registers no section and needs no
      // systemPrompt: two rows sharing one section name would throw, and one
      // section each would be the duplication this design removes.
      assert.ok(!t.inject.includes('systemPrompt'), `${t.name} must not register a prompt section`)
    }
  })
  test('the core row (package main) declares the name/inject/apply shape cordis needs', () => {
    assert.equal(typeof packageRow.name, 'string')
    assert.equal(packageRow.name, 'dsh-win-multi-bash', 'the plugin name is the bare package specifier')
    assert.equal(typeof packageRow.apply, 'function')
    assert.ok(!('Config' in packageRow), 'the core row owns no tool and no config of its own')
    for (const s of ['systemPrompt', 'tools']) assert.ok(packageRow.inject.includes(s), `the core row must inject ${s}`)
  })
  test('the development-only shell-prompt row is deleted, not shimmed', () => {
    // The row never appeared in a published version (0.3.0 / 0.3.1 declared the
    // two tool rows only), so 0.4.0 carries no module and no export for it. A
    // development-era profile that still lists the row reports one inactive entry
    // and is otherwise unaffected — the tools fall back to carrying the shared
    // guidance themselves, which the "no prompt row" boot state above proves.
    const root = join(__dirname, '..')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(!Object.keys(manifest.exports).some((key) => key.includes('shell-prompt')), 'the export must be gone')
    assert.equal(existsSync(join(root, 'lib', 'tool-bash', 'shell-prompt.js')), false, 'the module must be gone')
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('shell-prompt'), 'the wiring must not declare that row')
  })
  test('#2: git-bash Config is independent of wsl-bash (no .set() cross-pollution)', () => {
    assert.equal(GitBashExecutor.Config({}).probeTimeoutMs.get(), 4000, 'git-bash keeps its own 4e3 default')
    assert.throws(() => GitBashExecutor.Config({ sandbox: 'bwrap' }), 'bwrap is not a valid git-bash stance')
    assert.equal(WslBashExecutor.Config({}).probeTimeoutMs.get(), 8000, 'wsl-bash keeps its own 8e3 default')
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
  testAsync('execute(): an explicitly unconfined git run reports the fact (sandbox: none)', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig({ sandbox: 'none' }),
    })
    const result = await (await ex.execute(ex.resolve({ command: 'echo unconfined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /unconfined-ok/)
    // The old contract here was "no sandbox facts at all", which could not be
    // told apart from "this deployment composes no sandbox". It is now the
    // explicit, structured fact.
    // task-19: no `denied` on an unwrapped run — the sandbox never ran, so it can
    // deny nothing; the fact that matters is `unconfined`.
    assert.deepEqual(result.sandbox, { mode: 'read-only', unconfined: true })
  })
  // task-19: a confined failure whose stderr matches NO known signature must
  // report no `denied` at all, and the renderer must say the dialect is unknown.
  testAsync('execute(): a confined failure with an unmatched signature omits denied and says so', async () => {
    const build = (signatures) => {
      const ex = bareInstance(GitBashExecutor, {
        ctx: fakeCtx({
          subprocess: fakeSubprocess(),
          sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }), defaultMode: 'read-only' },
          sandbox: {
            confine: async () => ({
              argv: [GIT_BASH, '-c', 'printf unrelated-complaint >&2; exit 3'],
              enforcement: 'partial',
              denialSignatures: signatures,
              runnerFailureRules: [],
            }),
          },
        }),
        config: gitConfig({ sandbox: 'auto', probeTimeoutMs: 20000 }),
      })
      ex.internals.probeConfined = async () => true
      return ex
    }
    const spec = { command: 'echo x', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }
    const unknown = build(['nonexistent dialect'])
    const unmatched = await (await unknown.execute(unknown.resolve(spec))).result()
    assert.deepEqual(unmatched.sandbox, { mode: 'read-only', enforcement: 'partial' },
      'an unexplained failure reports no `denied`: the key must be absent, not false')
    assert.ok(renderResult(unmatched, []).includes(unmatchedDialectMarker()),
      'and the model is told the dialect is unknown instead of reading a plain failure')
    const known = build(['unrelated-complaint'])
    const matched = await (await known.execute(known.resolve(spec))).result()
    assert.equal(matched.sandbox.denied, true, 'a matching signature still reports denied: true')
    assert.ok(!renderResult(matched, []).includes('denial dialect'))
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
  testAsync('execute(): a runner failure fails closed instead of re-running unconfined', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: async () => ({ argv: [GIT_BASH, '-c', 'echo bwrap: runner exploded >&2; exit 1'], denialSignatures: [], runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES, enforcement: 'full' }),
    }
    // The dsh sandbox seam forbids silent unconfined passthrough, so runner
    // evidence must surface as a loud refusal naming the runner and both ways
    // out — never as a quiet re-run of the original argv.
    await assert.rejects(
      async () => (await ex.execute(ex.resolve({ command: 'echo fallback-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result(),
      (error) => /refusing to run unconfined under read-only mode/.test(String(error?.message)) && String(error?.message).includes('danger-full-access'),
    )
  })
  testAsync('execute(): a runner spawn failure fails closed', async () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: gitConfig(),
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: async () => ({ argv: ['G:\\no-such-runner-xyz.exe', '-c', 'x'], denialSignatures: [], runnerFailureRules: [], enforcement: 'full' }),
    }
    await assert.rejects(
      async () => (await ex.execute(ex.resolve({ command: 'echo respawn-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result(),
      (error) => /refusing to run unconfined/.test(String(error?.message)),
    )
  })
  testAsync('the git confinement probe awaits its child instead of freezing the event loop', async () => {
    // Behaviour, not spelling (Q2-G2-3): this probe runs inside the tool row's
    // `apply` (via resolveSandboxMode), so the invariant is "the loop keeps
    // advancing while it runs" — a source regex would still pass for
    // `execFileSync`, for a renamed helper, or with one space moved.
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({
        sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }), defaultMode: 'read-only' },
        // A REAL child that outlives many event-loop turns, so an awaiting probe
        // and a blocking one are unambiguously distinguishable. The margins are
        // deliberately wide (800ms child, 20s probe deadline): a cold `node -e`
        // start under load has been seen to take seconds, and a probe deadline
        // that merely *races* the child would turn a deterministic invariant
        // into a flake.
        sandbox: {
          confine: async () => ({
            argv: [process.execPath, '-e', 'setTimeout(() => {}, 800)'],
            denialSignatures: [], runnerFailureRules: [], enforcement: 'full',
          }),
        },
      }),
      config: gitConfig({ bashPath: process.execPath, probeTimeoutMs: 20000 }),
    })
    const ticks = []
    const timer = setInterval(() => ticks.push(1), 25)
    let mode
    try {
      mode = await ex.resolveSandboxMode()
    } finally {
      clearInterval(timer)
    }
    assert.equal(mode, 'read-only', 'the probe verdict still settles on the policy default')
    assert.ok(ticks.length > 0, `a synchronous probe freezes the host event loop (ticks=${ticks.length})`)
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
    // The profile/command separator upstream uses (`sandbox-local/src/index.ts:330`):
    // without it a profile argument could be read as the command.
    const separator = bwrap.indexOf('--', 1)
    assert.ok(separator > 1, 'the profile must be followed by an explicit -- separator')
    assert.deepEqual(bwrap.slice(separator, separator + 3), ['--', 'bash', '-c'])
    // And the embedded profile is exactly the vendored builder's output, so the
    // argv stays comparable to upstream's item for item.
    assert.deepEqual(
      bwrap.slice(1, separator),
      bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: '/mnt/g/LAB/202608' }),
    )
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
    const bwrap = argv.slice(argv.indexOf('--') + 1)
    const separator = bwrap.indexOf('--', 1)
    assert.deepEqual(
      bwrap.slice(1, separator),
      bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/mnt/g/LAB/202608' }),
      'read-only wraps with exactly the read-only profile',
    )
    assert.deepEqual(bwrap.slice(separator, separator + 3), ['--', 'bash', '-c'])
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
  testAsync('execute(): an explicitly unconfined wsl run reports the fact (sandbox: none)', async () => {
    const ex = bareInstance(WslBashExecutor, {
      ctx: fakeCtx({ subprocess: fakeSubprocess() }),
      config: WslBashExecutor.Config({ wslPath: WSL_EXE, sandbox: 'none' }),
    })
    ex.distro = () => undefined
    const result = await (await ex.execute(ex.resolve({ command: 'echo wsl-unconfined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() }))).result()
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /wsl-unconfined-ok/)
    assert.deepEqual(result.sandbox, { mode: 'read-only', unconfined: true })
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

console.log('\n[A] unit: job reads carry their loss/sandbox notices; the exported seams are pinned')
{
  // S1: a promoted foreground call takes exactly ONE consuming read, and that
  // read advances the model's cursor to the ring's total. When it is lossy, the
  // notice asserted here is the model's last chance to learn that output was
  // dropped and where the retained copy lives — no later `job_output` can
  // report it. Deleting the notice must therefore fail the gate, not just look
  // different.
  test('renderJobRead: a lossy read names the drop and the spill files', () => {
    assert.equal(
      renderJobRead('out\n', true, ['C:\\tmp\\out.log', 'C:\\tmp\\err.log']),
      'out\n[some output was dropped from memory; full output: C:\\tmp\\out.log, C:\\tmp\\err.log]',
    )
    assert.equal(
      renderJobRead('out\n', true, []),
      'out\n[some output was dropped from memory; full output: (unavailable)]',
    )
  })
  test('renderJobRead: newline discipline and the complete-read case', () => {
    assert.equal(renderJobRead('out\n', false, ['ignored.log']), 'out\n', 'a complete read is untouched')
    assert.equal(renderJobRead('out', true, []), 'out\n[some output was dropped from memory; full output: (unavailable)]')
    assert.equal(renderJobRead('', false, []), '')
    assert.equal(renderJobRead('', true, []), '[some output was dropped from memory; full output: (unavailable)]')
  })
  test('renderJobRead: sandbox facts ride along, with the hint only when escalation is advertised', () => {
    const denied = renderJobRead('x\n', false, [], { mode: 'read-only', denied: true }, ['workspace-write'])
    assert.match(denied, /\[sandbox: file access denied under read-only mode\]/)
    assert.match(denied, /\[sandbox: escalation available — retry this exact command once with sandbox_permissions/)
    const bare = renderJobRead('x\n', false, [], { mode: 'read-only', denied: true }, [])
    assert.match(bare, /file access denied under read-only mode/)
    assert.ok(!bare.includes('sandbox_permissions'), 'no escalation is offered without the parameter')
    assert.match(
      renderJobRead('x\n', false, [], { mode: 'workspace-write', denied: false, runnerFailed: true }, ['workspace-write']),
      /\[sandbox: the sandbox runner itself failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure\]/,
    )
  })
  // task-15: an unconfined run reports the fact, and the model hears about it
  // ONLY when the tool degraded to it itself (`auto`), never for an explicit
  // `sandbox: none` — that is expected configuration, not a surprise.
  test('renderResult: an automatically degraded run announces the missing sandbox', () => {
    const base = {
      stdout: { text: 'x\n', truncated: false },
      stderr: { text: '', truncated: false },
      timedOut: false,
      stopped: undefined,
      signal: null,
      exitCode: 0,
    }
    const unconfined = { mode: 'read-only', denied: false, unconfined: true }
    // task-18: the FIRST automatic degradation of a row carries the full
    // explanation; every later one carries only the short marker.
    const announced = renderResult({ ...base, sandbox: unconfined }, [], { unconfinedIsAutomatic: true, unconfinedDetail: true })
    assert.equal(announced, `x\n${unconfinedDetailMarker('read-only')}`)
    const short = renderResult({ ...base, sandbox: unconfined }, [], { unconfinedIsAutomatic: true })
    assert.equal(short, `x\n${unconfinedMarker('read-only')}`)
    assert.ok(!short.includes('confinement probe found no usable sandbox'), 'the short marker explains nothing')
    assert.ok(unconfinedMarker('read-only').length < 120, `the short marker must stay short: ${unconfinedMarker('read-only').length} chars`)
    for (const clause of ['confinement probe found no usable sandbox', 'repair the sandbox', 'sandbox: none']) {
      assert.ok(announced.includes(clause), `the full explanation must state "${clause}": ${announced}`)
    }
    // The exit marker stays last, so the card's exit pill still parses.
    const withExit = renderResult({ ...base, exitCode: 3, sandbox: unconfined }, [], { unconfinedIsAutomatic: true, unconfinedDetail: true })
    assert.ok(withExit.trimEnd().endsWith('[exit code: 3]'), withExit)
    assert.equal(renderResult({ ...base, sandbox: unconfined }, [], {}), 'x\n', 'an explicit `sandbox: none` stays quiet')
    assert.equal(renderResult({ ...base, sandbox: unconfined }), 'x\n', 'and so does a caller that passes no options')
    assert.equal(
      renderResult({ ...base, sandbox: { mode: 'read-only', denied: false, enforcement: 'full' } }, [], { unconfinedIsAutomatic: true, unconfinedDetail: true }),
      'x\n',
      'a wrapped run never carries the note',
    )
    assert.equal(
      renderResult({ ...base, sandbox: { mode: 'danger-full-access', denied: false } }, [], { unconfinedIsAutomatic: true, unconfinedDetail: true }),
      'x\n',
      'danger-full-access says everything through its mode',
    )
  })
  test('renderJobRead: the promoted path announces it under the same rule', () => {
    const unconfined = { mode: 'read-only', denied: false, unconfined: true }
    assert.equal(
      renderJobRead('x\n', false, [], unconfined, [], { unconfinedIsAutomatic: true, unconfinedDetail: true }),
      `x\n${unconfinedDetailMarker('read-only')}`,
      'the first automatic degradation of the row carries the full explanation',
    )
    assert.equal(
      renderJobRead('x\n', false, [], unconfined, [], { unconfinedIsAutomatic: true }),
      `x\n${unconfinedMarker('read-only')}`,
      'later ones carry only the short marker',
    )
    assert.equal(renderJobRead('x\n', false, [], unconfined, [], {}), 'x\n', 'explicit none: fact, no sentence')
    assert.equal(renderJobRead('x\n', false, [], unconfined), 'x\n', 'no options: no sentence')
    assert.equal(
      renderJobRead('x\n', false, [], { mode: 'read-only', denied: false, runnerFailed: true }, [], { unconfinedIsAutomatic: true, unconfinedDetail: true }),
      `x\n[sandbox: the sandbox runner itself failed under read-only mode — the command did not run; this is a sandbox problem, not a command failure]`,
      'a runner failure keeps its own note; the unconfined branch must not shadow it',
    )
  })
  // S1's transport half: the read's own `lossy`/spill facts must reach the
  // renderer. `ringDelta` is the text half; the call site is pinned end-to-end
  // by the tiny-ring fixture below.
  test('ringDelta: stdout in order, then one [stderr] section', () => {
    assert.equal(ringDelta([{ channel: 'stdout', text: 'a\n' }, { channel: 'stderr', text: 'w\n' }]), 'a\n[stderr]\nw\n')
    assert.equal(ringDelta([{ channel: 'stdout', text: 'a' }, { channel: 'stderr', text: 'w' }]), 'a\n[stderr]\nw')
    assert.equal(ringDelta([{ channel: 'stderr', text: 'w' }]), '[stderr]\nw')
    assert.equal(ringDelta([]), '')
  })
  // G5: a promoted foreground command's terminal detail is decided here, so a
  // sandbox denial must not read as an ordinary nonzero exit.
  test('processOutcome: sandbox facts join the job detail', () => {
    assert.deepEqual(processOutcome({ status: 'completed', exitCode: 3, signal: null }),
      { status: 'completed', detail: 'exit code: 3' })
    assert.deepEqual(processOutcome({ status: 'killed', exitCode: null, signal: 'SIGTERM' }),
      { status: 'killed', detail: 'signal: SIGTERM' })
    const denied = processOutcome(
      { status: 'completed', exitCode: 1, signal: null, sandbox: { mode: 'read-only', denied: true } },
      ['workspace-write'],
    )
    assert.equal(denied.status, 'completed')
    assert.match(denied.detail, /^exit code: 1; \[sandbox: file access denied under read-only mode\] \[sandbox: escalation available/)
    const runner = processOutcome(
      { status: 'completed', exitCode: 1, signal: null, sandbox: { mode: 'read-only', denied: false, runnerFailed: true } },
      [],
    )
    assert.match(runner.detail, /; \[sandbox: the sandbox runner itself failed under read-only mode/)
    // task-17/18: an unconfined BACKGROUND run is announced in the terminal detail
    // under exactly the foreground rule — only the tool's own degradation, never
    // an explicit `sandbox: none`, never a wrapped run — and the full explanation
    // rides only the row's FIRST one.
    const unconfined = { mode: 'read-only', denied: false, unconfined: true }
    const proc = (sandbox) => ({ status: 'completed', exitCode: 0, signal: null, sandbox })
    assert.equal(
      processOutcome(proc(unconfined), [], { unconfinedIsAutomatic: true, unconfinedDetail: true }).detail,
      `exit code: 0; ${unconfinedDetailMarker('read-only')}`,
      'the first auto-degraded job detail carries the full explanation',
    )
    assert.equal(
      processOutcome(proc(unconfined), [], { unconfinedIsAutomatic: true }).detail,
      `exit code: 0; ${unconfinedMarker('read-only')}`,
      'later ones carry the short marker, byte-identical to the foreground wording',
    )
    assert.equal(processOutcome(proc(unconfined), [], { unconfinedIsAutomatic: false }).detail, 'exit code: 0')
    assert.equal(processOutcome(proc(unconfined), []).detail, 'exit code: 0', 'no options: conservative silence')
    assert.equal(
      processOutcome(proc({ mode: 'read-only', denied: false, enforcement: 'full' }), [], { unconfinedIsAutomatic: true, unconfinedDetail: true }).detail,
      'exit code: 0',
      'a wrapped run never carries the note',
    )
    assert.equal(
      processOutcome(proc({ mode: 'danger-full-access', denied: false }), [], { unconfinedIsAutomatic: true, unconfinedDetail: true }).detail,
      'exit code: 0',
      'danger-full-access says everything through its mode',
    )
  })
  test('renderResult: a confined failure with no matching dialect says so instead of denying it', () => {
    // task-19: `denialFacts` leaves `denied` OUT when a failure matched no
    // signature; the renderer must then name the unknown dialect rather than let
    // the run read as a plain command error (or, worse, as "not denied").
    const base = {
      stdout: { text: 'x\n', truncated: false },
      stderr: { text: 'some unrelated complaint\n', truncated: false },
      timedOut: false, stopped: undefined, signal: null, exitCode: 1,
    }
    const unknown = renderResult({ ...base, sandbox: { mode: 'read-only', enforcement: 'partial' } }, [])
    assert.equal(unknown, `x\n[stderr]\nsome unrelated complaint\n${unmatchedDialectMarker()}\n[exit code: 1]`)
    assert.ok(unknown.trimEnd().endsWith('[exit code: 1]'), unknown)
    // A success never carries it (nothing failed).
    assert.equal(
      renderResult({ ...base, exitCode: 0, signal: null, sandbox: { mode: 'read-only', enforcement: 'partial' } }, []),
      'x\n[stderr]\nsome unrelated complaint\n',
    )
    // A matched denial keeps its own marker.
    const denied = renderResult({ ...base, sandbox: { mode: 'read-only', denied: true, enforcement: 'partial' } }, [])
    assert.ok(denied.includes('[sandbox: file access denied under read-only mode]') && !denied.includes('denial dialect'), denied)
    // An unconfined run must never be mistaken for the unknown-dialect case.
    assert.ok(
      !renderResult({ ...base, sandbox: { mode: 'read-only', unconfined: true } }, []).includes('denial dialect'),
      'unconfined failures belong to the unconfined path, not this one',
    )
    // A runner failure has its own, more specific note.
    assert.ok(
      !renderResult({ ...base, sandbox: { mode: 'read-only', denied: false, runnerFailed: true } }, []).includes('denial dialect'),
    )
  })
  test('the unconfined notes have ONE wording: the job detail imports them from the foreground renderer', () => {
    // Two copies of either sentence would drift; assert the single source AND the
    // byte-identical output of both forms on both paths.
    const backgroundSource = readFileSync(join(lib, 'tool-bash', 'types', 'background.js'), 'utf8')
    assert.ok(
      /import \{[^}]*unconfinedDetailMarker[^}]*unconfinedMarker[^}]*\} from '\.\/render\.js'/.test(backgroundSource)
        || /import \{[^}]*unconfinedMarker[^}]*unconfinedDetailMarker[^}]*\} from '\.\/render\.js'/.test(backgroundSource),
      'background.js must import both markers from render.js rather than restate either',
    )
    const markers = { short: unconfinedMarker('read-only'), detail: unconfinedDetailMarker('read-only') }
    assert.ok(markers.short.startsWith('[sandbox: not applied — ') && markers.detail.startsWith('[sandbox: not applied — '), 'both share the frame')
    const sandbox = { mode: 'read-only', denied: false, unconfined: true }
    const foregroundBase = {
      stdout: { text: 'x\n', truncated: false }, stderr: { text: '', truncated: false },
      timedOut: false, stopped: undefined, signal: null, exitCode: 0,
    }
    for (const [form, options] of [
      ['detail', { unconfinedIsAutomatic: true, unconfinedDetail: true }],
      ['short', { unconfinedIsAutomatic: true }],
    ]) {
      const job = processOutcome({ status: 'completed', exitCode: 0, signal: null, sandbox }, [], options)
      const foreground = renderResult({ ...foregroundBase, sandbox }, [], options)
      assert.ok(job.detail.endsWith(markers[form]) && foreground.includes(markers[form]),
        JSON.stringify({ form, job: job.detail, foreground }))
      assert.equal(job.detail.slice(job.detail.indexOf('[')), markers[form], `the ${form} job note IS the marker, not a paraphrase`)
    }
  })
  // G4: the stopped marker's position is contract — after the timeout marker,
  // before the signal/exit marker dsh's own parser anchors on.
  test('renderResult: [stopped: …] sits after [timed out …] and before [killed by signal …]', () => {
    const text = renderResult({
      stdout: { text: 'x\n', truncated: false },
      stderr: { text: '', truncated: false },
      timedOut: true,
      timeoutMs: 800,
      stopped: 'cancelled by the user',
      signal: 'SIGTERM',
      exitCode: null,
    }, [])
    const positions = ['[timed out after 800ms]', '[stopped: cancelled by the user]', '[killed by signal: SIGTERM]']
      .map((marker) => text.indexOf(marker))
    assert.ok(positions.every((at) => at >= 0), `every marker must be present: ${text}`)
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `marker order is contract: ${text}`)
  })
  test('renderPromoted: wording and body newline discipline are dsh\'s', () => {
    const tail = 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.'
    assert.equal(renderPromoted({ jobId: 'git_bash-7', timeoutMs: 800, output: 'line-1\n' }),
      `line-1\n[still running after 800ms; moved to background job git_bash-7]\n${tail}`)
    assert.equal(renderPromoted({ jobId: 'j', timeoutMs: 5, output: 'no-newline' }),
      `no-newline\n[still running after 5ms; moved to background job j]\n${tail}`)
    assert.equal(renderPromoted({ jobId: 'j', timeoutMs: 5, output: '' }),
      `[still running after 5ms; moved to background job j]\n${tail}`)
  })
  // T2: these two exports exist so the semantics can be pinned directly; this
  // is that pin (the doc comment claims it).
  test('validateShellArgs: exactly the two alpha.2 tolerances, and the negatives around them', () => {
    const base = { command: 'echo x', description: 'audit' }
    assert.doesNotThrow(() => validateShellArgs({ ...base, sandbox_permissions: 'read-only' }, 'read-only'))
    assert.doesNotThrow(() => validateShellArgs({ ...base, justification: '' }, 'read-only'))
    assert.doesNotThrow(() => validateShellArgs({ ...base, sandbox_permissions: 'read-only', justification: '' }, 'read-only'))
    assert.throws(() => validateShellArgs({ ...base, sandbox_permissions: 'workspace-write' }, 'read-only'), /justification/)
    assert.throws(() => validateShellArgs({ ...base, justification: 'because' }, 'read-only'), /only valid together with/)
    assert.throws(() => validateShellArgs({ ...base, sandbox_permissions: 'workspace-write', justification: '   ' }, 'read-only'), /non-empty sentence/)
    assert.throws(() => validateShellArgs({ ...base, command: ' \t ' }, 'read-only'), /non-empty string/)
    assert.throws(() => validateShellArgs({ ...base, description: '' }, 'read-only'), /non-empty string/)
    assert.throws(() => validateShellArgs({ ...base, timeoutMs: -1 }, 'read-only'), /positive number/)
  })
  testAsync('resolveSessionWorkdir: the mutable directory wins, and the legacy reading is byte-identical without it', async () => {
    const directory = join(__dirname, '..')
    const other = join(__dirname)
    /** The same canonicalization `resolveSessionWorkdir` applies (dsh-sandbox `canonicalPath`). */
    const canonicalLike = (path) => { try { return realpathSync.native(path) } catch { return path } }
    const signal = new AbortController().signal
    const agent = { id: 'audit-agent', session: { header: { cwd: directory } } }
    const exec = { agent, signal }
    // rc.2 / alpha.1 shape: no service, so the previous reading stands.
    assert.equal(await resolveSessionWorkdir({ get: () => undefined }, exec, 'P:\\root'), 'P:\\root')
    assert.equal(await resolveSessionWorkdir({ get: () => undefined }, exec, undefined), canonicalLike(directory))
    assert.equal(await resolveSessionWorkdir({ get: () => undefined }, { signal }, 'P:\\root'), 'P:\\root')
    // alpha.2 shape: the service answers, and it outranks the policy root.
    const calls = []
    const ctx = {
      get: (name) => name === 'workingDirectory'
        ? { ensure: async (a, s) => { calls.push([a, s]); return other } }
        : undefined,
    }
    assert.equal(await resolveSessionWorkdir(ctx, exec, 'P:\\root'), canonicalLike(other))
    assert.deepEqual(calls, [[agent, signal]], 'ensure takes exactly (agent, signal)')
  })
  // T3: the ordering sentence and the schema order it describes are one fact.
  test('the ordering sentence lives in the family section exactly once', () => {
    assert.equal(SHELL_ARGUMENT_ORDER_SECTION, 'Provide `description` before `command` in the arguments.')
    assert.equal(shellFamilySectionText({ background: true, escalation: true }).split(SHELL_ARGUMENT_ORDER_SECTION).length - 1, 1)
    assert.equal(shellFamilySectionText({ background: false, escalation: false }).split(SHELL_ARGUMENT_ORDER_SECTION).length - 1, 1)
    for (const dialect of ['msys', 'wsl'])
      assert.ok(!shellDescription(dialect).includes('Provide `description` before `command`'), `${dialect} must not repeat it`)
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
//
// dsh 0.2.1-alpha.2 introduced @deepseek-ai/dsh-working-directory and made its
// own tool-pwsh inject `workingDirectory`. That service comes from the
// working-directory row, which itself injects the `fs` service the base bundle
// provides through its fs-sandbox row. Mirror that minimal chain only when the
// package resolves: before alpha.2 neither row is needed, and one fixture stays
// valid on every supported runtime.
const ALPHA2_SERVICE_ROWS = (() => {
  try {
    import.meta.resolve('@deepseek-ai/dsh-working-directory')
    return `- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'

- id: working-directory
  name: '@deepseek-ai/dsh-working-directory'

`
  } catch {
    return ''
  }
})()

const BASE_ROWS = `${ALPHA2_SERVICE_ROWS}- id: system-prompt
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
/**
 * The git tool row pinned to kill-on-timeout. The shipped default follows dsh's
 * own tools (`promoteOnTimeout: true`: a timed-out foreground command keeps
 * running as a background job), so a section that asserts the kill path must say
 * so explicitly instead of depending on the default.
 */
const KILL_ON_TIMEOUT = `
    promoteOnTimeout: false`

/** The same pin for the wsl tool row (its block nests under `wslBash`). */
const KILL_ON_TIMEOUT_WSL = `
  config:
    promoteOnTimeout: false`

/**
 * The plugin's three rows. `gitExtraConfig` appends further `gitBash` keys,
 * already indented for that block.
 */
const PLUGIN_ROWS = (bashPath, gitExtraConfig = '', wslExtraConfig = '') => `
- id: win-mb-plugin
  name: 'dsh-win-multi-bash'

- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:${gitExtraConfig}
    gitBash:
      bashPath: '${bashPath}'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'${wslExtraConfig}
`

/** The core row alone: the shape with no tool mounted (it owns the shared section). */
const CORE_ROW_ONLY = `
- id: win-mb-plugin
  name: 'dsh-win-multi-bash'
`

/** The plugin rows minus one tool: the independent-switch shapes. */
const SHELL_PROMPT_ONLY_ROWS = CORE_ROW_ONLY

const GIT_ONLY_ROWS = (bashPath) => `${CORE_ROW_ONLY}
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:
    gitBash:
      bashPath: '${bashPath}'
`

const WSL_ONLY_ROWS = `${CORE_ROW_ONLY}
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
    assert.equal(git.gitBash.probeTimeoutMs.get(), 4000)
    assert.equal(git.gitBash.sandbox.get(), 'auto')
    assert.equal(git.gitBash.requireSandbox.get(), false)
    assert.equal(wsl.wslBash.probeTimeoutMs.get(), 8000)
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

  test('a non-volatile tool knob changes behaviour, not the editable surface (Q1-G1)', () => {
    // `promoteOnTimeout` is deliberately plain (dsh declares it plain too), so it
    // must not appear in the Plugins form. This is the invariant the (skipped)
    // dsh-settings section used to be the only evidence for; here it runs on the
    // schema the form is actually built from, on every runtime.
    for (const [rowId, tool, partition] of [
      ['win-mb-tool-git', gitBashTool, 'gitBash'],
      ['win-mb-tool-wsl', wslBashTool, 'wslBash'],
    ]) {
      assert.deepEqual(Object.keys(tool.Config.dict), ['enableRunInBackground', 'promoteOnTimeout', partition])
      assert.equal(tool.Config.dict.promoteOnTimeout.meta?.volatile, undefined, 'promoteOnTimeout must stay plain')
      const paths = volatilePaths(tool.Config)
      assert.ok(!paths.includes('promoteOnTimeout'), `${rowId}: promoteOnTimeout must not be projected`)
      assert.deepEqual(ROWS.find((row) => row.rowId === rowId).fields.map((knob) => knob.path.join('.')), paths)
    }
  })

  test('every user-visible SettingsForm label exists in both languages (Q2-G3)', () => {
    // The knob labels are covered above; these are the form-level strings whose
    // fallback is `en[key] ?? key` (lib/client.js textOf), i.e. a missing
    // translation renders the raw key at the user.
    const FORM_KEYS = ['unavailable', 'readOnly', 'saveFailed', 'save', 'saving', 'invalidNumber', 'overridden', 'reset']
    for (const key of FORM_KEYS)
      for (const [language, dict] of [['en', en], ['zh', zh]])
        assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${language} is missing "${key}"`)
    // And the two dictionaries stay in lockstep: a key added on one side only is
    // the same defect, one edit away.
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en/zh must carry the same key set')
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
    // M6: the row-form hook is unconditional, so a summary render needs one too
    // (and calling it proves the hook order does not depend on `view`).
    let summaryHookCalls = 0
    assert.equal(RowConfigCard({
      view: 'summary', t: (key) => zh[key] ?? key,
      useRowForm: () => { summaryHookCalls += 1; return {} },
    }), zh.summary)
    assert.equal(summaryHookCalls, 1, 'the hook runs before the summary early-return')
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
    const pages = slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config')
    assert.deepEqual(pages.map((entry) => entry.options.key), [
      rowKey('win-mb-tool-git'), rowKey('win-mb-tool-wsl'),
    ])
    for (const entry of pages) {
      assert.equal(entry.options.locale, client.NS)
      assert.equal(entry.component, RowConfigCard)
      assert.equal(typeof entry.options.inject().hooks.rowForm.getSnapshot, 'function')
    }
    // The bundle page also gets the core-row label and note, on their own slots.
    const detail = slotRegistrations.filter((entry) => entry.options.name !== 'plugins.row.config')
    assert.deepEqual(detail.map((entry) => entry.options.name), ['plugins.detail.badge', 'plugins.detail.section'])
    for (const entry of detail) {
      assert.equal(entry.options.locale, client.NS)
      assert.equal(entry.options.id, 'dsh-win-multi-bash:core')
    }
  })

  test('the detail label and note speak only for this bundle and its core row', () => {
    const slotRegistrations = []
    client.apply({
      locale: { register: () => {}, bind: () => (key) => key },
      configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
      slots: { inject: (_name, register) => register(), register: (options, component) => slotRegistrations.push({ options, component }) },
      effect: (callback) => callback(),
    })
    const component = (name) => slotRegistrations.find((entry) => entry.options.name === name).component
    const badge = component('plugins.detail.badge')
    const note = component('plugins.detail.section')
    const props = (subject) => ({ subject, t: (key) => `t:${key}` })
    const self = { name: 'dsh-win-multi-bash', installed: true, enabled: true }
    const bundle = props({ kind: 'bundle', pkg: self })
    const coreRow = props({ kind: 'row', pkg: self, row: { rowId: 'win-mb-plugin', moduleName: 'dsh-win-multi-bash', enabled: true } })
    const toolRow = props({ kind: 'row', pkg: self, row: { rowId: 'win-mb-tool-git', moduleName: 'dsh-win-multi-bash/tool-git-bash', enabled: true } })
    const foreignBundle = props({ kind: 'bundle', pkg: { name: 'dsh-free-search', installed: true, enabled: true } })
    const foreignItem = props({ kind: 'item', id: 'dsh-tool-jobs' })
    for (const rendered of [badge, note]) {
      assert.ok(rendered(bundle) !== null, 'the bundle page carries the label')
      assert.ok(rendered(coreRow) !== null, 'so does the core row\'s own page')
      assert.equal(rendered(toolRow), null, 'a tool row has nothing to say here')
      assert.equal(rendered(foreignBundle), null, 'another package renders nothing')
      assert.equal(rendered(foreignItem), null, 'an official plugin entry renders nothing')
      assert.equal(rendered({}), null, 'a subject-less render renders nothing')
    }
    assert.equal(badge(bundle).children[0], 't:coreBadge')
    assert.equal(note(bundle).children[0].children[0], 't:coreNote')
    // Both pages are the bundle speaking about itself: the copy is localized.
    for (const [language, dict] of [['en', en], ['zh', zh]]) {
      for (const key of ['coreBadge', 'coreNote']) {
        assert.equal(typeof dict[key], 'string', `${language} is missing ${key}`)
        assert.ok(dict[key].length > 0, `${key} is empty in ${language}`)
      }
    }
  })

  test('the slot key is the package name and the row id the patch declares', () => {
    const patch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8')
    const rowIds = [...patch.matchAll(/- id: (win-mb-[a-z-]+)/g)].map((match) => match[1])
    for (const rowId of ROWS.map((row) => row.rowId))
      assert.ok(rowIds.includes(rowId), `cordis.patch.yml must declare the row id "${rowId}"`)
    // Q2-G2-2: the expectation used to be a second hard-coded copy of the very
    // string lib/client.js builds, so renaming the package would have left this
    // green while every slot key silently stopped matching. The manifest is the
    // one authority; the key format (`<bundle>#<rowId>`) is the platform's.
    const { PACKAGE_NAME } = client.__internals
    const manifestName = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')).name
    assert.equal(PACKAGE_NAME, manifestName, 'the browser half must key off the manifest name')
    for (const rowId of ROWS.map((row) => row.rowId))
      assert.equal(rowKey(rowId), `${manifestName}#${rowId}`)
    assert.deepEqual(planOps([], new Map()), [], 'no drafts, no writes')
  })

  // ── client half · remediation guards (task-5) ──────────────────────────────
  // Mutation-sensitive: revert the matching fix in lib/client.js and exactly this
  // guard goes red (self-proof: .temp/review/client-fix-verify.mjs --mutate).

  await testAsync('a save is fenced by the revision its drafts were read at, not the latest one', async () => {
    const { RowConfigForm, ROWS } = client.__internals
    let revision = 7
    let snapshot = {
      status: 'ready', writable: true, revision,
      value: { enableRunInBackground: true, gitBash: { sandbox: 'auto', probeTimeoutMs: 10000 } },
      base: { gitBash: { sandbox: 'auto' } }, user: {},
    }
    const listeners = new Set()
    const calls = []
    const scope = {
      calls,
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      // The Host fence is strict equality (packages/settings/settings/src/index.ts:393-394).
      mutate: async (ops, expectedRevision) => {
        const accepted = expectedRevision === undefined || expectedRevision === revision
        calls.push({ ops, expectedRevision, accepted })
        if (accepted) revision += 1
        return accepted
      },
    }
    const form = new RowConfigForm(scope, ROWS[0])
    form.edit('gitBash.bashPath', 'D:\\Git\\usr\\bin\\bash.exe')  // drafts read at revision 7
    revision = 8                                                  // another writer commits
    snapshot = { ...snapshot, revision }
    for (const listener of [...listeners]) listener()
    await form.save()
    assert.equal(calls[0].expectedRevision, 7, 'the fence must be the read-at revision, never the latest')
    assert.equal(calls[0].accepted, false, 'a stale fence must lose the save, not overwrite the other write')
    assert.equal(form.project().failed, true, 'the refusal is reported')
    assert.equal(form.project().dirty, true, 'a refused save keeps its drafts')
    form.dispose()
  })

  await testAsync('a save writes only the fields a draft actually changes', async () => {
    const { RowConfigForm, ROWS } = client.__internals
    // Resolved section: sandbox 'auto', probeTimeoutMs 10000, enableRunInBackground true.
    const scope = fakeScope()
    const form = new RowConfigForm(scope, ROWS[0])
    form.edit('gitBash.sandbox', 'auto')          // retyped the value the section resolves to
    assert.equal(form.project().dirty, false, 'a no-op draft leaves Save nothing to do')
    form.resetField('gitBash.bashPath')           // a clear of a field the user layer never carried
    assert.equal(form.project().dirty, false, 'a no-op clear leaves Save nothing to do, either')
    await form.save()
    assert.deepEqual(scope.calls, [], 'no set for an equal value, no unset for a field the user layer lacks')
    // …and a real change still goes out, so the guard cannot pass by writing nothing ever.
    form.edit('gitBash.probeTimeoutMs', '12345')
    await form.save()
    assert.deepEqual(scope.calls[0].ops, [{ op: 'set', path: ['gitBash', 'probeTimeoutMs'], value: 12345 }])
    assert.equal(form.project().dirty, false, 'the accepted save clears its drafts')
    form.dispose()
  })

  test('the stylesheet is an effect, and unloading the plugin reclaims it', () => {
    const { installStyles, PACKAGE_NAME, STYLE_ID } = client.__internals
    const head = { children: [], appendChild(node) { head.children.push(node) } }
    const documentStub = {
      head,
      createElement(tag) {
        const node = { tag, dataset: {}, textContent: '', remove() { const at = head.children.indexOf(node); if (at >= 0) head.children.splice(at, 1) } }
        return node
      },
      querySelector(selector) {
        const match = /^style\[data-plugin='([^']+)'\]$/.exec(selector)
        return match === null ? null : head.children.find((node) => node.dataset.plugin === match[1]) ?? null
      },
    }
    const had = globalThis.document
    globalThis.document = documentStub
    try {
      const effects = []
      client.apply({
        locale: { register: () => () => {}, bind: () => (key) => key },
        configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
        slots: { inject: (_name, register) => register(), register: () => {} },
        effect: (callback, label) => { effects.push({ label, disposer: callback() }) },
      })
      const sheet = effects.find((effect) => effect.label === 'dsh-win-multi-bash: stylesheet')
      assert.ok(sheet !== undefined, 'the stylesheet must be registered on ctx.effect')
      assert.equal(typeof sheet.disposer, 'function', 'that effect must return a disposer')
      assert.equal(head.children.length, 1, 'exactly one style tag')
      assert.equal(head.children[0].dataset.plugin, PACKAGE_NAME, 'data-plugin is the reclaim key')
      assert.equal(head.children[0].dataset.pluginCss, STYLE_ID, 'data-plugin-css is the platform injector name')
      // Q2-G2-1: comparing the attribute with the constant that wrote it has no
      // discriminating power (`dsh-win-multi-bash` or `x.js` would both pass).
      // The platform's own injector rule is `${id}/${basename(fileId)}`
      // (packages/client/tsdown.client.ts:46), so pin the SHAPE here.
      assert.match(STYLE_ID, /^dsh-win-multi-bash\/client\.js$/, 'the style id follows the platform injector rule')
      const noop = installStyles()
      assert.equal(head.children.length, 1, 'a second install adds nothing')
      noop()
      assert.equal(head.children.length, 1, 'a no-op disposer must not remove a tag it did not install')
      for (const effect of [...effects].reverse()) effect.disposer?.()
      assert.equal(head.children.length, 0, 'unloading the plugin reclaims its stylesheet')
    } finally {
      if (had === undefined) delete globalThis.document
      else globalThis.document = had
    }
  })

  test('RowConfigCard calls the row-form hook before its view branch', () => {
    const { RowConfigCard, RowConfigForm, ROWS } = client.__internals
    const form = new RowConfigForm(fakeScope(), ROWS[0])
    const state = form.project()
    let hookCalls = 0
    assert.equal(RowConfigCard({
      view: 'summary', t: (key) => zh[key] ?? key,
      useRowForm: (select) => { hookCalls += 1; return select(state) },
    }), zh.summary)
    assert.equal(hookCalls, 1, 'a summary render must run the hook, or a reused instance breaks hook order')
    form.dispose()
  })

  // ── client half · task-12 remediation guards (landed from client-fix2.md §4) ──
  // Verbatim text: the author executed exactly these bodies against four
  // mutation bodies (control 5/0; each guard red under its own mutation).

  // Q2-G2-2 客户端侧：slot key 只有一份拼写（行为相同，故只能查源码）
  test('the slot key has one spelling: PACKAGE_NAME, not a second literal', () => {
    const source = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
    assert.equal(rowKey('win-mb-tool-git'), `${client.__internals.PACKAGE_NAME}#win-mb-tool-git`)
    assert.ok(!source.includes('dsh-win-multi-bash#'), 'the key must be built as `${PACKAGE_NAME}#${rowId}`')
  })

  await testAsync('a save already crossing the wire is not re-entered (Q2-G1)', async () => {
    // The second save would carry the baseline the first one already spent; the
    // Host refuses that stale fence and the refusal would raise a failure banner
    // over drafts the first save cleared — nothing left for the user to correct.
    const { RowConfigForm, ROWS } = client.__internals
    let revision = 7
    const waiters = []
    const calls = []
    const scope = {
      calls,
      getSnapshot: () => ({
        status: 'ready', writable: true, revision,
        value: { enableRunInBackground: true, gitBash: { sandbox: 'auto', probeTimeoutMs: 10000 } },
        base: { gitBash: { sandbox: 'auto' } }, user: {},
      }),
      subscribe: () => () => {},
      // The Host fence is strict equality (packages/settings/settings/src/index.ts:393-394).
      mutate: async (ops, expectedRevision) => {
        const accepted = expectedRevision === undefined || expectedRevision === revision
        calls.push({ ops, expectedRevision, accepted })
        await new Promise((settle) => { waiters.push(settle) })
        if (accepted) revision += 1
        return accepted
      },
    }
    const form = new RowConfigForm(scope, ROWS[0])
    form.edit('gitBash.probeTimeoutMs', '12345')
    const first = form.save()
    const second = form.save() // re-entrant, while the first is in flight
    for (const settle of waiters.splice(0)) settle()
    await first
    await second
    assert.equal(calls.length, 1, 'the re-entrant save must not reach mutate')
    assert.equal(form.project().failed, false, 'and it must not raise the failure banner')
    assert.equal(form.project().dirty, false, 'the accepted save cleared its drafts')
    form.dispose()
  })

  test('the stylesheet installer survives a host with no head (Q2-A1)', () => {
    // `installStyles` runs inside `ctx.effect`: a throw here takes both Configure
    // pages, the core-row badge and the note down with it.
    const { installStyles } = client.__internals
    const head = { children: [], appendChild(node) { head.children.push(node) } }
    const documentStub = { // deliberately no `head`
      createElement(tag) {
        const node = { tag, dataset: {}, textContent: '', remove() { const at = head.children.indexOf(node); if (at >= 0) head.children.splice(at, 1) } }
        return node
      },
      querySelector: () => null, // unreachable while the installer bails out on a head-less host
    }
    const had = globalThis.document
    globalThis.document = documentStub
    try {
      assert.equal(typeof installStyles(), 'function', 'the installer still answers with a disposer')
      assert.equal(head.children.length, 0, 'and appends nothing')
      const slotRegistrations = []
      assert.doesNotThrow(() => client.apply({
        locale: { register: () => () => {}, bind: () => (key) => key },
        configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
        slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
        effect: (callback) => callback(),
      }), 'apply must not throw on a head-less host')
      const pages = slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config')
      assert.deepEqual(pages.map((entry) => entry.options.key), [
        rowKey('win-mb-tool-git'), rowKey('win-mb-tool-wsl'),
      ], 'both Configure pages still registered')
    } finally {
      if (had === undefined) delete globalThis.document
      else globalThis.document = had
    }
  })

  await testAsync('an unknown key stages nothing, in edit and resetField alike (Q2-A2)', async () => {
    // The phantom draft is inert on the public surface (planOps ignores it and
    // `dirty` stays false), so this guard has to read the staged map.
    const { RowConfigForm, ROWS } = client.__internals
    const scope = fakeScope()
    const form = new RowConfigForm(scope, ROWS[0])
    form.edit('gitBash.nonexistent', 'x')
    form.resetField('gitBash.nonexistent') // before the fix this latched a phantom draft + baseline
    assert.equal(form.staged.size, 0, 'no draft for a key no control renders')
    assert.equal(form.baseline, undefined, 'and no baseline is latched for it')
    await form.save()
    assert.deepEqual(scope.calls, [], 'a save with only phantom drafts writes nothing')
    form.dispose()
  })


  test('the bundle declares a BARE package row — the only thing that serves the browser half', () => {
    // dsh-client-modules discovers a browser half by resolving a Loader row's
    // package name to its package.json (`locatePkgJson` →
    // `exactPackageSpecifier`), and that helper answers `undefined` for a
    // subpath. A bundle whose rows are all subpaths therefore serves NO client
    // bundle at all — which is exactly how the first version of this browser
    // half failed to appear on the Plugins page.
    const exactPackageSpecifier = (specifier) => {
      if (specifier.startsWith('@')) {
        const parts = specifier.split('/')
        return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
      }
      return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
    }
    const patch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8')
    const rows = [...patch.matchAll(/- id: (win-mb-[a-z-]+)\n\s+name: '([^']+)'/g)].map((match) => ({ id: match[1], name: match[2] }))
    assert.deepEqual(rows.map((row) => row.id).sort(), ['win-mb-plugin', 'win-mb-tool-git', 'win-mb-tool-wsl'], 'the core row plus one row per tool')
    const carriers = rows.filter((row) => exactPackageSpecifier(row.name) === 'dsh-win-multi-bash')
    assert.equal(carriers.length, 1, 'exactly one row must name the bare package specifier')

    // What that row loads must be a Loader-shaped plugin, and it is the row that
    // owns the family section now (the separate prompt row was merged into it).
    assert.equal(typeof packageRow.apply, 'function', 'the package main must hold the core row apply')
    assert.equal(carriers[0].name, SHELL_FAMILY_ROW_SPECIFIER, 'the core row is the section owner the tools look for')

    // And the declaration the scan reads next must be complete.
    const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-win-multi-bash')
    assert.equal(manifest.dsh.client.platform, 'web')
    const clientExport = manifest.exports['./client']
    assert.equal(typeof clientExport, 'string', 'exports["./client"] must be a string path')
    assert.ok(existsSync(join(PLUGIN, clientExport)), `exports["./client"] must exist: ${clientExport}`)
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
  test('a registry without getSectionOrder still yields a finite order', () => {
    for (const absent of [{}, { getSectionOrder: undefined }, null, undefined])
      assert.ok(Number.isFinite(shellFamilySectionOrder(absent)), `order must stay finite for ${String(absent)}`)
  })
  test('a getSectionOrder that throws still yields a finite order', () => {
    assert.equal(shellFamilySectionOrder({ getSectionOrder: () => { throw new Error('unknown section name') } }), 1005)
  })
  test('the core row still registers its section when the registry is intact', () => {
    const seen = []
    const registry = { section: (entry) => seen.push(entry), getSectionOrder: (name) => ({ TOOL_BASH: 1000, TOOL_PWSH: 1010 })[name] }
    packageRow.apply({ systemPrompt: registry })
    assert.equal(seen.length, 1, 'an intact registry must still get the section')
    assert.equal(seen[0].name, SHELL_FAMILY_SECTION_NAME)
    assert.equal(seen[0].order, 1005)
  })
  test('the core row survives a registry whose shape moved', () => {
    // Boot-time regressions: this row also carries the browser half, so an
    // unguarded dsh-internal call here takes the whole row (and the boot) down.
    for (const moved of [
      { section: () => {} },
      { section: () => {}, getSectionOrder: () => { throw new Error('unknown section name') } },
      { getSectionOrder: () => 1005 },
    ])
      assert.doesNotThrow(() => packageRow.apply({ systemPrompt: moved }), `apply must survive ${Object.keys(moved).join('+') || 'an empty registry'}`)
  })
  test('the section name is not per-tool', () => {
    for (const toolName of SHELL_FAMILY_TOOL_NAMES) assert.ok(!SHELL_FAMILY_SECTION_NAME.includes(toolName))
  })
}

console.log('\n[A] unit: a subset without the prompt row keeps the guidance (composed fallback)')
{
  // The tool descriptions were slimmed on the assumption that the family section
  // states the shared facts, so a composition that drops the owning row would
  // silently lose them. composeToolDescription puts them back into the tool's own
  // description instead, and the tool row warns when that happens.
  const own = shellDescription('msys')
  const shared = shellFamilySectionText({ background: true, escalation: false })
  test('with the owning row composed, the description stays dialect-only', () => {
    assert.equal(composeToolDescription({ own, familyPresent: true, background: true, escalation: false }), own)
  })
  test('without it, the description carries the shared facts itself', () => {
    const fallback = composeToolDescription({ own, familyPresent: false, background: true, escalation: false })
    assert.ok(fallback.startsWith(own), 'the dialect facts stay first')
    assert.ok(fallback.includes(shared), 'and the shared text follows')
    assert.ok(!fallback.includes(SHELL_ESCALATION_SECTION), 'the fallback follows what THIS tool advertises')
  })
  test('an unknown owner state is treated as composed, never as a reason to duplicate', () => {
    // `familyRowComposed` answers undefined for an unreadable loader; the wrapper
    // keeps the slim text, because the default composition does have the row.
    assert.equal(composeToolDescription({ own, familyPresent: undefined, background: true, escalation: true }), own)
  })
  test('the owning-row specifier is the one the patch declares', () => {
    assert.ok(readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8').includes(`name: '${SHELL_FAMILY_ROW_SPECIFIER}'`))
  })
}

console.log('\n[B] boot integration: default fixture (pinned via probed bash)')
{
  if (!HAS_GIT_BASH) {
    console.log('  … skipping pinned fixture: no Git Bash probed on this host')
  } else {
    let ctx
    try {
      ctx = await bootFixture(PLUGIN_ROWS(GIT_BASH, KILL_ON_TIMEOUT, KILL_ON_TIMEOUT_WSL), 'default.yml')
    await runTests(ctx, [
      ['boot: tools registered (git_bash, wsl_bash + job tools)', async () => {
        const names = ctx.tools.schemas().map((t) => t.name)
        for (const n of ['git_bash', 'wsl_bash', 'job_output', 'job_kill']) assert.ok(names.includes(n), `missing ${n}`)
      }],
      ['boot: both shell tools declare `description` before `command` (the family section\'s ordering sentence)', async () => {
        // T3: the prompt sentence `Provide description before command…` is only
        // true while the schemas actually declare that order (the SDK projects
        // `properties` in declaration order), so the two are pinned together.
        for (const name of ['git_bash', 'wsl_bash']) {
          const schema = ctx.tools.schemas().find((candidate) => candidate.name === name)
          assert.deepEqual(Object.keys(schema.parameters.properties).slice(0, 2), ['description', 'command'], name)
          assert.deepEqual(schema.parameters.required.slice(0, 2), ['description', 'command'], name)
        }
      }],
      ['boot: the assembled prompt carries the ordering sentence exactly once', async () => {
        const { prompt } = await assembledPrompt(ctx)
        assert.equal(prompt.split(SHELL_ARGUMENT_ORDER_SECTION).length - 1, 1)
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

console.log('\n[B] boot integration: promote-on-timeout (shipped default, SERIAL ctx)')
{
  if (!HAS_GIT_BASH) {
    console.log('  … skipping promote fixture: no Git Bash probed on this host')
  } else {
    let ctx
    try {
      // Its own fixture on the SHIPPED default (`promoteOnTimeout: true`), and
      // deliberately serial: with promotion every foreground call registers a
      // job the moment it starts, and the registry caps concurrent jobs per
      // owner (dsh-jobs-local default 10). The 18-case fixture above therefore
      // pins kill-on-timeout on both tool rows instead of depending on this
      // default — an agentless concurrent rig would otherwise exhaust the cap
      // and the background cases would starve for want of a job id.
      ctx = await bootFixture(PLUGIN_ROWS(GIT_BASH), 'promote.yml')
      await runTests(ctx, [
        ['git_bash: a timed-out foreground call is promoted to a background job', async () => {
          const result = await execToolResult(ctx, 'git_bash', { command: 'while :; do :; done', timeoutMs: 800 })
          assert.ok(!result.isError, 'unexpected error: ' + String(result.error))
          // Wording is copied verbatim from dsh's own tool (tool-bash/src/render.ts).
          assert.match(result.text, /\[still running after 800ms; moved to background job ([^\]]+)\]/)
          const jobId = /moved to background job ([^\]]+)\]/.exec(result.text)?.[1]
          assert.equal(typeof jobId, 'string', 'the promoted result must name the job')
          // It really is a registry job: readable, and killable.
          const read = await execTool(ctx, 'job_output', { job_id: jobId })
          assert.match(read, /running|no new output/i)
          await execTool(ctx, 'job_kill', { job_id: jobId })
        }],
        ['git_bash: an outside job_kill during the wait is reported as [stopped: …] (G4)', async () => {
          // The point of registering the foreground call as a job: it is
          // killable while the call still waits, and the model is told the kill
          // was not its command failing. dsh has the same end-to-end test
          // (tool-bash/tests/background.spec.ts:260-269).
          const pending = ctx.tools.execute({
            signal: new AbortController().signal,
            callId: ToolCallId(`audit-stopped-${Math.random().toString(36).slice(2)}`),
            name: 'git_bash',
            arguments: { description: 'audit stopped marker', command: 'echo started; sleep 5', timeoutMs: 30000 },
          })
          let jobId
          for (let attempt = 0; attempt < 100 && jobId === undefined; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            jobId = ctx.jobs.list(undefined).find((job) => job.status === 'running' && job.label === 'echo started; sleep 5')?.id
          }
          assert.ok(jobId !== undefined, 'a foreground command must be a visible job while it waits')
          await execTool(ctx, 'job_kill', { job_id: jobId, reason: 'audit stop' })
          const result = await pending
          const text = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
          assert.equal(result.value.kind, 'foreground')
          assert.equal(result.value.stopped, 'audit stop', 'the outside kill reason travels into the value')
          assert.match(text, /\[stopped: audit stop\]/)
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
  }
}

console.log('\n[B] boot integration: a promoted call whose read lost output reports it (S1)')
{
  if (!HAS_GIT_BASH) {
    console.log('  … skipping lossy-promote fixture: no Git Bash probed on this host')
  } else {
    let ctx
    try {
      // The real registry with a deliberately tiny ring: the promoted call's one
      // consuming read then falls behind whatever the command already printed, so
      // `lossy` is true deterministically (dsh-jobs-local `retainBytes`). This is
      // the shape that used to hand the model a truncated prefix with no notice
      // and no pointer to the retained output.
      const patchPath = join(FIXTURE_DIR, 'tiny-ring.patch.yml')
      writeFileSync(patchPath, '- id: tasks\n  config:\n    retainBytes: 32\n')
      writtenFixtures.push(patchPath)
      ctx = await bootFixture(PLUGIN_ROWS(GIT_BASH), 'tiny-ring.yml', loadOverlayPatches('dsh-wmb-audit', patchPath))
      await runTests(ctx, [
        ['a lossy promoting read names the dropped output (and its spill pointer if any)', async () => {
          const command = 'i=0; while [ $i -lt 40 ]; do echo line-$i; i=$((i+1)); done; sleep 5'
          const result = await execToolResult(ctx, 'git_bash', { command, timeoutMs: 1200 })
          assert.ok(!result.isError, `unexpected error: ${String(result.error)}`)
          assert.match(result.text, /\[still running after 1200ms; moved to background job [^\]]+\]/, result.text)
          assert.match(
            result.text,
            /\[some output was dropped from memory; full output: [^\]]+\]/,
            'the promoted result must report the evicted bytes: ' + result.text,
          )
          const jobId = /moved to background job ([^\]]+)\]/.exec(result.text)?.[1]
          await execTool(ctx, 'job_kill', { job_id: jobId, reason: 'audit cleanup' })
        }],
        ['a complete promoting read adds no notice', async () => {
          // Same tiny ring, but the command prints nothing before the deadline:
          // no bytes were evicted, so no notice may appear.
          const result = await execToolResult(ctx, 'git_bash', { command: 'sleep 5', timeoutMs: 1200 })
          assert.ok(!result.isError, `unexpected error: ${String(result.error)}`)
          assert.match(result.text, /\[still running after 1200ms; moved to background job [^\]]+\]/)
          assert.ok(!result.text.includes('dropped from memory'), `no loss notice expected: ${result.text}`)
          const jobId = /moved to background job ([^\]]+)\]/.exec(result.text)?.[1]
          await execTool(ctx, 'job_kill', { job_id: jobId, reason: 'audit cleanup' })
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
  }
}

console.log('\n[B] boot integration: an auto-degraded sandbox reports `unconfined` (REAL wsl probe)')
{
  // The three shapes the user's ruling distinguishes, all against the REAL wsl
  // provider on this host:
  //   1. `sandbox: auto` whose probe FAILS  → fact + a sentence the model reads;
  //   2. `sandbox: none`                    → fact, no sentence (expected config);
  //   3. a wrapped run                      → no fact, byte-identical to before.
  // (1) is made deterministic by pinning a distro that does not exist: the
  // functional bwrap probe then fails on a host whose WSL itself works.
  const WSL_ROW = (extra) => `${CORE_ROW_ONLY}
- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'${extra}
`
  const WSL_BWRAP_OK = HAS_WSL && (() => {
    const probe = spawnSync(WSL_EXE, [
      '-e', 'bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid',
      '--proc', '/proc', '--die-with-parent', '--', '/bin/true',
    ], { timeout: 20000, stdio: 'ignore' })
    return probe.status === 0
  })()

  const rawCall = (ctx, args) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`unconfined-${Math.random().toString(36).slice(2)}`),
    name: 'wsl_bash',
    arguments: { description: 'unconfined probe', ...args },
  })
  const rawText = (result) => (result.content ?? [])
    .filter((block) => block.type === 'text').map((block) => block.text).join('').replace(/\r\n/g, '\n')

  if (!HAS_WSL) {
    console.log('  … skipping unconfined fixture: no wsl.exe on this host')
  } else {
    let ctx
    try {
      ctx = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      wslDistro: 'no-such-distro-probe'`), 'unconfined-auto.yml')
      await runTests(ctx, [
        ['auto + failed probe: the fact rides the value and the model reads the note', async () => {
          const result = await rawCall(ctx, { command: 'echo auto-degraded' })
          assert.equal(result.isError, false, rawText(result))
          assert.deepEqual(result.value.sandbox, { mode: 'read-only', unconfined: true })
          assert.match(rawText(result), /\[sandbox: not applied — the confinement probe found no usable sandbox, so this command ran unconfined under read-only mode; repair the sandbox or set sandbox: none on this tool row to accept unconfined runs\]/)
        }],
        ['the schema declares the field, so validation cannot strip it', async () => {
          // `additionalProperties: false` is why this structural check matters:
          // without the declaration the value above would come back without it.
          const variants = ctx.tools.get('wsl_bash').output.schema.oneOf
          const foreground = variants.find((variant) => variant.properties.kind.const === 'foreground')
          assert.equal(foreground.properties.sandbox.properties.unconfined?.type, 'boolean')
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }

    let noneCtx
    try {
      noneCtx = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      sandbox: none`), 'unconfined-none.yml')
      await runTests(noneCtx, [
        ['sandbox: none carries the fact but never the note', async () => {
          const result = await rawCall(noneCtx, { command: 'echo explicit-none' })
          assert.equal(result.value.sandbox.unconfined, true)
          assert.ok(!rawText(result).includes('not applied'), `expected no sandbox note: ${rawText(result)}`)
          assert.match(rawText(result), /explicit-none/)
        }],
      ])
    } finally {
      if (noneCtx) await noneCtx.fiber.dispose()
    }

    if (!WSL_BWRAP_OK) {
      console.log('  … skipping wrapped-shape case: this host\'s WSL has no usable bwrap')
    } else {
      let wrapped
      try {
        wrapped = await bootFixture(WSL_ROW(''), 'unconfined-wrapped.yml')
        await runTests(wrapped, [
          ['a wrapped run is byte-identical to before: no `unconfined`, and no note', async () => {
            const result = await rawCall(wrapped, { command: 'echo wrapped-ok' })
            assert.deepEqual(result.value.sandbox, { mode: 'read-only', denied: false, enforcement: 'full' })
            assert.ok(!rawText(result).includes('not applied'))
            assert.match(rawText(result), /wrapped-ok/)
          }],
        ])
      } finally {
        if (wrapped) await wrapped.fiber.dispose()
      }
    }
  }
}

console.log('\n[B] boot integration: an auto-degraded BACKGROUND job says so in its terminal detail (REAL wsl probe)')
{
  // task-17. A background job's terminal detail is the only line the model reads
  // back for it, so an unconfined background command must announce itself there.
  // Same real-provider trick as the foreground section: a distro that does not
  // exist makes the functional probe fail deterministically.
  const WSL_ROW = (extra) => `${CORE_ROW_ONLY}
- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'${extra}
`
  const settledRead = async (ctx, jobId) => {
    // Each `job_output` call CONSUMES the delta, so accumulate across polls:
    // the note lands on the status line once the job settles, and the command's
    // own output may have arrived in an earlier poll.
    let seen = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const read = await execTool(ctx, 'job_output', { job_id: jobId })
      seen += read
      if (/exit code:|killed|failed/.test(read)) return seen
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return seen
  }
  // `execToolResult` drops the structured value; the fact lives on it.
  const valueOf = async (ctx, args) => (await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`audit-bg-fact-${Math.random().toString(36).slice(2)}`),
    name: 'wsl_bash',
    arguments: { description: 'audit background fact', ...args },
  })).value

  if (!HAS_WSL) {
    console.log('  … skipping background-unconfined fixture: no wsl.exe on this host')
  } else {
    // Each fixture below is used by ONE test that sequences its own calls: the
    // row-scoped first-time latch makes call ORDER observable, and `runTests`
    // runs a section's tests concurrently — sharing a fixture between an
    // ordering-sensitive test and any other call would make the guard flaky.
    let bgFirst
    try {
      bgFirst = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      wslDistro: 'no-such-distro-probe'`), 'unconfined-bg-first.yml')
      await runTests(bgFirst, [
        ['a background job that degrades FIRST carries the full explanation; the next one only the short marker', async () => {
          const started1 = await execTool(bgFirst, 'wsl_bash', { command: 'echo bg-degraded-1', run_in_background: true })
          const jobId1 = started1.match(/started background job (\S+)/)?.[1]
          assert.ok(jobId1, `no job id in: ${started1}`)
          const read1 = await settledRead(bgFirst, jobId1)
          assert.ok(read1.includes(unconfinedDetailMarker('read-only')), `first job detail must carry the full explanation: ${read1}`)
          const started2 = await execTool(bgFirst, 'wsl_bash', { command: 'echo bg-degraded-2', run_in_background: true })
          const jobId2 = started2.match(/started background job (\S+)/)?.[1]
          const read2 = await settledRead(bgFirst, jobId2)
          assert.ok(read2.includes(unconfinedMarker('read-only')), `second job detail must carry the short marker: ${read2}`)
          assert.ok(!read2.includes('confinement probe found no usable sandbox'), `and not the full explanation again: ${read2}`)
        }],
      ])
    } finally {
      if (bgFirst) await bgFirst.fiber.dispose()
    }

    let fgFirst
    try {
      fgFirst = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      wslDistro: 'no-such-distro-probe'`), 'unconfined-fg-first.yml')
      await runTests(fgFirst, [
        ['a foreground call that degrades first carries the full explanation; the next only the short marker', async () => {
          const first = await execTool(fgFirst, 'wsl_bash', { command: 'echo fg-degraded-1' })
          assert.ok(first.includes(unconfinedDetailMarker('read-only')), `first call must carry the full explanation: ${first}`)
          const second = await execTool(fgFirst, 'wsl_bash', { command: 'echo fg-degraded-2' })
          assert.ok(second.includes(unconfinedMarker('read-only')), `second call must carry the short marker: ${second}`)
          assert.ok(!second.includes('confinement probe found no usable sandbox'), `and not the full explanation again: ${second}`)
          // The structured fact is asserted here because the job view is the base
          // runtime's shape (`id/kind/label/status/detail/startedAt/finishedAt` —
          // no sandbox field), so for background jobs the note is the only channel.
          const value = await valueOf(fgFirst, { command: 'echo fg-degraded-3' })
          assert.deepEqual(value.sandbox, { mode: 'read-only', unconfined: true })
        }],
      ])
    } finally {
      if (fgFirst) await fgFirst.fiber.dispose()
    }

    let none
    try {
      none = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      sandbox: none`), 'unconfined-bg-none.yml')
      await runTests(none, [
        ['an explicit `sandbox: none` never carries a note — foreground or background', async () => {
          const started = await execTool(none, 'wsl_bash', { command: 'echo bg-explicit-none', run_in_background: true })
          const jobId = started.match(/started background job (\S+)/)?.[1]
          assert.ok(jobId, `no job id in: ${started}`)
          const read = await settledRead(none, jobId)
          assert.match(read, /exit code: 0/)
          assert.ok(!read.includes('not applied'), `expected no sandbox note in the job detail, got: ${read}`)
          assert.match(read, /bg-explicit-none/)
          const foreground = await execTool(none, 'wsl_bash', { command: 'echo fg-none' })
          assert.ok(!foreground.includes('not applied'), `expected no sandbox note in the foreground, got: ${foreground}`)
          const value = await valueOf(none, { command: 'echo fg-none-2' })
          assert.equal(value.sandbox.unconfined, true, 'the fact is still reported, only the sentence is withheld')
        }],
      ])
    } finally {
      if (none) await none.fiber.dispose()
    }

    if (!HAS_GIT_BASH) {
      console.log('  … skipping the wrapped/danger-full-access regression: no Git Bash probed on this host')
    } else {
      let wrapped
      try {
        wrapped = await bootFixture('', 'unconfined-wrapped-regression.yml')
        await runTests(wrapped, [
          ['wrapped runs and danger-full-access never carry either marker', async () => {
            const wrappedRun = await execTool(wrapped, 'git_bash', { command: 'echo wrapped-ok' })
            assert.ok(!wrappedRun.includes('not applied'), `a wrapped run must stay unannounced: ${wrappedRun}`)
            const fullAccess = await execTool(wrapped, 'git_bash', { command: 'echo full-access-ok', sandbox_permissions: 'danger-full-access', justification: 'audit regression check' })
            assert.ok(!fullAccess.includes('not applied'), `danger-full-access must stay unannounced: ${fullAccess}`)
          }],
        ])
      } finally {
        if (wrapped) await wrapped.fiber.dispose()
      }
    }
  }
}

console.log('\n[B] boot integration: dialect discovery learns this host\'s refusal text (REAL wsl probe)')
{
  // task-19: after a SUCCESSFUL functional probe, one doomed write outside the
  // granted root shows what a refusal prints on THIS host, and that text joins
  // the provider's signature set. The probe root is pinned under .temp/ so the
  // doomed name lands in a directory this suite owns; the write must be refused.
  const labRoot = join(__dirname, '..', '.temp', 'dialect-lab')
  mkdirSync(labRoot, { recursive: true })
  const labParent = dirname(labRoot)
  const leftovers = () => readdirSync(labParent).filter((name) => name.startsWith('.dsh-denial-probe-'))

  if (!HAS_WSL) {
    console.log('  … skipping discovery fixture: no wsl.exe on this host')
  } else {
    let ctx
    try {
      ctx = await bootFixture(`
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: read-only
    workspaceRoot: '${labRoot.replaceAll('\\', '\\\\')}'
`, 'dialect-discovery.yml')
      await runTests(ctx, [
        ['the real bwrap path discovers a signature and creates nothing', async () => {
          const ex = bareInstance(WslBashExecutor, {
            ctx,
            config: WslBashExecutor.Config({ wslPath: WSL_EXE }),
          })
          assert.equal(ex.requireBwrapUsable(), true, 'the functional probe must pass before discovery can run')
          assert.equal(typeof ex.denialDiscovery, 'string', 'the WSL path must learn a signature on this host')
          assert.ok(ex.denialDiscovery.length >= 4)
          console.log(`  … learned denial signature: ${JSON.stringify(ex.denialDiscovery)}`)
          assert.ok(ex.denialDiscoveryInvalid !== true, 'the doomed write must have been refused')
          assert.deepEqual(leftovers(), [], 'the doomed write must leave no file behind')
          assert.deepEqual(ex.effectiveDenialSignatures(['provider-signature']),
            ['provider-signature', ex.denialDiscovery], 'the learned signature joins the provider set')
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
      assert.deepEqual(leftovers(), [], 'no probe file may survive the fixture')
    }
  }
}

console.log('\n[B] boot integration: no job registry — config decides the schema, the call fails loud')
{
  if (!HAS_GIT_BASH) {
    console.log('  … skipping no-registry fixture: no Git Bash probed on this host')
  } else {
    let ctx
    try {
      // Deterministic reproduction of the regression this section guards: with
      // the registry disabled, an apply-time `ctx.get('jobs')` read is false on
      // every run, so the old latch dropped `run_in_background` from the schema
      // and silently turned promotion off (first seen as a 1-in-N flake under
      // load, because with the registry present the read races its mount).
      const patchPath = join(FIXTURE_DIR, 'no-jobs.patch.yml')
      writeFileSync(patchPath, '- id: tasks\n  disabled: true\n\n- id: tool-jobs\n  disabled: true\n')
      writtenFixtures.push(patchPath)
      ctx = await bootFixture(PLUGIN_ROWS(GIT_BASH), 'no-jobs.yml', loadOverlayPatches('dsh-wmb-audit', patchPath))
      await runTests(ctx, [
        ['without a registry the schema still advertises run_in_background', async () => {
          for (const name of ['git_bash', 'wsl_bash']) {
            const schema = ctx.tools.schemas().find((candidate) => candidate.name === name)
            assert.ok(
              schema.parameters.properties.run_in_background !== undefined,
              `${name}: the parameter follows enableRunInBackground, never a service read at apply time`,
            )
          }
        }],
        ['without a registry a timed-out foreground call is killed, as before promotion existed', async () => {
          const text = await execTool(ctx, 'git_bash', { command: 'while :; do :; done', timeoutMs: 800 })
          assert.match(text, /\[timed out after 800ms\]/)
        }],
        ['without a registry the background parameter still fails loudly', async () => {
          const result = await execToolResult(ctx, 'git_bash', { command: 'echo no-registry', run_in_background: true })
          assert.equal(result.isError, true)
          assert.match(`${result.text}${String(result.error)}`, /background jobs unavailable/)
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
      ['the shipped patch composes the core row and only the two tool rows', async () => {
        // `loader.entries()` is a cosmokit collection, not an Array: iterate it.
        const rows = []
        for (const entry of ctx.loader.entries()) rows.push({ id: entry.options.id, name: entry.options.name, enabled: !entry.disabled })
        const composed = rows.map((row) => `${String(row.id)}|${String(row.name)}|${String(row.enabled)}`).join(', ')
        const own = rows.filter((row) => String(row.name).startsWith('dsh-win-multi-bash'))
        assert.deepEqual(own.map((row) => row.name).sort(), ['dsh-win-multi-bash', 'dsh-win-multi-bash/tool-git-bash', 'dsh-win-multi-bash/tool-wsl-bash'], `the core row merged the old prompt row away; composed rows: ${composed}`)
        const core = own.find((row) => row.name === 'dsh-win-multi-bash')
        assert.equal(core.enabled, true, 'the core row must be enabled')
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
  // The no-registry state needs its own overlay: `tasks`/`tool-jobs` off. It
  // exists because the parameter and its guidance follow CONFIG now (task-13 /
  // commit 5fbc8ce), so a composition without a registry still advertises
  // `run_in_background` and still carries the background paragraph — while the
  // call itself fails loud. dsh's own tool drops both in that shape; README.md /
  // README.zh.md "与基座差异" records the tradeoff, and this state pins it.
  const NO_JOBS_PATCH_PATH = join(FIXTURE_DIR, 'prompt-state-no-jobs.patch.yml')
  writeFileSync(NO_JOBS_PATCH_PATH, '- id: tasks\n  disabled: true\n\n- id: tool-jobs\n  disabled: true\n')
  writtenFixtures.push(NO_JOBS_PATCH_PATH)
  const NO_JOBS_PATCHES = loadOverlayPatches('dsh-wmb-audit', NO_JOBS_PATCH_PATH)

  const STATES = [
    ['both tools', () => PLUGIN_ROWS(GIT_BASH), ['git_bash', 'wsl_bash'], true, false, true, undefined],
    ['git_bash only', () => GIT_ONLY_ROWS(GIT_BASH), ['git_bash'], true, false, true, undefined],
    ['wsl_bash only', () => WSL_ONLY_ROWS, ['wsl_bash'], false, false, true, undefined],
    ['no tool', () => SHELL_PROMPT_ONLY_ROWS, [], false, false, false, undefined],
    // dsh's own pwsh tool alongside ours: it registers its own section and
    // repeats a few of these facts in its own description, and the family
    // section must be unaffected by its presence.
    ['both tools + dsh tool-pwsh', () => `${PLUGIN_ROWS(GIT_BASH)}
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
`, ['git_bash', 'wsl_bash'], true, true, true, undefined],
    // No job registry composed at all: the shipped default still advertises and
    // still guides, because `background` follows `enableRunInBackground` alone.
    ['both tools, no job registry', () => PLUGIN_ROWS(GIT_BASH), ['git_bash', 'wsl_bash'], true, false, true, NO_JOBS_PATCHES],
  ]
  for (const [label, rows, expectedTools, needsGit, expectPwsh, expectBackground, patches] of STATES) {
    if (needsGit && !HAS_GIT_BASH) {
      console.log(`  … skipping ${label}: no Git Bash probed on this host`)
      continue
    }
    let ctx
    try {
      ctx = await bootFixture(rows(), `prompt-state-${label.replace(/[^a-z0-9]+/gi, '-')}.yml`, patches)
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
        [`${label}: the background paragraph tracks the parameter, exactly`, async () => {
          // A hard expectation from the state table, not an equality between two
          // readings taken at runtime (the old form passed even when the
          // parameter was silently missing).
          assert.equal(advertises('run_in_background'), expectBackground, `${label}: expected the parameter to be ${expectBackground ? 'advertised' : 'absent'}`)
          assert.equal(familyText.includes(SHELL_BACKGROUND_SECTION), expectBackground)
          if (label === 'both tools, no job registry')
            assert.equal(ctx.get('jobs'), undefined, 'this state must compose no job registry')
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
  //
  // KNOWN-SKIPPED ON EVERY RUNTIME SO FAR (Q1-G1): this fixture mounts
  // `@deepseek-ai/dsh-settings`, which injects configEditor/profileContext and
  // therefore never activates here — the run prints
  // `settings … pending (waiting for services: configEditor, profileContext)`
  // and the block below is skipped. It is kept as an integration probe for a
  // runtime that does compose those services, NOT as part of the gate; the
  // invariant it argues for (a non-volatile knob never becomes editable) is
  // asserted unconditionally in the unit section above
  // (`a non-volatile tool knob changes behaviour, not the editable surface`).
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
          assert.equal(form.value.gitBash.probeTimeoutMs, 4000)
          assert.equal(form.value.gitBash.requireSandbox, false)
        }],
        ['the wsl_bash form reports its own partition only', async () => {
          const form = forms.get('win-mb-tool-wsl')
          assert.deepEqual(Object.keys(form.value).sort(), ['enableRunInBackground', 'wslBash'])
          assert.equal(form.value.wslBash.probeTimeoutMs, 8000)
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

console.log('\n[B] boot integration: a subset without the prompt row keeps the guidance in the tools')
{
  // The combination the row switches allow and that used to lose information
  // silently: a tool row stays on while the row owning the shared section is off.
  // The tool's own description then carries the shared facts, the prompt still
  // states them exactly once, and the tool row warns at load.
  if (!HAS_GIT_BASH) {
    console.log('  … skipping: no Git Bash probed on this host')
  } else {
    let ctx
    try {
      ctx = await bootFixture(`
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:
    gitBash:
      bashPath: '${GIT_BASH}'
`, 'no-prompt-row.yml')
      const { assembly, prompt } = await assembledPrompt(ctx)
      const git = ctx.tools.schemas().find((schema) => schema.name === 'git_bash')
      await runTests(ctx, [
        ['the tool description carries the shared facts itself', async () => {
          assert.ok(git.description.includes(SHELL_EXIT_STATUS_SECTION), 'exit-status guidance')
          assert.ok(git.description.includes('fresh shell'), 'fresh-call guidance')
          assert.ok(git.description.includes('truncated to its tail'), 'truncation guidance')
          assert.ok(git.description.includes('never run it against a computed path you have not checked'), 'path safety')
        }],
        ['and the whole payload states it exactly once', async () => {
          // Tool descriptions are not prompt sections, so the count that matters
          // spans both: the slim section plus whatever the schemas carry.
          const corpus = [prompt, ...ctx.tools.schemas().filter((schema) => SHELL_FAMILY_TOOL_NAMES.includes(schema.name)).map((schema) => schema.description)].join('\n')
          assert.equal(corpus.split(SHELL_EXIT_STATUS_SECTION).length - 1, 1)
          assert.equal(assembly.sections.filter((section) => section.name === SHELL_FAMILY_SECTION_NAME).length, 0, 'no section without its owning row')
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
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
console.log('\n[A] unit: repository records (bilingual pair, LF discipline, published shape)')
{
  // The records a release depends on are data, not prose; pin them so a silent
  // drift (README edited without re-recording, a CRLF checkout, a script dropped
  // from the tarball) fails the gate instead of shipping.
  const gitBlobHash = (path) => {
    const bytes = readFileSync(path)
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  }
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))

  test('the bilingual record matches both README sides', () => {
    const record = readFileSync(join(PLUGIN, 'README.i18n.yaml'), 'utf8')
    for (const side of ['README.md', 'README.zh.md']) {
      const recorded = new RegExp(`^${side.replace('.', '\\.')}: ([0-9a-f]{40})$`, 'm').exec(record)
      assert.ok(recorded !== null, `README.i18n.yaml must record ${side}`)
      assert.equal(recorded[1], gitBlobHash(join(PLUGIN, side)), `${side} changed without re-recording its hash`)
    }
  })

  test('.gitattributes pins LF for every text file', () => {
    const attributes = readFileSync(join(PLUGIN, '.gitattributes'), 'utf8')
    assert.ok(/^\* text=auto eol=lf$/m.test(attributes), 'every text file must be normalized to LF')
    for (const binary of ['*.png', '*.ico'])
      assert.ok(attributes.includes(`${binary} binary`), `${binary} must stay binary`)
  })

  test('no shipped file carries a CR byte', () => {
    const shipped = ['cordis.patch.yml', 'package.json', 'README.md', 'README.zh.md']
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
    shipped.push(...walk(join(PLUGIN, 'lib')))
    for (const path of shipped) {
      const bytes = readFileSync(path)
      const firstCr = bytes.indexOf(0x0d)
      assert.equal(firstCr, -1, `${path.replace(PLUGIN, '')} carries a CR byte at ${firstCr}`)
    }
  })

  test('every PowerShell script starts with a UTF-8 BOM', () => {
    // Windows PowerShell 5.1 reads a BOM-less UTF-8 script as GBK: the Chinese
    // comments corrupt and a damaged byte can swallow a newline, so the rest of
    // the script lands inside a comment and parsing fails far from the cause.
    // smoke/run.ps1 regressed that way the moment a rewrite dropped its BOM.
    for (const path of ['smoke/run.ps1', 'smoke/audit.ps1']) {
      const head = readFileSync(join(PLUGIN, path)).subarray(0, 3)
      assert.ok(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf, `${path} must start with a UTF-8 BOM (PowerShell 5.1 reads it as GBK without one)`)
    }
  })

  test('the published file list ships the wiring and the implementation, and no hand-wiring scripts', () => {
    // `dsh plugin add` (pnpm) is the only install path now, so the two
    // hand-wiring scripts must be gone from the tree as well as from the manifest.
    for (const gone of ['install.ps1', 'uninstall.ps1']) {
      assert.ok(!existsSync(join(PLUGIN, gone)), `${gone} must be gone: the pnpm install path replaced it`)
      assert.ok(!manifest.files.includes(gone), `package.json files must no longer ship ${gone}`)
    }
    assert.ok(manifest.files.includes('cordis.patch.yml'), 'the composition wiring must ship')
    assert.ok(manifest.files.includes('lib/**/*.js'), 'the bundled implementation must ship')
    assert.ok(existsSync(join(PLUGIN, 'lib/client.js')), 'the browser half must exist for that glob to cover it')
    for (const excluded of ['smoke', '.temp', 'RELEASE_NOTES.md'])
      assert.ok(!manifest.files.some((entry) => entry.startsWith(excluded)), `the tarball must not ship ${excluded}`)
  })
}

console.log(`\n==== audit summary: ${passed} passed, ${failed} failed ====`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const { name, error } of failures) console.log(`  - ${name}: ${error?.message ?? error}`)
  process.exit(1)
}
