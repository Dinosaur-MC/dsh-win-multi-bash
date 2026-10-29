/**
 * The mechanism half of the interactive `terminal` tool: a PTY-backed session
 * registry over `ctx.subprocess.spawnTerminal`, its bounded output ring, and the
 * one readiness contract Windows actually supports.
 *
 * Why this is a separate module from the tool row (`./tool-bash/types/terminal.js`):
 * the row owns the model-facing contract (six actions, schema, rendering, the
 * dialect backend) while everything here is substrate behaviour that can be unit
 * tested against a fake handle — the same split `shell-executor.js` gives the
 * bash tools.
 *
 * Three facts this module is built around, all measured on a win32 host
 * (2026-10-16, `dsh-subprocess-local@0.2.0-rc.2`, Git Bash, real ConPTY):
 *
 *  - **`inspectActivity()` is always `unknown` on win32.** The provider refuses
 *    `shellActivity` for `platform === 'win32'`, so a readiness wait gated on it
 *    would never settle. It is therefore an *optional fast path*: a provider that
 *    can positively answer `idle` settles early, one that answers `busy` is
 *    believed and keeps waiting, and `unknown`/absent falls back to output
 *    silence. Silence is a fact; "the command finished" is not, and the returned
 *    `waitReason` says which one was observed.
 *  - **Input echo makes silence ambiguous.** The tty echoes what was written
 *    within ~10 ms, so a quiet window starts immediately even for a command that
 *    has not printed anything yet (`sleep 30` returns the echo and then nothing).
 *    A quiet threshold must therefore sit comfortably above the largest
 *    *between-chunk* gap ordinary commands produce — measured 216 ms worst case
 *    over 18 runs, so {@link DEFAULT_QUIET_MS} is 500 ms.
 *  - **The session is a process, not a call.** `cd`, `export`, `alias` and
 *    functions survive because one interactive shell lives for the whole session;
 *    the price is that the output is a *stream*, so this module owns scrollback
 *    retention, truncation reporting, and idle reclamation rather than handing
 *    that to a per-call collector.
 *
 * The module deliberately adds **no runtime dependency**: the terminal primitive
 * and its `node-pty` substrate belong to `ctx.subprocess`, which every standard
 * deployment already composes.
 * @module dsh-win-multi-bash/terminal-session
 */
import { randomUUID } from 'node:crypto';

/** The terminal signals the subprocess seam exposes; the tool declares exactly these. */
export const TERMINAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'];

/** Default gap of output silence that ends a wait, comfortably above the measured 216 ms. */
export const DEFAULT_QUIET_MS = 500;
/** Default ceiling on one wait: a call holds here and hands the model partial output. */
export const DEFAULT_WAIT_MS = 10_000;
/** Default retention per session (1 MiB): `seq 1 200000` measured 1.42 MiB, so it reports truncation. */
export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
/** Default idle reclamation: a session nobody touches is terminated (matches the upstream tool). */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** Default concurrent sessions; eight PTY shells cost ~40 ms and a trivial RSS each (measured). */
export const DEFAULT_MAX_SESSIONS = 8;
/** Default terminal geometry. 110 columns is wide enough that ordinary output does not wrap. */
export const DEFAULT_ROWS = 30;
export const DEFAULT_COLS = 110;
/** Default ceiling a caller may ask for with `waitMs`: a call never holds longer than this. */
export const DEFAULT_MAX_WAIT_MS = 120_000;
/**
 * How long `open` waits for the shell's first prompt.
 *
 * Measured on this host (2026-10-30): a bare `bash -i` prints its prompt in
 * ~0.8 s, but a SESSION loads the user's own startup files, and this repository's
 * prompt runs git — the first prompt then landed at ~4.0 s, exactly on the old
 * 4 s budget, so every `open` paid it in full and reported `timeout`. Ten
 * seconds leaves room for that: a wait still ends on silence (quiet) long before
 * the cap, and a shell that prints nothing at all is REPORTED
 * (`waitReason: 'timeout'`) rather than presented as an empty session.
 */
export const DEFAULT_STARTUP_WAIT_MS = 10000;

/** Largest number of reclaimed session ids kept as tombstones, so a stale id explains itself. */
const TOMBSTONE_LIMIT = 16;
/** How many ended sessions keep their ring readable before the oldest is evicted. */
const FINISHED_LIMIT = 8;
/** How much of the retained window `tail` answers: the panel's expanded view, not a download. */
const TAIL_CHARS = 64 * 1024;
/** Output-wait poll interval: cheap enough to run per wait, fast enough not to add latency. */
const POLL_MS = 50;
/**
 * How long `close` waits (at most) for the terminator's outcome to be published.
 * The tool row sends its own `graceMs`; this is the floor for a caller that sends none.
 */
const DEFAULT_GRACE_MS = 1000;
/** Longest single retained chunk (characters). Small chunks keep trimming and offsetting bounded. */
const COALESCE_UNITS = 8192;
/** Longest unterminated escape sequence carried across chunks before it is discarded. */
const MAX_PENDING_ESCAPE_UNITS = 4096;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One terminal-session failure. Every message names what the caller can do about it. */
class TerminalSessionError extends Error {
	/**
	 * @param message - actionable sentence, already prefixed with `terminal:`.
	 * @param code - stable machine-routable tag (`NO_SESSION`, `FOREIGN_SESSION`, …).
	 */
	constructor(message, code) {
		super(message);
		this.name = 'TerminalSessionError';
		this.code = code;
	}
}

