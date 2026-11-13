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

Every dialect owns its own executor, and **no tool registers as `ctx.shell`** — that seat stays with the base bundle's pwsh, so pwsh behaves exactly as it does without this plugin.

## Tools

| Tool | Backend | Notes |
| --- | --- | --- |
| `git_bash` | Git for Windows (MSYS) | **On by default**; owns a `GitBashExecutor` |
| `wsl_bash` | WSL Linux | **Opt-in**; owns a `WslBashExecutor`; its first load probes the distro |
| `msys2_bash` | MSYS2 UCRT64 | **Opt-in**; owns a `Msys2BashExecutor`; MSYS2's own `$MSYSTEM` and `pacman` |
| `ssh_shell` | Remote (SSH) | **Opt-in**; owns a `SshShellExecutor`; one pooled connection per host, one channel per call |
| `ssh_scp` | Remote (SSH) | **Opt-in with `ssh_shell`**; SFTP file/tree transfer on the same executor and pooled connection; foreground only |
| `ssh_hosts` | Remote (SSH) | **Opt-in with `ssh_shell`**; read-only sanitized host inventory; no connection or approval |
| `terminal` | `git_bash` / `wsl_bash` / `msys2_bash` | Local PTY sessions: `open` / `send` / `read` / `signal` / `close` / `list` |
| `pwsh` | dsh's own | Untouched; served by the base bundle's `pwsh-sandbox` row |

Only `git_bash` and `terminal` ship on; the rest are opt-in. `git_bash` often runs unconfined — see [Sandbox behavior](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md).

## Requirements

