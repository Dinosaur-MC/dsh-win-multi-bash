English | [中文](README.zh.md)

# dsh-win-multi-bash

[![npm version](https://img.shields.io/npm/v/dsh-win-multi-bash.svg)](https://www.npmjs.com/package/dsh-win-multi-bash)
[![license](https://img.shields.io/npm/l/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/package.json)
[![GitHub stars](https://img.shields.io/github/stars/Dinosaur-MC/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/stargazers)
![dsh ≥ 0.1.7-rc.2](https://img.shields.io/badge/dsh-%E2%89%A5%200.1.7--rc.2-blue.svg)
![platform: windows](https://img.shields.io/badge/platform-windows-0078d4.svg)
![dialects: MSYS, WSL, MSYS2, SSH](https://img.shields.io/badge/dialects-MSYS%20%7C%20WSL%20%7C%20MSYS2%20%7C%20SSH-4c1.svg)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/dinosaur-mc/dsh-win-multi-bash)

A Windows multi-bash plugin for DeepSeek Harness: the `git_bash` / `wsl_bash` model tools plus the opt-in `msys2_bash` and `ssh_bash`, each owning its own executor. The plugin never touches the `ctx.shell` seat — dsh's own pwsh executor keeps it — so pwsh behavior is identical to a deployment without the plugin.

## What it provides

| Tool | Backend | Dialect | Notes |
| --- | --- | --- | --- |
| `git_bash` | git-bash | MSYS | Owns a `GitBashExecutor`; Git for Windows toolchain |
| `wsl_bash` | wsl-bash | Linux | Owns a `WslBashExecutor`; WSL distro Linux userland |
| `msys2_bash` | msys2-bash | MSYS2 | **Opt-in**: owns a `Msys2BashExecutor`; MSYS2's own bash (`$MSYSTEM`, `pacman`) — a second toolchain next to Git Bash |
| `ssh_bash` | ssh-bash | Remote (SSH) | **Opt-in**: owns a `SshBashExecutor`; one command per call through the OpenSSH client. Its effects are on the other host, so no local file sandbox applies: every result carries `sandbox: { mode, remote: true }` |
| `terminal` | git-bash / wsl-bash / msys2-bash / ssh-bash | MSYS / Linux / MSYS2 / SSH | Interactive PTY sessions; the backend is whichever dialect `shell` names |
| `pwsh` (dsh's own) | pwsh | — | Served by the base bundle's `pwsh-sandbox` row, untouched by this plugin |

- Each tool constructs and drives its own executor; neither registers as `ctx.shell`, so the seat — and every plugin that injects `shell` (dsh's `tool-pwsh`, `permission-presets`, …) — is unaffected by this plugin being loaded.
- Why there is no selector any more: dsh 0.1.7 dropped `ShellExecRequest.shell`, the routing field the pre-0.1.7 `shell-select` design dispatched on. With no routing input left, the tool is what knows which shell it wants — so the selector has nothing to select on, and is gone.
- Executable resolution and sandbox probing are lazy: a host without Git Bash or WSL does not affect pwsh; failures are loud at first use.
- Git Bash is found automatically, in order: an explicit `gitBash.bashPath`, Git install roots inferred from `git.exe` layout directories on PATH (so an install reachable through `git` is found without a pin, even outside the well-known locations), the well-known Program Files layout on every fixed drive (`C:\Program Files\Git`, `D:\Program Files\Git`, ...), `bash.exe` on PATH, and finally the `HKLM\SOFTWARE\GitForWindows` install path (which the Git for Windows installer always records, covering portable installs). The Windows WSL launcher `System32\bash.exe` and `WindowsApps` app-execution alias directories are **never** selected, and candidates must be real regular files — symlinks/reparse points are rejected — so a stale WSL `bash.exe` alias can never shadow a real Git Bash (this tool is MSYS, not WSL).
- Sandbox `auto`: Git Bash probes the windows-acl runner, WSL probes `bwrap` inside the distro; a failed probe degrades honestly to an unconfined run with no sandbox facts. An explicit `sandbox: bwrap` with bubblewrap missing fails loudly at the first `wsl_bash` command (never at boot), leaving the other backends untouched.
- All rows register host-plane: every session sees the tools regardless of its agent preset.
- `ssh_bash` is the family's only **remote** dialect. It drives the OpenSSH client (`ssh <host> <command>`) and the command runs on the other host, so it is the one dialect the local file sandbox cannot speak for (see “Sandbox behavior”). The target is **deployment configuration** — `sshHost` / `sshUser` / `sshPort`, never a tool argument — so the model can never point the tool at a host the deployment did not pin, and the client is resolved from the Windows OpenSSH location (`%SystemRoot%\System32\OpenSSH\ssh.exe`) and then PATH, which is where a Git-for-Windows client lives.

## Sandbox behavior (important — read first ⚠️)

The three backends do **not** share the same file-sandbox capability:

| Backend | Mechanism | enforcement | On probe failure |
| --- | --- | --- | --- |
| `pwsh` | windows-acl restricted-token runner | partial | no probe — always confined (dsh's own executor) |
| `wsl_bash` | `bwrap` (bubblewrap) inside the distro | full | runs unconfined, no sandbox facts |
| `git_bash` | windows-acl runner wrapping MSYS bash | partial (when the probe passes) | runs unconfined, no sandbox facts when the probe fails |
| `ssh_bash` | none applies — the command runs on another host | n/a | no probe and no wrapper: nothing here governs a remote file effect |

> ⚠️ **`ssh_bash` is outside the DSH file sandbox, and says so instead of claiming otherwise.** A file sandbox fences the *local* effects of a command this host runs; an SSH command's effects are on the other host. The row therefore applies **no wrapper at all** — wrapping `ssh.exe` would only restrict which local keys and `known_hosts` the client may read (a different axis), and would in fact break the client, which must read `~/.ssh/*` outside the workspace root — and every result carries `sandbox: { mode, remote: true }`. `denied`, `enforcement`, `runnerFailed` and `unconfined` are all **absent** there: the first three would describe a sandbox that never ran, and `unconfined` means "a sandbox was asked for and could not be applied", which is not what happened. The model reads one sentence instead: `[sandbox: not applicable — this command runs on a remote host, so the local file sandbox (<mode> mode) was not applied and no verdict is claimed for its effects]`. Consequently `requireSandbox: true` **refuses every command** on this row (the documented way through is an explicit `danger-full-access` escalation), and the family prompt section drops its file-sandbox sentence while no locally-sandboxable family tool is mounted.
>
> ⚠️ **A stopped SSH call stops the client, not the remote command (measured on this host, 2026-10-17).** `ssh -T host 'sleep N'` survives a `kill -9` of the local client: with no remote tty, sshd only closes the channel and never signals the command (ignoring SIGHUP is not even required). The PTY form — `terminal` with `shell: ssh_bash` — is the one that reaps the remote process group when the session ends. So make long remote work self-limiting on the remote side (`timeout`, `systemd-run`), or interrupt it through a session.
>
> ⚠️ **`git_bash` usually cannot be sandboxed in Git for Windows deployments.** The windows-acl runner fails to launch the MSYS `bash.exe` under a restricted token (`CreateProcessAsUserW` returns Win32 error 2; `cmd.exe` and `pwsh.exe` launch fine). With `sandbox: auto`, a failed probe degrades to an **unconfined run** by contract. **Do not assume `git_bash` is protected by the DSH sandbox** — for sensitive operations use `pwsh` (restricted token active) or `wsl_bash` (bwrap active), or take the explicit escalation-approval path.
>
> ⚠️ **`wsl_bash` sandboxing depends on bubblewrap inside the distro.** Without bwrap, `auto` degrades to unconfined as well; the probe verdict is cached for the **host process lifetime** — after installing bwrap you must restart `dsh web` (or reload the tool row by editing the profile patch) before it is re-probed.
>
> ⚠️ **A denial is only classified when the command exits non-zero.** If a blocked write is followed by a successful command (`echo nope > /etc/x; echo done`), the overall exit is 0 and no `[sandbox: file access denied]` marker is emitted — matching the upstream bash-sandbox rule to avoid false positives. What the `sandbox` value then says is deliberately narrow: a **successful** confined run reports `denied: false`; a **failed** one whose stderr matches this backend's denial dialect reports `denied: true`; a failed one that matches nothing reports **no `denied` at all** plus `[sandbox: the command failed without matching this backend's denial dialect; see stderr]` — we do not assert a denial nobody observed. An unwrapped run reports only `{mode, unconfined: true}`, because a run outside a sandbox cannot have been denied by one.
>
> The sandbox constrains **file effects only** (`workspace-write` / `read-only`); network and other resources are not limited.
> **`requireSandbox`: refuse unconfined runs when the probe fails (optional hardening).** Both backends support `requireSandbox: true` (default `false`, keeping the existing degrade-and-run behavior). When enabled, a failed probe (windows-acl unusable for git-bash / bwrap missing for wsl-bash) means: `danger-full-access` runs as usual (an unconfined run is equivalent to an explicit full-access grant), while `read-only` / `workspace-write` calls are **refused** with an error naming the fix and the escalation path. The tool layer also advertises the sandbox and opens the `sandbox_permissions` argument, so the model can take the approval-based escalation. Example:

> ```yaml
> # the win-mb-plugin (core row) / win-mb-tool-git / win-mb-tool-wsl rows in cordis.patch.yml:
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

- **The windows-acl backend is stateful about exactly one directory.** It materializes ONE private temp root per (session, workspace root) — `%TEMP%\dsh-<6 alphanumerics>` — and caches that path for the whole session; its runner treats `--temp` as an input that must already exist, so a missing path is a hard failure (`windows-acl-run: --temp is not an existing directory: <path>`, exit 127) and every later *wrapped* spawn of that session fails until it is back. Recreating the directory by hand restores **existence only** — the seam's write grant (`tempWriteSid` ACE) does not come back, so a confined child writing its own `%TEMP%` stays denied. This plugin therefore recreates the directory **and re-applies the seam's own write grant** on the next confined run of a `git_bash` / `msys2_bash` row — the `guardSandboxTemp` switch, default on (see “Runtime configuration”). Measured on this machine 2026-10-16 (reproduced by this package's own audit; the ad-hoc device script stays a workspace artifact and is not shipped): without the grant a wrapped `cmd.exe` write into its own `%TEMP%` fails with “Access is denied”; with the grant it succeeds; after deleting the private root the runner exits 127 with that signature; after the heal the wrapped write succeeds again.

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

Each tool description is deliberately small: it states only what its own dialect owns — the shell and invocation, the dialect's path and environment-variable syntax, and (for `git_bash`) the MSYS note. Everything the family shares is stated once, by the single `tool:win-mb-bash` prompt section owned by the plugin's core row (the package row, `win-mb-plugin`): a fresh shell per call plus the `workdir` rule, `[exit code: N]` markers with the `&&` / `set -o pipefail` gating rule, `$DSH_*` environment facts, sandbox behavior, output truncation, delete/move target verification, the unset-variable `${VAR:?}` guard, background jobs, and the escalation contract. The longer dialect notes (MSYS path rewriting, WSL base64 payloads) live in this README rather than in the model-facing text.

Both tools run `bash -c`, so that safety guidance is worded as in `tool-bash`, not as in `tool-pwsh`: `$HOME` is an ordinary assignable variable in bash, so pwsh's "do not assign to automatic variables" sentence would be wrong here — the bash guard for a computed path is the `${VAR:?}` form above, which makes an unset variable fail instead of silently expanding to an empty string.

`git_bash`'s description additionally carries a path-format hint:

> MSYS paths work inside Git Bash only — dsh's file tools (`read`, `write`, `edit`) on Windows take native `C:\...` paths.

So when a command prints an MSYS path (e.g. `/d/WorkSpace/foo`), convert it to its Windows form (`D:\WorkSpace\foo`) before handing it to dsh's file tools; inside the bash command itself, MSYS paths are what the shell expects.

**`workdir` accepts native, MSYS and WSL-automount forms.** A model told that the dialect's paths are MSYS- or WSL-shaped will naturally write `workdir` that way, so the resolver translates a single-letter drive form (`/c/...`) and the WSL automount form (`/mnt/c/...`) into the native `C:\...` before the executor hands the value to `spawn`; MSYS POSIX roots (`/etc`, `/usr`, `/tmp`) and distro-side paths such as `/mnt/data` are left untouched, and a relative `workdir` still resolves against the session workspace. Before that translation an MSYS-form `workdir` failed as `spawn <shell> ENOENT` — a missing-shell symptom for what is really an unusable cwd.

**One section for the family, not one per tool.** The `tool:win-mb-bash` section — owned by the package row (the plugin's core row), and by neither tool — carries that shared guidance: check the `[exit code: N]` marker on every result and chain dependent steps with `&&` or `set -o pipefail`, because `;` never stops on failure and `cmd | tail` returns the status of `tail`, not of `cmd`. That is guidance about *composing* a multi-step command rather than about one call's arguments, so it belongs to the prompt instead of the per-call schema; the runtime's own tail truncation is also why a call never needs to bound output with a pipe. Prompt sections live in one global layer keyed by name, so two rows registering the same name throw while two names carrying the same text is duplication — on 0.3.1 the two descriptions were 1299 and 2164 characters with 1117 of them byte-identical, and the exit-status paragraph was assembled twice. The section's text is therefore resolved at every assembly from the tools actually mounted (`ctx.tools.get`), so `git_bash` and `wsl_bash` stay independently switchable: either alone, both, or neither each render exactly one correct copy, and a composition with neither renders no shell guidance at all. Its order is the midpoint of dsh's `TOOL_BASH` / `TOOL_PWSH` section orders, read from `ctx.systemPrompt.getSectionOrder`. The escalation contract and the background sentence are included only while a mounted tool actually advertises `sandbox_permissions` / `run_in_background`. The section never reads facts out of another row's description, so it stays self-sufficient whether or not dsh's `tool-pwsh` is in the composition; the sentences pwsh's own description shares with it are the residue a third-party row cannot edit away.

**The section is scope-aware about the sandbox.** Its file-sandbox sentence is a promise about the *local* effects of the command this host runs, so it is included only while a mounted family tool runs locally, and a remote-scope sentence is added while a remote dialect is mounted (`ssh_bash`): each dialect declares where its effects happen (`effects: 'local' | 'remote'`, a required registry field validated at boot), so the section reads one source instead of inferring it from a tool name.

**Row switches: what each combination does.** The bundle ships one row per shell tool plus the core row and the session row — and the Plugins page can switch each one, so the combination space is worth stating. Only one combination changes the *text*; none of them loses information:

| `win-mb-plugin` (core row) | `win-mb-tool-git` / `win-mb-tool-wsl` | Result |
|---|---|---|
| on | any subset | Intended: each tool states its dialect facts, the core row's section states the shared guidance once, following the mounted subset (a tool that advertises no `sandbox_permissions` also gets no escalation paragraph). |
| on | **both off** | No family tool is mounted, so the section resolves to empty text and the rendered prompt contains no shell guidance and no shell section at all. The two Configure pages disappear with their rows. |
| **off** | any subset | The Web client has no package row to find `dsh.client` on, so it serves no browser half and the Plugins page shows no **Configure** control. The tools keep working: with the section gone, each tool description carries the shared guidance itself (the fallback, which also logs a warning). |

The core row cannot be marked read-only: `dsh`'s plugin manager locks only the rows from its own protected-module list, its own row, and rows its profile patch cannot address (`readOnlyReason: "management-required" | "unaddressable"`) — there is no manifest flag a third-party bundle can set. The composition is therefore built so that switching the core row off cannot half-break anything: the tool rows are the ones a user actually toggles, and the third row above is the only consequence. Two rows became three: 0.3.0 and 0.3.1 shipped **only** `win-mb-tool-git` and `win-mb-tool-wsl`, so a hand-wired profile that is not migrated still resolves and loads both tools and behaves the same; the missing core row only means the shared guidance falls back into each tool description (above) and that the Plugins-page Configure control is absent — which 0.3.1 did not have either. Re-run `dsh plugin --profile web add dsh-win-multi-bash`, or add the `win-mb-plugin` row to the profile's `cordis.patch.yml` by hand, to get the core row. The separate `win-mb-shell-prompt` row that existed briefly in the development commits between 0.3.1 and 0.4.0 is simply gone — no published version ever declared it, so 0.4.0 ships no module behind that name. A profile that still carries it boots with one inactive entry (the module no longer resolves) and is otherwise unaffected: both tools load, and with no section owner composed each description carries the shared guidance itself.

Two further caveats. A row switched off *at runtime* takes effect immediately for the section (it is resolved per assembly), but a tool row that was already loaded keeps the description it registered: the fallback therefore appears only after that tool row reloads, or after a restart. And a warning issued at startup goes through cordis's logger, which the boot collector keeps for its failure report but discards on a successful boot at the default log level — so the fallback text, not the log line, is what actually guarantees the model keeps the guidance.

## Interactive terminal sessions (`terminal`)

`terminal` runs a **persistent PTY session** — a real interactive shell that stays alive between calls, so the current directory, exported variables, aliases, functions and background jobs survive. Use it for REPLs, debuggers, `ssh`, database clients, TUI programs, or any workflow that depends on shell state.

| Action | What it does |
|---|---|
| `open` | Starts a session and returns its `sessionId`, pid, cwd and startup output. |
| `send` | Writes `text` (with Enter unless `submit: false`) and returns the reply. |
| `read` | Reads new output without writing; `offset` re-reads from a whole-stream byte offset. |
| `signal` | Delivers a signal to the foreground process group. On this platform only `SIGINT` (Ctrl+C) actually reaches the shell — see the signals bullet below. |
| `close` | Ends the session and waits for its session tree to become quiescent. |
| `list` | The sessions you own. |

- **The backend is the dialect registry.** `shell` names one of the dialects that declare interactive-session capability — `git_bash`, `wsl_bash`, `msys2_bash`, `ssh_bash` — and each executor supplies its own interactive argv (`bash.exe -i`, `wsl.exe --cd <dir> [-d <distro>] -- bash -i`, or `ssh.exe -t <options> -- <host>`). `terminal.defaultShell` picks the default; a dialect that declares no session is never offered.
- **One interactive shell per session, using the user's own startup files.** `-i` only — no `--noprofile --norc` — because the aliases and exported functions a session exists to preserve are exactly what those files set up.
- **A wait that ends on silence is not a finished command.** `send` / `signal` return once output has been silent for `quietMs` and report `waitReason: "quiet"`; a tty echoes input within milliseconds, so silence usually starts long before a command finishes. `timeout` means the wait hit `waitMs` and the session is still running. Either way, `read` again for more — `quiet` deliberately does not claim "done".
- **Output is a stream, so it is bounded and honest about it.** Each session retains the last `maxBufferBytes` (default 1 MiB) of *sanitized* text, and reports two facts separately: `truncated` (this session dropped output at some point) and `lossy` (the offset this read asked for had already been dropped, so the whole retained tail came back instead of a delta). ANSI escape sequences are stripped; there is no terminal emulator here, so a program that redraws one line with carriage returns becomes several lines.
- **Sessions are capped, reclaimed, and process-local.** `maxSessions` (default 8) refuses the next `open` by name; a session untouched by `send`/`read`/`signal` for `idleMs` (default 10 minutes) is terminated, and its id afterwards says it was reclaimed by the idle reaper rather than looking unknown. Sessions do **not** survive a `dsh` restart.
- **Sessions are not jobs.** They are not registered in `ctx.jobs`, so `job_kill` cannot reach one: `close` is the only way to end a session, with the idle reaper as the backstop.
- **A PTY session runs unconfined, and says so.** The file sandbox wraps the argv of a spawned command; a terminal session is allocated by a different provider call, and on this host the windows-acl runner cannot start MSYS bash at all (measured here: `0xC0000142`) (above), so there is no honest way to confine one. Every `open` carries that fact, and `terminal.allowUnconfined: false` makes `open` refuse instead of running unprotected.
- **Only `SIGINT` reaches the shell here, and the other four say so.** Measured on this host: a win32 ConPTY terminal reports pid `0`, the provider's foreground-group lookup returns that same 0, and its kill path begins `if (pid <= 0) return` — so `SIGTERM` would RESOLVE (reporting success) while delivering nothing to any process, and `SIGKILL` is refused by the provider for the same reason. This tool therefore refuses `SIGTERM`/`SIGKILL` **by name** rather than returning a success that reached nothing; `SIGTSTP`/`SIGHUP` are refused by the provider and that refusal is reported verbatim; `SIGINT` is delivered as a Ctrl+C byte and does interrupt the foreground command (verified: it stops a `sleep 30` while the session stays usable).
- **Two provider facts to know.** `pid` is `0` on Windows (ConPTY), so it is display-only; and `inspectActivity()` always answers `unknown` there, which is why readiness falls back to output silence — on a provider that can answer, `idle` settles at once and `busy` keeps the wait going.
- **An SSH session is where a first-connect question can be answered — and the only form that reaps the remote side.** `open` with `shell: ssh_bash` runs `ssh.exe -t … -- <host>` with no `BatchMode`, so the real PTY is exactly what lets ssh ask for an unknown host's fingerprint, a password or a key passphrase — answer with `send`. The same PTY is what makes sshd reap the remote process group when the session ends, while a one-shot `ssh -T` command outlives its killed client (measured; see “Sandbox behavior”). Two honest limits: anything typed through `send` becomes part of the tool call, so authenticate with a key rather than typing a secret; and a session's `cwd` is where `ssh.exe` runs locally, never a remote directory.
- **The defaults were measured, not guessed.** `quietMs` 500 ms has ~2.3× headroom over the worst inter-chunk gap seen (216 ms, 18 runs of `ls -la /usr/bin | head -80`); 1 MiB is the boundary a single `seq 1 200000` crosses (1,489,391 B raw; this plugin's escape stripping leaves 1,289,146 B = 1.229 MiB, and the ring counts THAT), which is what makes `truncated` observable; `waitMs` 10 s was verified with a 40×200 ms ticker that returned partial output while the session stayed alive; and the 4 s startup budget covers the first prompt, measured at roughly 0.5–0.7 s on this host (a cold first ConPTY allocation is the slow end). Every one of them is live-editable on the row's Plugins page.

## Runtime configuration (the Plugins page)

Both tool rows carry their own configuration, and every knob is declared `.volatile()` — which is what makes it addressable by the runtime's settings service. The Web **Plugins** page therefore edits it: open **Plugins** in the sidebar, open the `dsh-win-multi-bash` bundle, and each row has a **Configure** page. The browser half (`lib/client.js`, declared as `dsh.client` + the `./client` export) registers that page into the page's `plugins.row.config` slot, keyed `dsh-win-multi-bash#<row id>`; a save goes to the profile's Cordis patch through `settings`/`ctx.configForms` — the same place a hand edit lands, with no HTTP route, no second settings file, and no YAML editing.

That is also why the bundle inserts its core row — `win-mb-plugin`, `name: 'dsh-win-multi-bash'` — and why it is the row it is: `dsh-client-modules` discovers a browser half by resolving a row's **bare package specifier** to its `package.json` and reading `dsh.client` there (`locatePkgJson` → `exactPackageSpecifier`, which answers `undefined` for a subpath). The tool rows are subpaths, so without this core row the client bundle is never served and the rows show no Configure control at all. Its module (`lib/index.js`) is the package main, and it owns the shared prompt section as well — one row for the plugin itself, one row per tool.

| Row | Options (in page order) |
|---|---|
| `git_bash` | Background jobs (`enableRunInBackground`); `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`; `bashPath`; sandbox stance (`auto` / `none`); `probeTimeoutMs`; `requireSandbox`; unwrapped-run notice (`sandboxNotice`: `once` by default, `always` to keep the short marker on every degraded run) |
| `wsl_bash` | The same tool-layer switch (`enableRunInBackground`) plus the same set under `wslBash`, `wslPath` and `wslDistro`, and the stance list adds `bwrap` |
| `msys2_bash` | The same tool-layer switch plus the same set under `msys2Bash`, `bashPath`, and the sandbox knobs (its stance list is MSYS's, so no `bwrap`) |
| `ssh_bash` | The same tool-layer switch plus the same set under `sshBash`: `sshPath`, `sshHost`, `sshUser`, `sshPort`, `acceptNewHostKeys`, `connectTimeoutMs`, and the sandbox knobs. `probeTimeoutMs` and `sandboxNotice` are structurally inert here — this dialect never probes and never degrades — and `requireSandbox` refuses every command rather than pretending |
| `terminal` | Interactive sessions: `defaultShell` (which dialect `open` uses by default); `maxSessions`; `idleMs`; `rows` / `cols`; `maxBufferBytes`; `waitMs` / `quietMs` / `maxWaitMs`; `allowUnconfined`; plus one executable pin per dialect (`gitBash.bashPath`, `wslBash.wslPath` / `wslDistro`, `msys2Bash.bashPath`, `sshBash.sshPath` / `sshHost` / `sshUser` / `sshPort` / `acceptNewHostKeys` / `connectTimeoutMs`) |

That list is exactly the volatile projection of each row's `Config` schema — the audit pins both sides (`volatilePaths` of the host configs against the browser half's field table), so a knob added to a backend without `.volatile()` cannot silently stay YAML-only, and the page cannot offer a field the Host would refuse.

- **Live reads.** Volatile fields are live references, and the executors read them through `.get()` at use time. A path, distro, stance, timeout, or hardening change applies to the next command without reloading the row.
- **Two knobs need the row's next load**, because they shape the tool's *schema* rather than one call: `enableRunInBackground` (the advertised `run_in_background` argument) and the escalation surface (`sandbox_permissions`, advertised at load from the probe verdict).
- **One behaviour switch is deliberately not on the page.** `promoteOnTimeout` (default on) keeps a foreground command that reaches its timeout running as a background job — visible and killable through the job tools — instead of killing it, matching dsh's own bash tool. It is non-volatile because it is a deployment stance rather than a live knob: set it in the row's YAML and it applies on the row's next load. With `enableRunInBackground: false`, or with no job registry composed, a timeout kills the command exactly as before.
- **A sandbox private temp directory that was removed out of band heals itself (`guardSandboxTemp`, default on).** Each confined run of a `git_bash` / `msys2_bash` row reads the `--temp` the seam is about to hand the windows-acl runner — the path the backend cached for this (session, workspace root) — and when that exact private root is missing it recreates it and re-applies the seam's own write grant (`tempWriteSid` + `AclWriteGrant`, the same calls `dsh-sandbox-local` makes). It is **idempotent, live, and deletes nothing**: the only accepted target is a missing, absolute `dsh-<6 alphanumerics>` *direct child* of an OS temp root, outside every workspace root; anything else — an ambient temp root, a nested path, a lock or spill directory, a wrongly spelled name, an existing directory — is refused and named. `AclWriteGrant` comes from `@deepseek-ai/dsh-sandbox-windows-acl`, taken through a lazy import (declared as an optional peer, no new runtime dependency); when it cannot be resolved the directory is still recreated (existence only) and the plugin warns that the grant was NOT restored. The switch is listed **once, at the top of the plugin** — on the `dsh-win-multi-bash` page, not on each row — and turning it off stops healing everywhere from the next command.
- **The self-heal switch is listed exactly once, on the plugin's own page** (`dsh-win-multi-bash`), never on a tool row: one deployment-wide value governs the guard, each row's inline pre-spawn check and every row alike. `enableRunInBackground` stays on the tool layer, so that one IS on each row. Two honest limits: `wsl_bash` uses bwrap and never materializes a `--temp` directory, so the knob is inert there; and healing only happens where a confined run happens at all — on a host where the windows-acl runner cannot start MSYS bash (measured here: `git_bash` returns `sandbox.unconfined: true` on every call) the git row never reaches the runner, so it can neither break nor heal through it.
- **An unwrapped run says so — once per row by default.** When a command is not wrapped by a sandbox, the result carries `sandbox.unconfined: true`. When the reason is a failed `sandbox: auto` probe — we degraded on your behalf — the row's **first** such run carries the full explanation: `[sandbox: not applied — the confinement probe found no usable sandbox, so this command ran unconfined under <mode> mode; repair the sandbox or set sandbox: none on this tool row to accept unconfined runs]`. What happens after that is the row's `sandboxNotice` knob: `once` (the default) stays silent — the structured fact still rides on every result, so nothing is hidden, and the same sentence stops pushing real output out of the context window; `always` keeps the short marker `[sandbox: not applied — ran unconfined under <mode> mode; reason and fix stated once per plugin load]` on every degraded run. Whichever form it takes, the announcement goes to the channel the model reads first: a foreground result, a promoted result, or a real background job's terminal detail. An explicit `sandbox: none` carries the fact without any note, and `danger-full-access` carries neither: its `mode` already says what it is.
- **Two dialects ship switched off.** `msys2_bash` (the MSYS2 installation's own `usr/bin/bash.exe`, a second toolchain next to Git Bash) is **opt-in**: enable the `win-mb-tool-msys2` row on the Plugins page to mount it, and pin `msys2Bash.bashPath` when MSYS2 is installed outside its usual location. It inherits the MSYS mechanism rather than copying it, and reports its own facts — `$MSYSTEM`, `pacman` — instead of Git Bash's.
- **`ssh_bash` also ships switched off, for a reason of its own: a deployment has to name the host.** Enable the `win-mb-tool-ssh` row and pin `sshBash.sshHost` (plus `sshUser` / `sshPort` when they are not the client's defaults); a row with no host refuses every call and names that field. The row's own knobs are the target, the client pin, the trust-on-first-use switch (`acceptNewHostKeys`, default **false**) and the connection-phase bound (`connectTimeoutMs`, default 15000 ms, sent as `ConnectTimeout` in whole seconds). `sshPath` is trusted when it exists and otherwise warns once and falls back to discovery, exactly like `bashPath`. Escalation is advertised only while `requireSandbox` is on: without it the row advertises no confinement it cannot provide, so there is no `sandbox_permissions` argument to misuse.
- **Text knobs are trimmed on save, and an unusable value is only reported — never rewritten.** A text field (a path, a distribution name) is saved trimmed and the trimmed value is shown back, so what you see is what is stored; blanking a field clears it. A value that fails the *syntax* check the page can make — a path that is not absolute, a distribution name containing spaces or quotes, a number that is not finite — shows a warning and is **still saved exactly as you typed it**: the plugin never rewrites or deletes your configuration. Whether a value actually works is decided **at runtime**: the executor warns once, falls back to its default (auto-discovery for a shell path; the first finished distribution for \`wslDistro\`), and leaves the stored value untouched until you save again.
- **The denial dialect is learned per host.** After a successful confinement probe, the row makes one deliberately-denied, harmless write outside the workspace root and keeps that refusal text as an extra signature (a union with the backend's own list), so a localized refusal the backend never enumerates is still classified. The probe target must not exist afterwards; if it somehow does, the row deletes it and discards the discovery. Failure to learn is silent and never blocks the row — and on a host whose runner cannot start the shell at all, no confinement (and no discovery) happens. Measured cost on this host: about +321 ms, once per row load, on the WSL/bwrap path.
- **On Windows the workspace-write boundary is object-shaped, and on some hosts it is not available at all.** Measured on a win32 host (2026-10-14): the ACL backend's grant follows the **object**, not the path — a file *created inside* the workspace keeps its grant even when reached through a hard link placed *outside* it (writing through the outside name lands on the inside file), while an object created *outside* never gains the grant (both directions measured against `icacls`), and reads stay unconfined. On that same host the runner could not start MSYS bash at all (`0xc0000142`, `NtCreateDirectoryObject(\BaseNamedObjects\…) : 0xC0000022`), so `sandbox: auto` degraded on **every** call and `git_bash` always ran unconfined — which the unconfined fact reports on every result (the structured field) and once per row in prose, including in a background job's terminal detail (the base job view has no sandbox field, so the note is the only channel there). Treat `sandbox: auto` as a guardrail rather than an absolute boundary, and `requireSandbox: true` as the fail-closed stance: on a host like that one it refuses every command instead of degrading — `git_bash` stops working there until the runner can start the shell.
- **Background advertising is config-driven here**, not registry-driven: `run_in_background` — and the family section's background sentence that follows it — appears whenever `enableRunInBackground` is on, and a call in a composition with no job registry fails loudly (`background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`). dsh's own tool instead re-registers itself and drops the parameter while no registry is composed. This factory does not re-register: a parameter that silently disappears depending on boot order is worse than one that refuses with a reason, so the choice is deterministic advertising plus a loud call-time failure.
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
├── bash-msys2/     Msys2BashExecutor (MSYS2's own bash)
├── bash-ssh/       SshBashExecutor (a remote shell over the OpenSSH client)
├── tool-bash/      tool factory + one instance per dialect
│                   (git-bash, wsl-bash, msys2-bash, ssh-bash) and
│                   backend ownership (types/backend.js)
├── terminal-session.js  the PTY session registry (bounded output, readiness, reclamation)
├── sandbox-temp-guard.js self-heal for the sandbox's private temp directory
└── vendor/         helper modules for runner-failure classification and bwrap profiles
```

Because no row of this plugin registers as `ctx.shell`, the patch inserts only its own rows and disables nothing: the base bundle's shell wiring (`pwsh-sandbox` on win32, `bash-sandbox` elsewhere) stays exactly as shipped, and pwsh keeps working whether or not this plugin is loaded.

## Prerequisites

- A dsh profile with the published `@deepseek-ai` base packages (every standard deployment).
- Git Bash and/or WSL on the machine (a missing backend only errors at first use; pwsh is unaffected).
- For `ssh_bash`: an SSH client on the machine (the Windows OpenSSH client, or a Git-for-Windows one on PATH) and a reachable host with a credential that needs no interactive prompt — a key, ideally through an agent — plus that host already present in `known_hosts`. All three are only needed if you enable that row.

## Install and remove

There is one install path: `dsh plugin`, a pnpm forwarder. It installs the package into the profile, and the bundle layer applies the package's own `cordis.patch.yml` (declared by `dsh.bundle.patch`), which inserts its rows. No script links anything by hand.

```powershell
# Install (pick one)
dsh plugin --profile web add dsh-win-multi-bash                    # npm published package (recommended)
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash   # GitHub repository source

# Remove
dsh plugin --profile web remove dsh-win-multi-bash
```

Requires `pnpm`; the bundle layer is assembled at boot, so **restart `dsh web`** for a change to take effect. Works on any profile, including freshly initialized ones.

The manual equivalent is the profile's `cordis.patch.yml`: the `insert:` rows this package's own `cordis.patch.yml` declares (that file is the composition wiring, documented inline) can be written into the profile patch by hand. Do not do both — a hand-written block next to a bundle install makes the loader reject the duplicate entry ids.

## Verification

```bash
pnpm test
```

Boots a real composition over the profile runtime (modifying nothing), verifies `git_bash` / `wsl_bash` register and execute real commands — including an explicit `bashPath` variant — and asserts `ctx.shell` is still provided by the base bundle's own row (the regression this plugin once caused). Requires node `^22.19.0 || >=24.0.0` — the `engines.node` range this package declares.

```bash
pnpm run test:audit
```

Runs the full audit suite instead: pure-unit coverage of the vendor helpers, executor internals and tool config schemas, plus boot-integration matrices for the real `cordis.patch.yml` and for misconfigurations.

The suite also covers the SSH dialect end to end without needing a network: its argv shape and option order, the target validation that makes an option-injection through `sshHost` impossible, client resolution and the stale-pin fallback, the `sandbox: { mode, remote: true }` fact (and the *absence* of `denied` / `enforcement` / `unconfined`), the rendered marker, `requireSandbox` failing closed, and the family section's remote gating. One boot case runs the real tool against `192.0.2.1` (TEST-NET-1, guaranteed unroutable), so the whole spawn → result → schema → render path is exercised with no server; the check that a command's failure is still reported as a *remote* fact rather than a sandbox verdict lives there.

A **live** round trip is available but opt-in, because it needs a reachable host and a credential:

```bash
DSH_AUDIT_SSH_HOST=ubuntu_tx node smoke/prepare.mjs audit
```

That runs `uname -sr; echo SSH-ROUNDTRIP-OK; exit 7` through `ssh_bash` and asserts the propagated exit status, the stdout, the remote sandbox fact, and that this host's managed `$DSH_*` variables do **not** cross the connection. It uses the host alias from your own `~/.ssh/config`, so it needs no new configuration; unset, every SSH case above still runs and the suite stays fully offline.

Both entries run `smoke/prepare.mjs`: it links the profile runtime into `smoke/node_modules` (refusing to touch anything that is not already the expected link), writes its fixtures under `.temp/smoke/`, and removes only the links it created. The `bashPath` it pins comes from the plugin's own resolver in `lib/`, never a hardcoded path.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| New sessions lack `git_bash` / `wsl_bash` | Check the rows are in the profile's `cordis.patch.yml` and that the profile resolves `dsh-win-multi-bash` (`dsh plugin --profile web list`); the bundle layer is assembled at boot, so restart the running `dsh web` |
| Boot fails with `duplicate loader entry id` | The rows are present twice — a hand-written block in the profile patch next to the bundle install; remove one of them |
| Boot fails with `Cannot find package '@deepseek-ai/...'` | The profile runtime lacks the base packages (every standard deployment has them); reinstall with `dsh plugin --profile web add dsh-win-multi-bash` |
| `git_bash` reports bash not found (or spawns the WSL `WindowsApps\bash.exe` alias with `spawn ... ENOENT`) | Git Bash is outside the probe paths, or a stale WSL app-execution alias shadows resolution: delete `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` (Settings → Apps → Advanced app settings → App execution aliases), or set `gitBash.bashPath` manually |
| `wsl_bash` errors | Check `wsl.exe --status` for a default distro; set `wslBash.wslDistro` to name one |
| `wsl_bash` fails with `bwrap was not found` | `sandbox: bwrap` is set but bubblewrap is missing inside the distro: install it per “Sandbox behavior → Enabling the bwrap sandbox for `wsl_bash`” (`sudo apt-get install -y bubblewrap`) and restart `dsh web`, or use `sandbox: auto` / `none` |
| `wsl_bash` sandbox reports a runner failure on bwrap | The bwrap workspace root is the Linux side of a Windows drive path (`/mnt/<drive>/...`): a UNC workspace root fails loud, and a distro with a custom automount root (wsl.conf `automount.root`) needs a matching configuration |
| Calling `wsl.exe` (or other native exes) with POSIX paths from `git_bash` reports `No such file or directory` | MSYS rewrote `/root` etc. to `<Git root>\root`: prefix with `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL="*"`, or use a `//` prefix; use the `wsl_bash` tool for WSL work |
| A wrapped command suddenly fails with `windows-acl-run: --temp is not an existing directory: …` (or `sandbox-unavailable`) and keeps failing on every call | The session's private sandbox temp root was removed out of band — an OS temp cleaner, a manual `rmdir`, a crashed sibling. With `guardSandboxTemp` on (the default) a `git_bash` / `msys2_bash` command recreates it and re-applies its write grant; retry once. If that row reports `sandbox.unconfined: true` it never reaches the ACL runner on this host and cannot heal: restart `dsh web` for a fresh private root. Recreating the directory by hand restores existence only (a confined child's own `%TEMP%` writes stay denied) |
| `wsl_bash` still runs without a sandbox after installing bubblewrap | The bwrap probe verdict is cached for the host process lifetime: restart `dsh web`, or reload the tool row by editing the profile patch |
| Boot warns `win-mb-tool-git … waiting for service: shell` (or dsh's own `tool-pwsh` / `permission-presets` do) | Nothing provides `ctx.shell`. This plugin no longer provides it either: check the base bundle's `pwsh-sandbox` row is not disabled by some other patch |
| `ssh_bash` reports `no ssh client was found` | Neither the Windows OpenSSH client (`Settings → Apps → Optional features → OpenSSH Client`) nor an `ssh.exe` on PATH exists: pin `sshBash.sshPath`, or put the Git-for-Windows client's `usr\bin` on PATH |
| `ssh_bash` fails with `Host key verification failed.` | The host is not in `known_hosts`. The one-shot form never asks: connect once in a real terminal (`ssh <host>`) to record the key, set `sshBash.acceptNewHostKeys: true` to trust an unknown key on first use (a *changed* key still fails), or answer the prompt in a `terminal` session opened with `shell: ssh_bash` |
| `ssh_bash` fails at once and never mentions a prompt | By design: the one-shot form sends `BatchMode=yes`, so a password or key-passphrase prompt fails immediately instead of hanging a call nobody can answer. Use a key (or an agent), or open a `terminal` session with `shell: ssh_bash` and answer the prompt there |
| `ssh_bash` refuses a command, naming `requireSandbox` | That row demands a file-sandbox fence, and nothing on this host can fence a remote effect. Turn `requireSandbox` off on that row, or pass `sandbox_permissions: "danger-full-access"` with a justification for that one call |
| `ssh_bash` returns `sandbox.remote: true` and no `denied` | That is the honest shape rather than a bug: the local file sandbox does not govern a command that runs on another host (see “Sandbox behavior ¶ `ssh_bash`”). A `denied` there would be a verdict nobody observed |
| Stopping an `ssh_bash` call left the remote command running | Expected and measured: with no remote tty, sshd only closes the channel and never signals the command. Make long remote work self-limiting on the remote side (`timeout`), or run it in a `terminal` session with `shell: ssh_bash`, whose PTY teardown does reap the remote process group |
| `terminal` says a session is "gone — closed by the idle reaper" | The session had no `send`/`read`/`signal` for `terminal.idleMs` (default 10 minutes) and was terminated. Open a new session, or raise `idleMs` on the terminal row. |
| `terminal` reports `waitReason: "quiet"` and the command plainly has not finished | That is what `quiet` means: the output went silent, which is NOT "the command finished" (a tty echoes input within milliseconds). `read` again, or raise `waitMs` / `quietMs` on the terminal row. |
| `terminal` reports `truncated: true` | The session produced more than `terminal.maxBufferBytes` (default 1 MiB) and its oldest output was dropped. Raise the cap, or read more often. |
| `terminal` refuses to open with an `allowUnconfined` message | That row is set to `terminal.allowUnconfined: false`; a PTY session cannot be file-sandboxed, so it refuses rather than run unprotected. Set it back to `true` to accept unconfined sessions. |

## Layout

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client manifest; exports . ./client ./tool-git-bash ./tool-wsl-bash ./tool-msys2-bash ./tool-ssh-bash
├── cordis.patch.yml        # the composition wiring (documented inline)
├── .gitattributes          # LF-only for every text file, binaries exempt
├── LICENSE / THIRD_PARTY_NOTICES
├── lib/                    # bundled implementation (plain ESM JS, no build step)
└── smoke/                  # smoke test (not published)
```
