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
| `ssh_shell`, `ssh_scp` | The same tool-layer switch plus the shared command limits under `sshShell` (`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`) and the host registry `sshShell.hosts` — one entry per host, see [The `ssh_shell` host registry](#the-ssh_shell-host-registry). This one row serves two tools: the command tool `ssh_shell` and the SFTP transfer tool `ssh_scp`, which adds no knobs of its own (see [File transfer](#file-transfer-ssh_scp)). The transfer reads the row's **hosts and host-key policy only** — not the shared **command** limits and not the output/spill limits (those bound a command's stdout/stderr; a transfer streams the file directly and has no output cap or spill): its own per-call `timeoutMs` (default `300000`) bounds one operation, and it resolves `localPath` against the session's working directory. The row keeps the sandbox knobs (`sandbox`, `probeTimeoutMs`, `requireSandbox`, `sandboxNotice`) like every row, but none of them can fence a remote effect: both stances mean the same thing here, the probe knobs are inert, and `requireSandbox` refuses every command under `read-only` / `workspace-write` |
| `terminal` | Interactive sessions: `defaultShell` (which dialect `open` uses by default); `maxSessions`; `idleMs`; `quietNoticeMs` (active/quiet sampling interval, `0` off); `rows` / `cols`; `maxBufferBytes`; `waitMs` / `quietMs` / `maxWaitMs`; `allowUnconfined`; plus one executable pin per dialect (`gitBash.bashPath`, `wslBash.wslPath` / `wslDistro`, `msys2Bash.bashPath`, and the terminal row's own single-host SSH pin under `sshShell`: `sshPath` / `sshHost` / `sshUser` / `sshPort` / `acceptNewHostKeys` / `connectTimeoutMs` — it does not read the `hosts` table in 0.8.0) |
| `win-mb-plugin` (core) | `guardSandboxTemp` (default on), `tempWatchMs` (default 10000 ms, floor 1000) |

The list is exactly the volatile projection of each row's `Config` schema; the audit pins both sides (`volatilePaths` of the host configs against the browser half's field table), so a knob added to a backend without `.volatile()` cannot silently stay YAML-only, and the page cannot offer a field the Host would refuse.

## Live semantics

- **Live reads.** Volatile fields are live references, and the executors read them through `.get()` at use time. A path, distro, stance, timeout or hardening change applies to the next command without reloading the row.
- **Two knobs need the row's next load**, because they shape the tool's *schema*: `enableRunInBackground` (the advertised `run_in_background` argument) and the escalation surface (`sandbox_permissions`, advertised at load from the probe verdict).
- **One behaviour switch is deliberately not on the page.** `promoteOnTimeout` (default on) keeps a foreground command that reaches its timeout running as a background job — visible and killable through the job tools — instead of killing it, matching dsh's own bash. It is non-volatile because it is a deployment stance rather than a live knob: set it in the row's YAML and it applies on the row's next load. With `enableRunInBackground: false`, or with no job registry composed, a timeout kills the command exactly as before.
- The page exists while the Host serves that row's namespace (`whileServed`), so a row that is switched off shows no Configure control.

## Defaults and switches

Only `git_bash` and `terminal` are enabled by default; three dialects ship switched off:

- `wsl_bash` is opt-in because a WSL deployment is a second toolchain a machine may not have, and the row's first load probes the distro. Enable `win-mb-tool-wsl`; pin `wslBash.wslDistro` when the default distribution is not the one you want.
- `msys2_bash` is opt-in: enable `win-mb-tool-msys2`, and pin `msys2Bash.bashPath` when MSYS2 is installed outside its usual location. It inherits the MSYS mechanism rather than copying it and reports its own facts — `$MSYSTEM`, `pacman` — instead of Git Bash's.
- `ssh_shell` is opt-in for a reason of its own: a deployment has to name its hosts. Enable `win-mb-tool-ssh` and list them under `sshShell.hosts`; a row with no hosts registers the tool and refuses every call with `no hosts are configured`. Authentication is key-only — `keyPath` names a private key file and `passphraseEnv` names an environment variable that holds its passphrase, never the passphrase itself — and host keys are checked against `known_hosts` instead of being trusted on first use. Every foreground result reports `sandbox: { mode, remote: true }`; `requireSandbox: true` makes the row refuse every remote command rather than pretend a local fence, and the documented way through is a per-call `danger-full-access` escalation (the only case where the row advertises `sandbox_permissions`). The same row also serves `ssh_scp`, a foreground-only SFTP transfer tool with no knobs of its own — same hosts, same pool, same host-key check.

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
| `shellTemplate` | no | The remote command line that reads a base64 script from its stdin. Default `bash -c 'eval "$(base64 -d)"'`. |
| `connectTimeoutMs` | no | Whole handshake and authentication ceiling for one connection, default `30000`. |
| `approval` | no | `trusted` or `session` (default). Recorded on the host for the session-authorization gate, which is not part of this change: today neither value changes a call for `ssh_shell` or `ssh_scp` — no prompt is made, and `trusted` is not required to use a host. Neither the model nor a call argument can set it. |
| `acceptNewHostKeys` | no | `false` by default. `true` accepts an unknown host key for that connection with a one-time warning; it never writes `known_hosts`. |
| `default` | no | At most one host may carry it; a call may then omit `alias`. |
| `description` | no | Free text for the human (the Configure page and the composition file); it never reaches a call's result. |

The registry is validated once per stored `hosts` value — a live edit re-validates it, and a call reuses that verdict instead of re-reading the array. A missing required field, a malformed or duplicated alias, a port outside the range, or two `default` hosts fails with a message naming the field and the alias. A broken array leaves the row registered with no hosts, and every call then fails with the same sentence — `sshShell.hosts is invalid (<the field and alias>)` — instead of letting "no host with alias X" hide the real cause. A valid empty array is a different state: `no hosts are configured; add them to the sshShell.hosts array on this row`.

`alias` may be omitted from a call only when **exactly one** host carries `default: true`. With no default the call fails and names the declared aliases; running on the first host instead would be a guess about where a command runs.

On the Plugins page the registry is edited as **JSON text** in one control: a draft that does not parse is reported and never saved, and an emptied control clears the override instead of writing an empty value. The array itself is never returned with secrets — it carries paths and an environment-variable name, never key material or a passphrase. The model sees only the alias list in the `alias` parameter's description.

## Host keys and `known_hosts`

The host key is verified during the handshake, before authentication completes and before any channel opens. ssh2 accepts whatever a server presents when no verifier is set, so the plugin parses `known_hosts` itself and fails closed. It reads `known_hosts` **and** `known_hosts2` together (`%USERPROFILE%\.ssh\` on Windows, `$HOME/.ssh/` elsewhere): an entry in either file counts, one missing file is not an error, and neither existing is the unknown-key case. Plain entries, `[host]:port` entries, several key types for one host, comments, hashed names (`|1|salt|hash`, HMAC-SHA1), OpenSSH host patterns (`*`, `?`, comma lists, `!` negation) and `@revoked` markers are honoured; the presented key's type and base64 blob must equal an entry's for the target and port.

- **No entry** — refused with `host key not found in known_hosts`, the file(s) read, and the presented key's fingerprint.
- **A different key for a known host** — refused with both SHA256 fingerprints.
- **`@revoked`** — refused even when a plain entry would accept the key, and `acceptNewHostKeys` never overrides a revocation.
- **`acceptNewHostKeys: true`** — an unknown key is accepted for that connection with one warning that prints the line to add. It never writes the file: 0.8.0 performs no trust-on-first-use.

Two stated limits fall on the strict side — the call is refused, never accepted on an unverified key. `@cert-authority` lines are parsed but not honoured (certificate-signed host keys are a later release, so such a host needs a plain entry as well). And a host pattern that negates a bracketed host with a port can over-refuse at the default port — `*,![example.com]:22` excludes the bare host too.

Add each entry deliberately before the first call — connect once with the OpenSSH client, or run `ssh-keyscan` — because the switch only covers a host with **no** entry, never a changed or revoked one.

Authentication is key-only and the passphrase stays out of the file: an encrypted key needs `passphraseEnv` to name an environment variable that holds its passphrase, and a missing or wrong passphrase fails the call with a message naming that variable. No passphrase or key material is written to config, logs or a tool result.

## Startup command and shell templates

Each call sends its command to the remote host as a POSIX script on the channel's stdin, base64-encoded. The host's `shellTemplate` is the command line that decodes it; the default is `bash -c 'eval "$(base64 -d)"'`, and a Windows host whose login shell is `cmd.exe` pins a template that starts Git Bash, for example:

```text
"C:\Program Files\Git\bin\bash.exe" -c "eval \"$(base64 -d)\""
```

The template is static per host and no user text is interpolated into it, which is what makes command quoting safe on any host whose template can launch a POSIX shell; a host without a working `base64` reports that shell's error verbatim. The remote script is laid out as:

```text
{ <startupCommand>
} || exit $?                     # omitted when the snippet is empty or only comments
cd -- '<workdir>' || exit $?     # only when the call passes workdir
<command>
```

The group closes on its **own line** on purpose: a one-line `{ …; }` cannot hold a snippet ending in a comment, a here-document, or an empty body — measured with bash, each of those either swallows the closing brace or fails outright. A snippet that is empty or only comments has nothing to run, so its guard line is omitted instead of producing an invalid `{ }`.

`startupCommand` is a **per-call** snippet, not session state: it runs in the same fresh shell, before the command, guarded so a failure aborts the call with its own exit status, and exported variables or a `cd` it performs apply to that one command and vanish when the shell exits. `workdir` is an absolute POSIX path **on the remote host** — the local session's directory is not used — and it is single-quote escaped before it is placed in the script. The value is never trimmed (a directory whose name ends in a space is legal; a whitespace-only path must attempt the `cd` and fail honestly), a local Windows path (drive letter, backslash, UNC) or a relative path is refused by name, and the result's `cwd` is that remote path or the empty string. There is no cross-call state (that is what `terminal` sessions are for) and no stdin (an interactive command or a TUI belongs in `terminal`).

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

Every call returns `{ ok, bytes, files?, error?, sandbox, outsideWorkspace? }`. `bytes` is what actually crossed the wire; `files` is the file count of a successful transfer; `sandbox: { mode, remote: true }` is on **every** result, because the transfer's other side is a remote effect. A failure is a **value**, not a thrown error: `ok: false`, the bytes already transferred, and an `error` naming the `phase` (`config` for the alias/registry, a malformed `remotePath` or a missing `localPath`, `sandbox` for a local-path refusal, `connect` before any SFTP session existed, `sftp` once it did), the `alias`, and the ssh2 message. The one exception is the caller cancelling the tool call: that surfaces as the platform's abort, the same shape `ssh_shell` reports (a timeout is still a structured error, not an abort).

**Capacity refusals are retried; nothing else is.** When the server refuses a new channel for capacity — `MaxSessions`, `administratively prohibited`, `channel open failure`, `open failed`, `resource shortage` — `ssh_shell` retries the OPEN (never the command) at 100/200/400 ms, capped at 1 s: a foreground call until its deadline, a background or job-owned call for at most four attempts. `ssh_scp` retries a refused SFTP subsystem under the same four-attempt budget. Authentication, host-key, handshake, socket and passphrase failures — and every SFTP operation error — are never retried. When retrying stops the error is the server's **last refusal verbatim** plus a note saying why: the call deadline expired for a foreground call, while the bounded budget (including a refused SFTP subsystem) says `gave up after N attempts`. It is never a synthetic timeout; an abort is the platform abort, and the alias is in `error.alias`.

`ssh_scp` shares the row's `approval` field with `ssh_shell`; until the session-authorization gate ships, that field is recorded and **not enforced** for either tool.

## Text and numeric fields

A text field (a path, a distribution name) is saved trimmed and the trimmed value is shown back, so what you see is what is stored; blanking a field clears it. A value that fails the *syntax* check the page can make — a path that is not absolute, a distribution name containing spaces or quotes, a number that is not finite — shows a warning and is **still saved exactly as you typed it**: the plugin never rewrites or deletes your configuration.

Whether a value actually works is decided **at runtime**: the executor warns once, falls back to its default (auto-discovery for a shell path; the first finished distribution for `wslDistro`), and leaves the stored value untouched until you save again. A **numeric** field is stored as the number its text names, so a spelling that names different text (`0x10`, `1e3`, `007`) is reported too — the mismatch is never silent.

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

Replace the single-target pins (`sshPath`, `sshHost`, `sshUser`, `sshPort`, `acceptNewHostKeys`, `connectTimeoutMs`) with a hosts array, in the profile's YAML or on the row's Configure page:

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

Authentication is key-only: a password prompt or a live ssh-agent is not available to `ssh_shell`, and an encrypted key needs `passphraseEnv`. Host keys are strict — add each host to `known_hosts` first, or set `acceptNewHostKeys: true` on that host to accept an unknown key once with a warning. Neither a missing `known_hosts` entry nor a changed key is bypassed by that switch, and `@cert-authority` entries are not honoured in 0.8.0.

The row also gains a second tool, `ssh_scp` (see [File transfer](#file-transfer-ssh_scp)). It is not a rename: there is no old name to migrate, it reads the same `sshShell.hosts` and reuses the same connection, its local side is sandboxed as described there, its remote paths use the POSIX form (`/C:/...` on a Windows OpenSSH host), and its `approval` semantics are recorded-only for now, like `ssh_shell`'s.