- dsh `0.1.7-rc.2` through `0.2.x` (the `engines.dsh` window).
- Windows, and a dsh deployment that provides the published `@deepseek-ai` base packages.
- Git Bash and/or WSL and/or MSYS2 only for the backends you enable; a missing backend never affects pwsh.
- For `ssh_shell` / `ssh_scp`: the `ssh2` package in the profile (an optional peer — see [The SSH transport](#the-ssh-transport-ssh2)), key-only access under `sshShell.hosts`, host keys in `known_hosts`.
- Node `^22.19.0 || >=24.0.0` (the range this package declares), and `pnpm` for installation.

## Install

Install through `dsh plugin` (pnpm): it applies this package's `cordis.patch.yml` bundle layer, which inserts the rows.

```powershell
dsh plugin --profile web add dsh-win-multi-bash                    # npm package (recommended)
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash # GitHub source
dsh plugin --profile web remove dsh-win-multi-bash                 # remove
```

Requires `pnpm`. The bundle layer is assembled at boot, so **restart `dsh web`** for a change to take effect. Do not also hand-write the same rows into the profile's `cordis.patch.yml`: the loader rejects duplicate entry ids.

### The SSH transport (`ssh2`)

`ssh2` is an **optional peer dependency**, not a dependency: `dsh plugin --profile web add dsh-win-multi-bash` installs this package alone, and every row still loads — the transport is resolved on first use (`lib/ssh-shell/ssh2.js`) and a missing one becomes the named failure `ssh2 is not installed for this deployment; install the package dependency`. That keeps the install free of native build scripts: a hard dependency on `ssh2` makes pnpm refuse the whole command with `ERR_PNPM_IGNORED_BUILDS` naming `ssh2` and `cpu-features`, because ssh2 ships an `install` script that pnpm 10+ will not run unattended.

To use `ssh_shell` / `ssh_scp`, add the transport to the same profile:

```powershell
dsh plugin --profile web add ssh2      # the same CLI that installed this plugin
```

`dsh plugin add` accepts a package that is not itself a plugin and reports `ssh2 declares no dsh.bundle — installed as a plain dependency, not a profile layer` — which is exactly what this is. Running `pnpm add ssh2` inside `$DSH_HOME\profiles\web` is the equivalent.

If pnpm stops with `ERR_PNPM_IGNORED_BUILDS`, dsh has already recorded the pending entries under `allowBuilds` in that profile's `pnpm-workspace.yaml` (`ssh2: set this to true or false`); approve them on the Plugins page, or set both to `true`, then re-run. The transport works either way: `ssh2` is pure JavaScript and the blocked script only builds the optional `cpu-features` accelerator. A profile that never enables the SSH row needs none of this.

## Quick start

- **`git_bash`** is ready after install: a fresh MSYS bash per call; `workdir` accepts native, MSYS (`/c/...`) and WSL automount (`/mnt/c/...`) forms.
- **`wsl_bash` / `msys2_bash`**: enable `win-mb-tool-wsl` / `win-mb-tool-msys2` on the Plugins page. Pin `wslBash.wslDistro` or `msys2Bash.bashPath` only when discovery is not enough.
- **`ssh_shell`**: enable `win-mb-tool-ssh` and add hosts under `sshShell.hosts` (`alias`, `host`, `user`, `keyPath`; optional `port`, `startupCommand`, `default`). A call names an alias, or omits it for the one `default`. Key-only auth, strict host keys; hosts default to `approval: session` (one prompt per session, `trusted` never asks) and are edited in the row's host table — see the [migration notes](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md).
- **`ssh_scp`**: transfers on the same row — `action` (`upload`/`download`), `localPath` (inside the workspace unless `danger-full-access`; lexical check), `remotePath` (POSIX `/...`, Windows drive `C:\...`/`C:/...` normalized to `/C:/...`, or UNC), `recursive`, `timeoutMs` (default 5 min). Foreground only; results are values with `sandbox` facts, and failures name the phase and alias.
- **`ssh_hosts`**: read-only inventory — `query`, `approval` (`session`/`trusted`), `defaultOnly`; sanitized facts with `hasStartupCommand`/`hasShellTemplate`, never credentials. No connection or approval; an empty registry is a successful empty list.
- **`terminal`**: `open` a session, `send` commands with `submit: true`, `read` the reply, then `close`. The working directory, exported variables and aliases survive between calls. Sessions are process-local, capped, idle-reclaimed and **not** jobs; the Session header lists and stops them.
- Every row has a **Configure** page; changes are live unless a knob shapes the tool schema.

## Design at a glance

- **Honest facts, not guesses.** A successful confined run says `denied: false`; a failed one matching the backend's denial dialect says `denied: true`; a failed one matching nothing says no `denied` at all. An unwrapped run says `unconfined: true`. A remote SSH run reports `sandbox: { mode, remote: true }`.
- **Platform-native calls.** Our shell tools use the platform's shell card; `ssh_scp` uses the generic row. See [Conversation rows](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md).
- **One connection per host, one channel per call.** `ssh_shell` reuses a pooled ssh2 client and gives every call its own exec channel — isolated, parallel-safe, cancellable. `ssh_scp` transfers share that pooled client, one SFTP session per transfer.
- **One declaration per dialect.** One executor file plus one registry declaration derives the tool modules, prompt membership, patch rows, config partition, package exports and client rows; a declaration that does not hold together throws at load. See [Architecture](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md).
- **One shared prompt section.** The core row owns one `tool:win-mb-bash` section whose text follows the mounted tools; each tool description keeps only its dialect facts.
- **Live configuration, user input wins.** Knobs are `.volatile()` where they can be live; the page never rewrites a value, and a save is revision-fenced.

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

The detailed documents are maintained in English; this README is the bilingual entry point and release summary.

## Verification

```bash
npm ci                  # once: the pinned 0.2.1-rc.2 dev runtime
pnpm test               # boot a composition; run real commands; a verdict
pnpm run test:audit     # the full audit suite
DSH_AUDIT_SSH_HOST=me node smoke/prepare.mjs audit   # optional live SSH
```

Both entries are development tools: the published tarball ships no `smoke/`. `pnpm test` fails on a missing tool, a wrong description, a lost `ctx.shell` seat or a failed command; the audit announces and counts its skips.

## Layout

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client + engines.dsh; exports for every tool subpath
├── cordis.patch.yml        # the composition wiring (documented inline)
├── lib/                    # plain ESM implementation (no build step)
├── smoke/                  # development verification (not published)
├── docs/                   # architecture, principles, sandbox, terminal, rows, config, verification, troubleshooting
└── LICENSE / THIRD_PARTY_NOTICES
```

`docs/` and `smoke/` are repository-only; `npm pack` ships only the files listed in `package.json`.

## License

MIT. See [LICENSE](LICENSE); upstream notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
