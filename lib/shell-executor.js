/**
 * The mechanism half every bash dialect shares.
 *
 * `lib/bash-git` and `lib/bash-wsl` were ~156 lines of duplicated mechanics
 * (17 identical blocks: the decorated handle, the unconfined run, the
 * per-process confinement facts, the settled-fact recording, the once-per-row
 * warning latch, the resolved policy). A third dialect would have copied them a
 * third time, so the mechanics live here and a dialect supplies only what is
 * genuinely its own:
 *
 * | hook | git (msys) | wsl |
 * |---|---|---|
 * | `argv(spec)` | `bash.exe -c <command>` | `wsl.exe --cd … -d … -- bash -c <b64>` |
 * | `confinedUsable()` | the async windows-acl provider probe | the functional bwrap probe (explicit `bwrap` throws) |
 * | `sandboxUnavailableMessage(policy)` | "the windows-acl runner cannot confine MSYS bash" | "bwrap was not found in the WSL distro" |
 * | `confinedRun(spec, policy)` | confine the MSYS argv, classify the runner failure | run the bwrap argv, static enforcement/signature facts |
 * | `denialSignaturesOf` / `enforcementOf` | per-run facts recorded at spawn | the vendored `BWRAP_*` constants |
 * | `runnerFailed(...)` | spawn failure of the runner program, or a classified runner failure | a classified runner failure |
 * | discovery (`tryBashPath` / `tryWslPath`, `probeDistroList`, …) | PATH/well-known/registry | `wsl -l -q` + the system launcher |
 *
 * Two differences are **deliberately not merged**, because merging them would
 * change behaviour rather than remove duplication:
 *
 *  - `candidateExists` — git's accepts only real files (a symlinked `bash.exe`
 *    is refused, because MSYS bash resolves its own root from the real path),
 *    wsl's also accepts a symlink. Each module keeps its own.
 *  - the sandbox stance vocabulary — git `['auto','none']`, wsl
 *    `['auto','none','bwrap']`. {@link sharedStanceConfig} takes the list from
 *    the dialect registry, so the union is never advertised by a dialect whose
 *    executor cannot honour it.
 *
 * Everything here is behaviour-preserving on purpose: this module was extracted
 * from the two executors without changing a branch, and the audit pins the
 * settled sandbox facts, the runner-failure paths and the argv shapes.
 * @module dsh-win-multi-bash/shell-executor
 */
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { classifyRunnerFailure, denialFacts, isRunnerSpawnFailure } from "./vendor/helpers.js";
/**
 * Copy a base Config schema and set the dialect's own fields on it.
 *
 * The executor's own schema must be **copied** rather than `.default({})`-ed on
 * the class: that call writes `meta.default` in place on the shared static, so a
 * second tool row would inherit a default it never declared. This was duplicated
 * in both executors before the base existed.
 * @param base - the schema to copy (the inherited executor Config).
 * @param fields - the dialect's own field schemas.
 * @returns the derived schema.
 */
export function deriveConfig(base, fields) {
	const derived = z.object({ ...base.dict });
	if (base.meta !== void 0) derived.meta = { ...base.meta };
	for (const key of Object.keys(fields)) derived.set(key, fields[key]);
	return derived;
}
/**
 * The knobs and stance vocabulary every dialect's Config carries, built from
 * the dialect's own stance list (never merged across dialects) and its own
 * probe deadline.
 * @param stances - the stances this dialect's executor implements, in order.
 * @param probeTimeoutMs - the dialect's default probe deadline.
 * @returns the schema fragment spread into `deriveConfig`.
 */
export function sharedStanceConfig(stances, probeTimeoutMs) {
	return {
		sandbox: z.union(stances.map((stance) => z.const(stance))).default("auto").volatile(),
		probeTimeoutMs: z.natural().default(probeTimeoutMs).volatile(),
		requireSandbox: z.boolean().default(false).volatile()
	};
}
/**
 * The shared executor: everything that is the same for every bash dialect.
 *
 * Subclasses must implement `argv(spec)` (plain/wrapped argv), `confinedUsable()`
 * (the once-per-row probe gate), `sandboxUnavailableMessage(policy)` (the
 * fail-closed text) and `confinedRun(spec, policy)`; the enforcement/signature
 * hooks have defaults that read the per-run facts git records, which wsl
 * overrides with its vendored constants.
 */
