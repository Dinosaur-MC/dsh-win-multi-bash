# Design principles

These are the rules the implementation is held to. They are stated as constraints, not preferences; the audit and the code structure enforce most of them.

## 1. Never assert a fact nobody observed

A result may describe only what actually happened:

- a **successful confined** run reports `denied: false`;
- a **failed confined** run whose stderr matches the backend's denial dialect reports `denied: true`;
- a **failed confined** run matching nothing reports **no `denied` field** plus a marker saying the sandbox is not the known cause;
- an **unwrapped** run reports `{ mode, unconfined: true }` — it cannot have been denied by a sandbox that never wrapped it;
- a **remote** run reports `sandbox: { mode, remote: true }` and nothing from the local vocabulary (`denied`, `enforcement`, `runnerFailed`, `unconfined`).

The same rule applies to the model-facing prompt: the file-sandbox sentence is a promise about local effects, so it is dropped when no locally-sandboxable family tool is mounted, and a remote-scope sentence is used instead when an SSH dialect is.

## 2. One declaration, every surface derived

A dialect is declared once. The declaration is the source for the tool module, patch row, default-enabled state, config partition, package export, prompt-section membership, terminal backend list and client row list. The browser half's block is generated from the registry and byte-compared by the audit, because the client module loader cannot import the package.

A declaration that does not hold together **throws at load**: duplicate ids, a mismatched `configKey`, a tool name colliding with the family section, a stance list without `auto`, or empty family facts. Forgetting a derived surface must be a loud failure, never a silently disabled feature.

## 3. One prompt section, scope-aware

The family's shared guidance lives in one `tool:win-mb-bash` section owned by the core row. It is resolved at every assembly from the mounted tools, so `git_bash` / `wsl_bash` / `msys2_bash` / `ssh_bash` stay independently switchable: any subset renders exactly one correct copy, and no tool renders guidance for a tool that is not present.

Per-tool descriptions keep only dialect facts. If the core row is absent, the shared guidance falls back into each tool description (with a warning); the fallback text, not the log line, is what guarantees the model keeps the guidance.

## 4. Fail loud at load, degrade honestly at runtime

Configuration mistakes that can be caught statically throw at load. A missing external toolchain (Git Bash, WSL, `bwrap`, an SSH client) is a runtime fact: the row loads, discovery/probing happens lazily, and a failed sandbox probe degrades to an honest unconfined run rather than pretending.

`requireSandbox: true` flips that default for deployments that prefer fail-closed: `read-only` / `workspace-write` calls are refused when the probe fails, while `danger-full-access` still runs (it is equivalent to an explicit full-access grant). `sandbox: none` is a deliberate opt-out and stays allowed.

## 5. Platform parity for the conversation card

A call should read like the platform's own `bash`/`pwsh` card, not like a bespoke widget:

- the full `terminalBlockLabels` surface (14 members, including `commandLine`, read by `TerminalBlock`'s header);
- the slot's `useDisclosure` hook, so the open state resets with the enclosing Turn;
- the terminal card only for a running call or a settled foreground command; a background call gets `TerminalBlock` with `background: true` (header only);
- the platform's exit capsule in the collapsed row for a non-zero exit or a signal;
- the prompt cwd resolved like `resolveTerminalCwd` (relative under the session workspace, `.`/`..` collapsed, a settled `meta.cwd` absolute path wins), with `home` passed so the home directory shows `~`.

The plugin deliberately **does not** use the terminal card for a promoted (still-running) result: a result block has `running: false` and no exit/signal, so the card would draw a green "done" dot for a command that is still running. A generic INPUT/OUTPUT body is the honest choice there.

## 6. Marker lines, not substrings

Not-settled notices are detected as **whole lines** shaped like `[...]` (`[output truncated; ...]`, `[still running after ...]`, `[some output was dropped from memory; ...]`). A substring probe would misclassify any command that merely prints those strings — including this plugin's own source — and force a valid shell result onto the generic card.

## 7. Live knobs vs schema knobs

A knob is `.volatile()` when it can apply live: paths, distro, sandbox stance, timeouts, session limits, the self-heal switch. The page edits exactly the volatile projection of each row's `Config` schema; the audit pins the browser field table against the host schemas, so a knob without `.volatile()` cannot silently stay YAML-only.

A knob that shapes the tool's advertised schema needs the row's next load: `enableRunInBackground` (the `run_in_background` argument) and the escalation surface (advertised from the probe verdict). `promoteOnTimeout` is deliberately not on the page: it is a deployment stance, not a live per-call switch.

## 8. User input wins; the page never rewrites config

A text field is saved trimmed and echoed back; an unusable value (a non-absolute path, a distro name with spaces/quotes, a non-finite number) is **reported and still saved exactly as typed**. Whether it works is a runtime decision: the executor warns once, falls back to discovery/default, and leaves the stored value untouched until the user saves again. A numeric field is stored as the number its text names, so a spelling that names a different value (`0x10`, `1e3`, `007`) is reported rather than silently rewritten.

The form is staged, not live: drafts are written only on Save, fenced by the revision they were read at, and a refused save keeps the drafts.

## 9. Optional backends must not poison each other

A broken WSL backend leaves `git_bash` fully usable; a missing Git Bash never affects pwsh; a row switched off never probes. The shared prompt section is the only cross-tool coupling, and it is resolved from what is mounted rather than assumed.

## 10. Verification is a verdict, not a report

`pnpm test` fails on a missing tool, a wrong description, a lost `ctx.shell` seat or any failed command. The audit announces and counts skips instead of hiding them between pass and fail totals. Every guard is written so a mutation turns it red; a test that cannot fail is not a guard.

## 11. Documentation boundary

The README is the release-facing entry point (bilingual, kept under the i18n hash gate). Detail that would make it a manual belongs in `docs/`: architecture, principles, sandbox caveats, terminal semantics, conversation-row internals, configuration, verification and troubleshooting. The npm tarball ships only the files in `package.json`'s `files` whitelist; `docs/` and `smoke/` are repository-only.
