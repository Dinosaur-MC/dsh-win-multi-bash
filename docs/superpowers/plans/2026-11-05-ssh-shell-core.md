# ssh_shell Core Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Rename ssh_bash to ssh_shell and replace its one-shot OpenSSH executor with an ssh2-backed connection pool: host registry config, known_hosts verification, per-call exec channels, and ctx.jobs integration.

**Architecture:** One SshEngine per tool row holds the host store and one ssh2.Client per alias. Every call opens one exec channel, sends a base64 POSIX script on stdin, streams stdout/stderr, settles on the channel exit event, and supports background jobs and timeout promotion through the existing factory job path.

**Tech Stack:** Node ^22.19 || >=24, ssh2 ^1.17.0, cordis 4, schemastery, the repository audit script (node smoke/prepare.mjs audit).

**Spec:** docs/superpowers/specs/2026-11-05-ssh-shell-design.md

## Plan split

The spec covers four independently testable subsystems, so it is split into four
plans. Each plan leaves the tree working and auditable:

- **Plan 1 (this):** rename, ssh2 transport pool, host registry config,
  known_hosts, script builder, exec path, jobs.
- **Plan 2:** ssh_scp (SFTP transfer, sandboxed local paths).
- **Plan 3:** session-memory authorization gate and the dedicated approval card.
- **Plan 4:** hosts table GUI, documentation, migration notes, 0.8.0 release.

## Global Constraints

- Target version 0.8.0; the rename is breaking and documented.
- Node engines ^22.19.0 || >=24.0.0; dsh >=0.1.7-rc.2 <0.3.0-0.
- The only new runtime dependency is ssh2 ^1.17.0; lockfile and
  THIRD_PARTY_NOTICES change with it.
- The plugin stays Windows-first: rows keep win32Only.
- Repository text is LF. Every commit leaves npm test and
  node smoke/prepare.mjs audit green.
- No secret value is written to config, logs or tool output: key paths only,
  passphrase through an environment variable name.
- Known hosts fail closed; ssh2's default auto-accept must never be used.
- No plugin-level concurrency cap; ctx.jobs and the server's MaxSessions are
  the only limits.

## File Structure

| Path | Responsibility |
| --- | --- |
| lib/tool-bash/types/ssh-shell.js | Tool module for the ssh dialect (renamed from ssh-bash.js) |
| lib/ssh-shell/index.js | SshShellExecutor: resolve/execute/terminal hooks (renamed from lib/bash-ssh/index.js) |
| lib/ssh-shell/hosts.js | Host array schema, validation, alias resolution |
| lib/ssh-shell/known-hosts.js | known_hosts parser and ssh2 hostVerifier |
| lib/ssh-shell/script.js | POSIX script builder (startup, workdir, base64 payload) |
| lib/ssh-shell/pool.js | Per-alias ssh2 connection pool and reconnect |
| lib/shell-dialects.js | Dialect declaration (tool name, config key, fields, facts) |
| lib/tool-bash/types/factory.js | Shared tool factory; exec/job/promotion wiring |
| lib/tool-bash/types/terminal.js | Terminal backend; rename only in this plan |
| package.json | Exports, ssh2 dependency, engines |
| cordis.patch.yml | Row name tool-ssh-shell |
| smoke/audit.test.mjs | Unit and boot assertions for every change |

## Task 1: Rename the surface with no behavior change

**Files:**
- Rename: lib/tool-bash/types/ssh-bash.js -> lib/tool-bash/types/ssh-shell.js
- Rename: lib/bash-ssh/index.js -> lib/ssh-shell/index.js
- Modify: lib/shell-dialects.js (ssh declaration)
- Modify: lib/tool-bash/types/terminal.js (comments and enum references only)
- Modify: package.json (exports and files)
- Modify: cordis.patch.yml (row name)
- Test: smoke/audit.test.mjs (expected assertion updates)

**Interfaces:**
- Consumes: the existing SshBashExecutor class name and its execute/resolve contract.
- Produces: dialect id ssh with toolName ssh_shell, configKey sshShell,
  specifier tool-ssh-shell, entry ssh-shell, executor
  { module: ../../ssh-shell/index.js, export: SshShellExecutor }.

- [ ] **Step 1: Rename the two files and the exported class**

Run: git mv lib/tool-bash/types/ssh-bash.js lib/tool-bash/types/ssh-shell.js
Run: git mv lib/bash-ssh/index.js lib/ssh-shell/index.js

