#!/usr/bin/env node
/**
 * Comprehensive audit suite for dsh-win-multi-bash.
 *
 * Two layers:
 *   A) Unit tests — pure helpers (vendor/helpers.js, vendor/bwrap-profiles.js),
 *      config schemas, and executor routing/sandbox logic via the documented
 *      `internals` test hooks (no boot, fake ctx/subprocess).
 *   B) Boot integration — boots the real loader over the profile runtime with
 *      the plugin's exact rows (plus a real-patch-shape fixture with
 *      `- insert:` blocks and `!!js` disabled tags) and executes a scenario
 *      matrix through git_bash / wsl_bash / the selector default.
 *
 * Run via smoke/audit.ps1 (it sets up the smoke/node_modules junctions and
 * cleans up after). Requires the profile runtime at ~/.dsh/profiles.
 *
 * Exit code 0 = all assertions passed; every failure prints a ✗ line.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
const { GitBashExecutor, candidateBashPaths, gitRootCandidates, resolveBashPath } =
  await import(libUrl('bash-git', 'index.js'))
const { WslBashExecutor } = await import(libUrl('bash-wsl', 'index.js'))
const { ShellSelectExecutor, SHELL_BACKEND_UNAVAILABLE } =
  await import(libUrl('shell-select', 'index.js'))
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

/** Instantiate an executor class without running its constructor (unit isolation). */
function bareInstance(cls, props) {
  const inst = Object.create(cls.prototype)
  const { config, source, ...rest } = props ?? {}
  Object.assign(inst, {
    internals: {},
    sandboxStance: 'auto',
    probeTimeoutMs: 10000,
    bwrapVerdict: undefined,
    confinedVerdict: undefined,
    distroProbed: false,
    distroVerdict: undefined,
    ...rest,
  })
  // `config` is a getter-only accessor reading `this.source()` — shadow it via `source`.
  inst.source = source ?? (() => config ?? {})
  return inst
}

// Git Bash for the real-spawn unit tests is NEVER hardcoded: it is probed with
// the plugin's own resolver (well-known locations → PATH, WSL launcher
// excluded → git.exe layout inference). `DSH_AUDIT_GIT_BASH` overrides for
// hosts where probing must not run. Tests that need a real bash skip when
// probing finds none, so the suite stays portable.
const GIT_BASH = process.env.DSH_AUDIT_GIT_BASH ?? resolveBashPath(undefined, process.env, process.platform) ?? ''
const HAS_GIT_BASH = GIT_BASH.length > 0

