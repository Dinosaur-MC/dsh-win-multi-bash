/**
 * Self-heal for the DSH sandbox's private temp directory.
 *
 * **The defect this exists for (measured, not theorised).** The windows-acl
 * rung of `dsh-sandbox-local` materializes ONE private temp directory per
 * (session, workspaceRoot) pair — `mkdtempSync(join(tmpdir(), 'dsh-'))` — and
 * caches it in `tempCapabilities` for the whole provider lifetime
 * (`dsh-sandbox-local/lib/index.js:416`, identical in 0.2.0-rc.2,
 * 0.2.1-alpha.4 and 0.2.1-alpha.5). Every confined spawn then goes through
 * `dsh-sandbox-windows-acl/lib/runner.js`, which treats `--temp` as an input
 * that MUST already exist (`runner.js:116`):
 *
 *     windows-acl-run: --temp is not an existing directory: <path>     (exit 127)
 *
 * Neither side checks for, recreates, or reports the missing directory — so
 * deleting that directory out of band (an OS temp cleaner, a manual `rmdir`,
 * a crashed sibling) bricks EVERY later wrapped spawn of that session: the
 * seam keeps handing the runner the same stale path. Recreating the directory
 * restores the existence half; the seam's `tempWriteSid` ACE is NOT restored
 * by a recreated directory (measured), so a confined child writing its own
 * `$env:TEMP` is still denied until the grant is re-applied.
 *
 * **What this module does, and only this.** Before a confined spawn it reads
 * the `--temp` the seam is about to hand the runner (channel b: the
 * `ctx.sandbox.confine()` result our executors already hold), and when that
 * path is a private temp root that has gone missing it recreates the directory
 * and re-applies the seam's own write grant with the seam's own derived SID —
 * the same `tempWriteSid`/`AclWriteGrant` calls `dsh-sandbox-local` makes. A
 * second channel reads the runner's settled stderr for the signature above
 * (channel a) and heals for the next command if the directory vanished between
 * the check and the runner's own check.
 *
 * Boundaries, stated as enforced invariants rather than intentions:
 *
 *  - **Nothing is ever deleted, renamed, moved, or written inside.** The only
 *    mutation is `mkdir` on a path that does not exist plus a DACL/label edit
 *    on that same directory.
 *  - A path is only ever acted on when ALL of these hold: it is an absolute
 *    path; it is inside an OS temp root; it is a DIRECT child of that root; its
 *    basename matches the mkdtemp shape `dsh-<6 alphanumerics>`; it is not
 *    inside any known workspace root; and (for the proactive channel) it does
 *    not exist. Anything else is a named refusal ({@link GUARD_REASONS}) — the
 *    guard never guesses at a path it does not recognise.
 *  - The `--temp` scan stops at the runner's `--` separator, so a WRAPPED
 *    command that happens to carry its own `--temp` token can never be mistaken
 *    for the runner's flag.
 *  - `.volatile()` knob off ⇒ `enabled()` is false and this module touches no
 *    filesystem and loads no package.
 *
 * **Honest limits.** It cannot stop the directory being deleted again (only
 * heal the next attempt); a `.volatile()` knob off means no healing at all;
 * a row that never reaches the windows-acl runner (wsl_bash uses bwrap) has
 * nothing to heal; dsh's OWN tools are healed only when one of this plugin's
 * rows runs a confined command first, because this plugin sees no confine
 * call it did not make; and when `@deepseek-ai/dsh-sandbox-windows-acl` cannot
 * be loaded the directory is recreated without its ACE (existence only), which
 * the report says out loud.
 *
 * Zero new runtime dependencies: the ACL package is taken through a lazy
 * `import()` (with a resolve-from-`dsh-sandbox-local` fallback) and is declared
 * as an optional peer, so a deployment without it still gets the existence
 * half instead of a failure to load this module.
 * @module dsh-win-multi-bash/sandbox-temp-guard
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * The switch's key: declared `.volatile()` on the PACKAGE row only (the tool rows no
 * longer carry a copy). A row that ever declares its own still wins through the
 * executor's override branch.
 */