In lib/ssh-shell/index.js rename the exported class SshBashExecutor to
SshShellExecutor (one declaration and the export). Keep the implementation
unchanged in this task.

- [ ] **Step 2: Update the dialect declaration**

In lib/shell-dialects.js replace the ssh entry's identity fields (keep fields,
facts, executor module and argvStyle unchanged for now):

    {
        id: 'ssh',
        toolName: 'ssh_shell',
        rowId: 'win-mb-tool-ssh',
        configKey: 'sshShell',
        specifier: 'tool-ssh-shell',
        entry: 'ssh-shell',
        label: { en: 'SSH remote shell', zh: 'SSH 远端 Shell' },
        executor: { module: '../../ssh-shell/index.js', export: 'SshShellExecutor' },
        ...
    }

- [ ] **Step 3: Update package.json and the patch row**

In package.json:
- exports: "./tool-ssh-bash" -> "./tool-ssh-shell": "./lib/tool-bash/types/ssh-shell.js"
- files already covers lib/**/*.js; no change needed.

In cordis.patch.yml rename the row name
dsh-win-multi-bash/tool-ssh-bash -> dsh-win-multi-bash/tool-ssh-shell and the
file tool-bash/types/ssh-bash.js references.

- [ ] **Step 4: Run the audit and collect the exact failures**

Run: node smoke/prepare.mjs audit
Expected: FAIL, with failures naming ssh_bash, sshBash, tool-ssh-bash and the
old file paths. This list is the checklist for Step 5.

- [ ] **Step 5: Update every assertion and reference**

Search: git grep -n "ssh_bash\|sshBash\|tool-ssh-bash\|ssh-bash"
Update smoke/audit.test.mjs assertions, the terminal shell enum expectations,
docs/configuration.md field names, README tables, and lib/client.js locale
strings. Do not change behavior.

- [ ] **Step 6: Run the audit and the smoke suite**

Run: node smoke/prepare.mjs audit
Expected: PASS with the same counts as before this task.
Run: npm test
Expected: PASS.

- [ ] **Step 7: Commit**

git add -A
git commit -m "refactor(ssh): rename ssh_bash to ssh_shell"

## Task 2: Host schema and validation

**Files:**
- Create: lib/ssh-shell/hosts.js
- Modify: lib/ssh-shell/index.js (Config gains the hosts array)
- Test: smoke/audit.test.mjs (unit section)

**Interfaces:**
- Produces:
  - export const hostSchema (schemastery object)
  - export function validateHosts(value): { ok: true, hosts: NormalizedHost[] } | { ok: false, error: string }
  - export function findHost(hosts, alias): NormalizedHost | undefined
  - NormalizedHost = { alias, host, port, user, keyPath, passphraseEnv?, startupCommand?, shellTemplate?, connectTimeoutMs, approval, acceptNewHostKeys, default, description? }

- [ ] **Step 1: Write the failing audit block**

Append to the unit section of smoke/audit.test.mjs:

    // --- ssh shell host validation ---
    {
      const { validateHosts, findHost } = await import('../lib/ssh-shell/hosts.js')
      const good = validateHosts([
        { alias: 'prod', host: '10.0.0.5', user: 'deploy', keyPath: '~/.ssh/id_ed25519' },
      ])
      assert.equal(good.ok, true)
      assert.equal(good.hosts[0].port, 22)
      assert.equal(good.hosts[0].approval, 'session')
      assert.equal(good.hosts[0].connectTimeoutMs, 30000)
      assert.equal(findHost(good.hosts, 'prod').host, '10.0.0.5')

      const dup = validateHosts([
        { alias: 'a', host: 'h', user: 'u', keyPath: 'k' },
        { alias: 'a', host: 'h2', user: 'u', keyPath: 'k' },
      ])
      assert.equal(dup.ok, false)
      assert.match(dup.error, /duplicate alias "a"/)

      const twoDefaults = validateHosts([
        { alias: 'a', host: 'h', user: 'u', keyPath: 'k', default: true },
        { alias: 'b', host: 'h', user: 'u', keyPath: 'k', default: true },
      ])
      assert.equal(twoDefaults.ok, false)
      assert.match(twoDefaults.error, /more than one default/)

      const badAlias = validateHosts([{ alias: 'has space', host: 'h', user: 'u', keyPath: 'k' }])
      assert.equal(badAlias.ok, false)
      assert.match(badAlias.error, /alias/)

      const badPort = validateHosts([{ alias: 'a', host: 'h', port: 70000, user: 'u', keyPath: 'k' }])
      assert.equal(badPort.ok, false)
      assert.match(badPort.error, /port/)
    }

