import { spawnSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from "../vendor/helpers.js";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * The PATH handed to MSYS bash: the resolved Git installation's bin dirs
 * prepended to the inherited PATH. The spawn environment is the scrubbed
 * parent env with explicit overrides, so without this the Git toolchain
 * (sleep, grep, ...) would be invisible inside bash even though bash.exe
 * itself is spawned by absolute path.
 */
function gitToolPath(bashPath, inheritedPath) {
	const binDir = dirname(bashPath);
	const usrBinDir = join(binDir, "..", "usr", "bin");
	const dirs = [binDir, usrBinDir].filter((dir, index, all) => all.indexOf(dir) === index);
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
* Well-known Git for Windows install locations plus PATH entries.
* @param env - the environment to probe; defaults to the process environment.
* @returns candidate `bash.exe` paths in resolution order.
*/
function candidateBashPaths(env = process.env) {
	const programFiles = env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const candidates = [
		join(programFiles, "Git", "bin", "bash.exe"),
		join(programFiles, "Git", "usr", "bin", "bash.exe"),
		join(programFilesX86, "Git", "bin", "bash.exe")
	];
	for (const entry of (env.PATH ?? "").split(";")) {
		const trimmed = entry.trim().replace(/^"|"$/g, "");
		if (trimmed.length === 0) continue;
		candidates.push(join(trimmed, "bash.exe"));
	}
	return candidates;
}
function candidateExists(candidate) {
	try {
		const stat = lstatSync(candidate);
		return stat.isFile() || stat.isSymbolicLink();
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
		bashPath: z.string(),
		sandbox: z.union([z.const("auto"), z.const("none")]).default("auto"),
		probeTimeoutMs: z.natural().default(1e4)
	});
	/** Test hook mirroring the sandbox-local internals pattern. */
	internals = {};
	sandboxStance;
	probeTimeoutMs;
	confinedVerdict;
	constructor(ctx, config) {
		super(ctx, config);
		const entry = config;
		this.sandboxStance = entry.sandbox;
		this.probeTimeoutMs = entry.probeTimeoutMs;
	}
	/** The capability fact: the policy default mode only while confinement is usable. */
	get sandboxMode() {
		if (this.sandboxStance === "none") return void 0;
		return this.probeConfinedOnce() ? this.ctx.sandboxPolicy.defaultMode : void 0;
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
		return (this.internals.resolveBashPath ?? ((configured) => resolveBashPath(configured)))(this.config.bashPath);
	}
	/** Route-time loud failure naming the probes, per the spec error contract. */
	bashPath() {
		const path = this.tryBashPath();
		if (path !== void 0) return path;
		throw new Error(`bash-git: Git Bash was not found (probed ${candidateBashPaths().join(", ")}). Install Git for Windows or set gitBash.bashPath in the shell-select config.`);
	}
	/**
	* Probe whether the windows-acl runner can launch bash.exe, once per
	* executor lifetime (lazy: the first sandboxMode read or the first routed
	* command). Runs a trivial confined `exit 0` synchronously (mirroring
	* sandbox-local's defaultProbeWindowsAcl shape); a spawn rejection, a
	* runner-failure exit, or a missing bash.exe all mean no confinement.
	*/
	probeConfinedOnce() {
		if (this.confinedVerdict !== void 0) return this.confinedVerdict;
		const probe = this.internals.probeConfined;
		if (probe !== void 0) return this.confinedVerdict = probe();
		const bashPath = this.tryBashPath();
		if (bashPath === void 0) return this.confinedVerdict = false;
		const root = this.ctx.sandboxPolicy.resolve().workspaceRoot;
		let confined;
		try {
			confined = this.ctx.sandbox.confine([
				bashPath,
				"-c",
				"exit 0"
			], {
				mode: "read-only",
				workspaceRoot: root
			});
		} catch {
			return this.confinedVerdict = false;
		}
		const runner = confined.argv[0];
		if (runner === void 0) return this.confinedVerdict = false;
		const probeRun = spawnSync(runner, confined.argv.slice(1), {
			timeout: this.probeTimeoutMs,
			cwd: root,
			stdio: "ignore"
		});
		return this.confinedVerdict = probeRun.status === 0;
	}
	confinedPolicy(spec) {
		return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
	}
	async run(spec) {
		if (this.sandboxStance === "none" || !this.probeConfinedOnce()) return this.runArgv(spec, this.gitArgv(spec));
		const policy = this.confinedPolicy(spec);
		if (policy.mode === "danger-full-access") return {
			...await this.runArgv(spec, this.gitArgv(spec)),
			sandbox: {
				mode: "danger-full-access",
				denied: false
			}
		};
		const confined = this.ctx.sandbox.confine(this.gitArgv(spec), {
			...policy,
			mode: policy.mode
		});
		let result;
		try {
			result = await this.runArgv(spec, confined.argv);
		} catch (error) {
			if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) return this.runArgv(spec, this.gitArgv(spec));
			throw error;
		}
		if (classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules) !== void 0) return this.runArgv(spec, this.gitArgv(spec));
		return {
			...result,
			sandbox: {
				mode: policy.mode,
				denied: classifyDenial(result, confined.denialSignatures),
				enforcement: confined.enforcement
			}
		};
	}
	/** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
	processFacts = /* @__PURE__ */ new Map();
	start(spec) {
		if (this.sandboxStance === "none" || !this.probeConfinedOnce()) return this.startArgv(spec, this.gitArgv(spec));
		const policy = this.confinedPolicy(spec);
		if (policy.mode === "danger-full-access") return this.startArgv(spec, this.gitArgv(spec));
		const confined = this.ctx.sandbox.confine(this.gitArgv(spec), {
			...policy,
			mode: policy.mode
		});
		let proc;
		try {
			proc = this.startArgv(spec, confined.argv);
		} catch (error) {
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) return this.startArgv(spec, this.gitArgv(spec));
			throw error;
		}
		this.processFacts.set(proc, {
			mode: policy.mode,
			enforcement: confined.enforcement,
			denialSignatures: confined.denialSignatures,
			runnerFailureRules: confined.runnerFailureRules,
			runnerProgram: confined.argv[0],
			workdir: spec.workdir
		});
		return proc;
	}
	/** Stamp per-process sandbox facts before `done` settles (bash-sandbox semantics). */
	onProcessDone(proc, stderr, spawnFailed, spawnError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			proc.sandbox = (spawnFailed ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.workdir) : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== void 0) ? {
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
		super.onProcessDone(proc, stderr, spawnFailed, spawnError);
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
export { GitBashExecutor, GitBashExecutor as default };
