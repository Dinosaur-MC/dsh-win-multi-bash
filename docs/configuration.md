# Configuration

Every row carries its own configuration — each tool row its tool-layer switch and backend partition, the core row the deployment-wide self-heal switch — and every knob is declared `.volatile()`, which is what makes it addressable by the runtime's settings service.

## The Plugins page

The Web **Plugins** page edits it: open **Plugins** in the sidebar, open the `dsh-win-multi-bash` bundle, and each row has a **Configure** page.

The browser half (`lib/client.js`, declared as `dsh.client` + the `./client` export) registers that page into the page's `plugins.row.config` slot, keyed `dsh-win-multi-bash#<row id>`; a save goes to the profile's Cordis patch through `settings` / `ctx.configForms` — the same place a hand edit lands, with no HTTP route, no second settings file, and no YAML editing.

That is also why the bundle inserts its core row — `win-mb-plugin`, `name: 'dsh-win-multi-bash'` — and why it is the row it is: `dsh-client-modules` discovers a browser half by resolving a row's **bare package specifier** to its `package.json` and reading `dsh.client` there (`locatePkgJson` → `exactPackageSpecifier`, which answers `undefined` for a subpath). The tool rows are subpaths, so without this core row the client bundle is never served and the rows show no Configure control at all. Its module (`lib/index.js`) is the package main, and it owns the shared prompt section as well — one row for the plugin itself, one row per tool.

## Rows and options

