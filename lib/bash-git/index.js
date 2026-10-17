import { spawn, spawnSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { ShellExecutorBase, deriveConfig, probeDeadline, sharedStanceConfig } from "../shell-executor.js";
import { SANDBOX_NOTICE_LEVELS, dialectById } from "../shell-dialects.js";
import { classifyRunnerFailure, denialFacts, isRunnerSpawnFailure, learnedDenialSignature } from "../vendor/helpers.js";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
/**
 * Derive a config schema from a base object schema WITHOUT mutating it.
 * schemastery's Schema#set() mutates the shared `dict` in place, so chaining
 * .set() on LocalBashExecutor.Config lets whichever subclass module loads
 * last overwrite the earlier one's fields — git-bash's probeTimeoutMs default
 * silently became wsl-bash's (30000 at the time; 8000 since 0.2.1-alpha.2
 * alignment) and its sandbox union gained the invalid
 * 'bwrap' value. Spreading the base dict into a fresh z.object makes every
 * derivation independent of both the base and other subclasses.
 */
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
var GitBashExecutor = class extends ShellExecutorBase {
	/** The dialect prefix every warning from this row carries. */
	static logName = "bash-git";
	static Config = deriveConfig(LocalBashExecutor.Config, {
		bashPath: z.string().volatile(),
		// The stance vocabulary is the dialect declaration's (`lib/shell-dialects.js`)
		// — `['auto', 'none']` for MSYS, deliberately not merged with wsl's.
		...sharedStanceConfig(dialectById("msys").sandboxStances, 4e3, SANDBOX_NOTICE_LEVELS)
	});
	
	
	/** Memoized probe promise; the provider's `confine` is async as of 0.1.7. */
	confinedProbe;
	
	/** The verdict `resolveSandboxMode` settled on, read back by the sync getter. */
	sandboxModeVerdict;
	/** The knob values that verdict was settled for, so a live stance edit re-settles. */
	sandboxModeVerdictKey;
	
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
	/**
	 * The argv of one persistent interactive Git Bash session: the resolved
	 * `bash.exe` with `-i` and nothing else.
	 *
	 * Deliberately no `--noprofile --norc`: a session exists so that the shell's
	 * own state — `alias`, exported functions, the user's prompt — is there, and
	 * suppressing the startup files would remove exactly that. The command tool is
	 * the one that wants a clean shell; this one does not.
	 * @returns argv for `ctx.subprocess.spawnTerminal`.
	 */
	terminalArgv() {
		return [this.bashPath(), "-i"];
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
		const resolve = (configured) => (this.internals.resolveBashPath ?? ((value) => resolveBashPath(value)))(configured);
		const configured = this.config.bashPath.get();
		const path = resolve(configured);
		// Status quo until A3 (recorded in the task report): a configured pin was
		// returned verbatim, so a stale path surfaced later as a bare spawn ENOENT.
		// Now the pin is used only when it is really there; otherwise the row
		// discovers Git for Windows at RUNTIME and warns once. Config is never
		// edited from here — the stored value stays byte-for-byte as the user left it.
		if (configured !== void 0 && configured.length > 0 && path === configured && !candidateExists(configured)) {
			this.warnOnce("bashPath", `gitBash.bashPath ${JSON.stringify(configured)} does not exist; falling back to auto-discovery (PATH, well-known installs, then the registry).`);
			const discovered = resolve(undefined);
			if (discovered !== void 0) return discovered;
			return (this.internals.registryBashPaths ?? registryBashPaths)();
		}
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
		return await this.runConfinedProbe();
	}
	/** Memoized denial-dialect promise: learned before the row's first confined run. */
	denialPromise;
	/**
	 * Learn this host's denial dialect once, before the row's first confined
	 * command. The capability probe on the apply path no longer pays for it, and
	 * every failure path still leaves the row on the provider's own signatures
	 * (see {@link discoverDenialSignature}).
	 * @returns the learned signature, or undefined.
	 */
	ensureDenialDialect() {
		this.denialPromise ??= this.discoverDenialSignature();
		return this.denialPromise;
	}
	/**
	 * Learn this host's denial dialect, once per row: after the functional probe
	 * proved the sandbox can confine, run one *doomed* write OUTSIDE the granted
	 * root (a random name in the workspace root's parent) and keep the stable part
	 * of what the refusal printed. The provider ships a fixed English dialect, but
	 * the text comes from whatever program the command ran in whatever language
	 * the host uses (`learnedDenialSignature` documents the limits).
	 *
	 * Harmlessness is asserted, not assumed: the target must not exist afterwards;
	 * if it does — meaning the write was NOT refused on this host — the file is
	 * removed immediately and the discovery is recorded as invalid instead of
	 * becoming a signature. Every failure path (no bash, confine throwing, a
	 * timeout, an unusable message) returns undefined and leaves the row running on
	 * the provider's signatures: this can never fail the row's apply.
	 * @returns the learned signature, or undefined.
	 */
	async discoverDenialSignature() {
		if (this.denialDiscovery !== undefined) return this.denialDiscovery;
		const bashPath = this.tryBashPath();
		if (bashPath === void 0) return this.denialDiscovery = undefined;
		const root = this.ctx.sandboxPolicy.resolve().workspaceRoot;
		const name = `.dsh-denial-probe-${randomUUID().slice(0, 8)}`;
		const target = join(dirname(root), name);
		let confined;
		try {
			confined = await this.confineRun([bashPath, "-c", `printf x > ../${name}`], {
				mode: "read-only",
				workspaceRoot: root
			}, probeDeadline(() => this.probeTimeoutMs));
		} catch {
			return this.denialDiscovery = undefined;
		}
		const stderr = await new Promise((resolve) => {
			const child = spawn(confined.argv[0], confined.argv.slice(1), {
				cwd: root,
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true
			});
			let text = "";
			child.stderr?.on("data", (chunk) => {
				text += String(chunk);
			});
			const timer = setTimeout(() => {
				child.kill();
				resolve(text);
			}, this.probeTimeoutMs);
			child.on("error", () => {
				clearTimeout(timer);
				resolve("");
			});
			child.on("close", () => {
				clearTimeout(timer);
				resolve(text);
			});
		});
		if (existsSync(target)) {
			rmSync(target, { force: true });
			this.denialDiscoveryInvalid = true;
			return this.denialDiscovery = undefined;
		}
		return this.denialDiscovery = learnedDenialSignature(stderr, [name, target, root]);
	}
	
	async runConfinedProbe() {
		const bashPath = this.tryBashPath();
		if (bashPath === void 0) return false;
		const root = this.ctx.sandboxPolicy.resolve().workspaceRoot;
		let confined;
		try {
			// BOUNDED: this is the row's apply-time capability probe. An unbounded
			// confine() would leave the row pending forever (a boot that never becomes
			// ready), which is strictly worse than "no confinement advertised".
			confined = await this.confineRun([
				bashPath,
				"-c",
				"exit 0"
			], {
				mode: "read-only",
				workspaceRoot: root
			}, probeDeadline(() => this.probeTimeoutMs));
		} catch {
			return false;
		}
		const runner = confined.argv[0];
		if (runner === void 0) return false;
		// This probe is async, never spawnSync: it runs inside the tool row's
		// `apply` (through resolveSandboxMode), and a synchronous child here would
		// stall the whole host event loop for up to probeTimeoutMs. That claim is
		// about THIS probe only — the PATH fallback above (`tryBashPath` →
		// `registryBashPaths`) still runs `reg query` through spawnSync with a
		// hard-coded 10s timeout (measured 23 ms on this machine 2026-10-14, when
		// the key is absent), and bash-wsl's two probes are synchronous as well
		// (measured 71 ms + 3.66 s there). Those paths are unchanged by this file.
		return await new Promise((resolve) => {
			const child = spawn(runner, confined.argv.slice(1), {
				cwd: root,
				stdio: "ignore",
				windowsHide: true
			});
			const timer = setTimeout(() => {
				child.kill();
				resolve(false);
			}, this.probeTimeoutMs);
			child.on("error", () => {
				clearTimeout(timer);
				resolve(false);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve(code === 0);
			});
		});
	}
	
	
		/** The dialect's argv: the resolved bash.exe, `-c`, and the command. */
		argv(spec) {
			return this.gitArgv(spec);
		}
		/** The once-per-row gate the base awaits: capability, then the denial dialect. */
		async confinedUsable() {
			if (!await this.probeConfinedOnce()) return false;
			// Learned before the first confined command runs, never on the apply path.
			await this.ensureDenialDialect();
			return true;
		}
		/** The fail-closed sentence for `requireSandbox` on a host the probe cannot confine. */
		sandboxUnavailableMessage(policy) {
			return "bash-git: sandbox unavailable — the windows-acl runner cannot confine MSYS bash (probe failed); refusing to run unconfined under " + policy.mode + " mode. Fix the sandbox or retry the command with sandbox_permissions: \"danger-full-access\" and a justification.";
		}
		/**
		 * Confine this spec's argv with the windows-acl provider and settle its facts.
		 *
		 * **Runner evidence at execution time fails closed**: a runner that fails to
		 * launch MSYS bash, or a classified runner failure in the settled result,
		 * throws instead of re-running the command unconfined — the silent
		 * passthrough the dsh sandbox seam forbids. The unconfined paths that remain
		 * are explicit ones: `sandbox: none`, `requireSandbox: false` with a failed
		 * probe (the declared `auto` contract, results carrying no sandbox facts) and
		 * `danger-full-access`.
		 * @param spec - the resolved execution spec from {@link resolve}.
		 * @param policy - the resolved file-effect policy.
		 * @returns the live handle; sandbox facts land on both `proc.sandbox` (at
		 *   settlement) and the decorated `result()`.
		 */
		async confinedRun(spec, policy) {
			let confined;
			const proc = await this.executeArgv(spec, async (signal) => {
				confined = await this.confineRun(this.gitArgv(spec), {
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
					denialSignatures: this.effectiveDenialSignatures(facts.denialSignatures),
					runnerFailureRules: facts.runnerFailureRules,
					runnerProgram: facts.argv[0],
					workdir: spec.workdir
				});
			});
			/**
			 * Refuse to continue when the confinement runner itself failed. Re-running
			 * the command unconfined here is the silent passthrough the dsh sandbox seam
			 * forbids ("must return enforcing argv or fail closed at wrap or
			 * runner-execution time; silent unconfined passthrough is forbidden",
			 * dsh-sandbox/src/index.ts) — and it hid the runner failure from the model.
			 * The error names the executable and both supported ways out.
			 */
			const runnerFailure = (detail) => new Error(`bash-git: the confinement runner (${confined.argv[0]}) failed before the command ran (${detail}); refusing to run unconfined under ${policy.mode} mode. Retry with sandbox_permissions: "danger-full-access" and a justification, or set sandbox: none on this tool row to accept unconfined runs.`);
			return this.constructor.decorateResult(proc, async (result) => {
				if (confined === void 0) return {
					...result,
					sandbox: {
						mode: policy.mode,
						denied: false
					}
				};
				if (classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules) !== void 0) throw runnerFailure(`exit ${String(result.exitCode)}`);
				return {
					...result,
					sandbox: {
						mode: policy.mode,
						...denialFacts(result.exitCode, result.stderr.text, this.effectiveDenialSignatures(confined.denialSignatures)),
						enforcement: confined.enforcement
					}
				};
			}, async (error) => {
				if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
				if (confined !== void 0 && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw runnerFailure(String(error?.message ?? error));
				throw error;
			});
		}	resolve(request) {
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
