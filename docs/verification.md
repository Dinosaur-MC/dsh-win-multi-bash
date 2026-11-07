# Verification

The plugin has two verification entry points plus one opt-in live check. All are development tools: the published tarball ships no `smoke/`.

## Dev runtime

The checkout resolves `@deepseek-ai/*` from its own `node_modules`, pinned by `package-lock.json`:

```bash
npm ci
```

That tree is the exact `0.2.1-rc.2` runtime the gate runs against, so a result does not depend on what the live profile happens to hold. A checkout without it falls back to linking the live profile (the arrangement earlier revisions used); `smoke/prepare.mjs` removes only the links it created.

Requires Node `^22.19.0 || >=24.0.0` — the range this package declares and the string the harness's own root `package.json` publishes. The plugin executes inside the dsh host process, so its floor cannot be lower than the host's; the desktop runtime ships Node 24.21.0, which the range admits.

## `pnpm test` — the driver (a verdict)

```bash
pnpm test
```

Boots a real composition over the profile runtime (modifying nothing) from its own fixture — which mounts the `git_bash` **and** `wsl_bash` rows explicitly, because the shipped patch ships the WSL row off — executes real commands (including an explicit `bashPath` variant), and asserts `ctx.shell` is still provided by the base bundle's own row (the regression this plugin once caused). The shipped patch's own default rows are verified by the audit instead (`pnpm run test:audit`, below).

It is a **verdict, not a report**: a missing tool, a wrong description, a lost `ctx.shell` seat or a failed command fails the run. It boots exactly two fixtures — the schema-default bash resolution and an explicit `bashPath` pin; neither disables the git row, so a missing-tool fixture is not part of this driver (the audit covers the misconfiguration cases it can boot: a stale pinned `bashPath`, a broken WSL backend, a nonexistent `wslDistro`).

On a host where `wsl.exe` exists but no distribution answers (the GitHub-hosted Windows image installs WSL this way), the driver still asserts the `wsl_bash` row is registered and advertises its facts, but reports the real-WSL command as a skip instead of failing the verdict. Both entries accept `DSH_AUDIT_WSL` to point the probe at a non-default launcher.

## `pnpm run test:audit` — the audit

```bash
pnpm run test:audit
```

Runs the full audit instead: pure-unit coverage of the vendor helpers, executor internals and tool config schemas, the browser half's form model (including the hosts table: add/remove, exclusive default, invalid rows blocking a save, the host-object array it stages), the client entry's export surface and the manifest's `engines.dsh` window, and boot-integration matrices for the real `cordis.patch.yml` and for misconfigurations (a stale pinned `bashPath`, a broken WSL backend, a nonexistent `wslDistro`, an explicit `bwrap` stance).

The suite also covers the SSH dialect end to end without a network. A real `ssh2.Server` fixture with a generated host key serves exec **and SFTP** (backed by a scratch directory), so the pool, the exec channel, the channel handle, the job-outcome mapping and the transfer runner run against a real protocol peer in-process: one TCP connection reused across a command and a transfer, a redial after a broken client, host-key verification on every dial, a `TERM` then `KILL` signal order, late output dropped after settlement, and a lost channel settling its job **failed** with the host-named sentence. The transfer cases move real files through the fixture's SFTP subsystem: file and directory uploads/downloads with real byte counts, empty directories preserved on both sides, missing parents created, a directory without `recursive` named as an error, a remote permission failure and a missing remote path kept as structured `sftp`-phase errors, and a stalled subsystem/OPEN request ending at the deadline — a refused subsystem has no session to close, so the call's lease is handed back and its client retired, and a session that arrives afterwards is closed. The channel-retry cases pin the capacity-only rule: a `MaxSessions`/capacity refusal is retried at 100/200/400 ms (capped at 1 s) and, at exhaustion, the last server refusal is reported verbatim with the matching note — the expired deadline for a foreground call, `gave up after N attempts` for the bounded budget; a non-capacity error is never retried; a foreground call retries until its deadline while a job-owned call is bounded to four attempts; an OPEN the server never answers settles at the deadline, and an abort surfaces as the platform abort. For a transfer, a refused subsystem is retried under the bounded budget and reported at the `connect` phase before any session exists. Every cancellation hands its lease back and retires only its own client, so a command sharing that connection finishes while repeated stalls never accumulate — that lease accounting is pinned directly, and the local-path rule has its own unit guards (inside, `..` escape, absolute outside, the `danger-full-access` allowance, and a missing workspace root failing closed). The registry mechanics behind the channel handle — output windows, spill files, job reads — are shared with the local dialects and pinned by their tests. Pure-unit guards pin the host registry (duplicates, defaults, aliases, ports, the broken-array verdict), the `known_hosts` parser (plain and bracketed entries, hashed names, patterns and negation, `@revoked`, `known_hosts2`), the POSIX script builder (startup guard, workdir quoting, base64 round-trip), the two-tool row (one executor registering `ssh_shell` and `ssh_scp` on the same `sshShell` partition, and the `ssh_scp` parameter/output surface with `ok`, `bytes`, `files`, `error`, `sandbox`, `outsideWorkspace` and no `run_in_background`), the authorization gate (trusted never asks; one request per session and host; a second session asks again; a changed fingerprint re-asks; rejection, cancellation and an unavailable answerer fail closed; a `never` policy rejects without asking; concurrent misses share one request; no connection on any refusal), the `ssh_scp` structured `approval` phase, the dedicated `conversation.composer` card entry at priority 0 with its two-tool matcher and the platform fallback for everything else, the alias parameter's three states, the `sandbox: { mode, remote: true }` fact and the *absence* of `denied` / `enforcement` / `unconfined`, `requireSandbox` failing closed, the session row's derived shell list and its `remote` fact, and the family section's remote gating. One boot case runs the real tool against a registry whose host is `192.0.2.1` (TEST-NET-1, guaranteed unroutable): the failure names the alias, an unknown alias is refused with the declared list, an unknown-alias or Windows/relative `remotePath` or outside-workspace `localPath` transfer answers as a structured value rather than an exception, the row advertises no `sandbox_permissions`, and the schema → render path is exercised with no server.

