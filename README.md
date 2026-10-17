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

A Windows multi-bash plugin for DeepSeek Harness. **`git_bash`** (Git for Windows / MSYS) is on by default. **`wsl_bash`** (WSL), **`msys2_bash`** (MSYS2 UCRT64) and **`ssh_bash`** (a remote shell over the OpenSSH client) are opt-in. **`terminal`** keeps a real PTY session alive between calls.

Every dialect owns its own executor, and **no tool registers as `ctx.shell`** — that seat stays with the base bundle's pwsh, so pwsh behaves exactly as it does without this plugin.

## Tools

| Tool | Backend | Notes |
| --- | --- | --- |
| `git_bash` | Git for Windows (MSYS) | **On by default**; owns a `GitBashExecutor` |
| `wsl_bash` | WSL Linux | **Opt-in**; owns a `WslBashExecutor`; its first load probes the distro |
| `msys2_bash` | MSYS2 UCRT64 | **Opt-in**; owns a `Msys2BashExecutor`; MSYS2's own `$MSYSTEM` and `pacman` |
| `ssh_bash` | Remote (SSH) | **Opt-in**; owns a `SshBashExecutor`; one command per call; the target is deployment configuration |
| `terminal` | any of the above | Persistent PTY sessions: `open` / `send` / `read` / `signal` / `close` / `list` |
| `pwsh` | dsh's own | Untouched; served by the base bundle's `pwsh-sandbox` row |

Only `git_bash` and `terminal` are enabled by default. The other three rows are switched off because each mounts a toolchain (or a host) a machine may not have; enable them on the **Plugins** page. On many Git for Windows hosts the windows-acl runner cannot launch MSYS bash, so `git_bash` runs unconfined and says so — for confinement use `wsl_bash` (bwrap) or dsh's pwsh. See [Sandbox behavior](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md).

## Install

There is one install path: `dsh plugin`, a pnpm forwarder. The bundle layer applies this package's own `cordis.patch.yml`, which inserts its rows.

```powershell
dsh plugin --profile web add dsh-win-multi-bash                    # npm package (recommended)
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash # GitHub source
dsh plugin --profile web remove dsh-win-multi-bash                 # remove
```

Requires `pnpm`. The bundle layer is assembled at boot, so **restart `dsh web`** for a change to take effect. Do not also hand-write the same rows into the profile's `cordis.patch.yml`: the loader rejects duplicate entry ids. Details and the manual equivalent are in [Configuration](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md).

## Quick start

- **`git_bash`** is ready after install. It runs a fresh MSYS bash per call; `workdir` accepts native, MSYS (`/c/...`) and WSL automount (`/mnt/c/...`) forms.
- **`wsl_bash` / `msys2_bash`**: enable `win-mb-tool-wsl` / `win-mb-tool-msys2` on the Plugins page. Pin `wslBash.wslDistro` or `msys2Bash.bashPath` only when discovery is not enough.
- **`ssh_bash`**: enable `win-mb-tool-ssh` and pin `sshBash.sshHost` (a host or a `~/.ssh/config` alias), plus `sshUser` / `sshPort` when needed. The target is never a tool argument; a row with no host refuses every call. A one-shot call uses `BatchMode=yes`, so authenticate with a key; a `terminal` session with `shell: "ssh_bash"` is the form that can answer a first-connect prompt.
- **`terminal`**: `open` a session, `send` commands with `submit: true`, `read` the reply, then `close`. The working directory, exported variables and aliases survive between calls. Sessions are process-local, capped, idle-reclaimed and **not** jobs.
- Every row has a **Configure** page on the Plugins page: paths, timeouts, sandbox stance, session limits and the deployment-wide self-heal switch. Changes are live unless a knob shapes the tool schema.

## Design at a glance

- **Honest facts, not guesses.** A successful confined run says `denied: false`; a failed one matching the backend's denial dialect says `denied: true`; a failed one matching nothing says no `denied` at all. An unwrapped run says `unconfined: true`. A remote SSH run reports `sandbox: { mode, remote: true }` and never borrows a local verdict.
- **Platform-native calls.** Our tool calls render as the platform's own shell card, with the full terminal label set, the seat's `useDisclosure`, a header-only background card, and the platform's exit capsule. See [Conversation rows](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md).
- **One declaration per dialect.** A dialect is one executor file plus one registry declaration; the tool modules, prompt membership, patch rows, config partition, package exports and client rows are derived from it. A declaration that does not hold together throws at load. See [Architecture](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md) and [Principles](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/principles.md).
- **One shared prompt section.** The core row owns a single `tool:win-mb-bash` section whose text follows the mounted tools; each tool description keeps only its own dialect facts.
- **Live configuration, user input wins.** Knobs are `.volatile()` where they can be live; the page never rewrites or deletes a value, and a save is revision-fenced. See [Configuration](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md).

## Documentation

| Document | What it covers |
| --- | --- |
| [Architecture](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md) | Rows, executors, the dialect registry, the prompt section, the client half and the call flow |
| [Design principles](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/principles.md) | The rules the implementation is held to: honest facts, derived surfaces, parity, live vs schema knobs |
| [Sandbox behavior](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md) | Per-backend capabilities, Windows caveats, bwrap, self-heal, SSH's remote scope |
| [Terminal sessions](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/terminal.md) | PTY lifecycle, signals, limits, SSH sessions, measured defaults |
| [Conversation rows](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md) | How a call becomes the platform shell card |
| [Configuration](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md) | The Plugins page, every row's knobs, live semantics, staged saves |
| [Verification](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/verification.md) | Dev runtime, both test entries, the live SSH round trip |
| [Troubleshooting](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/troubleshooting.md) | Symptom → fix |

## Verification

```bash
npm ci                  # once: the pinned 0.2.1-rc.2 dev runtime
pnpm test               # boot a composition; run real commands; a verdict
pnpm run test:audit     # the full audit suite
DSH_AUDIT_SSH_HOST=ubuntu_tx node smoke/prepare.mjs audit   # optional live SSH
```

Both entries are development tools: the published tarball ships no `smoke/`. `pnpm test` fails on a missing tool, a wrong description, a lost `ctx.shell` seat or a failed command; the audit announces and counts its skips. Details in [Verification](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/verification.md).

## Requirements

- Windows and a dsh deployment with the published `@deepseek-ai` base packages.
- Git Bash and/or WSL and/or MSYS2 only for the backends you enable; a missing backend never affects pwsh.
- For `ssh_bash`: an OpenSSH client, a reachable host and a credential that needs no interactive prompt.
- Node `^22.19.0 || >=24.0.0` (the range this package declares), and `pnpm` for installation.

## Layout

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client; exports for every tool subpath
├── cordis.patch.yml        # the composition wiring (documented inline)
├── lib/                    # plain ESM implementation (no build step)
├── smoke/                  # development verification (not published)
├── docs/                   # architecture, principles, sandbox, terminal, rows, config, verification, troubleshooting
└── LICENSE / THIRD_PARTY_NOTICES
```

`docs/` and `smoke/` are repository-only; `npm pack` ships only the files listed in `package.json`.

## License

MIT. See [LICENSE](LICENSE); upstream notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
