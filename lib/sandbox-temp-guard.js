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
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
/** The tool-layer knob that turns healing off; declared `.volatile()` on every tool row. */
export const SANDBOX_TEMP_GUARD_KNOB = 'guardSandboxTemp';
/** The knob's default: healing is ON, so a deployment needs no edit to be protected. */
export const SANDBOX_TEMP_GUARD_DEFAULT = true;
/** The private temp root's name shape: mkdtemp over the prefix `dsh-<6 alphanumerics>`. */
export const SANDBOX_TEMP_NAME = /^dsh-[A-Za-z0-9]{6}$/;
/** The runner's missing-temp signature, with the path it names in group 1. */
export const RUNNER_MISSING_TEMP = /--temp is not an existing directory:\s*(.+?)\s*$/m;
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
export function pathContains(root, candidate) {
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
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (typeof token !== 'string') continue;
		if (token === '--') return undefined;
		if (token === '--temp') {
			const value = argv[index + 1];
			return typeof value === 'string' && value.length > 0 ? value : undefined;
		}
		if (token.startsWith('--temp=')) {
			const value = token.slice('--temp='.length);
			return value.length > 0 ? value : undefined;
		}
	}
	return undefined;
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
	constructor(options = {}) {
		this.enabledOf = options.enabled ?? (() => SANDBOX_TEMP_GUARD_DEFAULT);
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
			mkdir: this.internals.mkdir ?? ((path) => mkdirSync(path))
		};
	}
	/** The ACL API seam (injectable for tests). */
	async aclApi() {
		return this.internals.aclApi === undefined ? await loadAclGrantApi() : await this.internals.aclApi();
	}
	/** Record one report and hand it back. */
	record(report) {
		this.reports.push(report);
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
