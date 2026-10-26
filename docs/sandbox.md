# Sandbox behavior

The DSH file sandbox constrains **file effects** of a command this host runs (`workspace-write` / `read-only`); it does not limit network or other resources. The three local backends do not share the same capability:

| Backend | Mechanism | Enforcement | On probe failure |
| --- | --- | --- | --- |
| `pwsh` | windows-acl restricted-token runner | partial | no probe — always confined (dsh's own executor) |
| `wsl_bash` | `bwrap` inside the distro | full | runs unconfined, no sandbox facts |
| `git_bash` | windows-acl runner wrapping MSYS bash | partial (when the probe passes) | runs unconfined, no sandbox facts |
| `ssh_bash` | none applies — the command runs on another host | n/a | no probe, no wrapper: no local verdict |

## Facts, not guesses

The result's `sandbox` field follows the observation:

- **successful confined** run — `denied: false`;
- **failed confined** run whose stderr matches the backend's denial dialect — `denied: true`;
- **failed confined** run matching nothing — **no `denied` at all**, plus `[sandbox: the command failed without matching this backend's denial dialect; see stderr]`. A denial is only classified when the command exits non-zero; a blocked write followed by a successful command has an overall exit 0 and emits no denial marker.
- **unwrapped** run — `{ mode, unconfined: true }`;
- **remote** run — `{ mode, remote: true }`, with `denied`, `enforcement`, `runnerFailed` and `unconfined` all absent.

The rendered markers carry the same facts. `sandboxNotice` controls how often the prose explanation appears:

- `once` (default) — the row's **first** automatically-degraded run carries the full explanation; later runs stay silent. The structured `sandbox.unconfined: true` still rides on every foreground result.
- `always` — every degraded run keeps the short marker.

An explicit `sandbox: none` carries the fact without a note; `danger-full-access` carries neither (its `mode` already says what it is). A promoted result states the fact inside its returned text; a background acknowledgement carries no `sandbox` field (the base bundle's own shape for the same branch).

## Git Bash on Windows

On many Git for Windows deployments the windows-acl runner **cannot launch the MSYS `bash.exe` under a restricted token** (`CreateProcessAsUserW` returns Win32 error 2; `cmd.exe` and `pwsh.exe` launch fine). With `sandbox: auto`, a failed probe degrades to an unconfined run by contract — every `git_bash` call then reports `sandbox.unconfined: true`. Do not assume `git_bash` is protected by the DSH sandbox on such a host: use `pwsh` (restricted token) or `wsl_bash` (bwrap), or take the explicit escalation-approval path.

The Windows ACL boundary is also **object-shaped**, not path-shaped: a file created inside the workspace keeps its grant when reached through a hard link outside it, while an object created outside never gains the grant; reads stay unconfined. Treat `sandbox: auto` as a guardrail, and `requireSandbox: true` as the fail-closed stance.

## WSL and bwrap

`wsl_bash` sandboxing requires bubblewrap **inside the distro**. Install it from Windows:

```bash
wsl.exe -d Ubuntu-24.04 -e sudo apt-get install -y bubblewrap
wsl.exe -d Ubuntu-24.04 -e bash -c "command -v bwrap && bwrap --version"
```

- The probe targets the first distro from `wsl -l -q`; pin `wslBash.wslDistro` when the target is not first, and install bwrap inside that distro. `docker-desktop` has no bash and cannot be used.
- Other families: Fedora `dnf install bubblewrap`, Alpine `apk add bubblewrap`.
- The probe verdict is cached for the **host process lifetime**: after installing bwrap you must restart `dsh web` (or reload the row) before it is re-probed.
- The bwrap workspace root is the Linux side of a Windows drive path (`/mnt/<drive>/...`); a UNC workspace root fails loud, and a custom automount root needs matching configuration.

## SSH: outside the local file sandbox, by design

A file sandbox fences the **local** effects of a command this host runs. An SSH command's effects are on the other host, so the row applies **no wrapper at all** — wrapping `ssh.exe` would only restrict which local keys and `known_hosts` the client may read, and would break the client, which must read `~/.ssh/*` outside the workspace root.

Consequences:

- every **foreground** result carries `sandbox: { mode, remote: true }`;
- a promoted result reports the same fact **inside its returned text** (a promotion's seeded read has no structured `sandbox` field in the base tool's shape);
- a background acknowledgement carries **no `sandbox` field** — the same shape dsh's own `pwsh`/`bash` use for that branch;
- `denied`, `enforcement`, `runnerFailed` and `unconfined` are all absent;
- `requireSandbox: true` **refuses every command** on that row; the documented way through is a per-call `danger-full-access` escalation;
- the family prompt section drops its local file-sandbox sentence when no locally-sandboxable family tool is mounted.

A **stopped SSH call stops the client, not the remote command** (measured). `ssh -T host 'sleep N'` survives a `kill -9` of the local client: with no remote tty, sshd closes the channel and never signals the command. Make long remote work self-limiting on the remote side (`timeout`, `systemd-run`), or run it in a `terminal` session with `shell: ssh_bash`, whose PTY teardown does reap the remote process group.

## `requireSandbox`

Both local backends support `requireSandbox: true` (default `false`). When enabled and the probe fails:

- `danger-full-access` runs as usual;
- `read-only` / `workspace-write` calls are **refused** with an error naming the fix and the escalation path.

`requireSandbox` and `sandbox: none` are mutually exclusive in intent: explicit `none` is a deliberate opt-out and stays allowed; `requireSandbox` only governs the "sandbox wanted but probe failed" case.

```yaml
# profile patch, per tool row:
- id: win-mb-tool-git
  name: 'dsh-win-multi-bash/tool-git-bash'
  config:
    gitBash: { requireSandbox: true }

- id: win-mb-tool-wsl
  name: 'dsh-win-multi-bash/tool-wsl-bash'
  config:
    wslBash: { requireSandbox: true }
```

## The private-temp self-heal

The windows-acl backend materializes **one private temp root per (session, workspace root)** — `%TEMP%\dsh-<6 alphanumerics>` — and caches that path for the provider's lifetime (one entry per session and workspace root). Its runner treats `--temp` as an input that must already exist, so a missing path is a hard failure (`windows-acl-run: --temp is not an existing directory: <path>`, exit 127) and every later **wrapped** spawn of that session fails until it is back.

Recreating the directory by hand restores **existence only**: the seam's write grant (`tempWriteSid` ACE) does not come back, so a confined child writing its own `%TEMP%` stays denied.

`guardSandboxTemp` (default on) repairs it at the one seam every confined spawn shares: the core row wraps `ctx.sandbox.confine()`, so the `--temp` named by the seam result is checked — and, when missing, recreated together with the seam's own write grant (`tempWriteSid` + `AclWriteGrant`, the same calls `dsh-sandbox-local` makes) — **before that result is handed back to the caller**. That covers this plugin's `git_bash` / `msys2_bash` rows *and* the host's own confined spawns — measured on this machine: `run_code`, the platform's `bash` and `pwsh`, and any PTY terminal service a deployment mounts (`dsh-terminal-bash` takes the same seam) — which no row of this plugin could otherwise reach; a per-row check also runs the repair on this plugin's own confine calls, and a timer (`tempWatchMs`) re-checks every private root the process has seen, so a directory deleted while nothing runs is restored without a human.

The hook is installed through `ctx.inject(['sandbox'])`, never through the core row's own `inject` list: a composition without a sandbox service loses the hook and nothing else. It patches the provider class's `confine` (the object that owns the method), so a provider rebuilt later in the same process is covered too, and disposal puts the method back exactly as it was found.

Boundaries, stated so the switch is not mistaken for a cleanup tool:

- the only accepted target is a **missing, absolute** `dsh-<6 alphanumerics>` **direct child of an OS temp root**, outside every workspace root — the workspace gate is applied wherever a root is known (the seam channel passes the policy root and the runner's `--workspace`), while the ambient scan has no workspace root to compare against and is bounded by the temp-root and name-shape gates alone;
- an ambient temp root, a nested path, a lock or spill directory, a wrongly spelled name, or an existing directory is refused and named; the heal path tolerates an existence race, because a directory rebuilt by someone else still needs its grant;
- nothing is deleted;
- `AclWriteGrant` is an optional peer from `@deepseek-ai/dsh-sandbox-windows-acl`, imported lazily; when it cannot be resolved the directory is still recreated (existence only) and the plugin warns that the grant was **not** restored;
- the switch is declared **once**, on the core row, and turning it off stops healing everywhere from the next command;
- `wsl_bash` uses bwrap and never materializes a `--temp` directory, so the knob is inert there;
- healing runs *before* the seam result is handed back, so the caller's spawn normally finds the directory already back — best-effort by construction: a failed `mkdir` or grant is reported and the command runs unchanged — while a deletion landing between that result and the runner's own check can still fail **that one call**, which is then repaired for the next;
- healing *through this plugin's own rows* only happens where a confined run happens at all: on a host whose runner cannot start MSYS bash, the git row never reaches the runner, so it can neither break nor heal through it — the seam channel above is what still covers the host's tools;
- wrapping another package's service is a deliberate, stated limit: the hook only ever adds a missing `dsh-<6>` directory and its grant, forwards arguments and rejections untouched, and is removed when the row goes away.

Measured on this machine (2026-10-16, reproduced by the audit): without the grant a wrapped `cmd.exe` write into its own `%TEMP%` fails with "Access is denied"; with it the write succeeds; after deleting the private root the runner exits 127 with that signature; after the heal the wrapped write succeeds again.

## Denial-dialect learning

The row's capability probe no longer learns the denial dialect. The first **confined** command makes one deliberately-denied, harmless write outside the workspace root and keeps that refusal text as an extra signature (a union with the backend's own list), so a localized refusal the backend never enumerates is still classified — and the command that triggers the learning is classified by it, because learning completes before that command starts. The probe target must not exist afterwards; if it somehow does, the row deletes it and discards the discovery. Failure to learn is silent and never blocks the row. Measured cost: about +321 ms, once per row lifecycle, on the WSL/bwrap path; a row that never runs a confined command never pays it.
