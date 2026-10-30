/**
 * The model-facing `terminal` tool: one persistent PTY session per call series,
 * with the shell taken from the dialect registry.
 *
 * **Why one row and not one per dialect.** The other tools here are per-dialect
 * because a command is a per-call thing. A session is a host-level resource: one
 * registry, one session cap, one idle reaper, one `list`. Splitting that per
 * shell would either duplicate the registry or make `list` a lie. So the row is
 * single and its backend is still the registry — the `shell` argument enumerates
 * exactly the dialects that declare `terminal`, and each executor supplies its
 * own interactive argv (`terminalArgv()`), so adding a dialect adds a session
 * backend without touching this file.
 *
 * **What the session gives the model.** The shell is a real interactive bash
 * (`bash.exe -i`, or `wsl.exe -- bash -i`), so `cd`, `export`, `alias`, shell
 * functions and background jobs survive between calls — the whole point, and
 * something the one-shot command tools deliberately cannot do.
 *
 * **Honest boundaries, stated here because they are contract, not caveats.**
 *  - A PTY session cannot be wrapped by the file sandbox (the windows-acl runner
 *    cannot start MSYS bash at all on this host, and the terminal primitive is a
 *    different provider call than `spawn`), so a session runs UNCONFINED. Every
 *    `open` reports the two facts FLAT — `sandboxMode`, `unconfined: true` — because a
 *    session result is not one command's sandbox verdict; a deployment that
 *    cannot accept that sets the row's `allowUnconfined: false` and gets a refusal
 *    instead — for a remote backend too, because that refusal is about THIS host
 *    being unable to fence the session at all.
 *  - A session opened in a backend whose file effects are remote (the SSH dialect)
 *    also reports `remote: true` and says so in its first line: the local file
 *    sandbox governs nothing such a session touches, exactly as it governs nothing
 *    an `ssh_bash` command touches. `unconfined` stays true there as well — no PTY
 *    session is wrapped — and the PAIR is what tells the model whether the shell it
 *    is typing into is on this host or on another one.
 *  - `quiet` is output silence, not completion (a tty echoes input within
 *    milliseconds, so silence starts before the command has printed anything).
 *    The wait reason says which fact was observed.
 *  - Sessions are process-local: they do not survive a `dsh` restart. They are
 *    also NOT registered in `ctx.jobs` — `job_kill` cannot reach one; `close` is
 *    the only way to end a session, and the idle reaper is the backstop.
 * @module dsh-win-multi-bash/tool-bash/terminal
 */
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools';
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm';
import { ownExecutor } from './backend.js';
import { dialectById, terminalBackends } from './registry.js';
import { resolveSessionWorkdir, toNativeWorkdir } from './factory.js';
import {
	createTerminalSessions,
	DEFAULT_COLS,
	DEFAULT_IDLE_MS,
	DEFAULT_MAX_BUFFER_BYTES,
	DEFAULT_MAX_SESSIONS,
	DEFAULT_MAX_WAIT_MS,
	DEFAULT_QUIET_MS,
	DEFAULT_ROWS,
	DEFAULT_STARTUP_WAIT_MS,
	DEFAULT_WAIT_MS,
	TERMINAL_SIGNALS,
} from '../../terminal-session.js';

/** The dialects that can host a session, in registry order. */
const BACKENDS = terminalBackends();

/**
 * The managed `$DSH_*` facts for one call, or `undefined` when this composition
 * has no `shellEnv` service. Probed rather than injected: the facts are a
 * convenience for the child, never the reason a terminal exists.
 * @param ctx - the row's context.
 * @param exec - the tool-call execution scope the service resolves facts for.
 * @returns the facts, or undefined when the service (or its method) is absent.
 */
function collectDshEnv(ctx, exec) {
	try {
		const service = ctx.get?.('shellEnv');
		return typeof service?.collect === 'function' ? service.collect(exec) : undefined;
	}
	catch {
		return undefined;
	}
}

/**
 * The model-friendly environment overrides dsh's own bash executor applies to
 * every command. Repeated here because this row does not go through
 * `LocalBashExecutor.spawnSpec` (it spawns a PTY through the subprocess seam
 * directly), and a session whose pager blocks on `--More--` would be unusable.
 * `TERM` is deliberately NOT set: the terminal primitive advertises the terminal
 * type it actually allocated, which is more truthful than a hard-coded `dumb`.
 */
