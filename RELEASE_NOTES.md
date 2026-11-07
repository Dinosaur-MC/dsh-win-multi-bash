# dsh-win-multi-bash v0.8.0

## New

- **`ssh_shell` reaches a whole registry of hosts, one alias at a time.** `sshShell.hosts` is an array of objects — `alias`, `host`, `port` (22), `user`, `keyPath`, `passphraseEnv`, `startupCommand`, `shellTemplate` (blank = precise passthrough into the remote login shell; a value is an explicit wrapper reading a base64 script from stdin), `connectTimeoutMs` (30000), `approvalTimeoutMs` (120000; `0` waits forever, else 1000–3600000), `approval` (`session`), `acceptNewHostKeys` (off), `default` and `description`. Aliases are unique, at most one host may be `default` (zero is valid: a call then names its alias), and the registry is validated once per stored value. A failure names the field and, where it has one, the alias — the array-level failures (`hosts must be an array`, `each host must be an object`) and `more than one default host` cannot name a single alias; the default message may list the aliases. An invalid array leaves the row registered and every call says `sshShell.hosts is invalid (<the field, and the alias where the failure has one>)`; a valid empty one says no hosts are configured. A call never picks a host it was not told or given as the default.
- **Test an unsaved host from the hosts table.** Each row has a **Test connection** action: it dials the row's current (unsaved) values, verifies the host key against `known_hosts` (a changed or `@revoked` key is still refused), authenticates with the named key, and executes no command. The inline result shows the presented fingerprint on success or the failed phase (`config`, `connect`, `host-key`, `auth`) and its message; the test is a human action and does not consume an agent approval grant, and it never writes `known_hosts`. Save stays explicit.
- **One pooled ssh2 connection per host, one exec channel per call.** The command form no longer starts a local `ssh.exe`: it drives ssh2 (~1.17.0) directly, reuses one TCP/SSH connection per alias, and gives every call its own channel, so concurrent commands interleave safely and a background call cannot swap output with a foreground one. Cancelling a call signals the remote process (TERM, then KILL 2 s later) instead of only closing the channel; a channel that closes without an exit status is reported as a lost connection and **fails** the call or job — never as a completed run.
- **Host keys are strict, like OpenSSH.** `known_hosts` and `known_hosts2` are read together; hashed entries, wildcard and negated patterns and `@revoked` are honoured, and a non-default port matches its `[host]:port` identity. A changed key is refused by name and a missing `known_hosts` file is reported as a host-key failure (there is nothing to verify the presented key against). `acceptNewHostKeys` (off by default) accepts an unknown key for **one connection** and never writes the file; it never bypasses a changed key. `@cert-authority` entries are not honoured in 0.8.0.
- **`ssh_hosts` lists the registry without touching a credential.** The third tool on the ssh row is a read-only inventory: optional `query` (case-insensitive over alias/host/user/description), `approval` (`session`/`trusted`) and `defaultOnly`; `{ hosts, total, matched }` in configured order with `hasStartupCommand`/`hasShellTemplate` booleans. It never returns `keyPath`, `passphraseEnv` or any key material, opens no connection and asks for no approval; an empty registry is a successful empty list.
- **Per-host startup commands and a real remote working directory.** `startupCommand` is a POSIX snippet run before the command on that host; `workdir` is an absolute path **on that host** — POSIX `/...` or a Windows drive path `X:\...` / `X:/...` — and the shell family chooses `cd --` or `cd /d`. A UNC `\\server\share...` is accepted for `ssh_scp`'s `remotePath`, but as a `workdir` it is refused on a cmd host (cmd cannot `cd /d` into a UNC path; use `pushd` in the command). Only a relative path is refused locally (a POSIX host given a Windows path reports the remote shell's own error).
- **Background work, promotion and `job_kill`.** A call may run as a platform job, promote on timeout, and be killed: the job owns the remote process, a kill signals it on the host, and a lost connection settles the job **failed** with the reason. Background and job-owned calls retry a refused channel open at most four times; a foreground call retries until its own deadline instead.
- **`ssh_scp` transfers files and trees over SFTP.** One row serves the command tool, the transfer tool and the read-only inventory: a transfer reuses the same `sshShell.hosts` entry, the same pooled connection and the same host-key check. It uploads or downloads a file or a directory tree (empty directories are preserved), bounds one operation with its own deadline (default `300000` ms, five minutes), and is **foreground only** — no `run_in_background`, no promotion, no job. Its local side is guarded: `workspace-write` resolves `localPath` against the session's working directory, refuses anything lexically outside it with the family's sandbox sentence, then refuses a symlink/junction target and re-checks the realpath of the deepest existing ancestor. Recursive walks also refuse remote-controlled entry names (`.`, `..`, embedded `/` or `\`) and re-check every target after creating it; `danger-full-access` remains the way out. The check and the stream are not atomic — TOCTOU remains a known limitation. Every result is a value — `{ ok, bytes, files?, error?, sandbox, outsideWorkspace? }` — with the `error.phase` naming `config`, `approval`, `sandbox`, `connect` or `sftp`, so a failed transfer is inspectable instead of thrown. Remote paths accept POSIX `/...`, a Windows drive path (`C:\...` or `C:/...`, normalized to `/C:/...`) or UNC `\\server\share`; a relative path is refused before any dial.
- **A session authorization gate in front of every dial.** Each host's `approval` is `trusted` (never ask) or `session` (the default): on `session`, the first use of that host in a conversation asks through the platform's approval service and the grant lives **in memory, for that session only** — one prompt per host. A prompt is bounded by the host's `approvalTimeoutMs` (default 120000, `0` waits forever): on timeout the pending card is withdrawn (the request signal is aborted) and the call fails closed with `approval timed out after <N> ms` (`phase: approval`, `outcome: timeout`), nothing is cached, and a concurrent waiter receives the same timeout instead of a fresh prompt. The fingerprint that decides whether a grant still applies is only `alias`, `host`, `port`, `user`, `keyPath` and `passphraseEnv` — editing any of those six asks again, while editing `startupCommand`, `shellTemplate`, `connectTimeoutMs`, `approvalTimeoutMs`, `acceptNewHostKeys`, `approval`, `default` or `description` does not. Refusal, cancellation or no answerer fails closed with phase `approval` (`ssh_shell` throws the named error; `ssh_scp` returns it as its structured value), and `approval: trusted` is the documented way to pre-authorize headless use.
- **Only channel capacity is retried.** When the server refuses a new channel for capacity — `MaxSessions`, `administratively prohibited`, `channel open failure`, `open failed`, `resource shortage` — the OPEN is retried at 100/200/400 ms, capped at 1 s, never the command. Authentication, host-key, handshake, socket and passphrase failures, and every SFTP operation error, are never retried. When retrying stops, the error is the server's **last refusal verbatim** plus a note saying why (the call deadline expired, or `gave up after N attempts`); it is never a synthetic timeout, and an abort stays the platform's abort.

## Improvements

- **Passthrough detects a cmd login shell and joins by its rules.** A blank `shellTemplate` probes the host once per connection with `echo __DSH_SHELL__%COMSPEC%__`; a drive-letter `%COMSPEC%` classifies cmd, and any probe failure/timeout falls back to posix without touching the call's result. Posix passthrough keeps LF and `cd -- <quoted>`; cmd passthrough emits one `&&`-joined line prefixed by `chcp 65001>nul`, with startup, `cd /d "<path>"` and the command flattened so multi-line commands actually run (Windows sshd runs only the first LF line otherwise). `chcp 65001` makes external programs and PowerShell output UTF-8, but cmd builtins (`dir`, `type`) may still emit the OEM code page; for non-ASCII output or command text prefer PowerShell or a wrapper template. Template mode is untouched and never probes.
- **A blank `shellTemplate` now means precise passthrough.** The built script (startup block, then `cd -- <quoted workdir>` when set, then the command) is the channel command line itself, so the remote host's own login shell runs it with no extra shell hop and no base64/stdin. A non-empty `shellTemplate` remains an explicit wrapper (base64 script on stdin) and is unchanged; a saved old default keeps working because it is an explicit value. Blank is never silently migrated, which matters on a Windows host whose `bash` is the WSL launcher: leaving the box empty cannot tunnel the command into WSL, while pinning Git Bash as the wrapper still can.
- **The ssh Configure page shows only the sandbox knob that applies.** The local-sandbox stance, `probeTimeoutMs` and `sandboxNotice` are hidden on a remote-effects row (they cannot affect a remote command); `requireSandbox` stays on local rows with its local probe-failure wording; the remote row gets its own `requireSandboxRemote` label/hint ("Allow only danger-full-access runs") instead of the local text. The schema still accepts the hidden knobs for backward compatibility. The filter is derived from the dialect's declared `effects`, not from a row name.
- **The host registry has a real table editor.** The ssh row's page draws one card per host with every field above, an exclusive `default` radio, an `approval` select, Add/Remove, and inline validation that blocks the save while a row is invalid (blank required field, malformed or duplicate alias, port outside 1..65535, a non-object entry, more than one default) — the page never shows JSON text. Empty optional fields are cleared from the saved object, and the write plan refuses an invalid table.
- **A dedicated authorization card for this bundle's prompts.** A `conversation.composer` chain entry at priority 0 claims only `ssh_shell`/`ssh_scp` pending approvals and renders the platform approval card's own structure (waiting strip, body, description, action row) with the alias and request sentence, plus three actions: **Reject**, **Allow once** (a TRUE one-shot: the card first records the call id and scope `once` on the terminal row's scope route, and the gate grants this call without caching it — the next call asks again), and the primary **Allow for this session** (the same mark with scope `session`, which the gate caches). An unmarked grant is treated as one-shot (fail closed); every other approval keeps the platform's shared card. A failed mark leaves the approval pending; a failed ANSWER re-enables the card with the failure, clears the scope mark it just wrote (the pending approval itself stays), and never pretends the request settled.
- **Errors place the failure.** Where a host is involved, a failure names its alias; where a stage applies, the message identifies the failed stage (`config`, `sandbox`, `connect`, `host-key`, `auth`, `channel`, `exec`). Configuration failures are about the registry, not a host — `no hosts are configured` and `sshShell.hosts is invalid (...)` have no alias, and `ssh_shell` reports every failure by a named error and its detail rather than through a structured `phase`. A timeout, an abort and a lost connection are outcomes reported as such (`timedOut`, the platform abort, `disconnected`) rather than phases. `ssh_scp` returns a structured value whose `error.phase` is exactly one of `config`, `approval`, `sandbox`, `connect` or `sftp`. A background acknowledgement carries no invented verdict, and a foreground result states the sandbox fact it actually observed (`sandbox: { mode, remote: true }`).

## Bug fixes

- A cancelled pending channel open no longer leaks a pooled connection lease: the lease is released before the client is retired, so a burst of cancellations cannot exhaust the pool.
- SFTP subsystem refusals are classified as capacity refusals and bounded (four attempts) instead of surfacing raw ssh2 text; `Unable to start subsystem` now ends with `gave up after N attempts` rather than looping.
- The hosts table refuses to save a table the Host would reject — blank required fields, malformed or duplicate aliases, a port outside the range, a non-object entry, or more than one default — instead of persisting an inventory every call then fails on.
- An approval answer that fails no longer marks the request settled: the card re-enables its buttons, shows the failure, and leaves the request pending.
- Stale single-host pins no longer fall back silently to one host: a profile that still carries them comes up with no hosts and the call error says what to add.
- Testing an unsaved host is now hardened: the test deadline is capped at 300 s (a larger unsaved `connectTimeoutMs` is refused as a configuration error), the private key must be a regular file of at most 1 MiB, a key ssh2 cannot parse or decrypt (including a missing passphrase) reports as `config` instead of `connect`, a learned host key still surfaces its one-time warning, and a late answer can no longer repopulate a row that was edited while the test ran.
- The hosts table can save itself: it now carries its own **Save hosts** button (the page-level Save still works), so a host added on the Configure page is written by the flow the user actually follows. Rows collapse to the connection target — `user@host:port`, the port defaulting to 22, with the alias as its own chip and never `alias@host` — and **Add host** refuses while any existing row is invalid, so blank rows can no longer stack up unseen.
- The hosts table no longer shows literal placeholders: row titles read `Host 1` (not `Host {index}`) and required warnings read `Alias is required.` (not `{field} is required.`), in both languages.
- The terminal session header works on DSH 0.2.2-rc.1 again: the panel's `/win-mb` route is registered directly on the injected web server (the host's `connection.rpc.handle` now throws `cannot get property "webServer" without inject`), and a zero-session header stays hidden even when its probe fails. This compatibility is a manual boot-gate check only — the automated suite remains pinned to 0.2.1-rc.2.

## Breaking changes

| Surface | 0.7.x | 0.8.0 |
| --- | --- | --- |
| Tool | `ssh_bash` | `ssh_shell` |
| Config partition | `sshBash` | `sshShell` |
| Patch row | `.../tool-ssh-bash` | `.../tool-ssh-shell` |
| Export subpath | `./tool-ssh-bash` | `./tool-ssh-shell` |
| Terminal shell value | `ssh_bash` | `ssh_shell` |
| Terminal pin partition | `sshBash` | `sshShell` |
| Executor | `SshBashExecutor` | `SshShellExecutor` |

The old names are not honoured at runtime. On the command row the single-host pins (`sshPath`, `sshHost`, `sshUser`, `sshPort`, `acceptNewHostKeys`, `connectTimeoutMs`) are **replaced** by `sshShell.hosts`, and the row has no `sshPath` any more (its client is ssh2, not `ssh.exe`). A profile that still lists `sshBash:` keeps that key unread and silently preserved: the row comes up with no hosts and every call fails with `no hosts are configured; add them to the sshShell.hosts array on this row` — there is no fallback to a single host. The `terminal` row keeps its own single-host pin under `sshShell` and does not read the registry, so sessions are unchanged apart from the partition rename.

## Known limitations

- The approval scope route is authenticated but **not bound to the pending approval**: a caller that knows a tool-call id can mark it once/session or clear the mark, which can under-grant (force a re-prompt) or cancel a chosen scope, but cannot grant anything the human did not answer.
- The local-path check for `ssh_scp` is layered but **not atomic**: it resolves lexically against the session and sandbox root, refuses a symlink/junction target via `lstat`, and re-checks the realpath of the deepest existing ancestor (including each recursive target after creation). A time-of-check/time-of-use window still exists between the check and the transfer, so it is a guardrail, not a containment boundary for a local attacker.
- Channel retrying has a bounded attempt budget but no separate deadline for background calls: they stop after four attempts, while a foreground call is bounded by its own deadline.
- **`ssh_hosts` is the read-only inventory; `ssh_list` is deferred.** 0.8.0's model-facing host list is `ssh_hosts` (query / approval / defaultOnly filters) which returns the registry without a credential, a connection or an approval prompt; the platform-style `ssh_list` registry tooling is still deferred.
- `terminal` stays outside the registry and the gate: an SSH session still uses the session row's single-host pin and is not covered by `ssh_shell`'s authorization.
- `@cert-authority` entries in `known_hosts` are not honoured.

## Security

- **Key-only authentication.** `keyPath` names a private key file; `passphraseEnv` names an environment variable that carries the passphrase — never the passphrase itself. There is no password prompt and no live ssh-agent.
- **Host keys are verified against `known_hosts`** (both files, hashed entries, patterns, `@revoked`); an unknown key fails unless the host opts into `acceptNewHostKeys`, which accepts it for one connection only, and a changed key is always refused. The tool never writes `known_hosts`.
- **Authorization grants are memory-only and per session**: a grant never leaves the process, is never persisted, and is lost when the session or plugin reloads.
- **No secrets are logged or returned**: results and warnings name aliases, targets and phases only — never a key path's contents or a passphrase value.

## Migration

1. Rename the tool in the profile: `win-mb-tool-ssh` now points at `dsh-win-multi-bash/tool-ssh-shell` (the export subpath, patch row and executor name follow the table above).
2. Replace the command row's pins with an `sshShell.hosts` array — at minimum `alias`, `host`, `user`, `keyPath` per host; add `port`, `startupCommand`, `shellTemplate`, `connectTimeoutMs`, `approval`, `acceptNewHostKeys` and `description` as needed, and mark at most one host `default: true`. The Plugins page's host table edits the same value.
3. If the profile still carries `sshBash:`, it is ignored: move anything worth keeping into `sshShell.hosts` and delete the stale key at your leisure (it is preserved silently, not read).
4. Update callers: `ssh_shell` with `alias` (or no alias when a default host exists) and its `command`; for a transfer use `ssh_scp` with `localPath`/`remotePath` and the same `alias`.
5. Move terminal sessions from `shell: "ssh_bash"` to `shell: "ssh_shell"`, and their pins from `sshBash.*` to `sshShell.*`; the session form keeps its own single host and does not read the hosts table in 0.8.0.
6. Add every host to `known_hosts` before the first call (or set `acceptNewHostKeys: true` for that host to accept an unknown key once). Authentication is key-only: put an encrypted key's passphrase in the environment variable named by `passphraseEnv`.
7. Decide each host's `approval`: leave `session` (the default) to be asked once per conversation, or set `trusted` for headless deployments. Remember the terminal form is not gated in 0.8.0.
# dsh-win-multi-bash v0.7.7

## New

- **A terminal session now says when it changes between active and quiet.** `quietNoticeMs` (default 60 s, `0` turns it off) is the sampling interval: the state is taken the moment the assistant goes idle, then once per interval the session is asked whether it printed since the previous sample — yes is active, no is quiet, and only a change is reported. Two notices are therefore at least one interval apart, and a burst that starts and stops inside one interval reads as a single active sample.
- **Those notices may open a turn, but only for idle work.** A session that starts printing again (or falls quiet) while the assistant is idle is news the model cannot discover by itself, so the notice is delivered with `followup` and starts a turn. While the assistant is busy nothing is sampled: the same output is already in its next tool result, and a busy period resets the baseline so a silence that began during a turn is never reported as a fresh crossing. End-of-session notices are unchanged and still never start a turn.

## Improvements

- **`idleMs: 0` now means "never reclaim on idleness" for real.** The reaper is not armed at all instead of being armed with a zero delay, so a long-lived shell can be kept without the idle timeout fighting it.
- **Watching a session row counts as activity.** A `terminal` read or a header row that is polling keeps the session out of the idle reaper, so a shell being looked at is not closed underneath the viewer.
- **The notice interval is read live.** Editing `quietNoticeMs` on the Plugins page (including setting it to `0`) applies to sessions that are already open; turning it off and on again starts from a fresh baseline instead of resurfacing a stale window.

## Bug fixes

- **A silence that began during a busy turn is no longer announced after it.** The baseline used to look a full interval back, so a session that fell silent while the assistant was working was counted as active and produced a quiet notice one sample later — a turn opened for a crossing that never happened inside the idle window. The baseline now uses a short edge: only output right before idle counts as active.
- **The burst notice reports the silence it interrupted, not its own age.** It used to compute the gap from a timestamp the burst itself had just rewritten, so the text always said "after 0 s". The silence is captured when the first byte after a quiet sample arrives, and it is dropped when the assistant goes busy or the sampling is switched off, so a stale number cannot be carried over.
- **Burst bytes are UTF-8 bytes, not UTF-16 code units.** A Chinese line of 7 bytes used to be reported as 3.
- **The sampler stops when the registry has no sessions left**, instead of leaving a 250 ms timer running for an empty map.
- **`quietNoticeMs` validation no longer explains the idle-timeout meaning of `0`.** It has its own zero-aware guard ("0 turns these state notices off").

## Docs

- `docs/terminal.md` describes the sampling model, the idle-only delivery, the turn-opening rule for state notices (and its absence for end notices), the live-read interval, and the burst text's meaning. `docs/configuration.md` lists `quietNoticeMs`, and the Settings hints are written in user language.

## Breaking changes

- A state notice can now start a turn while the assistant is idle, which spends a turn without a user action. Set `quietNoticeMs` to `0` to keep sessions silent.
# dsh-win-multi-bash v0.7.6

## New

- **The Session header panel now behaves like the list it was modelled on.** It sits after the background jobs in the header band, draws a `>_` prompt glyph, anchors its popover with the platform's own geometry (left/top from the trigger, 5 px gap, 12 px viewport margin, scroll/resize tracking, the desktop frame's top clearance), and renders one-line rows with no title bar. The finished section folds and clears through the new `sessions.clear` endpoint.
- **Every session now says how it ended.** The registry records a structured `endedReason` beside the prose it already kept, and both `sessions.list` and the model-facing `terminal list` carry it together with `exitCode`: `running`, `exited`, `exit N`, `stopped`, `idle timeout`, `closed`, `cancelled`, `died at startup`, `transport failed`. The panel colours its dot and picks its status word from that field instead of from exited-or-not.
- **The panel lists only its own conversation's sessions.** The terminal registry is one host-wide instance, and the panel used to list all of it: a shell opened in another conversation — even in another workspace — showed up here, and could be stopped or cleared from here. `sessions.list` and `sessions.clear` now take an `ownerKey`, the header passes the conversation it belongs to, and the model's own `list` keeps the same fence. A client that omits the key still gets the deployment-wide view.
- **Two caps with names instead of one.** `maxSessions` (8) now counts only the calling conversation's live sessions, so one conversation cannot exhaust the host for the others; `maxSessionsTotal` (32, editable on the Plugins page) is the deployment-wide ceiling. Each refusal names the knob that fired and the number it hit: "this conversation already has 8 live sessions and the per-conversation limit is 8 (maxSessions)" versus "the host is running N live terminal sessions across all conversations … (maxSessionsTotal)". In-flight opens count against both.
- **Any number of rows can be expanded at once.** Each open row owns its tail poll, its scroll-follow flag and its own output element, so two shells can be watched side by side; reopening the panel or unfolding the finished section returns each row to the end of its output.

## Improvements

- **`promoteOnTimeout` is a real knob.** It was declared non-volatile, so the settings service never offered it; it is now volatile and present on the Plugins page, in both languages.
- **The sandbox temp guard stops probing when it is off.** With `guardSandboxTemp: false` or a row whose stance is `none`, every spawn still created a private temp root and granted it an ACE before returning. Both cases now return before touching the seam.
- **The self-heal warnings key on the result, not on the first failure.** One latch swallowed every later `GRANT_FAILED`; the mkdir, ACL, grant, grant-free and healed outcomes now warn on their own keys.
- **Probing `ctx.get('loader')` can no longer fail a whole row.** The composed-row loader lookup is wrapped, with a safe fallback, so a live context that throws on the probe no longer drops every contribution registered after it.
- **The MSYS2 dialect's PATH is its own.** `<MSYSTEM>\\bin` now leads the PATH it builds, and it no longer routes through the Git executor's PATH rewriting, so `MSYSTEM=UCRT64` means what it says.

## Bug fixes

- **A shell that exited on its own no longer keeps a live idle timer.** `retire()` did not mark the session closed, so a later `read` re-armed the reaper; it then re-entered the retention path as `idle timeout`, rewrote the ending, reset the elapsed clock and put a cleared row back in the list. A retired session is now `closed` for every purpose, and the end notice is selected by the reason code rather than by matching prose.
- **A spawn that crossed the disposal boundary is reclaimed instead of leaked.** The start path checked for disposal once, before the spawn settled; a session published after the row was disposed outlived its owner. `open` now re-checks and reclaims, so a terminal cannot survive the plugin reload that killed its row.
## Docs

- **The documents match the code again.** `terminal.md` states the real end paths, the fixed close grace, which rows carry Stop, the 5 s closed poll and the 1.5 s tail re-read, the verbatim end notices, and the two reload outcomes (a page refresh keeps sessions, a plugin reload ends them and keeps no record). `verification.md` no longer claims the test suite verifies the shipped default rows, `RELEASE_NOTES` for 0.7.5 was corrected in place, and the bilingual README pair is back in step with its recorded hashes.

## Breaking changes

- None. `endedReason` and `exitCode` are additive in `sessions.list` and in `terminal list`; `sessions.clear` is a new endpoint; the panel's layout changes are presentation only.


# dsh-win-multi-bash v0.7.5

## New

- **The terminal sessions now have a Session header panel, built like the first-party job list.** One control beside the Session title lists every PTY session the deployment runs — running and finished — with a live count and an elapsed clock, and expands a row into its retained output. Stopping is a two-press action on running rows only; the panel is anchored to its trigger rather than overlay-ed, and it disappears when there is no session to show. Its `/win-mb` RPC (`sessions.list`, `sessions.tail`, `sessions.stop`) is registered on the root context through Connection, so the panel inherits that service's trust fence instead of inventing one.
- **An ended session stays readable, which it did not before.** Reclaiming a session dropped the object together with its output ring, so a session stopped from the header or closed by the idle reaper became unreadable at once — the model got "is gone" and the row was gone with it. The last eight ended sessions are now retained with their windows: `read` and `tail` still answer, the header's finished section still expands, and an evicted id answers with the reason it left instead of pretending it never existed.

## Improvements

- **`read` waits when asked, and an empty answer always says why.** A positive `waitMs` blocks until new output arrives and returns that delta; `0` stays an instant snapshot. Every empty result now carries `no_output`, `timeout` or `session_exit` — the row used to drop even the exit it received. `all: true` returns the whole retained window without moving the read cursor, and is refused together with `offset` or `waitMs`.
- **`send` and `signal` stop swallowing output that arrived between calls.** Their delta now starts at the caller's cursor, not the ring head, so output produced between two calls is delivered instead of vanishing (it was neither in that call's result nor in any later read).
- **Startup no longer pays a timeout on a slow prompt.** The readiness wait baselines at session birth by byte offset (an echo landing before the first poll no longer makes a silent command pay the whole budget), and `DEFAULT_STARTUP_WAIT_MS` moved from 4 s to 10 s: this repository's prompt runs git and the first prompt measured ~4.0 s, exactly on the old budget.

## Bug fixes

- **A reclaimed session no longer lists as running.** A stopped or reaped session reported `status: exited` only after its provider settled `done`; until then the panel showed it under running with a stop button. The view now reports a reclaimed session as `exited`, while the internal status is left alone so `close` still reports the exit code its terminator produces.
- **A finished row's clock stops at the end.** The panel computed every duration as `now - startedAt`, so a dead row kept counting up. Retention stamps `lastActiveAt` and a finished row's clock uses it; running rows keep ticking.
- **The blank line after every echoed command is gone.** ConPTY sends a lone CR — a cursor return — before a command's output, and a CRLF can straddle two chunks; both became an extra line break. A line-leading CR is now dropped and a split CRLF is paired across chunks.
- **Reopening the header panel no longer jumps.** The anchor survived a close, so the first frame painted at the previous position and the measurement moved it. The position is cleared on close and on open, so the first frame stays hidden until it is measured.

## Compatibility

- No breaking change to tool names, rows, config keys or existing results. `all` is a new optional `read` parameter, `read` now honours `waitMs` where it used to ignore it, and `read` results carry `waitReason` (with the new value `no_output`) where v0.7.4 returned none. The Session header panel registers on `conversation.session.header.actions` and needs the Connection service — a deployment without it registers nothing and the rest is unchanged.
- Stated limit: the finished list holds eight sessions with their output rings (about 1 MiB each at most) in memory, evicted in ending order; an evicted id is no longer readable.

# dsh-win-multi-bash v0.7.4

## New

- **The self-heal now covers every confined spawn on the host, not just this plugin's rows.** The core row wraps the shared sandbox seam — `ctx.sandbox.confine()` — so the private temp root a windows-acl spawn is about to use is recreated, with its write grant, before the seam result reaches the caller. That is the path the host's own `run_code`, the platform `bash` / `pwsh` and any mounted PTY terminal service take, and the path this plugin could not reach before: measured, `run_code` asks the same service (two call sites in its runtime) and no consumer caches the method, so one wrapper covers all of them.
- **The hook is optional by construction.** It arrives through `ctx.inject(['sandbox'])`, never through the core row's own `inject` list, is installed when the service appears (an already-wrapped seam is left alone), and is removed — the method restored to its original descriptor — when the row goes away. A composition without a sandbox service loses the hook and nothing else.

## Improvements

- **`guardSandboxTemp` now closes the timer's window instead of only narrowing it.** Until this release a deleted private root was repaired by a timer (up to `tempWatchMs` late) or by this plugin's own next confine, so the failing call itself still failed — and the failing tool was often the very one that would have reported it. The repair now happens inside the seam, before the runner reads `--temp`; a delete landing in the last instant can still fail one call, which the next one repairs.
- **The seam contract is preserved, and the audit pins it.** The seam result is returned unmodified (`enforcement`, `denialSignatures`, `runnerFailureRules` untouched); `this` and every argument pass through; a rejection stays a rejection (a swallowed `SandboxUnavailableError` would turn a refusal into an unconfined spawn); one wrapper per seam; a non-redefinable seam is refused by name; and the switch OFF does no filesystem work at all.

## Bug fixes

- **A missing sandbox private temp directory no longer bricks the session for core tools.** `dsh-sandbox-local` caches one `%TEMP%\dsh-<6>` per (session, workspace root) for its provider lifetime and never revalidates it, while the windows-acl runner refuses an argv whose `--temp` is gone (exit 127). Every confined spawn the host makes — `run_code`, `pwsh`, the platform `bash` — failed with `code run failed (sandbox-unavailable): windows-acl-run: --temp is not an existing directory: …` until something rebuilt the directory.

## Compatibility

- No change to tools, rows, config keys or tool results. `guardSandboxTemp` and `tempWatchMs` keep their names, defaults and page placement; the hook follows the same switch.
- Stated limit: only a missing `dsh-<6>` direct child of an OS temp root, outside every workspace root, is ever created and nothing is ever deleted; a deletion landing between the seam result and the runner's own check can still fail one call (repaired for the next); and when `@deepseek-ai/dsh-sandbox-windows-acl` cannot be loaded the directory is still recreated, but its write grant is not restored — and the plugin says so.

# dsh-win-multi-bash v0.7.3

## New

- **The manifest declares the DSH window it supports.** `engines.dsh` is `>=0.1.7-rc.2 <0.3.0-0`, so the official compatibility rule reads one declared range instead of falling back to the `@deepseek-ai/dsh*` peer list, and a future 0.3 prerelease is not admitted silently.

## Improvements

- **The browser half exports exactly the platform plugin triple.** `name`, `inject` and `apply` are the only members on the entry; the renderer helpers the audit needs are reached through a test-only global instead of an `__internals` export, matching the official rule that a `/client` entry carries no implementation values.

## Bug fixes

- **A missing declaration could have hidden a future DSH line.** Without `engines.dsh` the compatibility check fell back to peer ranges; the explicit range now fails closed on the next minor line.

## Compatibility

- No change to tools, rows, config, results or the browser UI. Installing on 0.1.7-rc.2 through 0.2.x is unchanged; booting was verified on 0.2.1-rc.2, the runtime this tree pins.

# dsh-win-multi-bash v0.7.2

## New

- **A call renders as the platform's own shell card.** `git_bash`, `wsl_bash`, `msys2_bash`, `ssh_bash` and `terminal` register a keyed `tool.call.toolview` row: the platform's command glyph, the tool's own name as the title (`Git Bash`, `WSL Bash`, `MSYS2 Bash`, `SSH remote shell`, `Terminal` / 「终端」), the command or its `description` as the collapsed summary, and the platform's terminal card as the body. A deployment missing the primitives the card is built from keeps the generic row rather than a half-drawn one.

## Improvements

- **Boot no longer blocks on probes.** `wsl -l -q`, the bwrap probe and the denial-dialect discovery run through an async `runProbe` (spawn + a killing timer) instead of `spawnSync`; a hanging `wsl.exe` can no longer freeze the host event loop for up to 16 s per row. The denial dialect is learned on the first confined command, not during apply, so a row that never runs confined pays nothing.
- **`wsl_bash` ships opt-in.** Only `git_bash` and `terminal` are enabled by default; `wsl_bash` joins `msys2_bash` and `ssh_bash` as switched off (enable `win-mb-tool-wsl` on the Plugins page). A row that is off never probes.
- **The verification entry point is a verdict again.** `pnpm test` fails on a missing tool, a wrong description, a lost `ctx.shell` seat or any failed command; the audit announces and counts its skips; `exports` are checked against `files`; `RELEASE_NOTES.md` must open with the version `package.json` declares; `DSH_AUDIT_TIMING=1` attributes the wall clock. Three timing races in the suite are gone.
- **The checkout owns its dev runtime.** `devDependencies` plus `package-lock.json` pin the 0.2.1-rc.2 runtime; `smoke/prepare.mjs` resolves it from the checkout and only falls back to the live profile when the checkout has none. `npm ci` rebuilds the gate runtime.
- **One shared prompt section and a smaller model surface.** The core row owns `tool:win-mb-bash`; each tool description keeps only its own dialect facts. Dead code and stale docs were removed (`attachToolLayer`, unused imports, `graceMs`, terminal internals), package metadata names `terminal`, and the README was trimmed to a bilingual entry point with the detail moved to `docs/`.
- **Boot-path confinement is bounded and the inject surface is narrower.** Every boot-path `confine()` carries a deadline (8 s fallback); `shellEnv` is probed per call, so a deployment without it loses the managed `$DSH_*` facts rather than the tool; `sandboxPolicy` is injected.

## Bug fixes

- **The shell card no longer collapses to a zero-size row.** The terminal label set was missing `commandLine`, which `TerminalBlock` reads in its header; expanding a card threw and the slot's error boundary replaced the entire entry with an empty anchor. The row now mirrors all fourteen platform labels and uses the seat's `useDisclosure`, so its open state resets with the enclosing Turn.
- **Ordinary output that merely names a not-settled marker stays a terminal card.** The old probe matched substrings anywhere, so reading this plugin's own source (or a command that printed the marker strings) fell back to the generic INPUT/OUTPUT body; it now matches a whole marker line.
- **Background calls render the platform's card.** They were excluded early; they now use `TerminalBlock` with `background: true` (header only, no status or output), like `bash`/`pwsh`. The job id stays in the tool result and the job tools, not in the card.
- **The collapsed row carries the platform's exit capsule** for a non-zero exit or a signal. The prompt cwd follows `resolveTerminalCwd`: a relative workdir joins the session workspace, `.`/`..` are collapsed, a settled `meta.cwd` absolute path wins, and `home` is passed so the home directory shows `~`.
- **SSH facts are visible where the model reads them.** The host-key policy is emitted in the session form too; a sub-second `connectTimeoutMs` is refused by name instead of rounded; `SIGTSTP`/`SIGHUP` are refused by name; a promoted remote call carries its sandbox fact (stamped on the handle before settlement); a prepared-timeout remote call reports `{ mode, remote: true }` rather than a local `denied: false`; promoted and background results carry no `sandbox` field, matching the base tools.
- **`terminal` results carry `shell` and `remote`.** Every `send` / `read` / `signal` / `close` / `list` value and its `output.schema` gained both; the session cap counts opens that have started but are not published; `close` waits (bounded by the row's grace) for the outcome its own terminate produced instead of reading `exitCode` the instant `terminate()` resolved.
- **A numeric field whose text names a different number is reported** (`0x10`, `1e3`, `007`), and one unserviceable row no longer takes the editor down with it: a throw while building one row's Configure page used to skip every contribution registered after it.
- **Historical release notes that contradicted their tags were corrected** — v0.7.1's live SSH session claim, v0.7.0's sandbox shape and README claims, v0.6.0's roadmap and line counts.

## Compatibility

- **`wsl_bash` is now opt-in.** Enable `win-mb-tool-wsl` on the Plugins page; `git_bash` and `terminal` stay on by default, and `msys2_bash`/`ssh_bash` stay off.
- **`terminal` results gain `shell` and `remote`** (additive; a consumer validating the old key set exactly must accept the two new keys).
- **`connectTimeoutMs` below 1000 ms is refused** rather than rounded, because ssh's `ConnectTimeout` is whole seconds. A one-shot call now always sends an explicit `StrictHostKeyChecking` (`yes` by default, `accept-new` when enabled); a `terminal` session keeps the inherited `ask` when the knob is off.
- **No tool changes name, parameters or foreground result shape.** `ssh_bash` remains opt-in; a promoted result and a background acknowledgement carry no `sandbox` field, as before, now with an explicit assertion.

# dsh-win-multi-bash v0.7.1

## New

- **A remote shell dialect: `ssh_bash`.** Opt-in, Windows-only and switched off until a deployment names a host. It drives one command per call through the OpenSSH client (`ssh -T -o BatchMode=yes -o StrictHostKeyChecking=… -- <target> <command>`), reports `sandbox: { mode, remote: true }` instead of inventing a local verdict — no local wrapper, no sandbox temp root — and keeps its option surface closed (no free `sshOptions`; target and port are validated). The host-key policy is a knob: strict by default, `accept-new` when you say so, strict again for a changed key.
- **The interactive `terminal` tool can open an SSH session.** `terminal { shell: "ssh_bash" }` runs `ssh -t … -- <target>` as a persistent PTY — the form that lets ssh ask for a fingerprint, a password or a passphrase, which the one-shot form cannot.

## Improvements

- **The self-heal switch is listed exactly once, on the plugin's own page.** It had been contributed a second time to the Settings navigation, where it appeared as an unlabelled entry beside the plugin page.
- **The family prompt section now states its scope.** When no locally sandboxable shell is mounted, the file-sandbox sentence is dropped; when a remote dialect is mounted, the section adds the `sandbox.remote: true` sentence instead of promising a local fence.
- **The SSH decisions are written into the README itself** (there is no separate design-record tree), so a consumer reading the npm page gets the same argument a checkout reader does.

## Bug fixes

- **A remote job's terminal state no longer hangs an unmatched-denial sentence on the dialect**, which had described a sandbox that never ran.
- **A session in a remote backend reports `remote: true`** instead of reading like a local, unconfined session — the one fact that says whether the files are on this machine.
- **The `terminal` row's pin schema honours each knob's declared kind.** Number and boolean leaves were being built as string pins, so a declared dialect's session form refused to open at run time.
- **Three timing races in the verification suite are gone** (they produced one red run in three on this machine): the terminal round trip deleted its fixture directory while the shell's cwd was still inside it, the SIGINT probe expected an answer inside one fixed window, and the background-output case read once after a fixed sleep. All three poll to a bounded deadline now.

## Compatibility

- **No existing tool changes name, parameters or result shape**, and every new knob defaults to the previous behaviour. `ssh_bash` ships switched off; `msys2_bash` stays opt-in as before.
- **`ssh_bash` is outside the DSH file sandbox on purpose.** A file sandbox fences the local effects of a command this host runs; an SSH command has none here, so the row wraps nothing and says so instead of claiming a verdict. `requireSandbox: true` therefore refuses every command on that row (the documented way through is an explicit `danger-full-access` escalation).

## Verification

- `pnpm test`: exit 0 — `git_bash`, `wsl_bash` and the base bundle's own `pwsh` seat each ran a real command, and `ctx.shell` stayed with the base bundle.
- `pnpm run test:audit`: **392 assertions, 0 failures**, twice on the same tree.
- With `DSH_AUDIT_SSH_HOST` set, the same suite adds the live one-shot round trip (opt-in, because it needs a reachable host and a credential).
- `npm pack --dry-run`: **30 files, 169,529 B packed** — nothing from `smoke/`, `.temp/` or this file.

# dsh-win-multi-bash v0.7.0

## New

- **An interactive PTY session tool: `terminal`.** `open` / `send` / `read` / `signal` / `close` / `list` drive a real Git Bash, WSL or MSYS2 session that survives between calls, so a REPL, a debugger or an interactive prompt works where a one-shot command cannot. A session is reclaimed after `idleMs` untouched, output is kept in a bounded ring with truncation reported, and the tool takes **no** `ctx.shell` seat — the base bundle's own pwsh provider stays exactly where it was, which the suite asserts. A PTY session is not sandbox-wrapped, and the row says so in its own result (flat `sandboxMode` + `unconfined: true` fields) instead of implying otherwise.
- **A sandbox private temp directory that was removed out of band heals itself, under one switch at the top of the plugin.** `guardSandboxTemp` (default on) is declared once on the package row rather than once per shell row, and the interval beside it (`tempWatchMs`, default 10000 ms) is a live value: a change applies without reloading a row. Healing is deterministic before a wrapped command runs — the engine checks at the call entry **and** again once the sandbox seam returns the argv it is about to spawn — with a timer as the unattended safety net for roots no command is about to use. Nothing is ever deleted: a missing `dsh-<6 alphanumerics>` direct child of an OS temp root is recreated and re-granted.

## Improvements

- **The unwrapped-run notice is a per-row knob (`sandboxNotice`).** `once` (default) prints the full explanation on a row's first degraded run and then keeps the body silent, so the model's context stops carrying the same paragraph on every call; `always` keeps the short marker on each one. The structured fact `sandbox.unconfined: true` is unchanged for every degraded run.
- **One verification entry point.** `smoke/prepare.mjs` replaces the two PowerShell bootstrap scripts: it links the profile runtime where the packaged code resolves `@deepseek-ai/*`, writes its fixtures under `.temp/smoke/`, and removes only the links it created. `pnpm test` runs the driver smoke; `pnpm run test:audit` runs the suite.
- **Docs:** the README (both languages) says where the self-heal switch lives and which command runs each verification entry.

## Bug fixes

- **`msys2_bash` discovers its own bash again when no `bashPath` is pinned** — the discovery helper returned the candidate table itself instead of calling it.

## Compatibility

- **No existing tool changes name, parameters or result shape**, and every new knob defaults to the previous behaviour.
- `guardSandboxTemp` moved from the tool layer to the package row: a profile that pinned it per shell row should pin it on the plugin row instead. A row that ever declares its own value still wins.

## Verification

- `pnpm test`: exit 0 — `git_bash`, `wsl_bash` and the base bundle's own `pwsh` seat each ran a real command (`git-bash-ok` / `wsl-ok` / `pwsh-ok`) with `shellSeatPresent: true`, in both the schema-default and the pinned-`bashPath` variant.
- `pnpm run test:audit`: **376 assertions, 0 failures**, repeated on the same tree.
- `npm pack --dry-run`: 28 files, 149,229 B packed — nothing from `smoke/`, `.temp/` or this file.

# dsh-win-multi-bash v0.6.0

## Improvements

- **A third shell dialect, `msys2_bash`, ships switched off.** It exposes MSYS2's UCRT64 bash as its own model tool — `uname` reports the MSYS runtime rather than Linux, `pacman` is reachable, `$MSYSTEM` is exported — with its own facts in the tool description; its `bash.exe` is discovered under the installation roots the dialect declares, or pinned per machine with `msys2Bash.bashPath`. The row arrives `disabled: true`: enable it in the Plugins page if you want a second toolchain next to Git Bash.
- **Adding a shell is now one executor file plus one declaration.** Every dialect is declared once — id, tool name, row id, config key, executor class, argv style, executable resolver, sandbox stances, family facts, default-enabled — and the tool modules, the shared prompt section's membership, the row wiring, the config partition and the package exports are all derived from that declaration. The mechanism half moved into a shared executor base, so a new dialect inherits existing behaviour instead of copying it: `lib/bash-git/index.js` **658 → 544 lines**, `lib/bash-wsl/index.js` **571 → 468**.
- **A declaration that does not hold together refuses to load.** Five startup checks (unique dialect id / tool name / row id / config key; a `configKey` that does not match the client form partition; a tool name that collides with the family section's name; a sandbox stance list without `auto`; family facts with no shared text) throw at load time instead of leaving a half-wired tool behind. Forgetting a derived surface is a loud failure now, not a silently disabled feature.
- **A background job keeps the identity of the call that created it.** `jobs.start` now carries `toolCall` (call id and root call id), so dsh's job records name the originating tool call; on a runtime that does not know the field, the plugin drops it and retries once instead of failing the call.
- **Docs:** the README (both languages) now carries status badges — npm, license, Node, stars, the required dsh version, `platform: windows`, the three dialects.

## Compatibility

- **No existing tool changes name, parameters or result shape.** `msys2_bash` is a new opt-in row; `git_bash` and `wsl_bash` keep their schemas, their sandbox facts and their wording. The shared prompt section's text, its order (between dsh's `TOOL_BASH` and `TOOL_PWSH`) and its one-copy-per-composition rule are unchanged.
- **An existing profile keeps working untouched.** The patch's three existing rows are byte-identical, and the package `exports` map only gained entries (`./factory`, `./shell-family`, `./registry`, `./tool-msys2-bash`).
- **The browser half still comes from the core row** (`win-mb-plugin`, the bare package-name row). Switching that row off still leaves both older tools working with the shared guidance in their own descriptions, and only the Configure pages disappear.

## Verification

Verified on dsh **0.2.1-alpha.4**, with the same plugin code re-run on **0.2.1-alpha.3** as a control.

- `smoke/audit.test.mjs`: **326 checks, 0 failures** (301 at v0.5.1), two runs per runtime.
- `npm pack --dry-run`: **25 files** (20 at v0.5.1 — five new `lib/` files carry the dialect registry, the shared executor base and the MSYS2 dialect). Tests, docs and these notes stay out of the tarball.
- **All three dialects run for real on this machine**: `git_bash` (MSYS/Git Bash), `wsl_bash` (WSL, bubblewrap stance) and `msys2_bash` (MSYS2 UCRT64 — `$MSYSTEM=UCRT64`, `pacman` reachable, a non-ASCII working directory read back).
- The startup checks and the two unmergeable dialect differences (symlink resolution when locating the executable; each dialect's own sandbox-stance vocabulary) are covered by named guards; putting the pre-refactor wiring back turns each named guard red.
- The audit no longer depends on an artifact being present: it creates its own probe parent directory, so a fresh clone (no `.temp/`) is green on the **first** run instead of only on the second.

# dsh-win-multi-bash v0.5.1

## Bug fixes

- **A configured shell path or distribution name that does not work is now reported instead of failing obscurely.** A pinned `bashPath` / `wslPath` that does not exist used to be handed straight to the command, so the first symptom was a bare `spawn ENOENT`; a pinned `wslDistro` that is not installed made every command fail with `WSL_E_DISTRO_NOT_FOUND`. The executor now logs one warning naming the value, falls back **at runtime** (auto-discovery for a shell path; the first finished distribution for the distribution name), and leaves the stored value exactly as you wrote it.
- **Text knobs are trimmed when you save, and the trimmed value is shown back**, so what the page displays is what the profile stores. Blanking a field still clears it.

## Compatibility

- **The plugin never rewrites or deletes your configuration.** A value that fails the *syntax* check the page can make — a path that is not absolute, a distribution name containing spaces or quotes, a number that is not finite — shows a warning and is **still saved exactly as typed**; the fallback happens only at runtime. An existing value that would not pass that check today is left byte-for-byte untouched until you save it again.
- The page's *syntax* check is deliberately not an existence check: a browser half cannot see your filesystem, so whether a path is real is decided when a command runs.

## Verification

Verified on dsh **0.2.1-alpha.2** and **0.2.0-rc.2**.

- `smoke/audit.test.mjs`: **301 checks, 0 failures** (293 at v0.5.0), run three times on rc.2 plus once against an isolated alpha.2 device.
- The stored-value guarantee is asserted, not assumed: with a value containing stray spaces in the profile, the form projects **no write at all** and the configuration bytes are identical before and after (checked by the audit and by a standalone probe).
- `npm test` (`smoke/run.ps1`) and `npm pack --dry-run` (20 files) were green on the v0.5.0 tree; this release changes no shipped file except `lib/client.js`, the two executors and their tests.

# dsh-win-multi-bash v0.5.0

## Improvements

- **A foreground timeout keeps the command running as a background job.** A foreground call that outlives `timeoutMs` is promoted instead of killed, the result says so, and reading it names any dropped output together with its spill file — dsh's own shell tools behave the same way. A new `promoteOnTimeout` knob (default on, deliberately not on the Plugins page) turns promotion off; with `enableRunInBackground: false`, a timeout still kills the command exactly as before. **Act only if you relied on timeouts killing the command.**
- **Foreground commands are registered as jobs from the start.** They appear in the task tools and can be killed with `job_kill`; a kill from outside the call is reported as `[stopped: …]` rather than as a command failure, so the model does not retry it.
- **The sandbox result now says what actually happened.** A run that was not wrapped by a sandbox reports `sandbox.unconfined: true`; when the reason is a failed `sandbox: auto` probe, every result carries a short note and the first one per row load carries the full explanation with both ways out. An explicit `sandbox: none` carries the fact without any note, and `danger-full-access` carries neither.
- **`denied` is optional and never guessed.** It is `true` when a failed confined run's output matches the backend's denial dialect, `false` on success, and **absent** when nothing matched — with a note pointing at stderr instead of a claim nobody observed. Each row also learns its host's dialect once, from a deliberately-denied harmless write outside the workspace root (the backend's own signatures are kept as the union).
- **The Windows sandbox boundary is documented from measurement.** The ACL backend's grant follows the object rather than the path, reads stay unconfined, and dsh rates that backend `partial`. On a host whose runner cannot start MSYS bash at all, `git_bash` reports on every call that it ran unconfined; `requireSandbox: true` is the fail-closed alternative there (it refuses every command rather than degrading).
- **`run_in_background` follows the configuration, not the job registry.** With no job registry composed the parameter is still advertised and the call fails loudly naming the missing packages; previously the parameter silently disappeared from the schema depending on load order.

## Bug fixes

- **A failed confinement runner no longer silently re-runs unconfined.** It fails closed with actionable text (retry with `sandbox_permissions: "danger-full-access"`, or set `sandbox: none` on the row). **Act only if you relied on the silent fallback.**
- **`wsl_bash`'s bubblewrap profile is complete and its probe is functional.** The profile now carries `--unshare-pid` and the wrapper keeps the separator `bwrap <profile> -- <command>`, so a confined command can no longer reach the host through procfs magic links; the probe builds the same profile and actually runs a command instead of checking that `bwrap` exists.
- **`git_bash`'s confinement probe no longer blocks the event loop** (it spawns asynchronously; default probe bound 4 s, WSL 8 s).
- **`wsl_bash` accepts MSYS-style paths and `wslDistro` consistently**, and passes the working directory explicitly so the starting directory is a property of the call rather than of the distro.
- **Promoted results are loss-aware**: a promotion that dropped output names the dropped bytes and the spill file, matching the foreground path.
- **The Plugins page saves are fenced**: platform-driven saves no longer race the staged draft, style installation is guarded, `resetField` validates its key, and the row key has a single source.

## Compatibility

- **`install.ps1` and `uninstall.ps1` are gone; the tarball is 20 files (22 before).** Install or upgrade with `dsh plugin --profile web add dsh-win-multi-bash`, or add the patch rows by hand — a profile that still lists a `files` entry for the removed scripts is unaffected, since nothing loads them.
- **`sandbox.denied` may be absent** (see above). A consumer that reads it must tolerate a missing field; `sandbox.unconfined` is new and equally optional.
- **Confinement runner failures now fail closed** instead of degrading to an unwrapped run.
- **The tool parameter table matches dsh's ordering** (`description` before `command`) and results carry `cwd` plus presentation metadata; both are additive for existing callers.
- YAML written by hand keeps working; the knobs that were already volatile are unchanged, and `promoteOnTimeout` is read from the row's config only.

## Verification

Verified on dsh **0.2.1-alpha.2** and **0.2.0-rc.2**.

- `smoke/audit.test.mjs`: **293 checks, 0 failures** (224 at v0.4.0), run three times per gate on rc.2 plus once against an isolated alpha.2 device; it covers the prompt dedup matrix, the volatile config projection, the browser half's form contract, the job/promotion behaviour, the sandbox facts and their once-per-load wording, and the repository records (bilingual hashes, LF, package `files`).
- `npm test` (`smoke/run.ps1`): exit 0 — `git_bash`, `wsl_bash` and the base bundle's own `pwsh` seat each ran a real command in both the schema-default and pinned-`bashPath` variants.
- `npm pack --dry-run`: 20 files, no `install.ps1` / `uninstall.ps1`.
- Real-machine sandbox measurements behind the notes above: a WSL/bubblewrap write outside the workspace is refused and the row learns that host's refusal text (~0.3 s, once per row load); on the Windows host tested, the ACL runner cannot start MSYS bash, so `git_bash` reports `unconfined` per call.

# dsh-win-multi-bash v0.4.0

## Improvements

- **The shared shell guidance is stated once.** Each tool description keeps only its dialect facts (289 / 143 characters, down from 1299 / 2164); one `tool:win-mb-bash` section states what the family shares. Prompt payload per turn: **3933 → 2693 characters**.
- **The section follows the composition.** Its text is resolved on every assembly from the tools actually mounted, so either tool alone, both, or neither each render exactly one correct copy — and with neither mounted it renders nothing at all. The escalation paragraph and the background sentence appear only while a mounted tool advertises `sandbox_permissions` / `run_in_background`. It now sorts between dsh's `TOOL_BASH` and `TOOL_PWSH` sections instead of ahead of the policy sections.
- **Both tool rows are configurable in the Web Plugins page.** Every knob is `.volatile()`, and a browser half (`lib/client.js`) registers a **Configure** page for each row: `enableRunInBackground`; `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`; `bashPath` (or `wslPath` / `wslDistro`); the sandbox stance; `probeTimeoutMs`; `requireSandbox`. The page is localized (en / zh), staged behind **Save**, and fenced by revision; writes go to the profile's Cordis patch, so there is no extra settings file, route or YAML editing. Changes apply to the next command, except `enableRunInBackground` and the escalation surface, which shape the tool schema and follow the row's next load.
- **Three rows: the plugin's core row plus one per tool.** The core row (`win-mb-plugin`, the package main) serves the browser half and owns the prompt section. dsh offers no way to mark a third-party row read-only, so switching that row off is arranged to be harmless — the tools keep working and carry the shared guidance in their own descriptions, and only the Configure pages disappear — and the page labels it as the core row (`plugins.detail.badge` / `.section`).
- **The Plugins page's timeout hints state what they do not cover**: `timeoutMs` / `maxTimeoutMs` apply to a foreground command only, never to a background job.

## Compatibility

- **The patch now inserts three rows, not two** (0.3.0 / 0.3.1 shipped the two tool rows only). Hand-wired profiles: add the `win-mb-plugin` row, or re-run `install.ps1` (its managed block is replaced by marker). A bundle-installed profile picks the new shape up on the next composition load. An un-migrated 0.3.1 profile keeps working: both tools load, and with no section owner each description carries the shared guidance itself.
- The tool rows no longer inject `systemPrompt` (they register no section of their own), so a composition without that service can still load them.
- **Volatile fields resolve to live references**: reading a resolved `GitBashExecutor.Config(...)` / `WslBashExecutor.Config(...)` field programmatically now needs `.get()`. Hand-written YAML is unchanged and still valid.
- New in the package: the `./client` export with `dsh.client` (a Web Host serves the browser half under `/plugins`; a non-Web host is unaffected), `install.ps1` / `uninstall.ps1` in `files`, and `.gitattributes` pinning LF. The tarball is 22 files; `smoke/` and this file are not shipped.

## Verification

Verified on dsh **0.2.0-rc.2**.

- `smoke/audit.test.mjs`: **224 checks, 0 failures** (140 before this release), covering the prompt dedup and its five-state assembly matrix, the volatile config projection, the browser half's form contract, the row-switch fallback, and the repository records (bilingual hashes, LF, package `files`).
- `npm test` (`smoke/run.ps1`): `git_bash`, `wsl_bash` and the base bundle's own `pwsh` seat each ran a real command with `shellSeatPresent: true`, in both the schema-default and pinned-`bashPath` variants.
- The smoke composition cannot activate `dsh-settings` (no `configEditor` / `profileContext`), so that projection is pinned against the documented rule instead of booted; the page itself is verified in the running Web app.

# dsh-win-multi-bash v0.3.1

## Bug fixes

- **An MSYS- or WSL-form `workdir` no longer fails as a missing shell.** An absolute `workdir` was handed to `spawn` as the child's `cwd` unchanged: `node:path` calls both MSYS `/d/WorkSpace` and the WSL automount view `/mnt/d/WorkSpace` absolute, but Windows resolves them against the current drive (`G:\d\WorkSpace`), so the spawn failed and reported ENOENT **against the executable** — `bash.exe` / `wsl.exe` — which reads as a missing shell rather than an unusable directory. Both forms are now translated to the native `D:\WorkSpace` before the executor sees them. Only a single-letter first segment (optionally under `/mnt/`) whose drive exists qualifies, so MSYS POSIX roots (`/etc`, `/usr`, `/tmp`, `/dev`) and distro-side paths such as `/mnt/data` keep their own meaning, and a relative `workdir` still resolves against the session workspace. `toNativeWorkdir` is exported for the audit.

## Improvements

- **Tool descriptions track the dsh 0.2.0 skeleton.** `tool-bash` and `tool-pwsh` each gained two sentences upstream; `git_bash` / `wsl_bash` now carry the bash-family wording — verify the resolved absolute target path before any delete or move, and guard a computed path against an unset variable with `${VAR:?}`. They deliberately do not adopt pwsh's `$HOME` sentence: in bash `$HOME` is an ordinary assignable variable.
- **The exit-status prompt section now states the gating rule.** Alongside the `[exit code: N]` instruction, each tool row tells the model to chain dependent steps with `&&` or `set -o pipefail`, because `;` never stops on failure and `cmd | tail` returns `tail`'s status rather than the command's. It stays in the prompt rather than the per-call schema (cross-call guidance), and the runtime's own tail truncation is the reason not to bound output with a pipe. The text lives in the exported `SHELL_EXIT_STATUS_SECTION` so the audit can pin it.

## Verification

Verified on dsh **0.2.0-rc.2**; the peer floors stay at `>=0.1.7-rc.2`, which that release satisfies, so 0.1.7 deployments are unaffected.

- `npm test` (`smoke/run.ps1`): `git_bash`, `wsl_bash` and the base bundle's own `pwsh` seat each executed a real command (`git-bash-ok` / `wsl-ok` / `pwsh-ok`) with `shellSeatPresent: true`, in both the schema-default and pinned-`bashPath` variants.
- `smoke/audit.ps1`: **140 assertions, 0 failures**. Nine of them are the new regression guards, and they do fail on the previous code: six unit assertions over the drive-form translation plus three boot assertions that run a real command through an MSYS-form and a WSL-automount `workdir`.

# dsh-win-multi-bash v0.3.0

## Breaking: rewritten for dsh 0.1.7

dsh 0.1.7 removed the shell seam's routing field, which is what this plugin's whole pre-0.1.7 design was built on. Loading the old version under 0.1.7 made `shell-select` fail to import, which left `ctx.shell` unprovided, which in turn left every plugin that injects `shell` — our own two tool rows, dsh's `tool-pwsh`, and `permission-presets` — stuck at `pending (waiting for service: shell)`.

- **The selector is gone; each tool owns its executor.** `ShellExecRequest` no longer carries `shell`, so there is no routing input left for a shared seat to dispatch on — the tool is what knows which shell it wants. `git_bash` / `wsl_bash` now each construct their own executor (on a child fiber with an isolated `shell` scope, so the cordis duplicate-service rule is respected) and drive it directly.
- **The plugin no longer occupies `ctx.shell`.** The patch no longer disables `pwsh-sandbox` (nor `shell-select`): the base bundle's own row keeps providing the seat, so pwsh, `tool-pwsh` and `permission-presets` work exactly as they would without this plugin installed. This is also the regression the smoke fixture now guards.
- **Config moved onto the tool rows.** The `win-mb-shell-select` row is removed; `gitBash:` / `wslBash:` now live on the row that uses them:
  ```yaml
  - id: win-mb-tool-git
    name: 'dsh-win-multi-bash/tool-git-bash'
    config:
      gitBash: { bashPath: '...' }
  ```
  `install.ps1` writes the new shape, and because it replaces its managed block by marker, re-running it over an old installation migrates cleanly (`uninstall.ps1` likewise still removes either generation). A hand-maintained old `win-mb-shell-select` block is not marker-managed, so replace it by hand.

## API migration

- `ShellExecutor.run()` / `start()` → a single `execute(spec)` returning a `ShellExecution`; foreground is `(await execute(spec)).result()`, background is the same handle's `done` / `readOutput` / `kill`. Both executors were re-based onto `executeArgv(spec, argvOrPrepare, onStarted)` + a memoized `result()` decoration, mirroring the base runtime's own `SandboxBashExecutor`.
- `ctx.sandbox.confine()` is now async and takes an optional `AbortSignal`; the windows-acl probe awaits it.
- The confinement probe can no longer be answered synchronously, so the tool layer awaits a new `resolveSandboxMode()` before it registers: the escalation surface (`sandbox_permissions`, `@deepseek-ai/dsh-sandbox`'s `ESCALATION_TARGETS`) is still settled before the model ever sees the tool. A backend whose probe fails *loud* (an explicit `sandbox: bwrap` with bubblewrap missing) is deliberately swallowed at registration so it cannot brick the tool row — its error resurfaces at the first routed command, which is the documented lazy contract. `requireSandbox` is unchanged in timing: it declares the mode regardless of the probe, so the tool still advertises the escalation surface, and the refusal happens when a command is actually attempted under `read-only` / `workspace-write` rather than at row load.
- Background jobs follow the new registry contract: the model's reads are pumped from `output` pull sources declared at `jobs.start`, not returned from the starter (`readOutput` is gone), and `owner` takes a session id. Per-process sandbox facts continue to be stamped by `onProcessDone` before `done` settles, so `runnerFailed` / `denied` still reach both the job outcome and the foreground renderer.
- `settings.installSection` / `SHELL_SETTINGS_NAMESPACE` were removed upstream. Settings are now schema-driven per profile entry, so the plugin's `Config` schema is the settings surface — no registration call is needed (and none is made).

## Bug fixes

- **`wsl_bash` now pins its start directory explicitly.** `argv()` / `bwrapArgv()` used to add `--cd` only when the workdir differed from a `defaultWorkdir()` helper — but that helper returned the `cwd` *volatile wrapper object* instead of its value (`this.config.cwd ?? process.cwd()` rather than `this.config.cwd.get() ?? process.cwd()`), so the comparison never matched and `--cd` was passed on every command anyway. Rather than revive the skip, the dead helper is gone and `--cd` is now unconditional: the auto-cd contract (a command with no explicit `workdir` starts in the WSL view of the session directory, `/mnt/<drive>/...`) becomes a property of the spec instead of a property of the distro's cwd-inheritance and automount settings. This is behaviour-preserving — it is what every deployment already ran — and `wsl.exe` accepts both Windows and Linux workdirs for `--cd`.

## Cleanup

- Deleted `lib/tool-bash/index.js` — a stale pre-bundled copy of the upstream tool with no importers.
- Deleted the unreferenced POSIX `bash` tool instance (`lib/tool-bash/types/index.js`) — never exported by this package, never wired into the patch.
- Deleted 5 unwired `invariant.js` companions. They registered no-op invariants under *upstream* package names (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-bash-git`, …) that this package does not own; the real packages already register their own.
- Peer floors raised from `>=0.1.0-rc.7` to `>=0.1.7-rc.2`; `dsh-pwsh-sandbox`, `dsh-pwsh-local` and `dsh-settings` dropped from `peerDependencies` (nothing imports them any more), and the `./shell-select` export is gone.

## Verification

`smoke/run.ps1` boots a real 0.1.7-rc.2 composition. In both the schema-default and pinned `bashPath` variants it reports: `git_bash` / `wsl_bash` registered with the expected MSYS / WSL descriptions, one real command executed through each, **`shellSeatPresent: true`** (the base bundle's `ctx.shell` provider still alive beside our rows — the exact condition that failed before), and a real pwsh command executed through that seat. `smoke/audit.test.mjs` runs 129 assertions over the executor internals, backend ownership, the background-job adapters, the tool config schemas and the patch/misconfiguration matrices — including a real-spawn check that a `wsl_bash` command with no workdir auto-cds to `/mnt/<drive>/...`.

# dsh-win-multi-bash v0.2.0

## Bug fixes

- **dsh 0.1.2 compatibility.** dsh 0.1.2 removed the cross-package runtime relays from `@deepseek-ai/dsh-settings` (the standalone `installSettingsSection` / `settingsNamespace` exports; `f4e49ccf8f` "move shared values behind service APIs"). `shell-select` now registers its namespace through the `ctx.settings` service (`ctx.inject(['settings'])` → `settings.installSection`, same schema/hooks shape), so the plugin loads again on dsh 0.1.2+.
- **`@deepseek-ai/dsh-settings` peer floor raised to `>=0.1.2-alpha.2`** — the previous `>=0.1.0-rc.7` range resolved to 0.1.2 while the code still used the removed export.
- **Smoke suite updated for the 0.1.2 runtime:** `CallId` → `ToolCallId` (dsh-llm rename) in `smoke/driver.mjs`; the fixture now mounts `@deepseek-ai/dsh-session-projection` (0.1.2's `dsh-sandbox-policy` requires the `sessionProjections` service). Both variants (schema-default and pinned `bashPath`) pass on the real 0.1.2-alpha.2 runtime.

## Verification

`smoke/run.ps1` boots a real 0.1.2-alpha.2 composition: `git_bash` / `wsl_bash` register with the expected descriptions and execute real commands through all three backends (git-bash / wsl-bash / pwsh) in both the default and pinned `bashPath` variants.

# dsh-win-multi-bash v0.1.2

## Improvements

- **Concise model-facing tool prompts.** The `git_bash` / `wsl_bash` descriptions now mirror the official `tool-pwsh` skeleton (fresh shell, paths/env, exit codes, `$DSH_*` facts, sandbox, truncation, background, escalation) instead of the longer dialect prose: the toolchain listing and the long MSYS path-conversion / WSL base64-payload notes were dropped from the model-facing text (they remain documented in the README's "Path conversion" section).
- **`git_bash` description carries a path-format hint.** MSYS paths work inside Git Bash only, while dsh's file tools (`read`, `write`, `edit`) on Windows take native `C:\...` paths — models are reminded to convert MSYS output paths before using file tools.

## Docs

- README (EN/ZH) gains a "Tool prompts" section describing the concise descriptions and the path-format rule; `cordis.patch.yml` inline row docs updated; i18n hashes re-recorded.

# dsh-win-multi-bash v0.1.1

## Bug fixes

- **`git_bash` no longer resolves into a stale WSL alias.** On hosts with Git for Windows on a non-C: drive and a leftover `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` app-execution alias (reported by `lstat` as a symlink and therefore "existing"), resolution could pick the dead alias and fail every command with `spawn ...\WindowsApps\bash.exe ENOENT`. Resolution now (a) probes Git roots inferred from PATH `git.exe` layout dirs first, (b) probes the well-known Program Files layout on every fixed drive (e.g. `D:\Program Files\Git`), (c) rejects symlinks/reparse points, and (d) skips `WindowsApps` alias directories — a dead WSL alias can no longer shadow a real Git Bash. `smoke/run.ps1`'s `Find-GitBash` mirrors the same rules.
- **New resolution primitives exported for tests** (`gitCandidatesUnder`, `probeDrives`, `candidateExists`) with audit coverage for WindowsApps exclusion, symlink rejection, drive-rooted probes (`GitProbeDrives` env override for hermetic fixtures), and git-root-first ordering.

# dsh-win-multi-bash v0.1.0

Windows multi-bash plugin for DeepSeek Harness: `git_bash` / `wsl_bash` model tools plus a `shell-select` executor routing the single `ctx.shell` seat across Git Bash, WSL and pwsh. Pwsh stays the default — existing behavior is unchanged until a bash-family tool is called.

## Features

- **`git_bash` tool** — Git for Windows (MSYS) toolchain, auto-resolved (well-known locations → PATH → git.exe layout inference → GitForWindows registry), never the WSL launcher.
- **`wsl_bash` tool** — WSL distro Linux userland; commands ride as base64 payloads so quoting and paths pass verbatim.
- **`shell-select` executor** — routes `request.shell ?? default` across git-bash / wsl-bash / pwsh; pwsh stays the default.
- **Sandboxing** — pwsh: windows-acl restricted token (partial); wsl-bash: bwrap inside the distro (full); git-bash: windows-acl probe (typically unavailable with Git for Windows — `CreateProcessAsUserW` cannot launch MSYS bash).
- **`requireSandbox` hardening (new)** — when a backend's probe fails, refuse unconfined runs unless the effective mode is `danger-full-access`; escalation via `sandbox_permissions` stays available.
- **bwrap denial classification (new)** — denied file effects now report `denied: true` with the `[sandbox: file access denied]` marker (foreground and background paths).
- **MSYS path-conversion guidance** — tool descriptions and README document `MSYS_NO_PATHCONV=1` for native exe calls (e.g. `wsl.exe`) from git_bash.

## Install

```powershell
# hot plug (no restart; recommended)
powershell -ExecutionPolicy Bypass -File .\install.ps1

# bundle install (restart dsh web)
dsh plugin --profile web add dsh-win-multi-bash
# or from source: dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash
```

## Sandbox notes (read before use)

- `wsl_bash` sandboxing requires `bubblewrap` inside the distro (`sudo apt-get install -y bubblewrap` on Ubuntu/Debian); the probe verdict is cached for the host process lifetime — restart `dsh web` after installing.
- `git_bash` usually cannot be sandboxed in Git for Windows deployments — do not assume DSH sandbox protection for it; enable `requireSandbox` to refuse unconfined runs outside `danger-full-access`.
- Denials are only classified when the command exits non-zero (matching upstream bash-sandbox rules).

## Verification

`smoke/run.ps1` boots a real composition and verifies `git_bash` / `wsl_bash` register and execute real commands (default and pinned `bashPath` variants).