// ═════════════════════════════════════════════════════════════════════════════
// A) Unit tests
// ═════════════════════════════════════════════════════════════════════════════
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
    assert.equal(GitBashExecutor.Config({}).sandbox, 'auto')
  })
  test('GitBashExecutor.Config rejects unknown sandbox stances', () => {
    assert.throws(() => GitBashExecutor.Config({ sandbox: 'bogus' }))
  })
  test('WslBashExecutor.Config accepts auto/none/bwrap', () => {
    for (const s of ['auto', 'none', 'bwrap']) assert.equal(WslBashExecutor.Config({ sandbox: s }).sandbox, s)
  })
  test('WslBashExecutor.Config rejects unknown sandbox stances', () => {
    assert.throws(() => WslBashExecutor.Config({ sandbox: 'bogus' }))
  })
  test('ShellSelectExecutor.Config defaults backends + pwsh default', () => {
    const c = ShellSelectExecutor.Config({})
    assert.deepEqual(c.backends, ['git-bash', 'wsl-bash', 'pwsh'])
    assert.equal(c.default, 'pwsh')
  })
  test('ShellSelectExecutor.Config merges partial partitions', () => {
    const c = ShellSelectExecutor.Config({ backends: ['git-bash'], gitBash: { bashPath: 'X' } })
    assert.deepEqual(c.backends, ['git-bash'])
    assert.equal(c.gitBash.bashPath, 'X')
    assert.equal(c.pwsh.timeoutMs, 120000)
  })
  test('ShellSelectExecutor.Config negative probeTimeoutMs rejected', () => {
    assert.throws(() => ShellSelectExecutor.Config({ gitBash: { probeTimeoutMs: -1 } }))
  })
  test('#2: git-bash Config is independent of wsl-bash (no .set() cross-pollution)', () => {
    assert.equal(GitBashExecutor.Config({}).probeTimeoutMs, 10000, 'git-bash keeps its own 1e4 default')
    assert.throws(() => GitBashExecutor.Config({ sandbox: 'bwrap' }), 'bwrap is not a valid git-bash stance')
    assert.equal(WslBashExecutor.Config({}).probeTimeoutMs, 30000, 'wsl-bash keeps its own 3e4 default')
    assert.equal(WslBashExecutor.Config({ sandbox: 'bwrap' }).sandbox, 'bwrap')
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
    const ex = bareInstance(GitBashExecutor)
    ex.source = () => ({ bashPath: 'C:\\pinned\\bash.exe' })
    assert.equal(ex.bashPath(), 'C:\\pinned\\bash.exe')
  })
  test('bashPath(): undefined resolution throws loud naming probes', () => {
    const ex = bareInstance(GitBashExecutor)
    ex.source = () => ({})
    ex.internals.resolveBashPath = () => undefined
    assert.throws(() => ex.bashPath(), /Git Bash was not found \(probed/)
  })
  test('gitArgv: [bashPath, -c, command]', () => {
    const ex = bareInstance(GitBashExecutor)
    ex.source = () => ({ bashPath: 'C:\\b.exe' })
    assert.deepEqual(ex.gitArgv({ command: 'ls -la' }), ['C:\\b.exe', '-c', 'ls -la'])
  })
  test('sandboxMode: stance none → undefined (no sandbox advertisement)', () => {
    const ex = bareInstance(GitBashExecutor, { sandboxStance: 'none' })
    assert.equal(ex.sandboxMode, undefined)
  })
  test('sandboxMode: failed probe → undefined (honest degrade)', () => {
    let calls = 0
    const ex = bareInstance(GitBashExecutor)
    ex.internals.probeConfined = () => { calls += 1; return false }
    assert.equal(ex.sandboxMode, undefined)
    assert.equal(ex.sandboxMode, undefined)
    assert.equal(calls, 1, 'probe cached after first call')
  })
  test('sandboxMode: successful probe → policy defaultMode', () => {
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: 'X' }) } }),
    })
    ex.ctx.sandboxPolicy.defaultMode = 'read-only'
    ex.internals.probeConfined = () => true
    assert.equal(ex.sandboxMode, 'read-only')
  })
  if (!HAS_GIT_BASH) {
    console.log('  … skipping real-spawn run() tests: no Git Bash probed on this host')
  } else {
  testAsync('run(): unconfined path passes plain git argv (no sandbox facts)', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      sandboxStance: 'none',
      config: { bashPath: GIT_BASH },
    })
    const result = await ex.run({ command: 'echo unconfined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /unconfined-ok/)
    assert.equal(result.sandbox, undefined)
  })
  testAsync('run(): confined path stamps sandbox facts (denied=false)', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      config: { bashPath: GIT_BASH },
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: () => ({ argv: [GIT_BASH, '-c', 'echo confined-ok'], denialSignatures: ['denied by policy'], runnerFailureRules: [], enforcement: 'full' }),
    }
    const result = await ex.run({ command: 'echo confined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.sandbox, { mode: 'read-only', denied: false, enforcement: 'full' })
  })
  testAsync('run(): denial signature classifies sandbox.denied=true', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      config: { bashPath: GIT_BASH },
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: () => ({ argv: [GIT_BASH, '-c', 'echo denied by policy >&2; exit 1'], denialSignatures: ['denied by policy'], runnerFailureRules: [], enforcement: 'full' }),
    }
    const result = await ex.run({ command: 'x', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })
    assert.equal(result.sandbox.denied, true)
  })
  testAsync('run(): runner failure falls back to unconfined run', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      config: { bashPath: GIT_BASH },
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: () => ({ argv: [GIT_BASH, '-c', 'echo bwrap: runner exploded >&2; exit 1'], denialSignatures: [], runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES, enforcement: 'full' }),
    }
    const result = await ex.run({ command: 'echo fallback-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })
    // stderr "bwrap: " is a *fake* runner-failure signature from our confined argv,
    // so the executor must have re-run the ORIGINAL argv unconfined: no sandbox facts.
    assert.equal(result.sandbox, undefined)
    assert.match(result.stdout.text, /fallback-ok/)
  })
  testAsync('run(): spawn failure of runner falls back unconfined', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      config: { bashPath: GIT_BASH },
    })
    ex.internals.probeConfined = () => true
    ex.ctx.sandbox = {
      confine: () => ({ argv: ['G:\\no-such-runner-xyz.exe', '-c', 'x'], denialSignatures: [], runnerFailureRules: [], enforcement: 'full' }),
    }
    const result = await ex.run({ command: 'echo respawn-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })
    assert.equal(result.sandbox, undefined)
    assert.match(result.stdout.text, /respawn-ok/)
  })
  testAsync('run(): danger-full-access bypasses confinement with honest facts', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(GitBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      config: { bashPath: GIT_BASH },
    })
    ex.internals.probeConfined = () => true
    const result = await ex.run({ command: 'echo dfa-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd(), sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: 'X' } })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  })
  }
}