- [ ] **Step 2: Run the audit to verify it fails**

Run: node smoke/prepare.mjs audit
Expected: FAIL with "Cannot find module .../lib/ssh-shell/hosts.js".

- [ ] **Step 3: Implement hosts.js**

    export const HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
    export const DEFAULT_PORT = 22
    export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
    export const DEFAULT_SHELL_TEMPLATE = 'bash -c \'eval "$(base64 -d)"\''

    export function validateHosts(value) {
      if (!Array.isArray(value)) return { ok: false, error: 'hosts must be an array' }
      const hosts = []
      const aliases = new Set()
      let defaults = 0
      for (const raw of value) {
        if (raw === null || typeof raw !== 'object') return { ok: false, error: 'each host must be an object' }
        const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
        if (!HOST_ALIAS.test(alias)) return { ok: false, error: 'invalid alias ' + JSON.stringify(raw.alias) }
        if (aliases.has(alias)) return { ok: false, error: 'duplicate alias "' + alias + '"' }
        aliases.add(alias)
        const host = typeof raw.host === 'string' ? raw.host.trim() : ''
        if (host === '' || /\s/.test(host)) return { ok: false, error: 'host "' + alias + '" must be a non-empty hostname or IP' }
        const user = typeof raw.user === 'string' ? raw.user.trim() : ''
        if (user === '') return { ok: false, error: 'host "' + alias + '" needs a user' }
        const keyPath = typeof raw.keyPath === 'string' ? raw.keyPath.trim() : ''
        if (keyPath === '') return { ok: false, error: 'host "' + alias + '" needs a keyPath' }
        const port = raw.port === undefined ? DEFAULT_PORT : raw.port
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'host "' + alias + '" port must be 1..65535' }
        if (raw.approval !== undefined && raw.approval !== 'trusted' && raw.approval !== 'session') {
          return { ok: false, error: 'host "' + alias + '" approval must be trusted or session' }
        }
        if (raw.default === true) defaults += 1
        hosts.push({
          alias, host, port, user, keyPath,
          passphraseEnv: typeof raw.passphraseEnv === 'string' && raw.passphraseEnv !== '' ? raw.passphraseEnv : undefined,
          startupCommand: typeof raw.startupCommand === 'string' && raw.startupCommand !== '' ? raw.startupCommand : undefined,
          shellTemplate: typeof raw.shellTemplate === 'string' && raw.shellTemplate !== '' ? raw.shellTemplate : DEFAULT_SHELL_TEMPLATE,
          connectTimeoutMs: Number.isInteger(raw.connectTimeoutMs) && raw.connectTimeoutMs > 0 ? raw.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS,
          approval: raw.approval === 'trusted' ? 'trusted' : 'session',
          acceptNewHostKeys: raw.acceptNewHostKeys === true,
          default: raw.default === true,
          description: typeof raw.description === 'string' ? raw.description : undefined,
        })
      }
      if (defaults > 1) return { ok: false, error: 'more than one default host' }
      return { ok: true, hosts }
    }

    export function findHost(hosts, alias) {
      return hosts.find((entry) => entry.alias === alias)
    }

    export function defaultHost(hosts) {
      return hosts.find((entry) => entry.default === true)
    }

- [ ] **Step 4: Wire the schema into Config**

In lib/ssh-shell/index.js add to the Config object:

    hosts: z.array(z.object({})).default([]).volatile(),

and normalize through validateHosts in apply; an invalid array logs the error
once and the tool registers with zero hosts (every call then fails with the
same message).

- [ ] **Step 5: Run the audit**

Run: node smoke/prepare.mjs audit
Expected: PASS for the new block.

- [ ] **Step 6: Commit**

git add lib/ssh-shell/hosts.js lib/ssh-shell/index.js smoke/audit.test.mjs
git commit -m "feat(ssh): validate the host registry"

## Task 3: known_hosts verifier

**Files:**
- Create: lib/ssh-shell/known-hosts.js
- Test: smoke/audit.test.mjs