The audit **announces and counts its skips**; an escaped assertion reports the case and prints the summary instead of killing the suite without a verdict. `DSH_AUDIT_TIMING=1` attributes the wall clock.

The suite also probes the default WSL distribution functionally. When one is missing it skips and counts the WSL execution cases and the real-WSL degradation fixtures, while the WSL schema, argv and prompt cases still run.

## GitHub Actions

`.github/workflows/ci.yml` runs on `windows-latest` for Node 22.x and 24.x: `npm ci`, the driver smoke, the full audit and `npm pack --dry-run`. Hosted runners have WSL installed without a distribution, so the audit skips the WSL execution cases it cannot run; Git Bash, the PTY/ConPTY path and the rest of the suite are hard gates.

## Live SSH round trip (opt-in)

A live round trip needs a reachable host and a credential, so it is never part of the gate:

```bash
DSH_AUDIT_SSH_HOST=me node smoke/prepare.mjs audit
```

That boots the real `ssh_shell` row with a one-host registry and runs `uname -sr; echo SSH-ROUNDTRIP-OK; exit 7` through the real tool over ssh2. It asserts that the remote exit status **7 propagates**, stdout carries `SSH-ROUNDTRIP-OK`, the structured fact is `sandbox.remote: true`, and this host's managed `$DSH_*` variables do **not** cross the connection. The host comes from `DSH_AUDIT_SSH_HOST` (a `~/.ssh/config` alias or a host name); `DSH_AUDIT_SSH_USER` (default `root`) and `DSH_AUDIT_SSH_KEY` (default `~/.ssh/id_ed25519`) pin the login, so the check adds no configuration of its own. Unset, every offline case still runs and the suite stays fully offline.

## What `smoke/prepare.mjs` does

Both entries run the same Node bootstrap: it links the runtime scope in force (the checkout's pinned `node_modules`, or the live profile when the checkout has none) into `smoke/node_modules`, refusing to touch anything that is not already the expected link, writes its fixtures under `.temp/smoke/`, and removes only the links it created. The `bashPath` it pins comes from the plugin's own resolver in `lib/`, never a hardcoded path.
## Manual 0.8.0 boot gate (isolated DSH)

Run on 2026-11-06 against `0.2.2-rc.1` in an isolated `DSH_HOME` with the local workspace linked into the isolated profile, a local Ollama provider (`qwen3.6-uncensored:35b_q5kp`), and the real `prod` host in the registry (`approval: session`, key auth). No local sshd was installed, so the gate used the known remote host; every other requirement of the Plan 4 gate held. The isolated instance ran on its own port/token, not the user's running profile.

- **Dedicated SSH card (allowed).** A real agent turn called `ssh_shell` for `prod`; the plugin's card rendered as a copy of the platform approval card (same root/card/strip/body/action-row structure and tokens, `StateDot`, heading/description) with `拒绝` / `允许一次` / `本次会话允许`. Clicking the added session button printed `GATE-ALLOW2` from the host.
- **True one-shot vs session (re-run on the scope-aware build `d30981b`).** In a fresh session, the first `prod` call chose `允许一次`: it printed `SCOPE-A`. A second call to the SAME host in the SAME session re-rendered the approval card (the one-shot grant is not cached). Choosing `本次会话允许` then printed `SCOPE-B`, and a third call executed with NO card and printed `SCOPE-C`. This re-run is the live proof that the scope-aware card keeps `允许一次` genuinely one-shot while the added session action caches for the session.
- **Approval timeout.** `approvalTimeoutMs` was set to 5000 on `prod`; a prompt was left unanswered. After five seconds the card was withdrawn and the tool returned exactly `Error: ssh: host "prod" (me@host.example.com:22) is not authorized for this session: approval timed out after 5000 ms`; no dial happened and the next call asked again (nothing cached). The field was reset to the default afterwards.
- **Rejected.** A fresh `win-host` request rendered a new card; `拒绝` made the tool fail with `ssh: host "win-host" (me@host.example.com:22) is not authorized for this session: the request was rejected`.
- **Sequential approvals.** The second request after the first allowed answer rendered a fresh card with enabled buttons, not a settled or stale one; state is per pending id, not per composer instance.
- **Non-SSH approval.** A `plugin_manager` call requiring `danger-full-access` rendered the platform's standard approval card (`拒绝` / `允许一次`), not the SSH card. The SSH matcher claims only `ssh_shell`/`ssh_scp`.
- **Synchronous `pending.answer` throw.** In the real page the pending object was located through the React fiber and its `answer` replaced with a synchronous throw. Clicking `本次会话允许` restored all three buttons (`disabled=false`) and showed the failure alert (`答复未能送达。该请求仍在等待——请重试，或改用标准审批卡答复。`); the card did not deadlock.

The throw injection is test-only browser-page instrumentation; no platform package or shipped file was modified. The pre-fix run of the same check left all buttons disabled with no alert, which is why the synchronous-answer guard is part of 0.8.0.
