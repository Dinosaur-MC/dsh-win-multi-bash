import { spawnSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from "../vendor/helpers.js";
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
/**
 * Derive a config schema from a base object schema WITHOUT mutating it.
 * schemastery's Schema#set() mutates the shared `dict` in place, so chaining
 * .set() on LocalBashExecutor.Config lets whichever subclass module loads
 * last overwrite the earlier one's fields — git-bash's probeTimeoutMs default
 * silently became wsl-bash's 30000 and its sandbox union gained the invalid
 * 'bwrap' value. Spreading the base dict into a fresh z.object makes every
 * derivation independent of both the base and other subclasses.
 */
function deriveConfig(base, fields) {
	const derived = z.object({ ...base.dict });
	if (base.meta !== void 0) derived.meta = { ...base.meta };
	for (const key of Object.keys(fields)) derived.set(key, fields[key]);
	return derived;
}
/**
 * The PATH handed to MSYS bash: the resolved Git installation's layout dirs
 * (`<root>\cmd`, `<root>\bin`, `<root>\usr\bin`) prepended to the inherited
 * PATH. The spawn environment is the scrubbed parent env with explicit
 * overrides, so without this the Git toolchain (sleep, grep, git, ...) would
 * be invisible inside bash even though bash.exe itself is spawned by absolute
 * path. The root is inferred from the bash location (`<root>\usr\bin\bash.exe`
 * or `<root>\bin\bash.exe`); when the location does not look like a Git layout
 * (e.g. a PATH-resolved foreign bash) only its own directory is prepended.
 */
function gitToolPath(bashPath, inheritedPath) {
	const binDir = dirname(bashPath);
	const base = basename(binDir).toLowerCase();
	const parent = dirname(binDir);
	const parentBase = basename(parent).toLowerCase();
	let root;
	if (base === "cmd") root = parent;
	else if (base === "bin") root = parentBase === "usr" ? dirname(parent) : parent;
	const dirs = [];
	if (root !== void 0) {
		for (const dir of [join(root, "cmd"), join(root, "bin"), join(root, "usr", "bin")]) {
			if (!dirs.includes(dir)) dirs.push(dir);
		}
	} else {
		dirs.push(binDir);
	}
	const rest = (inheritedPath ?? "").split(";").filter((entry) => entry.length > 0);
	return [...dirs, ...rest].join(";");
}
//#region lib/types/resolve.js
/**
* Git Bash executable resolution for the bash-git executor, dependency-free
* and parameterized (env/platform) so resolution is a pure function of its
* inputs on every platform — the twin of dsh-pwsh-local's resolvePwshPath.
* @module @deepseek-ai/dsh-bash-git/resolve
*/
/**
* Infer Git for Windows install roots from PATH entries shaped like its
* layout directories (`<root>\cmd`, `<root>\bin`, `<root>\usr\bin`) that
* actually contain `git.exe`. This lets resolution find a Git Bash that lives
* outside the well-known Program Files probes (e.g. `D:\Program Files\Git`
* with only `cmd` on PATH) without any manual pin. Only directories carrying a
* real `git.exe` qualify, so unrelated `bin` dirs (Strawberry Perl, Scoop
* shims, ...) are never mistaken for Git roots.
* @param env - the environment to probe; defaults to the process environment.
* @returns Git install roots in PATH order.
*/
function gitRootCandidates(env = process.env) {
	const roots = [];
	const seen = new Set();
	for (const entry of (env.PATH ?? "").split(";")) {
		const trimmed = entry.trim().replace(/^"|"$/g, "");
		if (trimmed.length === 0) continue;
		const base = basename(trimmed).toLowerCase();
		if (base !== "cmd" && base !== "bin") continue;
		const parent = dirname(trimmed);
		const root = base === "cmd" || basename(parent).toLowerCase() !== "usr" ? parent : dirname(parent);
		if (!candidateExists(join(trimmed, "git.exe"))) continue;
		const key = root.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			roots.push(root);
		}
	}
	return roots;
}
/**
* The well-known Git for Windows layout under one Program Files root
* (`<root>\Git\bin\bash.exe` and `<root>\Git\usr\bin\bash.exe`). Shared by the
* env `ProgramFiles` probes and the per-drive probes so an install on a
* non-C: drive (e.g. `D:\Program Files\Git`) is found without a pin.
* @param programFilesRoot - one Program Files root (e.g. `C:\Program Files`).
* @returns the two layout-shaped bash candidates under that root.
*/
function gitCandidatesUnder(programFilesRoot) {
	return [
		join(programFilesRoot, "Git", "bin", "bash.exe"),
		join(programFilesRoot, "Git", "usr", "bin", "bash.exe")
	];
}
/**
* The drive letters to probe for the well-known Git layout. An explicit
* `GitProbeDrives` env value (comma/space/`;`-separated letters) replaces the
* default of every existing fixed drive; the empty string disables drive
* probing entirely. Test fixtures use that override so resolution stays a pure
* function of the injected env.
* @param env - the environment to probe; defaults to the process environment.
* @returns existing drive roots in probe order (e.g. `C:\`, `D:\`).
*/
function probeDrives(env = process.env) {
	const override = env.GitProbeDrives;
	const letters = override !== void 0 && override.trim().length > 0
		? override.split(/[,;\s]+/).map((s) => s.trim().replace(/:$/, "")).filter((s) => s.length > 0)
		: override !== void 0 ? [] : "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
	const drives = [];
	for (const letter of letters) {
		const root = `${letter.charAt(0).toUpperCase()}:\\`;
		if (existsSync(root)) drives.push(root);
	}
	return drives;
}
/**
* Git Bash candidate paths in resolution order: Git roots inferred from PATH
* `git.exe` layout dirs first (the strongest signal — a real install, however
* it got on PATH), then the well-known Program Files layout under every fixed
* drive (covers non-C: installs), then every PATH entry. The Windows WSL
* launcher (`System32\bash.exe`) and the `WindowsApps` alias directories are
* deliberately excluded, and candidates are only accepted when they are real
* regular files (symlinks/reparse points rejected), so a stale WSL
* app-execution alias can never shadow a real Git Bash. PATH entries shaped
* like Git layout directories with a real `git.exe` additionally contribute
* their `<root>\usr\bin` and `<root>\bin` bash candidates via the first step,
* so an install reachable through `git` on PATH is found automatically.
* @param env - the environment to probe; defaults to the process environment.
* @returns candidate `bash.exe` paths in resolution order.
*/
function candidateBashPaths(env = process.env) {
	const wslLauncher = join(env.SystemRoot ?? "C:\\Windows", "System32", "bash.exe").toLowerCase();
	const candidates = [];
	for (const root of gitRootCandidates(env)) {
		for (const candidate of [join(root, "usr", "bin", "bash.exe"), join(root, "bin", "bash.exe")]) {
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
	}
	for (const pf of [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"]) {
		for (const candidate of gitCandidatesUnder(pf)) {
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
	}
	for (const drive of probeDrives(env)) {
		for (const candidate of gitCandidatesUnder(join(drive, "Program Files"))) {
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
	}
	for (const entry of (env.PATH ?? "").split(";")) {
		const trimmed = entry.trim().replace(/^"|"$/g, "");
		if (trimmed.length === 0) continue;
		const candidate = join(trimmed, "bash.exe");
		if (candidate.toLowerCase() === wslLauncher) continue;
		if (basename(trimmed).toLowerCase() === "windowsapps") continue;
		if (!candidates.includes(candidate)) candidates.push(candidate);
	}
	return candidates;
}
/**
* Whether a candidate path is a real regular file. Symlinks and reparse
* points — the shape of broken Windows app-execution aliases such as a stale
* `WindowsApps\bash.exe` — are rejected, so a dead WSL alias never resolves as
* a Git Bash.
* @param candidate - the absolute candidate path.
* @returns true only for an existing non-link regular file.
*/
function candidateExists(candidate) {
	try {
		const stat = lstatSync(candidate);
		return stat.isFile();
	} catch {
		return false;
	}
}
/**
* Resolve the Git Bash executable this executor spawns. Returns undefined on
* win32 when no candidate exists (the executor turns that into a loud
* route-time error naming the probes); non-win32 hosts resolve a bare
* `bash` for PATH resolution, mirroring resolvePwshPath.
* @param configured - an explicit `bashPath` config value, trusted as-is.
* @param env - the environment to probe on Windows; defaults to the process environment.
* @param platform - the platform to resolve for; defaults to the process platform.
* @returns the first existing well-known location on win32, else `bash`, else undefined.
*/
function resolveBashPath(configured, env = process.env, platform = process.platform) {
	if (configured !== void 0 && configured.length > 0) return configured;
	if (platform === "win32") {
		for (const candidate of candidateBashPaths(env)) if (candidateExists(candidate)) return candidate;
		return;
	}
	return "bash";
}
/**
* Registry-backed Git Bash locations: Git for Windows always records its
* install path at `HKLM\SOFTWARE\GitForWindows\InstallPath`, which is the
* reliable signal for installs outside every probe path (custom drives,
* portable installs, ...). Read via `reg query` (spawnSync) — any failure is
* an empty list, so a missing registry never breaks resolution.
* @returns the first existing bash.exe under the registered install, or undefined.
*/
function registryBashPaths() {
	if (process.platform !== "win32") return;
	try {
		const run = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\GitForWindows", "/v", "InstallPath"], {
			encoding: "utf8",
			timeout: 1e4
		});
		if (run.status !== 0 || run.error !== void 0) return;
		const line = run.stdout.split(/\r?\n/).find((l) => /InstallPath/i.test(l) && /REG_SZ/i.test(l));
		const install = line?.split("REG_SZ")[1]?.trim();
		if (install === void 0 || install.length === 0) return;
		for (const candidate of [join(install, "usr", "bin", "bash.exe"), join(install, "bin", "bash.exe")]) {
			if (candidateExists(candidate)) return candidate;
		}
	} catch {
		/* registry probe must never break resolution */
	}
}
//#endregion
//#region lib/types/index.js
/**
* Git Bash Service Provider for the bash capability seam: a LocalBashExecutor
* whose argv is `[bashPath, '-c', command]` (MSYS bash, clean profile-less
* environment). Sandbox policy `auto` probes whether the windows-acl runner
* can launch Cygwin bash (once, lazily, at the first sandboxMode read or the
* first routed command); when the probe fails, commands run unconfined and
* results honestly carry no sandbox facts (the declared auto contract).
* `none` never consults `ctx.sandbox`. The executable is resolved lazily at
* the first routed command and fails loud, naming the probes, when Git Bash
* is missing.
* @module @deepseek-ai/dsh-bash-git
*/
/**
* Git Bash executor over the local bash mechanics: argv is the resolved
* `bash.exe` followed by `-c` and the command, and the
* sandbox stance (`auto`/`none`) is applied lazily per the
* module doc's probe contract.
*/
var GitBashExecutor = class extends LocalBashExecutor {
	static Config = deriveConfig(LocalBashExecutor.Config, {
		bashPath: z.string().volatile(),
		sandbox: z.union([z.const("auto"), z.const("none")]).default("auto").volatile(),
		probeTimeoutMs: z.natural().default(1e4).volatile(),
		requireSandbox: z.boolean().default(false).volatile()
	});
	/** Test hook mirroring the sandbox-local internals pattern. */
	internals = {};
	/**
	 * The row's own knobs are declared `.volatile()`, so the loader hands each
	 * one a live reference rather than a snapshot (the same shape the inherited
	 * `cwd` / `timeoutMs` fields already have). Every read goes through `.get()`,
	 * which is what makes a value saved on the Plugins page apply to the next
	 * command without reloading the row.
	 */
	get sandboxStance() {
		return this.config.sandbox.get();
	}
	get probeTimeoutMs() {
		return this.config.probeTimeoutMs.get();
	}
	get requireSandbox() {
		return this.config.requireSandbox.get();
	}
	/** Memoized probe promise; the provider's `confine` is async as of 0.1.7. */
	confinedProbe;
	/** The verdict `resolveSandboxMode` settled on, read back by the sync getter. */
	sandboxModeVerdict;
	/** The knob values that verdict was settled for, so a live stance edit re-settles. */
	sandboxModeVerdictKey;
	constructor(ctx, config) {
		super(ctx, config);
	}
	/**
	 * The capability fact: the policy default mode while confinement is usable.
	 * The probe is async (the provider's `confine` returns a promise), so the
	 * tool layer awaits {@link resolveSandboxMode} before reading this; until
	 * then the mode is undeclared.
	 */
	get sandboxMode() {
		return this.sandboxModeVerdict;
	}
	/**
	 * Settle this executor's advertised sandbox mode. With `requireSandbox`,
	 * the mode is declared even when the probe fails, so the tool layer
	 * advertises escalation (`sandbox_permissions`) and the executor can refuse
	 * unconfined runs outside danger-full-access.
	 * @returns the mode to advertise, or `undefined` for an unconfining deployment.
	 */
	async resolveSandboxMode() {
		const stance = this.sandboxStance;
		const verdictKey = `${stance}|${String(this.requireSandbox)}`;
		if (this.sandboxModeVerdictKey === verdictKey) return this.sandboxModeVerdict;
		this.sandboxModeVerdictKey = verdictKey;
		if (stance === "none") return this.sandboxModeVerdict = void 0;
		if (this.requireSandbox) return this.sandboxModeVerdict = this.ctx.sandboxPolicy.defaultMode;
		return this.sandboxModeVerdict = await this.probeConfinedOnce() ? this.ctx.sandboxPolicy.defaultMode : void 0;
	}
	/** The exact argv every (un)confined command runs through. */
	gitArgv(spec) {
		return [
			this.bashPath(),
			"-c",
			spec.command
		];
	}
	/** The resolved Git Bash executable; undefined resolves to a loud route-time error. */
	tryBashPath() {
		const path = (this.internals.resolveBashPath ?? ((configured) => resolveBashPath(configured)))(this.config.bashPath.get());
		if (path !== void 0) return path;
		return (this.internals.registryBashPaths ?? registryBashPaths)();
	}
	/** Route-time loud failure naming the probes, per the spec error contract. */
	bashPath() {
		const path = this.tryBashPath();
		if (path !== void 0) return path;
		throw new Error(`bash-git: Git Bash was not found (probed ${candidateBashPaths().join(", ")} and the GitForWindows registry). Install Git for Windows or set gitBash.bashPath on the git_bash tool row.`);
	}
	/**
	* Probe whether the windows-acl runner can launch bash.exe, once per
	* executor lifetime (lazy: the first {@link resolveSandboxMode} await or the
	* first routed command). Wraps a trivial `exit 0` through the provider and
	* runs it (mirroring sandbox-local's defaultProbeWindowsAcl shape); a wrap
	* rejection, a spawn rejection, or a non-zero exit all mean no confinement.
	* @returns the memoized verdict.
	*/
	probeConfinedOnce() {
		this.confinedProbe ??= this.probeConfined();
		return this.confinedProbe;
	}
	async probeConfined() {
		const probe = this.internals.probeConfined;
		if (probe !== void 0) return probe();
		const bashPath = this.tryBashPath();
		if (bashPath === void 0) return false;
		const root = this.ctx.sandboxPolicy.resolve().workspaceRoot;
		let confined;
		try {
			confined = await this.ctx.sandbox.confine([
				bashPath,
				"-c",
				"exit 0"
			], {
				mode: "read-only",
				workspaceRoot: root
			});
		} catch {
			return false;
		}
		const runner = confined.argv[0];
		if (runner === void 0) return false;
		const probeRun = spawnSync(runner, confined.argv.slice(1), {
			timeout: this.probeTimeoutMs,
			cwd: root,
			stdio: "ignore"
		});
		return probeRun.status === 0;
	}
	confinedPolicy(spec) {
		return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
	}
	/** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
	processFacts = /* @__PURE__ */ new Map();
	/**
	 * Execute one resolved spec through the confined (or unconfined) Git Bash
	 * argv. Foreground is a property of awaiting `result()`, not of the call —
	 * one handle serves both call styles, as the 0.1.7 seam defines it.
	 * Confinement is probe-gated; runner evidence at execution time falls back
	 * to an unconfined run (the documented lazy contract) so a windows-acl
	 * runner that cannot launch MSYS bash never bricks the backend.
	 * @param spec - the resolved execution spec from {@link resolve}.
	 * @returns the live handle; sandbox facts land on both `proc.sandbox` (at
	 *   settlement) and the decorated `result()`.
	 */
	async execute(spec) {
		const policy = this.confinedPolicy(spec);
		if (policy.mode === "danger-full-access") return GitBashExecutor.decorateResult(await this.executeArgv(spec, this.gitArgv(spec)), (result) => ({
			...result,
			sandbox: {
				mode: "danger-full-access",
				denied: false
			}
		}));
		if (this.sandboxStance === "none") return this.executeArgv(spec, this.gitArgv(spec));
		if (!await this.probeConfinedOnce()) {
			if (this.requireSandbox) throw new Error("bash-git: sandbox unavailable — the windows-acl runner cannot confine MSYS bash (probe failed); refusing to run unconfined under " + policy.mode + " mode. Fix the sandbox or retry the command with sandbox_permissions: \"danger-full-access\" and a justification.");
			return this.executeArgv(spec, this.gitArgv(spec));
		}
		let confined;
		const proc = await this.executeArgv(spec, async (signal) => {
			confined = await this.ctx.sandbox.confine(this.gitArgv(spec), {
				...policy,
				mode: policy.mode
			}, signal);
			return confined.argv;
		}, (started) => {
			const facts = confined;
			if (facts === void 0) return;
			this.processFacts.set(started, {
				mode: policy.mode,
				enforcement: facts.enforcement,
				denialSignatures: facts.denialSignatures,
				runnerFailureRules: facts.runnerFailureRules,
				runnerProgram: facts.argv[0],
				workdir: spec.workdir
			});
		});
		/** Re-run the command unconfined after runner evidence proved confinement unavailable. */
		const unconfinedFallback = async () => (await this.executeArgv(spec, this.gitArgv(spec))).result();
		return GitBashExecutor.decorateResult(proc, async (result) => {
			if (confined === void 0) return {
				...result,
				sandbox: {
					mode: policy.mode,
					denied: false
				}
			};
			if (classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules) !== void 0) return unconfinedFallback();
			return {
				...result,
				sandbox: {
					mode: policy.mode,
					denied: classifyDenial(result, confined.denialSignatures),
					enforcement: confined.enforcement
				}
			};
		}, async (error) => {
			if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
			if (confined !== void 0 && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) return unconfinedFallback();
			throw error;
		});
	}
	/**
	 * Decorate the handle's foreground projection in place, memoized once. The
	 * handle keeps its identity (never wrapped in a second object) because the
	 * per-process facts and `onProcessDone` key on the exact instance.
	 * @param proc - the live execution handle.
	 * @param map - maps the settled result.
	 * @param mapError - maps a provider rejection.
	 * @returns the same handle, with `result()` decorated.
	 */
	static decorateResult(proc, map, mapError) {
		const base = proc.result.bind(proc);
		let decorated;
		proc.result = () => {
			decorated ??= base().then(map, mapError);
			return decorated;
		};
		return proc;
	}
	/** Stamp per-process sandbox facts before `done` settles (bash-sandbox semantics). */
	onProcessDone(proc, stderr, providerRejected, providerError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			proc.sandbox = (providerRejected ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir) : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== void 0) ? {
				mode: facts.mode,
				denied: false,
				enforcement: facts.enforcement,
				runnerFailed: true
			} : {
				mode: facts.mode,
				denied: matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
				enforcement: facts.enforcement
			};
		}
		super.onProcessDone(proc, stderr, providerRejected, providerError);
	}
	resolve(request) {
		const bashPath = this.tryBashPath();
		const env = bashPath === void 0 ? request.env : {
			...request.env,
			PATH: gitToolPath(bashPath, request.env?.PATH ?? process.env.PATH ?? "")
		};
		return {
			...super.resolve({ ...request, env }),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
};
//#endregion
export { GitBashExecutor, GitBashExecutor as default, candidateBashPaths, candidateExists, gitCandidatesUnder, gitRootCandidates, gitToolPath, probeDrives, registryBashPaths, resolveBashPath };