export const SANDBOX_TEMP_GUARD_KNOB = 'guardSandboxTemp';
/** The knob's default: healing is ON, so a deployment needs no edit to be protected. */
export const SANDBOX_TEMP_GUARD_DEFAULT = true;
/**
 * The deployment-wide switch, owned by the package row.
 *
 * WHY HERE. The switch has to be listed ONCE, at the top of the plugin, and every
 * consumer has to read the same one: the package row publishes it, and both this
 * module's own driver and each shell row's pre-spawn check consult it.
 *
 * A SOURCE, NOT A SNAPSHOT. The row's field is declared `.volatile()`, so `apply`
 * receives a cosmokit live handle rather than a boolean — measured: `validate({
 * guardSandboxTemp: false })` yields an object whose `.get()` is `false`. Comparing
 * that handle to `false` is always true, which silently deleted the OFF path; the row
 * therefore hands over an accessor and every read resolves it now. A plain boolean is
 * still accepted (tests, callers with no handle).
 */
let sandboxTempGuardSource = SANDBOX_TEMP_GUARD_DEFAULT;
/** Resolve a boolean or an accessor to the boolean it currently means. */
function resolveGuardEnabled() {
	const raw = typeof sandboxTempGuardSource === 'function' ? sandboxTempGuardSource() : sandboxTempGuardSource;
	return raw !== false;
}
/**
 * Publish the deployment-wide source: the package row passes `() => live(knob)`;
 * a boolean states a stance for callers that hold no handle.
 */
export function setSandboxTempGuardEnabled(source) {
	sandboxTempGuardSource = typeof source === 'function' ? source : source !== false;
	return resolveGuardEnabled();
}
/** Read the deployment-wide value, resolved now. */
export function getSandboxTempGuardEnabled() {
	return resolveGuardEnabled();
}
/**
 * How often a watch re-checks the roots it knows, in ms.
 *
 * Ten seconds, not thirty: one scan is a listing of the OS temp roots plus a stat per
 * candidate, and the deterministic guarantee lives elsewhere — every wrapped run
 * checks at its entry AND again immediately before the seam is handed `--temp`. The
 * timer is the ambient safety net for a root no command is about to use, so it is the
 * latency a reader notices; the live value below is what a reader can shorten.
 */
export const SANDBOX_TEMP_WATCH_MS = 10_000;
/** The shortest interval a caller may set, so a knob cannot turn this into a spin. */
export const SANDBOX_TEMP_WATCH_MS_MIN = 1_000;
/**
 * The live source of the interval: a number or an accessor (the row's `tempWatchMs`
 * handle). Resolved — and clamped to the floor — on every read, so neither a live
 * handle nor a below-floor value can silently disable the watch.
 */
let sandboxTempWatchSource = SANDBOX_TEMP_WATCH_MS;
/** Resolve the source to a usable millisecond count, clamped to the floor. */
function resolveWatchMs() {
	const raw = typeof sandboxTempWatchSource === 'function' ? sandboxTempWatchSource() : sandboxTempWatchSource;
	const next = Math.floor(Number(raw));
	if (!Number.isFinite(next) || next <= 0) return SANDBOX_TEMP_WATCH_MS;
	return next < SANDBOX_TEMP_WATCH_MS_MIN ? SANDBOX_TEMP_WATCH_MS_MIN : next;
}
/** Watch schedulers that can be woken immediately when the live value changes. */
const watchSchedulers = new Set();
/**
 * Set the live interval (the package row reads it from its own Config).
 *
 * Live on purpose: the knob is on the plugin page, and a value that only took effect
 * after a row reload would be a switch a reader cannot act on while watching a broken
 * directory. Every armed watch is woken immediately instead of waiting out the old
 * interval.
 */
