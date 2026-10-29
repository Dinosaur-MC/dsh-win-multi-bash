# Architecture

This is the map of the plugin: what is a row, what is a dialect, how a tool call becomes a rendered result, and which surfaces are derived from which declaration. The rules that constrain these choices are in [Design principles](principles.md).

## Vocabulary

- **Dialect** — one shell family: `git_bash`, `wsl_bash`, `msys2_bash`, `ssh_bash`.
- **Executor** — the object that turns one call's `command` / `workdir` / limits into a process, and decorates the result with sandbox facts. It extends `ShellExecutorBase`, which extends dsh's `LocalBashExecutor`.
- **Tool row** — one `cordis.patch.yml` row that mounts one tool (a subpath export such as `./tool-git-bash`).
- **Core row** — `win-mb-plugin`, named by the bare package specifier. It serves the browser half, owns the shared prompt section, and carries the deployment-wide self-heal switch.
- **Terminal row** — `win-mb-tool-terminal`; owns the PTY session tool and the session-backend definitions.

## Composition

The shipped `cordis.patch.yml` inserts:

| Row | Name | Default | Owns |
| --- | --- | --- | --- |
| `win-mb-plugin` | `dsh-win-multi-bash` (bare) | on | `./client` + `./factory`, the `tool:win-mb-bash` prompt section, `guardSandboxTemp` / `tempWatchMs` |
| `win-mb-tool-git` | `.../tool-git-bash` | on | `GitBashExecutor`, its config partition `gitBash` |
| `win-mb-tool-wsl` | `.../tool-wsl-bash` | **off** | `WslBashExecutor`, `wslBash` |
| `win-mb-tool-msys2` | `.../tool-msys2-bash` | **off** | `Msys2BashExecutor`, `msys2Bash` |
| `win-mb-tool-ssh` | `.../tool-ssh-bash` | **off** | `SshBashExecutor`, `sshBash` |
| `win-mb-tool-terminal` | `.../tool-terminal` | on | `terminal`, `terminal` config partition |

All rows are win32-only. A row inserts only its own tool; nothing of the base bundle's shell wiring is disabled. That is deliberate: the plugin never provides `ctx.shell`, so dsh's own `pwsh-sandbox` row keeps the seat and every plugin that injects `shell` is unaffected.

## The dialect registry

`lib/shell-dialects.js` declares every dialect once: id, tool name, row id, config key, executor class, argv style, executable resolver, sandbox stances, family facts, `effects: 'local' | 'remote'`, terminal capability, default-enabled state. `lib/tool-bash/types/registry.js` derives the tool modules and the client-facing list from it.

The derived surfaces are:

- the tool module and its `defineShellTool` call;
- the prompt section's membership and ordering;
- the patch row's id, subpath and `disabled` default;
- the `README`-visible fact that the row exists;
- `package.json`'s `exports` and `files`;
- the browser half's generated row list and terminal literals (`smoke/gen-client-registry.mjs` renders the block; the audit byte-compares it);
- the terminal row's `defaultShell` options, which in turn drive the conversation rows' wire-name list.

Adding a dialect is therefore **one executor file + one declaration**, not a checklist of six files. A declaration that does not hold together refuses to load: unique id / tool name / row id / config key, a `configKey` matching the browser partition, no tool name collision with the family section, a stance list containing `auto`, and non-empty family facts all throw at load time.

## Executors

`lib/shell-executor.js` holds `ShellExecutorBase`:

- probes are asynchronous (`runProbe`: spawn + a killing timer), never `spawnSync`; a hanging `wsl.exe` cannot freeze the host event loop;
- the denial dialect is learned once per row lifecycle, on the first **confined** command (not during apply), so a row that never runs confined pays nothing;
- every boot-path `confine()` call carries a deadline (`probeDeadline()`, 8 s fallback); on the current provider a confine has no await point, so the real bound remains the following spawn timeout;
- `started.sandbox` is stamped in `onStarted`, so a promoted call reads the same facts before settlement;
- the private-temp guard reads its switch live from the package row and re-applies the seam's write grant.

The four executors own their argv:

- `lib/bash-git/index.js` — MSYS `bash.exe`; paths are passed by Node, so MSYS rewriting does not apply to the plugin's own paths.
- `lib/bash-wsl/index.js` — `wsl.exe` driving Linux; the command travels as a base64 payload so quoting and Linux paths arrive verbatim.
- `lib/bash-msys2/index.js` — MSYS2's own UCRT64 bash; discovery under the installation roots or a pinned `bashPath`.
- `lib/bash-ssh/index.js` — one `ssh.exe` command per call, `-T`, `BatchMode=yes`; the target and host-key policy are deployment configuration, never call arguments.

## The tool factory