**Interfaces:**
- export function parseKnownHosts(text): { hosts: string[], type: string, blob: Buffer, line: number }[]
- export function verifyHostKey({ host, port, key, knownHostsPath, acceptNewHostKeys }):
  { ok: boolean, fingerprint: string, warning?: string, reason?: string }

- [ ] **Step 1:** Add assertions for plain, [host]:port, hashed (|1|salt|hmac), mismatch, missing-entry, and acceptNewHostKeys cases to smoke/audit.test.mjs; generate the fixture key with ssh2.utils.generateKeyPair('ed25519').
- [ ] **Step 2:** Run node smoke/prepare.mjs audit; expect failure (module missing).
- [ ] **Step 3:** Implement parsing (skip comments/markers, split host list, base64 blob) and matching (literal or HMAC-SHA1 for hashed entries; candidate host is host for port 22, [host]:port otherwise). Compare parseKey(key).getPublicSSH() type/blob; fingerprint is SHA256 base64 without padding.
- [ ] **Step 4:** Run node smoke/prepare.mjs audit; expect PASS.
- [ ] **Step 5:** Commit: git add lib/ssh-shell/known-hosts.js smoke/audit.test.mjs && git commit -m "feat(ssh): verify host keys against known_hosts".

## Task 4: POSIX script builder

**Files:**
- Create: lib/ssh-shell/script.js
- Test: smoke/audit.test.mjs

**Interfaces:**
- export function buildScript({ startupCommand, workdir, command }): { script: string, payload: string }