/**
 * Split printable text into bounded chunks without ever cutting a surrogate pair.
 *
 * Chunking is what keeps the ring's offset maths and eviction loop cheap: a single
 * 1.4 MiB `seq` write becomes ~180 chunks instead of one node whose head-slice
 * would cost a per-character byte count every eviction.
 * @param text - the text to split.
 * @returns chunks of at most {@link COALESCE_UNITS} UTF-16 units.
 */
function splitChunks(text) {
	const chunks = [];
	let index = 0;
	while (index < text.length) {
		let end = Math.min(text.length, index + COALESCE_UNITS);
		if (end < text.length) {
			const last = text.charCodeAt(end - 1);
			const next = text.charCodeAt(end);
			// Never split a surrogate pair: extend the chunk by the low surrogate.
			if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;
		}
		chunks.push(text.slice(index, end));
		index = end;
	}
	return chunks;
}

/**
 * One session's retained output, addressed by whole-stream byte offsets.
 *
 * Byte offsets (not characters) are the cursor because they are what
 * `ctx.jobs`/`ctx.subprocess` already use, so a caller that also reads a shell job
 * sees one coordinate system. Retention drops the OLDEST output, and the two
 * consequences are reported separately:
 *  - `truncated` — this session has dropped output at some point (a latch), so the
 *    retained window is not the whole story;
 *  - `lossy` — the offset THIS read asked for had already slid out of the window,
 *    so what came back is the whole retained tail rather than a true delta.
 * Merging them into one boolean would tell the model less than the runtime knows.
 */
export class OutputRing {
	/** @param maxBytes - retention ceiling in bytes. */
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
		this.chunks = [];
		this.totalBytes = 0;
		this.retainedBytes = 0;
		this.dropped = false;
	}
	/** Whether any output has been dropped from the retained window. */
	get truncated() {
		return this.dropped;
	}
	/** Whole-stream byte offset just past the newest retained byte. */
	get nextOffset() {
		return this.totalBytes;
	}
	/**
	 * Append already-sanitized printable text.
	 * @param text - text to retain.
	 */
	append(text) {
		if (text.length === 0) return;
		// One running offset: each pushed chunk records where its FIRST byte sits in the
		// whole stream, and `totalBytes` only advances after that record is taken.
		for (const piece of splitChunks(text)) {
			const bytes = Buffer.byteLength(piece);
			const tail = this.chunks[this.chunks.length - 1];
			if (tail !== undefined && tail.text.length + piece.length <= COALESCE_UNITS) tail.text += piece;
			else this.chunks.push({ text: piece, start: this.totalBytes });
			this.totalBytes += bytes;
			this.retainedBytes += bytes;
		}
		this.#trim();
	}
	/** Drop oldest output until the retained window fits. Never throws on an empty ring. */
	#trim() {
		while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
			const head = this.chunks[0];
			const headBytes = Buffer.byteLength(head.text);
			const excess = this.retainedBytes - this.maxBytes;
			if (headBytes <= excess) {
				this.chunks.shift();
				this.retainedBytes -= headBytes;
				this.dropped = true;
				continue;
			}
			let units = 0;
			let droppedBytes = 0;
			while (units < head.text.length && droppedBytes < excess) {
				const code = head.text.codePointAt(units);
				const width = code > 0xffff ? 2 : 1;
				droppedBytes += Buffer.byteLength(head.text.slice(units, units + width));
				units += width;
			}
			head.text = head.text.slice(units);
			head.start += droppedBytes;
			this.retainedBytes -= droppedBytes;
			this.dropped = true;
		}
		if (this.chunks.length === 0) this.retainedBytes = 0;
	}
	/**
	 * Read everything since a whole-stream byte offset.
	 * @param offset - whole-stream byte offset (0 for the first read).
	 * @returns the delta text, the offset to resume from, and both loss facts.
	 */
	readFrom(offset) {
		const windowStart = this.chunks.length === 0 ? this.totalBytes : this.chunks[0].start;
		if (offset >= this.totalBytes) return { text: '', nextOffset: this.totalBytes, truncated: this.dropped, lossy: false };
		const lossy = offset < windowStart;
		let from = lossy ? windowStart : offset;
		let text = '';
		let started = lossy;
		for (const chunk of this.chunks) {
			const chunkBytes = Buffer.byteLength(chunk.text);
			if (!started) {
				if (from >= chunk.start + chunkBytes) continue;
				if (from > chunk.start) {
					let units = 0;
					let seen = 0;
					while (units < chunk.text.length && seen < from - chunk.start) {
						const code = chunk.text.codePointAt(units);
						const width = code > 0xffff ? 2 : 1;
						seen += Buffer.byteLength(chunk.text.slice(units, units + width));
						units += width;
					}
					text += chunk.text.slice(units);
				} else text += chunk.text;
				started = true;
				continue;
			}
			text += chunk.text;
		}
		return { text, nextOffset: this.totalBytes, truncated: this.dropped, lossy };
	}
	/** The whole retained window without moving any cursor (list/diagnostics). */
	snapshot() {
		return { text: this.chunks.map((chunk) => chunk.text).join(''), truncated: this.dropped, bytes: this.retainedBytes };
	}
}

