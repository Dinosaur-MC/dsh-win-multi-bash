# Terminal sessions (`terminal`)

`terminal` runs a **persistent PTY session** — a real interactive shell that stays alive between calls, so the current directory, exported variables, aliases, functions and background jobs survive. Use it for REPLs, debuggers, `ssh`, database clients, TUI programs, or any workflow that depends on shell state.

| Action | What it does |
| --- | --- |
| `open` | Starts a session and returns its `sessionId`, `pid`, cwd, shell/remote fact and startup output |
| `send` | Writes `text` (with Enter unless `submit: false`) and returns the reply |
| `read` | Reads new output without writing; `offset` re-reads from a whole-stream byte offset |
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
- **Output is bounded and honest about it.** Each session retains the last `maxBufferBytes` (default 1 MiB) of **sanitized** text and reports two facts separately: `truncated` (the session dropped output at some point) and `lossy` (the offset this read asked for had already been dropped, so the whole retained tail came back instead of a delta). ANSI escape sequences are stripped; there is no terminal emulator, so a program that redraws one line with carriage returns becomes several lines.

## Lifecycle

- **Capped, reclaimed, process-local.** `maxSessions` (default 8) refuses the next `open` by name; a session untouched by `send` / `read` / `signal` for `idleMs` (default 10 minutes) is terminated, and its id afterwards says it was reclaimed by the idle reaper rather than looking unknown. Sessions do **not** survive a `dsh` restart.
- **Sessions are not jobs.** They are not registered in `ctx.jobs`, so `job_kill` cannot reach one: `close` is the only way to end a session, with the idle reaper as the backstop.
- **`close` reports what its terminate caused.** It waits (bounded by the row's grace) for the outcome the session tree produced instead of reading `exitCode` the instant `terminate()` resolves; a force-terminated session reports exit code 1 on Windows (no signal), a natural `exit 0` reports 0.

## Sandbox and remote facts

A PTY session runs **unconfined**, and says so:

- a file sandbox wraps the argv of a spawned command; a terminal session is allocated by a different provider call, and on this host the windows-acl runner cannot start MSYS bash at all (`0xC0000142`);
- every `open` carries `unconfined: true`;
- `terminal.allowUnconfined: false` makes `open` refuse instead of running unprotected;
- a session in a remote backend (SSH) also carries `remote: true` and says so in its first line — the one fact that matters there, since the files it touches are not on this host; `unconfined` stays true beside it.

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
- the 4 s startup budget covers the first prompt, measured at roughly 0.5–0.7 s on this host (a cold first ConPTY allocation is the slow end).

Every one of these is live-editable on the row's Plugins page.
