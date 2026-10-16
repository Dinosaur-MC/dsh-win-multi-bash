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
import { SANDBOX_TEMP_GUARD_DEFAULT, SANDBOX_TEMP_GUARD_KNOB, SANDBOX_TEMP_WATCH_MS, SandboxTempGuard } from "./sandbox-temp-guard.js";
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
export function sharedStanceConfig(stances, probeTimeoutMs, noticeLevels) {
	return {
		sandbox: z.union(stances.map((stance) => z.const(stance))).default("auto").volatile(),
		probeTimeoutMs: z.natural().default(probeTimeoutMs).volatile(),
		requireSandbox: z.boolean().default(false).volatile(),
		// How often an automatically degraded run announces itself; the default
		// is the first declared level (`once`), and the whole vocabulary comes
		// from the dialect registry so the schema and the form cannot drift.
		sandboxNotice: z.union(noticeLevels.map((level) => z.const(level))).default(noticeLevels[0]).volatile()
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
	 * The row's tool-layer knobs — the ones outside this executor's own config
	 * partition — handed over by the tool factory (see `factory.js` TOOL_CONFIG).
	 * The loader passes the volatile ones as live references, so every read here
	 * sees a value saved on the Plugins page without reloading the row.
	 */
	toolLayer;
	/** Memoized private-temp guard; never constructed before a confined run needs it. */
	tempGuardInstance;
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
	/**
	 * Hand this row's tool-layer knobs to the executor.
	 *
	 * They cannot travel in the backend partition this executor is built from
	 * (`factory.js` constructs it with `config[configKey]`), and the private-temp
	 * guard has to be readable from inside the confine path, so the factory passes
	 * the tool layer separately. A row that never calls this keeps the documented
	 * default: healing ON.
	 * @param toolLayer - the row's tool-layer config (volatile references).
	 * @returns this executor, for chaining at the call site.
	 */
	attachToolLayer(toolLayer, hostCtx = this.ctx) {
		this.toolLayer = toolLayer;
		// The ROW's own context is handed in explicitly: the executor's backend ctx is
		// an isolated child scope built for the sandbox/subprocess services, and a
		// timer must attach to the row's lifetime, not to that narrower one.
		return this.startTempWatch(hostCtx);
	}
	/** Whether the row's `guardSandboxTemp` knob allows healing (default: yes). */
	get sandboxTempGuardEnabled() {
		const knob = this.toolLayer?.[SANDBOX_TEMP_GUARD_KNOB];
		const value = typeof knob?.get === "function" ? knob.get() : knob;
		return value === void 0 ? SANDBOX_TEMP_GUARD_DEFAULT : value !== false;
	}
	/**
	 * The private-temp guard for this row (constructed lazily, once).
	 *
	 * Its inputs are the row's live knob and the standing policy's workspace
	 * root, so the "never inside a workspace root" gate follows the session's
	 * real boundary rather than a value captured at load.
	 */
	get tempGuard() {
		this.tempGuardInstance ??= new SandboxTempGuard({
			enabled: () => this.sandboxTempGuardEnabled,
			warn: (key, message) => this.warnOnce(key, message),
			workspaceRoots: () => {
				const root = this.ctx?.sandboxPolicy?.resolve?.()?.workspaceRoot;
				return typeof root === "string" && root.length > 0 ? [root] : [];
			}
		});
		return this.tempGuardInstance;
	}
	/**
	 * Confine one argv through the sandbox seam, then let the temp guard repair
	 * the seam's private temp directory if it has been removed out of band.
	 *
	 * **Why here.** `ctx.sandbox.confine()` returns the windows-acl runner's argv
	 * — the only place this plugin is legitimately handed the `--temp` path the
	 * seam has cached (`dsh-sandbox-local` `windowsAclRunnerArgv`). The runner
	 * hard-fails on a missing `--temp` (exit 127, "… is not an existing
	 * directory"), and the seam never recreates it, so repairing after the wrap
	 * and before the spawn is what turns a bricked session back into a working
	 * one — including the once-per-row confinement probe, whose memoized verdict
	 * would otherwise degrade the row to unconfined for the rest of the process.
	 *
	 * Healing is best-effort by construction: a throwing guard is reported once
	 * and the confinement proceeds exactly as it would have, so the guard can
	 * never become a new way for a command to fail.
	 * @param argv - the exact argv the caller is about to spawn.
	 * @param policy - the resolved file-effect policy (its workspace root is a guard gate).
	 * @param signal - cancellation before policy resolution or grant creation.
	 * @returns the seam's confine result, unmodified.
	 */
	async confineRun(argv, policy, signal) {
		const confined = await this.ctx.sandbox.confine(argv, policy, signal);
		try {
			await this.tempGuard.ensureArgvUsable(confined, policy);
		} catch (error) {
			this.warnOnce("sandbox-temp-guard", `could not check/repair the sandbox private temp directory (${String(error?.message ?? error)}); the confined command runs unchanged.`);
		}
		// The probe is the only confine call a never-confining row ever makes, so the
		// watch has to start here: it is the one moment the seam's root is visible.
		this.startTempWatch();
		return confined;
	}
	/**
	 * A SECOND trigger for the same check {@link ensureTempRootUsable} runs inline: a
	 * timer, for the case where no tool call happens at all after the root vanishes.
	 *
	 * WHY A TIMER. The two other channels both need a confined command: the
	 * proactive one runs just before a spawn, and the stderr one runs after a
	 * runner reports the missing directory. A row whose probe verdict is negative
	 * (measured here: the windows-acl runner cannot start MSYS bash, \`0xC0000142\`)
	 * never confines at all, so when an OS temp cleaner deletes the shared
	 * \`%TEMP%\\dsh-<6>\` the row has no trigger left — while every confined tool the
	 * HARNESS runs (its own pwsh / code runs, which share the same cache entry)
	 * starts failing with \`--temp is not an existing directory\` until a human
	 * rebuilds the directory by hand. This tick removes that human step: the
	 * repair needs no elevation, because it is mkdir + an ACL grant performed by
	 * the host process, not by a confined child.
	 * @returns this executor, for chaining at the call site.
	 */
	/**
	 * One watch tick: repair the seam's private root, learning it if need be.
	 *
	 * The learning branch exists because a probe that throws INSIDE the seam never
	 * reaches `ensureArgvUsable`, so a row can fail its probe without the guard ever
	 * seeing a \`--temp\` to remember — measured on this host, where the probe is the
	 * only confine call an unconfined row ever makes. Asking the seam for the argv it
	 * would hand a spawn is the one supported way to obtain that path without running
	 * anything: the call itself materializes the private root when the seam has none
	 * cached, and nothing is spawned from it.
	 * @returns when the tick's work has settled.
	 */
	async ensureTempRootUsable() {
		try {
			const guard = this.tempGuard;
			// DIRECT FILESYSTEM WORK FIRST, with no seam call: listing the temp
			// directories is a fact this process can read for itself, and it is the only
			// way to know a root no row will ever be handed (the harness's own confined
			// tools keep one of their own). A root is remembered while it still exists,
			// so a later deletion is repairable; the repair is mkdir + the seam's own
			// grant, done here in the host process, which needs no elevation at all.
			guard.rememberAmbient();
			await guard.ensureAmbient();
			if (guard.ambientRoots.length > 0) return;
			if (guard.seenTempArgvs.length > 0) {
				// The steady state: one existence check per remembered root (normally one).
				await guard.ensureSeen();
				return;
			}
			// Nothing learned yet — a probe that threw INSIDE the seam never reaches
			// `ensureArgvUsable`. Ask the seam for the argv it would hand a spawn: that
			// call is the only supported way to obtain the path without running
			// anything, and it materializes the root when the seam has none cached.
			const policy = this.ctx?.sandboxPolicy?.resolve?.();
			const probe = await this.ctx.sandbox.confine([process.execPath, "-e", ""], policy);
			await guard.ensureArgvUsable(probe, policy);
		} catch (error) {
			// Best-effort by construction: a check that cannot run must never become a
			// new way for a command to fail.
			this.warnSilentlyOnce("sandbox-temp-guard", `could not check/repair the sandbox private temp directory (${String(error?.message ?? error)}); the command runs unchanged.`);
		}
	}
	/**
	 * Report through \`warnOnce\` when it exists, and stay silent when it does not.
	 *
	 * The watch runs on a bare timer: a context that lost its logger must not turn a
	 * reporting failure into an unhandled throw from inside \`setInterval\`.
	 * @param key - the once-per-row latch key.
	 * @param message - the human-readable report.
	 * @returns nothing.
	 */
	warnSilentlyOnce(key, message) {
		try {
			this.warnOnce?.(key, message);
		} catch {
			// Nothing left to report with.
		}
	}
	startTempWatch(hostCtx = this.ctx) {
		if (this.tempWatchStarted === true) return this;
		this.tempWatchStarted = true;
		if (typeof hostCtx?.effect !== "function") {
			// Not silent: a watch that cannot start is exactly the state that leaves a
			// deleted private root unrepaired until a human rebuilds it.
			this.warnOnce("sandbox-temp-guard-watch", "this row has no context that can own a disposable timer, so the sandbox private temp watch is off; a deleted private temp root will only be noticed by a confined run.");
			return this;
		}
		try {
		hostCtx.effect(() => {
			const timer = setInterval(() => {
				if (this.sandboxTempGuardEnabled === false) return;
				// A timer must never be able to take the host down: a tick that throws
				// (or a row without a working guard) is reported once, and the interval
				// stays alive to try again on the next tick.
				try {
					this.ensureTempRootUsable();
				} catch (error) {
					this.warnSilentlyOnce("sandbox-temp-guard", `the sandbox private temp watch tick failed (${String(error?.message ?? error)}).`);
				}
			}, this.tempWatchMs ?? SANDBOX_TEMP_WATCH_MS);
			timer.unref?.();
			return () => clearInterval(timer);
		}, "dsh-win-multi-bash: sandbox private temp watch");
		} catch (error) {
			// Outside a disposable scope there is nothing to attach the timer to. The
			// watch is best-effort by design: losing it must not become a new failure.
			this.warnOnce("sandbox-temp-guard-watch", `could not start the sandbox private temp watch (${String(error?.message ?? error)}).`);
		}
		return this;
	}
	/**
	 * The argv of a persistent interactive shell for this dialect, or a refusal.
	 *
	 * A dialect that cannot host a session must say so instead of inheriting a
	 * plausible-looking `bash -i`: the registry only offers dialects that declare
	 * the capability, and a silent default here would make a half-implemented
	 * dialect look finished until a session failed at spawn time.
	 * @param spec - the resolved session facts (the dialect decides what it needs).
	 * @returns the argv to hand `ctx.subprocess.spawnTerminal`.
	 * @throws when the dialect does not implement interactive sessions.
	 */
	terminalArgv(spec) {
		void spec;
		throw new Error(`${this.constructor.logName ?? 'bash'}: this dialect does not implement interactive terminal sessions`);
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
		// Repair the seam's private root BEFORE anything is spawned, on every command.
		// The plugin is the only place that knows which directory the sandbox is about
		// to require, and this code runs in the HOST process — so the repair needs no
		// elevation and no confined child, and the caller sees nothing.
		await this.ensureTempRootUsable();
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
			// Fallback channel for the private temp root: the runner's own
			// missing-temp signature in the settled stderr. The proactive check in
			// `confineRun` covers every ordinary case, so this one only fires when
			// the directory vanished between that check and the runner's own — and
			// it heals for the NEXT command: the command this call already awaits is
			// never silently re-run. Unconfined runs start no runner, so they are
			// not asked (and no guard is constructed for them).
			if (facts.unconfined !== true) this.tempGuard.observeRunnerStderr(stderr);
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