export function setSandboxTempWatchMs(source) {
	const before = resolveWatchMs();
	sandboxTempWatchSource = typeof source === 'function' ? source : source;
	const after = resolveWatchMs();
	if (after !== before) {
		for (const wake of watchSchedulers) {
			try {
				wake();
			} catch {
				// A watch that cannot be woken keeps its own schedule; never fatal here.
			}
		}
	}
	return after;
}
/** Read the live interval, resolved and clamped now. */
export function getSandboxTempWatchMs() {
	return resolveWatchMs();
}
/**
 * Drive the guard from a row's OWN lifecycle, with no shell tool involved.
 *
 * The guard must not depend on a shell command ever running: measured on this host,
 * a row whose confinement probe fails never confines again, and the private root the
 * HARNESS keeps for its own confined tools is a different directory that no row is
 * ever handed — so a shell-triggered repair cannot reach either one. This driver
 * belongs to the always-mounted package row instead: it seeds its memory from a
 * directory listing at mount, then re-checks on a timer. The class stays free of any
 * shell or host dependency (node builtins only), which is what makes this possible.
 * @param ctx - a context that can own a disposable timer (feature-detected).
 * @param options - injectable guard, roots, interval and report sink (for tests).
 * @returns the guard it drives, or undefined when the context cannot own a timer.
 */
export function startSandboxTempWatch(ctx, options = {}) {
	const guard = options.guard ?? new SandboxTempGuard({
		enabled: options.enabled === undefined ? undefined : (() => options.enabled !== false),
		warn: options.warn,
		tempRoots: options.tempRoots,
		workspaceRoots: options.workspaceRoots
	});
	if (typeof ctx?.effect !== 'function') return undefined;
	ctx.effect(() => {
		let timer;
		let stopped = false;
		/**
		 * Self-rescheduling rather than a fixed `setInterval`: each round reads the LIVE
		 * interval, so a knob changed on the plugin page applies from the next round, and a
		 * woken scheduler starts that round immediately instead of waiting it out.
		 */
		/** The interval this watch uses: an explicit option wins, the live value otherwise. */
		const intervalNow = () => {
			const asked = typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
			if (asked === undefined) return getSandboxTempWatchMs();
			const next = Math.floor(Number(asked));
			// An EXPLICIT option is a code-level choice (a row, a test), so it is taken as given;
			// the floor below guards the user-facing knob, not this path.
			return Number.isFinite(next) && next > 0 ? next : getSandboxTempWatchMs();
		};
		const schedule = () => {
			if (stopped) return;
			timer = setTimeout(tick, intervalNow());
			timer.unref?.();
		};
		/**
		 * Wake means CHECK NOW, then re-arm with the interval in force: a reader who
		 * shrinks the knob while watching a missing directory gets the next scan at once,
		 * not one old interval later.
		 */
		const wake = () => {
			if (stopped) return;
			clearTimeout(timer);
			tick();
		};
		const tick = () => {
			// A timer must never be able to take the host down.
			try {
				guard.rememberAmbient();
				guard.ensureAmbient().catch(() => {});
			} catch {
				// Reported by the guard's own warn latch when it has one.
			}
			schedule();
		};
		watchSchedulers.add(wake);
		tick();
		return () => {
			stopped = true;
			watchSchedulers.delete(wake);
			clearTimeout(timer);
		};
	}, 'dsh-win-multi-bash: sandbox private temp guard');
	return guard;
}
/** The private temp root's name shape: mkdtemp over the prefix `dsh-<6 alphanumerics>`. */
export const SANDBOX_TEMP_NAME = /^dsh-[A-Za-z0-9]{6}$/;
/** The runner's missing-temp signature, with the path it names in group 1. */
const RUNNER_MISSING_TEMP = /--temp is not an existing directory:\s*(.+?)\s*$/m;
/** Every reason the guard can decline to act, as stable machine-readable codes. */
export const GUARD_REASONS = Object.freeze({
	DISABLED: 'disabled',
	NO_TEMP_ARGUMENT: 'no-temp-argument',
	BAD_PATH: 'bad-path',
	NOT_ABSOLUTE: 'not-absolute',
	OUTSIDE_TEMP_ROOT: 'outside-temp-root',
	NOT_DIRECT_CHILD: 'not-direct-child',
	NAME_SHAPE: 'name-shape',
	INSIDE_WORKSPACE: 'inside-workspace',
	ALREADY_EXISTS: 'already-exists',
	EXISTS_NOT_DIRECTORY: 'exists-not-directory'
});
/** How a heal attempt ended. `HEALED` is the only one that restores the seam's grant. */
export const HEAL_OUTCOMES = Object.freeze({
	HEALED: 'healed',
	EXISTENCE_ONLY: 'healed-existence-only',
	MKDIR_FAILED: 'mkdir-failed',
	GRANT_FAILED: 'grant-failed'
});
/**
 * Normalize one path for comparison (Windows compare is case-insensitive).
 * @param value - the path.
 * @returns the comparison key.
 */