var ShellExecutorBase = class extends LocalBashExecutor {
	/** Test hook mirroring the sandbox-local internals pattern. */
	internals = {};
	/** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
	processFacts = /* @__PURE__ */ new Map();
	/** Knobs already warned about, so one bad value warns once per row. */
	warnedAbout;
	/** The learned refusal signature, cached per row (see each dialect's discovery). */
	denialDiscovery;
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
	constructor(ctx, config) {
		super(ctx, config);
	}
	/**
	 * Warn once per row about one ignored knob value. The row keeps running on the
	 * fallback; repeating the same sentence on every call would bury real warnings.
	 * The `bash-git:` / `bash-wsl:` prefix comes from the subclass's
	 * `static logName`.
	 * @param key - the knob (or fact) the warning is about.
	 * @param message - the sentence, without the dialect prefix.
	 */
	warnOnce(key, message) {
		this.warnedAbout ??= new Set();
		if (this.warnedAbout.has(key)) return;
		this.warnedAbout.add(key);
		this.ctx?.logger?.warn?.(`${this.constructor.logName ?? "bash"}: ${message}`);
	}
	/** The file-effect policy for one spec: the caller's, or this composition's default. */
	confinedPolicy(spec) {
		return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
	}
	/** The provider's signatures plus whatever this host taught us. */
	effectiveDenialSignatures(signatures) {
		return this.denialDiscovery === undefined ? signatures : [...signatures, this.denialDiscovery];
	}
	/**
	 * Execute one resolved spec through the dialect's argv. Foreground is a
	 * property of awaiting `result()`, not of the call — one handle serves both
	 * call styles, as the 0.1.7 seam defines it. Confinement is probe-gated, and
	 * runner evidence at execution time **fails closed** inside each dialect's
	 * `confinedRun`.
	 * @param spec - the resolved execution spec from `resolve`.
	 * @returns the live handle; sandbox facts land on both `proc.sandbox` (at
	 *   settlement) and the decorated `result()`.
	 */
	async execute(spec) {
		const policy = this.confinedPolicy(spec);
		if (policy.mode === "danger-full-access") return this.constructor.decorateResult(await this.executeArgv(spec, this.argv(spec)), (result) => ({
			...result,
			sandbox: {
				mode: "danger-full-access",
				denied: false
			}
		}));
		if (this.sandboxStance === "none") return this.unconfinedRun(spec, policy);
		if (!await this.confinedUsable()) {
			if (this.requireSandbox) throw new Error(this.sandboxUnavailableMessage(policy));
			return this.unconfinedRun(spec, policy);
		}
		return this.confinedRun(spec, policy);
	}
	/**
	 * Run one spec with **no confinement at all**, and report that fact instead
	 * of leaving `sandbox` absent.
	 *
	 * Absence was the only signal before, and it is ambiguous: it could mean "this
	 * deployment composes no sandbox" or "the deployment asked for one, the probe
	 * failed, and this command ran unprotected". The structured
	 * `unconfined: true` — on the decorated `result()` **and** on `proc.sandbox`
	 * (so a background job's terminal detail and a promoted call's seeded read
	 * see the same facts) — removes the ambiguity.
	 *
	 * Whether the MODEL also reads a sentence about it is decided one layer up,
	 * in the tool factory, which knows the stance: an explicit `sandbox: none` is
	 * the deployment's own choice and stays quiet, an `auto` degradation is worth
	 * a note (`render.js` `unconfinedMarker`).
	 *
	 * `danger-full-access` deliberately does not come through here: its mode
	 * already says the sandbox was turned off on purpose.
	 * @param spec - the resolved execution spec.
	 * @param policy - the resolved file-effect policy.
	 * @returns the decorated handle.
	 */
	async unconfinedRun(spec, policy) {
		// No `denied` here: nothing was confined, so "the sandbox did not deny this"
		// is not a fact this run can support — `unconfined: true` says it all.
		const facts = {
			mode: policy.mode,
			unconfined: true
		};
		const proc = await this.executeArgv(spec, this.argv(spec), (started) => {
			// Minimal facts: `onProcessDone` branches on `unconfined` before it
			// touches any confined-run field (`enforcement`, signatures, …).
			this.processFacts.set(started, {
				mode: policy.mode,
				unconfined: true
			});
		});
		return this.constructor.decorateResult(proc, (result) => ({
			...result,
			sandbox: { ...facts }
		}));
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
	/**
	 * Whether this settled process's confinement runner failed. Default (git): a
	 * rejected spawn of the runner program, or a classified runner failure in the
	 * settled result; wsl overrides it with its vendored rules only.
	 * @param state - the settled facts, the stderr text and the rejection, when any.
	 * @returns true when the runner — not the command — is the thing that failed.
	 */
	runnerFailed({ facts, stderr, providerRejected, providerError, exitCode }) {
		return providerRejected ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir) : classifyRunnerFailure(exitCode, stderr, facts.runnerFailureRules) !== void 0;
	}
	/** The denial signatures a settled confined run is classified against. */
	denialSignaturesOf(facts) {
		return facts.denialSignatures;
	}
	/** The enforcement value a settled confined run reports. */
	enforcementOf(facts) {
		return facts.enforcement;
	}
	/** Stamp per-process sandbox facts before `done` settles (bash-sandbox semantics). */
	onProcessDone(proc, stderr, providerRejected, providerError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			// An unwrapped run reports the one fact that matters — it was not
			// confined — and nothing it cannot know (enforcement, denials).
			proc.sandbox = facts.unconfined === true ? {
				mode: facts.mode,
				unconfined: true
			} : this.runnerFailed({
				facts,
				stderr,
				providerRejected,
				providerError,
				exitCode: proc.exitCode
			}) ? {
				mode: facts.mode,
				denied: false,
				enforcement: this.enforcementOf(facts),
				runnerFailed: true
			} : {
				mode: facts.mode,
				...denialFacts(proc.exitCode, stderr, this.effectiveDenialSignatures(this.denialSignaturesOf(facts))),
				enforcement: this.enforcementOf(facts)
			};
		}
		super.onProcessDone(proc, stderr, providerRejected, providerError);
	}
};
export { ShellExecutorBase };
