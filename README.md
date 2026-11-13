English | [中文](README.zh.md)

# dsh-win-multi-bash

[![npm version](https://img.shields.io/npm/v/dsh-win-multi-bash.svg)](https://www.npmjs.com/package/dsh-win-multi-bash)
[![license](https://img.shields.io/npm/l/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/package.json)
[![GitHub stars](https://img.shields.io/github/stars/Dinosaur-MC/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/stargazers)
![dsh ≥ 0.1.7-rc.2 < 0.3](https://img.shields.io/badge/dsh-%E2%89%A5%200.1.7--rc.2%20%3C%200.3-blue.svg)
![platform: windows](https://img.shields.io/badge/platform-windows-0078d4.svg)
![dialects: MSYS, WSL, MSYS2, SSH](https://img.shields.io/badge/dialects-MSYS%20%7C%20WSL%20%7C%20MSYS2%20%7C%20SSH-4c1.svg)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/dinosaur-mc/dsh-win-multi-bash)

A Windows multi-bash plugin for DeepSeek Harness. **`git_bash`** (Git for Windows / MSYS) is on by default. **`wsl_bash`** (WSL), **`msys2_bash`** (MSYS2 UCRT64), **`ssh_shell`** (pooled SSH channels, key-only, many hosts) and **`ssh_scp`** (SFTP transfer on the same row) are opt-in. **`terminal`** keeps a real PTY session between calls.

Every dialect owns its own executor, and **no tool registers `ctx.shell`**: that seat stays with the base bundle pwsh, so pwsh behaves exactly as it does without this plugin.

## Tools

| Tool | Backend | Notes |
| --- | --- | --- |
| `git_bash` | Git for Windows (MSYS) | **On by default**; owns a `GitBashExecutor` |
| `wsl_bash` | WSL Linux | **Opt-in**; owns a `WslBashExecutor`; its first load probes the distro |
| `msys2_bash` | MSYS2 UCRT64 | **Opt-in**; owns a `Msys2BashExecutor`; MSYS2's own `$MSYSTEM` and `pacman` |
| `ssh_shell` | Remote (SSH) | **Opt-in**; owns a `SshShellExecutor`; one pooled connection per host, one channel per call |
| `ssh_scp` | Remote (SSH) | **Opt-in with `ssh_shell`**; SFTP transfer on the same pool; foreground only |
| `ssh_hosts` | Remote (SSH) | **Opt-in with `ssh_shell`**; read-only host inventory, no connection |
| `terminal` | `git_bash` / `wsl_bash` / `msys2_bash` | Local PTY sessions: `open` / `send` / `read` / `signal` / `close` / `list` |
| `pwsh` | dsh's own | Untouched; served by the base bundle's `pwsh-sandbox` row |

Only `git_bash` and `terminal` ship on. `git_bash` often runs unconfined — see [Sandbox behavior](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md).

## Requirements

- dsh `0.1.7-rc.2` through `0.2.x` (the `engines.dsh` window).
- Windows, and a dsh deployment that provides the published `@deepseek-ai` base packages.
- Git Bash and/or WSL and/or MSYS2 only for the backends you enable; a missing backend never affects pwsh.
- For `ssh_shell` / `ssh_scp`: the `ssh2` transport (an optional peer — see [The SSH transport](#the-ssh-transport-ssh2)) and a host registry under `sshShell.hosts`.
- Node `^22.19.0 || >=24.0.0` (the range this package declares), and `pnpm` for installation.

## Install

Install through `dsh plugin` (pnpm): it applies this package bundle `cordis.patch.yml`, which inserts the rows.

```powershell
dsh plugin --profile web add dsh-win-multi-bash                    # npm package (recommended)
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash # GitHub source
dsh plugin --profile web remove dsh-win-multi-bash                 # remove
```

The bundle layer is assembled at boot, so **restart `dsh web`** for a change to take effect. Do not also hand-write the same rows into the profile patch: the loader rejects duplicate entry ids.

### The SSH transport (`ssh2`)

`ssh2` is an **optional peer dependency**: installing this plugin neither installs nor builds it, and every row still loads; the transport is resolved on first use, and without it the SSH calls fail closed with `ssh2 is not installed for this deployment`. Add it to the same profile:

```powershell
dsh plugin --profile web add ssh2
```

A hard dependency would instead make pnpm refuse the whole install with `ERR_PNPM_IGNORED_BUILDS` naming `ssh2` and `cpu-features`. Approve the pending `allowBuilds` entries when pnpm asks: the blocked script only builds the optional accelerator. See [Configuration](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md).

## Quick start

- **`git_bash`** is ready after install: a fresh MSYS bash per call; `workdir` accepts native, MSYS (`/c/...`) and WSL automount (`/mnt/c/...`) forms.
- **`wsl_bash` / `msys2_bash`**: enable `win-mb-tool-wsl` / `win-mb-tool-msys2` on the Plugins page. Pin `wslBash.wslDistro` or `msys2Bash.bashPath` only when discovery is not enough.
- **`ssh_shell`**: enable `win-mb-tool-ssh` and add hosts under `sshShell.hosts` (`alias`, `host`, `user`, `keyPath`; optional `port`, `startupCommand`, `default`). A call names an alias, or omits it for the one `default`. Key-only auth, strict host keys; hosts default to `approval: session` (`trusted` never asks) and live in the row host table — see [Configuration](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md).
- **`ssh_scp`**: transfers on the same row — `action`, `localPath` (inside the workspace unless `danger-full-access`), `remotePath` (POSIX, Windows drive or UNC), `recursive`, `timeoutMs` (default 5 min). Foreground only; results are values with `sandbox` facts, and failures name the phase and alias.
- **`ssh_hosts`**: read-only inventory — `query`, `approval`, `defaultOnly`; sanitized facts, never credentials; no connection, no approval.
- **`terminal`**: `open`, `send` with `submit: true`, `read`, then `close`. The working directory, exported variables and aliases survive between calls. Sessions are process-local, capped, idle-reclaimed and **not** jobs.
- Every row has a **Configure** page; changes are live unless a knob shapes the tool schema.

## Design at a glance

- **Honest facts, not guesses.** A confined run that passed says `denied: false`; a denial-dialect failure says `denied: true`; one matching nothing carries no `denied`; an unwrapped run says `unconfined: true`; a remote SSH run reports `sandbox: { mode, remote: true }`.
- **Platform-native calls.** Our shell tools use the platform shell card; `ssh_scp` uses the generic row. See [Conversation rows](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md).
- **One connection per host, one channel per call.** `ssh_shell` reuses a pooled ssh2 client and gives every call its own exec channel — isolated, parallel-safe, cancellable; `ssh_scp` transfers share that pool.
- **One declaration per dialect.** One executor file plus one registry declaration derives the tool modules, prompt rows, config partition, exports and client rows; an inconsistent declaration throws at load. See [Architecture](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md).
- **One shared prompt section, live knobs.** The core row owns one `tool:win-mb-bash` section whose text follows the mounted tools; knobs are `.volatile()` where they can be live, and a save is revision-fenced.

## Documentation

| Document | What it covers |
| --- | --- |
| [Architecture](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md) | Rows, executors, the registry, the SSH pool and transfers, the client half |
| [Design principles](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/principles.md) | The rules the implementation is held to: honest facts, derived surfaces, parity, live vs schema knobs |
| [Sandbox behavior](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md) | Per-backend capabilities, Windows caveats, bwrap, self-heal, SSH's remote scope |
| [Terminal sessions](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/terminal.md) | PTY lifecycle, signals, limits, measured defaults |
| [Conversation rows](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md) | How a call becomes the platform shell card |
| [Configuration](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md) | The Plugins page, the SSH hosts and transfers, live semantics, staged saves |
| [Verification](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/verification.md) | Dev runtime, both test entries, the live SSH round trip |
| [Troubleshooting](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/troubleshooting.md) | Symptom → fix |

The detailed documents are in English; this README is the bilingual entry point.

## Verification

```bash
npm ci                  # once: the pinned 0.2.1-rc.2 dev runtime
pnpm test               # boot a composition; run real commands; a verdict
pnpm run test:audit     # the full audit suite
DSH_AUDIT_SSH_HOST=me node smoke/prepare.mjs audit   # optional live SSH
```

Both entries are development tools: the published tarball ships no `smoke/`. `pnpm test` fails on a missing tool, a wrong description, a lost `ctx.shell` seat or a failed command; the audit counts its skips.

## Layout

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client + engines.dsh; per-tool exports
├── cordis.patch.yml        # the composition wiring (documented inline)
├── lib/                    # plain ESM implementation (no build step)
├── smoke/                  # development verification (not published)
├── docs/                   # the documents listed above
└── LICENSE / THIRD_PARTY_NOTICES
```

`docs/` and `smoke/` are repository-only; `npm pack` ships only the `files` list.

## License

MIT. See [LICENSE](LICENSE); upstream notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
