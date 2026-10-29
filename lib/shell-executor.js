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
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { classifyRunnerFailure, denialFacts, isRunnerSpawnFailure } from "./vendor/helpers.js";
import { SandboxTempGuard, getSandboxTempGuardEnabled, getSandboxTempWatchMs } from "./sandbox-temp-guard.js";
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
/** Default probe deadline when the row's config cannot supply one (partial contexts, mocks). */
const DEFAULT_PROBE_DEADLINE_MS = 8000;

/**
 * A bounded deadline for one probe or `confine` call.
 *
 * Defense in depth, stated as what it is: on the 0.2.1-rc.2 sandbox provider a
 * `confine` call has no await point, so this signal never fires there — the real
 * bound on a probe is the spawn timeout that follows it. It is here because the
 * call is the one place a future provider could start waiting, and a boot-path
 * await without a bound is exactly the failure that leaves a row activating
 * forever. Reading the budget is itself guarded: a partial context may not carry
 * the row's config, and a deadline that cannot be read must not turn into "no
 * deadline".
 * @param readMs - a positive millisecond budget, or a thunk that reads one.
 * @returns an AbortSignal that aborts after that budget.
 */
export function probeDeadline(readMs) {
    let ms;
    try {
        ms = typeof readMs === 'function' ? readMs() : readMs;
    }
    catch {
        ms = undefined;
    }
    const value = Number(ms);
    return AbortSignal.timeout(Number.isFinite(value) && value > 0 ? value : DEFAULT_PROBE_DEADLINE_MS);
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
	/**
	 * Whether this dialect's file effects happen on ANOTHER host.
	 *
	 * `false` for every dialect whose command this host runs: the local file
	 * sandbox governs the effects, and the probe/wrap machinery below applies.
	 * `true` only for the SSH dialect, whose effects are on the remote side —
	 * {@link execute} then routes every run to {@link remoteRun}, which applies no
	 * local wrapper and reports the one fact that is actually observable.
	 */
	static remoteEffects = false;
	/** Read the dialect capability as an instance fact (see the static above). */
	get remoteEffects() {
		return this.constructor.remoteEffects === true;
	}
	/** Test hook mirroring the sandbox-local internals pattern. */
	internals = {};
	/** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
	processFacts = /* @__PURE__ */ new Map();
	/** Knobs already warned about, so one bad value warns once per row. */
	warnedAbout;
	/** The learned refusal signature, cached per row (see each dialect's discovery). */
	denialDiscovery;
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
	/**
	 * Run one probe program asynchronously under a hard deadline.
	 *
	 * A probe must never block the host event loop: a hanging `wsl.exe` would
	 * freeze every other row's boot, which is why the wait here is a timer and
	 * the child is killed on it. Every dialect's probes go through this helper.
	 * @param program - the executable to run.
	 * @param args - its arguments.
	 * @param options.timeoutMs - the deadline, after which the child is killed.
	 * @param options.capture - which stream to resolve with (`stdout`, `stderr` or `both`).
	 * @returns `{ status, stdout, stderr }`; `status` is null on timeout or spawn failure.
	 */
	runProbe(program, args, {
		timeoutMs,
		capture = null
	}) {
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let timer;
			let settled = false;
			const finish = (status) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({
					status,
					stdout,
					stderr
				});
			};
			const child = spawn(program, args, {
				windowsHide: true,
				stdio: ["ignore", capture === "stdout" || capture === "both" ? "pipe" : "ignore", capture === "stderr" || capture === "both" ? "pipe" : "ignore"]
			});
			timer = setTimeout(() => {
				child.kill();
				finish(null);
			}, timeoutMs);
			if (capture === "stdout" || capture === "both") child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			if (capture === "stderr" || capture === "both") child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", () => finish(null));
			child.on("close", (code) => finish(code));
		});
	}
	/** The file-effect policy for one spec: the caller's, or this composition's default. */
	confinedPolicy(spec) {
		return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
	}
	/**
	 * Whether healing is allowed: the deployment-wide switch the package row owns,
	 * read live from the settings service. There is no per-row copy — the switch is
	 * listed once, at the top of the plugin, and every executor reads that one value.
	 */
	get sandboxTempGuardEnabled() {
		return getSandboxTempGuardEnabled();
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
		// Two promises this probe would break: the switch OFF promises no filesystem
		// work at all, and `none` promises the dialect never consults ctx.sandbox. The
		// probe below is the one path that calls the seam with nothing learned yet, so
		// it must not be reached on either of them.
		if (this.sandboxTempGuardEnabled === false) return;
		// A bare test double may carry no stance at all; that is not a reason to fail
		// the command, and the probe below is best-effort anyway.
		let stance;
		try {
			stance = this.sandboxStance;
		} catch {
			stance = undefined;
		}
		if (stance === "none") return;
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
			// BOUNDED. This runs from the row's apply (the watch starts its first tick
			// synchronously), so a confine() that never settles would hold the row's
			// activation open forever — and a host that cannot finish activating a row
			// never reports itself ready. Same deadline the capability probe uses: a
			// repair that cannot complete in time is skipped, not waited on.
			const probe = await this.ctx.sandbox.confine([process.execPath, "-e", ""], policy, probeDeadline(() => this.probeTimeoutMs));
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
			let timer;
			let stopped = false;
			// Self-rescheduling, reading the LIVE interval each round: the knob on the
			// plugin page is meant to be usable while watching a broken directory, so a
			// change must not need a row reload to be noticed.
			const schedule = () => {
				if (stopped) return;
				// An explicit per-instance value still wins (a test or a future row may set it);
				// otherwise the deployment-wide live value the plugin page writes is what every
				timer = setTimeout(tick, this.tempWatchMs ?? getSandboxTempWatchMs());
				timer.unref?.();
			};
			const tick = () => {
				if (this.sandboxTempGuardEnabled !== false) {
					// A timer must never be able to take the host down: a tick that throws
					// (or a row without a working guard) is reported once, and the watch
					// stays alive to try again on the next tick.
					try {
						this.ensureTempRootUsable();
					} catch (error) {
						this.warnSilentlyOnce("sandbox-temp-guard", `the sandbox private temp watch tick failed (${String(error?.message ?? error)}).`);
					}
				}
				schedule();
			};
			schedule();
			return () => {
				stopped = true;
				clearTimeout(timer);
			};
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
		// A dialect whose effects are NOT on this host has nothing for the local file
		// sandbox to govern, so it is routed away from every confined path before the
		// private-temp repair and the probe gate — both of which exist only to serve a
		// local wrapper. Reporting `unconfined: true` here instead would state a
		// degradation of a confinement that was never attempted.
		if (this.remoteEffects) return this.remoteRun(spec, policy);
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
	 * Run one spec whose file effects are NOT on this host, and report exactly that.
	 *
	 * There is no probe, no wrapper and no runner here, so none of the confined
	 * vocabulary is available: `denied` would be a verdict about a sandbox that
	 * never ran, `enforcement` would name an enforcement that never happened,
	 * `runnerFailed` would blame a runner that was never started, and
	 * `unconfined: true` would read as "a sandbox was asked for and could not be
	 * applied". The one honest token is `remote: true` beside the policy mode:
	 * this command ran with the local file sandbox deliberately not applied,
	 * because it governs nothing here. Which is also why the private-temp repair
	 * is skipped — it exists to keep a local wrapper working.
	 *
	 * `requireSandbox` FAILS CLOSED instead: a deployment that demands a fence
	 * this host cannot provide gets a refusal rather than a run it would have to
	 * misdescribe. The documented way through is an explicit
	 * `danger-full-access`, which the tool layer offers as an escalation.
	 * @param spec - the resolved execution spec.
	 * @param policy - the resolved file-effect policy (its mode is still reported).
	 * @returns the decorated handle, whose `sandbox` carries only `mode` and `remote`.
	 */
	async remoteRun(spec, policy) {
		if (this.requireSandbox && policy.mode !== "danger-full-access")
			throw new Error(this.sandboxUnavailableMessage(policy));
		const facts = {
			mode: policy.mode,
			remote: true
		};
		const proc = await this.executeArgv(spec, this.argv(spec), (started) => {
			// Stamped before settlement, so a background job's terminal detail and a
			// promoted call's seeded read see the same facts as the foreground result.
			this.processFacts.set(started, { ...facts });
			// The same facts on the handle itself, before `done` settles: a promoted
			// (timed-out) call reads its seeded output from `proc.sandbox` BEFORE the
			// settle path gets a chance to stamp it, and an unpatched read told a model
			// nothing about a remote shell it was still waiting on.
			started.sandbox = { ...facts };
		});
		return this.constructor.decorateResult(proc, (result) => ({
			...result,
			sandbox: { ...facts }
		}));
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
			started.sandbox = { mode: policy.mode, unconfined: true };
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
			// A remote run starts no runner, so there is no runner stderr to observe
			// either (and the guard has nothing to repair for it).
			if (facts.unconfined !== true && facts.remote !== true) this.tempGuard.observeRunnerStderr(stderr);
			// An unwrapped run reports the one fact that matters — it was not
			// confined — and nothing it cannot know (enforcement, denials). A remote run
			// reports the fact that the sandbox does not apply here at all, and likewise
			// claims no enforcement and no verdict.
			proc.sandbox = facts.unconfined === true ? {
				mode: facts.mode,
				unconfined: true
			} : facts.remote === true ? {
				mode: facts.mode,
				remote: true
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