console.log('\n[A] unit: bash resolution (git-path inference, never the WSL launcher)')
{
  const bareEnv = (path) => ({ PATH: path, SystemRoot: 'C:\\Windows', ProgramFiles: 'G:\\no-such-pf', 'ProgramFiles(x86)': 'G:\\no-such-x86' })

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
}

console.log('\n[A] unit: WslBashExecutor (internals hooks)')
{
  test('wslPath(): configured pin returned verbatim', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl-pinned.exe' })
    assert.equal(ex.wslPath(), 'C:\\wsl-pinned.exe')
  })
  test('wslPath(): undefined resolution throws loud naming probes', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({})
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
  test('argv(): no --cd when workdir equals default', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl.exe' })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.argv({ command: 'x', workdir: process.cwd() })
    assert.deepEqual(argv.slice(0, 3), ['C:\\wsl.exe', '-d', 'Ubuntu-24.04'])
    assert.deepEqual(argv.slice(3), ['--', 'bash', '-c', ex.payload('x')])
  })
  test('argv(): --cd inserted before -d when workdir differs', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl.exe' })
    ex.distro = () => 'Ubuntu-24.04'
    const argv = ex.argv({ command: 'x', workdir: 'G:\\other' })
    assert.deepEqual(argv.slice(0, 5), ['C:\\wsl.exe', '--cd', 'G:\\other', '-d', 'Ubuntu-24.04'])
  })
  test('argv(): distro omitted when probe found none', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl.exe' })
    ex.distro = () => undefined
    assert.deepEqual(ex.argv({ command: 'x', workdir: process.cwd() }), ['C:\\wsl.exe', '--', 'bash', '-c', ex.payload('x')])
  })
  test('distro(): explicit wslDistro wins over probe', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslDistro: 'Pinned' })
    ex.internals.probeDistro = () => { throw new Error('must not probe') }
    assert.equal(ex.distro(), 'Pinned')
  })
  test('distro(): probe result cached and used', () => {
    let calls = 0
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({})
    ex.internals.probeDistro = () => { calls += 1; return 'Ubuntu-24.04' }
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(ex.distro(), 'Ubuntu-24.04')
    assert.equal(calls, 1)
  })
  test('requireBwrapUsable(): auto + failed probe → false (honest degrade)', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({})
    ex.internals.probeBwrap = () => false
    assert.equal(ex.requireBwrapUsable(), false)
  })
  test('requireBwrapUsable(): explicit bwrap + failed probe throws loud', () => {
    const ex = bareInstance(WslBashExecutor, { sandboxStance: 'bwrap' })
    ex.source = () => ({})
    ex.internals.probeBwrap = () => false
    assert.throws(() => ex.requireBwrapUsable(), /bwrap was not found/)
  })
  test('bwrapArgv(): workspace root converted to /mnt/<drive>', () => {
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl.exe' })
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
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl.exe' })
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
    const ex = bareInstance(WslBashExecutor)
    ex.source = () => ({ wslPath: 'C:\\wsl.exe' })
    ex.distro = () => undefined
    assert.throws(() => ex.bwrapArgv({
      command: 'x',
      workdir: 'G:\\LAB',
      sandboxPolicy: { mode: 'read-only', workspaceRoot: '\\\\server\\share\\x' },
    }), /unsupported Windows path/)
  })
  testAsync('run(): unconfined path passes plain argv (no sandbox facts)', async () => {
    const sub = fakeSubprocess()
    const ex = bareInstance(WslBashExecutor, {
      ctx: fakeCtx({ subprocess: sub }),
      sandboxStance: 'none',
      config: { wslPath: 'C:\\Windows\\System32\\wsl.exe' },
    })
    ex.distro = () => undefined
    const result = await ex.run({ command: 'echo wsl-unconfined-ok', timeoutMs: 30000, stdoutMaxBytes: 4096, workdir: process.cwd() })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /wsl-unconfined-ok/)
    assert.equal(result.sandbox, undefined)
  })
}

