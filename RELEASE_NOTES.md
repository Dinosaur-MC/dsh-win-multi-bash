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
