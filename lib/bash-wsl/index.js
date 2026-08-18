import { spawnSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { classifyDenial, classifyRunnerFailure, matchesSignature } from "../vendor/helpers.js";
import { BWRAP_RUNNER_FAILURE_RULES, bwrapProfileArgs } from "../vendor/bwrap-profiles.js";
import { lstatSync } from "node:fs";
import { join } from "node:path";
/**
 * The bwrap denial dialect: a denied file effect prints this signature on
 * stderr (mirrors DENIAL_SIGNATURES.bwrap in the base sandbox-local), so the
 * sandbox facts the tool renders can report `denied` instead of always false.
 */
const BWRAP_DENIAL_SIGNATURES = ["read-only file system"];
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
//#region lib/types/resolve.js
/**
* WSL executable and distro resolution for the bash-wsl executor, dependency-free
* and parameterized (env/platform) so resolution is a pure function of its
* inputs on every platform — the twin of dsh-bash-git's resolveBashPath and
* dsh-pwsh-local's resolvePwshPath.
* @module @deepseek-ai/dsh-bash-wsl/resolve
*/
/**
* Well-known WSL executable locations: System32 (the shipped wsl.exe) plus
* PATH entries.
* @param env - the environment to probe; defaults to the process environment.
* @returns candidate `wsl.exe` paths in resolution order.
*/
function candidateWslPaths(env = process.env) {
	const candidates = [join(env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe")];
	for (const entry of (env.PATH ?? "").split(";")) {
		const trimmed = entry.trim().replace(/^"|"$/g, "");
		if (trimmed.length === 0) continue;
		candidates.push(join(trimmed, "wsl.exe"));
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
* Resolve the wsl.exe executable this executor spawns. Returns undefined on
* win32 when no candidate exists (the executor turns that into a loud
* route-time error naming the probes); non-win32 hosts resolve a bare
* `wsl` for PATH resolution, mirroring resolvePwshPath.
* @param configured - an explicit `wslPath` config value, trusted as-is.
* @param env - the environment to probe on Windows; defaults to the process environment.
* @param platform - the platform to resolve for; defaults to the process platform.
* @returns the first existing well-known location on win32, else `wsl`, else undefined.
*/
function resolveWslPath(configured, env = process.env, platform = process.platform) {
	if (configured !== void 0 && configured.length > 0) return configured;
	if (platform === "win32") {
		for (const candidate of candidateWslPaths(env)) if (candidateExists(candidate)) return candidate;
		return;
	}
	return "wsl";
}
/**
* Parse `wsl -l -q` output into distro names. wsl.exe writes UTF-16LE with
* null-byte interleaving when stdout is redirected, so NUL bytes are stripped
* before splitting; surrounding quotes and blank lines are dropped.
* @param output - raw `-l -q` stdout.
* @returns distro names in output order.
*/
function parseWslDistroList(output) {
	const distros = [];
	for (const raw of output.replace(/\0/g, "").split(/\r?\n/)) {
		const line = raw.trim().replace(/^"|"$/g, "");
		if (line.length === 0) continue;
		distros.push(line);
	}
	return distros;
}
/**
* Convert a Windows drive-letter path to the WSL /mnt/<drive>/... form used
* as the bwrap workspace root inside the distro. Anything without a
* drive-letter form fails loud: wsl.exe's own `--cd` translation covers
* workdirs, but the bwrap profile needs an explicit Linux-side root.
* @param winPath - the Windows path to convert.
* @returns the Linux-side path.
* @throws Error when the path has no drive-letter form.
*/
function toWslPath(winPath) {
	const match = /^([A-Za-z]):[\\/](.+)$/.exec(winPath);
	if (match === null) throw new Error(`unsupported Windows path: ${winPath}`);
	const drive = match[1];
	const rest = match[2];
	/* v8 ignore next -- the regex guarantees both captures whenever it matches */
	if (drive === void 0 || rest === void 0) throw new Error(`unsupported Windows path: ${winPath}`);
	return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}
//#endregion
//#region lib/types/index.js
/**
* WSL Service Provider for the bash capability seam: a LocalBashExecutor
* whose argv is `[wslPath, --cd workdir?, -d distro?, --, bash, -c, payload]`.
* The command rides as a base64 payload through `echo <b64> | base64 -d | bash`
* so wsl.exe's Windows→Linux argument serialization can never damage quotes.
* Sandbox: `auto` probes bubblewrap inside the distro (once, lazily, at the
* first sandboxMode read or the first command) and runs unconfined without
* sandbox facts when absent; `bwrap` fails loud at first use when the probe
* fails; `none` never probes or confines.
* @module @deepseek-ai/dsh-bash-wsl
*/
/**
* WSL executor over the local bash mechanics: argv is the resolved wsl.exe
* followed by `--cd`/`-d`/`--` `bash -c` with the base64 payload, and the
* sandbox stance (`auto`/`bwrap`/`none`) is applied lazily per the module
* doc's probe contract.
*/
var WslBashExecutor = class extends LocalBashExecutor {
	static Config = deriveConfig(LocalBashExecutor.Config, {
		wslPath: z.string(),
		wslDistro: z.string(),
		sandbox: z.union([
			z.const("auto"),
			z.const("none"),
			z.const("bwrap")
		]).default("auto"),
		probeTimeoutMs: z.natural().default(3e4),
		requireSandbox: z.boolean().default(false)
	});
	/** Test hook mirroring the sandbox-local internals pattern. */
	internals = {};
	sandboxStance;
	probeTimeoutMs;
	bwrapVerdict;
	distroProbed = false;
	distroVerdict;
	constructor(ctx, config) {
		super(ctx, config);
		const entry = config;
		this.sandboxStance = entry.sandbox;
		this.probeTimeoutMs = entry.probeTimeoutMs;
		this.requireSandbox = entry.requireSandbox;
	}
	/**
	 * The capability fact: the policy default mode while bwrap is usable. With
	 * `requireSandbox`, the mode is declared even when the probe fails, so the
	 * tool layer advertises escalation (`sandbox_permissions`) and the executor
	 * can refuse unconfined runs outside danger-full-access.
	 */
	get sandboxMode() {
		if (this.sandboxStance === "none") return void 0;
		if (this.requireSandbox) return this.ctx.sandboxPolicy.defaultMode;
		return this.requireBwrapUsable() ? this.ctx.sandboxPolicy.defaultMode : void 0;
	}
	/** Auto: false means run unconfined. Explicit bwrap: a failed probe throws loud. */
	requireBwrapUsable() {
		if (this.probeBwrapOnce()) return true;
		if (this.sandboxStance === "bwrap") throw new Error("bash-wsl: bwrap was not found in the WSL distro (explicit sandbox \"bwrap\" is configured); install bubblewrap or set sandbox: auto/none");
		return false;
	}
	tryWslPath() {
		return (this.internals.resolveWslPath ?? ((configured) => resolveWslPath(configured)))(this.config.wslPath);
	}
	wslPath() {
		const path = this.tryWslPath();
		if (path !== void 0) return path;
		throw new Error(`bash-wsl: WSL was not found (probed ${candidateWslPaths().join(", ")}). Enable Windows Subsystem for Linux or set wslBash.wslPath.`);
	}
	probeDistroOnce() {
		if (!this.distroProbed) {
			this.distroProbed = true;
			const probe = this.internals.probeDistro;
			if (probe !== void 0) return this.distroVerdict = probe();
			const wsl = this.tryWslPath();
			if (wsl === void 0) {
				this.distroVerdict = void 0;
				/* v8 ignore next 2 -- every executor path resolves wslPath before this probe, so the guard is defensive only. */
				return;
			}
			const run = spawnSync(wsl, ["-l", "-q"], {
				timeout: this.probeTimeoutMs,
				encoding: "utf8"
			});
			this.distroVerdict = run.status === 0 ? parseWslDistroList(run.stdout)[0] : void 0;
		}
		return this.distroVerdict;
	}
	distro() {
		return this.config.wslDistro ?? this.probeDistroOnce();
	}
	probeBwrapOnce() {
		if (this.bwrapVerdict !== void 0) return this.bwrapVerdict;
		const probe = this.internals.probeBwrap;
		if (probe !== void 0) return this.bwrapVerdict = probe();
		const wsl = this.tryWslPath();
		if (wsl === void 0) return this.bwrapVerdict = false;
		const distro = this.distro();
		const run = spawnSync(wsl, [
			...distro !== void 0 ? ["-d", distro] : [],
			"-e",
			"bash",
			"-c",
			"command -v bwrap"
		], {
			timeout: this.probeTimeoutMs,
			stdio: "ignore"
		});
		return this.bwrapVerdict = run.status === 0;
	}
	payload(command) {
		return `echo ${Buffer.from(command, "utf8").toString("base64")} | base64 -d | bash`;
	}
	/** The workdir `resolve()` fills when a request omits one. */
	defaultWorkdir() {
		return this.config.cwd ?? process.cwd();
	}
	/**
	* The plain WSL argv for one spec (no sandbox). `--cd` is passed only when
	* the workdir differs from the default, so the subprocess cwd and the WSL
	* start directory agree without a redundant wsl.exe translation; a Linux
	* workdir passes through verbatim.
	*/
	argv(spec) {
		const head = [this.wslPath()];
		if (spec.workdir !== this.defaultWorkdir()) head.push("--cd", spec.workdir);
		const distro = this.distro();
		if (distro !== void 0) head.push("-d", distro);
		head.push("--", "bash", "-c", this.payload(spec.command));
		return head;
	}
	confinedPolicy(spec) {
		return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
	}
	/** The bwrap-wrapped argv; the workspace root is translated to its /mnt/<drive> form. */
	bwrapArgv(spec) {
		const policy = this.confinedPolicy(spec);
		const linuxRoot = toWslPath(policy.workspaceRoot);
		const head = [this.wslPath()];
		if (spec.workdir !== this.defaultWorkdir()) head.push("--cd", spec.workdir);
		const distro = this.distro();
		if (distro !== void 0) head.push("-d", distro);
		const mode = policy.mode;
		head.push("--", "bwrap", ...bwrapProfileArgs({
			mode,
			workspaceRoot: linuxRoot
		}), "bash", "-c", this.payload(spec.command));
		return head;
	}
	async run(spec) {
		const policy = this.confinedPolicy(spec);
		if (policy.mode === "danger-full-access") return {
			...await this.runArgv(spec, this.argv(spec)),
			sandbox: {
				mode: "danger-full-access",
				denied: false
			}
		};
		if (this.sandboxStance === "none") return this.runArgv(spec, this.argv(spec));
		if (!this.requireBwrapUsable()) {
			if (this.requireSandbox) throw new Error("bash-wsl: sandbox unavailable — bwrap was not found in the WSL distro; refusing to run unconfined under " + policy.mode + " mode. Install bubblewrap or retry the command with sandbox_permissions: \"danger-full-access\" and a justification.");
			return this.runArgv(spec, this.argv(spec));
		}
		const result = await this.runArgv(spec, this.bwrapArgv(spec));
		if (classifyRunnerFailure(result.exitCode, result.stderr.text, BWRAP_RUNNER_FAILURE_RULES) !== void 0) return {
			...result,
			sandbox: {
				mode: policy.mode,
				denied: false,
				enforcement: "full",
				runnerFailed: true
			}
		};
		return {
			...result,
			sandbox: {
				mode: policy.mode,
				denied: classifyDenial(result, BWRAP_DENIAL_SIGNATURES),
				enforcement: "full"
			}
		};
	}
	/** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
	processFacts = /* @__PURE__ */ new Map();
	start(spec) {
		const policy = this.confinedPolicy(spec);
		if (policy.mode === "danger-full-access") return this.startArgv(spec, this.argv(spec));
		if (this.sandboxStance === "none") return this.startArgv(spec, this.argv(spec));
		if (!this.requireBwrapUsable()) {
			if (this.requireSandbox) throw new Error("bash-wsl: sandbox unavailable — bwrap was not found in the WSL distro; refusing to run unconfined under " + policy.mode + " mode. Install bubblewrap or retry the command with sandbox_permissions: \"danger-full-access\" and a justification.");
			return this.startArgv(spec, this.argv(spec));
		}
		const proc = this.startArgv(spec, this.bwrapArgv(spec));
		this.processFacts.set(proc, { mode: policy.mode });
		return proc;
	}
	/** Stamp per-process sandbox facts before `done` settles (bash-sandbox semantics). */
	onProcessDone(proc, stderr, spawnFailed, spawnError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			proc.sandbox = classifyRunnerFailure(proc.exitCode, stderr, BWRAP_RUNNER_FAILURE_RULES) !== void 0 ? {
				mode: facts.mode,
				denied: false,
				enforcement: "full",
				runnerFailed: true
			} : {
				mode: facts.mode,
				denied: matchesSignature(proc.exitCode, stderr, BWRAP_DENIAL_SIGNATURES),
				enforcement: "full"
			};
		}
		super.onProcessDone(proc, stderr, spawnFailed, spawnError);
	}
	resolve(request) {
		return {
			...super.resolve(request),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
};
//#endregion
export { WslBashExecutor, WslBashExecutor as default };
