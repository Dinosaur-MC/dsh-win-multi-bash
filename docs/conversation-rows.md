# Conversation rows

A call of ours renders as the platform's own shell card, not as the generic `Tool call · <name>` row: the glyph the platform draws for `bash`/`pwsh`, the tool's **own name as the title** (`Git Bash`, `WSL Bash`, `MSYS2 Bash`, `SSH remote shell` — the same string in every language, so the four shells are told apart at a glance — and `Terminal` / 「终端」 for the session tool), the command (or its `description`) as the collapsed summary, and the platform's terminal card as the body.

## Dispatch

The platform dispatches every atomic call through its keyed `tool.call.toolview` slot **by wire name**, and a registered row replaces the generic one. That is the documented extension point for the package that owns a tool, and where the platform's own first-party rows live (`@deepseek-ai/dsh-client-ui-tool`: "an owning business package registers its wire Tool name").

One row is registered per tool this bundle mounts: the dialects the terminal row's `defaultShell` list carries (today `git_bash`, `wsl_bash`, `msys2_bash`, `ssh_bash`) plus `terminal`. The audit pins that list against the host registry's tool instances, so a dialect added there cannot keep the generic row unnoticed.

## All or nothing

The row is built from four client primitives (`DisclosureRow`, `TextShimmer`, `IconApiOutlineRegular`, `IconInspectOutlineRegular`). A deployment missing any of them registers **no row at all** and keeps the platform's generic card: plainer, never broken. `TerminalBlock` is optional rather than required: without it the rows still register and every body falls back to the platform's INPUT/OUTPUT card.

## State: the seat owns it

The row calls the `useDisclosure` hook the slot hands over, so its open/collapsed state resets with the enclosing Turn exactly like the platform's own rows; it keeps no private `useState`. A unit invocation without the hook uses a local fallback of the same shape.

## The body

- **Running `*_bash` calls** render the same card with no output/status; a background call renders it with `background: true` — **header only**, no status and no output, exactly as `bash`/`pwsh` draw their background acknowledgements. The job id is not shown in the card (the platform hides it too); it stays in the tool result and the job tools.
- **A settled foreground call** renders through `TerminalBlock` when its result is a single text block, is not an error, and carries none of this plugin's *not-settled* marker **lines** (a promotion still running, a spill preview, a job read that dropped output — matched as whole lines, so a command that merely prints those strings still renders as a terminal card). The body carries the command line, the output, and the exit code or signal, parsed from the same trailing `[exit code: N]` / `[killed by signal: X]` markers the host renderer writes; a marker-less result is a success because the renderer writes the exit marker only when the code is non-zero.
- **The collapsed row** also carries the platform's small exit capsule for a non-zero exit or a signal, so a failure is visible without expanding.
- **Every other call** keeps the generic INPUT/OUTPUT card — the single `terminal` tool included, whose call names an action rather than a command line, exactly like the platform's own `terminal_open`/`terminal_read` rows. A promoted (still-running) result deliberately stays generic: a result block has `running: false` and no exit/signal, so `TerminalBlock` would draw a green "done" dot for a command that is still running.

## Labels

`TerminalBlock` reads a full label surface (14 members) from its owner. The plugin mirrors the platform's `terminalBlockLabels` exactly, including `commandLine` (`Command line {n}` / `命令第 {n} 行`), which the primitive reads in its **header on every render**. A missing member throws `TypeError: ... is not a function` inside `TerminalBlock`; the slot's error boundary then replaces the entire entry with an empty `data-slot-error` node — measured as a zero-size card. The audit pins the whole list, not a hand-picked subset.

## Cwd and home

The prompt cwd follows the platform's `resolveTerminalCwd`:

- an absolute `workdir` is used as-is; a relative one joins under the session workspace;
- `.` and `..` are collapsed, and a `..` at a root is dropped (a UNC share's server/share are root, not poppable segments);
- the authored separator style is preserved;
- a settled result's recorded absolute `meta.cwd` wins over the requested workdir;
- `home` is passed so `TerminalBlock` displays the home directory as `~`.

## Activity summary

One thing stays the platform's: the turn's one-line activity summary is decided in `dsh-client-ui-chat` by a hard-coded name list — `bash`, `pwsh`, `exec_command`, `write_stdin`, and any name starting with `terminal_` — with no slot to extend, so a third-party wire name is counted as "calling tools" there however its own row looks.