- [ ] **Step 1:** Add assertions: plain command ends with newline; startup wraps as { startup; } || exit $?; workdir is single-quote escaped; base64 round-trips to the script.
- [ ] **Step 2:** Run the audit; expect failure.
- [ ] **Step 3:** Implement with quote(value) = "'" + value.replace(/'/g, "'\\''") + "'"; join startup, workdir (cd -- quoted || exit $?), command with newlines; payload is base64 of UTF-8.
- [ ] **Step 4:** Run the audit; expect PASS.
- [ ] **Step 5:** Commit: git add lib/ssh-shell/script.js smoke/audit.test.mjs && git commit -m "feat(ssh): build the remote POSIX script".

## Task 5: ssh2 connection pool

**Files:**
- Create: lib/ssh-shell/pool.js
- Modify: lib/ssh-shell/index.js
- Test: smoke/audit.test.mjs

**Interfaces:**
- export class SshPool { constructor({ knownHostsPath, log }); get(entry): Promise<Client>; dispose(): void; size(): number }

- [ ] **Step 1:** Add an in-process ssh2.Server fixture (generated ed25519 host key, accept auth, exec streams) and assert two get() calls reuse one client and exec returns the streamed output.
- [ ] **Step 2:** Run the audit; expect failure.
- [ ] **Step 3:** Implement: one record per alias; connect with readyTimeout, keepalive 15s x3, privateKey from keyPath, passphrase from process.env[entry.passphraseEnv], hostVerifier delegating to Task 3; delete the record on error/close.
- [ ] **Step 4:** Run the audit; expect PASS.
- [ ] **Step 5:** Commit: git add lib/ssh-shell/pool.js lib/ssh-shell/index.js smoke/audit.test.mjs && git commit -m "feat(ssh): pool one ssh2 connection per host".
## Task 6: exec channel, output isolation and abort

**Files:**
- Modify: lib/ssh-shell/index.js
- Test: smoke/audit.test.mjs

**Interfaces:**
- SshShellExecutor.execute(spec) / resolve(spec) return a handle with
  result(): { stdout, stderr, exitCode, signal, timedOut, aborted, durationMs }.
- The channel settles on 'exit', waits at most 100 ms for close, then destroys;
  late bytes are discarded and never reach the next call.

- [ ] **Step 1:** Add tests over the ssh2.Server fixture: exit code 7; stderr separated; timeout sends TERM then KILL (record 'signal' requests); a delayed writer's output never appears in the next call's stdout.
- [ ] **Step 2:** Run the audit; expect failure.
- [ ] **Step 3:** Implement: get the client from the pool, open exec(''), write the base64 payload and end stdin, collect stdout/stderr, record exit, arm a 100 ms force-destroy on exit, map timeout/abort to the TERM-2s-KILL-destroy sequence.
- [ ] **Step 4:** Run the audit; expect PASS.
- [ ] **Step 5:** Commit: git add lib/ssh-shell/index.js smoke/audit.test.mjs && git commit -m "feat(ssh): run commands over pooled exec channels".

## Task 7: tool wiring, parameters and audit

**Files:**
- Modify: lib/tool-bash/types/ssh-shell.js
- Modify: lib/shell-dialects.js
- Modify: lib/tool-bash/types/factory.js
- Modify: lib/client.js and smoke/gen-client-registry.mjs
- Test: smoke/audit.test.mjs

**Interfaces:**
- ssh_shell parameters: alias (required), command, description?, workdir?, timeoutMs?, run_in_background?.
- The row config exposes only sshShell.hosts (plus the shared tool-layer switches).

- [ ] **Step 1:** Change the dialect fields to [{ leaf: 'hosts', kind: 'hosts' }]; update facts and description (remote effects, no stdin, known_hosts, session authorization).
- [ ] **Step 2:** Remove the old pins (sshPath/sshHost/sshUser/sshPort/acceptNewHostKeys/connectTimeoutMs) from the row schema and description; add the alias parameter.
- [ ] **Step 3:** Run the audit; update the field-table assertions and the generated client registry. Add a temporary hosts field (JSON text) to lib/client.js so the browser form stays in sync with the host schema; Plan 4 replaces it with the table editor.
- [ ] **Step 4:** Run node smoke/prepare.mjs audit and npm test; expect PASS.
- [ ] **Step 5:** Commit: git add -A && git commit -m "feat(ssh): wire the ssh_shell tool to the pool".

## Task 8: jobs and timeout promotion

**Files:**
- Modify: lib/ssh-shell/index.js (handle contract)
- Modify: lib/tool-bash/types/factory.js only if the handle shape needs a hook
- Test: smoke/audit.test.mjs

**Interfaces:**
- The handle exposes the same local-executor fields: result(), kill(reason), and the output source used by startJob.
- run_in_background returns { kind: 'background', jobId, cwd }; promotion returns { kind: 'promoted', jobId, timeoutMs, output }.

- [ ] **Step 1:** Add job tests with a fake jobs registry over the ssh2.Server fixture: background registration, streamed job_output, job_kill TERM then KILL, promotion, refused admission.
- [ ] **Step 2:** Run the audit; expect failure.
- [ ] **Step 3:** Implement the handle contract and reuse the factory job path. Do not add a plugin-level concurrency limiter; surface the registry's refusal verbatim.
- [ ] **Step 4:** Run node smoke/prepare.mjs audit and npm test; expect PASS.
- [ ] **Step 5:** Commit: git add lib/ssh-shell/index.js lib/tool-bash/types/factory.js smoke/audit.test.mjs && git commit -m "feat(ssh): integrate ssh_shell with ctx.jobs".

## Task 9: Documentation and migration notes

**Files:**
- Modify: docs/configuration.md, docs/architecture.md, README.md, README.zh.md
- Create: the 0.8.0 RELEASE_NOTES section

- [ ] **Step 1:** Document the hosts array, known_hosts requirement, startup command, the sshBash -> sshShell migration, and the remote-effects/no-stdin facts.
- [ ] **Step 2:** Update the architecture map for the pool, channel, jobs and the unchanged terminal PTY path.
- [ ] **Step 3:** Run node smoke/prepare.mjs audit (the audit pins README/doc tables); expect PASS.
- [ ] **Step 4:** Commit: git add -A && git commit -m "docs(ssh): document ssh_shell hosts and migration".

## Plan Acceptance

1. ssh_shell is registered under the renamed row and exports; ssh_bash no longer appears in code, docs or audit assertions.
2. sshShell.hosts validates and names the field and alias on failure.
3. known_hosts is enforced; unknown or mismatched keys are refused with fingerprints; acceptNewHostKeys is per host and off by default.
4. A command runs over a reused ssh2 connection with correct stdout, stderr and exit code; a second call does not open a second TCP connection.
5. Timeout and abort send TERM then KILL; late output is dropped and never reaches the next call.
6. run_in_background registers a job; job_output streams; job_kill terminates; promotion returns a job id.
7. npm test and node smoke/prepare.mjs audit are green.

## Deferred

- Plan 2: ssh_scp. Plan 3: authorization gate and dedicated approval card. Plan 4: hosts table GUI, migration docs and the 0.8.0 release.