`lib/tool-bash/types/factory.js` builds one tool instance per dialect. It owns:

- the tool-layer `Config` (`enableRunInBackground`, `promoteOnTimeout`) and the backend partition the executor is built from;
- the escalation surface (`sandbox_permissions`) advertised only where confinement exists;
- background jobs: `run_in_background` starts a real job and returns `{ kind: 'background', jobId, cwd }`; a timed-out foreground command is promoted instead of killed (matching dsh's own bash);
- result rendering: exit/signal markers, sandbox markers, spill previews, promoted reads, the `(no output)` body;
- the fallback description when the core row is absent (the shared guidance moves into each tool description).

## The prompt section

One `tool:win-mb-bash` section is registered by the core row at the midpoint of dsh's `TOOL_BASH` and `TOOL_PWSH` orders. Its text is resolved **per assembly** from the tools actually mounted:

- no family tool — the section renders nothing;
- local dialects only — the local file-sandbox sentence is present;
- a remote dialect — a remote-scope sentence is added and the local promise is scoped to local tools;
- the background sentence and the escalation contract appear only while a mounted tool advertises `run_in_background` / `sandbox_permissions`.

Each tool description keeps only its own dialect facts. When the core row is switched off the section disappears and each loaded tool description carries the shared guidance itself (a fallback, with a logged warning).

## The client half

`lib/client.js` is a single CommonJS factory registered under the package name. It:

- registers the `settings.win-mb-bash` dictionary;
- injects the stylesheet once per document;
- registers one `plugins.row.config` page per row (key `dsh-win-multi-bash#<row id>`) while the Host serves that row's namespace;
- registers the conversation rows through the keyed `tool.call.toolview` slot (see [Conversation rows](conversation-rows.md));
- registers the Session header's terminal list (`conversation.session.header.actions`): `sessions.list` / `sessions.tail` over the `/win-mb` RPC, and `sessions.stop` for a human Stop;
- registers the core-row note via `plugins.detail.section`.

The browser half cannot import the package (the client module loader resolves subpaths to `undefined`), so the dialect list and terminal literals are generated into a marked region by `smoke/gen-client-registry.mjs`; the audit byte-compares that region with the registry. The bare-package core row is what makes the browser half discoverable at all: `dsh-client-modules` reads `dsh.client` from the row's resolved `package.json`, and a subpath row does not resolve that way.

## Call flow

```text
model tool call
  → tool instance (factory) resolves the policy and the workdir
  → executor builds argv and asks the sandbox seam (confine / none / remote)
  → subprocess spawns the shell; stdout/stderr are bounded and spilled
  → renderer writes markers ([exit code: N], sandbox facts, promotion, spill)
  → tool result (content + structured sandbox fact)
  → client slot tool.call.toolview renders the shell card
```

## Path conversion and workdir

Git Bash rewrites leading-slash POSIX paths into Windows paths whenever a native Windows program is called. That is MSYS behavior, not a plugin defect: `wsl.exe -e ls /root` inside `git_bash` becomes `...\Git\root`. Prefix the call with `MSYS_NO_PATHCONV=1` (or `MSYS2_ARG_CONV_EXCL="*"`) to pass arguments verbatim; for WSL work, prefer `wsl_bash`, which ships the command as a base64 payload.

`workdir` accepts native, MSYS (`/c/...`) and WSL automount (`/mnt/c/...`) forms. The resolver translates a single-letter drive form and the automount form to native before `spawn`; MSYS POSIX roots (`/etc`, `/usr`, `/tmp`) and distro-side paths such as `/mnt/data` are left alone, and a relative `workdir` resolves against the session workspace. The conversation card's prompt cwd applies the same resolution plus `.`/`..` normalization, so a `workdir: "lib/.."` displays the actual directory, not `..`.

## Package layout

```text
lib/
├── bash-git/       GitBashExecutor (MSYS)
├── bash-wsl/       WslBashExecutor (WSL, base64 payloads)
├── bash-msys2/     Msys2BashExecutor (MSYS2 UCRT64)
├── bash-ssh/       SshBashExecutor (remote shell over OpenSSH)
├── tool-bash/      factory + one instance per dialect; registry, shell-family,
│                   render, terminal, backend ownership
├── terminal-session.js   PTY registry: bounded output, readiness, reclamation
├── sandbox-temp-guard.js private-temp self-heal
└── vendor/         runner-failure classification, bwrap profiles
```

No build step: `lib/` is plain ESM JS. `smoke/` and `docs/` are repository-only; `package.json`'s `files` whitelist is the publish boundary. The manifest also declares `engines.dsh` (`>=0.1.7-rc.2 <0.3.0-0`): the runtime refuses the plugin outside that window instead of falling back to the peer list.