function comparisonKey(value) {
	return process.platform === 'win32' ? value.toLowerCase() : value;
}
/**
 * Whether `root` is the same directory as `candidate` or contains it.
 * @param root - the containing directory.
 * @param candidate - the candidate path.
 * @returns true when `candidate` is inside (or equal to) `root`.
 */
function pathContains(root, candidate) {
	const rel = relative(resolvePath(root), resolvePath(candidate));
	if (rel === '') return true;
	if (isAbsolute(rel)) return false;
	return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../');
}
/**
 * Every OS temp root this process can see, deduplicated case-insensitively.
 * `os.tmpdir()` is what the sandbox seam itself used (`mkdtempSync(join(tmpdir(),
 * 'dsh-'))`), and TEMP/TMP are the ambient spellings a seam in another shell
 * could have picked, so all three are accepted.
 * @param env - the environment to read (defaults to the process environment).
 * @returns absolute temp roots, in probe order.
 */
export function tempRoots(env = process.env) {
	const roots = [];
	const seen = new Set();
	for (const value of [tmpdir(), env.TEMP, env.TMP]) {
		if (typeof value !== 'string' || value.length === 0) continue;
		const root = resolvePath(value);
		const key = comparisonKey(root);
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push(root);
	}
	return roots;
}
/**
 * The `--temp <dir>` value of a windows-acl runner argv, or `undefined`.
 *
 * The scan stops at the runner's `--` separator (the seam's argv contract is
 * `[...runner flags, '--', ...command argv]`), so the wrapped command's own
 * arguments can never be read as the runner's flag.
 * @param argv - the confined argv.
 * @returns the temp directory the runner was told to use, when the argv carries one.
 */
export function sandboxTempArgument(argv) {
	if (!Array.isArray(argv)) return undefined;
	let found;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (typeof token !== 'string') continue;
		// The runner's own flags live before the separator; stopping here is what
		// makes a wrapped command's `--temp` argument unreadable as the runner's.
		if (token === '--') break;
		if (token === '--temp') {
			const value = argv[index + 1];
			if (typeof value === 'string' && value.length > 0) {
				found = value;
				index += 1;
			}
			continue;
		}
		if (token.startsWith('--temp=')) {
			const value = token.slice('--temp='.length);
			if (value.length > 0) found = value;
		}
	}
	// The LAST occurrence wins, matching the runner's own parse: if a future seam
	// emitted the flag twice, healing the first mention would heal a directory the
	// runner never validates.
	return found;
}
/**
 * The path named by the runner's missing-temp signature in settled stderr, or
 * `undefined` when the text carries no such line.
 * @param stderr - the settled stderr text.
 * @returns the path the runner complained about.
 */
export function missingTempDirectoryOf(stderr) {
	if (typeof stderr !== 'string') return undefined;
	const match = RUNNER_MISSING_TEMP.exec(stderr);
	if (match === null) return undefined;
	const path = match[1].trim();
	return path.length === 0 ? undefined : path;
}
/**
 * Decide whether one path is a private temp root this guard may act on.
 *
 * Order is deliberate: shape and scope (absolute, inside a temp root, a direct
 * child of it, the mkdtemp name shape, outside every known workspace root) are
 * settled BEFORE existence, so existence can never be the reason a
 * suspicious-looking path slips through.
 * @param tempPath - the path handed to the runner as `--temp`.
 * @param options - temp roots, workspace roots and the fs/existence seams.
 * @returns `{ action: 'heal' | 'skip', reason, path?, tempRoot? }`.
 */
