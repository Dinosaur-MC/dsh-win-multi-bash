# Architecture

This is the map of the plugin: what is a row, what is a dialect, how a tool call becomes a rendered result, and which surfaces are derived from which declaration. The rules that constrain these choices are in [Design principles](principles.md).

## Vocabulary

- **Dialect** — one shell family: `git_bash`, `wsl_bash`, `msys2_bash`, `ssh_shell`.
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
| `win-mb-tool-ssh` | `.../tool-ssh-shell` | **off** | `SshShellExecutor`, `sshShell` — serves `ssh_shell` and `ssh_scp` from one executor |
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
- `lib/ssh-shell/index.js` — pooled SSH over ssh2: one connection per host, one exec channel per call, a base64 POSIX script on the channel's stdin; hosts and host-key policy are deployment configuration, never call arguments (see [Remote execution](#remote-execution-ssh_shell)).

## The tool factory

`lib/tool-bash/types/factory.js` builds one tool instance per dialect. It owns:

- the tool-layer `Config` (`enableRunInBackground`, `promoteOnTimeout`) and the backend partition the executor is built from;
- the escalation surface (`sandbox_permissions`) advertised only where confinement exists;
- background jobs: `run_in_background` starts a real job and returns `{ kind: 'background', jobId, cwd }`; a timed-out foreground command is promoted instead of killed (matching dsh's own bash); the job label is `description · command`, because the platform draws that one field both as the job row's title and as its expanded command line;
- result rendering: exit/signal markers, sandbox markers, spill previews, promoted reads, the `(no output)` body;
- the fallback description when the core row is absent (the shared guidance moves into each tool description).

A dialect may also contribute **extra tools** from its one executor (`extraTools`): the ssh row registers `ssh_scp` this way, so the transfer shares the row's Config, host registry and connection pool instead of building a second engine.

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
- renders the `sshShell.hosts` registry as a **table** on the ssh row's Configure page: one card per host with every registry field, `approval` as a select and `default` as an exclusive radio (at most one, zero allowed), staging the host-object array — there is no JSON text control; each row also has a **Test connection** action that posts the row's unsaved values to `hosts.test` and shows the fingerprint or failed phase inline;
- registers the Session header's terminal list (`conversation.session.header.actions`): `sessions.list` / `sessions.tail` over the plugin's `/win-mb` JSON route on the web server (legacy hosts fall back to Connection RPC), and `sessions.stop` for a human Stop;
- registers the dedicated SSH authorization card as a `conversation.composer` chain entry at priority 0 (see [Conversation rows](conversation-rows.md#host-authorization-card)): it claims only a pending, answerable approval whose tool is `ssh_shell` or `ssh_scp`, and returns null for everything else so the platform's shared approval composer at priority 1 keeps the standard card;
- registers the core-row note via `plugins.detail.section`.

The browser half cannot import the package (the client module loader resolves subpaths to `undefined`), so the dialect list and terminal literals are generated into a marked region by `smoke/gen-client-registry.mjs`; the audit byte-compares that region with the registry. The bare-package core row is what makes the browser half discoverable at all: `dsh-client-modules` reads `dsh.client` from the row's resolved `package.json`, and a subpath row does not resolve that way.

## Call flow

```text
model tool call
  → tool instance (factory) resolves the policy and the workdir (the alias, for `ssh_shell`)
  → executor builds argv and asks the sandbox seam (confine / none), or opens a pooled channel (remote)
  → a transfer opens one SFTP session on the same pooled client and streams the files
  → subprocess spawns the shell, or the ssh channel runs the script remotely; stdout/stderr are bounded and spilled
  → renderer writes markers ([exit code: N], sandbox facts, promotion, spill)
  → tool result (content + structured sandbox fact; `{ remote: true }` for `ssh_shell`)
  → client slot tool.call.toolview renders the shell card
```

## Remote execution (`ssh_shell`)

The SSH dialect keeps the family's tool contract but replaces the local spawn with a pooled exec channel:

- **One engine per tool row, one client per host.** `lib/ssh-shell/pool.js` owns an `ssh2.Client` per alias, dialled lazily and reused across calls (two concurrent first calls share one dial); the host key is verified on every dial, a client that errors or closes is dropped so the next call redials instead of inheriting a dead socket, and row teardown closes every client. There is no idle timer.
- **One exec channel per call.** `execute` / `resolve` open a channel, send the base64 POSIX script built by `script.js` on its stdin, collect stdout and stderr separately, and settle on the exit status ssh2 delivers (the `exit` event or the `close` arguments). Settlement waits at most 100 ms for trailing bytes, then destroys the channel; bytes that arrive afterwards are counted and discarded, so a background child cannot leak output into the next call.
- **The host registry decides the target.** `hosts.js` validates `sshShell.hosts` and resolves the call's alias (or the single `default` host); `known-hosts.js` supplies the `hostVerifier` that refuses an unknown, changed or `@revoked` key before authentication completes. `pool.js` reads the private key from `keyPath` and a passphrase only from the environment variable the host names.
- **An unsaved host can be tested without joining the pool.** `lib/ssh-shell/probe.js` validates one row with the same `hosts.js` / `known-hosts.js` rules, dials a one-shot ssh2 client, verifies the host key and authenticates the key, then closes it — no command, no pool entry, no approval grant. The hosts table's Test connection action calls it through `hosts.test` on `/win-mb` and reports the fingerprint or the failed phase.
- **Authorization is a gate before any connection.** `approval.js` applies the host's `approval` policy before the pool is touched: `trusted` never asks; `session` (the default) asks once per session through `ctx.approval`, after the registry verdict and before the dial. Grants live in a `WeakMap` keyed by the Session object and a fingerprint over `alias + host + port + user + keyPath + passphraseEnv` — memory only, per session, lost on plugin reload — so editing any of those fields re-asks. A rejection, cancellation or unavailable answerer fails closed (the last naming the `trusted` escape hatch), a session policy of `never` rejects without asking, and concurrent misses for one host share a single in-flight request. Every gate failure carries phase `approval`: `ssh_shell` throws it, `ssh_scp` returns it as a structured `{ phase: 'approval' }` value.
- **No plugin-level concurrency cap.** Concurrency is bounded by the job registry's limits (background), the agent loop's parallel calls and the number of sessions (foreground), and the server's `MaxSessions` per connection. A channel the server refuses for **capacity** — `administratively prohibited`, `channel open failure`, `open failed`, `MaxSessions`, `resource shortage` — is retried (the OPEN only, never the command) at 100/200/400 ms, capped at 1 s: a foreground call retries until its deadline, while a background or job-owned call uses a bounded 4-attempt budget. Each attempt is raced against the deadline and the caller's abort, so a server that never answers the OPEN settles at the deadline instead of holding the call. Authentication, host-key, handshake, socket and passphrase failures — and every SFTP operation error — are never retried. When retrying stops the error is the **last server refusal verbatim** plus a note saying why: a foreground call adds that the call deadline expired, while the bounded background budget adds `gave up after N attempts`. It is never a synthetic "timed out", and a command that never ran reports no `timedOut`; an abort surfaces as the platform abort. One lease is taken per call and released once; the retries reuse the same leased client and each attempt opens a new channel. A refused SFTP subsystem follows the same bounded budget; its error phase is `connect` before any session exists and `sftp` after it does, with the alias in `error.alias` rather than in the message.
- **Jobs are the factory's, not a second implementation.** The channel handle exposes the same `result()` / `kill()` / output-source contract as the local executors, so `run_in_background` (register immediately, stream into the job ring, settle on exit), timeout promotion (register before starting, return a job id, leave it running), `job_kill` (TERM, 2 s, KILL, close) and the admission-refusal fallback all reuse the existing factory path. A channel that closes with no exit status is an infrastructure failure: the handle is `failed`, the job settles **failed** with a sentence naming the host, never completed with exit 0.
- **Cancellation is a remote signal.** On timeout or caller abort the runner sends `SIGTERM`, waits up to 2 s, sends `SIGKILL` and closes the channel; a lost connection tears the remote session down with it. Commands that detach themselves (`nohup`, `setsid`) survive by design, and are documented that way. The transport is `ssh2 ~1.17.0`: the version is pinned because the cancellation path uses the protocol-level signal request after stdin is half-closed (the public `signal()` becomes a no-op there). If a future build lacks that path, the result's stderr carries a loud marker that the remote command may still be running.
- **Remote effects are stated, not sandboxed.** The result carries `sandbox: { mode, remote: true }` and no local verdict; the local file sandbox is not applied to a command that runs on another host. `cwd` is the remote `workdir` when one was given and the empty string otherwise.
- **The PTY path is unchanged.** `terminal` still runs a real PTY over the OpenSSH client (`ssh.exe -t`), configured by its own `sshShell` single-host pin; it does not read the `hosts` table in 0.8.0, so interactive host-key questions and terminal semantics stay exactly as they were. `terminal` is also outside the host-authorization gate: a session uses its own single-host pin. Sharing the registry with `terminal` is future work.

### Transfers (`ssh_scp`)

The same row, executor, host registry, known_hosts check and connection pool serve a second tool, `ssh_scp` (`lib/ssh-shell/scp-tool.js` over `scp.js`). `defineShellTool` accepts an `extraTools` list for exactly this: a dialect registers additional tools against the ONE executor, so the transfer adds no row, no config partition and no second pool.

- **One SFTP session per operation** on a leased pooled client. A successful or failed operation closes its session before it returns, and a cancellation tears the live streams down, ends a session that exists, hands the lease back and retires exactly that client — including a session that arrives after the caller already got its answer. The one path that cannot run the operation's `finally` is a subsystem or OPEN request the server never answers: the client is closed with its last lease, which rejects the parked request, and a late session is closed when it finally arrives.
- **Foreground only.** No `run_in_background`, no promotion, no job: its own deadline (default 300 s) races the **whole** operation — the pool dial, the SFTP subsystem request and the transfer — because each of those awaits can park forever on a server that never answers.
- **A leased client, retired surgically.** `pool.get()` / `release()` count leases. A cancelled transfer hands its lease back and retires exactly the client it held (`retire(alias, client)`), so a command or another transfer already running on that connection finishes normally while the next call dials a fresh one. A stalled subsystem or OPEN request can never be un-parked, so closing the old client with its last lease is what stops it accumulating.
- **The local side is a real local effect.** `local-path.js` resolves `localPath` against the session cwd and requires it to stay inside the workspace root; `danger-full-access` is the only mode that allows an outside path, and the result then says `outsideWorkspace: true`. The decision is lexical (no pre-flight filesystem access), and a refusal reuses the family's sandbox sentence. `remotePath` must be absolute: POSIX `/...` is unchanged, a Windows drive path is normalized to `/C:/...` (upper-case drive letter, forward slashes) and UNC is passed through; a relative path is refused before any dial.
- **Result and failure contract.** `{ ok, bytes, files?, error?, sandbox, outsideWorkspace? }`, with `sandbox: { mode, remote: true }` on **every** result. A failure is a value: `{ phase, alias, message }` with the phase one of `config`, `sandbox`, `connect`, `sftp`, the alias named and the ssh2 message kept. Only the platform's abort throws, exactly as `ssh_shell` does.
- **No custom conversation card.** The transfer has no `tool.call.toolview` row of its own; it renders through the platform's generic card. A dedicated transfer card is future work.

## Path conversion and workdir

Git Bash rewrites leading-slash POSIX paths into Windows paths whenever a native Windows program is called. That is MSYS behavior, not a plugin defect: `wsl.exe -e ls /root` inside `git_bash` becomes `...\Git\root`. Prefix the call with `MSYS_NO_PATHCONV=1` (or `MSYS2_ARG_CONV_EXCL="*"`) to pass arguments verbatim; for WSL work, prefer `wsl_bash`, which ships the command as a base64 payload.

`workdir` accepts native, MSYS (`/c/...`) and WSL automount (`/mnt/c/...`) forms. The resolver translates a single-letter drive form and the automount form to native before `spawn`; MSYS POSIX roots (`/etc`, `/usr`, `/tmp`) and distro-side paths such as `/mnt/data` are left alone, and a relative `workdir` resolves against the session workspace. None of this applies to `ssh_shell`: its `workdir` is an absolute POSIX path on the remote host, taken verbatim (never resolved against the local session) and refused by name when it is a Windows or relative path. The conversation card's prompt cwd applies the same resolution plus `.`/`..` normalization, so a `workdir: "lib/.."` displays the actual directory, not `..`.

## Package layout

```text
lib/
├── bash-git/       GitBashExecutor (MSYS)
├── bash-wsl/       WslBashExecutor (WSL, base64 payloads)
├── bash-msys2/     Msys2BashExecutor (MSYS2 UCRT64)
├── ssh-shell/      SshShellExecutor (pooled ssh2 channels) + ssh_scp (SFTP),
│                   hosts, known_hosts, script builder, connection pool,
│                   local-path policy and transfer runner
├── tool-bash/      factory + one instance per dialect; registry, shell-family,
│                   render, terminal, backend ownership
├── terminal-session.js   PTY registry: bounded output, readiness, reclamation
├── sandbox-temp-guard.js private-temp self-heal
└── vendor/         runner-failure classification, bwrap profiles
```

No build step: `lib/` is plain ESM JS. `smoke/` and `docs/` are repository-only; `package.json`'s `files` whitelist is the publish boundary. The manifest also declares `engines.dsh` (`>=0.1.7-rc.2 <0.3.0-0`): the runtime refuses the plugin outside that window instead of falling back to the peer list.
