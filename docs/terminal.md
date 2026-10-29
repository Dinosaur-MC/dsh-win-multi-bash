# Terminal sessions (`terminal`)

`terminal` runs a **persistent PTY session** — a real interactive shell that stays alive between calls, so the current directory, exported variables, aliases, functions and background jobs survive. Use it for REPLs, debuggers, `ssh`, database clients, TUI programs, or any workflow that depends on shell state.

| Action | What it does |
| --- | --- |
| `open` | Starts a session and returns its `sessionId`, `pid`, cwd, shell/remote fact and startup output |
| `send` | Writes `text` (with Enter unless `submit: false`) and returns the reply |
| `read` | Reads new output without writing; `waitMs` blocks until the next output arrives, `all: true` dumps the retained scrollback, `offset` re-reads from a whole-stream byte offset |
| `signal` | Delivers a signal to the foreground process group; on this platform only `SIGINT` reaches the shell |
| `close` | Ends the session and waits for the outcome its own terminate produced |
| `list` | The sessions you own |

Every session result carries `shell` and `remote` (value and `output.schema`), so a context that only holds a later result still knows whether it is typing into another host.

## Backends

The backend is the dialect registry. `shell` names one of the dialects that declare interactive-session capability — `git_bash`, `wsl_bash`, `msys2_bash`, `ssh_bash` — and each executor supplies its own interactive argv:

- `bash.exe -i`
- `wsl.exe --cd <dir> [-d <distro>] -- bash -i`
- `ssh.exe -t <options> -- <host>` (no `-T`, no `BatchMode`, so the PTY can answer a first-connect prompt)

`terminal.defaultShell` picks the default; a dialect that declares no session is never offered.

**One shell per session, using the user's own startup files.** `-i` only — no `--noprofile --norc` — because the aliases and exported functions a session exists to preserve are exactly what those files set up.

## Output and waits

- **A wait that ends on silence is not a finished command.** `send` / `signal` return once output has been silent for `quietMs` and report `waitReason: "quiet"`; a tty echoes input within milliseconds, so silence usually starts long before a command finishes. `timeout` means the wait hit `waitMs` and the session is still running. Either way, `read` again for more.
- **`read` waits only when asked, and says why it is empty.** With a positive `waitMs` (clamped to `maxWaitMs`) it blocks until NEW output arrives and returns that delta the moment it lands; without one the call is an instant snapshot. An empty answer is never bare: it carries `waitReason: "no_output"` (nothing new since the last read), `"timeout"` (the budget ended with nothing new), or `"session_exit"`. The wait is cancelled with the call: an aborted tool call stops polling immediately instead of holding the session for the rest of its budget.
- **`all: true` is the unconditional form of `read`.** It returns the whole retained window (the scrollback) instead of a delta, and does not move the read cursor, so a later delta read still reports everything that arrived after the last delta; its `nextOffset` is therefore that cursor, not the end of the window. It is refused together with `offset` or `waitMs` (at the tool row and in the registry) rather than letting one silently win, and an empty window reports `no_output` like any other empty read.
- **A `send` or `signal` never swallows output.** Its delta starts at the caller's read cursor, not at the moment of the write, so output that arrived between the last read and the call is delivered with it instead of becoming invisible. That means a `send` after a long unread stretch carries the backlog too — bounded by `maxBufferBytes`, and reported by `truncated` / `lossy` like any other read.
- **Output is bounded and honest about it.** Each session retains the last `maxBufferBytes` (default 1 MiB) of **sanitized** text and reports two facts separately: `truncated` (the session dropped output at some point) and `lossy` (the offset this read asked for had already been dropped, so the whole retained tail came back instead of a delta). ANSI escape sequences are stripped; there is no terminal emulator, so a program that redraws one line with carriage returns becomes several lines.

## Lifecycle

- **Capped, reclaimed, process-local.** `maxSessions` (default 8) refuses the next `open` by name; a session untouched by `send` / `read` / `signal` for `idleMs` (default 10 minutes) is terminated, and its id afterwards says it was reclaimed by the idle reaper rather than looking unknown. Sessions do **not** survive a `dsh` restart.
- **Sessions are not jobs.** They are not registered in `ctx.jobs`, so `job_kill` cannot reach one: `close` is the only way the **model** can end a session; the Session header's Stop (a human) and the idle reaper are the other two paths.
- **`close` reports what its terminate caused.** It waits (bounded by a fixed 1 s grace) for the outcome the session tree produced instead of reading `exitCode` the instant `terminate()` resolves; a force-terminated session reports exit code 1 on Windows (no signal), a natural `exit 0` reports 0.

## Sandbox and remote facts

A PTY session runs **unconfined**, and says so:

- a file sandbox wraps the argv of a spawned command; a terminal session is allocated by a different provider call, and on this host the windows-acl runner cannot start MSYS bash at all (`0xC0000142`);
- every `open` carries `unconfined: true`;
- `terminal.allowUnconfined: false` makes `open` refuse instead of running unprotected;
- a session in a remote backend (SSH) also carries `remote: true` and says so in its first line — the one fact that matters there, since the files it touches are not on this host; `unconfined` stays true beside it.

