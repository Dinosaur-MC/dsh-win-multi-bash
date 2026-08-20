English | [中文](README.zh.md)

# dsh-win-multi-bash

A Windows multi-bash plugin for DeepSeek Harness: `git_bash` / `wsl_bash` model tools plus a `shell-select` executor that routes the single `ctx.shell` seat across Git Bash, WSL and pwsh. Pwsh stays the default, so existing behavior is unchanged until a bash-family tool is called.

## What it provides

| Tool | Backend | Dialect | Notes |
| --- | --- | --- | --- |
| `git_bash` | git-bash | MSYS | `request.shell: 'git-bash'`, Git for Windows toolchain |
| `wsl_bash` | wsl-bash | Linux | `request.shell: 'wsl-bash'`, WSL distro Linux userland |
| `pwsh` (existing) | pwsh | — | Selector default route; behavior identical to a deployment without the plugin |

- `shell-select` occupies the single `ctx.shell` seat and routes `request.shell ?? default` to one backend; `default` stays `pwsh`.
- Executable resolution and sandbox probing are lazy: a host without Git Bash or WSL does not affect pwsh; failures are loud at first use.
- Git Bash is found automatically, in order: an explicit `gitBash.bashPath`, Git install roots inferred from `git.exe` layout directories on PATH (so an install reachable through `git` is found without a pin, even outside the well-known locations), the well-known Program Files layout on every fixed drive (`C:\Program Files\Git`, `D:\Program Files\Git`, ...), `bash.exe` on PATH, and finally the `HKLM\SOFTWARE\GitForWindows` install path (which the Git for Windows installer always records, covering portable installs). The Windows WSL launcher `System32\bash.exe` and `WindowsApps` app-execution alias directories are **never** selected, and candidates must be real regular files — symlinks/reparse points are rejected — so a stale WSL `bash.exe` alias can never shadow a real Git Bash (this tool is MSYS, not WSL).
- Sandbox `auto`: Git Bash probes the windows-acl runner, WSL probes `bwrap` inside the distro; a failed probe degrades honestly to an unconfined run with no sandbox facts. An explicit `sandbox: bwrap` with bubblewrap missing fails loudly at the first `wsl_bash` command (never at boot), leaving the other backends untouched.
- All rows register host-plane: every session sees the tools regardless of its agent preset.

## Sandbox behavior (important — read first ⚠️)

The three backends do **not** share the same file-sandbox capability:

| Backend | Mechanism | enforcement | On probe failure |
| --- | --- | --- | --- |
| `pwsh` | windows-acl restricted-token runner | partial | no probe — always confined |
| `wsl_bash` | `bwrap` (bubblewrap) inside the distro | full | runs unconfined, no sandbox facts |
| `git_bash` | windows-acl runner wrapping MSYS bash | partial (when the probe passes) | runs unconfined, no sandbox facts when the probe fails |

> ⚠️ **`git_bash` usually cannot be sandboxed in Git for Windows deployments.** The windows-acl runner fails to launch the MSYS `bash.exe` under a restricted token (`CreateProcessAsUserW` returns Win32 error 2; `cmd.exe` and `pwsh.exe` launch fine). With `sandbox: auto`, a failed probe degrades to an **unconfined run** by contract. **Do not assume `git_bash` is protected by the DSH sandbox** — for sensitive operations use `pwsh` (restricted token active) or `wsl_bash` (bwrap active), or take the explicit escalation-approval path.
>
> ⚠️ **`wsl_bash` sandboxing depends on bubblewrap inside the distro.** Without bwrap, `auto` degrades to unconfined as well; the probe verdict is cached for the **host process lifetime** — after installing bwrap you must restart `dsh web` (or touch the shell settings section to trigger a backend rebuild) before it is re-probed.
>
> ⚠️ **A denial is only classified when the command exits non-zero.** If a blocked write is followed by a successful command (`echo nope > /etc/x; echo done`), the overall exit is 0 and no `[sandbox: file access denied]` marker is emitted — matching the upstream bash-sandbox rule to avoid false positives.
>
> The sandbox constrains **file effects only** (`workspace-write` / `read-only`); network and other resources are not limited.
> **`requireSandbox`: refuse unconfined runs when the probe fails (optional hardening).** Both backends support `requireSandbox: true` (default `false`, keeping the existing degrade-and-run behavior). When enabled, a failed probe (windows-acl unusable for git-bash / bwrap missing for wsl-bash) means: `danger-full-access` runs as usual (an unconfined run is equivalent to an explicit full-access grant), while `read-only` / `workspace-write` calls are **refused** with an error naming the fix and the escalation path. The tool layer also advertises the sandbox and opens the `sandbox_permissions` argument, so the model can take the approval-based escalation. Example:

