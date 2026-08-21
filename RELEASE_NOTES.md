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
