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

Boots a real composition over the profile runtime (modifying nothing), verifies the shipped patch mounts **only `git_bash`** by default (the opt-in `wsl_bash` row is enabled explicitly in its own fixture) and that it executes real commands — including an explicit `bashPath` variant — and asserts `ctx.shell` is still provided by the base bundle's own row (the regression this plugin once caused).

It is a **verdict, not a report**: a missing tool, a wrong description, a lost `ctx.shell` seat or a failed command fails the run. The fixture whose git row is disabled is used to prove the missing-tool case actually fails.

On a host where `wsl.exe` exists but no distribution answers (the GitHub-hosted Windows image installs WSL this way), the driver still asserts the `wsl_bash` row is registered and advertises its facts, but reports the real-WSL command as a skip instead of failing the verdict. Both entries accept `DSH_AUDIT_WSL` to point the probe at a non-default launcher.

## `pnpm run test:audit` — the audit

```bash
pnpm run test:audit
```

Runs the full audit instead: pure-unit coverage of the vendor helpers, executor internals and tool config schemas, the browser half's form model, and boot-integration matrices for the real `cordis.patch.yml` and for misconfigurations (a stale pinned `bashPath`, a broken WSL backend, a nonexistent `wslDistro`, an explicit `bwrap` stance).

The suite also covers the SSH dialect end to end without a network: argv shape and option order, target validation (leading `-`, whitespace/control characters make option injection impossible), client resolution and the stale-pin fallback, the `sandbox: { mode, remote: true }` fact and the *absence* of `denied` / `enforcement` / `unconfined`, the rendered marker, `requireSandbox` failing closed, the session row's derived shell list and its `remote` fact, and the family section's remote gating. One boot case runs the real tool against `192.0.2.1` (TEST-NET-1, guaranteed unroutable), so the whole spawn → result → schema → render path is exercised with no server.

The audit **announces and counts its skips**; an escaped assertion reports the case and prints the summary instead of killing the suite without a verdict. `DSH_AUDIT_TIMING=1` attributes the wall clock.

The suite also probes the default WSL distribution functionally. When one is missing it skips and counts the WSL execution cases and the real-WSL degradation fixtures, while the WSL schema, argv and prompt cases still run.

## GitHub Actions

`.github/workflows/ci.yml` runs on `windows-latest` for Node 22.x and 24.x: `npm ci`, the driver smoke, the full audit and `npm pack --dry-run`. Hosted runners have WSL installed without a distribution, so the audit skips the WSL execution cases it cannot run; Git Bash, the PTY/ConPTY path and the rest of the suite are hard gates.

## Live SSH round trip (opt-in)

A live round trip needs a reachable host and a credential, so it is never part of the gate:

```bash
DSH_AUDIT_SSH_HOST=ubuntu_tx node smoke/prepare.mjs audit
```

That boots the real SSH row with the real `ssh.exe` and runs `uname -sr; echo SSH-ROUNDTRIP-OK; exit 7` through the real tool. It asserts that the remote exit status **7 propagates**, stdout carries `SSH-ROUNDTRIP-OK`, the structured fact is `sandbox.remote: true`, and this host's managed `$DSH_*` variables do **not** cross the connection. The alias comes from the machine's own `~/.ssh/config`, so the check adds no configuration of its own; unset, every offline case still runs and the suite stays fully offline.

## What `smoke/prepare.mjs` does

Both entries run the same Node bootstrap: it links the runtime scope in force (the checkout's pinned `node_modules`, or the live profile when the checkout has none) into `smoke/node_modules`, refusing to touch anything that is not already the expected link, writes its fixtures under `.temp/smoke/`, and removes only the links it created. The `bashPath` it pins comes from the plugin's own resolver in `lib/`, never a hardcoded path.