export function classifySandboxTempTarget(tempPath, options = {}) {
	const roots = options.tempRoots ?? tempRoots();
	const workspaces = options.workspaceRoots ?? [];
	const exists = options.exists ?? existsSync;
	const stat = options.stat ?? statSync;
	const requireMissing = options.requireMissing !== false;
	const skip = (reason) => ({ action: 'skip', reason, path: tempPath });
	if (typeof tempPath !== 'string' || tempPath.trim().length === 0) return skip(GUARD_REASONS.BAD_PATH);
	if (!isAbsolute(tempPath)) return skip(GUARD_REASONS.NOT_ABSOLUTE);
	const parent = dirname(resolvePath(tempPath));
	const tempRoot = roots.find((root) => pathContains(root, tempPath));
	if (tempRoot === undefined) return skip(GUARD_REASONS.OUTSIDE_TEMP_ROOT);
	if (comparisonKey(parent) !== comparisonKey(resolvePath(tempRoot))) return skip(GUARD_REASONS.NOT_DIRECT_CHILD);
	if (!SANDBOX_TEMP_NAME.test(basename(tempPath))) return skip(GUARD_REASONS.NAME_SHAPE);
	for (const workspace of workspaces) {
		if (typeof workspace !== 'string' || workspace.length === 0) continue;
		if (pathContains(workspace, tempPath)) return skip(GUARD_REASONS.INSIDE_WORKSPACE);
	}
	let present = false;
	let directory = false;
	try {
		present = exists(tempPath);
		if (present) directory = stat(tempPath).isDirectory();
	} catch {
		// An unreadable path is not a target: never act on what cannot be inspected.
		return skip(GUARD_REASONS.EXISTS_NOT_DIRECTORY);
	}
	if (present && !directory) return skip(GUARD_REASONS.EXISTS_NOT_DIRECTORY);
	if (present && requireMissing) return skip(GUARD_REASONS.ALREADY_EXISTS);
	return { action: 'heal', reason: present ? GUARD_REASONS.ALREADY_EXISTS : 'missing', path: tempPath, tempRoot };
}
/** The package whose `tempWriteSid`/`AclWriteGrant` the seam's own grant uses. */
const ACL_PACKAGE = '@deepseek-ai/dsh-sandbox-windows-acl';
/** The seam that owns that package's grant (the resolution fallback base). */
const SANDBOX_LOCAL_PACKAGE = '@deepseek-ai/dsh-sandbox-local';
/** Memoized loader verdict: one attempt per process, including a failed one. */
let aclApiPromise;
/**
 * Load the ACL grant API lazily, or `undefined` when this deployment does not
 * have it. Tried in order: the bare specifier from this module, then from
 * `dsh-sandbox-local`'s own resolved location (that package declares it as a
 * real dependency, so its directory always has it when the seam runs at all).
 * A failed first attempt is memoized, so a deployment without the package pays
 * one resolution attempt and never a per-call `throw/catch`.
 * @returns the module namespace with `tempWriteSid` and `AclWriteGrant`, or `undefined`.
 */
export function loadAclGrantApi() {
	aclApiPromise ??= (async () => {
		try {
			return await import(ACL_PACKAGE);
		} catch {
			try {
				const require = createRequire(import.meta.url);
				const sibling = require.resolve(SANDBOX_LOCAL_PACKAGE);
				const viaSibling = createRequire(sibling);
				return await import(pathToFileURL(viaSibling.resolve(ACL_PACKAGE)).href);
			} catch {
				return undefined;
			}
		}
	})();
	return aclApiPromise;
}
/**
 * The guard one executor instance drives.
 *
 * Every dependency that touches the world is injectable, so the audit exercises
 * the whole decision table — including the mkdir/grant failure paths — without
 * creating anything under the real OS temp root or editing any real DACL.
 */