## Finished sessions

A session that ends is still history. `reclaim` moves it to a bounded **finished** list (8 sessions, oldest evicted first) instead of dropping it, so:

- `list` keeps showing it with `status: exited`, and the Session header's finished section keeps its row expandable;
- `read` answers from the retained ring — the delta since your cursor, or `all: true` for the whole window; `tail` (the panel's expand) returns that window without moving any cursor;
- `send`, `signal` and `close` are refused with the reason it ended (`stopped by the user from the session header`, `closed by the idle reaper after …`, `exited before its first prompt`);
- an evicted id answers `is gone — finished session evicted (retention limit)` (the reason is remembered for the most recent 16 reclaimed ids).

## Session header panel

The browser half adds one control beside the Session title (`conversation.session.header.actions`, the same list the first-party job and subagent entries use), modelled on the first-party **jobs** list (`@deepseek-ai/dsh-client-ui-jobs`):

- the trigger is a dot (only while a session is running) plus a count (`3 terminal session running`, or `3 terminal sessions` when all have ended) and a chevron; it renders **nothing** while no session exists — exactly like the job list;
- the popover lists **Running** rows first (filled cards, live dot, shell badge, name, cwd, elapsed time) and a **Finished** section for sessions whose shell already exited;
- each **running** row carries a two-press **Stop** (the first press arms it for 3 s and widens into a labelled confirm, the second sends the stop) — the same affordance as the job list's kill;
- rows poll `sessions.list` every 2 s while open (and every 5 s while closed, which is how the trigger appears), an expanded row re-reads `sessions.tail` every 1.5 s, and the elapsed clock ticks every second.

- The list and the stop ride the deployment's own Connection RPC channel (`/win-mb`): `sessions.list` answers with the registry's view, `sessions.stop` closes one session through the same `reclaim` path as the tool's `close`, and the tombstone records `stopped by the user from the session header` so a later model read names who ended it.
- A deployment without `ctx.connection`, or a shell that does not declare the slot, registers nothing: the button simply does not appear and every tool keeps working.
- The panel polls the list every 2 s while open and the expanded row's retained tail every 1.5 s. It is a reading surface, not a second control plane: the model's `terminal list` / `close` remain the agent-facing contract.
- A session can end without a tool call — the shell exits, the idle reaper closes it, or a human presses Stop. Each of those posts **one in-session notice** to the agent that opened the session (`terminal: session … was stopped by the user (session header).` / `terminal: session … was closed by the idle reaper after … ms without activity.` / `terminal: session … exited on its own (exit code …).`), so the owner reads it instead of polling. A model's own `close` is not announced: its tool result already said so.

## Signals

Only `SIGINT` reaches the shell on this platform; the other four are refused **by name**:

- a win32 ConPTY terminal reports pid `0`; the provider's foreground-group lookup returns 0, and its kill path begins `if (pid <= 0) return`. `SIGTERM` would RESOLVE (reporting success) while delivering nothing; `SIGKILL` is refused by the provider for the same reason;
- this tool refuses `SIGTERM` / `SIGKILL` rather than returning a success that reached nothing;
- `SIGTSTP` / `SIGHUP` are refused by the provider with its own raw error, which would contradict this tool's own signal list, so it refuses those by name too;
- `SIGINT` is delivered as a Ctrl+C byte and does interrupt the foreground command (verified: it stops a `sleep 30` while the session stays usable).

Two provider facts: `pid` is `0` on Windows (ConPTY) and is display-only; `inspectActivity()` always answers `unknown`, so readiness falls back to output silence.

## SSH sessions

An SSH session is where a first-connect question can be answered — and the only form that reaps the remote side:

- `open` with `shell: "ssh_bash"` runs `ssh.exe -t … -- <host>` with no `BatchMode`, so the real PTY lets ssh ask for an unknown host's fingerprint, a password or a key passphrase — answer with `send`;
- the same PTY makes sshd reap the remote process group when the session ends, while a one-shot `ssh -T` command outlives its killed client;
- two honest limits: anything typed through `send` becomes part of the tool call, so authenticate with a key rather than typing a secret; and a session's `cwd` is where `ssh.exe` runs locally, never a remote directory.

## Measured defaults

The defaults were measured, not guessed:

- `quietMs` 500 ms has ~2.3× headroom over the worst inter-chunk gap seen (216 ms, 18 runs of `ls -la /usr/bin | head -80`);
- 1 MiB is the boundary a single `seq 1 200000` crosses (1,489,391 B raw; the plugin's escape stripping leaves 1,289,146 B = 1.229 MiB, and the ring counts that), which is what makes `truncated` observable;
- `waitMs` 10 s was verified with a 40×200 ms ticker that returned partial output while the session stayed alive;
- the 10 s startup budget covers the first prompt: a bare `bash -i` prints in ~0.8 s here, but a session loads the user's startup files, and this repository's prompt runs git — the first prompt measured ~4.0 s, exactly on the old 4 s budget, so every `open` used to pay it and report `timeout`.

All but the startup budget are live-editable on the row's Plugins page; the 10 s startup wait is the module constant `DEFAULT_STARTUP_WAIT_MS`.