/**
 * Turn a raw terminal byte stream into the line-oriented text a model can read.
 *
 * A real terminal answers this with an emulator; this module cannot add one (no
 * new runtime dependency), so it does the part that is decidable without a screen:
 * drop escape sequences, keep the printable text, and normalize line endings. The
 * known cost is stated rather than hidden — a program that redraws one line with
 * carriage returns becomes several lines, because `\r` is normalized instead of
 * being applied as a cursor move. Retention still bounds the damage.
 *
 * Sequences split across reads are carried in a bounded pending buffer, so an
 * escape that arrives in two chunks is not mistaken for printable text.
 */
export class TerminalSanitizer {
	/** @param maxPendingUnits - carry ceiling; a runaway escape is dropped, not accumulated. */
	constructor(maxPendingUnits = MAX_PENDING_ESCAPE_UNITS) {
		this.maxPendingUnits = maxPendingUnits;
		this.pending = '';
		/** A chunk that ended on the CR of a CRLF pair; the LF comes next chunk. */
		this.pendingCr = false;
		/** The previous emitted text ended on a line break. */
		this.afterBreak = false;
	}
	/**
	 * Consume one decoded chunk.
	 * @param chunk - decoded terminal text.
	 * @returns the printable text this chunk completed.
	 */
	push(chunk) {
		this.pending += (this.pendingCr ? '\r' : '') + chunk;
		this.pendingCr = false;
		let printable = '';
		let index = 0;
		while (index < this.pending.length) {
			const escape = this.pending.indexOf('\u001b', index);
			if (escape === -1) {
				printable += this.pending.slice(index);
				index = this.pending.length;
				break;
			}
			printable += this.pending.slice(index, escape);
			const consumed = this.#escapeLength(escape);
			if (consumed === undefined) {
				index = escape;
				break;
			}
			index = escape + consumed;
		}
		this.pending = this.pending.slice(index);
		if (this.pending.length > this.maxPendingUnits) this.pending = '';
		// A CRLF that straddles two chunks must become ONE break. Emitting the CR
		// as a newline here and the LF as another one is what put a blank line
		// after every echoed command.
		let text = printable;
		// The same cursor-return rule, for a CR that opens this chunk.
		if (this.afterBreak && text.startsWith('\r') && text[1] !== '\n') text = text.slice(1);
		text = text.replace(/(\n)\r(?=[^\n])/g, '$1');
		if (text.endsWith('\r')) {
			text = text.slice(0, -1);
			this.pendingCr = true;
		}
		const normalized = normalizeTerminalText(text);
		this.afterBreak = normalized.endsWith('\n');
		return { text: normalized };
	}
	/**
	 * Flush at terminal end.
	 * @returns the trailing printable text; an unterminated escape is discarded.
	 */
	flush() {
		// A half-written sequence at the end is not text: cut at its ESC, so a session
		// killed mid-write does not end with fragments like "[3".
		const lastEscape = this.pending.lastIndexOf('\u001b');
		const printable = lastEscape === -1 ? this.pending : this.pending.slice(0, lastEscape);
		const text = printable + (this.pendingCr ? '\r' : '');
		this.pending = '';
		this.pendingCr = false;
		return { text: normalizeTerminalText(text) };
	}
	/**
	 * Length of the escape sequence starting at `index`, or `undefined` when it is
	 * not complete in the buffer yet (caller keeps it pending).
	 * @param index - index of the ESC character.
	 * @returns consumed UTF-16 units, or undefined for "incomplete".
	 */
	#escapeLength(index) {
		const kind = this.pending[index + 1];
		if (kind === undefined) return undefined;
		if (kind === '[') {
			let end = index + 2;
			while (end < this.pending.length) {
				const code = this.pending.charCodeAt(end);
				// CSI parameter/intermediate bytes are 0x20-0x3F; a final byte is 0x40-0x7E.
				if (code >= 0x40 && code <= 0x7e) return end + 1 - index;
				end += 1;
			}
			return undefined;
		}
		if (kind === ']') {
			let end = index + 2;
			while (end < this.pending.length) {
				if (this.pending[end] === '\u0007') return end + 1 - index;
				if (this.pending[end] === '\u001b' && this.pending[end + 1] === '\\') return end + 2 - index;
				end += 1;
			}
			return undefined;
		}
		// Charset designation (ESC ( 0, ESC ) A, …) carries one more byte.
		if (kind === '(' || kind === ')' || kind === '*' || kind === '+' || kind === '#' || kind === '%') {
			if (this.pending[index + 2] === undefined) return undefined;
			return 3;
		}
		return 2;
	}
}

/**
 * Normalize one printable run for line-oriented reading.
 * @param text - text with escape sequences already removed.
 * @returns text with CRLF/CR normalized, BEL and other C0 controls dropped.
 */