const ENV_OVERRIDES = { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' };

/** The terminal type this row requests when the provider accepts one. */
const TERMINAL_TYPE = 'xterm-256color';

const backendByName = (toolName) => BACKENDS.find((backend) => backend.toolName === toolName);
/**
 * Whether a session in this shell runs its file effects on another host.
 *
 * The dialect knows (`effects: 'remote'`), and every session result repeats the fact:
 * `open` says it in words, and `read`/`send`/`signal`/`close`/`list` carry it as data, so a
 * context that only holds a later result still knows it is typing into a remote shell.
 */
const isRemoteShell = (shell) => {
	const backend = backendByName(shell);
	return backend !== undefined && dialectById(backend.dialectId)?.effects === 'remote';
};

/**
 * The session backends as one readable list for the tool description, DERIVED so
 * a dialect that joins the registry joins this sentence too. It used to name
 * "Git Bash, WSL or MSYS2" by hand — which the SSH backend had already outgrown
 * while the `shell` enum declared right beside it was derived and did include it.
 */
const SESSION_SHELLS = BACKENDS.map((backend) => backend.label?.en ?? backend.toolName).join(', ');

/**
 * The schema one pin leaf is declared with, from the DIALECT's own declaration.
 *
 * Typed by kind on purpose: a dialect may declare a numeric or boolean leaf
 * (the SSH dialect declares both), and a `z.string()` pin for either would make
 * its own backend schema reject the value at `open` time — a broken session row
 * for a dialect that is perfectly well declared. The form already orders and
 * kinds these leaves from the same declaration (`terminalRows`), so this is the
 * schema half of one shape rather than a second list.
 * @param kind - the leaf kind the declaration states.
 * @returns the volatile field schema for that leaf.
 */
function pinSchema(kind) {
	if (kind === 'number') return z.number().volatile();
	if (kind === 'boolean') return z.boolean().volatile();
	return z.string().volatile();
}
/**
 * One pin value out of the row's resolved config partition, as a live read.
 * @param partition - the resolved partition (may be undefined before defaults).
 * @param leaf - the declared leaf name.
 * @returns the value when it is a non-empty string, or a declared number/boolean;
 *   `undefined` means "not pinned", so the dialect's own default stands.
 */
function pinValue(partition, leaf) {
	const field = partition?.[leaf];
	const value = typeof field?.get === 'function' ? field.get() : field;
	if (typeof value === 'string') return value.length > 0 ? value : undefined;
	return value;
}

/**
 * The terminal row's schema: its own knobs first, then one pin group per capable
 * dialect, in the order `terminalRows()` renders them. The audit compares this
 * schema's volatile projection with the browser half's field list position by
 * position, so a knob added in one place and not the other is a named red.
 */
const Config = z.object({
	terminal: z.object({
		defaultShell: z.union(BACKENDS.map((backend) => z.const(backend.toolName))).default(BACKENDS[0].toolName).volatile(),
		maxSessions: z.natural().default(DEFAULT_MAX_SESSIONS).volatile(),
		idleMs: z.natural().default(DEFAULT_IDLE_MS).volatile(),
		rows: z.natural().default(DEFAULT_ROWS).volatile(),
		cols: z.natural().default(DEFAULT_COLS).volatile(),
		maxBufferBytes: z.natural().default(DEFAULT_MAX_BUFFER_BYTES).volatile(),
		waitMs: z.natural().default(DEFAULT_WAIT_MS).volatile(),
		quietMs: z.natural().default(DEFAULT_QUIET_MS).volatile(),
		maxWaitMs: z.natural().default(DEFAULT_MAX_WAIT_MS).volatile(),
		allowUnconfined: z.boolean().default(true).volatile(),
	}).default({}),
	...Object.fromEntries(BACKENDS.map((backend) => {
		const declaration = dialectById(backend.dialectId);
		const pins = {};
		for (const own of declaration?.fields ?? []) pins[own.leaf] = pinSchema(own.kind);
		return [backend.configKey, z.object(pins).default({})];
	})),
});

/** Positive-integer knob guard: a stored 0 would divide a wait or a cap into nonsense. */
function positiveKnob(name, value) {
	if (!Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) throw new Error(`terminal: ${name} must be a positive whole number, got ${JSON.stringify(value)}`);
	return value;
}

/** Argument validation, by action. Named refusals only — the model reads these. */
function validateArgs(args) {
	const actions = ['open', 'send', 'read', 'signal', 'close', 'list'];
	if (typeof args.action !== 'string' || !actions.includes(args.action)) throw new Error(`terminal: "action" must be one of ${actions.join(', ')}, got ${JSON.stringify(args.action)}`);
	if (args.action !== 'open' && args.action !== 'list') {
		if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) throw new Error(`terminal: "sessionId" is required for action "${args.action}" (it is the id returned by open)`);
	}
	if (args.action === 'send' && (typeof args.text !== 'string' || args.text.length === 0)) throw new Error('terminal: "text" must be a non-empty string for action "send" (append \\n or \\r yourself for Enter)');
	if (args.action === 'signal') {
		if (typeof args.signal !== 'string' || !TERMINAL_SIGNALS.includes(args.signal)) throw new Error(`terminal: "signal" must be one of ${TERMINAL_SIGNALS.join(', ')}, got ${JSON.stringify(args.signal)}`);
	}
	if (args.shell !== undefined && backendByName(args.shell) === undefined) throw new Error(`terminal: unknown shell ${JSON.stringify(args.shell)}; this build offers ${BACKENDS.map((backend) => backend.toolName).join(', ')}`);
	if (args.offset !== undefined && (!Number.isFinite(args.offset) || args.offset < 0)) throw new Error(`terminal: "offset" must be a non-negative byte offset, got ${JSON.stringify(args.offset)}`);
	if (args.shell !== undefined && args.action !== 'open') throw new Error('terminal: "shell" is only meaningful for action "open"');
	if (args.action === 'read') {
		// `waitMs` is the one knob whose meaning differs by action: 0 is legal on read
		// (and is the default) because "do not wait" is a real request, while send and
		// signal require a positive budget. A read wait also accepts no ceiling above
		// the row's maxWaitMs — the row clamps it, so only the sign is checked here.
		// Whole milliseconds, because the wait is a poll budget: 0.5 would be accepted
		// here and then refused by the row's own positive-integer guard with a message
		// about a different knob shape.
		if (args.waitMs !== undefined && (!Number.isInteger(args.waitMs) || args.waitMs < 0)) throw new Error(`terminal: "waitMs" must be a non-negative whole number of milliseconds for action "read" (0 returns immediately), got ${JSON.stringify(args.waitMs)}`);
		if (args.all === true && args.offset !== undefined) throw new Error('terminal: "all" returns the whole retained window, so "offset" has nothing to select; pass one of them');
		if (args.all === true && args.waitMs !== undefined) throw new Error('terminal: "all" reads what is already there, so "waitMs" has nothing to wait for; pass one of them');
	}
	if (args.all !== undefined && args.action !== 'read') throw new Error('terminal: "all" is only meaningful for action "read"');
}

