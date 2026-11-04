# ssh_shell — pooled SSH command execution and scp transfers

Status: design approved 2026-11-05. Implementation plan pending.
Target release: 0.8.0 (breaking rename of ssh_bash).

## 1. Summary

Replace the one-shot ssh_bash dialect with ssh_shell: a multi-host, key-only SSH
command tool backed by a persistent ssh2 connection pool, plus ssh_scp for file
transfer. Each command call runs in its own exec channel, so calls are isolated,
parallel-safe, and cancellable. Background execution and timeout promotion go
through the existing ctx.jobs registry. The tool keeps the family result shape
(stdout/stderr/exit code) and reports remote effects honestly.

The terminal form is not changed in this release beyond the rename: a terminal
session still runs a real PTY over the OpenSSH client, configured by its own row
pin. Sharing the multi-host registry with terminal is future work.

## 2. Goals

- Rename tool ssh_bash -> ssh_shell, config partition sshBash -> sshShell, and
  the terminal shell enum value. Row id stays win-mb-tool-ssh.
- Host inventory configured in the web UI: many hosts, key authentication,
  invoked by alias.
- Persistent connection pool: one TCP connection per host, reused across calls.
- Per-call startup command (environment initialisation, e.g. launch Git Bash on
  a Windows host and set variables).
- Full ctx.jobs integration: run_in_background, timeout promotion, job_output,
  job_kill.
- Precise output isolation: delayed output from a completed call never reaches a
  later call.
- Cancellation semantics: timeout/cancel sends a real remote signal; a lost
  connection tears the remote session down.
- ssh_scp: upload/download files and directories over SFTP, with local paths
  subject to the workspace sandbox.
- Host authorization: intercept an unauthorized host, ask the human once per
  session through a dedicated approval card, and remember the grant in memory
  for that session only.

## 3. Non-goals

- Stateful command state across calls (cd, exported variables). That is what
  terminal sessions are for.
- Password or ssh-agent authentication in 0.8.0. Key files only; a passphrase
  may be supplied through an environment variable (never stored in config).
- Interactive/PTY commands through ssh_shell (no stdin, no TUI). Use terminal.
- Port forwarding, host clustering, jump hosts (ProxyJump), and ProxyCommand.
- Sharing the multi-host registry with terminal (future work).
- Host-key trust-on-first-use writes to known_hosts (accept-with-warning only).
- Durable authorization grants (disk or project scope). 0.8.0 keeps session
  grants in memory and loses them on plugin reload; a project scope and a
  per-call-only policy are future work.

## 4. Naming and migration

| Surface | 0.7.x | 0.8.0 |
| --- | --- | --- |
| Tool name | ssh_bash | ssh_shell |
| Config partition | sshBash | sshShell |
| Row id | win-mb-tool-ssh | unchanged |
| Patch row name | .../tool-ssh-bash | .../tool-ssh-shell |
| Export subpath | ./tool-ssh-bash | ./tool-ssh-shell |
| Executor module | lib/bash-ssh/index.js | lib/ssh-shell/index.js |
| Terminal shell enum | ssh_bash | ssh_shell |
| Terminal config partition | sshBash | sshShell |

This is a hard rename. The old configuration is not honoured at runtime; the
release notes and docs/configuration.md carry a migration section. A profile that
still lists sshBash under the ssh row is reported by the loader as an unknown
key; the tool then runs with defaults and no hosts, and every call fails with
"no hosts configured", which is the honest diagnostic for a stale config.

## 5. Architecture

One SshEngine per tool row (per plugin load):

- HostStore — reads the row's sshShell.hosts array (volatile), validates it,
  resolves aliases, and never exposes key material to the model.
- ConnectionPool — one ssh2.Client per alias, lazily connected, reused for exec
  channels and SFTP. A broken client is disposed and reconnected by the next
  call. The pool lives for the plugin lifetime; disposal closes every client.
- CommandRunner — one exec channel per call, job or foreground.
- ScpRunner — SFTP operations over the same pooled connection.

There is no plugin-level concurrency limiter. Concurrency is bounded by:

1. ctx.jobs global/per-owner job limits (background work);
2. the agent loop's parallel tool calls and the number of sessions (foreground
   work);
3. the SSH server's MaxSessions per connection (physical channel limit).

When the server refuses a channel, the runner retries with backoff until the
call's timeout (foreground) or a bounded retry budget (background), then reports
the server error verbatim. It never silently drops a call.

## 6. Host inventory

sshShell.hosts is an array of objects in the ssh row's configuration:

    interface SshHostConfig {
      alias: string;               // required; unique; /^[A-Za-z0-9][A-Za-z0-9._-]*$/
      host: string;                // required; hostname or IP; no whitespace
      port?: number;               // 1..65535, default 22
      user: string;                // required
      keyPath: string;             // required; absolute path or ~/...
      passphraseEnv?: string;      // env var name holding the passphrase; never the value
      startupCommand?: string;     // POSIX shell snippet, run before every command
      shellTemplate?: string;      // launcher that reads a base64 script from stdin
      connectTimeoutMs?: number;   // default 30000; whole handshake + auth ceiling
      approval?: "trusted" | "session"; // default "session"; see section 11
      acceptNewHostKeys?: boolean; // default false (strict known_hosts)
      default?: boolean;           // at most one; used when alias is omitted
      description?: string;
    }

Validation runs at config read and at call time. Missing key files, duplicate
aliases, two defaults, or a malformed alias fail with a message naming the field
and the alias.

The row stays opt-in (defaultEnabled false): with no hosts configured the tool
registers but every call fails with "no hosts configured". The tool joins the
family prompt section like the other dialects; its description states the
remote-effects and no-stdin facts.

### 6.1 GUI

The ssh row's Configure page gains a hosts table: add/remove rows, edit text and
number fields, mark a default row, and choose the authorization policy
(trusted/session), and save through the existing config form.
The browser half cannot import this package, so the field descriptor and host
schema are generated into smoke/gen-client-registry.mjs and pinned by the audit
(the existing client-registry rule). The table is a new field kind (hosts) in
the client form renderer; text values are stored trimmed, numbers as numbers,
and blank optional fields cleared.

ssh_list is the model-facing view: alias, host, port, user, default, keyReady,
approval, description, acceptNewHostKeys. It never returns key paths or
passphrases (keyReady is a boolean).

## 7. Transport and authentication

- Dependency: ssh2 ^1.17.0 (runtime dependency, not a peer). THIRD_PARTY_NOTICES
  is updated; license is MIT.
- Connect config: host, port, username, privateKey read from keyPath, optional
  passphrase from passphraseEnv, readyTimeout: connectTimeoutMs,
  keepaliveInterval: 15000, keepaliveCountMax: 3, tryKeyboard: false.
- Encrypted key without a resolvable passphrase fails with a message naming
  passphraseEnv; no passphrase is ever written to config or logs.
- Idle connections are not closed by a timer; the pool lives with the row and is
  closed on disposal. A broken client is replaced on the next call.

### 7.1 Host-key verification

known_hosts is parsed by us (no auto-accept):

- Paths: $HOME/.ssh/known_hosts (and known_hosts2 when present); Windows uses
  %USERPROFILE%/.ssh/known_hosts.
- Support plain entries, [host]:port entries, multiple key types, comments, and
  hashed host names (|1|salt|hash, HMAC-SHA1).
- The presented key is parsed with ssh2.utils.parseKey; its type and base64 blob
  must match an entry for the target.
- No entry -> refuse with "host key not found in known_hosts" and the expected
  path. A changed key -> refuse with both fingerprints.
- acceptNewHostKeys: true accepts an unknown key with a one-time warning per
  connection. It never writes the file; the warning tells the user how to add
  the entry.

## 8. Command execution

### 8.1 Request

ssh_shell(alias, command, description?, workdir?, timeoutMs?, run_in_background?).
alias is required unless exactly one host has default: true.

### 8.2 Remote script

The command is sent as a POSIX script on the channel's stdin, base64-encoded.
The remote command line is the host's shellTemplate, default:

    bash -c 'eval "$(base64 -d)"'