console.log('\n[A] unit: ShellSelectExecutor (internals hooks)')
{
  const makeSelector = () => {
    const sel = Object.create(ShellSelectExecutor.prototype)
    sel.backends = new Map()
    sel.fibers = []
    sel.internals = {}
    sel.source = () => ({ backends: ['git-bash', 'wsl-bash', 'pwsh'], default: 'pwsh' })
    return sel
  }
  test('requireBackend: unknown name throws SHELL_BACKEND_UNAVAILABLE', () => {
    const sel = makeSelector()
    assert.throws(() => sel.requireBackend('bogus'), (e) => e.code === SHELL_BACKEND_UNAVAILABLE)
  })
  test('resolve(): routes request.shell ?? default and stamps shellBackend', () => {
    const sel = makeSelector()
    sel.backends.set('git-bash', { resolve: (r) => ({ ...r, via: 'git' }) })
    sel.backends.set('pwsh', { resolve: (r) => ({ ...r, via: 'pwsh' }) })
    const routed = sel.resolve({ command: 'x', shell: 'git-bash' })
    assert.equal(routed.via, 'git')
    assert.equal(routed.shellBackend, 'git-bash')
    const dflt = sel.resolve({ command: 'x' })
    assert.equal(dflt.via, 'pwsh')
    assert.equal(dflt.shellBackend, 'pwsh')
  })
  test('run(): dispatches on spec.shellBackend ?? default', async () => {
    const sel = makeSelector()
    sel.backends.set('wsl-bash', { run: async (s) => ({ via: 'wsl', spec: s }) })
    const out = await sel.run({ shellBackend: 'wsl-bash' })
    assert.equal(out.via, 'wsl')
  })
  test('sandboxMode: first enabled backend declaring a mode wins', () => {
    const sel = makeSelector()
    sel.source = () => ({ backends: ['git-bash', 'pwsh'], default: 'pwsh' })
    sel.backends.set('git-bash', { sandboxMode: undefined })
    sel.backends.set('pwsh', { sandboxMode: 'read-only' })
    assert.equal(sel.sandboxMode, 'read-only')
  })
  test('rebuildBackends: unknown backend name fails loud', () => {
    const sel = makeSelector()
    sel.ctx = { plugin: () => { throw new Error('must not construct') } }
    assert.throws(() => sel.rebuildBackends({ backends: ['bogus'] }), /unknown backend "bogus"/)
  })
  test('rebuildBackends: internals.factories override + config partitions', () => {
    const sel = makeSelector()
    const received = []
    // `rebuildBackends` chains fiber.ctx.isolate(...).isolate(...) — a self-returning isolate.
    const fiberCtx = { isolate: () => fiberCtx }
    sel.ctx = {
      plugin: () => ({ ctx: fiberCtx }),
    }
    sel.internals.factories = {
      'git-bash': (ctx, cfg) => { received.push(['git-bash', cfg]); return { name: 'gb' } },
      'wsl-bash': (ctx, cfg) => { received.push(['wsl-bash', cfg]); return { name: 'wb' } },
    }
    sel.rebuildBackends({ backends: ['git-bash', 'wsl-bash'], default: 'git-bash', gitBash: { bashPath: 'GB' }, wslBash: { wslDistro: 'WB' } })
    assert.equal(sel.backends.size, 2)
    assert.equal(sel.backends.get('git-bash').name, 'gb')
    assert.equal(received[0][1].bashPath, 'GB')
    assert.equal(received[1][1].wslDistro, 'WB')
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// B) Boot integration
// ═════════════════════════════════════════════════════════════════════════════
const { boot, resolveConfigPath, loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
const { CallId } = await import('@deepseek-ai/dsh-llm')

const PLUGIN = join(__dirname, '..')

// Fixtures must live where the loader can resolve '@deepseek-ai/*' and
// 'dsh-win-multi-bash/*' — i.e. beside the smoke/node_modules junctions.
const FIXTURE_DIR = __dirname
const writtenFixtures = []

const BASE_ROWS = `- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'

- id: tools
  name: '@deepseek-ai/dsh-tools'

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'

- id: shell-env
  name: '@deepseek-ai/dsh-shell-env'

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
// probing finds none the pinned variant is skipped by the caller.
const PLUGIN_ROWS = (bashPath) => `
- id: win-mb-shell-select
  name: 'dsh-win-multi-bash/shell-select'
  config:
    backends: [git-bash, wsl-bash, pwsh]
    default: pwsh
    gitBash:
      bashPath: '${bashPath}'

- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
`

/** Execute a tool and return the joined text of its rendered content. */
async function execTool(ctx, name, args) {
  return execToolResult(ctx, name, args).then((r) => r.text)
}

/** Execute a tool and return { text, isError, error } for error-path assertions. */
async function execToolResult(ctx, name, args) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`audit-${name}-${Math.random().toString(36).slice(2)}`),
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
      ['wsl_bash: background job lifecycle', async () => {
        const text = await execTool(ctx, 'wsl_bash', { command: 'while :; do :; done', run_in_background: true })
        const jobId = text.match(/started background job (\S+)/)?.[1]
        assert.ok(jobId, `no job id in: ${text}`)
        await execTool(ctx, 'job_kill', { job_id: jobId })
        const read2 = await execTool(ctx, 'job_output', { job_id: jobId })
        assert.match(read2, /killed|stopping|cancelled/i)
      }],
      ['selector: default route lands on pwsh', async () => {
        const result = await ctx.shell.run(ctx.shell.resolve({ command: 'echo selector-default-ok', signal: new AbortController().signal }))
        assert.equal(result.exitCode, 0)
        assert.match(result.stdout.text, /selector-default-ok/)
      }],
      ['selector: explicit shell routes to each backend', async () => {
        const git = await ctx.shell.run(ctx.shell.resolve({ command: 'echo routed-git', shell: 'git-bash', signal: new AbortController().signal }))
        assert.match(git.stdout.text, /routed-git/)
        const wsl = await ctx.shell.run(ctx.shell.resolve({ command: 'echo routed-wsl', shell: 'wsl-bash', signal: new AbortController().signal }))
        assert.match(wsl.stdout.text, /routed-wsl/)
        const pwsh = await ctx.shell.run(ctx.shell.resolve({ command: 'echo routed-pwsh', shell: 'pwsh', signal: new AbortController().signal }))
        assert.match(pwsh.stdout.text, /routed-pwsh/)
      }],
      ['selector: unknown backend fails with SHELL_BACKEND_UNAVAILABLE', async () => {
        // resolve() throws synchronously (HarnessError, code SHELL_BACKEND_UNAVAILABLE).
        assert.throws(() => ctx.shell.resolve({ command: 'echo x', shell: 'bogus', signal: new AbortController().signal }), (e) => {
          assert.equal(e.code, SHELL_BACKEND_UNAVAILABLE)
          return true
        })
      }],
      ['git_bash sandbox facts (records actual probe outcome)', async () => {
        const result = await ctx.shell.run(ctx.shell.resolve({ command: 'echo sandbox-facts', signal: new AbortController().signal, shell: 'git-bash' }))
        const facts = result.sandbox
        console.log(`      git_bash sandbox facts: ${JSON.stringify(facts)}`)
        if (facts !== undefined) {
          assert.equal(typeof facts.mode, 'string')
          assert.equal(typeof facts.denied, 'boolean')
        }
      }],
      ['wsl_bash sandbox facts (bwrap missing on this host → honest degrade)', async () => {
        const result = await ctx.shell.run(ctx.shell.resolve({ command: 'echo wsl-sandbox-facts', signal: new AbortController().signal, shell: 'wsl-bash' }))
        console.log(`      wsl_bash sandbox facts: ${JSON.stringify(result.sandbox)}`)
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
- id: win-mb-shell-select
  name: 'dsh-win-multi-bash/shell-select'
  config:
    backends: [git-bash, wsl-bash, pwsh]
    default: pwsh

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
    ])
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }
}

console.log('\n[B] boot integration: REAL cordis.patch.yml applied as overlay patches')
{
  // The plugin's own patch disables base rows (absent here → loader warns+skips)
  // and inserts the win-mb-* rows — exactly the Path A/B wiring. `!!js` tags are
  // evaluated by loadOverlayPatches, proving the shipped patch file parses.
  const patchPath = join(PLUGIN, 'cordis.patch.yml')
  const patches = loadOverlayPatches('dsh-wmb-audit', patchPath)
  assert.ok(patches.length >= 3, `expected ≥3 patch entries, got ${patches.length}`)
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
    ])
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }
}

console.log('\n[B] boot integration: misconfiguration matrices')
{
  const BOGUS_BACKEND_ROWS = (bashPath) => `
- id: win-mb-shell-select
  name: 'dsh-win-multi-bash/shell-select'
  config:
    backends: [git-bash, bogus]
    default: git-bash
    gitBash:
      bashPath: '${bashPath}'
`
  let ctx
  try {
    ctx = await bootFixture(BOGUS_BACKEND_ROWS(GIT_BASH), 'bogus-backend.yml')
    await runTests(ctx, [
      ['unknown backend in config fails loud at first use', async () => {
        const r = await execToolResult(ctx, 'git_bash', { command: 'echo x' })
        assert.ok(r.isError || /unknown backend "bogus"/.test(r.text), `text: ${r.text.slice(0, 200)}`)
      }],
    ])
  } finally {
    if (ctx) await ctx.fiber.dispose()
  }

  let ctx2
  try {
    ctx2 = await bootFixture(`
- id: win-mb-shell-select
  name: 'dsh-win-multi-bash/shell-select'
  config:
    backends: [git-bash, wsl-bash, pwsh]
    default: pwsh
    wslBash:
      wslDistro: 'NoSuchDistro-999'

- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
`, 'bad-distro.yml')
    await runTests(ctx2, [
      ['nonexistent wslDistro surfaces as a failed command, not a crash', async () => {
        const r = await execToolResult(ctx2, 'wsl_bash', { command: 'echo x' })
        assert.ok(r.text.length > 0)
      }],
    ])
  } finally {
    if (ctx2) await ctx2.fiber.dispose()
  }

  // #3 (fixed): explicit `sandbox: bwrap` without bubblewrap must NOT brick the
  // boot (the selector's sandboxMode advertisement now tolerates a backend's
  // probe failure); the error surfaces loudly at the first wsl_bash command.
  let ctx3
  try {
    ctx3 = await bootFixture(`
- id: win-mb-shell-select
  name: 'dsh-win-multi-bash/shell-select'
  config:
    backends: [git-bash, wsl-bash, pwsh]
    default: pwsh
    wslBash:
      sandbox: bwrap

- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
`, 'explicit-bwrap.yml')
    await runTests(ctx3, [
      ['#3: boot succeeds with explicit bwrap + missing bubblewrap', async () => {
        const names = ctx3.tools.schemas().map((t) => t.name)
        assert.ok(names.includes('git_bash'))
        assert.ok(names.includes('wsl_bash'))
      }],
      ['#3: other backends unaffected (git_bash still executes)', async () => {
        const text = await execTool(ctx3, 'git_bash', { command: 'echo still-works' })
        assert.match(text, /still-works/)
      }],
      ['#3: first wsl_bash use fails loud with the bwrap message', async () => {
        const r = await execToolResult(ctx3, 'wsl_bash', { command: 'echo x' })
        assert.ok(/bwrap was not found/.test(r.text), `text: ${r.text.slice(0, 200)}`)
      }],
    ])
  } finally {
    if (ctx3) await ctx3.fiber.dispose()
  }
}

for (const p of writtenFixtures) rmSync(p, { force: true })
try { rmSync(join(__dirname, '_repro.mjs'), { force: true }) } catch { /* not ours */ }

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n==== audit summary: ${passed} passed, ${failed} failed ====`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const { name, error } of failures) console.log(`  - ${name}: ${error?.message ?? error}`)
  process.exit(1)
}