/** The one-line summary each result kind renders to. */
const TRUNCATION_NOTE = '[terminal: the session output buffer overflowed; the oldest output is no longer available]';
const LOSSY_NOTE = '[terminal: this read asked for an offset that had already been dropped, so it returns the whole retained tail]';
const WAIT_NOTES = {
	quiet: '[wait: output went silent — that is NOT proof the command finished; read again or raise waitMs for a long-running command]',
	timeout: '[wait: the wait reached its cap and the session is still running; read again for more]',
	session_exit: '[wait: the session exited; open a new one to continue]',
	idle: '[wait: the provider reported the shell idle]',
	no_output: '[wait: nothing new has arrived since the last read; pass waitMs to block for the next output, or all: true to read the retained window]',
};
/**
 * Render the retained text plus the facts that must not be silently dropped:
 * truncation, a lossy read, and what "the wait ended" actually meant.
 * @param output - the delta text.
 * @param facts - the read outcome.
 * @returns the model-facing text.
 */
function renderOutput(output, facts) {
	const parts = [output];
	if (facts.waitReason !== undefined && WAIT_NOTES[facts.waitReason] !== undefined) parts.push(WAIT_NOTES[facts.waitReason]);
	if (facts.lossy === true) parts.push(LOSSY_NOTE);
	if (facts.truncated === true) parts.push(TRUNCATION_NOTE);
	return parts.join('\n');
}