The template is static per host; no user text is interpolated into it. This is
what makes command quoting safe on any host whose template can launch a POSIX
shell. A Windows host whose login shell is cmd.exe sets a template such as:

    "C:\Program Files\Git\bin\bash.exe" -c "eval \"$(base64 -d)\""

and validates it once per host. base64 is delivered by Git Bash / coreutils; a
missing base64 surfaces the shell's error verbatim.

The script layout is:

    { <startupCommand>; } || exit $?
    cd -- <quoted workdir> || exit $?    # only when workdir is given
    <command>

The command runs in a fresh shell each call. Startup runs before the command in
the same shell, so exported variables and cd from startup apply to the call and
vanish afterwards. The startup guard line is omitted when startupCommand is
empty. workdir is an absolute path ON THE REMOTE HOST; the local session cwd is
not used, and the value is single-quote escaped before it is placed in the
script. The script is never interpolated into the shellTemplate.

### 8.3 Result

Same shape as the family's foreground result: kind "foreground", cwd, exitCode,
signal, timedOut, aborted, timeoutMs, stdout (text, truncated, optional
spillPath), stderr, and sandbox { mode, remote: true }. cwd is the remote
workdir when one was given and the empty string otherwise (the renderer says
"remote" rather than inventing a local path). Output caps and spill follow the
row's maxOutputBytes / maxSpillBytes knobs.

### 8.4 Output isolation

- stdout and stderr are separate channel streams.
- The call settles on the channel's exit event (exit status known), waits at
  most 100 ms for trailing bytes, then destroys the channel. Any bytes that
  arrive after settlement are discarded and logged at debug level.
- A background child that inherited the channel's stdout therefore cannot leak
  into the next call: the channel is closed and the child gets a broken pipe on
  its next write.
- Output is decoded as UTF-8. Hosts whose shell emits a legacy code page (for
  example cmd.exe without the Git Bash template) may produce mojibake; the
  template is the supported fix.

### 8.5 Timeout and cancellation

- Timeout budget is per call, measured from channel open.
- On timeout or caller abort: send SIGTERM via the SSH signal request, wait up
  to 2 s, send SIGKILL, close the channel. Result: timedOut true or aborted
  true, exitCode null, with the phase in the error text.
- Background/promoted jobs do not time out: once handed to the job registry the
  channel keeps running until exit or job_kill.
- A whole-connection loss takes the remote session down with it (sshd tears the
  session down). Commands that detach themselves (nohup, setsid) are documented
  as surviving by design.
- Silent network loss is detected by keepalive (15 s x 3); in-flight calls fail
  with "connection lost" and their jobs settle failed.

## 9. Jobs

The runner implements the same handle contract the local executors use:
resolve(spec) returns a handle with an output source, result(), and kill(reason).
The factory's existing job and promotion paths are reused.

- run_in_background true: open the channel, register the job immediately, return
  { kind: "background", jobId, cwd }. Output streams into the job ring as it
  arrives; exit settles the job with the exit code.
- Timeout promotion (when ctx.jobs is present and promoteOnTimeout is on):
  register the job before starting, wait for it; when the call's budget expires
  return { kind: "promoted", jobId, timeoutMs, output } and leave the job
  running. job_output continues from the same ring; job_kill terminates.
- Job admission refused: an explicit run_in_background call throws the registry's
  error verbatim; the promotion path falls back to a foreground call with the
  deadline kill, matching the local factory.
- job_kill: SIGTERM -> 2 s -> SIGKILL -> close; the job settles killed.
- The tool declares isConcurrencySafe: () => true.

## 10. ssh_scp

ssh_scp(action: "upload" | "download", alias, localPath, remotePath, recursive?,
timeoutMs?). Foreground only: transfers are not registered as jobs.

- Runs over SFTP on the pooled connection.
- Local path: resolved against the session cwd. It must be inside the workspace
  root; when the effective sandbox mode is danger-full-access an outside path is
  allowed and the result says so. A refused path uses the plugin's standard
  sandbox sentence.
- Remote path: absolute POSIX path. SFTP on Windows OpenSSH expects the /C:/...
  drive form; the tool description states this.
- Upload creates remote parent directories; download creates local parent
  directories. recursive walks directories.