export function normalizeTerminalText(text) {
	return text
		// A run of CRs before the LF is one line break: ConPTY emits the Enter echo
		// as CR CR LF on this host, and a plain CRLF replace left a phantom blank
		// line after every echoed command.
		.replace(/\r+\n/g, '\n')
		// A CR at the start of a line with no LF after it is a cursor return: the
		// shell sends one before every command's output, and turning it into a
		// break is what put a blank line between the echo and the result.
		.replace(/(\n)\r(?=[^\n])/g, '$1')
		.replaceAll('\r', '\n')
		.replaceAll('\u0007', '')
		// Keep tab and newline; drop the remaining C0 controls and DEL.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * Build the session registry one `terminal` row owns.
 *
 * Ownership is fenced by the calling agent, mirroring the rest of the runtime: a
 * session is reachable only by the agent that opened it, and `list` returns only
 * that agent's sessions.
 * @param ctx - a context with the `subprocess` service (the row injects it).
 * @param options - the host-side hooks the caller supplies.
 * @param options.warn - optional logger sink for reclamation and teardown failures.
 * @returns the registry: open/send/read/signal/close/list/dispose.
 */
export function createTerminalSessions(ctx, options = {}) {
	const warn = typeof options.warn === 'function' ? options.warn : () => {};
	/**
	 * One end-of-session notice, delivered at most once.
	 *
	 * The model is not watching a PTY: a shell can die on its own, the idle
	 * reaper can close it, and the Session header can stop it. Each of those is
	 * news the owning agent should read in-session rather than discover by
	 * polling `list`. The callback is supplied by the row, which knows how to
	 * reach the owning agent; a throw here can never fail the close itself.
	 */
	const notify = typeof options.notify === 'function' ? options.notify : () => {};
	/** Live sessions by id, in publication order. */
	const sessions = new Map();
	/** Set by `dispose`, so an open still awaiting its spawn cannot outlive the row. */
	let disposed = false;
/** Opens that have started but are not published yet (see `open`). */
	let opening = 0;
	/** Reclaimed/closed ids, so a stale id answers with why instead of "unknown". */
	const tombstones = new Map();
	/**
	 * Ended sessions kept readable, in ending order.
	 *
	 * A session that ends is still history: its ring holds the last output and the
	 * Session header's finished section expands from it. Retention is bounded; an
	 * evicted id degrades to a tombstone carrying the reason.
	 */
	const finished = new Map();
	const retainedBytes = (session) => (typeof session.ring.retainedBytes === 'number' ? session.ring.retainedBytes : 0);
	const retainFinished = (session, reason) => {
		session.finishedReason = reason;
		// The end time the panel shows: a finished row's elapsed must stop here.
		session.lastActiveAt = Date.now();
		session.cursor = session.ring.nextOffset;
		finished.set(session.id, session);
		while (finished.size > FINISHED_LIMIT) {
			const oldest = finished.keys().next().value;
			finished.delete(oldest);
			remember(oldest, 'finished session evicted (retention limit)');
		}
	};

	const remember = (id, reason) => {
		tombstones.set(id, { reason, at: Date.now() });
		while (tombstones.size > TOMBSTONE_LIMIT) tombstones.delete(tombstones.keys().next().value);
	};
	const endedError = (id) => {
		const done = finished.get(id);
		const grave = done === undefined ? tombstones.get(id) : { reason: done.finishedReason ?? 'ended' };
		return new TerminalSessionError(
			grave === undefined
				? `terminal: no session ${JSON.stringify(id)}. Open one with action "open", or list the sessions you own.`
				: `terminal: session ${JSON.stringify(id)} is gone — ${grave.reason}. Open a new session.`,
			grave === undefined ? 'NO_SESSION' : 'SESSION_GONE',
		);
	};
	/** The readable session: live first, then one kept after it ended. */
	const requireReadable = (ownerKey, id) => {
		const session = sessions.get(id) ?? finished.get(id);
		if (session === undefined) throw endedError(id);
		if (session.ownerKey !== ownerKey) throw new TerminalSessionError(`terminal: session ${JSON.stringify(id)} belongs to another agent`, 'FOREIGN_SESSION');
		return session;
	};
	const require = (ownerKey, id) => {
		const session = sessions.get(id);
		if (session === undefined) throw endedError(id);
		if (session.ownerKey !== ownerKey) throw new TerminalSessionError(`terminal: session ${JSON.stringify(id)} belongs to another agent`, 'FOREIGN_SESSION');
		return session;
	};
	const touch = (session) => {
		// A finished session is not activity: re-stamping it would move the end time the
		// panel shows and arm a timer whose reclaim is a no-op.
		if (session.closed === true) return;
		session.lastActiveAt = Date.now();
		if (session.idleMs <= 0) return;
		if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
		session.idleTimer = setTimeout(() => {
			reclaim(session, `closed by the idle reaper after ${session.idleMs} ms without activity`)
				.catch((error) => warn(`terminal: the idle reaper could not close session ${session.id} cleanly: ${String(error?.message ?? error)}`));
		}, session.idleMs);
		if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
	};
	/** Announce one ending, once per session, without letting a delivery failure fail the close. */
	const announce = (session, cause) => {
		if (session.announced === true) return;
		session.announced = true;
		try {
			notify({ session, view: view(session), cause });
		} catch (error) {
			warn(`terminal: the session notice for ${session.id} could not be delivered: ${String(error?.message ?? error)}`);
		}
	};
	/**
	 * Move a session that ended on its own into the finished list.
	 *
	 * `reclaim` is for "we ended it" and also terminates the provider. A shell that
	 * exited by itself needs only the bookkeeping, so it keeps its ring for `read`
	 * and its slot in the live map no longer counts against `maxSessions`.
	 */
	const retire = (session, reason) => {
		if (session.closed === true) return;
		if (sessions.delete(session.id) === false) return;
		if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
		retainFinished(session, reason);
	};
	/** Terminate one session and drop it from the live map; safe to call twice. */
	const reclaim = async (session, reason) => {
		if (session.closed) return session.closePromise;
		session.closed = true;
		if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
		const live = sessions.delete(session.id);
		retainFinished(session, reason);
		// A shell that already exited has nothing to terminate; the retention above is
		// the whole job, and reporting a terminate for it would be a lie.
		if (live === false) {
			session.closePromise = Promise.resolve();
			return session.closePromise;
		}
		if (reason.startsWith('closed by the idle reaper')) announce(session, 'idle');
		session.closePromise = Promise.resolve(session.handle.terminate()).catch((error) => {
			warn(`terminal: terminating session ${session.id} failed: ${String(error?.message ?? error)}`);
		});
		return session.closePromise;
	};
	/** Deliver whatever is new since the session's cursor, and advance it. */
	const drain = (session, offset) => {
		const from = offset ?? session.cursor;
		const read = session.ring.readFrom(from);
		if (read.nextOffset > session.cursor) session.cursor = read.nextOffset;
		return read;
	};
	const view = (session) => ({
		sessionId: session.id,
		shell: session.shell,
		name: session.name,
		pid: session.pid,
		cwd: session.cwd,
		// A reclaimed session is over even if its provider has not settled `done`
		// yet; the panel must not keep listing it as running.
		status: session.closed === true && session.status === 'running' ? 'exited' : session.status,
		startedAt: session.startedAt,
		lastActiveAt: session.lastActiveAt,
		idleMs: session.idleMs,
		rows: session.rows,
		cols: session.cols,
		retainedBytes: session.ring.retainedBytes,
		truncated: session.ring.truncated,
	});

	/**
	 * Start one session.
	 * @param request - the fully resolved spawn the tool row built.
	 * @returns the published session view.
	 */
	async function open(request) {
		// In-flight starts count towards the cap: the spawn and the startup settle are
		// awaited, so counting only the PUBLISHED sessions would let two concurrent opens
		// both pass a cap of one and start two shells.
		// An exited session is retained history, not a shell: it must not hold a slot.
		const live = [...sessions.values()].filter((session) => session.status !== 'exited').length + opening;
		if (live >= request.maxSessions) {
			throw new TerminalSessionError(
				`terminal: ${live} sessions are already open and the limit is ${request.maxSessions}; close one with action "close" (or raise the terminal row's maxSessions) before opening another`,
			'SESSION_LIMIT',
			);
		}
		opening += 1;
		try {
			return await startSession(request);
		} finally {
			opening -= 1;
		}
	}
	/** The body of one admitted open; the cap was checked by {@link open}. */
	async function startSession(request) {
		const handle = await ctx.subprocess.spawnTerminal({
			argv: request.argv,
			cwd: request.cwd,
			...(request.env === undefined ? {} : { env: request.env }),
			rows: request.rows,
			cols: request.cols,
			...(request.terminalType === undefined ? {} : { terminalType: request.terminalType }),
			graceMs: request.graceMs,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		if (disposed === true) {
			await Promise.resolve(handle.terminate()).catch(() => {});
			throw new TerminalSessionError('terminal: the terminal row was disposed while this session was starting', 'DISPOSED');
		}
		const session = {
			id: request.id ?? randomUUID(),
			ownerKey: request.ownerKey,
			name: request.name,
			shell: request.shell,
			pid: handle.pid,
			cwd: request.cwd,
			startedAt: Date.now(),
			lastActiveAt: Date.now(),
			lastOutputAt: Date.now(),
			idleMs: request.idleMs,
			rows: request.rows,
			cols: request.cols,
			handle,
			ring: new OutputRing(request.maxBufferBytes),
			sanitizer: new TerminalSanitizer(),
			decoder: new TextDecoder(),
			cursor: 0,
			status: 'running',
			exitCode: undefined,
			signal: undefined,
			closed: false,
			closePromise: undefined,
			idleTimer: undefined,
		};
		handle.output.on('data', (chunk) => {
			const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
			const text = session.decoder.decode(bytes, { stream: true });
			if (text.length === 0) return;
			const clean = session.sanitizer.push(text);
			// Only PRINTABLE output counts as activity. ConPTY emits escape-only
			// bursts while it initialises; letting those advance the clock is exactly
			// what made an early `open` settle "quiet" with an empty reply (measured:
			// the prompt itself arrived ~1.2 s later, so the caller was told a session
			// had settled before it had printed anything at all).
			if (clean.text.length > 0) {
				session.lastOutputAt = Date.now();
				session.ring.append(clean.text);
			}
		});
		const finish = () => {
			const tail = session.sanitizer.push(session.decoder.decode());
			if (tail.text.length > 0) session.ring.append(tail.text);
			const rest = session.sanitizer.flush();
			if (rest.text.length > 0) session.ring.append(rest.text);
			session.lastOutputAt = Date.now();
		};
		handle.output.once('end', finish);
		handle.output.once('error', finish);
		handle.done.then((outcome) => {
			finish();
			session.status = 'exited';
			session.exitCode = outcome.exitCode;
			session.signal = outcome.signal;
			if (session.closed !== true) {
				announce(session, 'exited');
				retire(session, `exited on its own${outcome.exitCode === undefined ? '' : ` (exit code ${outcome.exitCode})`}`);
			}
		}, (error) => {
			finish();
			session.status = 'exited';
			warn(`terminal: session ${session.id} transport failed: ${String(error?.message ?? error)}`);
			retire(session, 'its transport failed');
		});
		sessions.set(session.id, session);
		touch(session);
		// Startup settle: a published session whose shell died before its first
		// prompt is not a session, so the failure is raised here (naming the
		// dialect) instead of surfacing as an empty first read. `quiet` is the
		// normal outcome, and `timeout` is tolerated: some shells are just slow to
		// print, and the caller can still read.
		let startupWaitReason;
		if (typeof request.startupWaitMs === 'number' && request.startupWaitMs > 0) {
			// Baseline 0 = "anything this session has printed". A fast shell can land its
			// prompt while the spawn call is still resolving, and a baseline taken HERE
			// then discards it: measured on this host, every open paid the full 4 s startup
			// budget and reported timeout with the prompt already sitting in the ring.
			try {
				startupWaitReason = await waitReady(session, { waitMs: request.startupWaitMs, quietMs: request.quietMs ?? DEFAULT_QUIET_MS }, 0, request.signal);
			} catch (error) {
				// A cancelled open must not leave an unnamed shell holding a slot.
				if (error?.code === 'ABORTED') await reclaim(session, 'the open was cancelled');
				throw error;
			}
			if (startupWaitReason === 'session_exit') {
				const code = session.exitCode;
				await reclaim(session, 'exited before its first prompt');
				throw new TerminalSessionError(`terminal: the ${request.shell} session exited before reaching a prompt (exit code ${String(code)}); check that this shell starts interactively on this host`, 'STARTUP_FAILED');
			}
		}
		return { session, view: view(session), startupWaitReason };
	}

	/**
	 * Observe the provider's activity answer when it can give one.
	 * @param session - the session to inspect.
	 * @returns `'idle'`, `'busy'` or `'unknown'`.
	 */
	async function activityOf(session) {
		if (typeof session.handle.inspectActivity !== 'function') return 'unknown';
		try {
			const activity = await session.handle.inspectActivity();
			return activity?.state === 'idle' || activity?.state === 'busy' ? activity.state : 'unknown';
		} catch {
			return 'unknown';
		}
	}

	/**
	 * Wait until this session looks ready to read, without ever killing it.
	 *
	 * `idle` and `busy` are the provider's own answers and are trusted; `unknown`
	 * (every win32 host today) falls back to output silence, whose meaning is
	 * reported verbatim as `quiet` so a caller never reads it as "the command
	 * finished". The cap hands partial output back and leaves the shell running.
	 * @param session - the session to wait on.
	 * @param limits - the wait shape for this call.
	 * @returns the observed reason.
	 */
	async function waitReady(session, limits, sinceOffset = session.ring.nextOffset, signal) {
		const deadline = Date.now() + limits.waitMs;
		// Silence alone is not evidence of readiness — it is also what a shell that
		// has not printed its prompt yet looks like. Measured here (2026-10-16): the
		// Git Bash prompt arrives ~660 ms after the spawn, so a wait that trusts the
		// clock alone returned an EMPTY open in ~400 ms and the prompt then landed
		// after the caller had already been told the session had "settled". So a
		// wait may only settle on silence once THIS wait has seen output at all.
		//
		// "Seen" is counted against the byte offset the wait opened at, not the wall
		// clock: a send's own echo can land between the write resolving and the first
		// poll, and a clock baseline then reads that as "no output yet" — a silent
		// command paid the whole waitMs instead of settling on its own silence.
		let sawOutput = session.ring.nextOffset > sinceOffset;
		for (;;) {
			// A wait the caller has given up on must stop now, not at its own cap: the
			// budget can be minutes long, and a cancelled call that keeps holding the
			// session open is worse than the snapshot it replaced.
			if (signal?.aborted === true) throw new TerminalSessionError('terminal: the call was aborted while waiting for the session', 'ABORTED');
			if (session.status === 'exited') return 'session_exit';
			const now = Date.now();
			if (session.ring.nextOffset > sinceOffset) sawOutput = true;
			if (now - session.lastOutputAt >= limits.quietMs) {
				const activity = await activityOf(session);
				// A provider that can answer at all is believed immediately: `idle` is
				// real prompt evidence, and `busy` outranks silence. Only when it
				// cannot answer does this fall back to silence — and then only after
				// this wait has seen output, because a shell that has not printed
				// anything yet is not quiet, it is early.
				if (activity === 'idle') return 'idle';
				if (activity !== 'busy' && sawOutput) return 'quiet';
			}
			if (now >= deadline) return 'timeout';
			await sleep(POLL_MS);
		}
	}

	/**
	 * Write to a session and return what the write produced.
	 * @param request - owner, target id, text, submit flag, optional resize and wait shape.
	 * @returns the delta plus the reason the wait ended.
	 */
	async function send(request) {
		const session = require(request.ownerKey, request.sessionId);
		if (session.status === 'exited') throw new TerminalSessionError(`terminal: session ${request.sessionId} has exited (code ${String(session.exitCode)}); open a new session`, 'SESSION_EXITED');
		if (typeof request.text !== 'string' || request.text.length === 0) throw new TerminalSessionError('terminal: "text" must be a non-empty string for action "send"', 'INVALID_TEXT');
		touch(session);
		await resizeIfAsked(session, request);
		// The wait's baseline is the write, so only what the write caused can settle it.
		const since = session.ring.nextOffset;
		await session.handle.write(request.submit === false ? request.text : `${request.text}\r`);
		const waitReason = await waitReady(session, request, since, request.abortSignal);
		// But the DELTA starts at the caller's cursor, not at the write: anything that
		// arrived after the last read and before this send is still the caller's to see.
		// Starting at the write made those bytes invisible forever — they were neither in
		// this result nor in any later read, because the cursor had already jumped past them.
		const read = session.ring.readFrom(session.cursor);
		session.cursor = Math.max(session.cursor, read.nextOffset);
		session.lastActiveAt = Date.now();
		return { ...read, shell: session.shell, waitReason };
	}

	/**
	 * Wait until the ring holds bytes beyond `since`, or the budget runs out.
	 *
	 * A read wait is not a readiness wait: it does not care about silence, only about
	 * whether anything NEW has arrived, so it returns the moment the next chunk lands.
	 * @param session - the session to watch.
	 * @param since - whole-stream byte offset the caller has already seen.
	 * @param waitMs - the caller's budget in milliseconds.
	 * @returns `session_exit` when the shell ended, `timeout` when nothing arrived, and
	 *   `undefined` when new output is available.
	 */
	async function waitForOutput(session, since, waitMs, signal) {
		const deadline = Date.now() + waitMs;
		let touchedAt = Date.now();
		while (session.status !== 'exited' && session.closed !== true && session.ring.nextOffset <= since) {
			if (signal?.aborted === true) throw new TerminalSessionError('terminal: the call was aborted while waiting for output', 'ABORTED');
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			// A caller blocked on THIS session is activity. Without this refresh the idle
			// reaper could close the very session the call is waiting on whenever
			// `idleMs` is shorter than the requested budget.
			if (session.idleMs > 0 && Date.now() - touchedAt >= Math.min(session.idleMs / 2, 1000)) {
				touch(session);
				touchedAt = Date.now();
			}
			await sleep(Math.min(POLL_MS, remaining));
		}
		if (session.status === 'exited') return 'session_exit';
		return session.ring.nextOffset > since ? undefined : 'timeout';
	}

	/**
	 * Read output without writing: the delta from the caller's cursor, the whole
	 * retained window when `all` is set, and — when `waitMs` is positive — a wait for
	 * the next chunk instead of an instant snapshot.
	 * @param request - owner, target id, optional offset, wait budget and all flag.
	 * @returns the text, the resume offset, both loss facts and why the wait ended.
	 */
	async function read(request) {
		const session = requireReadable(request.ownerKey, request.sessionId);
		touch(session);
		const waitMs = typeof request.waitMs === 'number' && request.waitMs > 0 ? request.waitMs : 0;
		if (request.all === true) {
			// The registry refuses the meaningless combinations itself instead of letting
			// `all` quietly win: a direct caller (a test, a future RPC) gets the same answer
			// the tool row gives, not a silent resolution.
			if (request.offset !== undefined || waitMs > 0) {
				throw new TerminalSessionError('terminal: "all" reads the retained window as it stands, so it cannot be combined with offset or waitMs', 'INVALID_REQUEST');
			}
			// Unconditional scrollback: no cursor movement, so a later delta read still
			// reports everything that arrived after the caller's last DELTA read. The
			// resume offset is therefore the CURSOR, not the window's end — a caller that
			// feeds it back gets the delta it has not seen, not one it has.
			const snapshot = session.ring.snapshot();
			return {
				text: snapshot.text,
				nextOffset: session.cursor,
				truncated: snapshot.truncated,
				lossy: false,
				shell: session.shell,
				waitReason: session.status === 'exited' || session.closed === true ? 'session_exit' : (snapshot.text.length === 0 ? 'no_output' : undefined),
			};
		}
		const since = request.offset ?? session.cursor;
		// `status` becomes 'exited' only when the provider settles `done`; a session we
		// already reclaimed is over regardless, and waiting on its ring would burn the
		// whole budget for output that can never arrive.
		const ended = session.status === 'exited' || session.closed === true;
		let waitReason = ended ? 'session_exit' : undefined;
		if (waitMs > 0 && waitReason === undefined && session.ring.nextOffset <= since) {
			waitReason = await waitForOutput(session, since, waitMs, request.abortSignal);
		}
		const result = drain(session, request.offset);
		// An empty delta must explain itself: "nothing new since the last read" is a fact
		// about the cursor, not a broken session, and this text is what the model reads.
		if (result.text.length === 0 && waitReason === undefined) waitReason = 'no_output';
		return { ...result, shell: session.shell, waitReason };
	}

	/**
	 * Deliver one signal to the session's foreground process group.
	 * @param request - owner, target id, signal name, optional wait shape.
	 * @returns the delta, the receiving process-group id, and the wait reason.
	 */
	async function signal(request) {
		const session = require(request.ownerKey, request.sessionId);
		if (session.status === 'exited') throw new TerminalSessionError(`terminal: session ${request.sessionId} has exited; signal it is not possible`, 'SESSION_EXITED');
		if (!TERMINAL_SIGNALS.includes(request.signal)) throw new TerminalSessionError(`terminal: "signal" must be one of ${TERMINAL_SIGNALS.join(', ')} (got ${JSON.stringify(request.signal)})`, 'INVALID_SIGNAL');
		if (typeof session.handle.signalForeground !== 'function') throw new TerminalSessionError('terminal: this subprocess provider cannot signal a terminal foreground group', 'NO_SIGNAL_SUPPORT');
		// A provider whose terminal has no addressable pid cannot reach a foreground
		// group at all: measured on this host, win32 ConPTY reports pid 0 for the
		// whole session, the inspector's own kill path opens with `if (pid <= 0)
		// return`, and yet signalForeground RESOLVES — so SIGTERM "succeeds" while
		// delivering nothing. Reporting success for a signal that reaches no process
		// is the half-working contract this plugin refuses to ship, so those two are
		// refused by name. SIGINT still works: the win32 provider delivers it as a
		// Ctrl+C byte to the terminal, which is why it is allowed through.
		// Two more declared signals cannot be delivered by this platform's provider at all:
		// it answers SIGTSTP/SIGHUP with its own raw error, which would reach the model as a
		// provider message that contradicts this tool's own ("only SIGINT reaches the shell"
		// and, worse, "SIGINT, SIGTERM, and SIGKILL are available"). They are refused here,
		// by name, with the same code as the two below.
		if (request.signal === 'SIGTSTP' || request.signal === 'SIGHUP') {
			throw new TerminalSessionError(
				`terminal: ${request.signal} is not deliverable on this platform; on the Windows terminal provider SIGINT is the only signal that reaches the shell`,
				'SIGNAL_UNREACHABLE',
			);
		}
		if (session.pid <= 0 && (request.signal === 'SIGTERM' || request.signal === 'SIGKILL')) {
			throw new TerminalSessionError(`terminal: this provider exposes no addressable terminal pid (${session.pid}), so ${request.signal} would be delivered to nothing here; SIGINT is the only signal that reaches the shell on this platform`, 'SIGNAL_UNREACHABLE');
		}
		touch(session);
		const since = session.ring.nextOffset;
		const delivered = await session.handle.signalForeground(request.signal);
		const waitReason = await waitReady(session, request, since, request.abortSignal);
		// Same rule as `send`: the delta starts at the caller's cursor, so a signal never
		// swallows output that arrived between the last read and the delivery.
		const read = session.ring.readFrom(session.cursor);
		session.cursor = Math.max(session.cursor, read.nextOffset);
		session.lastActiveAt = Date.now();
		return { ...read, shell: session.shell, delivered, waitReason };
	}

	/**
	 * Terminate one session and wait for its process tree to become quiescent.
	 * @param request - owner and target id.
	 * @returns the terminal state.
	 */
	/**
	 * Wait (bounded) for a terminated session to publish its outcome.
	 *
	 * `close` used to read `session.exitCode` the instant `terminate()` resolved, while the
	 * outcome is assigned by the `done` continuation — a race that reported `exitCode: null`
	 * for a session that had in fact exited. The wait is bounded by the row's grace so a
	 * provider that never settles `done` still closes.
	 */
	async function waitForExit(session, graceMs) {
		if (session.status === 'exited') return;
		await Promise.race([session.handle.done.catch(() => {}), sleep(graceMs)]);
	}
	async function close(request) {
		const session = require(request.ownerKey, request.sessionId);
		const tail = session.ring.snapshot();
		await reclaim(session, 'closed by the caller');
		await waitForExit(session, request.graceMs ?? DEFAULT_GRACE_MS);
		return { sessionId: session.id, shell: session.shell, exitCode: session.exitCode, signal: session.signal, output: tail.text, truncated: tail.truncated };
	}

	/** Apply an optional resize before a write; a provider without `resize` is left alone. */
	async function resizeIfAsked(session, request) {
		if (request.cols === undefined && request.rows === undefined) return;
		if (typeof session.handle.resize !== 'function') return;
		const cols = request.cols ?? session.cols;
		const rows = request.rows ?? session.rows;
		if (cols === session.cols && rows === session.rows) return;
		try {
			await session.handle.resize(cols, rows);
			session.cols = cols;
			session.rows = rows;
		} catch (error) {
			warn(`terminal: resizing session ${session.id} to ${cols}x${rows} failed: ${String(error?.message ?? error)}`);
		}
	}

	/** The sessions one agent owns, in publication order. */
	function list(ownerKey) {
		return [...sessions.values(), ...finished.values()].filter((session) => session.ownerKey === ownerKey).map(view);
	}

	/**
	 * The retained output of one session, for the header's expanded row.
	 *
	 * A human reading the list is not an owner-scoped tool call, so this returns
	 * the ring's retained tail without moving any agent's cursor.
	 * @param id - the session id.
	 * @returns the retained text and whether older output was dropped.
	 */
	function tail(id) {
		const session = sessions.get(id) ?? finished.get(id);
		if (session === undefined) throw endedError(id);
		const snapshot = session.ring.snapshot();
		const output = snapshot.text.length > TAIL_CHARS ? snapshot.text.slice(-TAIL_CHARS) : snapshot.text;
		return { sessionId: id, output, truncated: snapshot.truncated === true || output.length < snapshot.text.length };
	}
	/** Every live session, regardless of owner: the session header's list. */
	function listAll() {
		return [...sessions.values(), ...finished.values()].map(view);
	}
	/**
	 * Close one session by id without an owner key.
	 *
	 * The header panel is a human surface, not an agent call: it lists every
	 * session the deployment runs and may stop any of them. The reason travels
	 * into the tombstone, so a later model read says who ended it.
	 * @param id - the session id the panel listed.
	 * @param reason - why it was closed (shown by later reads).
	 * @returns the id, shell and a closed marker.
	 */
	async function stop(id, reason = 'stopped by the user from the session header') {
		const session = sessions.get(id);
		if (session === undefined) throw endedError(id);
		await reclaim(session, reason);
		announce(session, 'stopped');
		return { sessionId: session.id, shell: session.shell, closed: true };
	}

	/** Terminate every live session; the owning row calls this from its effect disposer. */
	async function dispose() {
		disposed = true;
		const live = [...sessions.values()];
		await Promise.all(live.map((session) => reclaim(session, 'closed when the terminal row was disposed')));
		finished.clear();
		tombstones.clear();
	}

	return { open, send, read, signal, close, list, listAll, stop, tail, dispose };
}