> ```yaml
> # the win-mb-shell-select row in cordis.patch.yml
> config:
>   backends: [git-bash, wsl-bash, pwsh]
>   default: pwsh
>   gitBash: { requireSandbox: true }
>   wslBash: { requireSandbox: true }
> ```

> `requireSandbox` and `sandbox: none` are mutually exclusive in intent — explicit `none` is a deliberate opt-out and stays allowed; `requireSandbox` only governs the "sandbox wanted but probe failed" case.

### Enabling the bwrap sandbox for `wsl_bash`

`wsl_bash` sandboxing requires bubblewrap inside the distro. On Ubuntu/Debian:

```bash
wsl.exe -d Ubuntu-24.04 -e sudo apt-get install -y bubblewrap   # install straight from Windows
wsl.exe -d Ubuntu-24.04 -e bash -c "command -v bwrap && bwrap --version"   # verify
```

- The probe targets the **first distro** from `wsl -l -q`; if your target distro is not the first, pin it via `wslBash.wslDistro` in `cordis.patch.yml` and install bwrap **inside that distro** (e.g. `Ubuntu-24.04`; `docker-desktop` has no bash and cannot be used).
- `sudo` may require a password (depending on the distro's sudoers configuration); use `apt-get install -y` for scripting.
- Other distro families: Fedora `dnf install bubblewrap`, Alpine `apk add bubblewrap`.
- After installing you **must restart `dsh web`** (or touch the shell settings section to rebuild backends) — the probe verdict is cached for the host process lifetime, and `wsl_bash` stays unconfined until then.

## Path conversion (MSYS auto-rewriting)

Git Bash rewrites leading-slash POSIX paths into Windows paths (e.g. `<Git root>\root`) whenever a native Windows program is called — standard MSYS behavior, not a plugin defect. Calling `wsl.exe` (or any native exe) with POSIX paths from inside `git_bash` therefore fails:

```bash
wsl.exe -e ls /root                       # ✗ ls: cannot access 'D:/Program Files/Git/root'
MSYS_NO_PATHCONV=1 wsl.exe -e ls /root    # ✓ passed verbatim
```

- To pass arguments verbatim, prefix the call with `MSYS_NO_PATHCONV=1` (or `MSYS2_ARG_CONV_EXCL="*"`); a single argument can be escaped with a `//` prefix.
- For WSL work **prefer the `wsl_bash` tool**: it spawns `wsl.exe` directly from Node and ships the command as a base64 payload, so quoting and Linux paths reach the distro verbatim — no rewriting involved.
- The plugin's own internal paths (Git Bash probing, the bwrap workspace root, workdirs) are all passed by Node directly and are never subject to MSYS rewriting.

## Package contents

The full feature implementation ships in `lib/` as plain ESM JS — no build step — and imports only dsh's published base packages:

```
lib/
├── shell-select/   ShellSelectExecutor (the ctx.shell selector)
├── bash-git/       GitBashExecutor (MSYS)
├── bash-wsl/       WslBashExecutor (WSL, base64 payloads)
├── tool-bash/      tool factory + git_bash / wsl_bash instances
└── vendor/         helper modules for runner-failure classification and bwrap profiles
```

When the deployment's base bundle already provides its own `shell-select` row, the patch disables that row and lets this plugin's selector own the seat (two providers would conflict). On base bundles without it, the entry is a harmless no-op.

## Prerequisites

- A dsh profile with the published `@deepseek-ai` base packages (every standard deployment).
- Git Bash and/or WSL on the machine (a missing backend only errors at first use; pwsh is unaffected).

## Plug and unplug

Two mutually exclusive paths insert the same rows. Never use both at once — the loader rejects duplicate entry ids.

### Path A: hot plug (recommended, no restart)

```powershell
# Install
powershell -ExecutionPolicy Bypass -File .\install.ps1            # default profile: web
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName <name>

# Uninstall
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

The script links the package into `<profile>/node_modules/` (a junction), maintains the package-local `node_modules/@deepseek-ai` junction the bundled code needs, and writes a managed block into the profile's `cordis.patch.yml` — `dsh web` hot-reloads that file, so the feature goes live without a restart. The script is idempotent and auto-detects Git Bash installs outside the default probe paths by reading `HKLM:\SOFTWARE\GitForWindows` and pinning `gitBash.bashPath`.

### Path B: bundle install (portable, requires restart)

```powershell
# Install (pick one)
dsh plugin --profile web add dsh-win-multi-bash                    # npm published package (recommended)
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash   # GitHub repository source

# Uninstall
dsh plugin --profile web remove dsh-win-multi-bash
```

Requires `pnpm` (dsh plugin is a pnpm forwarder); the bundle layer is assembled at boot, so **restart `dsh web`** for it to take effect. Works on any profile, including freshly initialized ones.

## Verification

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke\run.ps1
```

Boots a real composition over the profile runtime (modifying nothing), verifies `git_bash` / `wsl_bash` register and execute real commands — including an explicit `bashPath` variant. Requires node >= 20.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| New sessions lack `git_bash` / `wsl_bash` | Check the managed block exists in the profile patch, the profile `node_modules/dsh-win-multi-bash` junction exists, and the package-local `node_modules/@deepseek-ai` junction exists (re-run install.ps1); confirm the running `dsh web` hot-reloads the profile patch |
| Boot fails with `duplicate loader entry id` | Both plug paths are active; remove one of them |
| Boot fails with `Cannot find package '@deepseek-ai/...'` | The package-local `node_modules/@deepseek-ai` junction is missing (re-run install.ps1), or the profile runtime lacks the base packages |
| `git_bash` reports bash not found (or spawns the WSL `WindowsApps\bash.exe` alias with `spawn ... ENOENT`) | Git Bash is outside the probe paths, or a stale WSL app-execution alias shadows resolution: delete `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` (Settings → Apps → Advanced app settings → App execution aliases), re-run install.ps1 (registry auto-detect), or set `gitBash.bashPath` manually |
| `wsl_bash` errors | Check `wsl.exe --status` for a default distro; set `wslBash.wslDistro` to name one |
| `wsl_bash` fails with `bwrap was not found` | `sandbox: bwrap` is set but bubblewrap is missing inside the distro: install it per “Sandbox behavior → Enabling the bwrap sandbox for `wsl_bash`” (`sudo apt-get install -y bubblewrap`) and restart `dsh web`, or use `sandbox: auto` / `none` |
| `wsl_bash` sandbox reports a runner failure on bwrap | The bwrap workspace root is the Linux side of a Windows drive path (`/mnt/<drive>/...`): a UNC workspace root fails loud, and a distro with a custom automount root (wsl.conf `automount.root`) needs a matching configuration |
| Calling `wsl.exe` (or other native exes) with POSIX paths from `git_bash` reports `No such file or directory` | MSYS rewrote `/root` etc. to `<Git root>\root`: prefix with `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL="*"`, or use a `//` prefix; use the `wsl_bash` tool for WSL work |
| `wsl_bash` still runs without a sandbox after installing bubblewrap | The bwrap probe verdict is cached for the host process lifetime: restart `dsh web`, or touch the shell settings section to trigger a backend rebuild |
| `shell-select: backend "x" is not enabled` | The `backends` list does not match the tool names; keep `backends: [git-bash, wsl-bash, pwsh]` |

## Layout

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle manifest; exports ./shell-select ./tool-git-bash ./tool-wsl-bash
├── cordis.patch.yml        # the composition wiring (documented inline)
├── install.ps1             # Path A hot plug (junctions + managed block + Git Bash detection)
├── uninstall.ps1           # Path A hot unplug
├── LICENSE / THIRD_PARTY_NOTICES
├── lib/                    # bundled implementation (plain ESM JS, no build step)
└── smoke/                  # smoke test (not published)
```
