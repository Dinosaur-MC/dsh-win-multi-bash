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
- Sandbox `auto`: Git Bash probes the windows-acl runner, WSL probes `bwrap` inside the distro; a failed probe degrades honestly to an unconfined run with no sandbox facts. An explicit `sandbox: bwrap` with bubblewrap missing fails loudly at the first `wsl_bash` command (never at boot), leaving the other backends untouched.
- All rows register host-plane: every session sees the tools regardless of its agent preset.

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
- Git Bash and/or WSL on the host (a missing backend only errors at first use; pwsh is unaffected).

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
# Install
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash

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
| `git_bash` reports bash not found | Git Bash is outside the default probe paths: re-run install.ps1 (registry auto-detect) or set `gitBash.bashPath` manually |
| `wsl_bash` errors | Check `wsl.exe --status` for a default distro; set `wslBash.wslDistro` to name one |
| `wsl_bash` fails with `bwrap was not found` | `sandbox: bwrap` is set but bubblewrap is missing inside the distro: install it (e.g. `apt install bubblewrap`), or use `sandbox: auto` / `none` |
| `wsl_bash` sandbox reports a runner failure on bwrap | The bwrap workspace root is the Linux side of a Windows drive path (`/mnt/<drive>/...`): a UNC workspace root fails loud, and a distro with a custom automount root (wsl.conf `automount.root`) needs a matching configuration |
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
