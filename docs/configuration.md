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
| `ssh_bash` | The same tool-layer switch plus the same set under `sshBash`: `sshPath`, `sshHost`, `sshUser`, `sshPort`, `acceptNewHostKeys`, `connectTimeoutMs`, and the sandbox knobs. `probeTimeoutMs` and `sandboxNotice` are structurally inert here — this dialect never probes and never degrades — and `requireSandbox` refuses every command rather than pretending |
| `terminal` | Interactive sessions: `defaultShell` (which dialect `open` uses by default); `maxSessions`; `idleMs`; `rows` / `cols`; `maxBufferBytes`; `waitMs` / `quietMs` / `maxWaitMs`; `allowUnconfined`; plus one executable pin per dialect (`gitBash.bashPath`, `wslBash.wslPath` / `wslDistro`, `msys2Bash.bashPath`, `sshBash.sshPath` / `sshHost` / `sshUser` / `sshPort` / `acceptNewHostKeys` / `connectTimeoutMs`) |
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
- `ssh_bash` is opt-in for a reason of its own: a deployment has to name the host. Enable `win-mb-tool-ssh` and pin `sshBash.sshHost` (plus `sshUser` / `sshPort` when they are not the client's defaults); a row with no host refuses every call and names that field. `sshPath` is trusted when it exists and otherwise warns once and falls back to discovery, exactly like `bashPath`. Escalation is advertised only while `requireSandbox` is on: without it the row advertises no confinement it cannot provide, so there is no `sandbox_permissions` argument to misuse.

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
