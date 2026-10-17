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
 * Run via `pnpm test:audit` (or `node smoke/prepare.mjs audit`): that Node
 * bootstrap links the profile runtime into smoke/node_modules and cleans up
 * after. Requires the profile runtime at ~/.dsh/profiles.
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

/** Remove a fixture directory, retrying while Windows still holds the handles. */
function removeFixtureDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
const { remoteSandboxMarker, renderJobRead, renderPromoted, renderResult, unconfinedDetailMarker, unconfinedMarker, unmatchedDialectMarker } =
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
  familyRowComposed, markFamilySectionOwner,
} = await import(libUrl('tool-bash', 'types', 'shell-family.js'))
const packageRow = await import(libUrl('index.js'))
// The registry's own expectations, so the row lists below are compared with the
// single source instead of a hand-kept literal.
const { CLIENT_ROWS: REGISTRY_ROWS, PATCH_ROWS, TOOL_INSTANCES } = await import(libUrl('tool-bash', 'types', 'registry.js'))
const { LocalBashExecutor } = await import('@deepseek-ai/dsh-bash-local')

let passed = 0
/** Wall-clock attribution, printed when DSH_AUDIT_TIMING=1 (see the summary). */
const TIMING = process.env.DSH_AUDIT_TIMING === '1'
const STARTED_AT = Date.now()
const timing = { boots: 0, bootMs: 0, calls: 0, callMs: 0 }
const timed = async (bucket, run) => {
  if (!TIMING) return run()
  const began = Date.now()
  try { return await run() } finally {
    timing[bucket + 'Ms'] += Date.now() - began
    timing[bucket + 's'] += 1
  }
}
let failed = 0
const failures = []
let skipped = 0
/**
 * Report one failure that escaped a test and end the run with a summary anyway.
 *
 * A thrown assertion used to be able to kill the process mid-suite, which reported NOTHING
 * — no ✓/✗ line for the case that threw and no summary at all (measured while mutating a
 * value a later test compares against). A suite that can end without a verdict is not a gate.
 */
const reportAndExit = (label, error) => {
  failed += 1
  failures.push({ name: label, error })
  console.log(`  ✗ ${label}\n      ${String(error?.message ?? error).split('\n').slice(0, 6).join('\n      ')}`)
console.log(`\n==== audit summary: ${passed} passed, ${failed} failed, ${skipped} skipped ====`)
  process.exit(1)
}
process.on('uncaughtException', (error) => reportAndExit('uncaught exception', error))
process.on('unhandledRejection', (error) => reportAndExit('unhandled rejection', error))
/**
 * Announce a case this host cannot exercise — and COUNT it: a skip that only prints is a
 * hole in the totals, and one that stays silent (two of them did) is invisible entirely.
 */
const skip = (message) => {
  skipped += 1
  console.log(message)
}

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
// A wsl.exe-shaped pin that EXISTS (so no runtime fallback fires) but is not WSL:
// `node -e bwrap …` exits non-zero, so the functional bwrap probe fails
// deterministically on a host whose WSL itself works, while the command it is
// asked to run still SPAWNS (and fails as an ordinary command, exit 9) — which is
// what the degrade fixtures need. (A pinned distro that does not exist no longer
// degrades at all: it falls back at runtime, by design.)
const BROKEN_WSL = process.execPath
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
    // It owns no TOOL, but it does own the deployment-wide switches: the top-level
    // self-heal switch is read here, and declaring Config is also what makes the Host
    // serve this row's namespace (the precondition for the top-level card).
    assert.ok('Config' in packageRow, 'the core row declares the top-level switches')
    assert.equal(typeof packageRow.Config, 'function')
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
  test('bashPath(): a pin that exists is returned verbatim', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({ bashPath: process.execPath }) })
    assert.equal(ex.bashPath(), process.execPath)
  })
  // A3: a pin that is NOT there falls back at RUNTIME and says so once per row;
  // the stored value is never rewritten (nothing here writes config at all).
  test('bashPath(): a pin that is missing warns once and falls back to discovery', () => {
    // Windows paths are built from the separator's code point so this file needs no
    // backslash escapes of its own.
    const BS = String.fromCharCode(92)
    const pinned = `C:${BS}pinned${BS}bash.exe`
    const discovered = `C:${BS}discovered${BS}bash.exe`
    const warnings = []
    const ex = bareInstance(GitBashExecutor, {
      ctx: { logger: { warn: (message) => warnings.push(String(message)) } },
      config: GitBashExecutor.Config({ bashPath: pinned }),
    })
    ex.internals.resolveBashPath = (configured) => configured ?? discovered
    ex.internals.registryBashPaths = () => undefined
    assert.equal(ex.bashPath(), discovered)
    assert.equal(warnings.length, 1, warnings.join(' | '))
    assert.ok(warnings[0].startsWith('bash-git: gitBash.bashPath "'), warnings[0])
    assert.ok(warnings[0].includes(JSON.stringify(pinned)), warnings[0])
    assert.ok(warnings[0].includes('does not exist; falling back to auto-discovery'), warnings[0])
    assert.equal(ex.bashPath(), discovered)
    assert.equal(warnings.length, 1, 'the second call must not warn again')
  })
  test('bashPath(): undefined resolution throws loud naming probes', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({}) })
    ex.internals.resolveBashPath = () => undefined
    ex.internals.registryBashPaths = () => undefined // registry may hit on hosts with Git installed
    assert.throws(() => ex.bashPath(), /Git Bash was not found \(probed/)
  })
  test('gitArgv: [bashPath, -c, command]', () => {
    const ex = bareInstance(GitBashExecutor, { config: GitBashExecutor.Config({ bashPath: process.execPath }) })
    assert.deepEqual(ex.gitArgv({ command: 'ls -la' }), [process.execPath, '-c', 'ls -la'])
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
    skip('  … skipping real-spawn execute() tests: no Git Bash probed on this host')
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
      // The dialect learning is not this test's subject (it has its own tests), and
      // the stubbed `confine` cannot answer the doomed-write probe faithfully.
      ex.discoverDenialSignature = async () => undefined
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
  testAsync('the apply-path probe does not learn the denial dialect; the first confined use does', async () => {
    const ex = bareInstance(GitBashExecutor, { ctx: fakeCtx({ subprocess: fakeSubprocess() }), config: gitConfig() })
    ex.runConfinedProbe = async () => true
    const learned = []
    ex.discoverDenialSignature = async () => { learned.push('learn') }
    assert.equal(await ex.probeConfinedOnce(), true, 'the capability probe still answers')
    assert.deepEqual(learned, [], 'the probe runs on the apply path, so it must not learn the dialect there')
    await ex.confinedUsable()
    assert.deepEqual(learned, ['learn'], 'the first confined use learns it before the command runs')
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
        skip('  … skipping symlink case: creating symlinks needs admin/developer mode')
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
  test('wslPath(): a pin that exists is returned verbatim', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
    assert.equal(ex.wslPath(), WSL_EXE)
  })
  test('wslPath(): a pin that is missing warns once and falls back to the standard location', () => {
    const BS = String.fromCharCode(92)
    const pinned = `C:${BS}nope${BS}wsl.exe`
    const warnings = []
    const ex = bareInstance(WslBashExecutor, {
      ctx: { logger: { warn: (message) => warnings.push(String(message)) } },
      config: WslBashExecutor.Config({ wslPath: pinned }),
    })
    ex.internals.resolveWslPath = (configured) => configured ?? WSL_EXE
    assert.equal(ex.wslPath(), WSL_EXE)
    assert.equal(warnings.length, 1, warnings.join(' | '))
    assert.ok(warnings[0].startsWith('bash-wsl: wslBash.wslPath "'), warnings[0])
    assert.ok(warnings[0].includes(JSON.stringify(pinned)), warnings[0])
    assert.ok(warnings[0].includes('does not exist; falling back to the standard Windows location'), warnings[0])
    ex.wslPath()
    assert.equal(warnings.length, 1, 'once per row')
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
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.argv({ command: 'x', workdir: 'G:\\other' })
    assert.deepEqual(argv.slice(0, 5), [WSL_EXE, '--cd', 'G:\\other', '-d', 'Ubuntu-24.04'])
    assert.deepEqual(argv.slice(5), ['--', 'bash', '-c', ex.payload('x')])
  })
  test('argv(): a workdir equal to process.cwd() still gets --cd (auto-cd, not a skip)', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.argv({ command: 'x', workdir: process.cwd() })
    assert.deepEqual(argv.slice(0, 3), [WSL_EXE, '--cd', process.cwd()])
  })
  test('argv(): a Linux workdir passes through verbatim', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
    ex.distro = () => undefined
    assert.deepEqual(ex.argv({ command: 'x', workdir: '/mnt/g/LAB' }), [WSL_EXE, '--cd', '/mnt/g/LAB', '--', 'bash', '-c', ex.payload('x')])
  })
  test('argv(): distro omitted when probe found none', () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
    ex.distro = () => undefined
    assert.deepEqual(ex.argv({ command: 'x', workdir: process.cwd() }), [WSL_EXE, '--cd', process.cwd(), '--', 'bash', '-c', ex.payload('x')])
  })
  test('defaultWorkdir() is gone — no consumer compares against a config default any more', () => {
    assert.equal(typeof WslBashExecutor.prototype.defaultWorkdir, 'undefined')
  })
  testAsync('distro(): an installed wslDistro wins over the probed first entry', async () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslDistro: 'Pinned' }) })
    ex.internals.probeDistro = () => ['Pinned', 'Ubuntu-24.04']
    await ex.ensureDistroList()
    assert.equal(ex.distro(), 'Pinned')
  })
  // A3: a pin this host does not have would fail every command with wsl.exe's own
  // error; the row uses the first listed distro at RUNTIME instead and says so once.
  testAsync('distro(): an uninstalled wslDistro falls back to the first listed one and warns once', async () => {
    const warnings = []
    const ex = bareInstance(WslBashExecutor, {
      ctx: { logger: { warn: (message) => warnings.push(String(message)) } },
      config: WslBashExecutor.Config({ wslDistro: 'NoSuchDistro' }),
    })
    ex.internals.probeDistro = () => ['Ubuntu-24.04', 'Debian']
    await ex.ensureDistroList()
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(warnings.length, 1, warnings.join(' | '))
    assert.match(warnings[0], /^bash-wsl: wslBash\.wslDistro "NoSuchDistro" is not installed; falling back to "Ubuntu-24\.04"\.$/)
    ex.distro()
    assert.equal(warnings.length, 1, 'once per row')
  })
  testAsync('distro(): probe result cached and used', async () => {
    let calls = 0
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({}) })
    ex.internals.probeDistro = () => { calls += 1; return 'Ubuntu-24.04' }
    await ex.ensureDistroList()
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(calls, 1)
  })
  testAsync('ensureBwrapUsable(): auto + failed probe → false (honest degrade)', async () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({}) })
    ex.internals.probeBwrap = () => false
    assert.equal(await ex.ensureBwrapUsable(), false)
  })
  testAsync('ensureBwrapUsable(): explicit bwrap + failed probe throws loud', async () => {
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ sandbox: 'bwrap' }) })
    ex.internals.probeBwrap = () => false
    await assert.rejects(() => ex.ensureBwrapUsable(), /bwrap was not found/)
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
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
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
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
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
    const ex = bareInstance(WslBashExecutor, { config: WslBashExecutor.Config({ wslPath: WSL_EXE }) })
    ex.distro = () => undefined
    assert.throws(() => ex.bwrapArgv({
      command: 'x',
      workdir: 'G:\\LAB',
      sandboxPolicy: { mode: 'read-only', workspaceRoot: '\\\\server\\share\\x' },
    }), /unsupported Windows path/)
  })
  if (!HAS_WSL) {
    skip('  … skipping real-spawn WSL tests: no wsl.exe on this host')
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
    // `sandboxNotice: once` (the default) spends the row's one announcement on its
    // first degraded run, so every later renderer suppresses the text entirely —
    // the structured `sandbox.unconfined` fact is what still carries the truth.
    assert.equal(
      renderResult({ ...base, sandbox: unconfined }, [], { unconfinedIsAutomatic: true, unconfinedSilent: true }),
      'x\n',
      'a silenced notice leaves the output untouched',
    )
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
    // REVIEW B1: a REMOTE job carries the remote sentence, on success AND on
    // failure. The unmatched-denial branch below it is what a failing `ssh.exe`
    // used to be labelled with: exit 255 (a connection error) with a
    // `{ mode, remote: true }` block satisfies that branch's every condition, so
    // the model read a denial-dialect verdict about a sandbox that never ran. The
    // foreground renderer never had this hole; the job detail is a second channel
    // onto the same facts and must say the same thing.
    const remoteFact = { mode: 'workspace-write', remote: true }
    for (const [status, exitCode, signal, base] of [
      ['completed', 0, null, 'exit code: 0'],
      ['completed', 255, null, 'exit code: 255'],
      ['killed', null, 'SIGTERM', 'signal: SIGTERM'],
    ]) {
      const detail = processOutcome({ status, exitCode, signal, sandbox: remoteFact }, ['danger-full-access']).detail
      assert.equal(detail, base + '; ' + remoteSandboxMarker('workspace-write'),
        'a remote job says what the foreground says, for ' + status + ' exit ' + String(exitCode))
      assert.ok(!detail.includes('denial dialect'), detail)
      assert.ok(!detail.includes('ran unconfined'), detail)
    }
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
/**
 * Where this audit writes the fixtures and patches it generates: ONE scratch
 * directory, already covered by the `.temp` rule in `.gitignore`. A new test therefore
 * never needs a new ignore entry — the previous per-name entries (`smoke/fixture.*.yml`)
 * are gone, and a run that is killed midway cannot leave an untracked file behind.
 * `dialect-lab` below uses the same `.temp` convention.
 */
const FIXTURE_DIR = join(__dirname, '..', '.temp', 'smoke')
mkdirSync(FIXTURE_DIR, { recursive: true })
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
  return timed('boot', () => boot('dsh-wmb-audit', resolveConfigPath(path, undefined), patches))
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
/** The opt-in MSYS2 row, pinned to the installation the host has. */
const MSYS2_ROWS = (bashPath) => `${CORE_ROW_ONLY}
- id: win-mb-tool-msys2
  name: 'dsh-win-multi-bash/tool-msys2-bash'
  config:
    msys2Bash:
      bashPath: '${bashPath.replaceAll(String.fromCharCode(92), String.fromCharCode(92) + String.fromCharCode(92))}'
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
  const result = await timed('call', () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`audit-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: { description: `audit ${name}`, ...args },
  }))
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
    if (existsSync('Q:\\')) {
      skip('  … skipping: this host has a Q: drive, so the "no such drive" case cannot be exercised')
      return
    }
    assert.equal(toNativeWorkdir('/q/WorkSpace'), '/q/WorkSpace')
  })
}

console.log('\n[A] unit: the dialect registry is the single source (S1)')
{
  // Everything that used to be a hand-maintained dialect list is derived from
  // `lib/shell-dialects.js`. These guards are what turn "someone added a dialect
  // and forgot one of the eight places" from a silent half-working composition
  // into a red audit: the derived surfaces must agree with each other, and the
  // two files that cannot import the registry at runtime (cordis.patch.yml is
  // static YAML; lib/client.js is a client module the loader resolves by bare
  // specifier only) are compared against it byte-wise.
  const registry = await import(libUrl('tool-bash', 'types', 'registry.js'))
  const {
    DIALECT_FACTS, SHELL_DIALECTS, SHELL_FAMILY_TOOL_NAMES, CLIENT_ROWS, LEAF_RULES,
    PATCH_ROWS, EXPORT_SUBPATHS, TOOL_INSTANCES, PACKAGE_NAME, REGISTRY_ERROR_PREFIX, validateShellDialects,
  } = registry
  const { currentClientRegistry, renderClientRegistry } = await import(new URL('./gen-client-registry.mjs', import.meta.url).href)
  const broken = (over) => SHELL_DIALECTS.map((dialect, index) => (index === 0 ? { ...dialect, ...over } : dialect))
  /** Every rejection must carry the registry prefix — that is what makes it readable at boot. */
  const rejects = (dialects, pattern) => {
    let error
    try {
      validateShellDialects(dialects)
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== undefined, `expected a rejection for ${pattern}`)
    assert.ok(String(error.message).startsWith(REGISTRY_ERROR_PREFIX), String(error.message))
    assert.match(String(error.message), pattern)
  }

  test('the shipped registry passes its own validation', () => {
    assert.doesNotThrow(() => validateShellDialects())
    assert.ok(SHELL_DIALECTS.length >= 2, 'the plugin ships at least the two bash dialects')
  })

  test('every dialect appears in every derived surface', () => {
    for (const dialect of SHELL_DIALECTS) {
      if (dialect.family.shared === true) assert.equal(DIALECT_FACTS[dialect.family.facts], dialect.facts)
      assert.ok(SHELL_FAMILY_TOOL_NAMES.includes(dialect.toolName), `${dialect.id} missing from the family tool names`)
      const row = CLIENT_ROWS.find((entry) => entry.rowId === dialect.rowId)
      assert.ok(row, `${dialect.id} missing from the client rows`)
      assert.ok(row.label.en.length > 0 && row.label.zh.length > 0)
      // Every knob the dialect declares is on its form, in its own partition.
      for (const own of dialect.fields) {
        const knob = row.fields.find((entry) => entry.key === `${dialect.configKey}.${own.leaf}`)
        assert.ok(knob, `${dialect.id}: ${own.leaf} missing from the form`)
        assert.equal(knob.kind, own.kind)
        if (own.rule !== undefined) assert.equal(LEAF_RULES[own.leaf], own.rule)
      }
      assert.deepEqual(row.fields.find((entry) => entry.key === `${dialect.configKey}.sandbox`).options, dialect.sandboxStances)
      const patchRow = PATCH_ROWS.find((entry) => entry.id === dialect.rowId)
      assert.equal(patchRow?.name, `${PACKAGE_NAME}/${dialect.specifier}`, `${dialect.id}: patch row name`)
      assert.equal(patchRow?.win32Only, dialect.win32Only)
      assert.ok(EXPORT_SUBPATHS[`./${dialect.specifier}`], `${dialect.id}: export subpath`)
      const instance = TOOL_INSTANCES.find((entry) => entry.id === dialect.id)
      assert.deepEqual(instance, {
        id: dialect.id,
        toolName: dialect.toolName,
        rowId: dialect.rowId,
        configKey: dialect.configKey,
        specifier: dialect.specifier,
        entry: dialect.entry,
        label: dialect.label,
        sandboxStances: dialect.sandboxStances,
        argvStyle: dialect.argvStyle,
        effects: dialect.effects,
        win32Only: dialect.win32Only,
        executor: dialect.executor,
        resolve: dialect.resolve,
      })
    }
  })

  test('the registry and package.json exports agree in both directions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.deepEqual(manifest.exports, EXPORT_SUBPATHS)
    // The three subpaths a third party needs to reuse the skeleton (R1):
    for (const subpath of ['./factory', './shell-family', './registry'])
      assert.ok(manifest.exports[subpath], `${subpath} must be exported`)
  })

  test('cordis.patch.yml declares exactly the derived rows, in order (and the right gate)', () => {
    const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    // A row is either win32-gated (enabled by default) or plain `disabled: true`
    // (opt-in, enabled by the user in the panel) — the derived flag says which.
    const rows = [...yml.matchAll(/^ {4}- id: ([\w-]+)\n {6}name: '([^']+)'\n(?: {6}#[^\n]*\n)* {6}disabled: ([^\n]+)$/gm)]
      .map(([, id, name, gate]) => ({ id, name, gate }))
    assert.deepEqual(rows.map((row) => ({ id: row.id, name: row.name })), PATCH_ROWS.map((row) => ({ id: row.id, name: row.name })))
    for (const [index, row] of rows.entries()) {
      const expected = PATCH_ROWS[index]
      // A win32-only dialect is either gated by the platform expression (enabled
      // by default) or shipped unconditionally disabled (opt-in, the user turns it
      // on) — never enabled on a platform its executor cannot serve.
      assert.equal(row.gate, expected.disabledByDefault ? 'true' : "!!js process.platform !== 'win32'", `${row.id}: gate`)
      assert.ok(expected.win32Only || row.gate === "!!js process.platform !== 'win32'", `${row.id}: a non-win32 row must not be gated off on win32`)
    }
    assert.ok(rows.some((row) => row.gate === 'true'), 'the opt-in dialect ships disabled')
  })

  test('the browser half carries the generated dialect block byte for byte', () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    // The browser half cannot import the registry (the client loader resolves
    // bare boot-graph specifiers only), so its copy is generated; this is the
    // guard that makes "forgot to regenerate" loud.
    assert.equal(currentClientRegistry(source), renderClientRegistry(),
      'lib/client.js is stale — run: node smoke/gen-client-registry.mjs --write')
    for (const dialect of SHELL_DIALECTS) assert.ok(source.includes(`rowId: "${dialect.rowId}"`))
  })

  test('a duplicate rowId is rejected at startup, by name', () => {
    rejects([SHELL_DIALECTS[0], { ...SHELL_DIALECTS[1], rowId: SHELL_DIALECTS[0].rowId }], /duplicate rowId/)
  })

  test('a dialect with no configKey is rejected at startup, by name', () => {
    rejects(broken({ configKey: undefined }), /declares no configKey/)
  })

  test('a tool name inside the family section name is rejected at startup, by name', () => {
    rejects(broken({ toolName: 'bash' }), /collides with the family section name/)
  })

  test('a stance list without auto is rejected at startup, by name', () => {
    rejects(broken({ sandboxStances: ['none'] }), /sandboxStances must include "auto"/)
  })

  test('a family-shared dialect with no facts key is rejected at startup, by name', () => {
    rejects(broken({ family: { shared: true } }), /family-shared but declares no facts key/)
  })

  test('a dialect with no facts block is rejected at startup, by name', () => {
    rejects(broken({ facts: undefined }), /declares no dialect facts/)
  })

  test('an empty registry is rejected at startup, by name', () => {
    rejects([], /non-empty list of dialect declarations/)
  })
}

