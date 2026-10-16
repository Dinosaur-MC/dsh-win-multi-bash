import { spawnSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { ShellExecutorBase, deriveConfig, sharedStanceConfig } from "../shell-executor.js";
import { dialectById } from "../shell-dialects.js";
import { classifyRunnerFailure, denialFacts, learnedDenialSignature } from "../vendor/helpers.js";
import { BWRAP_RUNNER_FAILURE_RULES, bwrapProfileArgs } from "../vendor/bwrap-profiles.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * The bwrap denial dialect: a denied file effect prints this signature on
 * stderr (mirrors DENIAL_SIGNATURES.bwrap in the base sandbox-local), so the
 * sandbox facts the tool renders can report `denied` instead of always false.
 */
const BWRAP_DENIAL_SIGNATURES = ["read-only file system"];
/**
 * The enforcement this executor reports for a **bwrap-wrapped** run.
 *
 * It is NOT something this plugin's probe measures. It is the classification
 * upstream publishes for the bwrap backend:
 * `STATIC_ENFORCEMENT = { bwrap: "full", landlock: "full", seatbelt: "full",
 * "windows-acl": "partial" }`
 * (`@deepseek-ai/dsh-sandbox-local/lib/index.js:187-192` — the shipped bundle of
 * `sandbox-local/src/index.ts:178-182`), where `SandboxEnforcement =
 * 'full' | 'partial'` means "how completely this backend enforces the policy's
 * **file effects**" (`packages/sandbox/sandbox/src/index.ts:60`). Reporting it
 * here is therefore an upstream-sourced claim, not a probe result — and it is
 * reported only when the command is actually wrapped, which a functional probe
 * (the same profile builder, run with `/bin/true`) gates. The vendored profile
 * this executor wraps with is drift-guarded against that same upstream package
 * (see `smoke/audit.test.mjs`, "the vendored bwrap profile against the upstream
 * artifact"), which is what keeps the claim backed by the profile it describes.
 */
const BWRAP_ENFORCEMENT = "full";
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
var WslBashExecutor = class extends ShellExecutorBase {
	/** The dialect prefix every warning from this row carries. */
	static logName = "bash-wsl";
	static Config = deriveConfig(LocalBashExecutor.Config, {
		wslPath: z.string().volatile(),
		wslDistro: z.string().volatile(),
		// The stance vocabulary is the dialect declaration's (`lib/shell-dialects.js`)
		// — `['auto', 'none', 'bwrap']` for WSL, deliberately not merged with git's.
		...sharedStanceConfig(dialectById("wsl").sandboxStances, 8e3)
	});
	
	
	bwrapVerdict;
	distroProbed = false;
	distroVerdict;
	/** Parsed `wsl -l -q` names, cached with the verdict (one probe per row). */
	distroList;
	
	
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
	/**
	 * The awaitable form of {@link sandboxMode}. The bwrap probe spawns
	 * `wsl.exe` synchronously, so the verdict is already available; this exists
	 * so both backends present the tool layer the same contract (git-bash's
	 * provider probe is genuinely async).
	 *
	 * Cost, stated because this runs on the tool row's `apply` path through
	 * `resolveSandboxMode`: the distro probe (`wsl -l -q`) and the functional
	 * bwrap probe are two serial `spawnSync` calls, each capped by
	 * `probeTimeoutMs` (8000 by default) — a 16s ceiling of blocked event loop
	 * on a host where WSL hangs. Measured on this machine (2026-10-14, WSL with
	 * bwrap present): 71 ms for `-l -q` plus **3.66 s** for the bwrap run, so
	 * the WSL row's apply really does hold the loop for ~3.7 s. It is not
	 * async-ified here because a distro that cannot answer `wsl -l -q` is
	 * exactly the host this probe must fail fast on, and the WSL side has no
	 * equivalent of git-bash's registry fallback to pay for.
	 * @returns the mode to advertise, or `undefined` for an unconfining deployment.
	 */
	async resolveSandboxMode() {
		return this.sandboxMode;
	}
	/** Auto: false means run unconfined. Explicit bwrap: a failed probe throws loud. */
	requireBwrapUsable() {
		if (this.probeBwrapOnce()) return true;
		if (this.sandboxStance === "bwrap") throw new Error("bash-wsl: bwrap was not found in the WSL distro (explicit sandbox \"bwrap\" is configured); install bubblewrap or set sandbox: auto/none");
		return false;
	}
	tryWslPath() {
		const resolve = (configured) => (this.internals.resolveWslPath ?? ((value) => resolveWslPath(value)))(configured);
		const configured = this.config.wslPath.get();
		const path = resolve(configured);
		// A configured wsl.exe that is not there is a runtime fallback, not an edit:
		// the stored value stays exactly as it is (A3 — nothing here writes config),
		// the row discovers the standard location instead, and the user is told once
		// per row which value was ignored.
		if (configured !== void 0 && configured.length > 0 && path === configured && !candidateExists(configured)) {
			this.warnOnce("wslPath", `wslBash.wslPath ${JSON.stringify(configured)} does not exist; falling back to the standard Windows location.`);
			return resolve(undefined);
		}
		return path;
	}
	
	wslPath() {
		const path = this.tryWslPath();
		if (path !== void 0) return path;
		throw new Error(`bash-wsl: WSL was not found (probed ${candidateWslPaths().join(", ")}). Enable Windows Subsystem for Linux or set wslBash.wslPath.`);
	}
	probeDistroList() {
		if (!this.distroProbed) {
			this.distroProbed = true;
			const probe = this.internals.probeDistro;
			if (probe !== void 0) {
				// The hook predates the list probe: it may answer with the first name
				// (the old contract) or with the whole list, and both stay supported.
				const probed = probe();
				this.distroList = probed === void 0 ? [] : Array.isArray(probed) ? probed : [probed];
				this.distroVerdict = this.distroList[0];
				return this.distroList;
			}
			const wsl = this.tryWslPath();
			if (wsl === void 0) {
				this.distroList = [];
				this.distroVerdict = void 0;
				/* v8 ignore next 2 -- every executor path resolves wslPath before this probe, so the guard is defensive only. */
				return this.distroList;
			}
			const run = spawnSync(wsl, ["-l", "-q"], {
				timeout: this.probeTimeoutMs,
				encoding: "utf8"
			});
			this.distroList = run.status === 0 ? parseWslDistroList(run.stdout) : [];
			this.distroVerdict = this.distroList[0];
		}
		return this.distroList ?? [];
	}
	probeDistroOnce() {
		this.probeDistroList();
		return this.distroVerdict;
	}
	distro() {
		const pinned = this.config.wslDistro.get();
		if (pinned === void 0) return this.probeDistroOnce();
		// A pinned distribution that this host does not have would fail every
		// command with wsl.exe's own error; fall back to the first listed distro at
		// runtime (the stored pin stays untouched) and say so once.
		if (this.probeDistroList().includes(pinned)) return pinned;
		const fallback = this.probeDistroOnce();
		this.warnOnce("wslDistro", `wslBash.wslDistro ${JSON.stringify(pinned)} is not installed; falling back to ${fallback === void 0 ? "WSL's first distribution (none is listed)" : JSON.stringify(fallback)}.`);
		return fallback;
	}
	probeBwrapOnce() {
		if (this.bwrapVerdict !== void 0) return this.bwrapVerdict;
		const probe = this.internals.probeBwrap;
		if (probe !== void 0) return this.bwrapVerdict = probe();
		const wsl = this.tryWslPath();
		if (wsl === void 0) return this.bwrapVerdict = false;
		const distro = this.distro();
		// Functional probe, not an existence check: run the SAME profile builder
		// every real wrap uses, so a host that cannot create the private PID
		// namespace rejects bwrap here instead of accepting a weaker probe and
		// failing at the first command. dsh-sandbox-local does the same (with the
		// same `--` separator, `sandbox-local/src/index.ts:68-75`), which is why
		// the upstream-sourced enforcement constant above can be reported as a
		// fact about the wrapped command rather than a guess.
		const run = spawnSync(wsl, [
			...distro !== void 0 ? ["-d", distro] : [],
			"-e",
			"bwrap",
			...bwrapProfileArgs({ mode: "read-only" }),
			"--",
			"/bin/true"
		], {
			timeout: this.probeTimeoutMs,
			stdio: "ignore"
		});
		const usable = run.status === 0;
		if (usable) this.discoverDenialSignature();
		return this.bwrapVerdict = usable;
	}
	/**
	 * Learn this host's denial dialect, once per row: the functional probe just
	 * proved bwrap can confine, so one *doomed* write outside the granted root (a
	 * random name in the workspace root's parent, run under the same read-only
	 * profile with `--cd` at that root) shows what a refusal prints here. The
	 * provider ships a fixed English dialect; the text itself comes from whatever
	 * program the command ran, so a host whose console language is not English can
	 * print something else entirely (`learnedDenialSignature` documents the limits).
	 *
	 * Harmlessness is asserted, not assumed: the target must not exist afterwards;
	 * if it does — the write was NOT refused — the file is removed at once and the
	 * discovery is recorded as invalid instead of becoming a signature. Every other
	 * failure path (no wsl.exe, a timeout, an unusable message) returns undefined
	 * and leaves the row on the provider's signatures: this never fails the row.
	 * @returns the learned signature, or undefined.
	 */
	discoverDenialSignature() {
		if (this.denialDiscovery !== undefined) return this.denialDiscovery;
		const wsl = this.tryWslPath();
		if (wsl === void 0) return this.denialDiscovery = undefined;
		const root = this.ctx.sandboxPolicy.resolve().workspaceRoot;
		const name = `.dsh-denial-probe-${randomUUID().slice(0, 8)}`;
		const target = join(dirname(root), name);
		const distro = this.distro();
		const run = spawnSync(wsl, [
			"--cd",
			toWslPath(root),
			...distro !== void 0 ? ["-d", distro] : [],
			"-e",
			"bwrap",
			...bwrapProfileArgs({ mode: "read-only" }),
			"--",
			"bash",
			"-c",
			`printf x > ../${name}`
		], {
			timeout: this.probeTimeoutMs,
			encoding: "utf8"
		});
		if (existsSync(target)) {
			rmSync(target, { force: true });
			this.denialDiscoveryInvalid = true;
			return this.denialDiscovery = undefined;
		}
		return this.denialDiscovery = learnedDenialSignature(run.stderr ?? "", [name, target, root, toWslPath(root)]);
	}
	
	payload(command) {
		return `echo ${Buffer.from(command, "utf8").toString("base64")} | base64 -d | bash`;
	}
	/**
	* The plain WSL argv for one spec (no sandbox).
	*
	* `--cd` always carries the resolved workdir. That is the auto-cd contract:
	* a command the caller started without an explicit `workdir` still lands in
	* the WSL view of the session directory (`/mnt/<drive>/...`) rather than
	* wherever the distro happens to default to. wsl.exe does translate an
	* inherited Windows cwd on its own, but only for a path it can translate
	* and only under the distro's automount settings — passing the workdir
	* explicitly keeps the start directory a property of the spec instead of a
	* property of the distro. A Linux workdir passes through verbatim.
	*
	* (This used to skip `--cd` when the workdir equaled the configured
	* default. That branch was dead — it compared against the `cwd` volatile
	* *wrapper* rather than its value, so it never matched — and skipping is
	* not worth reviving: the explicit form is what the auto-cd feature is
	* specified as, and it is the behaviour every deployment already runs.)
	*/
	argv(spec) {
		const head = [this.wslPath(), "--cd", spec.workdir];
		const distro = this.distro();
		if (distro !== void 0) head.push("-d", distro);
		head.push("--", "bash", "-c", this.payload(spec.command));
		return head;
	}
	
	/** The bwrap-wrapped argv; the workspace root is translated to its /mnt/<drive> form. */
	bwrapArgv(spec) {
		const policy = this.confinedPolicy(spec);
		const linuxRoot = toWslPath(policy.workspaceRoot);
		const head = [this.wslPath(), "--cd", spec.workdir];
		const distro = this.distro();
		if (distro !== void 0) head.push("-d", distro);
		const mode = policy.mode;
		// Upstream wraps as `bwrap <profile> -- <argv>` (`sandbox-local/src/index.ts:330`;
		// its own functional probe at `:70` uses the same separator). The separator
		// is what keeps a profile argument from being read as the command: our
		// command is always the literal `bash`, so leaving it out has no live
		// effect today, but repeating the upstream shape removes the latent
		// ambiguity and lets the argv be compared to upstream's item for item.
		head.push("--", "bwrap", ...bwrapProfileArgs({
			mode,
			workspaceRoot: linuxRoot
		}), "--", "bash", "-c", this.payload(spec.command));
		return head;
	}
	/** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
	
		/** The once-per-row bwrap probe gate the base awaits. */
		confinedUsable() {
			// Resolved by the user's ruling (2026-10-14): the fallback the base then
			// takes reports the structured fact `unconfined: true` (see `unconfinedRun`),
			// and the MODEL reads a sentence about it only when the stance was `auto` —
			// an `auto` degradation is something we did to the user, while an explicit
			// `sandbox: none` is their own choice and stays quiet. The git-bash
			// executor's equivalent fallback reports the same fact shape, so an absent
			// `sandbox` field now means exactly one thing: the executor does not
			// implement sandboxing for this composition at all.
			return this.requireBwrapUsable();
		}
		/** The fail-closed sentence for `requireSandbox` on a distro without bubblewrap. */
		sandboxUnavailableMessage(policy) {
			return "bash-wsl: sandbox unavailable — bwrap was not found in the WSL distro; refusing to run unconfined under " + policy.mode + " mode. Install bubblewrap or retry the command with sandbox_permissions: \"danger-full-access\" and a justification.";
		}
		/** WSL's enforcement is the vendored bwrap constant, not a per-run provider fact. */
		enforcementOf() {
			return BWRAP_ENFORCEMENT;
		}
		/** …and so are the denial signatures it classifies against. */
		denialSignaturesOf() {
			return BWRAP_DENIAL_SIGNATURES;
		}
		/** A settled run counts as a runner failure only through the vendored rules. */
		runnerFailed({ stderr, exitCode }) {
			return classifyRunnerFailure(exitCode, stderr, BWRAP_RUNNER_FAILURE_RULES) !== void 0;
		}
		/**
		 * Run this spec through the bwrap argv and settle its facts. Unlike the
		 * windows-acl probe, a distro missing bubblewrap is evidence the deployment
		 * has no confinement at all, and the spec's error contract surfaces it (the
		 * base's `confinedUsable` gate): a classified runner failure in the settled
		 * result is stamped as `runnerFailed` rather than retried.
		 * @param spec - the resolved execution spec from {@link resolve}.
		 * @param policy - the resolved file-effect policy.
		 * @returns the live handle; sandbox facts land on both `proc.sandbox` (at
		 *   settlement) and the decorated `result()`.
		 */
		async confinedRun(spec, policy) {
			const proc = await this.executeArgv(spec, this.bwrapArgv(spec), (started) => {
				this.processFacts.set(started, { mode: policy.mode });
			});
			return this.constructor.decorateResult(proc, (result) => this.runnerFailed({
				stderr: result.stderr.text,
				exitCode: result.exitCode
			}) ? {
				...result,
				sandbox: {
					mode: policy.mode,
					denied: false,
					enforcement: BWRAP_ENFORCEMENT,
					runnerFailed: true
				}
			} : {
				...result,
				sandbox: {
					mode: policy.mode,
					...denialFacts(result.exitCode, result.stderr.text, this.effectiveDenialSignatures(BWRAP_DENIAL_SIGNATURES)),
					enforcement: BWRAP_ENFORCEMENT
				}
			});
		}	resolve(request) {
		return {
			...super.resolve(request),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
};
//#endregion
// `candidateExists` is exported for the same reason git exports its own: the two
// deliberately differ (wsl accepts a symlinked launcher, MSYS bash does not) and
// the audit pins that difference instead of assuming a shared base merged it.
export { WslBashExecutor, WslBashExecutor as default, candidateExists };