- Default timeout 5 min per operation; the timeout aborts the SFTP stream and
  returns a structured error.
- Result: { ok, bytes, files?, error? }.

## 11. Host authorization gate

ssh_shell and ssh_scp must not use a host the human has not authorized. The
gate runs before any connection or channel is opened:

- host.approval is "trusted" (never ask) or "session" (default; ask once per
  session, then remember in memory for that session). Project- or
  disk-persisted grants and a per-call-only policy are out of scope for 0.8.0.
- Session grants live in a WeakMap keyed by the Session object. They are never
  written to disk, never shared between sessions, and disappear when the
  session is collected or the plugin reloads; a reloaded session asks again.
  This is session-memory persistence, not durable authorization.
- The grant key is a fingerprint over alias, host, port, user, keyPath and
  passphraseEnv. Editing any connection field invalidates the grant.
- On a miss the tool calls ctx.approval.request with agent, toolName, callId,
  signal and a reason naming the alias, user@host:port, the scope and its
  consequence. The request is the single action "authorize this session's use
  of this host"; the dedicated card's allow button answers allowed-once and
  exactly that action is granted.
- allowed-once records the session grant and proceeds. rejected and cancelled
  throw without connecting. unavailable fails closed with a message naming the
  missing answerer and the "trusted" escape hatch. A session approval policy of
  "never" rejects deterministically.
- Concurrent misses for the same host in one session share one in-flight
  approval promise.
- Unknown aliases fail before any prompt. trusted is the explicit
  pre-authorization for headless use; neither the model nor a tool argument can
  set it.
- The gate covers ssh_shell and ssh_scp. terminal keeps its own explicit
  single-host pin in 0.8.0 and is out of scope.

### 11.1 Dedicated approval card

The shared approval card (conversation.approval.card) is a single factory with
fixed allow-once/reject buttons and no button slot, so the plugin contributes
its own card for ssh approvals instead of modifying the shared one:

- The browser half registers a conversation.composer chain entry at priority 0
  (the shared approval composer runs at priority 1). Its select matches only
  pending approvals whose toolName is ssh_shell or ssh_scp; everything else
  returns null and keeps the standard card.
- The card shows the request reason and two buttons: "Allow for this session"
  (answers allowed-once) and "Deny" (answers rejected). The host's
  session-grant logic runs on allowed-once exactly as before, so no new RPC or
  approval service is involved and the approval audit events are unchanged.
- The card is a small behavior-compatible reimplementation built from the
  plugin's existing React + ui-primitives surface, matching the shared card's
  look. It does not vendor @deepseek-ai/dsh-client-ui-approval source and
  carries no third-party source notice.
- If the chain registration is unavailable on an older host, the request still
  works through the standard card; only the button copy differs.
- Enter/Esc shortcuts stay owned by the shared approval plugin; the custom
  card activates its own buttons by mouse/keyboard, and the shared shortcuts
  may not target it. Documented as a minor UX gap.

## 12. Terminal

- The terminal tool's shell enum becomes ssh_shell; the terminal row's ssh pin
  partition is renamed to sshShell with the same single-host fields (sshPath,
  sshHost, sshUser, sshPort, acceptNewHostKeys, connectTimeoutMs).
- The PTY form keeps using the OpenSSH client (ssh.exe -t), so interactive
  prompts, host-key questions and terminal semantics are unchanged.
- The terminal ssh backend does not read the multi-host table in 0.8.0. This is
  documented as a known limitation; a later release can bridge the registry.
- No startup command for terminal sessions in 0.8.0.

## 13. Errors and observability

Every failure names the alias and the phase: config, connect, host-key, auth,
channel, exec, timeout, aborted, disconnected, sftp. The underlying ssh2 message
is kept in the error text. Keys, passphrases and file contents are never logged.

## 14. Security and sandbox

- Remote commands are remote effects: the local file sandbox is not applied;
  results carry sandbox { mode, remote: true }.
- ssh_scp local effects are sandboxed as described above.
- Host keys are verified against known_hosts; auto-unverified connections are
  never made.
- Config contains key paths and an optional environment variable name, never
  secret values.