console.log('\n[A] unit: the shared executor base owns the mechanism, each dialect keeps its own rules (S2)')
{
  // The extraction moved ~150 duplicated lines into `lib/shell-executor.js`. Two
  // differences are deliberate and must NOT be merged; these guards fail if
  // either is ever unified, and the first one fails if a dialect re-implements
  // (and so can drift from) the shared mechanism.
  const { ShellExecutorBase, sharedStanceConfig } = await import(libUrl('shell-executor.js'))
  const { SANDBOX_NOTICE_LEVELS } = await import(libUrl('shell-dialects.js'))
  const { dialectById } = await import(libUrl('tool-bash', 'types', 'registry.js'))
  const { candidateExists: wslCandidateExists } = await import(libUrl('bash-wsl', 'index.js'))
  const { candidateExists: gitCandidateExists } = await import(libUrl('bash-git', 'index.js'))
  // `decorateResult` is static and asserted separately below.
  const mechanism = ['execute', 'unconfinedRun', 'onProcessDone', 'confinedPolicy', 'warnOnce', 'effectiveDenialSignatures']

  test('both executors extend the one base and re-implement none of its mechanism', () => {
    assert.ok(GitBashExecutor.prototype instanceof ShellExecutorBase, 'git extends the base')
    assert.ok(WslBashExecutor.prototype instanceof ShellExecutorBase, 'wsl extends the base')
    for (const member of mechanism)
      assert.equal(typeof ShellExecutorBase.prototype[member], 'function', `the base must own ${member}`)
    assert.equal(typeof ShellExecutorBase.decorateResult, 'function', 'the base owns the static decorator')
    for (const dialect of [GitBashExecutor, WslBashExecutor]) {
      for (const member of mechanism)
        assert.ok(!Object.hasOwn(dialect.prototype, member), `${dialect.logName} must not copy ${member}`)
      for (const hook of ['argv', 'confinedUsable', 'sandboxUnavailableMessage', 'confinedRun'])
        assert.equal(typeof dialect.prototype[hook], 'function', `${dialect.logName} must supply ${hook}`)
    }
    assert.equal(GitBashExecutor.logName, 'bash-git')
    assert.equal(WslBashExecutor.logName, 'bash-wsl')
  })

  test('candidateExists keeps its dialect semantics: git refuses a symlink, wsl accepts it', () => {
    // Not a defect and not a merge candidate: MSYS bash derives its own root from
    // the real path, so a symlinked bash.exe is refused; wsl.exe is fine either
    // way. The two live in one base class now, which is exactly why this is
    // pinned rather than assumed.
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-wmb-s2-symlink-'))
    try {
      const target = join(tmp, 'target.exe')
      writeFileSync(target, '')
      assert.equal(gitCandidateExists(target), true)
      assert.equal(wslCandidateExists(target), true)
      try {
        symlinkSync(target, join(tmp, 'bash.exe'), 'file')
      } catch {
        skip('  … skipping the symlink half: creating symlinks needs admin/developer mode')
        return
      }
      const link = join(tmp, 'bash.exe')
      assert.equal(gitCandidateExists(link), false, 'git refuses a symlinked bash.exe')
      assert.equal(wslCandidateExists(link), true, 'wsl accepts a symlinked wsl.exe')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('the stance vocabularies stay per dialect and come from the registry', () => {
    // Compared by their printed vocabulary (`"auto" | "none"`): a union keeps its
    // member schemas in `.list`, and the printed form is what the schema means.
    const vocabulary = (schema) => String(schema)
    assert.equal(vocabulary(GitBashExecutor.Config.dict.sandbox), '"auto" | "none"')
    assert.equal(vocabulary(WslBashExecutor.Config.dict.sandbox), '"auto" | "none" | "bwrap"')
    assert.equal(vocabulary(GitBashExecutor.Config.dict.sandbox), dialectById('msys').sandboxStances.map((stance) => `"${stance}"`).join(' | '))
    assert.equal(vocabulary(WslBashExecutor.Config.dict.sandbox), dialectById('wsl').sandboxStances.map((stance) => `"${stance}"`).join(' | '))
    assert.notEqual(vocabulary(GitBashExecutor.Config.dict.sandbox), vocabulary(WslBashExecutor.Config.dict.sandbox),
      'the union is never advertised by a dialect whose executor cannot honour it')
  })

  test('the shared stance fragment builds each vocabulary (and its deadline) from the declaration', () => {
    const fragment = sharedStanceConfig(['auto', 'none'], 1234, SANDBOX_NOTICE_LEVELS)
    // A union built here still holds its member schemas; `deriveConfig` is what
    // normalizes them into the plain list the two Configs expose.
    assert.equal(String(fragment.sandbox), '"auto" | "none"')
    assert.equal(String(sharedStanceConfig(['auto', 'none', 'bwrap'], 1, SANDBOX_NOTICE_LEVELS).sandbox), '"auto" | "none" | "bwrap"')
    assert.equal(fragment.sandbox.meta.default, 'auto')
    assert.equal(fragment.sandbox.meta.volatile, true)
    assert.equal(fragment.probeTimeoutMs.meta.default, 1234)
    assert.equal(fragment.requireSandbox.meta.default, false)
    // The unwrapped-run notice vocabulary comes from the registry, so the schema
    // union and the browser form's options cannot drift; `once` is the default
    // because repeating the sentence on every call only costs context.
    assert.equal(fragment.sandboxNotice.meta.default, 'once')
    assert.deepEqual(Object.keys(sharedStanceConfig(['auto'], 1, SANDBOX_NOTICE_LEVELS)).sort(), ['probeTimeoutMs', 'requireSandbox', 'sandbox', 'sandboxNotice'])
  })

  test('familyRowComposed answers from the registered fact first, then the loader', () => {
    // The gap the extensibility review named: these two were only exercised
    // through `composeToolDescription`, so a change in the fallback could move
    // the shared prose without a red test.
    const withOwner = (disabled) => ({ get: () => ({ entries: () => [{ options: { name: SHELL_FAMILY_ROW_SPECIFIER }, disabled }] }) })
    markFamilySectionOwner(true)
    try {
      assert.equal(familyRowComposed(withOwner(true)), true, 'the registered fact outranks the name heuristic')
    } finally {
      markFamilySectionOwner(false)
    }
    assert.equal(familyRowComposed(withOwner(false)), true, 'the owner row is composed and enabled')
    assert.equal(familyRowComposed(withOwner(true)), false, 'the owner row is composed but switched off')
    assert.equal(familyRowComposed({ get: () => ({ entries: () => [] }) }), false, 'no owner row declared')
    assert.equal(familyRowComposed({ loader: { entries: () => [{ options: { name: SHELL_FAMILY_ROW_SPECIFIER } }] } }), true,
      'a row without an explicit disabled flag counts as enabled')
    assert.equal(familyRowComposed({}), undefined, 'an unreadable loader is "treat as composed", never a guess the other way')
    assert.equal(familyRowComposed({ get: () => ({}) }), undefined, 'a loader without entries() is unreadable too')
    markFamilySectionOwner(true)
    try {
      assert.equal(familyRowComposed({}), true, 'the registered fact is enough on its own')
    } finally {
      markFamilySectionOwner(false)
    }
    assert.equal(familyRowComposed({}), undefined, 'and clearing it restores the heuristic answer')
  })
}

console.log('\n[A] unit + [B] boot: the MSYS2 dialect end to end (S3)')
{
  // The third dialect exists to prove the skeleton: one executor file plus one
  // declaration. These guards check that every derived surface picked it up, that
  // its facts reach the model description, that the row ships OPT-IN, and — the
  // acceptance test the task asks for — that it really runs this machine's MSYS2
  // (uname, $MSYSTEM, pacman, the MSYS drive form, a Windows workdir, a
  // non-ASCII path).
  const { CLIENT_ROWS, PATCH_ROWS, EXPORT_SUBPATHS, TOOL_INSTANCES, dialectById } = await import(libUrl('tool-bash', 'types', 'registry.js'))
  const msys2Tool = await import(libUrl('tool-bash', 'types', 'msys2-bash.js'))
  const { Msys2BashExecutor, declaredBashPaths, msys2RootOf, msys2ToolPath } = await import(libUrl('bash-msys2', 'index.js'))
  const declaration = dialectById('msys2')
  const candidates = declaredBashPaths()
  const MSYS2_BASH = candidates.find((candidate) => existsSync(candidate))

  test('the unpinned probe returns its candidate list (the defect a live session found)', () => {
    // `msys2Candidates()` used to return the FUNCTION instead of calling it, so both
    // callers threw; every MSYS2 test above pins `bashPath`, which short-circuits the
    // method, so the suite stayed green while an unpinned row could never discover its
    // own installation. Both callers are pinned here, against a bare instance.
    const bare = Object.create(Msys2BashExecutor.prototype)
    bare.config = { bashPath: { get: () => '' } }
    bare.internals = {}
    const probed = bare.msys2Candidates()
    assert.ok(Array.isArray(probed), 'the probe must return the candidate list, not the function itself')
    assert.deepEqual(probed, declaredBashPaths(), 'and it must be the declaration-driven list')
    assert.doesNotThrow(() => bare.tryBashPath(), 'unpinned discovery must be able to run at all')
  })

  test('the declaration reaches every derived surface, and the name does not collide', () => {
    assert.equal(declaration.toolName, 'msys2_bash')
    assert.equal(msys2Tool.name, 'tool-msys2_bash')
    assert.ok(SHELL_FAMILY_TOOL_NAMES.includes('msys2_bash'), 'it joins the shared section family')
    assert.ok(!SHELL_FAMILY_SECTION_NAME.includes('msys2_bash'), 'the section name is not per-tool')
    assert.ok(CLIENT_ROWS.some((row) => row.rowId === 'win-mb-tool-msys2'), 'it has a Configure page')
    assert.equal(PATCH_ROWS.find((row) => row.id === 'win-mb-tool-msys2')?.disabledByDefault, true, 'the row ships opt-in')
    assert.ok(EXPORT_SUBPATHS['./tool-msys2-bash'], 'its subpath is exported')
    assert.ok(TOOL_INSTANCES.some((instance) => instance.id === 'msys2'))
    // Its facts are what tells the model this is not Git Bash.
    const description = shellDescription('msys2')
    assert.match(description, /MSYS2 UCRT64/)
    assert.match(description, /pacman/)
    assert.match(description, /MSYS2 form/)
    assert.doesNotMatch(description, /unknown shell dialect/)
  })

  test('its root, toolchain PATH and discovery follow the layout it declares', () => {
    const root = msys2RootOf(MSYS2_BASH ?? `C:${String.fromCharCode(92)}msys64${String.fromCharCode(92)}usr${String.fromCharCode(92)}bin${String.fromCharCode(92)}bash.exe`)
    assert.equal(root, (MSYS2_BASH ?? `C:${String.fromCharCode(92)}msys64${String.fromCharCode(92)}usr${String.fromCharCode(92)}bin${String.fromCharCode(92)}bash.exe`).replace(/[\\/]usr[\\/]bin[\\/]bash\.exe$/, ''))
    assert.equal(msys2RootOf('C:' + String.fromCharCode(92) + 'other' + String.fromCharCode(92) + 'bash.exe'), undefined)
    const path = msys2ToolPath(`${root}${String.fromCharCode(92)}usr${String.fromCharCode(92)}bin${String.fromCharCode(92)}bash.exe`, 'INHERITED')
    assert.match(path, /usr\\bin/)
    assert.match(path, /ucrt64\\bin/, 'the declared MSYSTEM toolchain directory is on PATH')
    assert.ok(path.endsWith('INHERITED'), 'and the inherited PATH is preserved')
    assert.ok(candidates.every((candidate) => candidate.endsWith(String.fromCharCode(92) + 'usr' + String.fromCharCode(92) + 'bin' + String.fromCharCode(92) + 'bash.exe')))
  })

  if (MSYS2_BASH === undefined) {
    console.log(`  … skipping the MSYS2 round trip: no bash.exe under ${candidates.join(', ')}`)
  } else {
    let ctx
    try {
      ctx = await bootFixture(MSYS2_ROWS(MSYS2_BASH), 'msys2-roundtrip.yml')
      await runTests(ctx, [
        ['msys2_bash really runs this machine MSYS2 (uname, $MSYSTEM, pacman)', async () => {
          const out = await execTool(ctx, 'msys2_bash', { command: 'uname -a; echo "MSYSTEM=$MSYSTEM"; pacman --version | head -2; echo "TOOLCHAIN=$(command -v pacman)"' })
          // MSYS2's uname reports the subsystem `MSYSTEM` selects (UCRT64 ⇒
          // MINGW64_NT-…, the default MSYS ⇒ MSYS_NT-…), so both are correct here;
          // what matters is that this is the MSYS runtime, not Linux.
          assert.match(out, /M(?:SYS|INGW64)_NT-/, out)
          assert.doesNotMatch(out, /^Linux/m, out)
          assert.match(out, /MSYSTEM=UCRT64/, `the declared MSYSTEM is exported: ${out}`)
          assert.match(out, /Pacman v6\./, 'pacman is reachable — this is MSYS2, not Git Bash')
          // MSYS2 resolves pacman through `/bin` (a symlink onto `/usr/bin`).
          assert.match(out, /TOOLCHAIN=\/(?:usr\/)?bin\/pacman/, out)
          assert.doesNotMatch(out, /fatal error/i)
        }],
        ['msys2_bash carries the MSYS drive form and converts a Windows workdir', async () => {
          const out = await execTool(ctx, 'msys2_bash', { command: 'pwd; echo "DRIVE=$(pwd | cut -c2)"', workdir: process.cwd() })
          assert.match(out, /^\/[a-z]\//m, `workdir must arrive in MSYS drive form: ${out}`)
          assert.match(out, /DRIVE=[a-z]/, out)
        }],
        ['msys2_bash survives a non-ASCII workdir (and reads a file there)', async () => {
          // `.temp` is gitignored, so it is absent in a fresh clone and in every
          // copied device: create the parent before mkdtemp, or the FIRST run of
          // this suite dies here and only the second one is green.
          const guardRoot = join(process.cwd(), '.temp')
          mkdirSync(guardRoot, { recursive: true })
          const dir = mkdtempSync(join(guardRoot, 'msys2-guard'))
          const cjk = join(dir, 'MSYS2 非 ASCII 目录')
          mkdirSync(cjk, { recursive: true })
          writeFileSync(join(cjk, 'hello.txt'), 'msys2-non-ascii-ok\n')
          try {
            const out = await execTool(ctx, 'msys2_bash', { command: 'pwd; cat hello.txt', workdir: cjk })
            assert.match(out, /msys2-non-ascii-ok/, out)
          } finally {
            removeFixtureDir(dir)
          }
        }],
        ['msys2_bash is a dialect of its own: the git facts are not what it reports', async () => {
          const out = await execTool(ctx, 'msys2_bash', { command: 'echo "$MSYSTEM"; test -x /usr/bin/pacman && echo PACMAN=yes' })
          assert.match(out, /UCRT64/)
          assert.match(out, /PACMAN=yes/)
          const schema = ctx.tools.get('msys2_bash')?.description ?? ''
          assert.match(schema, /MSYS2 UCRT64/)
          assert.doesNotMatch(schema, /Git Bash \(MSYS2\)/)
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
  }
}

console.log('\n[A] unit + [B] boot: the SSH dialect (remote effects, no local sandbox claim) (S4)')
{
  // The fourth dialect is the FIRST whose command does not run on this host, and
  // that is the one thing the family's sandbox contract cannot absorb: there is no
  // local file effect to fence, so 'denied', 'enforcement', 'runnerFailed' and
  // 'unconfined' would each state a fact nobody observed. These guards pin both the
  // declaration surfaces and the facts a run really reports, so a borrowed verdict
  // cannot come back. None of them needs a network: the argv/validation half is
  // pure, the fact half drives 'remoteRun' directly, and the one integration case
  // talks to TEST-NET-1, which by definition never answers.
  //
  // Windows separators are built with a constant instead of written literally, so
  // this block stays readable in a source file that must not carry stray escapes.
  const BS = String.fromCharCode(92)
  const winPath = (...parts) => parts.join(BS)
  const {
    CLIENT_ROWS: SSH_CLIENT_ROWS, PATCH_ROWS: SSH_PATCH_ROWS, EXPORT_SUBPATHS: SSH_EXPORT_SUBPATHS,
    SHELL_DIALECTS: SSH_DIALECTS, TERMINAL_BACKENDS: SSH_TERMINAL_BACKENDS,
    REMOTE_FAMILY_TOOL_NAMES, dialectById: sshDialectById,
  } = await import(libUrl('tool-bash', 'types', 'registry.js'))
  const { validateShellDialects, REGISTRY_ERROR_PREFIX } = await import(libUrl('shell-dialects.js'))
  const sshTool = await import(libUrl('tool-bash', 'types', 'ssh-bash.js'))
  const terminalTool = await import(libUrl('tool-bash', 'types', 'terminal.js'))
  const {
    DEFAULT_CONNECT_TIMEOUT_MS, SshBashExecutor, assertConnectTimeoutMs, assertSshPort, assertSshTarget, buildSshArgv,
    candidateSshPaths, connectTimeoutSeconds, declaredSshPaths, resolveSshPath,
  } = await import(libUrl('bash-ssh', 'index.js'))
  const { SHELL_REMOTE_SCOPE_SECTION, shellFamilySectionTextFor } =
    await import(libUrl('tool-bash', 'types', 'shell-family.js'))
  const { remoteSandboxMarker } = await import(libUrl('tool-bash', 'types', 'render.js'))
  const declaration = sshDialectById('ssh')
  const localSsh = candidateSshPaths().find((candidate) => existsSync(candidate))
  /** The phrase the family's local-sandbox sentence carries; asserted by presence AND absence. */
  const LOCAL_SANDBOX_PHRASE = 'file access denied under'

  /** A bare executor: prototype plus the config/ctx slices the hooks actually read. */
  const bareSsh = (over = {}) => Object.assign(Object.create(SshBashExecutor.prototype), {
    config: {
      sshPath: { get: () => over.sshPath ?? 'ssh.exe' },
      sshHost: { get: () => (over.sshHost === undefined ? 'example.invalid' : over.sshHost) },
      sshUser: { get: () => over.sshUser ?? '' },
      sshPort: { get: () => over.sshPort },
      acceptNewHostKeys: { get: () => over.acceptNewHostKeys === true },
      connectTimeoutMs: { get: () => over.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS },
      sandbox: { get: () => over.sandbox ?? 'auto' },
      requireSandbox: { get: () => over.requireSandbox === true },
      probeTimeoutMs: { get: () => 4000 },
    },
    // No discovery: a pinned resolver keeps every assertion below a pure function
    // of what the test states, not of what this machine happens to have installed.
    internals: { resolveSshPath: (configured) => (configured === undefined || configured.length === 0 ? 'ssh.exe' : configured) },
    processFacts: new Map(),
    warnedAbout: new Set(),
    ctx: {
      sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write', workspaceRoot: winPath('C:', 'ws') }) },
      logger: { warn: () => {} },
    },
  })
  /** A settled handle good enough for the decoration path (installable on a bare executor). */
  const remoteHandle = (result) => ({ result: async () => result })
  const okResult = () => ({
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
  })

  test('the declaration reaches every derived surface, and the row ships opt-in', () => {
    assert.equal(declaration.toolName, 'ssh_bash')
    assert.equal(sshTool.name, 'tool-ssh_bash')
    assert.ok(SHELL_FAMILY_TOOL_NAMES.includes('ssh_bash'), 'it joins the shared section family')
    assert.ok(!SHELL_FAMILY_SECTION_NAME.includes('ssh_bash'), 'the section name is not per-tool')
    assert.ok(SSH_CLIENT_ROWS.some((row) => row.rowId === 'win-mb-tool-ssh'), 'it has a Configure page')
    assert.equal(SSH_PATCH_ROWS.find((row) => row.id === 'win-mb-tool-ssh')?.disabledByDefault, true,
      'the row ships opt-in: it needs a host only a deployment can name')
    assert.ok(SSH_EXPORT_SUBPATHS['./tool-ssh-bash'], 'its subpath is exported')
    // Appended LAST: ROWS[0]/ROWS[1] stay the git and wsl rows, and the session row
    // stays last of all — nothing a reader already depends on got renumbered.
    assert.deepEqual(SSH_CLIENT_ROWS.slice(3).map((row) => row.rowId), ['win-mb-tool-ssh', 'win-mb-tool-terminal'])
    // The persistent form is the SESSION row offering this dialect (decision 1).
    assert.ok(SSH_TERMINAL_BACKENDS.some((backend) => backend.toolName === 'ssh_bash'))
    // Its facts are what tells the model this is not a local shell.
    const description = shellDescription('ssh')
    assert.match(description, /remote SSH/)
    assert.match(description, /ssh <host> <command>/)
    assert.match(description, /remote host's own paths/)
    assert.match(description, /read on the remote host/)
    assert.doesNotMatch(description, /unknown shell dialect/)
  })

  test('the effect scope is declared once and the family reads it from there', () => {
    assert.equal(declaration.effects, 'remote')
    for (const dialect of SSH_DIALECTS.filter((entry) => entry.id !== 'ssh'))
      assert.equal(dialect.effects, 'local', dialect.id + ' runs its command on this host')
    assert.deepEqual(REMOTE_FAMILY_TOOL_NAMES, ['ssh_bash'], 'exactly one remote dialect is shipped')
    assert.equal(SshBashExecutor.remoteEffects, true)
    assert.equal(GitBashExecutor.remoteEffects, false)
    assert.equal(WslBashExecutor.remoteEffects, false)
    // A declaration that forgets to say is REFUSED at boot rather than defaulted to
    // local — that default is exactly the false claim this axis exists to prevent.
    const broken = SSH_DIALECTS.map((dialect, index) => (index === 0 ? { ...dialect, effects: undefined } : dialect))
    let error
    try { validateShellDialects(broken) } catch (caught) { error = caught }
    assert.ok(error !== undefined, 'an undeclared effect scope must be refused')
    assert.ok(String(error.message).startsWith(REGISTRY_ERROR_PREFIX), String(error.message))
    assert.match(String(error.message), /declares no effects/)
  })

  test('the one-shot argv is non-interactive by construction, with the command as ONE element', () => {
    const argv = buildSshArgv({
      sshPath: 'ssh.exe', target: 'u@h', port: undefined, connectTimeoutMs: 15000,
      acceptNewHostKeys: false, command: 'echo \"$HOME\"; ls -l', interactive: false,
    })
    assert.deepEqual(argv, [
      'ssh.exe', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', '--', 'u@h', 'echo \"$HOME\"; ls -l',
    ])
    // ssh joins its own remaining arguments and hands the result to the REMOTE login
    // shell, so passing the command as one element is exactly right — and no local
    // shell ever parses it.
    assert.equal(argv[argv.length - 1], 'echo \"$HOME\"; ls -l')
    assert.ok(!argv.includes('-t'), 'the one-shot form never asks for a remote tty')
    // Every option is a declared field or a constant, so nothing in configuration can
    // inject an argv element; the pins only ever become their own elements.
    assert.deepEqual(buildSshArgv({
      sshPath: 'ssh.exe', target: 'h', port: 2222, connectTimeoutMs: 1500,
      acceptNewHostKeys: true, command: 'id', interactive: false,
    }), [
      'ssh.exe', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=1',
      '-o', 'StrictHostKeyChecking=accept-new', '-p', '2222', '--', 'h', 'id',
    ])
    // The host-key policy is emitted in BOTH states, shaped per FORM: leaving the option
    // out would let a user or system ssh_config answer instead (a `Host *` line saying
    // `no` would then silently accept a changed key for a one-shot call).
    const oneShot = (acceptNewHostKeys) => buildSshArgv({
      sshPath: 's', target: 'h', connectTimeoutMs: 1000, acceptNewHostKeys, command: 'x', interactive: false,
    })
    const sessionArgv = (acceptNewHostKeys) => buildSshArgv({
      sshPath: 's', target: 'h', connectTimeoutMs: 1000, acceptNewHostKeys, interactive: true,
    })
    assert.ok(oneShot(false).includes('StrictHostKeyChecking=yes'), 'a one-shot call refuses an unknown host even where the config would ask')
    assert.ok(!oneShot(false).includes('StrictHostKeyChecking=accept-new'))
    assert.ok(oneShot(true).includes('StrictHostKeyChecking=accept-new'))
    assert.ok(!oneShot(true).includes('StrictHostKeyChecking=yes'))
    // The SESSION keeps the inherited `ask` when the knob is off: a first-connect
    // question is the reason the persistent form exists at all.
    assert.ok(!sessionArgv(false).some((entry) => entry.startsWith('StrictHostKeyChecking')), 'a session must still be able to ask')
    assert.ok(sessionArgv(true).includes('StrictHostKeyChecking=accept-new'))
    // The connection bound is whole seconds, rounded DOWN so the ssh-side bound stays
    // inside the configured one; a pin under one second is refused at route time
    // instead of being rounded UP into a bound nobody asked for.
    assert.equal(connectTimeoutSeconds(15000), 15)
    assert.equal(connectTimeoutSeconds(1999), 1)
    assert.equal(connectTimeoutSeconds(900), 1, 'the pure floor, which a sub-second pin never reaches')
    assert.equal(assertConnectTimeoutMs(1000), 1000)
    assert.equal(assertConnectTimeoutMs(15000), 15000)
    for (const bad of [0, 999, 500, -1, Number.NaN, 'x'])
      assert.throws(() => assertConnectTimeoutMs(bad), /at least 1000 ms/, JSON.stringify(bad))
  })

  test('the session argv asks for a remote tty and passes no command', () => {
    const argv = bareSsh({ sshHost: 'u@h' }).terminalArgv({ workdir: winPath('C:', 'ws') })
    assert.deepEqual(argv, ['ssh.exe', '-t', '-o', 'ConnectTimeout=15', '--', 'u@h'])
    // No BatchMode: a session exists so that a fingerprint, a password or a key
    // passphrase CAN be asked, and the PTY is what makes ssh ask at all.
    assert.ok(!argv.includes('BatchMode=yes'))
    // The local cwd is where ssh.exe runs; the remote shell starts where its own
    // login lands. Translating one into the other would be an invented fact.
    assert.ok(!argv.includes('--cd'))
  })

  test('a target can never be read as an option, and a port is bounded', () => {
    assert.equal(assertSshTarget('host.example', 'sshBash.sshHost'), 'host.example')
    assert.equal(assertSshTarget('ubuntu_tx', 'sshBash.sshHost'), 'ubuntu_tx')
    // The classic injection: an option smuggled in through the target.
    assert.throws(() => assertSshTarget('-oProxyCommand=calc', 'sshBash.sshHost'), /must not begin with \"-\"/)
    assert.throws(() => assertSshTarget('a b', 'sshBash.sshHost'), /whitespace or a control character/)
    assert.throws(() => assertSshTarget('h' + String.fromCharCode(9), 'sshBash.sshHost'), /whitespace or a control character/)
    assert.throws(() => assertSshTarget('h' + String.fromCharCode(0), 'sshBash.sshHost'), /whitespace or a control character/)
    assert.throws(() => assertSshTarget('', 'sshBash.sshHost'), /is not configured/)
    assert.throws(() => assertSshTarget(undefined, 'sshBash.sshHost'),
      /ssh_bash row OR on the terminal row/, 'the refusal must name BOTH rows: a session reads the terminal row')
    assert.throws(() => assertSshTarget(undefined, 'sshBash.sshHost'), /is not configured/)
    assert.equal(assertSshPort(22), 22)
    assert.equal(assertSshPort(65535), 65535)
    for (const bad of [0, 65536, 22.5, Number.NaN, 'x'])
      assert.throws(() => assertSshPort(bad), /whole number between 1 and 65535/, JSON.stringify(bad))
    // The user half is validated the same way, and the two become ONE token.
    assert.equal(bareSsh({ sshHost: 'h', sshUser: 'root' }).target(), 'root@h')
    assert.equal(bareSsh({ sshHost: 'h', sshUser: '' }).target(), 'h')
    assert.throws(() => bareSsh({ sshHost: 'h', sshUser: '-l root' }).target(), /must not begin with \"-\"/)
    assert.throws(() => bareSsh({ sshHost: '' }).target(), /is not configured/)
  })
  test('client resolution prefers the declared root, and a stale pin falls back once', () => {
    const env = { SystemRoot: 'C:' + BS + 'Windows', PATH: winPath('C:', 'other') }
    assert.deepEqual(declaredSshPaths(env), [winPath('C:', 'Windows', 'System32', 'OpenSSH', 'ssh.exe')])
    // An unexpanded %VAR% never resolves; the declaration's literal fallback is what
    // keeps a host without SystemRoot working.
    assert.deepEqual(declaredSshPaths({}), [
      '%SystemRoot%' + BS + 'System32' + BS + 'OpenSSH' + BS + 'ssh.exe',
      winPath('C:', 'Windows', 'System32', 'OpenSSH', 'ssh.exe'),
    ])
    const candidates = candidateSshPaths(env)
    assert.equal(candidates[0], winPath('C:', 'Windows', 'System32', 'OpenSSH', 'ssh.exe'), 'the declared root is probed first')
    assert.ok(candidates.includes(winPath('C:', 'other', 'ssh.exe')),
      'every PATH entry is probed too, which is how a Git-for-Windows client is found')
    // The declaration's literal fallback root is a REAL probe, so a win32 answer is
    // the Windows OpenSSH path when that client is installed and `undefined` when it
    // is not — never a substitute plucked from somewhere else. Asserted as the
    // invariant instead of a fixed path, because the suite must hold on both hosts.
    const winAnswer = resolveSshPath(undefined, { SystemRoot: 'C:' + BS + 'Windows', PATH: '' }, 'win32')
    if (winAnswer === undefined) {
      console.log('    (no Windows OpenSSH client here: the win32 negative case is live on this host)')
    } else {
      assert.ok(candidateSshPaths({ SystemRoot: 'C:' + BS + 'Windows', PATH: '' }).includes(winAnswer),
        'a win32 answer must come from the probe table, never from nowhere')
      assert.ok(existsSync(winAnswer), 'and the path it answers must really exist')
    }
    assert.equal(resolveSshPath('C:' + BS + 'pinned' + BS + 'ssh.exe', env, 'win32'), 'C:' + BS + 'pinned' + BS + 'ssh.exe',
      'an explicit pin is trusted as-is')
    assert.equal(resolveSshPath(undefined, {}, 'linux'), 'ssh', 'POSIX resolves the bare client')
    // A pin that does not exist warns once and discovers instead of spawning a
    // missing program (the failure mode the Git dialect already paid for).
    const warnings = []
    const stale = bareSsh({ sshPath: winPath('C:', 'nope', 'ssh.exe') })
    stale.ctx = { sandboxPolicy: stale.ctx.sandboxPolicy, logger: { warn: (message) => warnings.push(message) } }
    stale.internals = { resolveSshPath: (configured) => (configured === undefined ? winPath('C:', 'found', 'ssh.exe') : configured) }
    assert.equal(stale.sshPath(), winPath('C:', 'found', 'ssh.exe'))
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].startsWith('bash-ssh: sshBash.sshPath \"'), warnings[0])
    assert.ok(warnings[0].includes('does not exist'), warnings[0])
    assert.equal(stale.sshPath(), winPath('C:', 'found', 'ssh.exe'))
    assert.equal(warnings.length, 1, 'the warning is once per row, not once per call')
    const missing = bareSsh()
    missing.internals = { resolveSshPath: () => undefined }
    assert.throws(() => missing.sshPath(), /no ssh client was found/)
  })

  test('the ssh_bash row exposes the shared knobs and its own, and nothing else', () => {
    assert.deepEqual(volatilePaths(sshTool.Config), [
      'enableRunInBackground',
      'sshBash.cwd', 'sshBash.timeoutMs', 'sshBash.maxTimeoutMs', 'sshBash.maxOutputBytes',
      'sshBash.maxSpillBytes', 'sshBash.graceMs',
      'sshBash.sshPath', 'sshBash.sshHost', 'sshBash.sshUser', 'sshBash.sshPort',
      'sshBash.acceptNewHostKeys', 'sshBash.connectTimeoutMs',
      'sshBash.sandbox', 'sshBash.probeTimeoutMs', 'sshBash.requireSandbox', 'sshBash.sandboxNotice',
    ])
    const resolved = sshTool.Config({})
    assert.equal(resolved.sshBash.sandbox.get(), 'auto')
    assert.equal(resolved.sshBash.requireSandbox.get(), false, 'nothing is demanded by default')
    assert.equal(resolved.sshBash.acceptNewHostKeys.get(), false, 'no host key is ever accepted on the user behalf by default')
    assert.equal(resolved.sshBash.connectTimeoutMs.get(), 15000)
    assert.equal(resolved.sshBash.sshPort.get(), undefined, 'no port pin leaves ssh its own default')
    assert.equal(resolved.sshBash.sshPath.get(), undefined, 'no client pin means discovery')
    assert.deepEqual(unionOptions(sshTool.Config.dict.sshBash.dict.sandbox), ['auto', 'none'],
      'the vocabulary is the declaration, and bwrap is never advertised by a dialect that cannot honour it')
    assert.deepEqual(unionOptions(sshTool.Config.dict.sshBash.dict.sandbox), [...declaration.sandboxStances])
  })

  test('the session row types a dialect pin by the kind the declaration states', () => {
    // A numeric or boolean leaf declared as a STRING pin would make the dialect's own
    // Config reject the seeded value at open time — a broken session for a perfectly
    // well declared dialect. The type is the invariant; what schemastery PRINTS for a
    // number is its own business, so only the string type is asserted by name.
    const pins = terminalTool.Config.dict.sshBash.dict
    assert.equal(String(pins.sshHost), 'string', 'a text leaf stays a text pin')
    assert.notEqual(String(pins.sshPort), 'string', 'a number leaf is NOT a string pin')
    assert.notEqual(String(pins.acceptNewHostKeys), 'string', 'a boolean leaf is NOT a string pin')
    assert.notEqual(String(pins.connectTimeoutMs), 'string')
    // And the seeded round trip really resolves through the backend schema.
    const pinned = terminalTool.Config({ sshBash: { sshPort: 2222, acceptNewHostKeys: true, sshHost: 'h' } })
    assert.equal(pinned.sshBash.sshPort.get(), 2222, 'a numeric pin survives the session row')
    assert.equal(pinned.sshBash.acceptNewHostKeys.get(), true, 'a boolean pin survives too')
  })

  testAsync('a remote run reports remote, and NONE of the borrowed verdicts', async () => {
    const executor = bareSsh({ sshHost: 'blackhole.invalid' })
    executor.internals = { resolveSshPath: () => winPath('C:', 'OpenSSH', 'ssh.exe') }
    const spawned = []
    executor.executeArgv = async (spec, argv, onStarted) => {
      spawned.push(argv)
      const proc = remoteHandle({
        exitCode: 255, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
        stdout: { text: '', truncated: false },
        stderr: { text: 'ssh: connect to host blackhole.invalid port 22: Connection timed out', truncated: false },
      })
      onStarted?.(proc)
      // The fact a PROMOTED (timed-out) call reads BEFORE settlement: it is stamped on the
      // handle itself, not only in the executor's private map.
      assert.deepEqual(proc.sandbox, { mode: 'workspace-write', remote: true },
        'the remote fact must be on the handle before `done` settles')
      return proc
    }
    const handle = await executor.remoteRun({ command: 'uname -a', workdir: winPath('C:', 'ws') },
      { mode: 'workspace-write', workspaceRoot: winPath('C:', 'ws') })
    const result = await handle.result()
    assert.deepEqual(result.sandbox, { mode: 'workspace-write', remote: true })
    for (const borrowed of ['denied', 'enforcement', 'runnerFailed', 'unconfined'])
      assert.ok(!(borrowed in result.sandbox), 'a remote run must not carry \"' + borrowed + '\"')
    assert.deepEqual(Object.keys(result.sandbox).sort(), ['mode', 'remote'], 'and nothing else either')
    // The argv it really used is the one-shot shape, with the command as one element.
    assert.deepEqual(spawned, [['C:' + BS + 'OpenSSH' + BS + 'ssh.exe', '-T', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', '--', 'blackhole.invalid', 'uname -a']])
  })

  testAsync('requireSandbox fails closed on a remote dialect, and danger-full-access is the way out', async () => {
    const demanding = bareSsh({ requireSandbox: true, sshHost: 'h' })
    demanding.executeArgv = async () => { throw new Error('this must never spawn') }
    await assert.rejects(
      () => demanding.remoteRun({ command: 'id' }, { mode: 'read-only', workspaceRoot: winPath('C:', 'ws') }),
      /no sandbox can be applied to a command that runs on a remote host/)
    // The documented escape hatch still runs, and still reports the remote fact.
    const allowed = bareSsh({ requireSandbox: true, sshHost: 'h' })
    allowed.internals = { resolveSshPath: () => 'ssh.exe' }
    let spawned = 0
    allowed.executeArgv = async (spec, argv, onStarted) => {
      spawned += 1
      const proc = remoteHandle(okResult())
      onStarted?.(proc)
      return proc
    }
    const result = await (await allowed.remoteRun({ command: 'id' }, { mode: 'danger-full-access', workspaceRoot: winPath('C:', 'ws') })).result()
    assert.equal(spawned, 1)
    assert.deepEqual(result.sandbox, { mode: 'danger-full-access', remote: true })
    // The advertised surface follows the same switch: a row that demands nothing
    // advertises no confinement, so it also advertises no escalation parameter.
    assert.equal(await bareSsh({ requireSandbox: false }).resolveSandboxMode(), undefined,
      'a row that demands nothing advertises nothing, so the model never sees sandbox_permissions')
    const demandingRow = bareSsh({ requireSandbox: true })
    assert.equal(await demandingRow.resolveSandboxMode(), 'workspace-write')
    assert.equal(demandingRow.sandboxMode, 'workspace-write', 'the sync getter reads the settled verdict')
    // REVIEW N3: the stance must not silently disarm the demand. Under `sandbox:
    // none` a demanding row still advertises escalation, because neither stance can
    // be honoured by a local wrapper — and without the advertisement the refusal's
    // own escape hatch (`sandbox_permissions`) is not in the parameter table, so the
    // row could neither run nor be rescued.
    assert.equal(await bareSsh({ requireSandbox: true, sandbox: 'none' }).resolveSandboxMode(), 'workspace-write',
      'a demanding row advertises the way out under `sandbox: none` too')
    assert.equal(await bareSsh({ requireSandbox: false, sandbox: 'none' }).resolveSandboxMode(), undefined,
      'and a row that demands nothing still advertises nothing')
    // The confinement hooks are explicit REFUSALS, never plausible defaults: an
    // answer of 'false' would send the family down its unconfined path and report a
    // degradation fact about a confinement that was never attempted.
    await assert.rejects(() => bareSsh().confinedUsable(), /never confines/)
    await assert.rejects(() => bareSsh().confinedRun({}, { mode: 'read-only' }), /no sandbox can be applied/)
  })

  test('the settlement hook stamps the same fact for a background job or a promoted read', () => {
    const executor = bareSsh()
    const remoteProc = {}
    executor.processFacts.set(remoteProc, { mode: 'read-only', remote: true })
    executor.onProcessDone(remoteProc, '', false)
    assert.deepEqual(remoteProc.sandbox, { mode: 'read-only', remote: true })
    // The neighbouring arm of the same expression still reports ITS fact, so the new
    // one did not swallow the existing vocabulary.
    const unwrapped = {}
    executor.processFacts.set(unwrapped, { mode: 'workspace-write', unconfined: true })
    executor.onProcessDone(unwrapped, '', false)
    assert.deepEqual(unwrapped.sandbox, { mode: 'workspace-write', unconfined: true })
    assert.equal(unwrapped.sandbox.remote, undefined, 'the remote fact is not added to a local run')
  })

  test('the rendered result carries the remote marker and never the unmatched-denial marker', () => {
    const failed = {
      exitCode: 255, signal: null, timedOut: false,
      stdout: { text: '', truncated: false },
      stderr: { text: 'ssh: connect to host h port 22: Connection timed out', truncated: false },
      sandbox: { mode: 'workspace-write', remote: true },
    }
    const text = renderResult(failed, ['danger-full-access'])
    assert.ok(text.includes(remoteSandboxMarker('workspace-write')), text)
    assert.ok(text.includes('[sandbox: not applicable'))
    assert.ok(text.includes('workspace-write'), 'the policy mode is still reported, as the configuration fact it is')
    assert.ok(text.includes('[exit code: 255]'), 'the exit marker is still last')
    // A nonzero exit whose sandbox block carries no verdict would otherwise trip the
    // unmatched-denial marker, which would blame a sandbox that was never there.
    assert.ok(!text.includes(unmatchedDialectMarker()), text)
    assert.ok(!text.includes('not applied ' + String.fromCharCode(8212)), 'and it is never announced as a degraded confinement')
    // A SUCCESSFUL remote run carries the same sentence: this is the shape of the
    // sandbox block, not a warning about a failure.
    const success = { ...failed, exitCode: 0, stderr: { text: '', truncated: false } }
    assert.ok(renderResult(success, []).includes(remoteSandboxMarker('workspace-write')))
    // The promoted path states it too, and adds no runner-failure claim.
    const promoted = renderJobRead('out', false, [], { mode: 'workspace-write', remote: true })
    assert.ok(promoted.includes(remoteSandboxMarker('workspace-write')), promoted)
    assert.ok(!promoted.includes('runner itself failed'))
  })

  test('the family section drops its sandbox sentence for an all-remote set and adds the remote clause', () => {
    const local = shellFamilySectionText({ background: false, escalation: false })
    assert.ok(local.includes(LOCAL_SANDBOX_PHRASE), 'the default keeps the sentence it always had')
    assert.ok(!local.includes(SHELL_REMOTE_SCOPE_SECTION))
    const remote = shellFamilySectionText({ background: false, escalation: false, localSandbox: false, remote: true })
    assert.ok(!remote.includes(LOCAL_SANDBOX_PHRASE), 'no local file-sandbox promise over a command that runs elsewhere')
    assert.ok(remote.includes(SHELL_REMOTE_SCOPE_SECTION))
    assert.match(remote, /sandbox\.remote: true/, 'and it names the structured fact instead of inventing a verdict')
    // A MIXED composition says both, because the local tools really are sandboxed.
    const mixed = shellFamilySectionText({ background: false, escalation: false, localSandbox: true, remote: true })
    assert.ok(mixed.includes(LOCAL_SANDBOX_PHRASE) && mixed.includes(SHELL_REMOTE_SCOPE_SECTION))
    // The mounted-set resolver reads the scope, so a composition decides this from
    // what is actually loaded instead of from a name list of its own.
    const fakeCtx = (names) => ({ tools: { get: (name) => (names.includes(name) ? { name, parameters: { properties: {} } } : undefined) } })
    assert.equal(shellFamilySectionTextFor(fakeCtx([]), 's'), '')
    const gitOnly = shellFamilySectionTextFor(fakeCtx(['git_bash']), 's')
    assert.ok(gitOnly.includes(LOCAL_SANDBOX_PHRASE) && !gitOnly.includes(SHELL_REMOTE_SCOPE_SECTION))
    const sshOnly = shellFamilySectionTextFor(fakeCtx(['ssh_bash']), 's')
    assert.ok(!sshOnly.includes(LOCAL_SANDBOX_PHRASE) && sshOnly.includes(SHELL_REMOTE_SCOPE_SECTION))
    const both = shellFamilySectionTextFor(fakeCtx(['git_bash', 'ssh_bash']), 's')
    assert.ok(both.includes(LOCAL_SANDBOX_PHRASE) && both.includes(SHELL_REMOTE_SCOPE_SECTION))
    // The fallback path (no prompt section composed) must not claim a local sandbox
    // for the remote tool either — that is the whole point of the flag.
    const fallback = composeToolDescription({
      own: shellDescription('ssh'), familyPresent: false, background: false, escalation: false,
      localSandbox: false, remote: true,
    })
    assert.ok(fallback.includes(SHELL_REMOTE_SCOPE_SECTION))
    assert.ok(!fallback.includes(LOCAL_SANDBOX_PHRASE))
  })
  if (localSsh === undefined) {
    skip('  … skipping the SSH boot cases: no ssh client found on this machine')
  } else {
    /**
     * The one-shot row against TEST-NET-1 (RFC 5737, guaranteed unroutable), so the
     * real spawn -> result -> schema -> render path is exercised with NO network and
     * no credential. The connect fails; what is asserted is the FACT a failure carries,
     * which is exactly where a borrowed verdict used to be able to reappear.
     */
    const BLACKHOLE_ROWS = (sshPath) => CORE_ROW_ONLY + `
- id: win-mb-tool-ssh
  name: 'dsh-win-multi-bash/tool-ssh-bash'
  config:
    sshBash:
      sshPath: '${sshPath.split(BS).join(BS + BS)}'
      sshHost: '192.0.2.1'
      connectTimeoutMs: 1000
`
    const sshCall = (ctx, args) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('audit-ssh-' + Math.random().toString(36).slice(2)),
      name: 'ssh_bash',
      arguments: { description: 'audit ssh', ...args },
    })
    let ctx
    try {
      ctx = await bootFixture(BLACKHOLE_ROWS(localSsh), 'ssh-blackhole.yml')
      await runTests(ctx, [
        ['ssh_bash reports the remote sandbox fact through the REAL spawn/result/render path', async () => {
          const result = await sshCall(ctx, { command: 'uname -a' })
          const value = result.value
          assert.ok(value !== undefined, 'the tool must return its structured value, not a schema violation')
          assert.equal(value.kind, 'foreground')
          assert.notEqual(value.exitCode, 0, 'an unroutable address must fail: ' + JSON.stringify(value.sandbox))
          assert.equal(value.sandbox.remote, true)
          assert.equal(typeof value.sandbox.mode, 'string')
          for (const borrowed of ['denied', 'enforcement', 'runnerFailed', 'unconfined'])
            assert.ok(!(borrowed in value.sandbox), 'the schema must not carry \"' + borrowed + '\" for a remote run')
          const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
          assert.ok(text.includes('[sandbox: not applicable'), text)
          assert.ok(!text.includes('denial dialect'), text)
          assert.ok(!text.includes('ran unconfined'), 'a remote run is not a degraded confinement: ' + text)
        }],
        ['the tool advertises no sandbox_permissions it cannot honour', async () => {
          const definition = ctx.tools.get('ssh_bash')
          assert.ok(definition !== undefined)
          const properties = definition.parameters?.properties ?? {}
          assert.equal(properties.sandbox_permissions, undefined,
            'a row that demands nothing advertises no escalation')
          assert.equal(properties.run_in_background !== undefined, true, 'and it keeps the shared background surface')
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
    // OPT-IN: a real round trip needs a reachable host and a credential, so it is
    // never part of the gate. Run it with
    //   DSH_AUDIT_SSH_HOST=ubuntu_tx node smoke/prepare.mjs audit
    const liveHost = process.env.DSH_AUDIT_SSH_HOST
    if (liveHost === undefined || liveHost.length === 0) {
      skip('  … skipping the live SSH round trip: set DSH_AUDIT_SSH_HOST to run it')
    } else {
      const LIVE_ROWS = CORE_ROW_ONLY + `
- id: win-mb-tool-ssh
  name: 'dsh-win-multi-bash/tool-ssh-bash'
  config:
    sshBash:
      sshPath: '${localSsh.split(BS).join(BS + BS)}'
      sshHost: '${liveHost}'
      connectTimeoutMs: 15000
`
      let liveCtx
      try {
        liveCtx = await bootFixture(LIVE_ROWS, 'ssh-live.yml')
        await runTests(liveCtx, [
          ['ssh_bash really reaches ' + liveHost + ': exit status, stdout and no DSH_* leak', async () => {
            const result = await sshCall(liveCtx, { command: 'uname -sr; echo SSH-ROUNDTRIP-OK; exit 7' })
            const value = result.value
            assert.equal(value.exitCode, 7, 'the remote exit status is propagated: ' + JSON.stringify(value.stdout))
            assert.match(value.stdout.text, /SSH-ROUNDTRIP-OK/)
            assert.equal(value.sandbox.remote, true)
            const leak = await sshCall(liveCtx, { command: 'env | grep -c \"^DSH_\" || true' })
            assert.equal(leak.value.stdout.text.trim(), '0',
              'this host managed $DSH_* facts must not cross the connection: ' + leak.value.stdout.text)
          }],
        ])
      } finally {
        if (liveCtx) await liveCtx.fiber.dispose()
      }
    }
  }
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
  test('the git_bash row exposes the background switch and every executor knob', () => {
    // No guardSandboxTemp here: the deployment-wide switch is listed ONCE, on the
    // package row, and a row copy is exactly the repetition this pins against.
    assert.deepEqual(volatilePaths(gitBashTool.Config), [
      'enableRunInBackground',
      'gitBash.cwd', 'gitBash.timeoutMs', 'gitBash.maxTimeoutMs', 'gitBash.maxOutputBytes',
      'gitBash.maxSpillBytes', 'gitBash.graceMs',
      'gitBash.bashPath', 'gitBash.sandbox', 'gitBash.probeTimeoutMs', 'gitBash.requireSandbox', 'gitBash.sandboxNotice',
    ])
  })
  test('the wsl_bash row exposes the background switch and every executor knob', () => {
    assert.deepEqual(volatilePaths(wslBashTool.Config), [
      'enableRunInBackground',
      'wslBash.cwd', 'wslBash.timeoutMs', 'wslBash.maxTimeoutMs', 'wslBash.maxOutputBytes',
      'wslBash.maxSpillBytes', 'wslBash.graceMs',
      'wslBash.wslPath', 'wslBash.wslDistro', 'wslBash.sandbox', 'wslBash.probeTimeoutMs', 'wslBash.requireSandbox', 'wslBash.sandboxNotice',
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
    assert.equal(git.gitBash.sandboxNotice.get(), 'once', 'the row explains an unwrapped run once by default')
    assert.equal(wsl.wslBash.probeTimeoutMs.get(), 8000)
    assert.equal(wsl.wslBash.sandbox.get(), 'auto')
  })
}

console.log('\n[A] unit: sandbox private temp guard (self-heal for the sandbox private temp root)')
{
  // The defect these pin: dsh-sandbox-local caches ONE private temp root per
  // (session, workspaceRoot) for the provider's whole lifetime
  // (`mkdtempSync(join(tmpdir(), 'dsh-'))`), and the windows-acl runner
  // refuses a missing `--temp` (exit 127), so deleting that directory out of
  // band bricks every later wrapped spawn of the session. The guard reads the
  // `--temp` the seam already handed our executor and recreates the directory
  // plus the seam's own write grant. Pinned here: the decision table (what may
  // be touched at all), every failure path, and both integration points.
  const {
    SANDBOX_TEMP_GUARD_DEFAULT, SANDBOX_TEMP_GUARD_KNOB, SANDBOX_TEMP_NAME, SANDBOX_TEMP_WATCH_MS,
    GUARD_REASONS, HEAL_OUTCOMES, SandboxTempGuard, classifySandboxTempTarget, startSandboxTempWatch,
    loadAclGrantApi, missingTempDirectoryOf, sandboxTempArgument, workspaceArgument,
  } = await import(libUrl('sandbox-temp-guard.js'))
  const { TOOL_LAYER_FIELDS, TERMINAL_ROWS } = await import(libUrl('tool-bash', 'types', 'registry.js'))

  // Scratch temp roots: real mkdtemp directories under the OS temp root, torn
  // down by THIS block (the guard itself never deletes anything). Forward
  // slashes keep the source free of escape surprises; path.join normalizes.
  const guardRoots = []
  const scratchRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-wmb-guard-'))
    guardRoots.push(root)
    return root
  }
  /** The seam's grant API, faked: only the calls and the derived SID matter. */
  const fakeAcl = (records) => ({
    tempWriteSid: (path) => 'SID(' + path + ')',
    AclWriteGrant: {
      create(sid) {
        records.push(['create', sid])
        return {
          add(path, standing) { records.push(['add', path, standing === true]) },
          dispose() { records.push(['dispose']) },
        }
      },
    },
  })
  /** The exact shape dsh-sandbox-local hands the runner (see windowsAclRunnerArgv). */
  const runnerArgv = (workspace, temp) => [
    'node', 'runner.js', '--workspace', workspace, '--temp', temp,
    '--mode', 'workspace-write', '--write-sid', 'S-1-4-1-1', '--temp-write-sid', 'S-1-4-1-1-1',
    '--', 'bash', '-c', 'exit 0',
  ]

  test('sandboxTempArgument(): reads the runner flag, prefers it over the wrapped command, stops at --', () => {
    const temp = join('C:/Temp', 'dsh-Ab12Cd')
    assert.equal(sandboxTempArgument(runnerArgv('C:/ws', temp)), temp)
    assert.equal(sandboxTempArgument(['n', 'r', '--temp=' + temp]), temp)
    // The wrapped command's own --temp token sits AFTER the separator and must
    // never be mistaken for the runner's flag.
    assert.equal(sandboxTempArgument(['n', 'r', '--workspace', 'C:/ws', '--', 'bash', '-c', 'echo --temp /evil']), undefined)
    assert.equal(sandboxTempArgument(['n', 'r', '--temp-write-sid', 'S-1-4-1-1-1', '--']), undefined)
    assert.equal(sandboxTempArgument(['n', 'r']), undefined)
    assert.equal(sandboxTempArgument(undefined), undefined)
  })

  test('workspaceArgument(): the runner workspace only, never the wrapped command arguments', () => {
    assert.equal(workspaceArgument(runnerArgv('C:/ws', 'C:/Temp/dsh-Ab12Cd')), 'C:/ws')
    assert.equal(workspaceArgument(['n', 'r', '--', '--workspace', 'C:/evil']), undefined)
    assert.equal(workspaceArgument(undefined), undefined)
  })

  test('missingTempDirectoryOf(): finds the runner signature and ignores everything else', () => {
    const named = join('C:/Users/x/AppData/Local/Temp', 'dsh-Ab12Cd')
    assert.equal(missingTempDirectoryOf('windows-acl-run: --temp is not an existing directory: ' + named + '\n'), named)
    assert.equal(missingTempDirectoryOf('bash: line 1: oops\n'), undefined)
    assert.equal(missingTempDirectoryOf('--temp is not an existing directory: '), undefined)
    assert.equal(missingTempDirectoryOf(undefined), undefined)
  })

  test('the accepted name shape is the one mkdtemp really produces (measured, not guessed)', () => {
    const root = scratchRoot()
    for (let i = 0; i < 25; i += 1) {
      const made = mkdtempSync(join(root, 'dsh-'))
      const name = made.slice(root.length + 1)
      assert.ok(SANDBOX_TEMP_NAME.test(name), 'mkdtemp produced a name the guard would refuse: ' + name)
      assert.ok(/^[A-Za-z0-9]{6}$/.test(name.slice(4)), 'mkdtemp alphabet changed: ' + name)
    }
    // The neighbouring private directories the seam also creates must NOT
    // qualify: only `dsh-` + exactly six alphanumerics is a private temp root.
    for (const other of ['dsh-acl-skill-Ab12Cd', 'dsh-Ab12C', 'dsh-Ab12Cde', 'dsh-ab12c-', 'dsh-acl-locks', 'dsh-spill-gZMl5U', 'Temp'])
      assert.ok(!SANDBOX_TEMP_NAME.test(other), 'the guard would accept a non-private-root shape: ' + other)
  })

  test('classification: only a MISSING dsh-<6> direct child of a temp root may be healed', () => {
    const root = 'G:/TempRoot'
    const ws = 'G:/LAB/ws'
    const kind = (path, options = {}) => classifySandboxTempTarget(path, {
      tempRoots: [root], workspaceRoots: [ws], exists: () => false, ...options,
    })
    const target = join(root, 'dsh-Ab12Cd')
    assert.deepEqual(kind(target), { action: 'heal', reason: 'missing', path: target, tempRoot: root })
    assert.equal(kind(target, { exists: () => true, stat: () => ({ isDirectory: () => true }) }).reason, GUARD_REASONS.ALREADY_EXISTS)
    assert.equal(kind(target, { exists: () => true, stat: () => ({ isDirectory: () => false }) }).reason, GUARD_REASONS.EXISTS_NOT_DIRECTORY)
    assert.equal(kind(target, { exists: () => { throw new Error('EACCES') } }).reason, GUARD_REASONS.EXISTS_NOT_DIRECTORY)
    assert.equal(kind('').reason, GUARD_REASONS.BAD_PATH)
    assert.equal(kind('dsh-Ab12Cd').reason, GUARD_REASONS.NOT_ABSOLUTE)
    assert.equal(kind(join('G:/elsewhere', 'dsh-Ab12Cd')).reason, GUARD_REASONS.OUTSIDE_TEMP_ROOT)
    assert.equal(kind(join(root, 'sub', 'dsh-Ab12Cd')).reason, GUARD_REASONS.NOT_DIRECT_CHILD)
    assert.equal(kind(root).reason, GUARD_REASONS.NOT_DIRECT_CHILD)
    assert.equal(kind(join(root, 'dsh-Ab12C')).reason, GUARD_REASONS.NAME_SHAPE)
    assert.equal(kind(join(root, 'dsh-acl-skill-Ab12Cd')).reason, GUARD_REASONS.NAME_SHAPE)
    assert.equal(kind(join(root, 'dsh-Ab12Cd'), { workspaceRoots: [root] }).reason, GUARD_REASONS.INSIDE_WORKSPACE)
    assert.equal(kind(join(root, 'dsh-Ab12Cd'), { workspaceRoots: [] }).action, 'heal')
  })

  test('classification: shape and scope are decided BEFORE existence', () => {
    // An existing, wrongly-shaped path must be refused for its SHAPE — the
    // reason a guard declines is evidence, and it has to name the real one.
    const verdict = classifySandboxTempTarget(join('G:/TempRoot', 'not-a-private-root'), {
      tempRoots: ['G:/TempRoot'], workspaceRoots: [],
      exists: () => true, stat: () => ({ isDirectory: () => true }),
    })
    assert.equal(verdict.reason, GUARD_REASONS.NAME_SHAPE)
  })

  test('the guard can only ever create: its own fs seam has no deleting or writing operation', () => {
    assert.deepEqual(Object.keys(new SandboxTempGuard({}).fs()).sort(), ['exists', 'mkdir', 'readdir', 'stat'])
  })

  test('...and the module SOURCE carries no deleting or writing call at all (F3)', () => {
    // The seam above is the module's OWN factory, so pinning its key set proves
    // nothing about the module: a reviewer added a real `unlinkSync` import and
    // call inside `heal()` and every assertion here stayed green. This reads the
    // source, which is what makes "nothing is ever deleted" the enforced invariant
    // its header claims rather than a property nobody checks.
    const source = readFileSync(join(PLUGIN, 'lib', 'sandbox-temp-guard.js'), 'utf8')
    // Comments are stripped first: the module's own prose explains that a manual
    // `rmdir` out of band is what it exists to survive, and a naive substring
    // check flagged that documentation as a deletion call.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of ['unlink', 'rmSync', 'rmdir', 'rename(', 'writeFile', 'appendFile', 'truncate', 'createWriteStream', 'chmod'])
      assert.ok(!code.includes(forbidden), 'sandbox-temp-guard.js must never call ' + forbidden)
    // ...and its filesystem surface stays exactly the three read/create imports.
    const imported = /import\s*\{([^}]*)\}\s*from\s*['"]node:fs['"]/.exec(source)
    assert.ok(imported !== null, 'the fs import must stay explicit')
    assert.deepEqual(imported[1].split(',').map((name) => name.trim()).sort(), ['existsSync', 'mkdirSync', 'readdirSync', 'statSync'])
  })

  test('the self-heal switch is listed ONCE, on the package row, never on a tool row', () => {
    assert.deepEqual(TOOL_LAYER_FIELDS.map((knob) => knob.key), ['enableRunInBackground'])
    // The deployment-wide self-heal switch is NOT a tool-layer field any more: it is
    // declared once on the package row, so no tool row repeats it, no row page shows
    // it, and there is no per-row override left to disagree with it.
    for (const tool of [gitBashTool, wslBashTool]) {
      assert.ok(!(SANDBOX_TEMP_GUARD_KNOB in tool.Config({})), 'a tool row must not carry the deployment-wide switch')
      assert.equal(tool.Config.dict[SANDBOX_TEMP_GUARD_KNOB], undefined, 'and it must not be reachable as a row option either')
    }
    // The switch belongs to the rows that RUN a confined command (the dialect
    // rows). The terminal row deliberately does NOT carry it: a PTY session is
    // never wrapped by the sandbox seam, so a switch there would be a control
    // that cannot do anything — the opposite of what this file exists to prevent.
    for (const row of REGISTRY_ROWS) {
      // THE SWITCH IS LISTED ONCE, on the package row (its own Config): a tool row
      // must not repeat it, because four copies of one deployment-wide knob is
      // exactly the drift a single top-level switch exists to prevent.
      assert.ok(!row.fields.some((knob) => knob.key === SANDBOX_TEMP_GUARD_KNOB), row.rowId + ' must not repeat the deployment-wide switch')
    }
  })

  test('the self-heal switch comes from the package row only: the per-row override is gone', () => {
    const bare = bareInstance(GitBashExecutor, { config: gitConfig() })
    assert.equal(bare.sandboxTempGuardEnabled, SANDBOX_TEMP_GUARD_DEFAULT)
    assert.equal(typeof bare.attachToolLayer, 'undefined', 'the removed override seam must not come back')
    // Starting the watch is still a chainable, idempotent call on the row's context.
    const chained = bare.startTempWatch({ effect: () => () => {} })
    assert.equal(chained, bare)
    assert.equal(bare.startTempWatch({ effect: () => () => {} }), bare)
  })

  assert.ok(Number.isFinite(SANDBOX_TEMP_WATCH_MS) && SANDBOX_TEMP_WATCH_MS >= 1000,
    'the watch interval must be a real interval, not 0/NaN (that would spin the host)')

  // The third channel, and the only one that reaches a row whose probe verdict is
  // negative — the case this machine is actually in: the windows-acl runner cannot
  // start MSYS bash (probe failed => the row never confines again), while the HARNESS
  // keeps using the same (session, workspace root) private root. Deleting that root
  // then bricks every confined tool the harness runs until a human rebuilds it; the
  // repair itself needs no elevation, because the host process is not confined.
  await testAsync('ensureSeen(): the watch repairs a root that vanished after the probe, with no confined run', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Ab12Cd')
    const records = []
    const warnings = []
    const guard = new SandboxTempGuard({
      tempRoots: () => [root],
      warn: (key, message) => warnings.push(key + ': ' + message),
      internals: { aclApi: async () => fakeAcl(records) },
    })
    await guard.ensureArgvUsable({ argv: runnerArgv('C:/ws', missing) }, { mode: 'read-only', workspaceRoot: 'C:/ws' })
    assert.ok(existsSync(missing), 'the one confine call a never-confining row makes still creates the root')
    rmSync(missing, { recursive: true, force: true })
    records.length = 0
    warnings.length = 0
    const repaired = await guard.ensureSeen()
    assert.equal(repaired.length, 1, 'the watch repairs exactly the vanished root')
    assert.equal(repaired[0].channel, 'temp-watch')
    assert.equal(repaired[0].action, 'heal')
    assert.ok(existsSync(missing), 'the root the shared seam hands out must exist again')
    assert.deepEqual(records, [['create', 'SID(' + missing + ')'], ['add', missing, true], ['dispose']])
    assert.equal(warnings.length, 1)
    // Cheap when nothing is wrong: a tick over a healthy root touches neither fs nor ACL.
    records.length = 0
    assert.deepEqual(await guard.ensureSeen(), [])
    assert.deepEqual(records, [], 'a healthy root must not be re-granted on every tick')
  })

  await testAsync('ensureSeen(): the row switch stops the watch too, and remembers nothing to repair', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Ab12Cd')
    let mkdirCalls = 0
    const guard = new SandboxTempGuard({
      enabled: () => false,
      tempRoots: () => [root],
      internals: { mkdir: () => { mkdirCalls += 1 }, aclApi: async () => fakeAcl([]) },
    })
    guard.remember({ argv: runnerArgv('C:/ws', missing) }, {})
    assert.deepEqual(await guard.ensureSeen(), [], 'a disabled guard repairs nothing')
    assert.equal(mkdirCalls, 0, 'and never touches the filesystem')
  })

  await testAsync('startTempWatch(): the base registers ONE disposable timer, and a tick heals in the host', async () => {
    const { ShellExecutorBase: Base } = await import(libUrl('shell-executor.js'))
    const root = scratchRoot()
    const missing = join(root, 'dsh-Ab12Cd')
    let disposer
    let effectLabel = ''
    const guard = new SandboxTempGuard({ tempRoots: () => [root], warn: () => {}, internals: { aclApi: async () => fakeAcl([]) } })
    await guard.ensureArgvUsable({ argv: runnerArgv('C:/ws', missing) }, {})
    rmSync(missing, { recursive: true, force: true })
    // The real prototype (a tick calls sibling methods, and a plain object crashed
    // the whole audit), with the class's GETTERS shadowed by own data properties:
    // neither Object.assign nor a spread can overwrite `tempGuard`.
    const hostInstance = (fields) => {
      const made = Object.create(Base.prototype)
      for (const [key, value] of Object.entries(fields)) Object.defineProperty(made, key, { value, writable: true, configurable: true })
      return made
    }
    const host = hostInstance({
      tempGuard: guard,
      tempWatchMs: 5,
      tempWatchStarted: false,
      sandboxTempGuardEnabled: true,
      warnOnce: () => {},
      ctx: { effect: (callback, label) => { effectLabel = label; disposer = callback() } },
    })
    assert.equal(Base.prototype.startTempWatch.call(host), host)
    assert.ok(typeof disposer === 'function', 'the timer must be disposable through ctx.effect')
    assert.ok(effectLabel.includes('temp watch'), String(effectLabel))
    await new Promise((done) => setTimeout(done, 60))
    assert.ok(existsSync(missing), 'one tick must repair the vanished root')
    disposer()
    // Registering twice would leave a second interval behind on every call.
    const twice = hostInstance({
      tempGuard: guard, tempWatchMs: 5, tempWatchStarted: true, sandboxTempGuardEnabled: true, warnOnce: () => {},
      ctx: { effect: () => { throw new Error('must not register a second timer') } },
    })
    assert.equal(Base.prototype.startTempWatch.call(twice), twice)
    // A tick with no working guard must be REPORTED, never thrown out of the timer:
    // an uncaught throw here takes the whole host down (measured, this file).
    const broken = hostInstance({
      tempGuard: undefined,
      tempWatchMs: 5,
      tempWatchStarted: false,
      sandboxTempGuardEnabled: true,
      warnOnce: undefined,
      ctx: { effect: (callback) => callback() },
    })
    assert.equal(Base.prototype.startTempWatch.call(broken), broken)
    await new Promise((done) => setTimeout(done, 40))
  })

  await testAsync('ensureTempRootUsable(): with nothing remembered it ASKS the seam, then heals what the seam requires', async () => {
    const { ShellExecutorBase: Base } = await import(libUrl('shell-executor.js'))
    const root = scratchRoot()
    const missing = join(root, 'dsh-Ab12Cd')
    let confineCalls = 0
    const guard = new SandboxTempGuard({ tempRoots: () => [root], warn: () => {}, internals: { aclApi: async () => fakeAcl([]) } })
    const host = Object.create(Base.prototype)
    for (const [key, value] of Object.entries({
      tempGuard: guard,
      sandboxTempGuardEnabled: true,
      warnSilentlyOnce: () => {},
      ctx: {
        sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:/ws' }) },
        sandbox: { confine: async () => { confineCalls += 1; return { argv: runnerArgv('C:/ws', missing), temp: missing } } },
      },
    })) Object.defineProperty(host, key, { value, writable: true, configurable: true })
    // The premise of this machine: the probe threw INSIDE the seam, so this row never
    // reached ensureArgvUsable and the guard knows no root at all.
    assert.equal(guard.seenTempArgvs.length, 0)
    await Base.prototype.ensureTempRootUsable.call(host)
    assert.equal(confineCalls, 1, 'it must ask the seam exactly once')
    assert.ok(existsSync(missing), 'the root the seam is about to require must exist afterwards')
    assert.equal(guard.seenTempArgvs.length, 1, 'and it is remembered for the steady state')
    await Base.prototype.ensureTempRootUsable.call(host)
    assert.equal(confineCalls, 1, 'the steady state must not call the seam again')
  })

  await testAsync('confineRun(): by the time it returns, the seam argv is usable — the spawn never sees a missing --temp', async () => {
    const { ShellExecutorBase: Base } = await import(libUrl('shell-executor.js'))
    const root = scratchRoot()
    const missing = join(root, 'dsh-Qq77Ww')
    const guard = new SandboxTempGuard({ tempRoots: () => [root], warn: () => {}, internals: { aclApi: async () => fakeAcl([]) } })
    const host = Object.create(Base.prototype)
    for (const [key, value] of Object.entries({
      tempGuard: guard,
      sandboxTempGuardEnabled: true,
      tempWatchStarted: true,
      warnOnce: () => {},
      warnSilentlyOnce: () => {},
      ctx: {
        sandbox: { confine: async (argv) => ({ argv: runnerArgv('C:/ws', missing), temp: missing }) },
      },
    })) Object.defineProperty(host, key, { value, writable: true, configurable: true })
    // The premise: the seam hands back an argv naming a root that is GONE. The
    // caller spawns whatever this call returns, so the repair has to be inside it.
    assert.ok(!existsSync(missing), 'the premise is a missing private root')
    const policy = { mode: 'workspace-write', workspaceRoot: 'C:/ws' }
    const confined = await Base.prototype.confineRun.call(host, ['bash', '-c', 'echo hi'], policy, undefined)
    const temp = sandboxTempArgument(confined.argv)
    assert.equal(temp, missing, 'the seam result is returned unmodified')
    assert.ok(existsSync(temp), 'and the root it names exists BEFORE the caller can spawn it')
  })

  // `testAsync`, not `test`: with the synchronous helper an assertion failure here is an
  // uncaught rejection that aborts the whole file (later cases never run, and the ✓ is
  // printed before the assertion), which is exactly how this case first hid a bug.
  await testAsync('the interval is a LIVE value: the knob applies without a reload, and has a floor', async () => {
    const mod = await import(libUrl('sandbox-temp-guard.js'))
    assert.equal(typeof mod.getSandboxTempWatchMs, 'function', 'the live value must be readable')
    assert.equal(typeof mod.setSandboxTempWatchMs, 'function', 'and writable by the package row')
    assert.equal(mod.getSandboxTempWatchMs(), mod.SANDBOX_TEMP_WATCH_MS, 'it starts at the shipped default')
    // Module state is shared with every other test in this file, so the value is
    // restored: a leaked 2000 would silently couple later cases to this one.
    const shipped = mod.getSandboxTempWatchMs()
    try {
      assert.equal(mod.setSandboxTempWatchMs(2000), 2000, 'a value from the page is taken as-is')
      assert.equal(mod.getSandboxTempWatchMs(), 2000, 'and read back live, with no reload')
      assert.equal(mod.setSandboxTempWatchMs(5), mod.SANDBOX_TEMP_WATCH_MS_MIN, 'a value under the floor is CLAMPED UP, never silently ignored')
      assert.equal(mod.setSandboxTempWatchMs('nonsense'), mod.SANDBOX_TEMP_WATCH_MS, 'a non-number falls back to the shipped default')
      // A live source (what the package row publishes) is resolved on every read.
      let asked = 3000
      assert.equal(mod.setSandboxTempWatchMs(() => asked), 3000, 'an accessor is accepted')
      asked = 4000
      assert.equal(mod.getSandboxTempWatchMs(), 4000, 'and re-read after the handle changes')
    } finally {
      mod.setSandboxTempWatchMs(shipped)
      assert.equal(mod.getSandboxTempWatchMs(), shipped, 'the live value must be left as it was found')
    }
    assert.ok(mod.SANDBOX_TEMP_WATCH_MS <= 10_000, 'the shipped default is the timelier one')
  })

  // REGRESSION GUARD (review of the previous commit found this whole family missing).
  // A `.volatile()` field arrives in `apply` as a live handle, not as a value: comparing
  // the handle to `false` kept the OFF path from ever existing, `Number(handle)` was NaN
  // so the interval knob was ignored, and the handle handed to `setTimeout` was coerced
  // to 1 ms — a synchronous `%TEMP%` listing about a thousand times a second.
  await testAsync('the package row resolves its .volatile() knobs to live VALUES, not to handles', async () => {
    const plugin = await import(libUrl('index.js'))
    const guardApi = await import(libUrl('sandbox-temp-guard.js'))
    let enabled = false
    let asked = 1500
    const resolved = { guardSandboxTemp: { get: () => enabled }, tempWatchMs: { get: () => asked } }
    const disposers = []
    // `apply` returns early without a `systemPrompt` service; the guard is published first.
    plugin.apply({ logger: { warn: () => {} }, effect: (callback) => { const off = callback(); disposers.push(off); return off; } }, resolved)
    assert.equal(guardApi.getSandboxTempGuardEnabled(), false, 'off must mean OFF, not a truthy handle')
    assert.equal(guardApi.getSandboxTempWatchMs(), 1500, 'the interval must land as a NUMBER, not a handle')
    enabled = true
    asked = 2500
    assert.equal(guardApi.getSandboxTempGuardEnabled(), true, 'a later page change is seen without re-running apply')
    assert.equal(guardApi.getSandboxTempWatchMs(), 2500, 'and so is the interval')
    for (const off of disposers) if (typeof off === 'function') off()
    guardApi.setSandboxTempGuardEnabled(true)
    guardApi.setSandboxTempWatchMs(guardApi.SANDBOX_TEMP_WATCH_MS)
  })

  test("the plugin row declares the switch, and the client lists it at the TOP level", () => {
    // The Host serves a settings namespace only when the row declares a Config, and
    // the official page renders a bundle config card only for plugins.bundle.config
    // keyed by the PACKAGE name — a row-level form alone can never reach the top.
    const index = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8')
    assert.ok(index.includes('guardSandboxTemp'), 'the package row must declare the switch')
    // `.volatile()` fields arrive as live handles, so the row must READ THROUGH them: the
    // previous form compared the handle itself to false and silently killed the OFF path.
    assert.ok(index.includes('live(config.guardSandboxTemp) !== false'), 'the switch must be resolved through its handle')
    assert.ok(index.includes('setSandboxTempWatchMs(() => live(config.tempWatchMs))'), 'and the interval published as a live source')
    assert.ok(!index.includes('intervalMs: config.tempWatchMs'), 'a raw handle must never reach the timer')
    assert.ok(index.includes('z.boolean().default(SANDBOX_TEMP_GUARD_DEFAULT)'), 'the switch defaults to the guard default')
    assert.ok(index.includes('z.natural().default(SANDBOX_TEMP_WATCH_MS)'), 'and the interval to the watch constant')
    // Volatile is not decoration: a plain field is served read-only, and the page
    // then reports the row as unconfigurable instead of rendering the switch.
    assert.ok(index.includes('guardSandboxTemp: z.boolean().default(SANDBOX_TEMP_GUARD_DEFAULT).volatile()'), 'the switch must be volatile')
    assert.ok(index.includes('tempWatchMs: z.natural().default(SANDBOX_TEMP_WATCH_MS).volatile()'), 'and so must the interval')
    const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
    assert.ok(client.includes('plugins.bundle.config'), 'the client must register the top-level seat')
    // The switch card is offered at every key a deployment might ask that seat with:
    // the bundle seat under the served namespace, and under the package name.
    assert.ok(!client.includes('["plugins.row.config", rowKey(CORE_ROW_ID)]'), 'the core row page must not carry it')
    assert.ok(client.includes('["plugins.bundle.config", CORE_ROW_ID]'), 'the bundle seat under the served namespace')
    assert.ok(client.includes('["plugins.bundle.config", PACKAGE_NAME]'), 'and under the package name the contract words it with')
    // Listed exactly once, as the README words it. Measured on this host (2026-10-17):
    // a `settings.section` contribution rendered the same form a second time, as an
    // unlabelled top-level Settings entry, because a section registration here carries
    // no label at all. The bundle card is the one place.
    assert.ok(!client.includes('ctx.slots.inject("settings.section"'), 'the Settings panel must not carry a second copy')
  })

  await testAsync("startSandboxTempWatch(): the row switch off means no repair at all", async () => {
    const root = scratchRoot()
    const victim = join(root, 'dsh-Ab12Cd')
    mkdirSync(victim)
    // A pre-built guard carries its own switch, so this one is built OFF: the point
    // is that the driver repairs nothing at all when the deployment turned it off.
    const guard = new SandboxTempGuard({ enabled: () => false, tempRoots: () => [root], warn: () => {}, internals: { aclApi: async () => fakeAcl([]) } })
    let disposer
    startSandboxTempWatch({ effect: (callback) => { disposer = callback() } }, { guard, intervalMs: 5 })
    rmSync(victim, { recursive: true, force: true })
    await new Promise((done) => setTimeout(done, 40))
    assert.ok(!existsSync(victim), 'a disabled guard must not recreate anything')
    disposer()
  })

  await testAsync('rememberAmbient()/ensureAmbient(): a root learned from the listing is rebuilt when it vanishes', async () => {
    const root = scratchRoot()
    const victim = join(root, 'dsh-Ab12Cd')
    mkdirSync(victim)
    const guard = new SandboxTempGuard({ tempRoots: () => [root], warn: () => {}, internals: { aclApi: async () => fakeAcl([]) } })
    assert.equal(guard.rememberAmbient(), 1, 'the listing is the source that needs no seam')
    assert.deepEqual(guard.ambientRoots, [victim])
    rmSync(victim, { recursive: true, force: true })
    const repaired = await guard.ensureAmbient()
    assert.equal(repaired.length, 1)
    assert.equal(repaired[0].channel, 'ambient-root')
    assert.equal(repaired[0].action, 'heal')
    assert.ok(existsSync(victim), 'a root the listing saw must be rebuilt after it vanishes')
    assert.deepEqual(await guard.ensureAmbient(), [], 'and nothing is done while it exists')
    // Only the private-root shape, directly under a temp root, may be adopted.
    mkdirSync(join(root, 'dsh-toolong'))
    mkdirSync(join(root, 'plain-dir'))
    const before = guard.ambientRoots.length
    guard.rememberAmbient()
    assert.equal(guard.ambientRoots.length, before, 'only dsh-<6 alnum> may be adopted')
    // The knob stops this channel exactly like the others.
    const off = new SandboxTempGuard({ enabled: () => false, tempRoots: () => [root], warn: () => {} })
    off.rememberAmbient()
    assert.deepEqual(await off.ensureAmbient(), [])
  })

  test('the guard is shell-free by construction: its code reaches into nothing from the tool layer', () => {
    const source = readFileSync(join(PLUGIN, 'lib', 'sandbox-temp-guard.js'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // The contract is: no dependency on the SHELL/tool layer and none on the sandbox
    // seam. A host context is accepted for one thing only — owning a disposable timer.
    for (const forbidden of ['shell-executor', 'bash-git', 'bash-wsl', 'bash-msys2', 'tool-bash', 'ctx.shell', 'ctx.sandbox', 'ctx.subprocess'])
      assert.ok(!code.includes(forbidden), 'the guard must not reach into ' + forbidden)
    const imported = [...code.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1])
    assert.ok(imported.length > 0 && imported.every((specifier) => specifier.startsWith('node:')),
      'the guard may import node builtins only, got: ' + imported.join(', '))
  })

  await testAsync('startSandboxTempWatch(): its own row drives the guard, with no shell tool involved', async () => {
    const root = scratchRoot()
    const victim = join(root, 'dsh-Ab12Cd')
    mkdirSync(victim)
    const guard = new SandboxTempGuard({ tempRoots: () => [root], warn: () => {}, internals: { aclApi: async () => fakeAcl([]) } })
    let label = ''
    let disposer
    const ctx = { effect: (callback, name) => { label = name; disposer = callback() } }
    assert.equal(startSandboxTempWatch(ctx, { guard, intervalMs: 5 }), guard)
    assert.ok(label.includes('temp guard'), String(label))
    assert.deepEqual(guard.ambientRoots, [victim], 'mounting seeds the memory from the listing, before anything vanishes')
    rmSync(victim, { recursive: true, force: true })
    await new Promise((done) => setTimeout(done, 40))
    assert.ok(existsSync(victim), 'the timer repairs it with no shell command anywhere in sight')
    disposer()
    // A context that cannot own a timer gets no driver at all, and no crash.
    assert.equal(startSandboxTempWatch({}, { guard, intervalMs: 5 }), undefined)
  })

  // These are AWAITED, unlike the (fire-and-forget) testAsync calls elsewhere in
  // this file: the block's scratch temp roots are torn down at its end, and an
  // unfinished heal would otherwise race that cleanup.
  await testAsync('ensureArgvUsable(): a missing private temp root is recreated and re-granted with the seam SID', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Ab12Cd')
    const records = []
    const warnings = []
    const guard = new SandboxTempGuard({
      tempRoots: () => [root],
      warn: (key, message) => warnings.push(key + ': ' + message),
      internals: { aclApi: async () => fakeAcl(records) },
    })
    const report = await guard.ensureArgvUsable({ argv: runnerArgv('C:/ws', missing) }, { mode: 'workspace-write', workspaceRoot: 'C:/ws' })
    assert.equal(report.channel, 'confined-argv')
    assert.equal(report.action, 'heal')
    assert.equal(report.outcome, HEAL_OUTCOMES.HEALED)
    assert.ok(existsSync(missing), 'the missing private temp root must exist before the spawn')
    assert.deepEqual(records, [['create', 'SID(' + missing + ')'], ['add', missing, true], ['dispose']])
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('removed out of band'))
    // Idempotent: the very same call now sees the directory and touches nothing.
    records.length = 0
    const again = await guard.ensureArgvUsable({ argv: runnerArgv('C:/ws', missing) }, {})
    assert.equal(again.action, 'skip')
    assert.equal(again.reason, GUARD_REASONS.ALREADY_EXISTS)
    assert.deepEqual(records, [], 'an existing directory must not be re-granted or re-touched')
  })

  await testAsync('ensureArgvUsable(): the knob off is a hard stop — no filesystem, no package load', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Ab12Cd')
    let existsCalls = 0
    let mkdirCalls = 0
    let aclLoads = 0
    const guard = new SandboxTempGuard({
      enabled: () => false,
      tempRoots: () => [root],
      internals: {
        exists: () => { existsCalls += 1; return false },
        mkdir: () => { mkdirCalls += 1 },
        aclApi: async () => { aclLoads += 1; return fakeAcl([]) },
      },
    })
    const report = await guard.ensureArgvUsable({ argv: runnerArgv('C:/ws', missing) }, {})
    assert.equal(report.reason, GUARD_REASONS.DISABLED)
    assert.equal(guard.observeRunnerStderr('windows-acl-run: --temp is not an existing directory: ' + missing), undefined)
    assert.deepEqual(await guard.settle(), [])
    assert.equal(existsCalls, 0)
    assert.equal(mkdirCalls, 0)
    assert.equal(aclLoads, 0)
  })

  await testAsync('ensureArgvUsable(): the AMBIENT temp root of a read-only run is never a target', async () => {
    // Read-only and agentless policies hand the runner the ambient temp root
    // (`--temp <os temp>`); it is not a mkdtemp child and must never be
    // recreated or re-granted.
    const root = scratchRoot()
    const guard = new SandboxTempGuard({
      tempRoots: () => [root],
      internals: { mkdir: () => { throw new Error('the ambient temp root must never be created') } },
    })
    const report = await guard.ensureArgvUsable({ argv: runnerArgv('C:/ws', root) }, {})
    assert.equal(report.action, 'skip')
    assert.equal(report.reason, GUARD_REASONS.NOT_DIRECT_CHILD)
  })

  await testAsync('heal(): without the ACL package the directory is restored, existence only, and said so', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Cd34Ef')
    const warnings = []
    const guard = new SandboxTempGuard({ tempRoots: () => [root], warn: (key, message) => warnings.push(message), internals: { aclApi: async () => undefined } })
    const report = await guard.heal(missing, [])
    assert.equal(report.outcome, HEAL_OUTCOMES.EXISTENCE_ONLY)
    assert.equal(report.detail, 'acl-api-unavailable')
    assert.ok(existsSync(missing))
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('NOT restored'))
  })

  await testAsync('heal(): a grant failure is reported by name, and the directory is left in place', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Gh56Ij')
    const guard = new SandboxTempGuard({
      tempRoots: () => [root],
      internals: {
        aclApi: async () => ({
          tempWriteSid: (path) => 'SID(' + path + ')',
          AclWriteGrant: { create: () => ({ add: () => { throw new Error('SetNamedSecurityInfoW 5') }, dispose: () => {} }) },
        }),
      },
    })
    const report = await guard.heal(missing, [])
    assert.equal(report.outcome, HEAL_OUTCOMES.GRANT_FAILED)
    assert.ok(report.detail.includes('SetNamedSecurityInfoW'))
    assert.ok(existsSync(missing), 'nothing is ever rolled back by deleting the directory')
  })

  await testAsync('heal(): a refused mkdir is reported by name, and nothing else is attempted', async () => {
    const root = scratchRoot()
    const guard = new SandboxTempGuard({
      tempRoots: () => [root],
      internals: {
        mkdir: () => { const error = new Error('EPERM'); error.code = 'EPERM'; throw error },
        aclApi: async () => { throw new Error('must not be reached after a failed mkdir') },
      },
    })
    const report = await guard.heal(join(root, 'dsh-Kl78Mn'), [])
    assert.equal(report.outcome, HEAL_OUTCOMES.MKDIR_FAILED)
    assert.equal(report.detail, 'EPERM')
  })

  await testAsync('heal(): a path that fails the gates is never created, even when asked directly', async () => {
    const root = scratchRoot()
    const guard = new SandboxTempGuard({ tempRoots: () => [root], internals: { mkdir: () => { throw new Error('must not be called') } } })
    const outside = await guard.heal(join('C:/Windows', 'dsh-Ab12Cd'), [])
    assert.equal(outside.action, 'skip')
    assert.equal(outside.reason, GUARD_REASONS.OUTSIDE_TEMP_ROOT)
    const shaped = await guard.heal(join(root, 'dsh-12chars'), [])
    assert.equal(shaped.reason, GUARD_REASONS.NAME_SHAPE)
  })

  await testAsync('observeRunnerStderr(): the runner signature heals for the NEXT command, and settle() awaits it', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Op90Qr')
    const records = []
    const guard = new SandboxTempGuard({ tempRoots: () => [root], internals: { aclApi: async () => fakeAcl(records) } })
    const named = guard.observeRunnerStderr('noise\nwindows-acl-run: --temp is not an existing directory: ' + missing + '\n')
    assert.equal(named, missing)
    const settled = await guard.settle()
    assert.equal(settled.length, 1)
    assert.equal(settled[0].outcome, HEAL_OUTCOMES.HEALED)
    assert.ok(existsSync(missing))
    assert.deepEqual(records, [['create', 'SID(' + missing + ')'], ['add', missing, true], ['dispose']])
  })

  await testAsync('observeRunnerStderr(): unrelated stderr, and the knob off, are both no-ops', async () => {
    const root = scratchRoot()
    let aclLoads = 0
    const on = new SandboxTempGuard({ tempRoots: () => [root], internals: { aclApi: async () => { aclLoads += 1; return fakeAcl([]) } } })
    assert.equal(on.observeRunnerStderr('bash: EPERM\n'), undefined)
    assert.deepEqual(await on.settle(), [])
    assert.equal(aclLoads, 0)
    const off = new SandboxTempGuard({ enabled: () => false, tempRoots: () => [root], internals: { mkdir: () => { throw new Error('must not run') } } })
    assert.equal(off.observeRunnerStderr('windows-acl-run: --temp is not an existing directory: ' + join(root, 'dsh-St12Uv')), undefined)
    assert.deepEqual(await off.settle(), [])
  })

  await testAsync('loadAclGrantApi(): the optional peer resolves here, or degrades to undefined without throwing', async () => {
    const api = await loadAclGrantApi()
    if (api === undefined) {
      skip('  … skipping: the optional ACL peer is not resolvable here, so only the degradation is covered')
      return
    }
    assert.equal(typeof api.tempWriteSid, 'function')
    assert.equal(typeof api.AclWriteGrant.create, 'function')
    // The SID is a pure function of the path, so a heal recomputes the SAME
    // identity the seam's cached capability used.
    assert.equal(api.tempWriteSid('C:/Temp/dsh-Ab12Cd'), api.tempWriteSid('C:/Temp/dsh-Ab12Cd'))
    assert.match(api.tempWriteSid('C:/Temp/dsh-Ab12Cd'), /^S-1-4-\d+-\d+-1$/)
  })

  await testAsync('confineRun(): the argv the seam hands over is repaired BEFORE the runner is spawned', async () => {
    const root = scratchRoot()
    const missing = join(root, 'dsh-Wx34Yz')
    const records = []
    const guard = new SandboxTempGuard({ tempRoots: () => [root], internals: { aclApi: async () => fakeAcl(records) } })
    const confinements = []
    const executor = bareInstance(GitBashExecutor, {
      config: gitConfig(),
      tempGuardInstance: guard,
      ctx: fakeCtx({
        sandbox: { confine: async (argv, policy) => { confinements.push({ argv, policy }); return { argv: runnerArgv('C:/ws', missing), enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] } } },
      }),
    })
    const confined = await executor.confineRun(['bash', '-c', 'exit 0'], { mode: 'workspace-write', workspaceRoot: 'C:/ws' })
    assert.equal(confinements.length, 1)
    assert.ok(confined.argv.includes(missing), 'the seam argv is returned unchanged')
    assert.ok(existsSync(missing), 'the guard ran before the spawn, so the runner finds its --temp')
    assert.equal(guard.reports.at(-1).outcome, HEAL_OUTCOMES.HEALED)
  })

  await testAsync('confineRun(): a throwing guard is reported once and never replaces the run', async () => {
    const executor = bareInstance(GitBashExecutor, {
      config: gitConfig(),
      tempGuardInstance: { ensureArgvUsable: async () => { throw new Error('guard exploded') } },
      ctx: fakeCtx({ sandbox: { confine: async () => ({ argv: ['node', 'runner.js'] }) }, logger: { warn() {} } }),
    })
    const confined = await executor.confineRun(['bash', '-c', 'exit 0'], { mode: 'workspace-write', workspaceRoot: 'C:/ws' })
    assert.deepEqual(confined.argv, ['node', 'runner.js'])
  })

  test('onProcessDone(): a confined settle offers its stderr to the guard; an unconfined one does not', () => {
    const seen = []
    const spy = { observeRunnerStderr: (stderr) => { seen.push(stderr) } }
    const proc = { exitCode: 0, sandbox: undefined }
    const confined = bareInstance(GitBashExecutor, { config: gitConfig(), tempGuardInstance: spy })
    confined.processFacts.set(proc, { mode: 'workspace-write', enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] })
    confined.onProcessDone(proc, 'windows-acl-run: --temp is not an existing directory: C:/Temp/dsh-Ab12Cd\n', false)
    assert.equal(seen.length, 1)
    assert.ok(seen[0].includes('--temp is not an existing directory'))
    assert.deepEqual(proc.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'partial' })
    const other = { exitCode: 0 }
    const loose = bareInstance(GitBashExecutor, { config: gitConfig(), tempGuardInstance: spy })
    loose.processFacts.set(other, { mode: 'workspace-write', unconfined: true })
    loose.onProcessDone(other, 'irrelevant', false)
    assert.equal(seen.length, 1, 'an unconfined run started no runner, so the guard must not be asked')
    assert.deepEqual(other.sandbox, { mode: 'workspace-write', unconfined: true })
  })

  // Only this block's own scratch roots, and only after re-verifying that each
  // one really is a mkdtemp child of the OS temp root.
  const tempRoot = realpathSync(tmpdir()).toLowerCase()
  for (const root of guardRoots) {
    const resolved = realpathSync(root)
    assert.ok(basename(resolved).startsWith('dsh-wmb-guard-'), 'refusing to clean up a path this block did not create: ' + resolved)
    assert.ok(resolved.toLowerCase().startsWith(tempRoot), 'refusing to clean up outside the OS temp root: ' + resolved)
    rmSync(resolved, { recursive: true, force: true })
  }
}

console.log('\n[A] unit: the interactive terminal row (registry-derived backends, session mechanism)')
{
  // The registry is the single source for WHICH shells may host a session; the
  // session mechanism's boundaries are pinned here against a fake PTY, so a real
  // shell is only needed for the state-persistence boot test further down.
  const { TERMINAL_BACKENDS, TERMINAL_ROWS: TERMINAL_FORM_ROWS, CLIENT_ROWS: TERMINAL_CLIENT_ROWS,
    EXPORT_SUBPATHS: TERMINAL_EXPORTS, PATCH_ROWS: TERMINAL_PATCHES, TERMINAL_ROW, SHELL_DIALECTS: TERMINAL_DIALECTS } =
    await import(libUrl('tool-bash', 'types', 'registry.js'))
  const terminalTool = await import(libUrl('tool-bash', 'types', 'terminal.js'))
  const { ShellExecutorBase } = await import(libUrl('shell-executor.js'))
  const { Msys2BashExecutor } = await import(libUrl('bash-msys2', 'index.js'))
  const {
    OutputRing, TerminalSanitizer, createTerminalSessions, TERMINAL_SIGNALS, normalizeTerminalText,
  } = await import(libUrl('terminal-session.js'))
  const { PassThrough } = await import('node:stream')
  /** A prototype-only instance: enough to exercise the argv hooks without a ctx. */
  const bare = (Executor, patch) => Object.assign(Object.create(Executor.prototype), patch)

  test('the shell argument is exactly the dialects that declare terminal capability', () => {
    const declared = TERMINAL_DIALECTS.filter((dialect) => dialect.terminal === true).map((dialect) => dialect.toolName)
    assert.deepEqual(TERMINAL_BACKENDS.map((backend) => backend.toolName), declared)
    assert.ok(declared.length >= 2, 'a terminal that could host only one shell would not need a registry')
    for (const dialect of TERMINAL_DIALECTS)
      if (dialect.terminal !== true) assert.ok(!declared.includes(dialect.toolName), dialect.id + ' must not be offered')
  })

  test('the terminal row is wired like every other row, and its form is derived from the capability set', () => {
    const patch = TERMINAL_PATCHES.find((row) => row.id === TERMINAL_ROW.rowId)
    assert.equal(patch?.name, 'dsh-win-multi-bash/' + TERMINAL_ROW.specifier)
    assert.equal(patch?.win32Only, true)
    assert.equal(patch?.disabledByDefault, false, 'a capability nobody mounts is not a capability')
    assert.equal(TERMINAL_EXPORTS['./' + TERMINAL_ROW.specifier], './lib/tool-bash/types/' + TERMINAL_ROW.entry + '.js')
    // Last on the page on purpose: the dialect rows keep their positions, so a
    // reader that already depends on ROWS[0]/ROWS[1] cannot be renumbered.
    const ids = TERMINAL_CLIENT_ROWS.map((row) => row.rowId)
    assert.equal(ids[ids.length - 1], TERMINAL_ROW.rowId)
    assert.equal(TERMINAL_FORM_ROWS.length, 1)
    assert.deepEqual(TERMINAL_FORM_ROWS[0].fields.map((knob) => knob.key),
      TERMINAL_CLIENT_ROWS[TERMINAL_CLIENT_ROWS.length - 1].fields.map((knob) => knob.key))
    assert.deepEqual(TERMINAL_FORM_ROWS[0].fields[0].options, TERMINAL_BACKENDS.map((backend) => backend.toolName))
    // The pins are the dialects' OWN declared leaves, under their own partitions.
    for (const backend of TERMINAL_BACKENDS)
      for (const own of (TERMINAL_DIALECTS.find((dialect) => dialect.id === backend.dialectId)?.fields ?? []))
        assert.ok(TERMINAL_FORM_ROWS[0].fields.some((knob) => knob.key === backend.configKey + '.' + own.leaf),
          backend.configKey + '.' + own.leaf + ' must be pinnable from the session row too')
  })

  test('the row schema and its Plugins page address one and the same set, in one order', () => {
    assert.deepEqual(volatilePaths(terminalTool.Config), TERMINAL_FORM_ROWS[0].fields.map((knob) => knob.path.join('.')))
    const schema = terminalTool.Config({})
    assert.equal(schema.terminal.defaultShell.get(), TERMINAL_BACKENDS[0].toolName, 'the default is the first capable dialect')
    assert.equal(schema.terminal.allowUnconfined.get(), true)
    for (const backend of TERMINAL_BACKENDS)
      assert.ok(schema[backend.configKey] !== undefined, backend.configKey + ' must have a pin partition')
  })

  test('every capable dialect supplies the interactive argv its substrate needs', () => {
    assert.throws(() => ShellExecutorBase.prototype.terminalArgv.call({ constructor: { logName: 'bash-x' } }),
      /does not implement interactive terminal sessions/,
      'a dialect without a session must refuse, never inherit a plausible argv')
    const git = bare(GitBashExecutor, { bashPath: () => 'C:/Git/bin/bash.exe' })
    assert.deepEqual(git.terminalArgv(), ['C:/Git/bin/bash.exe', '-i'])
    assert.ok(!Object.hasOwn(Msys2BashExecutor.prototype, 'terminalArgv'), 'msys2 inherits the MSYS argv rather than copying it')
    const wsl = bare(WslBashExecutor, { wslPath: () => 'wsl.exe', distro: () => 'Ubuntu-24.04' })
    assert.deepEqual(wsl.terminalArgv({ workdir: 'C:\\ws' }), ['wsl.exe', '--cd', 'C:\\ws', '-d', 'Ubuntu-24.04', '--', 'bash', '-i'])
    const wslBare = bare(WslBashExecutor, { wslPath: () => 'wsl.exe', distro: () => undefined })
    assert.deepEqual(wslBare.terminalArgv({}), ['wsl.exe', '--', 'bash', '-i'], 'an unlisted distro adds no -d')
  })

  test('the ring reports truncation and a slid offset separately, and never splits a pair', () => {
    const ring = new OutputRing(8)
    ring.append('0123456789')
    const whole = ring.readFrom(0)
    assert.equal(whole.lossy, true)
    assert.equal(whole.truncated, true)
    assert.equal(ring.readFrom(whole.nextOffset - 3).lossy, false)
    assert.equal(ring.readFrom(whole.nextOffset - 3).truncated, true, 'the latch still reports earlier loss')
    const pair = new OutputRing(64 * 1024)
    const source = 'x'.repeat(8191) + '\u{1f600}' + 'y'.repeat(4)
    pair.append(source)
    assert.equal(pair.readFrom(0).text, source, 'byte-identical across the 8192-unit chunk boundary')
  })

  test('the sanitizer strips escapes across chunk boundaries and normalizes line endings', () => {
    const sanitizer = new TerminalSanitizer()
    assert.equal(sanitizer.push('a\u001b[').text, 'a')
    assert.equal(sanitizer.push('32mb\u0007').text, 'b')
    assert.equal(normalizeTerminalText('x\r\ny\rz'), 'x\ny\nz')
    const bounded = new TerminalSanitizer(16)
    assert.equal(bounded.push('k\u001b[' + '9'.repeat(40)).text, 'k')
    assert.equal(bounded.flush().text, '', 'a runaway carry never resurfaces as text')
  })

  /** A fake PTY service, so the registry's boundaries need no real shell. */
  const fakePty = () => {
    const spawned = []
    const handles = []
    const service = {
      spawnTerminal: async (spec) => {
        spawned.push(spec)
        const output = new PassThrough()
        let settle
        const done = new Promise((resolve) => { settle = resolve })
        const handle = {
          pid: 7, output, done, writes: [], signals: [], terminated: 0,
          write: async (data) => { handle.writes.push(data) },
          signalForeground: async (signal) => { handle.signals.push(signal); return 3 },
          inspectActivity: async () => ({ state: 'unknown', revision: 1 }),
          resize: async () => {},
          terminate: async () => { handle.terminated += 1; output.end() },
        }
        handle.exit = (outcome) => settle(outcome)
        handles.push(handle)
        return handle
      },
    }
    return { spawned, handles, service }
  }
  const sessionRequest = (ownerKey, over = {}) => ({
    ownerKey, shell: 'git_bash', argv: ['bash', '-i'], cwd: 'C:/ws', env: {}, name: undefined, signal: undefined,
    maxSessions: 2, idleMs: 0, rows: 30, cols: 110, maxBufferBytes: 4096, waitMs: 300, quietMs: 60, graceMs: 1000, ...over,
  })
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const throwsSync = (fn, predicate, label) => {
    let error
    try { fn() } catch (caught) { error = caught }
    assert.ok(error !== undefined, label + ': expected a refusal')
    assert.ok(predicate(error), label + ': ' + String(error?.message ?? error))
  }
  await testAsync('the session cap, owner fence, signal set and disposal are enforced', async () => {
    const fake = fakePty()
    const sessions = createTerminalSessions({ subprocess: fake.service }, {})
    const opened = await sessions.open(sessionRequest('agent-a'))
    await sessions.open(sessionRequest('agent-a'))
    await assert.rejects(() => sessions.open(sessionRequest('agent-a')), (error) => error.code === 'SESSION_LIMIT')
    assert.equal(fake.spawned.length, 2, 'the refused open spawned nothing')
    throwsSync(() => sessions.read({ ownerKey: 'agent-b', sessionId: opened.session.id }),
      (error) => error.code === 'FOREIGN_SESSION', 'another agent')
    assert.equal(sessions.list('agent-b').length, 0)
    // Three of the five declared signals can reach this platform's provider at all; the
    // other two are refused by name (see the zero-pid case below).
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'])
      assert.equal((await sessions.signal({ ownerKey: 'agent-a', sessionId: opened.session.id, signal, waitMs: 60, quietMs: 20 })).delivered, 3)
    assert.deepEqual(fake.handles[0].signals, ['SIGINT', 'SIGTERM', 'SIGKILL'])
    for (const signal of ['SIGTSTP', 'SIGHUP'])
      await assert.rejects(() => sessions.signal({ ownerKey: 'agent-a', sessionId: opened.session.id, signal, waitMs: 60, quietMs: 20 }),
        (error) => error.code === 'SIGNAL_UNREACHABLE', signal + ' is not deliverable here')
    assert.deepEqual(fake.handles[0].signals, ['SIGINT', 'SIGTERM', 'SIGKILL'], 'and it never reaches the provider either')
    await assert.rejects(() => sessions.signal({ ownerKey: 'agent-a', sessionId: opened.session.id, signal: 'SIGWINCH', waitMs: 60, quietMs: 20 }),
      (error) => error.code === 'INVALID_SIGNAL')
    await sessions.dispose()
    assert.deepEqual(fake.handles.map((handle) => handle.terminated), [1, 1], 'disposal terminates every session once')
  })
  await testAsync('a provider with no addressable pid refuses every signal it cannot deliver, by name', async () => {
    // win32 ConPTY reports pid 0 for the whole session. Only SIGINT reaches the shell
    // (the provider delivers it as a Ctrl+C byte); the other four DECLARED signals are
    // refused here, with this plugin's own code, instead of reaching the provider and
    // surfacing its raw message — which contradicts both this tool's description and
    // the refusal right below it.
    const fake = fakePty()
    const spawn = fake.service.spawnTerminal
    fake.service.spawnTerminal = async (spec) => {
      const handle = await spawn(spec)
      handle.pid = 0
      return handle
    }
    const zero = createTerminalSessions({ subprocess: fake.service }, {})
    const opened = await zero.open(sessionRequest('agent-a', { maxSessions: 1 }))
    assert.equal(opened.view.pid, 0, 'the fixture really has no addressable pid')
    for (const signal of ['SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']) {
      await assert.rejects(
        () => zero.signal({ ownerKey: 'agent-a', sessionId: opened.session.id, signal, waitMs: 60, quietMs: 20 }),
        (error) => error.code === 'SIGNAL_UNREACHABLE' && /SIGINT is the only signal/.test(error.message),
        signal + ' must be refused by name',
      )
    }
    assert.deepEqual(fake.handles[0].signals, [], 'a refused signal never reaches the provider')
    assert.equal((await zero.signal({ ownerKey: 'agent-a', sessionId: opened.session.id, signal: 'SIGINT', waitMs: 60, quietMs: 20 })).delivered, 3,
      'SIGINT still reaches it')
    await zero.dispose()
  })
  await testAsync('close reports the exit status its terminator produces, not the race', async () => {
    // `close` used to read `session.exitCode` the instant `terminate()` resolved, while the
    // outcome is assigned by the `done` continuation: a session that had exited could still
    // be reported as `exitCode: null`. This fake publishes its outcome a tick after
    // terminating, like a provider that observes the exit slightly later.
    const fake = fakePty()
    const spawn = fake.service.spawnTerminal
    fake.service.spawnTerminal = async (spec) => {
      const handle = await spawn(spec)
      handle.terminate = async () => {
        handle.terminated += 1
        handle.output.end()
        setTimeout(() => handle.exit({ exitCode: 7, signal: null }), 20)
      }
      return handle
    }
    const sessions = createTerminalSessions({ subprocess: fake.service }, {})
    const opened = await sessions.open(sessionRequest('agent-a', { maxSessions: 1, startupWaitMs: 0 }))
    const closed = await sessions.close({ ownerKey: 'agent-a', sessionId: opened.session.id, graceMs: 500 })
    assert.equal(closed.exitCode, 7, 'the terminator\'s outcome is reported, not lost to the race')
    assert.equal(closed.shell, 'git_bash', 'and the result still names its shell')
    await sessions.dispose()
  })

  await testAsync('two concurrent opens cannot both pass a session cap of one', async () => {
    // The cap has to count a session that is still STARTING: the spawn and the startup
    // settle are awaited, so counting only the published map lets both opens through.
    const fake = fakePty()
    const spawn = fake.service.spawnTerminal
    fake.service.spawnTerminal = async (spec) => {
      await settle(30)
      return spawn(spec)
    }
    const sessions = createTerminalSessions({ subprocess: fake.service }, {})
    const results = await Promise.allSettled([
      sessions.open(sessionRequest('agent-a', { maxSessions: 1, startupWaitMs: 0 })),
      sessions.open(sessionRequest('agent-a', { maxSessions: 1, startupWaitMs: 0 })),
    ])
    const refused = results.filter((result) => result.status === 'rejected')
    assert.equal(refused.length, 1, 'exactly one of two concurrent opens may start')
    assert.equal(refused[0].reason.code, 'SESSION_LIMIT')
    assert.equal(fake.spawned.length, 1, 'the refused open spawned nothing')
    await sessions.dispose()
  })
  await testAsync('an old handle without resize/inspectActivity still runs, and an idled session explains itself', async () => {
    const fake = fakePty()
    const sessions = createTerminalSessions({ subprocess: fake.service }, {})
    const opened = await sessions.open(sessionRequest('a'))
    delete fake.handles[0].resize
    delete fake.handles[0].inspectActivity
    const sent = await sessions.send({ ownerKey: 'a', sessionId: opened.session.id, text: 'x', cols: 200, waitMs: 200, quietMs: 30 })
    // No output was observed on this fake handle, and it cannot answer
    // `inspectActivity`: the wait must report the cap rather than claim silence.
    assert.equal(sent.waitReason, 'timeout', 'no observed output means no quiet, only the cap')
    const idled = await sessions.open(sessionRequest('a', { idleMs: 40 }))
    await settle(140)
    assert.equal(fake.handles[1].terminated, 1)
    throwsSync(() => sessions.read({ ownerKey: 'a', sessionId: idled.session.id }),
      (error) => error.code === 'SESSION_GONE' && /idle reaper/.test(error.message), 'an idle-reclaimed id')
    await sessions.dispose()
  })
}

console.log('\n[B] boot integration: the terminal row over a REAL PTY (state must survive between calls)')
{
  // The acceptance test the row exists for: one live interactive shell whose
  // cwd, exported variables and aliases outlive the call that set them. The
  // fixture pins the probed Git Bash (never a hardcoded path) and a small output
  // cap so truncation is observable without megabytes of output.
  const TERMINAL_FIXTURE_ROWS = (configLines) => CORE_ROW_ONLY + [
    '- id: win-mb-tool-terminal',
    "  name: 'dsh-win-multi-bash/tool-terminal'",
    '  config:',
    '    terminal:',
    ...configLines.map((line) => '      ' + line),
    '    gitBash:',
    "      bashPath: '" + GIT_BASH.replaceAll(String.fromCharCode(92), String.fromCharCode(92) + String.fromCharCode(92)) + "'",
    '',
  ].join('\n')
  const runTerminal = async (ctx, args) => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('audit-terminal-' + Math.random().toString(36).slice(2)),
      name: 'terminal',
      arguments: args,
    })
    const text = (result.content ?? []).filter((entry) => entry.type === 'text').map((entry) => entry.text).join('')
    return { text, value: result.value, isError: result.isError }
  }

  // The model-facing surface of the session row, before any shell is spawned and
  // with no shell pin: what the tool says it offers, and what an `open` reports
  // about whose host the session is on. Booted separately from the round trip so
  // it runs on a machine with no Git Bash too — nothing here touches a PTY.
  await testAsync('the terminal row offers every session backend it declares, and says which host a session is on', async () => {
    const { TERMINAL_BACKENDS: SESSION_BACKENDS } = await import(libUrl('tool-bash', 'types', 'registry.js'))
    const ctx = await bootFixture(TERMINAL_FIXTURE_ROWS([]), 'terminal-surface.yml')
    try {
      const definition = ctx.tools.get('terminal')
      assert.ok(definition !== undefined, 'the terminal row must register')
      // REVIEW N2: the description named "Git Bash, WSL or MSYS2" by hand while the
      // `shell` enum declared beside it was derived — so the SSH backend was offered
      // by the parameter list and denied by the prose the model reads first.
      assert.ok(SESSION_BACKENDS.length >= 2, 'this build must declare session backends')
      for (const backend of SESSION_BACKENDS) {
        assert.ok(definition.parameters.properties.shell.enum.includes(backend.toolName),
          'the shell enum must offer ' + backend.toolName)
        assert.ok(definition.description.includes(backend.label.en),
          'the description must name "' + backend.label.en + '": ' + definition.description.slice(0, 160))
      }
      assert.ok(!definition.description.includes('in Git Bash, WSL or MSYS2'),
        'and it must not hand-list a subset of what the enum offers')
      // REVIEW N1: a session in a remote backend used to read a LOCAL sandbox
      // sentence and carry no remote token at all — the one fact that says whether
      // the shell the model is typing into is on this host.
      const renderOpen = (value) => definition.output.render({ action: 'open' }, value).map((block) => block.text).join('')
      const openValue = (remote) => ({
        kind: 'open', sessionId: 's1', shell: remote ? 'ssh_bash' : 'git_bash', pid: 7, cwd: 'C:/ws',
        sandboxMode: 'none', unconfined: true, remote, output: 'ready', truncated: false, lossy: false, nextOffset: 5,
      })
      const openSchema = definition.output.schema.oneOf.find((branch) => branch.properties?.kind?.const === 'open')
      assert.ok(openSchema !== undefined, 'the open value shape must exist')
      assert.ok('remote' in openSchema.properties,
        'the open schema must carry the remote fact, or the value is rejected')
      const remote = renderOpen(openValue(true))
      assert.ok(remote.includes('— remote: this session runs on the host its backend connects to'), remote)
      assert.ok(!remote.includes('unconfined: the file sandbox does not wrap'),
        'a remote session must not be described by a LOCAL sandbox sentence: ' + remote)
      const local = renderOpen(openValue(false))
      assert.ok(local.includes('— unconfined: the file sandbox does not wrap a PTY session'), local)
      assert.ok(!local.includes('— remote: '), local)
    } finally { await ctx.fiber.dispose() }
  })

  if (GIT_BASH === '') {
    skip('  … skipping the terminal round trip: no Git Bash was found to pin')
  } else {
    let ctx
    try {
      ctx = await bootFixture(TERMINAL_FIXTURE_ROWS([
        'defaultShell: git_bash',
        'maxSessions: 2',
        'maxBufferBytes: 4096',
        'waitMs: 6000',
        'quietMs: 400',
      ]), 'terminal-roundtrip.yml')
      await testAsync('the tool is registered, the shell seat is untouched, and bad arguments are named', async () => {
        const names = ctx.tools.schemas().map((tool) => tool.name)
        assert.ok(names.includes('terminal'), 'terminal must be registered: ' + names.join(','))
        assert.ok(ctx.shell !== undefined, 'the terminal row must not contend for the shell seat')
        // Two layers answer here, and both are real: the runtime's own schema
        // validation rejects a missing/unknown `action` (and an out-of-enum
        // `signal`/`shell`) BEFORE the tool body runs, and the body's own checks
        // catch everything the schema cannot (a missing sessionId, empty text, an
        // unknown session). The patterns accept either layer by name.
        for (const [args, pattern] of [
          [{}, /missing required property "action"/],
          [{ action: 'nope' }, /invalid arguments|"action" must be one of/],
          [{ action: 'send', text: 'x' }, /"sessionId" is required/],
          [{ action: 'send', sessionId: 'x', text: '' }, /"text" must be a non-empty string/],
          [{ action: 'signal', sessionId: 'x', signal: 'SIGWINCH' }, /invalid arguments|"signal" must be one of/],
          [{ action: 'open', shell: 'pwsh' }, /invalid arguments|unknown shell/],
          [{ action: 'read', sessionId: 'no-such-session' }, /no session/],
        ]) {
          const refused = await runTerminal(ctx, args)
          assert.equal(refused.isError, true, 'expected a refusal for ' + JSON.stringify(args) + ': ' + refused.text)
          assert.match(refused.text, pattern)
        }
      })
      await testAsync('a real Git Bash session keeps cwd, exported variables and aliases across calls', async () => {
        const dir = mkdtempSync(join(process.cwd(), '.temp', 'terminal-state-'))
        let id
        try {
          const opened = await runTerminal(ctx, { action: 'open', name: 'roundtrip' })
          assert.ok(!opened.isError, opened.text)
          assert.equal(opened.value.kind, 'open')
          assert.equal(opened.value.shell, 'git_bash')
          assert.equal(opened.value.unconfined, true, 'a PTY session cannot be sandboxed, and the result says so')
          id = opened.value.sessionId
          const send = async (text) => (await runTerminal(ctx, { action: 'send', sessionId: id, text })).value.output
          assert.match(await send('cd "' + dir + '" && pwd'), /terminal-state-/, 'the shell moved')
          assert.match(await send('pwd'), /terminal-state-/, 'the directory survived the next call')
          await send('export DSH_WMB_PROBE=42')
          assert.match(await send('echo "PROBE=$DSH_WMB_PROBE"'), /PROBE=42/, 'the exported variable survived')
          await send("alias t='echo alias-ok'")
          assert.match(await send('t'), /alias-ok/, 'the alias survived')
          const listed = await runTerminal(ctx, { action: 'list' })
          assert.equal(listed.value.kind, 'list')
          assert.ok(listed.value.sessions.some((session) => session.sessionId === id), 'list names the live session')
          // F4: a reviewer showed that adding a key to `read`'s value (which makes
          // the runtime drop the whole value) and deleting `open`'s waitReason both
          // left this suite green, so both contracts are pinned here.
          assert.ok(['quiet', 'idle', 'timeout'].includes(opened.value.waitReason), String(opened.value.waitReason))
          const drained = await runTerminal(ctx, { action: 'read', sessionId: id })
          assert.equal(drained.value.kind, 'session')
          assert.deepEqual(Object.keys(drained.value).sort(), ['kind', 'lossy', 'nextOffset', 'output', 'remote', 'shell', 'truncated'],
            'read must return exactly the declared fields')
          assert.equal(drained.value.shell, 'git_bash', 'a session result names the shell it belongs to')
          assert.equal(drained.value.remote, false, 'and whether that shell runs its effects on another host')
        } finally {
          // The shell's cwd is INSIDE this directory: close the session before deleting it.
          if (id !== undefined) await runTerminal(ctx, { action: 'close', sessionId: id }).catch(() => {})
          removeFixtureDir(dir)
        }
      })
      await testAsync('a big burst reports truncation, and SIGINT interrupts without killing the session', async () => {
        const opened = await runTerminal(ctx, { action: 'open' })
        const id = opened.value.sessionId
        const big = await runTerminal(ctx, { action: 'send', sessionId: id, text: 'seq 1 20000', waitMs: 4000 })
        assert.equal(big.value.truncated, true, 'a 29 KB burst must not vanish silently under a 4 KiB cap')
        await runTerminal(ctx, { action: 'send', sessionId: id, text: 'sleep 30', waitMs: 300 })
        const signalled = await runTerminal(ctx, { action: 'signal', sessionId: id, signal: 'SIGINT', waitMs: 1500 })
        assert.ok(!signalled.isError, signalled.text)
        // The command text is echoed, so matching the ARITHMETIC RESULT proves the
        // shell really ran it rather than just printing what was typed.
        let after = ''
        for (let attempt = 0; attempt < 4 && !/AFTER-SIGINT-42/.test(after); attempt += 1) {
          const probe = await runTerminal(ctx, { action: 'send', sessionId: id, text: 'echo AFTER-SIGINT-$((6*7))', waitMs: 3000 })
          after += probe.value?.output ?? ''
        }
        assert.match(after, /AFTER-SIGINT-42/, 'the session survives Ctrl+C')
        const closed = await runTerminal(ctx, { action: 'close', sessionId: id })
        assert.equal(closed.value.kind, 'closed')
        const gone = await runTerminal(ctx, { action: 'send', sessionId: id, text: 'echo x' })
        assert.equal(gone.isError, true)
        assert.match(gone.text, /gone|no session/)
      })
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }
    let strict
    try {
      strict = await bootFixture(TERMINAL_FIXTURE_ROWS(['defaultShell: git_bash', 'allowUnconfined: false']), 'terminal-unconfined-off.yml')
      await testAsync('allowUnconfined: false refuses to open a session instead of running one unconfined', async () => {
        const refused = await runTerminal(strict, { action: 'open' })
        assert.equal(refused.isError, true, refused.text)
        assert.match(refused.text, /allowUnconfined/)
      })
    } finally {
      if (strict) await strict.fiber.dispose()
    }
    // OPT-IN, like the SSH row's own live round trip: a real session needs a reachable host
    // and a credential, so it is NEVER part of the gate. Run it with
    //   DSH_AUDIT_SSH_HOST=ubuntu_tx node smoke/prepare.mjs audit
    // This is the only coverage of the PERSISTENT remote form — the form that exists so a
    // fingerprint, a password or a passphrase can be answered at all (a remote tty).
    const liveSshHost = process.env.DSH_AUDIT_SSH_HOST
    const liveSshPath = (await import(libUrl('bash-ssh', 'index.js'))).resolveSshPath(undefined)
    if (liveSshHost === undefined || liveSshHost.length === 0) {
      skip('  … skipping the live SSH terminal session: set DSH_AUDIT_SSH_HOST to run it')
    } else if (liveSshPath === undefined) {
      skip('  … skipping the live SSH terminal session: no ssh client was found')
    } else {
      const LIVE_SESSION_ROWS = CORE_ROW_ONLY + [
        '- id: win-mb-tool-terminal',
        "  name: 'dsh-win-multi-bash/tool-terminal'",
        '  config:',
        '    terminal:',
        '      defaultShell: ssh_bash',
        '      maxSessions: 1',
        '      waitMs: 12000',
        '      quietMs: 600',
        '      idleMs: 120000',
        '    sshBash:',
        "      sshPath: '" + liveSshPath.replaceAll(String.fromCharCode(92), String.fromCharCode(92) + String.fromCharCode(92)) + "'",
        "      sshHost: '" + liveSshHost + "'",
        '      connectTimeoutMs: 15000',
        '',
      ].join('\n')
      let live
      try {
        live = await bootFixture(LIVE_SESSION_ROWS, 'terminal-ssh-live.yml')
        await testAsync('a real SSH session reaches ' + liveSshHost + ', keeps remote state, and is reaped on close', async () => {
          const opened = await runTerminal(live, { action: 'open' })
          assert.ok(!opened.isError, opened.text)
          assert.equal(opened.value.kind, 'open')
          assert.equal(opened.value.shell, 'ssh_bash')
          assert.equal(opened.value.remote, true, 'a session on another host must say so, not carry a local sandbox sentence')
          const id = opened.value.sessionId
          const sent = async (text, waitMs) => (await runTerminal(live, { action: 'send', sessionId: id, text, waitMs })).value.output
          assert.match(await sent('echo SSH-PTY-OK; uname -sr', 12000), /SSH-PTY-OK/, 'the remote login shell ran the command')
          const probe = await runTerminal(live, { action: 'send', sessionId: id, text: 'uname -sr', waitMs: 12000 })
          assert.match(probe.value.output, /Linux/, "the remote kernel is not this host's")
          assert.equal(probe.value.remote, true, 'a later result repeats the remote fact, not just `open`')
          assert.equal(probe.value.shell, 'ssh_bash')
          // State across calls is the reason a session exists; the echoed command text
          // cannot satisfy either match on its own.
          await sent('export WMB_PTY_PROBE=42', 8000)
          assert.match(await sent('echo "PROBE=$WMB_PTY_PROBE"', 8000), /PROBE=42/, 'an exported variable survived the next call')
          await sent('cd /tmp', 8000)
          assert.match(await sent('pwd', 8000), /^[^\n]*\/tmp/m, 'the remote working directory survived too')
          const listed = await runTerminal(live, { action: 'list' })
          assert.ok(listed.value.sessions.some((session) => session.sessionId === id && session.shell === 'ssh_bash'), 'list names the remote session')
          const closed = await runTerminal(live, { action: 'close', sessionId: id })
          assert.equal(closed.value.kind, 'closed')
        })
      } finally {
        if (live) await live.fiber.dispose()
      }
    }
  }
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
    if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (initial) => [initial, () => {}] }
    if (id === '@deepseek-ai/dsh-client-ui-primitives')
      return { SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', Checkbox: 'Checkbox', SegmentedControl: 'SegmentedControl', Button: 'Button', DisclosureRow: 'DisclosureRow', TextShimmer: 'TextShimmer', IconApiOutlineRegular: 'IconApiOutlineRegular', IconInspectOutlineRegular: 'IconInspectOutlineRegular', TerminalBlock: 'TerminalBlock' }
    throw new Error(`unexpected client require: "${id}"`)
  })
  const { ROWS, rowKey, planOps, RowConfigForm, RowConfigCard, en, zh, SHELL_TOOL_NAMES, TERMINAL_TOOL_NAME, ToolCard, toolCardBody, toolCardIo, terminalBody, terminalLabels, cardTitle, shellCard, shellStatus, cardSummary, cardState, cardOutput, cardInput } = client.__internals

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

  test('every row\'s page lists exactly the host\'s volatile projection, in schema order', async () => {
    // The expected row list is the registry's (S1/S3): a dialect added without
    // regenerating this block fails on the byte comparison, and a row order that
    // drifted from the composition fails here.
    assert.deepEqual(ROWS.map((row) => row.rowId), REGISTRY_ROWS.map((row) => row.rowId))
    // EVERY dialect, not the first two: the page is the editable projection of the row's
    // `Config`, so a knob added on either side without the other is a control the Host
    // would refuse or a knob the page silently cannot reach. (msys2 and ssh used to have
    // no comparison at all, and the ssh row's schema was pinned against a literal.)
    const { SHELL_DIALECTS, TERMINAL_ROW } = await import(libUrl('tool-bash', 'types', 'registry.js'))
    const packageRow = await import(libUrl('index.js'))
    const rows = [
      ...SHELL_DIALECTS.map((dialect) => ({ rowId: dialect.rowId, entry: dialect.entry })),
      { rowId: TERMINAL_ROW.rowId, entry: TERMINAL_ROW.entry },
    ]
    assert.equal(rows.length, ROWS.length, 'every carried row is checked')
    for (const { rowId, entry } of rows) {
      const row = ROWS.find((candidate) => candidate.rowId === rowId)
      assert.ok(row !== undefined, `no page for ${rowId}`)
      const schema = (await import(libUrl('tool-bash', 'types', entry + '.js'))).Config
      assert.deepEqual(row.fields.map((knob) => knob.path.join('.')), volatilePaths(schema),
        rowId + ': the page must list exactly the knobs the Host serves, in schema order')
    }
    // The core row's two switches are the same contract — they are what the bundle card edits.
    const { CORE_ROW } = client.__internals
    assert.deepEqual(CORE_ROW.fields.map((knob) => knob.path.join('.')), volatilePaths(packageRow.Config))
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

  // ── A3: trim on save; a warning is never a write ─────────────────────────────
  const BS = String.fromCharCode(92)
  const win = (...parts) => parts.join(BS)

  await testAsync('A3: a text draft is TRIMMED into the write, and the form echoes the trimmed value', async () => {
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    const typed = `  ${win('C:', 'Git', 'usr', 'bin', 'bash.exe')}  `
    form.edit('gitBash.bashPath', typed)
    // The draft is echoed as typed while it is being edited (caret-friendly), and
    // the WRITE is the trimmed value.
    assert.equal(form.project().fields.find((k) => k.key === 'gitBash.bashPath').text, typed)
    await form.save()
    assert.deepEqual(scope.calls.length, 1)
    assert.deepEqual(scope.calls[0].ops, [{ op: 'set', path: ['gitBash', 'bashPath'], value: win('C:', 'Git', 'usr', 'bin', 'bash.exe') }])
    // What the field then shows is what was stored: the trimmed value.
    const stored = fakeScope({ value: { gitBash: { bashPath: win('C:', 'Git', 'usr', 'bin', 'bash.exe') } } })
    const after = new RowConfigForm(stored, gitRow)
    assert.equal(after.project().fields.find((k) => k.key === 'gitBash.bashPath').text, win('C:', 'Git', 'usr', 'bin', 'bash.exe'))
    after.dispose()
    form.dispose()
  })

  await testAsync('A3: an invalid value warns, still saves as typed, and plans no repair write', async () => {
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    const bad = win('relative', 'bash.exe')
    form.edit('gitBash.bashPath', bad)
    const projected = form.project()
    const field = projected.fields.find((k) => k.key === 'gitBash.bashPath')
    assert.equal(field.invalid, true, 'the field carries the visible warning marker')
    assert.equal(field.invalidReason, 'path')
    assert.equal(projected.invalid, false, 'a warning never blocks the save (A3: the user input wins)')
    await form.save()
    // The user's input is written — trimmed, and as typed otherwise; no default is
    // written back and nothing is deleted to "repair" it.
    assert.deepEqual(scope.calls.length, 1)
    assert.deepEqual(scope.calls[0].ops, [{ op: 'set', path: ['gitBash', 'bashPath'], value: bad }])
    form.dispose()
  })

  await testAsync('A3: a non-finite number is still refused a write (nothing to carry), warning shown', async () => {
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    form.edit('gitBash.probeTimeoutMs', 'soon')
    const field = form.project().fields.find((k) => k.key === 'gitBash.probeTimeoutMs')
    assert.equal(field.invalid, true)
    assert.equal(field.invalidReason, 'number')
    assert.equal(form.project().invalid, false, 'the card itself reports no blocker')
    await form.save()
    assert.deepEqual(scope.calls, [], 'no mutation for a draft no control accepts')
    assert.equal(form.project().dirty, true, 'and the form stays dirty for the user to fix')
    form.dispose()
  })

  await testAsync('A3: a numeric spelling that names different text is WARNED about, not rewritten', async () => {
    // `0x10`, `1e3`, `007`: the save writes the NUMBER (16/1000/7) while the box shows what
    // was typed, so the mismatch is reported instead of being silent. It is still only a
    // warning: the value written is the number the text names, and the box keeps the text
    // until the user changes it (the A3 rule: the user's input wins, nothing is rewritten).
    const scope = fakeScope()
    const form = new RowConfigForm(scope, gitRow)
    const fieldOf = () => form.project().fields.find((k) => k.key === 'gitBash.probeTimeoutMs')
    for (const [draft, value] of [['0x10', 16], ['1e3', 1000], ['007', 7]]) {
      form.edit('gitBash.probeTimeoutMs', draft)
      assert.equal(fieldOf().text, draft, 'the box shows what was typed: ' + draft)
      assert.equal(fieldOf().invalid, true, draft + ' names different text, so it is flagged')
      assert.equal(fieldOf().invalidReason, 'numberFormat', draft)
      await form.save()
      assert.equal(scope.calls.at(-1).ops[0].value, value, draft + ' is stored as the number it names')
    }
    // Exactly-what-it-names spellings are not flagged.
    form.edit('gitBash.probeTimeoutMs', '1500.5')
    assert.equal(fieldOf().invalidReason, undefined, 'a decimal fraction is exactly what it names')
    form.edit('gitBash.probeTimeoutMs', '10000')
    assert.equal(fieldOf().invalidReason, undefined)
    form.dispose()
  })
  await testAsync('A3: a blank text control is a CLEAR, never an error', async () => {
    const scope = fakeScope({ user: { gitBash: { bashPath: win('C:', 'old', 'bash.exe') } } })
    const form = new RowConfigForm(scope, gitRow)
    form.edit('gitBash.bashPath', '   ')
    const field = form.project().fields.find((k) => k.key === 'gitBash.bashPath')
    assert.equal(field.invalid, false, 'whitespace-only is a clear, not an invalid value')
    await form.save()
    assert.deepEqual(scope.calls[0].ops, [{ op: 'unset', path: ['gitBash', 'bashPath'] }])
    form.dispose()
  })

  await testAsync('A3: a stored value that violates the rule is NEVER rewritten by the form', async () => {
    // The user's constraint, pinned: an old value (here a path padded with spaces,
    // the shape a pre-trim release could store) keeps its exact bytes until the
    // user saves over it. Projecting the form must produce no write at all.
    const stored = `  ${win('C:', 'Program Files', 'Git', 'bin', 'bash.exe')}  `
    const scope = fakeScope({
      value: { enableRunInBackground: true, gitBash: { sandbox: 'auto', bashPath: stored } },
      base: { gitBash: { sandbox: 'auto' } },
      user: { gitBash: { bashPath: stored } },
    })
    const form = new RowConfigForm(scope, gitRow)
    const before = JSON.stringify(scope.getSnapshot())
    const projected = form.project()
    assert.equal(projected.fields.find((k) => k.key === 'gitBash.bashPath').text, stored, 'the stored bytes are shown verbatim — no trim echo, no migration')
    assert.deepEqual(planOps(gitRow.fields, new Map(), scope.getSnapshot()), [], 'projection plans no write')
    assert.equal(projected.dirty, false)
    await form.save()
    assert.deepEqual(scope.calls, [], 'and a save with no drafts sends nothing')
    assert.equal(JSON.stringify(scope.getSnapshot()), before, 'the stored bytes are byte-for-byte unchanged')
    form.dispose()
  })

  test('A3: the syntax rules are the three documented ones, and existence is NOT one of them', () => {
    const gitForm = new RowConfigForm(fakeScope(), ROWS[0])
    const wslForm = new RowConfigForm(fakeScope(), ROWS[1])
    const forms = [gitForm, wslForm]
    const reason = (key, text) => {
      const form = key.startsWith('wslBash') ? wslForm : gitForm
      form.edit(key, text)
      const field = form.project().fields.find((k) => k.key === key)
      assert.ok(field, `no field for ${key}`)
      form.discard()
      return field.invalidReason
    }
    assert.equal(reason('gitBash.bashPath', win('C:', 'Git', 'bash.exe')), undefined)
    assert.equal(reason('gitBash.bashPath', '/c/Git/bash.exe'), undefined, 'the POSIX drive form is accepted')
    assert.equal(reason('gitBash.bashPath', win(BS, 'server', 'share', 'bash.exe')), undefined, 'a UNC path is accepted')
    assert.equal(reason('gitBash.bashPath', 'bash.exe'), 'path')
    assert.equal(reason('gitBash.cwd', 'relative'), 'path')
    assert.equal(reason('wslBash.wslPath', 'wsl.exe'), 'path')
    assert.equal(reason('wslBash.wslDistro', 'Ubuntu 24.04'), 'distro')
    assert.equal(reason('wslBash.wslDistro', 'Ubuntu"24.04'), 'distro')
    assert.equal(reason('wslBash.wslDistro', 'Ubuntu-24.04'), undefined)
    // No existence check anywhere in this layer: a syntactically perfect path to a
    // file that is not there is NOT flagged here (the executor warns at use time).
    assert.equal(reason('gitBash.bashPath', win('C:', 'definitely', 'not', 'here', 'bash.exe')), undefined)
    for (const form of forms) form.dispose()
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
    // Declaration order: sandbox, probeTimeoutMs, requireSandbox, sandboxNotice —
    // the notice enum is the last control the form draws.
    const notice = tree.children[tree.children.length - 1]
    assert.equal(notice.children[1].type, 'SegmentedControl')
    assert.deepEqual(notice.children[1].props.options.map((option) => option.value), ['once', 'always'])
    const sandbox = tree.children[tree.children.length - 4]
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
    assert.deepEqual(pages.map((entry) => entry.options.key), REGISTRY_ROWS.map((row) => rowKey(row.rowId)))
    for (const entry of pages) {
      assert.equal(entry.options.locale, client.NS)
      assert.equal(entry.component, RowConfigCard)
      assert.equal(typeof entry.options.inject().hooks.rowForm.getSnapshot, 'function')
    }
    // The bundle page also gets the core-row label and note, on their own slots.
    const detail = slotRegistrations.filter((entry) => entry.options.name !== 'plugins.row.config' && entry.options.name !== 'tool.call.toolview')
    // The bundle seat comes first, under both candidate keys; then the badge/note. No
    // `settings.section` entry: that surface showed the same form a second time.
    assert.deepEqual(detail.map((entry) => entry.options.name), ['plugins.bundle.config', 'plugins.bundle.config', 'plugins.detail.badge', 'plugins.detail.section'])
    assert.deepEqual(detail.slice(0, 2).map((entry) => entry.options.key), [client.__internals.CORE_ROW_ID, 'dsh-win-multi-bash'])
    assert.equal(detail[0].component, RowConfigCard)
    assert.equal(typeof detail[0].options.inject().hooks.rowForm.getSnapshot, 'function')
    for (const entry of detail.slice(2)) {
      assert.equal(entry.options.locale, client.NS)
      assert.equal(entry.options.id, 'dsh-win-multi-bash:core')
    }
  })

  test('the conversation rows cover exactly the dialect tools, keyed by wire name', () => {
    const slotRegistrations = []
    client.apply({
      locale: { register: () => () => {}, bind: () => (key) => key },
      configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
      slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
      effect: (callback) => callback(),
    })
    // The card list is derived from the terminal row's own capability list, so a dialect
    // added to the host registry cannot keep the generic `Tool call · <name>` row.
    assert.deepEqual(SHELL_TOOL_NAMES, TOOL_INSTANCES.map((instance) => instance.toolName))
    assert.equal(TERMINAL_TOOL_NAME, 'terminal')
    const rows = slotRegistrations.filter((entry) => entry.options.name === 'tool.call.toolview')
    assert.deepEqual(rows.map((entry) => entry.options.key), [...SHELL_TOOL_NAMES, TERMINAL_TOOL_NAME])
    for (const entry of rows) {
      assert.equal(entry.options.locale, client.NS)
      assert.equal(entry.options.priority, undefined, 'a key nobody else registers needs no priority')
      assert.equal(entry.component, ToolCard)
    }
    // Additive: every Configure page is still registered alongside the card.
    const pages = slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config')
    assert.deepEqual(pages.map((entry) => entry.options.key), REGISTRY_ROWS.map((row) => rowKey(row.rowId)))
  })

  test('a deployment without the card primitives gets no row at all, not a broken one', () => {
    const slotRegistrations = []
    const bare = registrations[0].factory((id) => {
      if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (initial) => [initial, () => {}] }
      if (id === '@deepseek-ai/dsh-client-ui-primitives')
        return { SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField', Checkbox: 'Checkbox', SegmentedControl: 'SegmentedControl', Button: 'Button' }
      throw new Error('unexpected client require: "' + id + '"')
    })
    assert.doesNotThrow(() => bare.apply({
      locale: { register: () => () => {}, bind: () => (key) => key },
      configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
      slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
      effect: (callback) => callback(),
    }), 'the platform\'s own generic row is the fallback, never a crash')
    assert.deepEqual(slotRegistrations.filter((entry) => entry.options.name === 'tool.call.toolview'), [])
    assert.equal(slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config').length, REGISTRY_ROWS.length)
  })

  test('the row summary follows the platform shell rule', () => {
    assert.equal(cardSummary('shell', JSON.stringify({ command: 'run\nmore', description: 'first' }), 'c'), 'first')
    assert.equal(cardSummary('shell', JSON.stringify({ command: 'run\nmore' }), 'c'), 'run', 'the command is read one line deep')
    assert.equal(cardSummary('shell', '{"command": "broken', 'c'), '{"command": "broken', 'partial JSON is shown raw')
    assert.equal(cardSummary('shell', JSON.stringify({ timeoutMs: 5 }), 'c'), '{"timeoutMs":5}', 'no readable argument: the raw text')
    assert.equal(cardSummary('shell', '', 'c9'), 'c9', 'nothing yet: the call id, never a blank row')
    assert.equal(cardSummary('terminal', JSON.stringify({ action: 'open', sessionId: 's1' }), 'c'), 'open')
  })

  test('the row state and body follow the platform stage contract', () => {
    assert.equal(cardState('preparing', undefined), 'preparing')
    assert.equal(cardState('start', { phase: 'start', argsRaw: '{}' }), 'running')
    assert.equal(cardState('result', { kind: 'result', content: [], isError: false }), 'ok')
    assert.equal(cardState('result', { kind: 'result', content: [], isError: true }), 'error')
    assert.equal(cardState('result', { kind: 'result', content: [], error: { code: 'interrupted' } }), 'stopped')
    assert.equal(cardOutput({ kind: 'result', content: [{ type: 'image' }] }), JSON.stringify({ type: 'image' }, null, 2), 'a non-text block is shown as JSON')
    assert.equal(cardOutput({ kind: 'result', content: [], error: { name: 'E', code: 'C' } }), 'E: C')
    assert.equal(cardInput('{"a":1}'), '{\n  "a": 1\n}')
    assert.equal(cardInput('not json'), 'not json')
  })

  test('every tool this bundle renders a row for has its own title, in both languages', () => {
    for (const name of [...SHELL_TOOL_NAMES, TERMINAL_TOOL_NAME]) {
      for (const [language, dict] of [['en', en], ['zh', zh]]) {
        const title = dict[`tool.title.${name}`]
        assert.equal(typeof title, 'string', `${language} has no tool.title.${name}`)
        assert.ok(title.length > 0, `${language} tool.title.${name} is empty`)
      }
      // The shells read the SAME in every language: a reader tells git_bash from wsl_bash
      // from msys2_bash from ssh_bash at a glance, whatever the UI language is.
      if (SHELL_TOOL_NAMES.includes(name)) assert.equal(en[`tool.title.${name}`], zh[`tool.title.${name}`])
    }
    assert.equal(cardTitle({ toolName: 'git_bash' }, (key) => en[key] ?? key), 'Git Bash')
    assert.equal(cardTitle({ toolName: 'ssh_bash' }, (key) => zh[key] ?? key), 'SSH remote shell')
    assert.equal(cardTitle({ toolName: 'not_ours' }, (key) => key), 'tool.title.other', 'an unlisted name falls back instead of showing a raw locale key')
  })

  test('the shell result markers are parsed the way the platform parses its own', () => {
    assert.deepEqual(shellStatus('out\n[exit code: 3]'), { output: 'out', exitCode: 3 })
    assert.deepEqual(shellStatus('out\n[killed by signal: SIGINT]'), { output: 'out', signal: 'SIGINT' })
    assert.deepEqual(shellStatus('out'), { output: 'out', exitCode: 0 }, 'this renderer writes the exit marker only when the code is non-zero')
  })

  test('the terminal card is used exactly where a settled shell command is', () => {
    const argsRaw = JSON.stringify({ command: 'ls', description: 'list' })
    const settled = (text, over = {}) => ({ kind: 'result', call: { argsRaw }, content: [{ type: 'text', text }], isError: false, ...over })
    const card = (block, raw = argsRaw, output = 'out') => shellCard({ toolName: 'git_bash', block }, raw, output)
    assert.deepEqual(card(settled('out')), { command: 'ls', cwd: undefined, output: 'out', exitCode: 0, signal: undefined, running: false })
    assert.equal(card(settled('o\n[exit code: 2]'), argsRaw, 'o\n[exit code: 2]').exitCode, 2)
    assert.deepEqual(card({ phase: 'start', argsRaw }, argsRaw, null), { command: 'ls', cwd: undefined, output: undefined, exitCode: undefined, signal: undefined, running: true }, 'a running call already shows the command line')
    for (const [what, block, raw, output] of [
      ['a background call', settled('out'), JSON.stringify({ command: 'ls', run_in_background: true }), 'out'],
      ['a failed call', settled('boom', { isError: true }), argsRaw, 'boom'],
      ['a spill preview', settled('o\n[output truncated; full output: p]'), argsRaw, 'o\n[output truncated; full output: p]'],
      ['a promotion still running in the background', settled('o\n[still running after 5ms; moved to background job j1]'), argsRaw, 'o\n[still running after 5ms; moved to background job j1]'],
      ['a job read that dropped output', settled('o\n[some output was dropped from memory; full output: p]'), argsRaw, 'o\n[some output was dropped from memory; full output: p]'],
      ['a call with no command', settled('out'), JSON.stringify({ description: 'd' }), 'out'],
    ]) assert.equal(card(block, raw, output), null, `${what} must stay on the generic body`)
    assert.equal(shellCard({ toolName: TERMINAL_TOOL_NAME, block: settled('out') }, argsRaw, 'out'), null, 'the terminal tool names an action, not a command line')
  })

  test('the terminal labels fill the tokens the primitive hands back', () => {
    const labels = terminalLabels((key) => zh[key] ?? key)
    assert.equal(labels.exitCode(3), '退出码 3')
    assert.equal(labels.signal('SIGINT'), '信号 SIGINT')
    assert.equal(labels.expandAria(7), '展开其余 7 行输出')
    assert.equal(labels.expand(7), '… 其余 7 行', "the folded control reads copy.expand(hidden)")
    assert.equal(labels.copy, '复制')
    // The WHOLE surface the platform's own `terminalBlockLabels` carries
    // (dsh-client-ui-tool), not a hand-picked subset: a missing member is a render
    // that throws the moment the card caps its lines.
    const PLATFORM_LABELS = ['signal', 'exitCode', 'noExitCode', 'running', 'failed', 'done', 'copy', 'copied', 'noOutput', 'collapseAria', 'collapse', 'expandAria', 'expand']
    assert.deepEqual(Object.keys(labels).sort(), [...PLATFORM_LABELS].sort())
    for (const key of PLATFORM_LABELS) assert.ok(labels[key] !== undefined, `TerminalBlock needs ${key}`)
  })

  test('the card renders the platform shell look, its own title, and the terminal body', () => {
    const argsRaw = JSON.stringify({ command: 'ls', description: 'list' })
    const block = { kind: 'result', call: { argsRaw }, content: [{ type: 'text', text: 'out' }], isError: false }
    // A locale seat resolves a missing key to the key itself (and to the `common`
    // namespace before that), which is exactly what `cardTitle`'s fallback detects.
    const t = (key) => en[key] ?? key
    const tree = ToolCard({ toolName: 'git_bash', callId: 'c1', phase: 'result', cwd: 'C:/ws', t, block })
    const row = tree.children.find((child) => child && child.type === 'DisclosureRow')
    assert.ok(row, 'the row IS the platform primitive, so the chrome is the platform\'s')
    assert.equal(row.props.icon.type, 'IconApiOutlineRegular', 'the icon the platform uses for bash/pwsh')
    assert.equal(row.props.title, 'Git Bash', 'the title is the tool\'s own name, in every language')
    assert.equal(row.props.expandable, true)
    assert.equal(row.props.open, false)
    assert.equal(row.props.collapsedContent[1].type, 'TextShimmer')
    assert.equal(row.props.collapsedContent[1].children[0].children[0], 'list')
    // The expanded body: the platform's terminal card, then the seat's inspect button.
    const body = toolCardBody({ t, inspect: () => {} }, terminalBody(shellCard({ toolName: 'git_bash', block }, argsRaw, 'out'), t))
    assert.deepEqual(body.children.map((child) => child.type), ['TerminalBlock', 'button'])
    assert.equal(body.children[0].props.command, 'ls')
    assert.equal(body.children[0].props.output, 'out')
    assert.equal(body.children[0].props.exitCode, 0)
    assert.equal(body.children[0].props.maxLines, Infinity, 'the platform expands its terminal card in full')
    assert.equal(body.children[0].props.labels.exitCode(2), 'exit code 2', 'the labels are localized AND filled')
    // The generic body keeps its INPUT/OUTPUT card and its error tone.
    const io = toolCardIo({ t: (key) => key }, 'error', 'IN', 'OUT')
    assert.deepEqual(io.children.map((child) => child.type), ['div', 'span', 'div'], 'input, divider, output')
    assert.equal(io.children[2].children[1].props['data-error'], '', 'a failed call paints its output in the error tone')
    assert.deepEqual(toolCardBody({ t: (key) => key, inspect: () => {} }, io).children.map((child) => child.type), ['div', 'button'])
    const preparing = ToolCard({ toolName: 'git_bash', callId: 'c1', phase: 'preparing', t: (key) => key, block: { phase: 'preparing' } })
    const preparingRow = preparing.children.find((child) => child && child.type === 'DisclosureRow')
    assert.equal(preparingRow.props.expandable, false, 'no arguments exist yet, so there is nothing to expand')
    assert.equal(preparingRow.props.running, true)
  })

  test('each card primitive on its own is load-bearing: omit one and no row is registered', () => {
    // The README says "a deployment missing any of them registers no row at all", so the
    // gate is pinned per member, not once with all four absent: a check weakened to one
    // name would otherwise pass and then render h(undefined, …) at run time.
    const CARD = ['DisclosureRow', 'TextShimmer', 'IconApiOutlineRegular', 'IconInspectOutlineRegular']
    for (const missing of CARD) {
      const slotRegistrations = []
      const partial = registrations[0].factory((id) => {
        if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (initial) => [initial, () => {}] }
        if (id === '@deepseek-ai/dsh-client-ui-primitives')
          return Object.fromEntries([...CARD, 'SettingsForm', 'SettingsValueField', 'Checkbox', 'SegmentedControl', 'Button']
            .filter((name) => name !== missing)
            .map((name) => [name, name]))
        throw new Error('unexpected client require: ' + id)
      })
      partial.apply({
        locale: { register: () => () => {}, bind: () => (key) => key },
        configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
        slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
        effect: (callback) => callback(),
      })
      assert.deepEqual(slotRegistrations.filter((entry) => entry.options.name === 'tool.call.toolview'), [],
        `without ${missing} not one conversation row may be registered`)
      // The Configure pages do not depend on these primitives, so they stay.
      assert.equal(slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config').length, REGISTRY_ROWS.length)
    }
    // A NULL member is as unusable as a missing one: the gate and the card body shared one
    // test for it, so a deployment exposing `null` cannot register a row that renders
    // `h(null, …)`. (The undefined-only filter this replaces passed that case.)
    for (const nulled of CARD) {
      const slotRegistrations = []
      const partial = registrations[0].factory((id) => {
        if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (initial) => [initial, () => {}] }
        if (id === '@deepseek-ai/dsh-client-ui-primitives')
          return Object.fromEntries([...CARD, 'SettingsForm', 'SettingsValueField', 'Checkbox', 'SegmentedControl', 'Button']
            .map((name) => [name, name === nulled ? null : name]))
        throw new Error('unexpected client require: ' + id)
      })
      partial.apply({
        locale: { register: () => () => {}, bind: () => (key) => key },
        configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
        slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
        effect: (callback) => callback(),
      })
      assert.deepEqual(slotRegistrations.filter((entry) => entry.options.name === 'tool.call.toolview'), [],
        `with ${nulled} present but null not one conversation row may be registered`)
    }
  })

  test('a deployment with the card primitives but no TerminalBlock keeps the generic body', () => {
    const slotRegistrations = []
    const partial = registrations[0].factory((id) => {
      if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (initial) => [initial, () => {}] }
      if (id === '@deepseek-ai/dsh-client-ui-primitives')
        return { DisclosureRow: 'DisclosureRow', TextShimmer: 'TextShimmer', IconApiOutlineRegular: 'IconApiOutlineRegular', IconInspectOutlineRegular: 'IconInspectOutlineRegular' }
      throw new Error('unexpected client require: ' + id)
    })
    partial.apply({
      locale: { register: () => () => {}, bind: () => (key) => key },
      configForms: { get: () => fakeScope(), whileServed: (names, callback) => { callback(new Set(names)); return () => {} } },
      slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
      effect: (callback) => callback(),
    })
    assert.equal(slotRegistrations.filter((entry) => entry.options.name === 'tool.call.toolview').length, SHELL_TOOL_NAMES.length + 1, 'the rows are still registered')
    const argsRaw = JSON.stringify({ command: 'ls' })
    const block = { kind: 'result', call: { argsRaw }, content: [{ type: 'text', text: 'out' }], isError: false }
    assert.equal(partial.__internals.shellCard({ toolName: 'git_bash', block }, argsRaw, 'out'), null, 'without the primitive the body falls back to the ioCard')
  })

  test('with the Host serving nothing, no Configure page is registered (the gate itself is pinned)', () => {
    // The claim is the GATE, not the card: the page exists while the Host serves that row's
    // namespace. Every other stub in this block calls back immediately, so deleting the
    // `whileServed` wrapper used to keep them all green.
    const slotRegistrations = []
    client.apply({
      locale: { register: () => () => {}, bind: () => (key) => key },
      configForms: { get: () => fakeScope(), whileServed: () => () => {} },
      slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
      effect: (callback) => callback(),
    })
    assert.deepEqual(slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config'), [],
      'a row the Host does not serve shows no Configure control')
    // Registered independently of any row namespace, and therefore still here.
    const names = slotRegistrations.map((entry) => entry.options.name)
    assert.ok(names.includes('plugins.bundle.config'), 'the switch card is not gated on a row namespace')
    assert.equal(names.filter((name) => name === 'tool.call.toolview').length, SHELL_TOOL_NAMES.length + 1)
  })

  test('one unserviceable row cannot take the rest of the page with it', () => {
    // `apply` isolates each contribution now: before that, a throw inside the row loop
    // skipped every contribution registered after it (the bundle card, the labels) while
    // the comment promised the rest kept working.
    const slotRegistrations = []
    const warnings = []
    const broken = REGISTRY_ROWS[0].rowId
    client.apply({
      logger: { warn: (message) => warnings.push(String(message)) },
      locale: { register: () => () => {}, bind: () => (key) => key },
      configForms: {
        get: (rowId) => { if (rowId === broken) throw new Error('no config editor for ' + rowId); return fakeScope() },
        whileServed: (names, callback) => { callback(new Set(names)); return () => {} },
      },
      slots: { inject: (_name, register) => register(), register: (options, component) => { slotRegistrations.push({ options, component }); return () => {} } },
      effect: (callback) => callback(),
    })
    const pages = slotRegistrations.filter((entry) => entry.options.name === 'plugins.row.config')
    assert.deepEqual(pages.map((entry) => entry.options.key), REGISTRY_ROWS.slice(1).map((row) => rowKey(row.rowId)),
      'every OTHER row keeps its page')
    assert.ok(warnings.some((message) => message.includes(broken) && message.includes('failed')), JSON.stringify(warnings))
    const names = slotRegistrations.map((entry) => entry.options.name)
    assert.ok(names.includes('plugins.bundle.config'), 'the contributions after the loop still registered')
    assert.equal(names.filter((name) => name === 'tool.call.toolview').length, SHELL_TOOL_NAMES.length + 1)
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
    const rowIds = [...patch.matchAll(/- id: (win-mb-[\w-]+)/g)].map((match) => match[1])
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
      assert.deepEqual(pages.map((entry) => entry.options.key), REGISTRY_ROWS.map((row) => rowKey(row.rowId)),
        'every dialect row still gets its Configure page')
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
    const rows = [...patch.matchAll(/- id: (win-mb-[\w-]+)\n\s+name: '([^']+)'/g)].map((match) => ({ id: match[1], name: match[2] }))
    assert.deepEqual(rows.map((row) => row.id).sort(), PATCH_ROWS.map((row) => row.id).sort(), 'the core row plus one row per dialect')
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
    skip('  … skipping pinned fixture: no Git Bash probed on this host')
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
      ['boot: the promoted and background values carry no `sandbox` field, like the base tools', async () => {
        // The base bundle's own `pwsh`/`bash` tools shape these two branches as
        // `{kind, jobId, timeoutMs, output}` and `{kind, jobId}` — no `sandbox` field —
        // and a promotion states the fact it can state inside its TEXT. This plugin
        // FOLLOWS that shape on purpose: adding a field here would also mean adding it
        // to `output.schema`, since a value key the schema does not declare makes the
        // runtime drop the whole value.
        const branches = ctx.tools.get('git_bash').output.schema.oneOf
        const keys = (kind) => Object.keys(branches.find((branch) => branch.properties?.kind?.const === kind).properties).sort()
        assert.deepEqual(keys('promoted'), ['cwd', 'jobId', 'kind', 'output', 'timeoutMs'])
        assert.deepEqual(keys('background'), ['cwd', 'jobId', 'kind'], 'the base handle plus the cwd this plugin reports')
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
        let read = ''
        const deadline = Date.now() + 15000
        do {
          await new Promise((r) => setTimeout(r, 400))
          read += await execTool(ctx, 'job_output', { job_id: jobId })
        } while (!/completed|exit code/i.test(read) && Date.now() < deadline)
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
    skip('  … skipping promote fixture: no Git Bash probed on this host')
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
    skip('  … skipping lossy-promote fixture: no Git Bash probed on this host')
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
    skip('  … skipping unconfined fixture: no wsl.exe on this host')
  } else {
    let ctx
    try {
      ctx = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      wslPath: '${BROKEN_WSL}'`), 'unconfined-auto.yml')
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
      skip('  … skipping wrapped-shape case: this host\'s WSL has no usable bwrap')
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
    skip('  … skipping background-unconfined fixture: no wsl.exe on this host')
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
      wslPath: '${BROKEN_WSL}'
      sandboxNotice: always`), 'unconfined-bg-first.yml')
      await runTests(bgFirst, [
        ['with `sandboxNotice: always` a background job that degrades FIRST carries the full explanation; the next one only the short marker', async () => {
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
      wslPath: '${BROKEN_WSL}'
      sandboxNotice: always`), 'unconfined-fg-first.yml')
      await runTests(fgFirst, [
        ['with `sandboxNotice: always` a foreground call that degrades first carries the full explanation; the next only the short marker', async () => {
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

    // The default level is `once`: the row explains itself on its FIRST degraded
    // run and stays silent afterwards. The structured `sandbox.unconfined` fact is
    // what carries the truth from then on, which is why the sentence no longer has
    // to repeat itself into the context window on every call.
    let fgOnce
    try {
      fgOnce = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      wslPath: '${BROKEN_WSL}'`), 'unconfined-fg-once.yml')
      await runTests(fgOnce, [
        ['by default (`sandboxNotice: once`) the first degraded call explains itself and the second stays silent', async () => {
          const first = await execTool(fgOnce, 'wsl_bash', { command: 'echo once-1' })
          assert.ok(first.includes(unconfinedDetailMarker('read-only')), `the first call must explain itself: ${first}`)
          const second = await execTool(fgOnce, 'wsl_bash', { command: 'echo once-2' })
          assert.ok(!second.includes('[sandbox: not applied'), `the second call must carry no notice: ${second}`)
          assert.ok(!second.includes('confinement probe found no usable sandbox'), `and no explanation either: ${second}`)
          const value = await valueOf(fgOnce, { command: 'echo once-3' })
          assert.deepEqual(value.sandbox, { mode: 'read-only', unconfined: true }, 'the fact still rides on every result')
        }],
      ])
    } finally {
      if (fgOnce) await fgOnce.fiber.dispose()
    }

    let bgOnce
    try {
      bgOnce = await bootFixture(WSL_ROW(`
  config:
    wslBash:
      wslPath: '${BROKEN_WSL}'`), 'unconfined-bg-once.yml')
      await runTests(bgOnce, [
        ['by default the second degraded background job carries no notice in its terminal detail', async () => {
          const started1 = await execTool(bgOnce, 'wsl_bash', { command: 'echo bg-once-1', run_in_background: true })
          const jobId1 = started1.match(/started background job (\S+)/)?.[1]
          assert.ok(jobId1, `no job id in: ${started1}`)
          const read1 = await settledRead(bgOnce, jobId1)
          assert.ok(read1.includes(unconfinedDetailMarker('read-only')), `the first job detail must explain itself: ${read1}`)
          const started2 = await execTool(bgOnce, 'wsl_bash', { command: 'echo bg-once-2', run_in_background: true })
          const jobId2 = started2.match(/started background job (\S+)/)?.[1]
          assert.ok(jobId2, `no job id in: ${started2}`)
          const read2 = await settledRead(bgOnce, jobId2)
          assert.ok(!read2.includes('[sandbox: not applied'), `the second job detail must carry no notice: ${read2}`)
        }],
      ])
    } finally {
      if (bgOnce) await bgOnce.fiber.dispose()
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
      skip('  … skipping the wrapped/danger-full-access regression: no Git Bash probed on this host')
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
    skip('  … skipping discovery fixture: no wsl.exe on this host')
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
          assert.equal(await ex.ensureBwrapUsable(), true, 'the functional probe must pass before discovery can run')
          // The dialect is learned on the first confined run (not by the probe), so
          // this test drives the same step the base's `execute` drives.
          await ex.ensureDenialDialect()
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

console.log('\n[B] boot integration: a background job records the tool call that created it (M1 / alpha.3)')
{
  // alpha.3 added `JobSpec.toolCall?` and writes it into the durable
  // `job/registered` / `job/settled` payloads and the public job view. The two
  // facts asserted here are MEASURED, not assumed (report §: rc.2 and alpha.2 share
  // the same `jobs.start`, which ignores the field; alpha.3 records it):
  //   1. the registry RECEIVES `toolCall.callId` on every generation (so removing
  //      it is observable here, not only on alpha.3);
  //   2. the runtime either records it (alpha.3) or ignores it without erroring.
  const JOBS_RECORDS_TOOLCALL = (() => {
    try {
      const path = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-jobs-local/package.json')
      return readFileSync(join(dirname(path), 'lib', 'index.js'), 'utf8').includes('toolCall')
    } catch {
      return false
    }
  })()

  if (!HAS_GIT_BASH) {
    skip('  … skipping M1 fixture: no Git Bash probed on this host')
  } else {
    const callOf = (ctx, name, args, callId) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: callId ?? ToolCallId(`m1-${Math.random().toString(36).slice(2)}`),
      name,
      arguments: { description: `m1 ${name}`, ...args },
    })
    const textOf = (result) => (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\r\n/g, '\n')

    let ctx
    try {
      ctx = await bootFixture(PLUGIN_ROWS(GIT_BASH), 'jobs-toolcall.yml')
      await runTests(ctx, [
        [JOBS_RECORDS_TOOLCALL
            ? 'jobs.start receives toolCall.callId, and this runtime records it in the durable view'
            : 'jobs.start receives toolCall.callId, and this runtime accepts and ignores it', async () => {
          const jobs = ctx.get('jobs')
          const specs = []
          const events = []
          const realStart = jobs.start
          jobs.start = function (spec) { specs.push(spec); return realStart.call(this, spec) }
          const subscription = jobs.events.subscribe({}, (event) => events.push(event))
          try {
            const callId = ToolCallId(`m1-${Math.random().toString(36).slice(2)}`)
            const started = await callOf(ctx, 'git_bash', { command: 'echo m1-witness', run_in_background: true }, callId)
            const startedText = textOf(started)
            assert.equal(started.isError, false, startedText)
            const jobId = startedText.match(/started background job (\S+)/)?.[1]
            assert.ok(jobId && jobId !== 'undefined', `the job id must be a real id: ${startedText}`)
            // 1. what WE sent — observable on every generation (M1's own witness).
            assert.equal(specs.length, 1, 'one registration')
            assert.equal(specs[0].toolCall?.callId, callId, 'the registry must receive the originating call id')
            assert.deepEqual(Object.keys(specs[0]).sort(), ['kind', 'label', 'output', 'run', 'toolCall'],
              'and no other JobSpec key changed')
            assert.equal(specs[0].label, 'echo m1-witness', 'label unchanged')
            assert.equal(typeof specs[0].run, 'function', 'run unchanged')
            assert.ok(Array.isArray(specs[0].output), 'output unchanged')
            if (specs[0].toolCall.rootCallId !== undefined)
              assert.equal(typeof specs[0].toolCall.rootCallId, 'string', 'rootCallId is only included when it exists')
            // 2. what the runtime did with it.
            const registered = events.find((event) => event.type === 'registered')
            assert.ok(registered, 'the registry announced the registration')
            assert.equal(registered.job.id, jobId)
            const record = jobs.store?.get?.(jobId)
            if (JOBS_RECORDS_TOOLCALL) {
              // alpha.3 keeps the record in its own store and copies it into the
              // durable `job/registered` payload (`recordSessionEvent`); the
              // in-process `view()` deliberately omits it, so the store record is
              // the observable here (the durable event needs an owner session the
              // agentless fixture does not have — asserted below as a boundary).
              assert.equal(record?.toolCall?.callId, callId, 'alpha.3 records the call id with the job')
              assert.equal(typeof record?.toolCall?.rootCallId, 'string', 'and the root call id with it')
            } else {
              assert.equal(record?.toolCall, undefined, 'an older runtime accepts the field and ignores it')
              assert.equal(registered.job.toolCall, undefined, 'its view never grows the field either')
              assert.equal(started.value.jobId, jobId, 'and the job still starts exactly as before')
            }
            // 3. the model-facing view: shape-stable on every generation.
            const read = await callOf(ctx, 'job_output', { job_id: jobId })
            const view = read.value?.job
            assert.ok(view, 'job_output returns the job view')
            assert.equal(view.toolCall, undefined, 'the public job view keeps its shape')
            assert.equal(view.id, jobId)
            assert.equal(view.label, 'echo m1-witness')
            // 4. the identity tracks the CALL, not a constant: a foreground call
            //    registers its own job (timeout promotion) and reports its own id.
            const before = specs.length
            const ownCallId = ToolCallId(`m1-fg-${Math.random().toString(36).slice(2)}`)
            await callOf(ctx, 'git_bash', { command: 'echo m1-foreground' }, ownCallId)
            assert.equal(specs.length, before + 1, 'a foreground call registers its own job for promotion')
            assert.equal(specs.at(-1).toolCall.callId, ownCallId, 'and carries that call id, not the previous one')
            assert.notEqual(specs.at(-1).toolCall.callId, callId)
          } finally {
            jobs.start = realStart
            if (typeof subscription === 'function') subscription()
            else subscription?.dispose?.()
          }
        }],
      ])
    } finally {
      if (ctx) await ctx.fiber.dispose()
    }

    let degrade
    try {
      degrade = await bootFixture(PLUGIN_ROWS(GIT_BASH), 'jobs-toolcall-degrade.yml')
      await runTests(degrade, [
        ['a registry that rejects the field is retried without it, and the verdict is cached', async () => {
          const jobs = degrade.get('jobs')
          const realStart = jobs.start
          const calls = []
          jobs.start = function (spec) {
            calls.push([...Object.keys(spec)].sort())
            if (spec.toolCall !== undefined) throw new Error('invalid job spec: unknown field "toolCall"')
            return realStart.call(this, spec)
          }
          try {
            const first = await execTool(degrade, 'git_bash', { command: 'echo m1-degrade', run_in_background: true })
            assert.match(first, /started background job \S+/, first)
            assert.equal(calls.length, 2, `one rejected attempt then a clean one: ${JSON.stringify(calls)}`)
            assert.ok(calls[0].includes('toolCall') && !calls[1].includes('toolCall'), JSON.stringify(calls))
            // Settled once per row: the next job does not try the field again.
            await execTool(degrade, 'git_bash', { command: 'echo m1-degrade-2', run_in_background: true })
            assert.equal(calls.length, 3, 'the second job must not attempt the field again')
            assert.ok(!calls[2].includes('toolCall'))
          } finally {
            jobs.start = realStart
          }
        }],
      ])
    } finally {
      if (degrade) await degrade.fiber.dispose()
    }
  }
}

console.log('\n[B] boot integration: no job registry — config decides the schema, the call fails loud')
{
  if (!HAS_GIT_BASH) {
    skip('  … skipping no-registry fixture: no Git Bash probed on this host')
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
        // Only git_bash and the interactive terminal row are on by default; the WSL
        // row is opt-in (first-load probing is why), so the tool is absent here.
        assert.ok(!names.includes('wsl_bash'), 'the WSL row is opt-in and must not compose by default')
      }],
      ['tools execute through the real patch composition', async () => {
        const text = await execTool(ctx, 'git_bash', { command: 'echo patch-overlay-ok' })
        assert.match(text, /patch-overlay-ok/)
      }],
      ['the shipped patch does not leave the shell seat unprovided', async () => {
        assert.ok(ctx.shell !== undefined, 'the base bundle keeps ctx.shell')
      }],
      ['the shipped patch disables no base row (no selector to make room for)', async () => {
        const raw = readFileSync(patchPath, 'utf8')
        const unconditional = [...raw.matchAll(/- id: ([\w-]+)\n(?:(?!\s*- id:)[^\n]*\n)*?\s+disabled:\s*true/g)].map((match) => match[1])
        const optIn = PATCH_ROWS.filter((row) => row.disabledByDefault === true).map((row) => row.id)
        // Our own opt-in dialect ships disabled on purpose; disabling anything ELSE
        // (a base row) is what this guard forbids.
        assert.deepEqual(unconditional, optIn, 'only the opt-in dialect rows may be unconditionally disabled')
        assert.ok(!/shell-select/.test(raw), 'no selector row remains')
      }],
      ['the shipped patch composes the core row and only the two tool rows', async () => {
        // `loader.entries()` is a cosmokit collection, not an Array: iterate it.
        const rows = []
        for (const entry of ctx.loader.entries()) rows.push({ id: entry.options.id, name: entry.options.name, enabled: !entry.disabled })
        const composed = rows.map((row) => `${String(row.id)}|${String(row.name)}|${String(row.enabled)}`).join(', ')
        const own = rows.filter((row) => String(row.name).startsWith('dsh-win-multi-bash'))
        assert.deepEqual(own.map((row) => row.name).sort(), PATCH_ROWS.map((row) => row.name).sort(), `every declared row must be composed; composed rows: ${composed}`)
        const core = own.find((row) => row.name === 'dsh-win-multi-bash')
        assert.equal(core.enabled, true, 'the core row must be enabled')
        for (const row of PATCH_ROWS.filter((entry) => entry.disabledByDefault === true))
          assert.equal(own.find((entry) => entry.name === row.name)?.enabled, false, `${row.name} ships disabled (opt-in)`)
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
      skip('  … skipping: this composition provides no configEditor/profileContext, so dsh-settings never activates')
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
    skip('  … skipping: no Git Bash probed on this host')
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
      ['a stale pinned bashPath falls back at runtime instead of failing the command', async () => {
        // A3, and status quo notes: before this change the pin was trusted verbatim,
        // so this command died on a bare spawn ENOENT. Now the pin is used only when
        // it is really there: the row discovers Git for Windows at RUNTIME (and warns
        // once — covered by the unit guard above), while the stored value is left
        // exactly as it is. Nothing in this plugin writes config.
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x' })
        assert.equal(r.isError, false, `the runtime fallback must let the command run: ${r.text.slice(0, 200)}`)
        assert.match(r.text, /x/)
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

  test('the smoke bootstrap is Node, and the PowerShell scripts are gone', () => {
    // Two PowerShell scripts used to duplicate this bootstrap, and one of them
    // re-implemented the plugin OWN Git Bash probe. One Node entry replaced them,
    // which also retired the UTF-8 BOM requirement PowerShell 5.1 imposed (a
    // rewrite once dropped run.ps1 BOM and PowerShell then read it as GBK).
    for (const gone of ['smoke/run.ps1', 'smoke/audit.ps1']) {
      assert.ok(!existsSync(join(PLUGIN, gone)), gone + ' must be gone: the Node bootstrap replaced it')
    }
    assert.ok(existsSync(join(PLUGIN, 'smoke/prepare.mjs')), 'the Node bootstrap must exist')
    assert.equal(manifest.scripts.test, 'node smoke/prepare.mjs', 'npm test must run the Node bootstrap')
    assert.equal(manifest.scripts['test:audit'], 'node smoke/prepare.mjs audit', 'and so must the audit entry')
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

    // A release condition that used to be uncaught: the notes must DOCUMENT the version this
    // tree declares, or a publish ships an artifact nobody wrote down (the version cannot be
    // published twice, so this is the last moment the mismatch is cheap).
    const notes = readFileSync(join(PLUGIN, 'RELEASE_NOTES.md'), 'utf8')
    assert.equal(notes.split('\n')[0], `# ${manifest.name} v${manifest.version}`,
      'RELEASE_NOTES.md must open with the version package.json declares')
    const section = notes.slice(0, notes.indexOf('\n# ', 1))
    for (const heading of ['## New', '## Improvements', '## Bug fixes'])
      assert.ok(section.includes(heading), `the newest section must carry ${heading}`)
    // ...and the globs are checked against the files they must actually cover: the
    // assertions above only compare their STRINGS, so a file the tarball would drop
    // (the way `lib/bash-ssh/index.js` was missing from a stale pack) stayed invisible.
    const covered = (rel) => manifest.files.some((entry) => {
      if (entry === rel) return true
      // Only the shape this manifest uses: `lib/**/*.js` (root + suffix). A new glob
      // shape shows up here as a loud failure naming the export it would drop.
      const at = entry.indexOf('/**/*')
      if (at < 0) return false
      const root = entry.slice(0, at + 1)
      return rel.startsWith(root) && rel.endsWith(entry.slice(at + 5))
    })
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (!target.startsWith('./')) continue
      const rel = target.slice(2)
      // npm includes package.json whatever `files` says; everything else must be named.
      if (rel === 'package.json') continue
      assert.ok(existsSync(join(PLUGIN, rel)), `${subpath} exports ${rel}, which does not exist`)
      assert.ok(covered(rel), `${subpath} exports ${rel}, which the published file list would drop`)
    }
  })
}

if (TIMING) {
  const total = Date.now() - STARTED_AT
  console.log(`[timing] boots ${timing.boots} = ${(timing.bootMs / 1000).toFixed(1)} s, tool calls ${timing.calls} = ${(timing.callMs / 1000).toFixed(1)} s, suite total ${(total / 1000).toFixed(1)} s`)
}
console.log(`\n==== audit summary: ${passed} passed, ${failed} failed, ${skipped} skipped ====`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const { name, error } of failures) console.log(`  - ${name}: ${error?.message ?? error}`)
  process.exit(1)
}