export class SandboxTempGuard {
	/** Every report this instance produced, oldest first. */
	reports = [];
	/** Heals started by the (synchronous) stderr channel; `settle()` awaits them. */
	pendingHeals = [];
	/** The seam's private roots this row has been handed, newest last (bounded). */
	seenTempArgvs = [];
	/** Private roots this process has SEEN in the temp directories (paths, bounded). */
	ambientRoots = [];
	constructor(options = {}) {
		this.enabledOf = options.enabled ?? (() => getSandboxTempGuardEnabled());
		this.warn = options.warn ?? (() => {});
		this.tempRootsOf = options.tempRoots ?? (() => tempRoots());
		this.workspaceRootsOf = options.workspaceRoots ?? (() => []);
		this.internals = options.internals ?? {};
	}
	/** Whether the row's knob lets this guard act at all. */
	get enabled() {
		return this.enabledOf() !== false;
	}
	/** The fs seam (injectable for tests). */
	fs() {
		return {
			exists: this.internals.exists ?? existsSync,
			stat: this.internals.stat ?? statSync,
			mkdir: this.internals.mkdir ?? ((path) => mkdirSync(path)),
			readdir: this.internals.readdir ?? ((path) => readdirSync(path))
		};
	}
	/** The ACL API seam (injectable for tests). */
	async aclApi() {
		return this.internals.aclApi === undefined ? await loadAclGrantApi() : await this.internals.aclApi();
	}
	/** Record one report and hand it back. */
	record(report) {
		this.reports.push(report);
		// Bounded on purpose: this instance lives as long as the row, so an
		// unbounded log would grow with every confined command the deployment runs.
		if (this.reports.length > 32) this.reports.splice(0, this.reports.length - 32);
		return report;
	}
	/** Classify against this instance's roots plus the caller's per-call ones. */
	classify(tempPath, extraRoots = [], requireMissing = true) {
		return classifySandboxTempTarget(tempPath, {
			tempRoots: this.tempRootsOf(),
			workspaceRoots: [...this.workspaceRootsOf(), ...extraRoots],
			exists: this.fs().exists,
			stat: this.fs().stat,
			requireMissing
		});
	}
	/**
	 * The proactive channel: make the `--temp` a confined spawn is about to use
	 * usable again, BEFORE the runner is started.
	 * @param confined - the `ctx.sandbox.confine()` result (its `argv` is read).
	 * @param policy - the resolved policy, for its workspace root.
	 * @returns the report; `action: 'heal'` only when something was done.
	 */
	async ensureArgvUsable(confined, policy) {
		if (!this.enabled) return this.record({ channel: 'confined-argv', action: 'skip', reason: GUARD_REASONS.DISABLED });
		const argv = confined?.argv;
		// Every seam call is a chance to learn the root this row must keep alive. On a
		// row the probe leaves unconfined this is the ONLY confine call there will ever
		// be, so without remembering it here the root would never be re-checked again.
		this.remember(confined, policy);
		const tempPath = sandboxTempArgument(argv);
		if (tempPath === undefined) return this.record({ channel: 'confined-argv', action: 'skip', reason: GUARD_REASONS.NO_TEMP_ARGUMENT });
		const extraRoots = [workspaceArgument(argv), policy?.workspaceRoot].filter((value) => typeof value === 'string' && value.length > 0);
		const verdict = this.classify(tempPath, extraRoots, true);
		if (verdict.action === 'skip') return this.record({ channel: 'confined-argv', action: 'skip', reason: verdict.reason, path: tempPath });
		// The heal's own report is spread FIRST: it carries the same keys, and the
		// channel this call came in on must win over the heal's generic one.
		return this.record({ ...(await this.heal(tempPath, extraRoots)), channel: 'confined-argv' });
	}
	/**
	 * The fallback channel: read one settled stderr for the runner's
	 * missing-temp signature and heal for the NEXT command. The call that failed
	 * is never retried (a retry would run a command the caller already saw
	 * settle); the heal is started here and awaited only by {@link settle}.
	 * @param stderr - the settled stderr text.
	 * @returns the path the runner named, or `undefined` when it named none.
	 */
	observeRunnerStderr(stderr) {
		if (!this.enabled) return undefined;
		const tempPath = missingTempDirectoryOf(stderr);
		if (tempPath === undefined) return undefined;
		const pending = this.heal(tempPath, []).then(
			(report) => report,
			(error) => ({ channel: 'runner-stderr', action: 'heal', path: tempPath, outcome: HEAL_OUTCOMES.GRANT_FAILED, detail: String(error?.message ?? error) })
		);
		this.pendingHeals.push(pending);
		return tempPath;
	}
	/** Await every heal the stderr channel started (tests and shutdown). */
	async settle() {
		const pending = this.pendingHeals;
		this.pendingHeals = [];
		return await Promise.all(pending);
	}
	/**
	 * Remember one seam call's confined argv, so its private root can be re-checked
	 * later even if no confined command ever runs again.
	 *
	 * This is what makes the repair reach a row that never confines: the once-per-row
	 * probe hands over the seam's cached \`dsh-<6>\` exactly once, and after that the
	 * row runs unconfined forever — so nothing else would ever notice the root being
	 * deleted out of band, which is precisely when the harness that shares the same
	 * (session, workspace root) cache entry starts failing every command.
	 * @param confined - the \`ctx.sandbox.confine()\` result.
	 * @param policy - the resolved policy, replayed when a later heal needs it.
	 */
	remember(confined, policy) {
		const tempPath = sandboxTempArgument(confined?.argv);
		if (tempPath === undefined) return;
		const entry = { argv: confined.argv, policy };
		this.seenTempArgvs = [...this.seenTempArgvs.filter((seen) => sandboxTempArgument(seen.argv) !== tempPath), entry].slice(-4);
	}
	/**
	 * Re-check every remembered root, healing the ones that have vanished.
	 *
	 * Deliberately cheap: an \`existsSync\` per remembered root (normally exactly one)
	 * and a heal only when a root is really gone, so a timer may call it often.
	 * @returns the reports of the roots that were repaired.
	 */
	/**
	 * Learn every private root the OS temp directories currently hold.
	 *
	 * This is the one source that does NOT need the seam: a directory listing is a
	 * fact this process can read for itself, and it is the only way to notice a root
	 * the plugin will never be handed. Measured on this host: the harness's own
	 * confined tools keep a private root of their own, separate from every row's — and
	 * a directory deleted out of band is invisible to a later listing, so remembering
	 * it BEFORE it vanishes is what makes the later repair possible.
	 * @returns how many roots the listing produced.
	 */
	rememberAmbient() {
		const fs = this.fs();
		const found = [];
		for (const root of this.tempRootsOf()) {
			let entries;
			try {
				entries = fs.readdir(root);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (typeof entry === 'string' && SANDBOX_TEMP_NAME.test(entry)) found.push(resolvePath(root, entry));
			}
		}
		if (found.length === 0) return 0;
		const seen = new Set(this.ambientRoots);
		for (const path of found) seen.add(path);
		// Bounded: the list lives as long as the row, and a deployment creates one root
		// per (session, workspace root) per row — a handful, not a stream.
		this.ambientRoots = [...seen].slice(-16);
		return found.length;
	}
	/**
	 * Recreate every remembered root that has since vanished.
	 * @returns the reports of the roots that were repaired.
	 */
	async ensureAmbient() {
		if (!this.enabled) return [];
		const repaired = [];
		for (const tempPath of this.ambientRoots) {
			if (this.fs().exists(tempPath)) continue;
			const verdict = this.classify(tempPath, [], true);
			if (verdict.action === 'skip') continue;
			repaired.push(this.record({ ...(await this.heal(tempPath, [])), channel: 'ambient-root' }));
		}
		return repaired;
	}
	async ensureSeen() {
		if (!this.enabled) return [];
		const repaired = [];
		for (const seen of this.seenTempArgvs) {
			const tempPath = sandboxTempArgument(seen.argv);
			if (tempPath === undefined || this.fs().exists(tempPath)) continue;
			const extraRoots = [workspaceArgument(seen.argv), seen.policy?.workspaceRoot].filter((value) => typeof value === 'string' && value.length > 0);
			const verdict = this.classify(tempPath, extraRoots, true);
			if (verdict.action === 'skip') continue;
			repaired.push(this.record({ ...(await this.heal(tempPath, extraRoots)), channel: 'temp-watch' }));
		}
		return repaired;
	}
	/**
	 * Recreate one missing private temp directory and restore the seam's write
	 * grant on it. Re-checks the shape/scope gates first (an existence race is
	 * tolerated, because a recreated directory is what we wanted anyway), and
	 * never deletes anything.
	 * @param tempPath - the path to restore.
	 * @param extraRoots - additional workspace roots to stay out of.
	 * @returns the report.
	 */
	async heal(tempPath, extraRoots = []) {
		const verdict = this.classify(tempPath, extraRoots, false);
		if (verdict.action === 'skip') return { channel: 'heal', action: 'skip', reason: verdict.reason, path: tempPath };
		const fs = this.fs();
		try {
			fs.mkdir(tempPath);
		} catch (error) {
			if (error?.code !== 'EEXIST') {
				this.warn(
					'sandbox-temp-guard',
					`could not recreate the sandbox private temp directory ${tempPath} (${String(error?.code ?? error?.message ?? error)}); the next confined command will keep failing until it can be created.`
				);
				return { channel: 'heal', action: 'heal', path: tempPath, outcome: HEAL_OUTCOMES.MKDIR_FAILED, detail: String(error?.code ?? error?.message ?? error) };
			}
		}
		const api = await this.aclApi();
		if (api === undefined || typeof api.tempWriteSid !== 'function' || typeof api.AclWriteGrant?.create !== 'function') {
			this.warn(
				'sandbox-temp-guard',
				`recreated the sandbox private temp directory ${tempPath}, but ${ACL_PACKAGE} could not be loaded, so its write grant was NOT restored; a confined child writing its own $env:TEMP may still be denied.`
			);
			return { channel: 'heal', action: 'heal', path: tempPath, outcome: HEAL_OUTCOMES.EXISTENCE_ONLY, detail: 'acl-api-unavailable' };
		}
		let grant;
		try {
			grant = api.AclWriteGrant.create(api.tempWriteSid(tempPath));
			// STANDING on purpose: dispose() must free the local SID allocations
			// without revoking the ACE this heal just restored — the same shape
			// dsh-sandbox-local uses for the workspace reuse cache. The seam still
			// owns revocation through its own (now stale-path) capability, which is
			// disposed with the provider.
			grant.add(tempPath, true);
		} catch (error) {
			try {
				grant?.dispose();
			} catch {
				// The grant's own cleanup failure must not mask the original one.
			}
			this.warn(
				'sandbox-temp-guard',
				`recreated the sandbox private temp directory ${tempPath}, but restoring its write grant failed (${String(error?.message ?? error)}); a confined child writing its own $env:TEMP may be denied.`
			);
			return { channel: 'heal', action: 'heal', path: tempPath, outcome: HEAL_OUTCOMES.GRANT_FAILED, detail: String(error?.message ?? error) };
		}
		try {
			grant.dispose();
		} catch (error) {
			this.warn('sandbox-temp-guard', `restored the write grant on ${tempPath}, but freeing the grant handle reported: ${String(error?.message ?? error)}`);
		}
		this.warn(
			'sandbox-temp-guard',
			`the sandbox private temp directory ${tempPath} had been removed out of band; recreated it and restored its write grant.`
		);
		return { channel: 'heal', action: 'heal', path: tempPath, outcome: HEAL_OUTCOMES.HEALED };
	}
}
/**
 * The workspace root the runner was told to confine, or `undefined`.
 * @param argv - the confined argv.
 * @returns the `--workspace` value.
 */
export function workspaceArgument(argv) {
	if (!Array.isArray(argv)) return undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (typeof token !== 'string') continue;
		if (token === '--') return undefined;
		if (token === '--workspace') {
			const value = argv[index + 1];
			return typeof value === 'string' && value.length > 0 ? value : undefined;
		}
	}
	return undefined;
}
