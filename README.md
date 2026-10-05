English | [中文](README.zh.md)

# dsh-win-multi-bash

A Windows multi-bash plugin for DeepSeek Harness: the `git_bash` / `wsl_bash` model tools, each owning its own Git Bash / WSL executor. The plugin never touches the `ctx.shell` seat — dsh's own pwsh executor keeps it — so pwsh behavior is identical to a deployment without the plugin.

## What it provides

| Tool | Backend | Dialect | Notes |
| --- | --- | --- | --- |
| `git_bash` | git-bash | MSYS | Owns a `GitBashExecutor`; Git for Windows toolchain |
| `wsl_bash` | wsl-bash | Linux | Owns a `WslBashExecutor`; WSL distro Linux userland |
| `pwsh` (dsh's own) | pwsh | — | Served by the base bundle's `pwsh-sandbox` row, untouched by this plugin |

- Each tool constructs and drives its own executor; neither registers as `ctx.shell`, so the seat — and every plugin that injects `shell` (dsh's `tool-pwsh`, `permission-presets`, …) — is unaffected by this plugin being loaded.
- Why there is no selector any more: dsh 0.1.7 dropped `ShellExecRequest.shell`, the routing field the pre-0.1.7 `shell-select` design dispatched on. With no routing input left, the tool is what knows which shell it wants — so the selector has nothing to select on, and is gone.
- Executable resolution and sandbox probing are lazy: a host without Git Bash or WSL does not affect pwsh; failures are loud at first use.
- Git Bash is found automatically, in order: an explicit `gitBash.bashPath`, Git install roots inferred from `git.exe` layout directories on PATH (so an install reachable through `git` is found without a pin, even outside the well-known locations), the well-known Program Files layout on every fixed drive (`C:\Program Files\Git`, `D:\Program Files\Git`, ...), `bash.exe` on PATH, and finally the `HKLM\SOFTWARE\GitForWindows` install path (which the Git for Windows installer always records, covering portable installs). The Windows WSL launcher `System32\bash.exe` and `WindowsApps` app-execution alias directories are **never** selected, and candidates must be real regular files — symlinks/reparse points are rejected — so a stale WSL `bash.exe` alias can never shadow a real Git Bash (this tool is MSYS, not WSL).
- Sandbox `auto`: Git Bash probes the windows-acl runner, WSL probes `bwrap` inside the distro; a failed probe degrades honestly to an unconfined run with no sandbox facts. An explicit `sandbox: bwrap` with bubblewrap missing fails loudly at the first `wsl_bash` command (never at boot), leaving the other backends untouched.
- All rows register host-plane: every session sees the tools regardless of its agent preset.

## Sandbox behavior (important — read first ⚠️)

The three backends do **not** share the same file-sandbox capability:

| Backend | Mechanism | enforcement | On probe failure |
| --- | --- | --- | --- |
| `pwsh` | windows-acl restricted-token runner | partial | no probe — always confined (dsh's own executor) |
| `wsl_bash` | `bwrap` (bubblewrap) inside the distro | full | runs unconfined, no sandbox facts |
| `git_bash` | windows-acl runner wrapping MSYS bash | partial (when the probe passes) | runs unconfined, no sandbox facts when the probe fails |

> ⚠️ **`git_bash` usually cannot be sandboxed in Git for Windows deployments.** The windows-acl runner fails to launch the MSYS `bash.exe` under a restricted token (`CreateProcessAsUserW` returns Win32 error 2; `cmd.exe` and `pwsh.exe` launch fine). With `sandbox: auto`, a failed probe degrades to an **unconfined run** by contract. **Do not assume `git_bash` is protected by the DSH sandbox** — for sensitive operations use `pwsh` (restricted token active) or `wsl_bash` (bwrap active), or take the explicit escalation-approval path.
>
> ⚠️ **`wsl_bash` sandboxing depends on bubblewrap inside the distro.** Without bwrap, `auto` degrades to unconfined as well; the probe verdict is cached for the **host process lifetime** — after installing bwrap you must restart `dsh web` (or reload the tool row by editing the profile patch) before it is re-probed.
>
> ⚠️ **A denial is only classified when the command exits non-zero.** If a blocked write is followed by a successful command (`echo nope > /etc/x; echo done`), the overall exit is 0 and no `[sandbox: file access denied]` marker is emitted — matching the upstream bash-sandbox rule to avoid false positives.
>
> The sandbox constrains **file effects only** (`workspace-write` / `read-only`); network and other resources are not limited.
> **`requireSandbox`: refuse unconfined runs when the probe fails (optional hardening).** Both backends support `requireSandbox: true` (default `false`, keeping the existing degrade-and-run behavior). When enabled, a failed probe (windows-acl unusable for git-bash / bwrap missing for wsl-bash) means: `danger-full-access` runs as usual (an unconfined run is equivalent to an explicit full-access grant), while `read-only` / `workspace-write` calls are **refused** with an error naming the fix and the escalation path. The tool layer also advertises the sandbox and opens the `sandbox_permissions` argument, so the model can take the approval-based escalation. Example:

> ```yaml
> # the win-mb-shell-prompt / win-mb-tool-git / win-mb-tool-wsl rows in cordis.patch.yml:
> # each tool row carries only its own backend's partition
> - id: win-mb-tool-git
>   name: 'dsh-win-multi-bash/tool-git-bash'
>   config:
>     gitBash: { requireSandbox: true }
>
> - id: win-mb-tool-wsl
>   name: 'dsh-win-multi-bash/tool-wsl-bash'
>   config:
>     wslBash: { requireSandbox: true }
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
- After installing you **must restart `dsh web`** (or reload the tool row by editing the profile patch) — the probe verdict is cached for the host process lifetime, and `wsl_bash` stays unconfined until then.

## Tool prompts (model-facing descriptions)

Each tool description is deliberately small: it states only what its own dialect owns — the shell and invocation, the dialect's path and environment-variable syntax, and (for `git_bash`) the MSYS note. Everything the family shares is stated once, by the single `tool:win-mb-bash` prompt section owned by the `win-mb-shell-prompt` row: a fresh shell per call plus the `workdir` rule, `[exit code: N]` markers with the `&&` / `set -o pipefail` gating rule, `$DSH_*` environment facts, sandbox behavior, output truncation, delete/move target verification, the unset-variable `${VAR:?}` guard, background jobs, and the escalation contract. The longer dialect notes (MSYS path rewriting, WSL base64 payloads) live in this README rather than in the model-facing text.

Both tools run `bash -c`, so that safety guidance is worded as in `tool-bash`, not as in `tool-pwsh`: `$HOME` is an ordinary assignable variable in bash, so pwsh's "do not assign to automatic variables" sentence would be wrong here — the bash guard for a computed path is the `${VAR:?}` form above, which makes an unset variable fail instead of silently expanding to an empty string.

`git_bash`'s description additionally carries a path-format hint:

> MSYS paths work inside Git Bash only — dsh's file tools (`read`, `write`, `edit`) on Windows take native `C:\...` paths.

So when a command prints an MSYS path (e.g. `/d/WorkSpace/foo`), convert it to its Windows form (`D:\WorkSpace\foo`) before handing it to dsh's file tools; inside the bash command itself, MSYS paths are what the shell expects.

**`workdir` accepts native, MSYS and WSL-automount forms.** A model told that the dialect's paths are MSYS- or WSL-shaped will naturally write `workdir` that way, so the resolver translates a single-letter drive form (`/c/...`) and the WSL automount form (`/mnt/c/...`) into the native `C:\...` before the executor hands the value to `spawn`; MSYS POSIX roots (`/etc`, `/usr`, `/tmp`) and distro-side paths such as `/mnt/data` are left untouched, and a relative `workdir` still resolves against the session workspace. Before that translation an MSYS-form `workdir` failed as `spawn <shell> ENOENT` — a missing-shell symptom for what is really an unusable cwd.

**One section for the family, not one per tool.** The `tool:win-mb-bash` section — registered by the `win-mb-shell-prompt` row, owned by neither tool — carries that shared guidance: check the `[exit code: N]` marker on every result and chain dependent steps with `&&` or `set -o pipefail`, because `;` never stops on failure and `cmd | tail` returns the status of `tail`, not of `cmd`. That is guidance about *composing* a multi-step command rather than about one call's arguments, so it belongs to the prompt instead of the per-call schema; the runtime's own tail truncation is also why a call never needs to bound output with a pipe. Prompt sections live in one global layer keyed by name, so two rows registering the same name throw while two names carrying the same text is duplication — on 0.3.1 the two descriptions were 1299 and 2164 characters with 1117 of them byte-identical, and the exit-status paragraph was assembled twice. The section's text is therefore resolved at every assembly from the tools actually mounted (`ctx.tools.get`), so `git_bash` and `wsl_bash` stay independently switchable: either alone, both, or neither each render exactly one correct copy, and a composition with neither renders no shell guidance at all. Its order is the midpoint of dsh's `TOOL_BASH` / `TOOL_PWSH` section orders, read from `ctx.systemPrompt.getSectionOrder`. The escalation contract and the background sentence are included only while a mounted tool actually advertises `sandbox_permissions` / `run_in_background`. The section never reads facts out of another row's description, so it stays self-sufficient whether or not dsh's `tool-pwsh` is in the composition; the sentences pwsh's own description shares with it are the residue a third-party row cannot edit away.

## Runtime configuration (the Plugins page)

Both tool rows carry their own configuration, and every knob is declared `.volatile()` — which is what makes it addressable by the runtime's settings service. The Web **Plugins** page therefore edits it: open **Plugins** in the sidebar, open the `dsh-win-multi-bash` bundle, and each row has a **Configure** page. The browser half (`lib/client.js`, declared as `dsh.client` + the `./client` export) registers that page into the page's `plugins.row.config` slot, keyed `dsh-win-multi-bash#<row id>`; a save goes to the profile's Cordis patch through `settings`/`ctx.configForms` — the same place a hand edit lands, with no HTTP route, no second settings file, and no YAML editing.

The patch therefore also inserts a fourth, behavior-free row — `win-mb-plugin`, `name: 'dsh-win-multi-bash'` — and it is not optional: `dsh-client-modules` discovers a browser half by resolving a row's **bare package specifier** to its `package.json` and reading `dsh.client` there (`locatePkgJson` → `exactPackageSpecifier`, which answers `undefined` for a subpath). All three runtime rows are subpaths, so without that row the client bundle is never served and the rows show no Configure control at all. Its module (`lib/index.js`) is the documented shape for such a carrier: an empty `apply`.

| Row | Options (in page order) |
|---|---|
| `git_bash` | Background jobs (`enableRunInBackground`); `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`; `bashPath`; sandbox stance (`auto` / `none`); `probeTimeoutMs`; `requireSandbox` |
| `wsl_bash` | The same set under `wslBash`, plus `wslPath` and `wslDistro`, and the stance list adds `bwrap` |

That list is exactly the volatile projection of each row's `Config` schema — the audit pins both sides (`volatilePaths` of the host configs against the browser half's field table), so a knob added to a backend without `.volatile()` cannot silently stay YAML-only, and the page cannot offer a field the Host would refuse.

- **Live reads.** Volatile fields are live references, and the executors read them through `.get()` at use time. A path, distro, stance, timeout, or hardening change applies to the next command without reloading the row.
- **Two knobs need the row's next load**, because they shape the tool's *schema* rather than one call: `enableRunInBackground` (the advertised `run_in_background` argument) and the escalation surface (`sandbox_permissions`, advertised at load from the probe verdict).
- **Staged, not live typing.** The page stages drafts and writes only on **Save**, fenced by the revision it read; a save the Host refuses keeps the drafts. Emptying a path or a distro stages a clear, so the override drops and the built-in probe resolves again.
- The page exists while the Host serves that row's namespace (`whileServed`), so a row that is switched off shows no Configure control.

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
├── bash-git/       GitBashExecutor (MSYS)
├── bash-wsl/       WslBashExecutor (WSL, base64 payloads)
├── tool-bash/      tool factory + git_bash / wsl_bash instances,
│                   backend ownership (types/backend.js)
└── vendor/         helper modules for runner-failure classification and bwrap profiles
```

Because no row of this plugin registers as `ctx.shell`, the patch inserts only its own two tool rows and disables nothing: the base bundle's shell wiring (`pwsh-sandbox` on win32, `bash-sandbox` elsewhere) stays exactly as shipped, and pwsh keeps working whether or not this plugin is loaded.

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

Boots a real composition over the profile runtime (modifying nothing), verifies `git_bash` / `wsl_bash` register and execute real commands — including an explicit `bashPath` variant — and asserts `ctx.shell` is still provided by the base bundle's own row (the regression this plugin once caused). Requires node >= 20.

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke\audit.ps1
```

Runs the full audit suite instead: pure-unit coverage of the vendor helpers, executor internals and tool config schemas, plus boot-integration matrices for the real `cordis.patch.yml` and for misconfigurations.

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
| `wsl_bash` still runs without a sandbox after installing bubblewrap | The bwrap probe verdict is cached for the host process lifetime: restart `dsh web`, or reload the tool row by editing the profile patch |
| Boot warns `win-mb-tool-git … waiting for service: shell` (or dsh's own `tool-pwsh` / `permission-presets` do) | Nothing provides `ctx.shell`. This plugin no longer provides it either: check the base bundle's `pwsh-sandbox` row is not disabled by some other patch |

## Layout

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle manifest; exports ./tool-git-bash ./tool-wsl-bash
├── cordis.patch.yml        # the composition wiring (documented inline)
├── install.ps1             # Path A hot plug (junctions + managed block + Git Bash detection)
├── uninstall.ps1           # Path A hot unplug
├── LICENSE / THIRD_PARTY_NOTICES
├── lib/                    # bundled implementation (plain ESM JS, no build step)
└── smoke/                  # smoke test (not published)
```