- acceptNewHostKeys is per host and off by default.
- Authorization grants are in-memory and session-scoped: the agent cannot
  create, widen or persist them, and there is no grant file to tamper with.
  The host config's "trusted" flag is the only pre-authorization and is
  editable only in the GUI.

## 15. Testing

Unit tests (no network):

1. Host validation: duplicates, missing fields, bad alias, two defaults, port
   bounds.
2. known_hosts: plain, [host]:port, hashed entries, multiple key types,
   mismatch, missing file.
3. Script builder: startup guard, workdir quoting, base64 round-trip, command
   with quotes/newlines, empty command.
4. Job lifecycle against a stub ssh2.Client: output streaming, exit settlement,
   late-output discard, timeout signal order (TERM then KILL), caller abort, job
   kill, admission refusal.
5. ssh_scp path resolution and sandbox refusal.
6. ssh_list secret-free projection.
7. Authorization gate: trusted bypass; session grant reuse within one session;
   a second session prompts again; rejection/cancellation/unavailable fail
   closed; a changed connection fingerprint re-prompts; concurrent misses
   coalesce into one request.
8. Client registry: the generated registry carries the composer chain entry,
   its priority, and the ssh_shell/ssh_scp matcher; the audit pins them and
   proves no other tool name matches.

Integration tests (deterministic, in-process): an ssh2.Server fixture with a
generated host key serves exec and SFTP; the pool connects to it, so channel,
job, timeout and scp paths run without a real network. A live-host smoke test
(ubuntu_tx) stays manual.

Audit updates: field tables (client vs host config), patch rows, exports, tool
names, terminal enum, and the generated client registry all change and must be
pinned.

## 16. Rollout

- Version 0.8.0. RELEASE_NOTES migration section; docs/configuration.md and
  docs/architecture.md updated.
- package.json gains the ssh2 dependency; package-lock.json is regenerated; the
  third-party notice list is updated.
- CI must be green before the tag and release; npm after the GitHub release.
- Existing users of ssh_bash move to ssh_shell; the migration text includes a
  sample hosts array and the sshBash -> sshShell rename.

## 17. Verified facts behind this design

- ssh2 auto-accepts host keys when hostVerifier is not set (README).
- stream.signal('KILL') kills the remote process; closing only the channel
  leaves it running; ending the whole connection takes the session down
  (measured on a Linux OpenSSH target).
- A background child holding the channel's stdout delays channel close; doing
  stream.destroy() on the exit event closes promptly and drops subsequent
  output; the next call is clean.
- Win32-OpenSSH does not support ControlMaster multiplexing (measured: the
  master exits, the socket is dead, the client falls back to a direct
  connection), so a per-call ssh.exe pool is not viable; channels are the right
  transport.
- Cold ssh.exe calls cost roughly 0.5-1.1 s; a pooled channel costs the RTT and
  tens of milliseconds.

## 18. Acceptance criteria

1. ssh_list returns the configured hosts and no secrets.
2. ssh_shell with an alias runs a command over one pooled connection and returns
   stdout, stderr and the exit code; a second call reuses the connection.
3. A command with run_in_background true returns a job id; job_output streams;
   job_kill stops the remote process (verified by pgrep on the test host).
4. A foreground call that exceeds its budget with promotion enabled returns a
   job id and the job completes.
5. A command that spawns a delayed writer leaves no bytes in the next call's
   result.
6. Timeout and cancel produce timedOut/aborted and the remote process is gone
   (pgrep).
7. A dropped connection fails the call and settles its job as failed.
8. ssh_scp uploads and downloads a file and a directory tree; a local path
   outside the workspace is refused under workspace-write.
9. Host key mismatch and missing known_hosts entry are refused with the
   fingerprint and the expected file.
10. The full audit suite passes, and the client/host field tables are in sync.
11. A host with approval "session" prompts on its first use in a session, does
    not prompt again in that session, prompts again in another session, and a
    denied request leaves the host unusable there. A host with "trusted" never
    prompts. The prompt uses the dedicated card with "Allow for this session"
    and "Deny" buttons; other tools keep the standard approval card.