const tool = {
	name: 'tool-terminal',
	// `shellEnv` is probed per call, not injected: it only adds the managed
	// `$DSH_*` facts to a session's environment, and a deployment without it
	// must lose the facts rather than the terminal.
	inject: ['tools', 'subprocess', 'sandbox', 'sandboxPolicy'],
	Config,
	async apply(ctx, config = {}) {
		const warn = (message) => ctx.logger?.warn?.(message);
		/**
		 * Deliver one end-of-session notice to the agent that owns the session.
		 *
		 * A PTY can end without a tool call: the shell exits, the idle reaper closes
		 * it, or a human presses Stop in the Session header. The owner learns it
		 * in-session instead of polling. The `agents` service is probed on the root
		 * context (services are not reachable through this row's own fiber); an
		 * agent that is gone, or an inject that throws, is not the session's problem.
		 * @param event - { session, view, cause } from the registry.
		 */
		const notifySessionEnded = ({ session, cause }) => {
			let agents;
			try {
				agents = ctx.root?.get?.('agents') ?? ctx.get?.('agents');
			} catch {
				agents = undefined;
			}
			const owner = agents?.get?.(session.ownerKey);
			if (owner === undefined || owner === null) return;
			const id = JSON.stringify(session.id);
			const text = cause === 'stopped'
				? `terminal: session ${id} (${session.shell}) was stopped by the user (session header).`
				: cause === 'idle'
					? `terminal: session ${id} (${session.shell}) was closed by the idle reaper after ${session.idleMs} ms without activity.`
					: `terminal: session ${id} (${session.shell}) exited on its own${session.exitCode === undefined ? '' : ` (exit code ${session.exitCode})`}.`;
			const message = createUserMessage({
				content: [{ type: 'text', text }],
				source: { kind: 'terminal', form: 'notice', summary: `terminal session ${session.shell} ended` },
			});
			// Delivery follows the job notifier: an idle agent is WOKEN with a new turn
			// (`followup`), a busy one gets the notice steered into the turn it is
			// already running (`inject`). Injecting an idle agent only parked the
			// message in its next-turn inbox, so a Stop pressed between turns looked
			// like silence.
			const idle = typeof owner.status === 'string' && owner.status === 'idle';
			try {
				if (idle && typeof owner.followup === 'function') owner.followup(message);
				else owner.inject(message);
			} catch (error) {
				if (typeof owner.followup === 'function') owner.followup(message);
				else throw error;
			}
		};
		const sessions = createTerminalSessions(ctx, { warn: (message) => warn(message), notify: notifySessionEnded });
		// The Session header's data channel. A human surface, not a tool: the panel
		// lists every live session and may stop one, so the reason travels into the
		// tombstone a later model read reports.
		//
		// The route is registered through the ROOT context: `connection.rpc.handle`
		// registers through `webServer` on the ctx it is called with, and a tool row's
		// fiber is not where that service is reachable- calling it there threw
		// `cannot get property "webServer" without inject` (injecting `webServer` on a
		// child scope did not help; the root does). A deployment without the
		// connection service simply has no header panel.
		const registerSessionChannel = () => {
			let connection;
			try {
				connection = ctx.root?.get?.('connection');
			} catch {
				connection = undefined;
			}
			if (typeof connection?.rpc?.handle !== 'function') return;
			// Result envelope, not a throw: a thrown handler surfaces to the browser as
			// an HTTP 500 transport failure with no message, which is exactly the
			// unreadable error the panel must not show. Every failure comes back as
			// `{ ok: false, error }`, so the panel can print it in full.
			const disposeChannel = connection.rpc.handle('/win-mb', async (endpoint, payload) => {
				try {
					if (endpoint === 'sessions.list') return { ok: true, value: { sessions: sessions.listAll() } };
					if (endpoint === 'sessions.tail') {
						const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
						if (sessionId === '') return { ok: false, error: { code: 'terminal/bad-request', message: 'terminal: sessions.tail needs a sessionId', details: {} } };
						return { ok: true, value: { tail: sessions.tail(sessionId) } };
					}
					if (endpoint === 'sessions.clear') return { ok: true, value: { cleared: sessions.clearFinished() } };
					if (endpoint === 'sessions.stop') {
						const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
						if (sessionId === '') {
							return { ok: false, error: { code: 'terminal/bad-request', message: 'terminal: sessions.stop needs a sessionId', details: {} } };
						}
						return { ok: true, value: { stopped: await sessions.stop(sessionId) } };
					}
					return { ok: false, error: { code: 'terminal/unknown-endpoint', message: `terminal: unknown session endpoint ${JSON.stringify(endpoint)}`, details: {} } };
				} catch (error) {
					return { ok: false, error: { code: 'terminal/failure', message: String(error?.message ?? error), details: {} } };
				}
			});
			if (typeof disposeChannel === 'function') ctx.effect(() => () => disposeChannel(), 'dsh-win-multi-bash: terminal session channel');
		};
		// Timing and context are two different requirements: `ctx.inject` waits until
		// both services exist, while the registration itself must run on the ROOT
		// context (that is the ctx where `webServer` is reachable). Doing either
		// alone leaves the route unregistered or throws at boot.
		try {
			ctx.inject(['webServer', 'connection'], () => {
				try {
					registerSessionChannel();
				} catch (error) {
					warn(`terminal: the session header channel is unavailable: ${String(error?.message ?? error)}`);
				}
			});
		} catch (error) {
			warn(`terminal: the session header channel is unavailable: ${String(error?.message ?? error)}`);
		}
		/** Lazily built per-dialect backends, keyed by dialect id, each on its own fiber. */
		const backends = new Map();
		ctx.effect(() => () => {
			for (const entry of backends.values()) {
				try {
					entry.fiber?.dispose?.();
				} catch (error) {
					warn(`terminal: disposing the ${entry.dialectId} backend failed: ${String(error?.message ?? error)}`);
				}
			}
			backends.clear();
			return sessions.dispose();
		});
		/**
		 * The executor owning one dialect's session mechanics, built on first use.
		 *
		 * Built through `ownExecutor` like every other tool row here, so the
		 * executor registers under an isolated `shell` scope and never contends for
		 * the seat. Its config is the dialect's OWN schema seeded with this row's
		 * pins, so an installed-elsewhere shell can be pointed at without touching
		 * the command tool's row.
		 */
		const backendFor = async (toolName) => {
			const declaration = backendByName(toolName);
			if (declaration === undefined) throw new Error(`terminal: shell ${JSON.stringify(toolName)} is not offered by this build`);
			const dialect = dialectById(declaration.dialectId);
			const existing = backends.get(dialect.id);
			if (existing !== undefined) return existing;
			const module = await import(new URL(dialect.executor.module, import.meta.url));
			const Executor = module[dialect.executor.export];
			if (typeof Executor !== 'function') throw new Error(`terminal: dialect "${dialect.id}" declares executor ${dialect.executor.module}#${dialect.executor.export}, which is not a constructor`);
			const pins = {};
			const partition = config[dialect.configKey];
			for (const own of dialect.fields ?? []) {
				const value = pinValue(partition, own.leaf);
				if (value !== undefined) pins[own.leaf] = value;
			}
			const { executor, fiber } = ownExecutor(ctx, Executor, Executor.Config(pins));
			const entry = { dialectId: dialect.id, toolName, executor, fiber };
			backends.set(dialect.id, entry);
			return entry;
		};
		/**
		 * This row's live knobs, read at use time so a saved value applies at once.
		 * RAW: validation happens where a knob is actually used, because a stored 0
		 * in a geometry knob must not make `list` or `close` fail — an unrelated
		 * action failing is a worse outcome than the one broken knob.
		 */
		const knobs = () => ({
			defaultShell: config.terminal.defaultShell.get(),
			maxSessions: config.terminal.maxSessions.get(),
			idleMs: config.terminal.idleMs.get(),
			rows: config.terminal.rows.get(),
			cols: config.terminal.cols.get(),
			maxBufferBytes: config.terminal.maxBufferBytes.get(),
			waitMs: config.terminal.waitMs.get(),
			quietMs: config.terminal.quietMs.get(),
			maxWaitMs: config.terminal.maxWaitMs.get(),
			allowUnconfined: config.terminal.allowUnconfined.get() === true,
		});
		/** The wait shape one send/signal needs, validated on use. */
		const waitShape = (limits, requested) => {
			const maxWaitMs = positiveKnob('terminal.maxWaitMs', limits.maxWaitMs);
			const waitMs = requested === undefined ? positiveKnob('terminal.waitMs', limits.waitMs) : Math.min(positiveKnob('waitMs', requested), maxWaitMs);
			return { waitMs, quietMs: positiveKnob('terminal.quietMs', limits.quietMs) };
		};
		/**
		 * Turn the registry's own abort into the cancellation the host expects.
		 *
		 * The session layer is substrate and is tested without `dsh-llm`, so it names the
		 * condition `ABORTED`; this row maps it to the same shape the bash row throws for
		 * an aborted wait, so a cancelled call ends as a cancellation instead of a tool error.
		 * @param work - one registry call that may block on a long wait.
		 * @returns whatever the call returned.
		 */
		const guardAbort = async (work) => {
			try {
				return await work();
			} catch (error) {
				if (error?.code !== 'ABORTED') throw error;
				const aborted = new HarnessError('tool call aborted', TOOL_ABORTED);
				aborted.name = 'AbortError';
				throw aborted;
			}
		};
		/** The calling agent's fence: sessions are reachable only by their opener. */
		const ownerKeyOf = (exec) => exec.agent?.id ?? '';
		ctx.tools.register(defineTool({
			name: 'terminal',
			description: 'Run an interactive PTY session in any shell this plugin registers as a session backend (' + SESSION_SHELLS + ' in this composition). The shell stays alive between calls, so the current directory, exported variables, aliases, functions and background jobs all persist for the session — use this for REPLs, debuggers, interactive prompts or any work that depends on shell state across calls. Actions: open (start a session, returns its id), send (write input, then read the reply), read (read new output without writing; pass waitMs to block for the next output, or all: true to read the retained scrollback), signal (deliver one of ' + TERMINAL_SIGNALS.join('/') + ' to the foreground process; on this platform only SIGINT reaches the shell — SIGTERM and SIGKILL are refused by name instead of silently reaching nothing), close (terminate the session), list (the sessions you own). A wait reason of quiet means the output went SILENT, not that the command finished: read again for a long command. Sessions are process-local (they do not survive a dsh restart), bounded by a session cap, reclaimed after an idle period, and are NOT jobs — end one with action close. A PTY session cannot be file-sandboxed, so it runs unconfined (each open says so).',
			parameters: {
				action: {
					type: 'string',
					enum: ['open', 'send', 'read', 'signal', 'close', 'list'],
					required: true,
					description: 'open: create a session and return its id. send: write input and read the reply. read: read new output without writing (waitMs blocks for the next output; all reads the retained window). signal: signal the foreground process group. close: terminate the session. list: list the sessions you own.',
				},
				sessionId: { type: 'string', description: 'Session id returned by open; required for send/read/signal/close.' },
				shell: { type: 'string', enum: BACKENDS.map((backend) => backend.toolName), description: `Which shell to open (open only). Defaults to this row's defaultShell (currently ${BACKENDS[0].toolName}).` },
				name: { type: 'string', description: 'Optional owner-local label for the session (open only), e.g. "gdb" or "repl".' },
				cwd: { type: 'string', description: 'Working directory for the session (open only). Defaults to the session workspace; a relative path resolves against it.' },
				text: { type: 'string', description: 'With action send: the input to write. No newline is added unless submit is true.' },
				submit: { type: 'boolean', description: 'With action send: append Enter (a carriage return) to the input. Defaults to true.' },
				signal: { type: 'string', enum: TERMINAL_SIGNALS, description: 'With action signal: the signal for the foreground process group (SIGINT is Ctrl+C).' },
				offset: { type: 'number', description: 'With action read: a whole-stream byte offset to read from (the previous result\'s nextOffset). Omit to read output produced since the last read.' },
				waitMs: { type: 'number', description: 'How long to wait for output to settle before returning (send/signal). With action read: how long to wait for NEW output before returning; 0 (the default) returns immediately. The row clamps it to its maxWaitMs.' },
				all: { type: 'boolean', description: 'With action read: return the WHOLE retained output window (the session scrollback) instead of only what arrived since the last read. It does not move the read cursor, and it cannot be combined with offset or waitMs.' },
				idleMs: { type: 'number', description: 'Idle timeout for this session in ms (open only): it is terminated after this long without a send/read/signal. Defaults to the row\'s idleMs.' },
				rows: { type: 'number', description: 'Terminal rows (open, or a resize before a send).' },
				cols: { type: 'number', description: 'Terminal columns (open, or a resize before a send).' },
			},
			output: {
				schema: {
					oneOf: [
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								kind: { type: 'string', required: true, const: 'open' },
								sessionId: { type: 'string', required: true },
								shell: { type: 'string', required: true },
								pid: { type: 'integer', required: true },
								cwd: { type: 'string', required: true },
								sandboxMode: { type: 'string', required: true },
								unconfined: { type: 'boolean', required: true },
								remote: { type: 'boolean', required: true },
								output: { type: 'string', required: true },
								truncated: { type: 'boolean', required: true },
								lossy: { type: 'boolean', required: true },
								nextOffset: { type: 'integer', required: true },
								waitReason: { type: 'string' },
							},
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								kind: { type: 'string', required: true, const: 'session' },
								// Which shell this session belongs to, and whether its file effects are on
								// ANOTHER host: `open` says so once, but a resumed context only holds the
								// results it is looking at, so every session result repeats both facts.
								shell: { type: 'string', required: true },
								remote: { type: 'boolean', required: true },
								output: { type: 'string', required: true },
								truncated: { type: 'boolean', required: true },
								lossy: { type: 'boolean', required: true },
								nextOffset: { type: 'integer', required: true },
								waitReason: { type: 'string' },
								delivered: { type: 'integer' },
							},
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								kind: { type: 'string', required: true, const: 'closed' },
								sessionId: { type: 'string', required: true },
								shell: { type: 'string', required: true },
								remote: { type: 'boolean', required: true },
								exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
								signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
								output: { type: 'string', required: true },
								truncated: { type: 'boolean', required: true },
							},
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								kind: { type: 'string', required: true, const: 'list' },
								sessions: {
									type: 'array',
									items: {
										type: 'object',
										additionalProperties: false,
										properties: {
											sessionId: { type: 'string', required: true },
											shell: { type: 'string', required: true },
											remote: { type: 'boolean', required: true },
											status: { type: 'string', required: true },
											pid: { type: 'integer', required: true },
											cwd: { type: 'string', required: true },
											idleMs: { type: 'number', required: true },
											retainedBytes: { type: 'integer', required: true },
											truncated: { type: 'boolean', required: true },
											// Why a finished session ended, for the resuming model: absent while it runs.
											endedReason: { type: 'string' },
											exitCode: { type: 'integer' },
										},
									},
								},
							},
						},
					],
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.kind === 'open'
						? `terminal session ${value.sessionId} (${value.shell}, pid ${value.pid}, cwd ${value.cwd}) — ${value.remote === true
							? 'remote: this session runs on the host its backend connects to, so the local file sandbox governs nothing here (a PTY session is not wrapped on this host either)'
							: 'unconfined: the file sandbox does not wrap a PTY session'}\n${renderOutput(value.output, value)}`
						: value.kind === 'closed'
							? `terminal session ${value.sessionId} closed (exit code ${String(value.exitCode)}${value.signal === null ? '' : `, signal ${value.signal}`})${value.output.length > 0 ? `\n${value.output}` : ''}${value.truncated ? `\n${TRUNCATION_NOTE}` : ''}`
							: value.kind === 'list'
								? value.sessions.length === 0
									? 'no terminal sessions are open'
									: value.sessions.map((session) => `${session.sessionId} ${session.shell} ${session.status}${session.endedReason === undefined ? '' : ` ended ${session.endedReason}`}${session.exitCode === undefined ? '' : ` (exit ${session.exitCode})`} pid ${session.pid} cwd ${session.cwd} retained ${session.retainedBytes}B${session.truncated ? ' (truncated)' : ''}`).join('\n')
								: renderOutput(value.output, value),
				}],
			},
			async execute(args, exec) {
				validateArgs(args);
				if (exec.signal.aborted) {
					const error = new HarnessError('tool call aborted', TOOL_ABORTED);
					error.name = 'AbortError';
					throw error;
				}
				const ownerKey = ownerKeyOf(exec);
				const limits = knobs();
				if (args.action === 'list') {
					// Projected to exactly the declared fields on purpose: the output
					// schema is `additionalProperties: false`, so an extra key here does
					// not leak — it makes the runtime DROP the whole value and the model
					// sees a result with no structured body at all. The audit's state test
					// reads `value.kind`, which is what caught that.
					return {
						kind: 'list',
						sessions: sessions.list(ownerKey).map((session) => ({
							sessionId: session.sessionId,
							shell: session.shell,
							remote: isRemoteShell(session.shell),
							status: session.status,
							pid: session.pid,
							cwd: session.cwd,
							idleMs: session.idleMs,
							retainedBytes: session.retainedBytes,
							truncated: session.truncated,
							...(typeof session.endedReason === 'string' ? { endedReason: session.endedReason } : {}),
							...(typeof session.exitCode === 'number' ? { exitCode: session.exitCode } : {}),
						})),
					};
				}
				if (args.action === 'read') {
					// A positive waitMs blocks until NEW output arrives or the budget ends, so
					// a poll during a long command is one call instead of an instant empty
					// snapshot. `all` is the unconditional form and never waits.
					const waitMs = args.all === true || args.waitMs === undefined
						? 0
						: (args.waitMs === 0 ? 0 : Math.min(positiveKnob('waitMs', args.waitMs), positiveKnob('terminal.maxWaitMs', limits.maxWaitMs)));
					const result = await guardAbort(() => sessions.read({ ownerKey, sessionId: args.sessionId, offset: args.offset, all: args.all === true, waitMs, abortSignal: exec.signal }));
					return {
						kind: 'session',
						shell: result.shell,
						remote: isRemoteShell(result.shell),
						output: result.text,
						truncated: result.truncated,
						lossy: result.lossy,
						nextOffset: result.nextOffset,
						...(result.waitReason === undefined ? {} : { waitReason: result.waitReason }),
					};
				}
				if (args.action === 'send') {
					const { waitMs, quietMs } = waitShape(limits, args.waitMs);
					const result = await guardAbort(() => sessions.send({ ownerKey, sessionId: args.sessionId, text: args.text, submit: args.submit, rows: args.rows, cols: args.cols, waitMs, quietMs, abortSignal: exec.signal }));
					return { kind: 'session', shell: result.shell, remote: isRemoteShell(result.shell), output: result.text, truncated: result.truncated, lossy: result.lossy, nextOffset: result.nextOffset, waitReason: result.waitReason };
				}
				if (args.action === 'signal') {
					const { waitMs, quietMs } = waitShape(limits, args.waitMs);
					const result = await guardAbort(() => sessions.signal({ ownerKey, sessionId: args.sessionId, signal: args.signal, waitMs, quietMs, abortSignal: exec.signal }));
					return { kind: 'session', shell: result.shell, remote: isRemoteShell(result.shell), output: result.text, truncated: result.truncated, lossy: result.lossy, nextOffset: result.nextOffset, waitReason: result.waitReason, delivered: result.delivered };
				}
				if (args.action === 'close') {
					const result = await sessions.close({ ownerKey, sessionId: args.sessionId });
					return { kind: 'closed', sessionId: result.sessionId, shell: result.shell, remote: isRemoteShell(result.shell), exitCode: result.exitCode ?? null, signal: result.signal ?? null, output: result.output, truncated: result.truncated };
				}
				// open
				const shell = args.shell ?? limits.defaultShell;
				const standingPolicy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
				if (!limits.allowUnconfined) {
					throw new Error('terminal: this row has allowUnconfined: false, and a PTY session cannot be file-sandboxed, so it refuses to open one. Set terminal.allowUnconfined: true on this row to accept unconfined sessions.');
				}
				const { executor, dialectId } = await backendFor(shell);
				const sessionCwd = await resolveSessionWorkdir(ctx, exec, standingPolicy?.workspaceRoot);
				const cwd = args.cwd === undefined
					? (sessionCwd ?? process.cwd())
					: (sessionCwd !== undefined && !isAbsolute(args.cwd) ? resolvePath(sessionCwd, args.cwd) : toNativeWorkdir(args.cwd));
				const argv = executor.terminalArgv({ workdir: cwd });
				const dshEnv = collectDshEnv(ctx, exec);
				const resolved = executor.resolve({ command: '', env: { ...ENV_OVERRIDES, ...dshEnv } });
				const env = { ...(resolved.env ?? ENV_OVERRIDES) };
				// WSL only: WSLENV is how a Windows-side variable actually crosses into
				// the distro; without it the $DSH_* facts the harness advertises would
				// silently not exist inside the session.
				if (dialectById(dialectId)?.argvStyle === 'wsl') {
					const names = Object.keys(dshEnv ?? {});
					if (names.length > 0) env.WSLENV = [env.WSLENV, ...names].filter((value) => typeof value === 'string' && value.length > 0).join(':');
				}
				const { waitMs, quietMs } = waitShape(limits, args.waitMs);
				const opened = await sessions.open({
					id: randomUUID(),
					ownerKey,
					shell,
					name: args.name,
					argv,
					cwd,
					env,
					rows: args.rows === undefined ? positiveKnob('terminal.rows', limits.rows) : positiveKnob('rows', args.rows),
					cols: args.cols === undefined ? positiveKnob('terminal.cols', limits.cols) : positiveKnob('cols', args.cols),
					terminalType: TERMINAL_TYPE,
					graceMs: 3000,
					idleMs: args.idleMs === undefined ? positiveKnob('terminal.idleMs', limits.idleMs) : positiveKnob('idleMs', args.idleMs),
					maxSessions: positiveKnob('terminal.maxSessions', limits.maxSessions),
					maxBufferBytes: positiveKnob('terminal.maxBufferBytes', limits.maxBufferBytes),
					waitMs,
					quietMs,
					startupWaitMs: DEFAULT_STARTUP_WAIT_MS,
					signal: exec.signal,
				});
				const first = await sessions.read({ ownerKey, sessionId: opened.session.id });
				return {
					kind: 'open',
					// Reported, never hidden: a start that hit the budget is an empty
					// reply plus this reason, so an empty session is never mistaken for
					// a broken one — the prompt simply had not arrived yet.
					waitReason: opened.startupWaitReason,
					sessionId: opened.session.id,
					shell,
					pid: opened.view.pid,
					cwd: opened.view.cwd,
					sandboxMode: standingPolicy?.mode ?? 'unknown',
					// Both facts are observed and they answer different questions: no PTY
					// session is wrapped on this host (`unconfined`), and this one's file
					// effects are not on this host at all (`remote`) when its backend says so.
					unconfined: true,
					remote: dialectById(dialectId)?.effects === 'remote',
					output: first.text,
					truncated: first.truncated,
					lossy: first.lossy,
					nextOffset: first.nextOffset,
				};
			},
			presentCall: (args) => ({
				card: 'terminal',
				title: `terminal ${args.action}${args.sessionId === undefined ? '' : ` ${args.sessionId}`}`,
				...args.text === undefined ? {} : { description: args.text },
				...args.cwd === undefined ? {} : { cwd: args.cwd },
			}),
		}));
	},
};
export const name = tool.name;
export const inject = tool.inject;
export { Config };
export const apply = tool.apply;