| Row | Options (in page order) |
| --- | --- |
| `git_bash` | Background jobs (`enableRunInBackground`); `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`; `bashPath`; sandbox stance (`auto` / `none`); `probeTimeoutMs`; `requireSandbox`; unwrapped-run notice (`sandboxNotice`: `once` by default, `always` to keep the short marker on every degraded run) |
| `wsl_bash` | The same tool-layer switch plus the same set under `wslBash`, `wslPath` and `wslDistro`; the stance list adds `bwrap` |
| `msys2_bash` | The same tool-layer switch plus the same set under `msys2Bash`, `bashPath`, and the sandbox knobs (its stance list is MSYS's, so no `bwrap`) |
| `ssh_shell`, `ssh_scp` | The same tool-layer switch plus the shared command limits under `sshShell` (`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`) and the host registry `sshShell.hosts` — one entry per host, see [The `ssh_shell` host registry](#the-ssh_shell-host-registry). This one row serves two tools: the command tool `ssh_shell` and the SFTP transfer tool `ssh_scp`, which adds no knobs of its own (see [File transfer](#file-transfer-ssh_scp)). The transfer reads the row's **hosts and host-key policy only** — not the shared **command** limits and not the output/spill limits (those bound a command's stdout/stderr; a transfer streams the file directly and has no output cap or spill): its own per-call `timeoutMs` (default `300000`) bounds one operation, and it resolves `localPath` against the session's working directory. Its Configure page puts the host registry first, then `requireSandbox` (labelled for what it does on this row: only `danger-full-access` runs), then the shared limits; the local-sandbox stance, `probeTimeoutMs` and `sandboxNotice` are local-only and are omitted on this row. The schema still accepts all four for backward compatibility, but none can fence a remote effect; `requireSandbox` refuses every command under `read-only` / `workspace-write` |
| `terminal` | Interactive sessions: `defaultShell` (which dialect `open` uses by default); `maxSessions`; `idleMs`; `quietNoticeMs` (active/quiet sampling interval, `0` off); `rows` / `cols`; `maxBufferBytes`; `waitMs` / `quietMs` / `maxWaitMs`; `allowUnconfined`; plus one executable pin per dialect (`gitBash.bashPath`, `wslBash.wslPath` / `wslDistro`, `msys2Bash.bashPath`, and the terminal row's own single-host SSH pin under `sshShell`: `sshPath` / `sshHost` / `sshUser` / `sshPort` / `acceptNewHostKeys` / `connectTimeoutMs` — it does not read the `hosts` table in 0.8.0). The page groups these as Session, Output and waiting, Backend executables, and SSH session; the SSH pins are worded for sessions (an unset host refuses opening a session, `acceptNewHostKeys` here uses `ssh.exe` and therefore writes `known_hosts`). |
| `win-mb-plugin` (core) | `guardSandboxTemp` (default on), `tempWatchMs` (default 10000 ms, floor 1000) |

The list is exactly the volatile projection of each row's `Config` schema; the audit pins both sides (`volatilePaths` of the host configs against the browser half's field table), so a knob added to a backend without `.volatile()` cannot silently stay YAML-only, and the page cannot offer a field the Host would refuse.

## Live semantics

- **Live reads.** Volatile fields are live references, and the executors read them through `.get()` at use time. A path, distro, stance, timeout or hardening change applies to the next command without reloading the row.
- **Two knobs need the row's next load**, because they shape the tool's *schema*: `enableRunInBackground` (the advertised `run_in_background` argument) and the escalation surface (`sandbox_permissions`, advertised at load from the probe verdict).
- **One behaviour switch is deliberately not on the page.** `promoteOnTimeout` (default on) keeps a foreground command that reaches its timeout running as a background job — visible and killable through the job tools — instead of killing it, matching dsh's own bash. It is non-volatile because it is a deployment stance rather than a live knob: set it in the row's YAML and it applies on the row's next load. With `enableRunInBackground: false`, or with no job registry composed, a timeout kills the command exactly as before.
- The page exists while the Host serves that row's namespace (`whileServed`), so a row that is switched off shows no Configure control.

## Defaults and switches

Only `git_bash` and `terminal` are enabled by default; three dialects ship switched off:

- `wsl_bash` is opt-in because a WSL deployment is a second toolchain a machine may not have, and the row's first load probes the distro. Enable `win-mb-tool-wsl`; pin `wslBash.wslDistro` to name the one you want: a blank value uses the FIRST distribution `wsl -l -q` lists, which is not necessarily the default distribution.
- `msys2_bash` is opt-in: enable `win-mb-tool-msys2`, and pin `msys2Bash.bashPath` when MSYS2 is installed outside its usual location. It inherits the MSYS mechanism rather than copying it and reports its own facts — `$MSYSTEM`, `pacman` — instead of Git Bash's.
- `ssh_shell` is opt-in for a reason of its own: a deployment has to name its hosts. Enable `win-mb-tool-ssh` and list them under `sshShell.hosts`; a row with no hosts registers the tool and refuses every call with `no hosts are configured`. Authentication is key-only — `keyPath` names a private key file and `passphraseEnv` names an environment variable that holds its passphrase, never the passphrase itself — and host keys are checked against `known_hosts` instead of being trusted on first use. Every foreground result reports `sandbox: { mode, remote: true }`; `requireSandbox: true` makes the row refuse every remote command rather than pretend a local fence (its card says so; the local-only stance, probe timeout and notice are not shown on this row), and the documented way through is a per-call `danger-full-access` escalation (the only case where the row advertises `sandbox_permissions`). The same row also serves `ssh_scp`, a foreground-only SFTP transfer tool with no knobs of its own — same hosts, same pool, same host-key check.

## The `ssh_shell` host registry

`sshShell.hosts` is the row's whole host inventory: an array of objects, one per host, and the alias a call passes is the only way to choose one. It replaces the previous single-target pins — the tool no longer drives an `ssh.exe` process, so its Configure page carries no client path, host, user or port.

| Field | Required | Meaning |
| --- | --- | --- |
| `alias` | yes | The name a call passes. Unique within the array, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. |
| `host` | yes | Hostname or IP address; no whitespace. |
| `port` | no | `1`–`65535`, default `22`. |
| `user` | yes | The login user. |
| `keyPath` | yes | Absolute path, or `~/...`, to the private key file. Keys are the only credential form in 0.8.0 — no password and no ssh-agent. |
| `passphraseEnv` | no | The name of the environment variable that holds the key's passphrase. The value is never stored: config carries the variable name only. |
| `startupCommand` | no | A POSIX shell snippet run before every command on that host; see [Startup command and shell templates](#startup-command-and-shell-templates). |
| `shellTemplate` | no | Optional wrapper command line. Blank (the default) means precise passthrough: the script is the channel command line and the remote login shell runs it directly. A non-empty value is an explicit wrapper whose command line reads the base64 script from stdin. |
| `connectTimeoutMs` | no | Whole handshake and authentication ceiling for one connection, default `30000`. |
| `approvalTimeoutMs` | no | How long a session-authorization prompt may stay open, default `120000` (2 minutes). `0` waits forever; any other value must be `1000`–`3600000`. On timeout the pending card is withdrawn and the call fails closed with the timeout sentence; nothing is cached, so a later call asks again. |
| `approval` | no | `trusted` or `session` (default). `session` asks the human once per session before the host is used; `trusted` pre-authorizes it and never asks — the only form usable headless. Neither the model nor a call argument can set it; see [Host authorization](#host-authorization). |
| `acceptNewHostKeys` | no | `false` by default. `true` accepts an unknown host key for that connection with a one-time warning; it never writes `known_hosts`. |
| `default` | no | At most one host may carry it; a call may then omit `alias`. |
| `description` | no | Free text for the human (the Configure page and the composition file); it never reaches a call's result. |

The registry is validated once per stored `hosts` value — a live edit re-validates it, and a call reuses that verdict instead of re-reading the array. A missing required field, a malformed or duplicated alias, a port outside the range, or more than one `default` host fails with a message naming the field and the alias (for a duplicate default the message may list the aliases). A broken array leaves the row registered with no hosts, and every call then fails with the same sentence — `sshShell.hosts is invalid (<the field and alias>)` — instead of letting "no host with alias X" hide the real cause. A valid empty array is a different state: `no hosts are configured; add them to the sshShell.hosts array on this row`.

`alias` may be omitted from a call only when **exactly one** host carries `default: true`. With no default the call fails and names the declared aliases; running on the first host instead would be a guess about where a command runs.

On the Plugins page the registry is a **table**, one card per host: a two-column form (one column under 640px) with alias / host / port / user / key file always visible, and the passphrase environment variable, startup command, shell template, timeouts, session authorization, `acceptNewHostKeys` and `description` behind a per-row **Advanced settings** toggle (collapsed by default; a field with an error forces the section open). The checkbox and radio are full-width rows, not narrow grid cells, so their labels stay on one line; each hint is two-line clamped with the full sentence in its `title`. Every field above (text/number inputs, textareas for `startupCommand` / `shellTemplate` / `description`, a checkbox for `acceptNewHostKeys`), a per-host **Session authorization** select (`session` / `trusted`) and one exclusive **Default host** radio across the table. **Add host** appends a blank row and refuses while any existing row is invalid (a broken row cannot be buried under new blanks); **Remove host** drops one; the table also carries its own **Save hosts** button beside Add, so a host can be filled and tested before it is written (the page-level Save still works). Rows collapse to the connection target — `user@host:port`, `host:port` when the user is blank, or the alias when the host is blank (the port defaults to 22) — never `alias@host`, because an alias is a name, not a login user. The alias is its own code-styled token beside the `Host N` numbering, and the row whose default radio is on carries a **Default** badge. A new/blank row starts expanded, a named row starts collapsed, the toggle exposes `aria-expanded`, and a collapsed invalid row keeps its problem count in the header. Required-field, alias-format/duplicate, host-format, port-range, timeout-range and duplicate-default problems are shown inline on the row, and a table-level alert says the table cannot be saved while any row is invalid — the write plan refuses an invalid table. `default` is **at most one**, and zero is allowed; the radio keeps the table's single default at most one (a stored or hand-edited array with two is reported and blocks the save). Editor row ids only keep React identity stable and are never saved. The value a save writes is the array of host objects — blanks cleared, numbers as numbers — and there is no JSON text control on the page. A legacy JSON-string draft from the pre-table form is still shown as rows, so an in-flight draft is not lost. The array is never returned with secrets: it carries paths and an environment-variable name, never key material or a passphrase. The model sees only the alias list in the `alias` parameter's description. Each field carries a one-line hint; `startupCommand`, `shellTemplate` and `description` keep spaces and newlines exactly as typed (whitespace-only still clears the field), and the two shell snippets render as monospace textareas that grow with their lines. The clear action is named **Clear host table** and needs a second confirmation click before it stages the empty array. Each row also has a **Test connection** action: it dials that row's current (unsaved) values, verifies the host key against `known_hosts` (a changed or `@revoked` key still fails), authenticates with the named key, and executes no command; the inline result carries the presented fingerprint (plus any one-time host-key warning) on success, or the failed phase and message on failure: `config` is an invalid row, an unreadable/non-regular/oversized key file (at most 1 MiB is read), a credential ssh2 cannot parse, or a `connectTimeoutMs` above the 300 s test ceiling; `connect` is the socket or the total deadline (also capped at 300 s); `host-key` is an unknown, unverified or changed key (a missing `known_hosts` file is reported here too, because there is nothing to verify against); `auth` is the server rejecting the credential. The Shell template box shows a placeholder saying that blank runs directly (and that `bash -c 'eval "$(base64 -d)"'` is an explicit wrapper), not a hidden default. The action is served by the **terminal row's** `/win-mb` route, so disabling that row makes the test report that the endpoint is not registered. The test is a human action on the Configure page — it does not consume an agent approval grant — and it never writes `known_hosts`. Save stays explicit: a row can be tested before it is written.

## Host keys and `known_hosts`

The host key is verified during the handshake, before authentication completes and before any channel opens. ssh2 accepts whatever a server presents when no verifier is set, so the plugin parses `known_hosts` itself and fails closed. It reads `known_hosts` **and** `known_hosts2` together (`%USERPROFILE%\.ssh\` on Windows, `$HOME/.ssh/` elsewhere): an entry in either file counts, one missing file is not an error, and neither existing is the unknown-key case. Plain entries, `[host]:port` entries, several key types for one host, comments, hashed names (`|1|salt|hash`, HMAC-SHA1), OpenSSH host patterns (`*`, `?`, comma lists, `!` negation) and `@revoked` markers are honoured; the presented key's type and base64 blob must equal an entry's for the target and port.

- **No entry** — refused with `host key not found in known_hosts`, the file(s) read, and the presented key's fingerprint.
- **A different key for a known host** — refused with both SHA256 fingerprints.
- **`@revoked`** — refused even when a plain entry would accept the key, and `acceptNewHostKeys` never overrides a revocation.
- **`acceptNewHostKeys: true`** — an unknown key is accepted for that connection with one warning that prints the line to add. It never writes the file: 0.8.0 performs no trust-on-first-use.

Two stated limits fall on the strict side — the call is refused, never accepted on an unverified key. `@cert-authority` lines are parsed but not honoured (certificate-signed host keys are a later release, so such a host needs a plain entry as well). And a host pattern that negates a bracketed host with a port can over-refuse at the default port — `*,![example.com]:22` excludes the bare host too.

Add each entry deliberately before the first call — connect once with the OpenSSH client, or run `ssh-keyscan` — because the switch only covers a host with **no** entry, never a changed or revoked one.

Authentication is key-only and the passphrase stays out of the file: an encrypted key needs `passphraseEnv` to name an environment variable that holds its passphrase, and a missing or wrong passphrase fails the call with a message naming that variable. No passphrase or key material is written to config, logs or a tool result.

## Host authorization

`ssh_shell` and `ssh_scp` do not use a host the human has not authorized **for this session**. The host's `approval` field decides how that happens:

- **`trusted`** — the host is pre-authorized and never asks. This is the deployment's headless escape hatch; neither the model nor a call argument can set it.
- **`session`** (the default) — the first use in a session asks through the platform's approval service, once per session and host, and remembers the answer in memory only.

Grants live in a `WeakMap` keyed by the Session object and a host fingerprint: never written to disk, never shared between sessions, and lost when the plugin reloads — a new session is asked again. The fingerprint is `alias + host + port + user + keyPath + passphraseEnv`; editing **any** of those fields invalidates the grant and the next use asks again. Only the passphrase environment variable's *name* is part of it, never the passphrase.

The gate runs **before any connection or channel**: a broken registry or unknown alias fails first, then the grant is checked, then the pool dials — a refusal therefore never dials. Concurrent first uses of the same host in one session share one in-flight request instead of prompting twice.

Outcomes are fail-closed: `rejected` and `cancelled` refuse without connecting; `unavailable` fails closed with a sentence naming the missing answerer and the `trusted` escape hatch; a session approval policy of `never` rejects deterministically without asking, and a request that cannot be answered fails closed rather than granting.

A refusal is reported with phase `approval`: `ssh_shell` throws the named error and `ssh_scp` returns it as its structured `{ ok: false, error: { phase: "approval", alias, message } }` value — the same sentence either way. The prompt uses this bundle's dedicated card (see [Conversation rows](conversation-rows.md#host-authorization-card)). `terminal` sessions stay out of scope in 0.8.0: a session still uses its own single-host pin and is not gated by this table.

## Startup command and shell templates

Each call's script is the channel command line by default: the remote host's own login shell runs it, with no extra shell hop. That is precise passthrough, and it is what a blank `shellTemplate` means. Nothing is base64-encoded and nothing is written to stdin in this mode; a `cd -- <quoted workdir>` line still precedes the command, and a non-POSIX login shell reports its own error for it. A non-empty `shellTemplate` is an explicit opt-in wrapper: it becomes the command line and the base64 script travels on stdin, exactly as before. On a Windows host whose login shell is `cmd.exe`, leaving the template blank runs the text as a cmd command line; when you need a POSIX shell, pin a wrapper that starts Git Bash, for example:

```text
"C:\Program Files\Git\bin\bash.exe" -c "eval \"$(base64 -d)\""
```

The wrapper is static per host and no user text is interpolated into it, which is what makes command quoting safe on any host whose template can launch a POSIX shell; a host without a working `base64` reports that shell's error verbatim. A host whose registry entry already carries the old default keeps it as an explicit wrapper — only a blank value changed meaning, and it is never migrated silently. The remote script is laid out as:

```text
{ <startupCommand>
} || exit $?                     # omitted when the snippet is empty or only comments
cd -- '<workdir>' || exit $?     # only when the call passes workdir
<command>
```

The group closes on its **own line** on purpose: a one-line `{ …; }` cannot hold a snippet ending in a comment, a here-document, or an empty body — measured with bash, each of those either swallows the closing brace or fails outright. A snippet that is empty or only comments has nothing to run, so its guard line is omitted instead of producing an invalid `{ }`.

`startupCommand` is a **per-call** snippet, not session state: it runs INSIDE the host's login shell, before the command, guarded so a failure aborts the call with its own exit status, and exported variables or a `cd` it performs apply to that one command and vanish when the shell exits. On a Windows host whose sshd already starts bash, leave it empty; a `bash.exe` path belongs in the optional `shellTemplate` wrapper with forward slashes and quotes (blank there means passthrough into the login shell, which on `cmd.exe` is not a POSIX shell). When the startup group or the channel template is the thing that failed, the call's stderr starts with a line naming the field and the alias (`ssh: host "<alias>" started, but its 启动命令 (startupCommand) failed: …` or `ssh: host "<alias>" could not start its shell template (<first word>): …`); the raw stderr follows and the exit status is unchanged. `workdir` is an absolute POSIX path **on the remote host** — the local session's directory is not used — and it is single-quote escaped before it is placed in the script. The value is never trimmed (a directory whose name ends in a space is legal; a whitespace-only path must attempt the `cd` and fail honestly), a local Windows path (drive letter, backslash, UNC) or a relative path is refused by name, and the result's `cwd` is that remote path or the empty string. There is no cross-call state (that is what `terminal` sessions are for) and no stdin (an interactive command or a TUI belongs in `terminal`).

## File transfer (`ssh_scp`)

`ssh_scp` is the second tool on the same ssh row. It reads the same `sshShell.hosts` registry, verifies the same `known_hosts`, and reuses the row's pooled connection, so a command and a transfer cost one TCP connection per host. It is **foreground only** — no `run_in_background`, no promotion, no job — and its own deadline bounds one operation (default `300000` ms, five minutes).

| Parameter | Required | Meaning |
| --- | --- | --- |
| `action` | yes | `upload` sends `localPath` to `remotePath`; `download` brings `remotePath` to `localPath`. |
| `alias` | per the registry | The host, by the same rule as `ssh_shell`: named, or omitted only when exactly one host is `default`. |
| `localPath` | yes | The path on **this** machine. A relative path resolves against the session's working directory and the resolved path must stay inside the workspace root. The check is **lexical** — no `realpath`, no TOCTOU protection — so a symlink or junction inside the workspace that points outside it is followed by the file stream even though its path looked contained; treat the rule as a path check, not an OS confinement. `danger-full-access` is the only mode that allows an outside path, and the result then carries `outsideWorkspace: true`. A denied path is refused with the family's standard sandbox sentence — never silently clamped to the root. |
| `remotePath` | yes | An absolute POSIX path on the host. On a Windows OpenSSH host use the `/C:/Users/...` drive form; a local `C:\...` path or a relative path is refused before anything is dialled. |
| `recursive` | no | `false` by default. `true` walks a directory tree, preserves empty directories and creates the missing parents on the receiving side; a directory without it is a named error instead of an empty result. |
| `timeoutMs` | no | Per-operation deadline in milliseconds; default `300000`. Expiry destroys the transfer streams, closes the SFTP session and reports a timeout — it never hangs. |

Every call returns `{ ok, bytes, files?, error?, sandbox, outsideWorkspace? }`. `bytes` is what actually crossed the wire; `files` is the file count of a successful transfer; `sandbox: { mode, remote: true }` is on **every** result, because the transfer's other side is a remote effect. A failure is a **value**, not a thrown error: `ok: false`, the bytes already transferred, and an `error` naming the `phase` (`config` for the alias/registry, a malformed `remotePath` or a missing `localPath`, `approval` for the host-authorization gate, `sandbox` for a local-path refusal, `connect` before any SFTP session existed, `sftp` once it did), the `alias`, and the ssh2 message. The one exception is the caller cancelling the tool call: that surfaces as the platform's abort, the same shape `ssh_shell` reports (a timeout is still a structured error, not an abort).

**Capacity refusals are retried; nothing else is.** When the server refuses a new channel for capacity — `MaxSessions`, `administratively prohibited`, `channel open failure`, `open failed`, `resource shortage` — `ssh_shell` retries the OPEN (never the command) at 100/200/400 ms, capped at 1 s: a foreground call until its deadline, a background or job-owned call for at most four attempts. `ssh_scp` retries a refused SFTP subsystem under the same four-attempt budget. Authentication, host-key, handshake, socket and passphrase failures — and every SFTP operation error — are never retried. When retrying stops the error is the server's **last refusal verbatim** plus a note saying why: the call deadline expired for a foreground call, while the bounded budget (including a refused SFTP subsystem) says `gave up after N attempts`. It is never a synthetic timeout; an abort is the platform abort, and the alias is in `error.alias`.

`ssh_scp` shares the row's `approval` field with `ssh_shell`, and [Host authorization](#host-authorization) applies to both: a gate refusal is the structured `approval` phase and never reaches a dial.

## Text and numeric fields

A text field (a path, a distribution name) is saved trimmed and the trimmed value is shown back, so what you see is what is stored; blanking a field clears it. A value that fails the *syntax* check the page can make — a path that is not absolute, a distribution name containing spaces or quotes, a number that is not finite — shows a warning and is **still saved exactly as you typed it**: the plugin never rewrites or deletes your configuration.

Whether a value actually works is decided **at runtime**: the executor warns once, falls back to its default (auto-discovery for a shell path; the first distribution listed by `wsl -l -q` for `wslDistro`, not necessarily the default one), and leaves the stored value untouched until you save again. A **numeric** field is stored as the number its text names, so a spelling that names different text (`0x10`, `1e3`, `007`) is reported too — the mismatch is never silent.

## Self-heal switch

`guardSandboxTemp` (default on) is declared once on the core row, never per tool row: one deployment-wide value governs the guard, the seam hook every confined spawn goes through (`ctx.sandbox.confine()` — `run_code`, the platform's `bash` / `pwsh`, and this plugin's own rows), each row's inline pre-spawn check, and the watch timer alike. `enableRunInBackground` stays on the tool layer, so that one **is** on each row.

Two honest limits: `wsl_bash` uses bwrap and never materializes a `--temp` directory, so the knob is inert there; and the hook refreshes the directory the seam hands a spawn, so a deletion landing between that seam result and the runner's own check can still fail one call (repaired for the next). See [Sandbox behavior](sandbox.md) for the mechanism and its boundaries.

## Unwrapped-run notice

When a command is not wrapped by a sandbox, the **foreground** result carries `sandbox.unconfined: true` (a promotion says it in its text; a background acknowledgement carries no `sandbox` field — the base bundle's own shape).

When the reason is a failed `sandbox: auto` probe — the plugin degraded on your behalf — the row's **first** such run carries the full explanation:

> `[sandbox: not applied — the confinement probe found no usable sandbox, so this command ran unconfined under <mode> mode; repair the sandbox or set sandbox: none on this tool row to accept unconfined runs]`

After that, `sandboxNotice` decides:

- `once` (default) — stay silent; the structured fact still rides on every result, so nothing is hidden and the same sentence stops pushing real output out of the context window;
- `always` — keep the short marker `[sandbox: not applied — ran unconfined under <mode> mode; reason and fix stated once per plugin load]` on every degraded run.

An explicit `sandbox: none` carries the fact without any note; `danger-full-access` carries neither — its `mode` already says what it is.

On a Windows host the degraded path is the normal path, not an edge case: the provider's ACL enforcement is itself only `partial` by design (NTFS hard links alias one object across paths, and reads stay unconfined), and on a host whose windows-acl runner cannot start MSYS bash the probe fails outright, so every `git_bash` call reports `sandbox.unconfined: true`. The knob is for exactly that: one explanation per row load, then a clean context with the structured fact retained.

## Denial dialect

The row's capability probe no longer learns the denial dialect. The first **confined** command makes one deliberately-denied, harmless write outside the workspace root and keeps that refusal text as an extra signature (a union with the backend's own list), so a localized refusal the backend never enumerates is still classified — and the command that triggers the learning is classified by it, because learning completes before that command starts. The probe target must not exist afterwards; if it somehow does, the row deletes it and discards the discovery. Failure to learn is silent and never blocks the row. Measured cost: about +321 ms, once per row lifecycle, on the WSL/bwrap path; a row that never runs a confined command never pays it.

## Background advertising

Background advertising is config-driven here, not registry-driven: `run_in_background` — and the family section's background sentence that follows it — appears whenever `enableRunInBackground` is on. A call in a composition with no job registry fails loudly (`background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`). dsh's own tool instead re-registers itself and drops the parameter while no registry is composed; this factory does not re-register, because a parameter that silently disappears depending on boot order is worse than one that refuses with a reason.

## Staged saves

The page stages drafts and writes only on **Save**, fenced by the revision it read; a save the Host refuses keeps the drafts. Emptying a path or a distro stages a clear, so the override drops and the built-in probe resolves again. A save already crossing the wire is not re-entered.

## Migration from `ssh_bash` (0.8.0)

0.8.0 renames the remote dialect and turns its configuration into a host registry. The old names are **not** honoured at runtime:

| Surface | 0.7.x | 0.8.0 |
| --- | --- | --- |
| Tool | `ssh_bash` | `ssh_shell` |
| Config partition | `sshBash` | `sshShell` |
| Patch row | `.../tool-ssh-bash` | `.../tool-ssh-shell` |
| Export subpath | `./tool-ssh-bash` | `./tool-ssh-shell` |
| Terminal shell value | `ssh_bash` | `ssh_shell` |
| Terminal pin partition | `sshBash` | `sshShell` |
| Executor | `SshBashExecutor` | `SshShellExecutor` |

A profile that still lists `sshBash:` under the ssh row keeps that key **unread**: neither this tool nor the terminal row looks at it any more (the stale key is preserved silently — no throw and no loader warning; naming it in the loader is Plan 4 work). The row therefore comes up with no hosts, and the diagnostic is the call error — `no hosts are configured; add them to the sshShell.hosts array on this row` — rather than a silent fallback to one host.

Replace the single-target pins (`sshPath`, `sshHost`, `sshUser`, `sshPort`, `acceptNewHostKeys`, `connectTimeoutMs`) with a hosts array, in the profile's YAML or with the row's host table:

```yaml
- id: win-mb-tool-ssh
  name: 'dsh-win-multi-bash/tool-ssh-shell'
  config:
    sshShell:
      hosts:
        - alias: ubuntu
          host: 10.0.0.5
          port: 22
          user: deploy
          keyPath: '~/.ssh/id_ed25519'
          startupCommand: 'export APP_ENV=production'
        - alias: win-build
          host: build.example.com
          user: builder
          keyPath: 'C:\Users\me\.ssh\id_ed25519'
          shellTemplate: '"C:\Program Files\Git\bin\bash.exe" -c "eval \"$(base64 -d)\""'
          default: true
```

Then update the calls — `ssh_shell` with `alias: "ubuntu"` and its `command`, or with no alias when exactly one host carries `default: true` — and move terminal sessions from `shell: "ssh_bash"` to `shell: "ssh_shell"`, with their pins under `sshShell.*`. The terminal row keeps its own single-host pin (`sshPath`, `sshHost`, `sshUser`, `sshPort`, `acceptNewHostKeys`, `connectTimeoutMs`); it does not read the hosts table in 0.8.0, and its `acceptNewHostKeys` is the OpenSSH client's `accept-new`, so a session's first connection is recorded into `known_hosts` — the host registry's switch only accepts a key for one connection and never writes the file. The tool row has no `sshPath` any more: its client is ssh2 (`~1.17.0`), not `ssh.exe`.

Authentication is key-only: a password prompt or a live ssh-agent is not available to `ssh_shell`, and an encrypted key needs `passphraseEnv`. Host keys are strict — add each host to `known_hosts` first, or set `acceptNewHostKeys: true` on that host to accept an unknown key once with a warning. `acceptNewHostKeys` accepts an UNKNOWN key (no covering entry) once with a warning; it never bypasses a changed key, and a missing `known_hosts` file is reported as a host-key failure because there is nothing to verify against. `@cert-authority` entries are not honoured in 0.8.0.

The row also gains a second tool, `ssh_scp` (see [File transfer](#file-transfer-ssh_scp)). It is not a rename: there is no old name to migrate, it reads the same `sshShell.hosts` and reuses the same connection, its local side is sandboxed as described there, its remote paths use the POSIX form (`/C:/...` on a Windows OpenSSH host), and its `approval` semantics are `ssh_shell`'s (session-memory grants, see [Host authorization](#host-authorization)).

## Known limitations (0.8.0)

- **The local transfer path is checked, not confined.** `ssh_scp`'s `localPath` rule is lexical (no `realpath`/TOCTOU), so a symlink or junction inside the workspace that points outside it is followed by the file stream. Treat it as a path check, not an OS confinement.
- **Channel-open retries are bounded.** Capacity refusals are retried at 100/200/400 ms (capped at 1 s): a foreground call until its deadline, a background or job-owned call for at most four attempts, and a refused SFTP subsystem for four attempts. There is no unbounded or queued retry beyond that budget, and no retry at all for authentication, host-key, handshake, socket, passphrase or SFTP-operation errors.
- **`ssh_list` is deferred.** 0.8.0 ships no model-facing host-list tool; the configured aliases are visible in the `alias` parameter's description, and key paths and passphrases are never exposed.
- **`terminal` stays outside the registry and the gate.** An SSH session keeps its own single-host pin under `sshShell` and does not read the hosts table; the session authorization gate covers `ssh_shell` and `ssh_scp` only.

