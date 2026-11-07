/**
 * The SSH dialect: **a shell that is not on this machine**. Two execution paths
 * share this one module:
 *
 *  - **Commands (`ssh_shell`) use ssh2.** Each call resolves a host ALIAS from the
 *    row's registry, takes an exec channel on that host's pooled connection
 *    (`./pool.js`), sends the script as base64 on stdin, and reports the exit
 *    status with stdout and stderr kept apart (`openChannel`). No local
 *    `ssh.exe` runs for a command, so nothing here depends on an OpenSSH
 *    installation.
 *  - **Persistent sessions (`terminal`) still use the OpenSSH client.** The
 *    terminal row builds this same executor and calls {@link terminalArgv}, which
 *    produces the interactive `ssh` argv a PTY runs — the only form that can
 *    carry a fingerprint/password/passphrase question to a human.
 *
 * It is a dialect like any other — one executor file plus one declaration in
 * `lib/shell-dialects.js` — and it reuses the family's loading, result shape and
 * audit guards. What it cannot reuse is the *file sandbox*, and the whole of
 * this module's unusual shape follows from that one fact:
 *
 *  - **No local wrapper, ever.** `ctx.sandbox.confine()` wraps a local argv so
 *    that the child's *file effects* are fenced. A remote command has no such
 *    effect to fence: the effects happen on the other host, and fencing a local
 *    client would only restrict which config/known_hosts/keys it may read — a
 *    different axis (and for the session form it would break the client, which
 *    must read `~/.ssh/*` outside the workspace root). So the dialect declares
 *    `effects: 'remote'` and `ShellExecutorBase.execute` routes every run to
 *    `remoteRun`, which applies no sandbox and reports the honest fact
 *    `sandbox: { mode, remote: true }` instead of a verdict nobody observed.
 *  - **Commands never prompt.** There is no remote tty on a command channel and no
 *    local stdin: a prompt could not be answered, and an unanswered one would hang
 *    until the deadline. Host keys are verified against `known_hosts`
 *    (`./known-hosts.js`); a changed key is refused by name. The way to answer
 *    any prompt is the interactive session form ({@link terminalArgv}), where a
 *    real PTY carries the question to a human.
 *  - **Cancellation signals the remote process.** A timeout or job kill sends
 *    TERM, then KILL 2 s later, then closes the channel (see
 *    {@link SshShellExecutor.signalChannel}); a channel that closes WITHOUT an
 *    exit status is reported as a lost connection, never as a completed run.
 *  - **The option surface is closed.** Every option is a declared, typed field;
 *    there is no free-form `sshOptions` string, so configuration can never
 *    inject an argv element into the session form. Its target is validated
 *    ({@link assertSshTarget}) so it can never be read as an option either, and
 *    `--` ends option parsing as a second, structural line of defence.
 *
 * @module dsh-win-multi-bash/ssh-shell
 */
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { appendFileSync, lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellExecutorBase, deriveConfig, sharedStanceConfig } from "../shell-executor.js";
import { SANDBOX_NOTICE_LEVELS, dialectById } from "../shell-dialects.js";
import { createApprovalGate } from "./approval.js";
import { assertRemoteWorkdir, defaultHost, findHost, validateHosts } from "./hosts.js";
import { BACKGROUND_RETRY_ATTEMPTS, ChannelRefusalExhausted, abortedBeforeStart, isChannelRefusal, retryDelayMs } from "./retry.js";
import { SshPool } from "./pool.js";
import { ScpRunner } from "./scp.js";
import { buildPassthroughCommand, buildScript, channelInvocation, classifyShellFamily, explainFailure } from "./script.js";

/** A positive numeric limit from the row's config, or the fallback (partial contexts). */
function positiveLimit(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Wait one wall-clock interval; the TERM -> KILL cancellation sequence needs it. */
function delayMs(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
/** The declaration this module implements (roots, stances, facts). */
const DIALECT = dialectById("ssh");
/**
 * The default **connection-phase** bound, in milliseconds.
 *
 * Milliseconds like every other timing knob in this plugin; converted to the
 * whole seconds `ConnectTimeout` takes. It bounds the TCP/SSH handshake only —
 * never the remote command, which the call's own `timeoutMs` bounds. Without it
 * a blackholed address would spend the platform's TCP timeout inside the
 * command's budget; measured here, `ConnectTimeout=3` against TEST-NET-1 fails
 * in 3.08 s.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 15e3;
/**
 * The one option that makes the one-shot form deterministic. Not a knob: a
 * deployment that needs interactive authentication for a *command* would get a
 * call that can only fail (there is no tty to prompt on) or hang, so the way to
 * authenticate interactively is the session form, not a wider command row.
 */
const BATCH_MODE_OPTION = "BatchMode=yes";
/** Expand `%VAR%` references the way the declaration's roots are written. */
function expandRoot(root, env = process.env) {
	return root.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}
/** `<root>\ssh.exe` for every declared root that can hold one, in order. */
function declaredSshPaths(env = process.env) {
	const paths = [];
	// Deduplicated on purpose: the declaration carries a `%SystemRoot%` root AND its
	// literal fallback, and those two name the SAME path on a host that has
	// SystemRoot. A route-time error that lists its probe paths must not print the
	// same one twice — a reader would take that for two separate attempts.
	for (const root of DIALECT.resolve.roots ?? []) {
		const candidate = join(expandRoot(root, env), "ssh.exe");
		if (!paths.includes(candidate)) paths.push(candidate);
	}
	return paths;
}
/**
 * Whether a candidate path is something this host can spawn: a real regular
 * file, or a symlink (an alias to a working client is fine to run — unlike
 * MSYS bash, ssh derives nothing from its own location).
 * @param candidate - the absolute candidate path.
 * @returns true when the path exists as a file or a symlink.
 */
function candidateExists(candidate) {
	try {
		const stat = lstatSync(candidate);
		return stat.isFile() || stat.isSymbolicLink();
	} catch {
		return false;
	}
}
/**
 * Candidate `ssh.exe` paths in probe order: the declared roots first (the
 * OpenSSH client Windows ships as an optional feature `OpenSSH Client`, which
 * is the client this dialect is written against), then every PATH entry — which
 * also finds a Git-for-Windows client (`<git>\usr\bin\ssh.exe`), since
 * installing Git puts that directory on PATH.
 * @param env - the environment to probe; defaults to the process environment.
 * @returns candidate paths in resolution order.
 */
function candidateSshPaths(env = process.env) {
	const candidates = [];
	for (const declared of declaredSshPaths(env))
		if (!candidates.includes(declared)) candidates.push(declared);
	for (const entry of (env.PATH ?? "").split(";")) {
		const trimmed = entry.trim().replace(/^"|"$/g, "");
		if (trimmed.length === 0) continue;
		const candidate = join(trimmed, "ssh.exe");
		if (!candidates.includes(candidate)) candidates.push(candidate);
	}
	return candidates;
}
/**
 * Resolve the ssh client this executor spawns. Returns undefined on win32 when
 * no candidate exists (the executor turns that into a loud route-time error
 * naming the probes); non-win32 hosts resolve a bare `ssh` for PATH
 * resolution, mirroring resolveBashPath / resolveWslPath.
 * @param configured - an explicit `sshPath` config value, trusted as-is.
 * @param env - the environment to probe on Windows; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @returns the first existing candidate on win32, else `ssh`, else undefined.
 */
function resolveSshPath(configured, env = process.env, platform = process.platform) {
	if (configured !== void 0 && configured.length > 0) return configured;
	if (platform === "win32") {
		for (const candidate of candidateSshPaths(env)) if (candidateExists(candidate)) return candidate;
		return;
	}
	return "ssh";
}
/**
 * Validate one hand-written target token (`sshHost` / `sshUser`).
 *
 * This is the structural half of "configuration can never inject an argv
 * element": a token beginning with `-` would be read by ssh as an OPTION (the
 * classic `-oProxyCommand=…` shape), and a token carrying whitespace or a
 * control character cannot be one argument at all. Both are refused by name
 * instead of being silently passed through.
 * @param value - the configured value.
 * @param what - the config leaf, for the refusal message.
 * @returns the value when it is a usable target token.
 * @throws Error naming the leaf and the reason.
 */
function assertSshTarget(value, what) {
	if (typeof value !== "string" || value.trim().length === 0)
		// Both rows are named on purpose: the one-shot tool reads THIS row's `sshShell`
		// partition, while a `terminal` session reads the TERMINAL row's — a deployment that
		// pinned the host on the ssh_shell row (where the composition comment tells it to) and
		// then opened a session used to be told to set the field where it already was.
		throw new Error(`ssh-shell: ${what} is not configured; set it on the ssh_shell row OR on the terminal row (Plugins page → SSH remote shell / Interactive terminal) — the one-shot tool and a session each read their own row's pin — or pin it in cordis.patch.yml.`);
	if (/^-/.test(value))
		throw new Error(`ssh-shell: ${what} ${JSON.stringify(value)} must not begin with "-": ssh would read it as an option instead of a target.`);
	if (/[\s\u0000-\u001f]/.test(value))
		throw new Error(`ssh-shell: ${what} ${JSON.stringify(value)} contains whitespace or a control character, which cannot be one ssh argument.`);
	return value;
}
/**
 * Validate the optional port pin. A port is handed to `-p` as a separate argv
 * element, so it cannot inject anything; the check is here so a nonsense value
 * fails with a sentence instead of an opaque ssh usage error.
 * @param value - the configured port.
 * @returns the value when it is a whole number in 1..65535.
 * @throws Error naming the leaf and the expected range.
 */
function assertSshPort(value) {
	if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1 || value > 65535)
		throw new Error(`ssh-shell: sshShell.sshPort must be a whole number between 1 and 65535, got ${JSON.stringify(value)}`);
	return value;
}
/**
 * The whole seconds ssh's `ConnectTimeout` takes, derived from the millisecond
 * knob, rounded DOWN so the ssh-side bound stays inside the configured one. A pin
 * under one second never reaches here: `assertConnectTimeoutMs` refuses it rather
 * than round it UP into a bound the deployment did not ask for.
 * @param connectTimeoutMs - the configured connection-phase bound.
 * @returns a whole number of seconds, at least 1.
 */
function connectTimeoutSeconds(connectTimeoutMs) {
	return Math.max(1, Math.floor(connectTimeoutMs / 1000));
}
/**
 * Validate the connection-phase bound before it becomes an ssh option.
 * `ConnectTimeout` is in whole seconds, so a request under one second cannot be
 * expressed at all — and rounding it up would hand ssh a longer bound than the
 * deployment configured. It is refused by name instead.
 * @param value - the configured bound, in milliseconds.
 * @returns the value when ssh can express it.
 * @throws Error naming the leaf and the floor.
 */
function assertConnectTimeoutMs(value) {
	if (!Number.isFinite(value) || value < 1000) {
		throw new Error(`ssh-shell: sshShell.connectTimeoutMs must be at least 1000 ms (ssh's ConnectTimeout is in whole seconds), got ${JSON.stringify(value)}`);
	}
	return value;
}
/**
 * The argv of one SSH invocation — pure, so the shape is pinned directly by the
 * audit instead of through a live connection.
 *
 * Flag order is load-bearing: every option precedes `--`, which ends option
 * parsing (measured supported on this host's OpenSSH 10.3p1), and the remote
 * command is passed as ONE argv element after the target. ssh joins its
 * remaining arguments with spaces and hands the result to the remote login
 * shell, so a single element is exactly right — and no local shell is involved
 * in the command at all.
 * @param options - the resolved facts of this invocation.
 * @param options.sshPath - the client executable.
 * @param options.target - the validated `[user@]host` token.
 * @param options.port - the validated port, or undefined for ssh's own default.
 * @param options.connectTimeoutMs - the connection-phase bound, in milliseconds.
 * @param options.acceptNewHostKeys - whether an unknown host key may be learned (TOFU).
 * @param options.command - the remote command (one-shot form only).
 * @param options.interactive - true for the session form (remote tty, prompts allowed).
 * @returns the exact argv to spawn.
 */
function buildSshArgv({ sshPath, target, port, connectTimeoutMs, acceptNewHostKeys, command, interactive }) {
	const argv = [sshPath];
	if (interactive === true) {
		// A session exists so that state AND prompts are there, so the remote tty is
		// requested explicitly: the session's own stdin is a PTY, which is what lets
		// ssh ask for a fingerprint, a password or a key passphrase at all.
		argv.push("-t");
	} else {
		// No remote tty, and no prompt of any kind. Measured: an unknown host key
		// then fails immediately (rc 255) rather than asking, so a one-shot call is
		// deterministic and can never wait on a question nobody can answer.
		argv.push("-T", "-o", BATCH_MODE_OPTION);
	}
	argv.push("-o", `ConnectTimeout=${connectTimeoutSeconds(connectTimeoutMs)}`);
	// Trust-on-first-use is a DEPLOYMENT decision, off by default — and the option is
	// emitted in BOTH states, because leaving it out would let a user or system
	// ssh_config answer the question instead (a `Host *` line saying `no` would then
	// silently accept a changed key for a one-shot call).
	//   - one-shot (no tty, BatchMode): `yes` — an unknown host fails deterministically
	//     and a changed key fails wherever the config would have said otherwise;
	//   - session (remote tty): `accept-new` when the knob is on, and the inherited
	//     `ask` when it is off — a session exists exactly so a human can answer the
	//     first-connect question, and forcing `yes` would remove that.
	if (interactive === true) {
		if (acceptNewHostKeys === true) argv.push("-o", "StrictHostKeyChecking=accept-new");
	} else {
		argv.push("-o", acceptNewHostKeys === true ? "StrictHostKeyChecking=accept-new" : "StrictHostKeyChecking=yes");
	}
	if (port !== undefined) argv.push("-p", String(port));
	argv.push("--", target);
	if (interactive !== true) argv.push(command);
	return argv;
}
/**
 * SSH executor: a dialect whose effects are elsewhere.
 *
 * The sandbox hooks below are deliberately **refusals rather than plausible
 * defaults**. `execute` routes every run to `remoteRun` before the probe gate,
 * so they are unreachable from the normal path; a dialect that answered `true`
 * from `confinedUsable()` would be promising a confinement that does not exist,
 * and one that inherited a default would look finished until a session failed.
 */
var SshShellExecutor = class extends ShellExecutorBase {
	/** The dialect prefix every warning from this row carries. */
	static logName = "ssh-shell";
	/**
	 * This dialect's file effects happen on ANOTHER host, so the local file
	 * sandbox has nothing to govern (see the module doc). The base routes every
	 * run to `remoteRun`, and the family prompt section drops its local-sandbox
	 * sentence while a remote dialect is mounted.
	 */
	static remoteEffects = true;
	/**
	 * The tool layer reads this to serve an ALIAS parameter and to treat `workdir` as
	 * a path on the remote host instead of the caller's session directory.
	 */
	static remoteHosts = true;
	static Config = deriveConfig(LocalBashExecutor.Config, {
		// The host registry (see ./hosts.js). Deliberately an untyped array of objects:
		// every field is validated by `validateHosts`, which names the field AND the
		// alias, instead of schemastery rejecting the whole array with a path nobody
		// can act on — and the browser half edits the same leaves one by one.
		hosts: z.array(z.object({})).default([]).volatile(),
		// The session pins (see the dialect's `terminalFields`) are NOT volatile here
		// on purpose: a command call never reads them, so exposing them on the ssh
		// row's page would be a control that changes nothing. They stay in this
		// schema because the terminal row builds THIS executor and seeds them into
		// it, and its own page is where a deployment edits them.
		sshPath: z.string(),
		sshHost: z.string(),
		sshUser: z.string(),
		sshPort: z.natural(),
		acceptNewHostKeys: z.boolean().default(false),
		connectTimeoutMs: z.natural().default(DEFAULT_CONNECT_TIMEOUT_MS),
		// The stance vocabulary comes from the dialect declaration. Both values mean
		// the same thing here — no local wrapper — because there is nothing local to
		// wrap; `requireSandbox` is the knob that carries an actual demand, and it
		// fails closed (see `remoteRun`). The vocabulary is deliberately NOT extended
		// with a stance nobody could honour.
		...sharedStanceConfig(DIALECT.sandboxStances, 4e3, SANDBOX_NOTICE_LEVELS)
	});
	/** The verdict one raw `hosts` value settled on, and the value it was settled for. */
	hostsVerdict;
	hostsVerdictSource;
	/**
	 * The row's validated host registry, read live and validated at most once per
	 * stored value.
	 *
	 * Validation is reported ONCE per row, not once per call: a broken array is a
	 * configuration fact, and repeating the same sentence on every command would
	 * bury the output. The row keeps registering (the other dialects share the
	 * page); every call then fails naming the same cause, which is the honest
	 * diagnostic for a stale or malformed `sshShell` partition.
	 *
	 * The verdict is what the CALL path reports: `hostFor` throws this `error`
	 * (field + alias, from `validateHosts`) rather than a generic "no hosts
	 * configured", and the first validation also `warnOnce`s, so a broken registry
	 * is visible in the log before the first command runs.
	 * @returns the `validateHosts` verdict; `hosts` is empty when it is not ok.
	 */
	hostRegistry() {
		let raw;
		try {
			raw = this.config.hosts.get();
		} catch {
			raw = [];
		}
		if (this.hostsVerdict !== undefined && this.hostsVerdictSource === raw) return this.hostsVerdict;
		this.hostsVerdictSource = raw;
		const verdict = validateHosts(raw ?? []);
		if (verdict.ok === true) {
			this.hostsVerdict = verdict;
			return verdict;
		}
		this.warnOnce("hosts", `the sshShell.hosts array is invalid (${verdict.error}); this row registers no hosts, so every call fails until it is fixed.`);
		this.hostsVerdict = { ok: false, hosts: [], error: verdict.error };
		return this.hostsVerdict;
	}
	/** The normalized hosts; empty when the array is missing or invalid (see {@link hostRegistry}). */
	get hosts() {
		return this.hostRegistry().hosts;
	}
	/** The pooled transport, built on first use (see ./pool.js). */
	poolInstance;
	/** The SFTP transfer engine, built on first use over THAT pool (see ./scp.js). */
	scpRunner;
	/**
	 * The session authorization gate (spec §11), built once from this row's ctx.
	 *
	 * The approval service is OPTIONAL here: a deployment without it still composes
	 * (the gate then fails closed with the no-answerer sentence), which is why the
	 * service is probed instead of injected.
	 * @returns the gate.
	 */
	approvalService() {
		// `ctx.approval` is a cordis SERVICE access: on a ctx that never injected it the
		// property access throws. Probe through `ctx.get` (the documented safe read) and
		// only then fall back to a plain-object ctx (unit tests).
		return typeof this.ctx?.get === "function" ? this.ctx.get("approval") : this.ctx?.approval;
	}
	/**
	 * Read the session's EFFECTIVE approval policy from the service's PUBLIC surface.
	 *
	 * dsh's ApprovalService exposes `overrideOf(session)` and `config` but keeps
	 * `effectivePolicy` private (measured against @deepseek-ai/dsh-user-approval's
	 * published types), so the same fold is composed here: the session override wins,
	 * the configured default is next, and `ask` is the fallback when a deployment has
	 * no policy surface at all. `never` is the only value that stops the request.
	 * @param approval - the approval service (or undefined).
	 * @param session - the call's session.
	 * @returns 'never' or 'ask'.
	 */
	approvalPolicy(approval, session) {
		const override = approval?.overrideOf?.(session);
		if (override === "never" || override === "ask") return override;
		const configured = approval?.config?.policy;
		return configured === "never" ? "never" : "ask";
	}
	approvalGate() {
		const approval = this.approvalService();
		const hasRequest = typeof approval?.request === "function";
		// A gate built while the service was absent must be rebuilt once it appears:
		// otherwise a late-composed approval plugin would leave the row failing closed
		// for the rest of the process. (The cached gate is kept while still absent.)
		if (this.gate === undefined || (this.gateWithoutRequest === true && hasRequest)) {
			this.gate = createApprovalGate({
				request: hasRequest ? (request) => approval.request(request) : undefined,
				logger: this.ctx?.logger,
				policy: (session) => this.approvalPolicy(approval, session),
			});
			this.gateWithoutRequest = !hasRequest;
		}
		return this.gate;
	}
	/**
	 * Authorize one use of one host in the CALL's session, before any dial.
	 *
	 * The session is DERIVED from the agent (`agent.session`) and handed to the gate
	 * together with that same agent, so the session the approval service audits under
	 * and the session a grant is cached for are the same object by construction; the
	 * gate re-checks the identity and fails closed when a wiring mistake disagrees.
	 * @param options.host - the resolved host entry.
	 * @param options.toolName - `ssh_shell` or `ssh_scp`.
	 * @param options.agent - the FULL tool-call agent (its session is the grant key).
	 * @param options.callId - the calling tool call, when known.
	 * @param options.signal - the caller's abort signal.
	 * @returns `{ granted: true }` when the host may be used.
	 */
	async authorizeHost({ host, toolName, agent, callId, signal }) {
		return this.approvalGate().authorize({
			session: agent?.session,
			agent,
			host,
			toolName,
			callId,
			signal,
		});
	}
	/**
	 * The row's transfer engine, sharing this executor's pool, hosts and logger.
	 *
	 * Built lazily on the pool's first use so the ssh_scp tool and the ssh_shell tool
	 * always end up on ONE connection per host.
	 * @returns the runner.
	 */
	transferRunner() {
		if (this.scpRunner === undefined) {
			this.scpRunner = new ScpRunner({
				pool: this.sshPool(),
				logger: this.ctx?.logger,
			});
		}
		return this.scpRunner;
	}
	/** Whether the installed ssh2 exposes the internal protocol signal request (see {@link protocolSignalsAvailable}). */
	protocolSignalSupport;
	/**
	 * This row's ssh2 connection pool: one client per alias, dialled lazily and
	 * reused by every call.
	 *
	 * Built on first use, not at apply time, so a row that is configured but never
	 * calls anything opens no connection; registered as a disposable effect so the
	 * row's reload/teardown closes every client instead of leaking sockets. A bare
	 * test double has no disposable scope, which is why the registration is guarded.
	 * @returns the pool.
	 */
	sshPool() {
		if (this.poolInstance !== undefined) return this.poolInstance;
		const pool = new SshPool({
			log: (message) => this.ctx?.logger?.warn?.(`${this.constructor.logName ?? "ssh-shell"}: ${message}`),
		});
		this.poolInstance = pool;
		try {
			this.ctx?.effect?.(() => () => this.disposePool(), "dsh-win-multi-bash: ssh connection pool");
		}
		catch {
			// No disposable scope on this context: the pool still works, it just is not
			// closed by the row's teardown (a test double, or a partial ctx).
		}
		return pool;
	}
	/** Close every pooled connection; idempotent, and the row's teardown calls it. */
	disposePool() {
		const pool = this.poolInstance;
		this.poolInstance = undefined;
		pool?.dispose();
	}
	/** The verdict `resolveSandboxMode` settled on, read back by the sync getter. */
	sandboxModeVerdict;
	/** The knob values that verdict was settled for, so a live stance edit re-settles. */
	sandboxModeVerdictKey;
	/** The capability fact (see {@link resolveSandboxMode}). */
	get sandboxMode() {
		return this.sandboxModeVerdict;
	}
	/**
	 * Settle this executor's advertised sandbox mode.
	 *
	 * There is no probe because there is nothing to probe: no local wrapper can
	 * fence a remote effect, under EITHER stance — `sandbox: none` is not "no demand"
	 * on a remote row, it is the same "nothing local to wrap" the `auto` value already
	 * means (see the dialect declaration). So the stance must not decide this: the
	 * only thing that carries a real demand is `requireSandbox`, and when it is on the
	 * mode is declared whatever the stance, so the tool layer advertises escalation
	 * (`sandbox_permissions`) and the model has the documented way out — an
	 * explicit `danger-full-access` with a justification — instead of a row that
	 * simply cannot run. Gating that on the stance left the refusal sentence naming
	 * an escape hatch the parameter table then refused to accept: a row that could
	 * neither run nor be rescued.
	 * @returns the mode to advertise, or `undefined` for a row that demands nothing.
	 */
	async resolveSandboxMode() {
		const stance = this.sandboxStance;
		const verdictKey = `${stance}|${String(this.requireSandbox)}`;
		if (this.sandboxModeVerdictKey === verdictKey) return this.sandboxModeVerdict;
		this.sandboxModeVerdictKey = verdictKey;
		return this.sandboxModeVerdict = this.requireSandbox ? this.ctx.sandboxPolicy.defaultMode : void 0;
	}
	/**
	 * One pin's current value.
	 *
	 * The session pins are plain (non-volatile) fields on this schema: the ssh
	 * command row does not edit them, and the terminal row seeds them by value when
	 * it builds this executor. A bare executor in a test may still hand a volatile
	 * ref, so both shapes are read here instead of assuming either.
	 * @param name - the pin's leaf name.
	 * @returns the configured value, or undefined when the row leaves it unset.
	 */
	pin(name) {
		const field = this.config?.[name];
		return typeof field?.get === "function" ? field.get() : field;
	}
	/** The resolved ssh client; undefined resolves to a loud route-time error. */
	trySshPath() {
		const resolve = (configured) => (this.internals.resolveSshPath ?? ((value) => resolveSshPath(value)))(configured);
		const configured = this.pin("sshPath");
		const path = resolve(configured);
		// A stale pin is used only when it really exists; otherwise the row
		// discovers the client at RUNTIME and warns once. Config is never edited
		// from here — the stored value stays byte-for-byte as the user left it.
		if (configured !== void 0 && configured.length > 0 && path === configured && !candidateExists(configured)) {
			this.warnOnce("sshPath", `sshShell.sshPath ${JSON.stringify(configured)} does not exist; falling back to auto-discovery (${(DIALECT.resolve.roots ?? []).join(", ")}, then PATH).`);
			return resolve(undefined);
		}
		return path;
	}
	/** Route-time loud failure naming the probes, per the family's error contract. */
	sshPath() {
		const path = this.trySshPath();
		if (path !== void 0) return path;
		throw new Error(`ssh-shell: no ssh client was found (probed ${candidateSshPaths().join(", ")}). Install the Windows OpenSSH client or set sshShell.sshPath on the ssh_shell tool row.`);
	}
	/** The `[user@]host` token, both halves validated so neither can be an option. */
	target() {
		const host = assertSshTarget(this.pin("sshHost"), "sshShell.sshHost");
		const user = this.pin("sshUser");
		if (user === undefined || user.length === 0) return host;
		return `${assertSshTarget(user, "sshShell.sshUser")}@${host}`;
	}
	/** The validated port, or undefined (ssh's own default). */
	port() {
		const port = this.pin("sshPort");
		return port === undefined ? void 0 : assertSshPort(port);
	}
	/**
	 * Resolve a request into a spec with the REMOTE workdir rules.
	 *
	 * A command's working directory is a directory on the machine that runs it, so
	 * for this dialect `workdir` is the absolute POSIX path the caller named on the
	 * host — never the local session cwd, and never resolved against it. The spec
	 * carries that path twice on purpose: `remoteWorkdir` is what the script builder
	 * changes into (absent when the caller named none), and `workdir` is the string
	 * the tool layer reports as `cwd` ('' = the host's login directory, which is the
	 * truth when the caller named none).
	 * @param request - the tool layer's request.
	 * @returns the resolved spec.
	 */
	resolve(request) {
		const spec = super.resolve(request);
		const named = request?.remoteWorkdir ?? request?.workdir;
		const remoteWorkdir = typeof named === "string" && named.trim().length > 0 ? named : undefined;
		if (remoteWorkdir !== undefined) assertRemoteWorkdir(remoteWorkdir);
		return {
			...spec,
			workdir: remoteWorkdir ?? "",
			...remoteWorkdir === undefined ? {} : { remoteWorkdir },
			...(typeof request?.alias === "string" && request.alias.length > 0 ? { alias: request.alias } : {}),
			// The tool layer's execution context, carried through so the authorization
			// gate can ask (and audit) under the REAL agent: a spec without one must
			// fail closed rather than invent a principal.
			...request?.agent === undefined ? {} : { agent: request.agent },
			...request?.callId === undefined ? {} : { callId: request.callId },
		};
	}
	/** The shared facts of one invocation, read live so a saved pin applies at once. */
	invocation() {
		return {
			sshPath: this.sshPath(),
			target: this.target(),
			port: this.port(),
			connectTimeoutMs: assertConnectTimeoutMs(this.pin("connectTimeoutMs")),
			acceptNewHostKeys: this.pin("acceptNewHostKeys") === true
		};
	}
	/**
	 * The host one spec targets. The registry verdict comes FIRST: a broken
	 * `sshShell.hosts` array must report its own error (field + alias) even when the
	 * caller named an alias, because "no host with alias X" over a registry that never
	 * parsed hides the actual cause.
	 *
	 * An omitted alias is only ever honoured when EXACTLY ONE host is marked
	 * `default: true` (spec §8.1). With no default — or several, which the registry
	 * rejects — the call fails and names the declared aliases: silently running on the
	 * first host would be a guess, and the guess would be about where a command runs.
	 * @param spec - the resolved execution spec, optionally carrying host/alias.
	 * @returns the normalized host entry.
	 */
	hostFor(spec) {
		const verdict = this.hostRegistry();
		if (verdict.ok !== true) throw new Error(`ssh-shell: sshShell.hosts is invalid (${verdict.error}); every call fails until it is fixed`);
		const hosts = verdict.hosts;
		if (hosts.length === 0) throw new Error("ssh-shell: no hosts are configured; add them to the sshShell.hosts array on this row");
		if (spec?.host !== undefined && spec.host !== null) return spec.host;
		if (typeof spec?.alias === "string" && spec.alias.length > 0) {
			const found = findHost(hosts, spec.alias);
			if (found !== undefined) return found;
			throw new Error(`ssh-shell: no host with alias "${spec.alias}"; this row declares ${hosts.map((host) => host.alias).join(", ")}`);
		}
		const chosen = defaultHost(hosts);
		if (chosen !== undefined) return chosen;
		throw new Error(`ssh-shell: the alias is required; this row declares ${hosts.map((host) => host.alias).join(", ")} and no host has default:true`);
	}
	/**
	 * Validate an alias the tool layer is about to run, before anything is resolved.
	 *
	 * The tool parameter is free text, so a typo has to fail as a tool error naming
	 * the declared aliases — not as a connection attempt against a host nobody
	 * configured.
	 * @param alias - the alias the caller named.
	 * @returns the normalized host entry.
	 */
	aliasHost(alias) {
		return this.hostFor({ alias });
	}
	/**
	 * The aliases this row can serve, for the tool's parameter description.
	 * @returns the declared aliases, plus the registry error when it is broken.
	 */
	aliasChoices() {
		const verdict = this.hostRegistry();
		return {
			aliases: verdict.hosts.map((host) => host.alias),
			...verdict.ok === true ? {} : { error: verdict.error },
		};
	}
	/**
	 * One stream's collector, with the family's reader shape.
	 *
	 * `maxBytes` is the retained window: past it the stream is TRUNCATED (the flag the
	 * family reports) and the dropped bytes go to a spill file (never silently lost,
	 * never unbounded). `readFrom` serves the background-job reads, by BYTE offset.
	 * @param maxBytes - the retained window.
	 * @param maxSpillBytes - the spill-file ceiling.
	 * @returns the collector (`push`, `readFrom`, `final`).
	 */
	createStream(maxBytes, maxSpillBytes) {
		const chunks = [];
		let bytes = 0;
		let truncated = false;
		let spillPath;
		let spilled = 0;
		const spill = (text) => {
			if (text.length === 0 || spilled >= maxSpillBytes) return;
			try {
				if (spillPath === undefined) spillPath = join(mkdtempSync(join(tmpdir(), "dsh-wmb-ssh-")), "stream.log");
				const buffer = Buffer.from(text, "utf8");
				const room = maxSpillBytes - spilled;
				const data = buffer.length > room ? buffer.subarray(0, room) : buffer;
				appendFileSync(spillPath, data);
				spilled += data.length;
			}
			catch {
				// A spill file that cannot be written is a degraded convenience, not a
				// reason to lose the command: the truncated flag still says what happened.
				spillPath = undefined;
			}
		};
		const push = (text) => {
			if (typeof text !== "string" || text.length === 0) return;
			const buffer = Buffer.from(text, "utf8");
			const room = maxBytes - bytes;
			if (buffer.length <= room) {
				chunks.push({ text, start: bytes });
				bytes += buffer.length;
				return;
			}
			truncated = true;
			if (room > 0) {
				const prefix = buffer.subarray(0, room).toString("utf8");
				chunks.push({ text: prefix, start: bytes });
				bytes += Buffer.byteLength(prefix, "utf8");
			}
			spill(buffer.subarray(Math.max(0, room)).toString("utf8"));
		};
		const readFrom = (fromByte) => {
			const offset = Math.max(0, Number(fromByte) || 0);
			let text = "";
			for (const chunk of chunks) {
				const end = chunk.start + Buffer.byteLength(chunk.text, "utf8");
				if (end <= offset) continue;
				text += chunk.start >= offset
					? chunk.text
					: Buffer.from(chunk.text, "utf8").subarray(offset - chunk.start).toString("utf8");
			}
			return { text, nextOffset: bytes, lossy: truncated };
		};
		const final = () => ({
			text: chunks.map((chunk) => chunk.text).join(""),
			truncated,
			...spillPath === undefined ? {} : { spillPath },
		});
		return { push, readFrom, final };
	}
	/**
	 * Probe the login shell ONCE per host/connection: cmd expands %COMSPEC% to a
	 * drive-letter path; a POSIX shell echoes the literal variable. Any failure or
	 * timeout is posix, and it never reaches the caller's result.
	 */
	probeShellFamily(client) {
		return new Promise((resolve) => {
			let settled = false;
			let stream;
			// A probe only needs the sentinel line; cap what a chatty login shell can make
			// this buffer, and close a channel that answers after the timer already won.
			const MAX_PROBE_BYTES = 4096;
			let output = "";
			const finish = (family) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { stream?.close?.(); } catch { /* already gone */ }
				resolve(family);
			};
			const timer = setTimeout(() => finish(undefined), 3000);
			try {
				client.exec("echo __DSH_SHELL__%COMSPEC%__", (error, accepted) => {
					if (settled) {
						// The timer already classified this connection. Close the late channel
						// instead of leaving it (and its login shell) running.
						try { accepted?.close?.(); } catch { /* already gone */ }
						return;
					}
					if (error !== undefined && error !== null) return finish(undefined);
					stream = accepted;
					accepted.on("data", (chunk) => {
						if (output.length < MAX_PROBE_BYTES) output += String(chunk).slice(0, MAX_PROBE_BYTES - output.length);
					});
					accepted.stderr?.on("data", () => {});
					accepted.on("close", () => finish(classifyShellFamily(output)));
					accepted.on("end", () => finish(classifyShellFamily(output)));
					accepted.on("error", () => finish(undefined));
					try { accepted.end(); } catch { /* probe channel already gone */ }
				});
			} catch {
				finish(undefined);
			}
		});
	}
	/** Cached by alias AND client: a replaced/retired connection re-probes. */
	async shellFamilyFor(client, host) {
		this.shellFamilies ??= new Map();
		const cached = this.shellFamilies.get(host.alias);
		if (cached?.client === client) return cached.family ?? await cached.pending;
		const pending = this.probeShellFamily(client);
		const record = { client, pending };
		this.shellFamilies.set(host.alias, record);
		const family = await pending;
		if (family === undefined) {
			// A failed/timed-out probe is NOT a classification: report posix for THIS
			// call only and forget the record, so the next call re-probes. Caching it
			// would turn one transient timeout into POSIX syntax for every later call
			// on an otherwise healthy cmd host.
			if (this.shellFamilies.get(host.alias) === record) this.shellFamilies.delete(host.alias);
			return "posix";
		}
		record.family = family;
		return family;
	}
	/**
	 * Open one exec channel for a call and wrap it in the family's handle.
	 *
	 * The channel's command line is the host's STATIC `shellTemplate`; the script
	 * travels as a base64 stdin payload, so no command text is ever interpolated into
	 * a shell string. The handle settles when the channel exits, waits at most 100 ms
	 * for the remaining bytes, then destroys the channel — that is what keeps a late
	 * writer from leaking into the next call. A timeout or abort sends TERM, then
	 * KILL 2 s later, then closes.
	 * @param spec - the resolved execution spec.
	 * @param onStarted - stamps the provider facts before the handle can settle.
	 * @returns the live handle.
	 */
	async openChannel(spec, onStarted) {
		const host = this.hostFor(spec);
		const maxOutputBytes = positiveLimit(this.config?.maxOutputBytes?.get?.(), 64e3);
		const maxSpillBytes = positiveLimit(this.config?.maxSpillBytes?.get?.(), 64 * 1024 * 1024);
		// A refused OPEN (MaxSessions / administratively prohibited) is retried below with
		// the bounded backoff spec §5 asks for; see ./retry.js for the classification and
		// the delays, and the loop after the lease for how the deadline and the caller's
		// abort win at every attempt.
		const built = buildScript({
			startupCommand: host.startupCommand,
			// The resolved spec's workdir IS the remote path (see resolve()): '' means the
			// caller named none, and the script builder then omits the cd entirely.
			workdir: spec.workdir,
			command: spec.command,
		});
		// The client is LEASED for the life of this call: a stalled transfer must be able
		// to retire its own connection without tearing down a command that shares it, and
		// that is only safe when every holder says when it is done.
		const pool = this.sshPool();
		const client = await pool.get(host);
		// An empty template is precise passthrough: the command goes to the login shell
		// itself. Its family decides how parts are joined (LF vs cmd &&). A non-empty
		// template is an explicit wrapper and never probes.
		const passthrough = !(typeof host.shellTemplate === "string" && host.shellTemplate.trim() !== "");
		let invocation;
		if (passthrough) {
			const family = await this.shellFamilyFor(client, host);
			invocation = channelInvocation({
				shellTemplate: host.shellTemplate,
				built,
				commandLine: buildPassthroughCommand({ family, startupCommand: host.startupCommand, workdir: spec.workdir, command: spec.command, built }),
			});
		} else {
			invocation = channelInvocation({ shellTemplate: host.shellTemplate, built });
		}
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			pool.release(client);
		};
		// Feature-detect the internal signal path once, on the first real client.
		this.protocolSignalsAvailable(client);
		let stream;
		let exitCode;
		let exitSignal;
		let onExit;
		// The OPEN can be refused for CAPACITY (MaxSessions): that is transient, so the
		// open is retried with a bounded backoff — the command is never retried, and the
		// server's own words survive to the caller. The deadline and the caller's abort
		// are armed BEFORE the first attempt, and EVERY attempt is RACED against them:
		// a server that authenticates but never answers the session OPEN (or accepts the
		// session and never answers the exec request) would otherwise hold the call
		// forever, because the retry loop only ever sees a callback that never comes.
		const hasDeadline = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 && spec.onExpiry !== "none";
		const deadlineAt = hasDeadline ? Date.now() + spec.timeoutMs : Number.POSITIVE_INFINITY;
		let preCancel;
		let preWake;
		let preCancelResolve;
		/** Resolves with the cancellation reason; the open race waits on it. */
		const preCancelPromise = new Promise((resolve) => {
			preCancelResolve = resolve;
		});
		/**
		 * Record the FIRST cancellation (timeout or caller abort) and wake whoever waits.
		 * @param kind - 'timeout' or 'abort'.
		 */
		const preAbort = (kind) => {
			if (preCancel !== undefined) return;
			preCancel = kind;
			preCancelResolve?.(kind);
			preWake?.(kind);
		};
		const preTimer = hasDeadline ? setTimeout(() => preAbort("timeout"), spec.timeoutMs) : undefined;
		const preOnAbort = () => preAbort("abort");
		if (spec.signal !== undefined) {
			if (spec.signal.aborted) preAbort("abort");
			else spec.signal.addEventListener("abort", preOnAbort, { once: true });
		}
		/** Sleep one backoff, returning early with the cancellation reason. */
		const sleepBackoff = (ms) => new Promise((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				preWake = undefined;
				resolve(undefined);
			}, ms);
			preWake = (kind) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				preWake = undefined;
				resolve(kind);
			};
		});
		const budget = spec.onExpiry === "none" ? BACKGROUND_RETRY_ATTEMPTS : Number.POSITIVE_INFINITY;
		const deadlineNote = () => `the call deadline of ${spec.timeoutMs} ms expired during channel retries`;
		let lastRefusal;
		/** The error a pre-open cancellation reports (abort wins its own name). */
		const cancelError = (kind) => kind === "abort"
			? abortedBeforeStart()
			: new ChannelRefusalExhausted(host.alias, lastRefusal, deadlineNote());
		let pendingOpen = false;
		try {
			for (let attempt = 1; ; attempt += 1) {
				if (preCancel === "abort") throw abortedBeforeStart();
				if (preCancel === "timeout") throw new ChannelRefusalExhausted(host.alias, lastRefusal, deadlineNote());
				const attemptPromise = new Promise((resolve, reject) => {
					client.exec(invocation.command, (error, accepted) => {
						if (error !== undefined && error !== null) return reject(error);
						if (preCancel !== undefined) {
							// Accepted AFTER the call was cancelled: never use it. Close the
							// channel so the server does not keep a session for a call that
							// already reported its answer.
							try {
								accepted.close?.();
							}
							catch {
								// The channel is already gone.
							}
							return reject(cancelError(preCancel));
						}
						// The exit status can be delivered in the same tick the channel opens, and
						// an event with no listener is lost — so it is captured HERE, before the
						// handle exists, and replayed once the settler is installed.
						accepted.once("exit", (code, signalName) => {
							exitCode = code;
							exitSignal = signalName;
							onExit?.(code, signalName);
						});
						resolve(accepted);
					});
				});
				// A cancellation may abandon this attempt; its late settlement is not a
				// failure to report (and a late channel was closed above).
				attemptPromise.catch(() => {});
				try {
					const raced = await Promise.race([
						attemptPromise.then((accepted) => ({ kind: "open", accepted })),
						preCancelPromise.then((kind) => ({ kind })),
					]);
					if (raced.kind !== "open") {
						pendingOpen = true;
						throw cancelError(raced.kind);
					}
					stream = raced.accepted;
					pendingOpen = false;
					break;
				}
				catch (error) {
					if (error?.name === "AbortError" || error instanceof ChannelRefusalExhausted) throw error;
					if (!isChannelRefusal(error)) throw error;
					lastRefusal = error;
					const delay = retryDelayMs(attempt);
					if (attempt >= budget) throw new ChannelRefusalExhausted(host.alias, lastRefusal, `gave up after ${attempt} attempts`);
					if (deadlineAt - Date.now() <= delay) throw new ChannelRefusalExhausted(host.alias, lastRefusal, deadlineNote());
					const reason = await sleepBackoff(delay);
					if (reason === "abort") throw abortedBeforeStart();
					if (reason === "timeout") throw new ChannelRefusalExhausted(host.alias, lastRefusal, deadlineNote());
				}
			}
		}
		catch (error) {
			release();
			if (error?.name === "AbortError" || error instanceof ChannelRefusalExhausted) {
				// An attempt may still be parked on this client. Retire exactly the client
				// this call leased: it closes with its last lease (the release above went
				// out once), so a later server answer cannot leak a channel, while a
				// concurrent command holding its own lease keeps running.
				if (pendingOpen) {
					try {
						this.sshPool().retire?.(host.alias, client);
					}
					catch {
						// A pool without retire cannot be told; the call still reports out.
					}
				}
				throw error;
			}
			throw new Error(`ssh-shell: host "${host.alias}" could not open an exec channel: ${String(error?.message ?? error)}`);
		}
		finally {
			clearTimeout(preTimer);
			spec.signal?.removeEventListener?.("abort", preOnAbort);
		}

		const stdout = this.createStream(maxOutputBytes, maxSpillBytes);
		const stderr = this.createStream(maxOutputBytes, maxSpillBytes);
		const startedAt = Date.now();
		const state = {
			settled: false,
			exitCode: null,
			signal: null,
			exited: false,
			timedOut: false,
			aborted: false,
			killed: false,
			cancelling: false,
			cancelReason: undefined,
			lateBytes: 0,
			signalUnavailable: false,
			failure: undefined,
		};
		let proc;
		let finish;
		let graceTimer;
		let timeoutTimer;
		const done = new Promise((resolve) => {
			finish = () => {
				if (state.settled) return;
				state.settled = true;
				clearTimeout(graceTimer);
				clearTimeout(timeoutTimer);
				spec.signal?.removeEventListener?.("abort", onAbort);
				try {
					stream.destroy();
				}
				catch {
					// The channel is already gone.
				}
				const cancelled = state.timedOut === true || state.aborted === true || state.killed === true;
				// A channel that ends WITHOUT an exit status, and was not cancelled, is a LOST
				// CONNECTION — not a completed command. The family must say so (spec §8.5/§13),
				// otherwise a dropped link reads as "exited with no status" and the caller has
				// no idea the work may be half done.
				if (state.exited !== true && cancelled !== true && state.failure === undefined) {
					state.failure = new Error(`ssh-shell: the connection to host "${host.alias}" was lost while the command was running (the exec channel closed without an exit status)`);
				}
				proc.status = state.failure !== undefined ? "failed" : cancelled ? "killed" : "completed";
				proc.exitCode = state.exitCode;
				proc.signal = state.signal;
				proc.droppedBytes = state.lateBytes;
				// The background/job layer reads this instead of inventing a reason: a failed
				// handle becomes a FAILED task whose detail is exactly this sentence (see
				// `processOutcome` in lib/tool-bash/types/background.js).
				if (state.failure !== undefined) proc.failureReason = state.failure.message;
				// The lease ends with the call, INCLUDING a job that settles later: the
				// handle is what the job layer awaits.
				release();
				// The spec asks for the dropped-byte count at debug (spec §8.4): it is normal
				// for a background child to keep writing on a settled channel, but a row that
				// sees it should be able to find out.
				if (state.lateBytes > 0) {
					try {
						this.ctx?.logger?.debug?.(`ssh-shell: host "${host.alias}" dropped ${state.lateBytes} byte(s) that arrived after the channel settled`);
					}
					catch {
						// A logger that throws must never fail the settle path.
					}
				}
				resolve();
			};
		});
		const onAbort = () => beginCancel("abort");
		/**
		 * Start ONE cancellation, whatever asks first.
		 *
		 * A timeout and a caller abort can race, and a job kill can arrive during either:
		 * the first reason wins (so the result says which one it was) and the TERM -> KILL
		 * sequence is sent exactly once.
		 * @param kind - 'timeout', 'abort' or 'kill'.
		 */
		const beginCancel = (kind) => {
			if (state.settled === true || state.cancelling === true) return;
			state.cancelling = true;
			state.cancelReason = kind;
			if (kind === "timeout") state.timedOut = true;
			else if (kind === "abort") state.aborted = true;
			else state.killed = true;
			void cancel();
		};
		// TERM immediately, KILL after the 2 s grace, then close: the order a shell user
		// expects and the only order that stops a process ignoring SIGTERM.
		const cancel = async () => {
			this.signalChannel(stream, "TERM", state);
			await delayMs(2000);
			if (state.settled) return;
			this.signalChannel(stream, "KILL", state);
			await delayMs(100);
			finish();
		};
		stream.on("data", (chunk) => {
			if (state.settled) {
				state.lateBytes += chunk.length;
				return;
			}
			stdout.push(String(chunk));
		});
		stream.stderr.on("data", (chunk) => {
			if (state.settled) {
				state.lateBytes += chunk.length;
				return;
			}
			stderr.push(String(chunk));
		});
		/** Record an exit status wherever it arrived from (exit event or close arguments). */
		const markExit = (code, signalName) => {
			if (code !== undefined) {
				state.exitCode = code ?? null;
				state.exited = true;
			}
			if (signalName !== undefined) {
				state.signal = signalName ?? null;
				state.exited = true;
			}
			if (state.exited === true) graceTimer = setTimeout(finish, 100);
		};
		// ssh2's client channel reports the exit status on 'close' (measured: it emits
		// `close` with (code, signal)), and can also emit 'exit' in the same tick the
		// channel opens — that one is captured inside the exec callback and replayed here.
		// Both paths apply the SAME settle rule: wait at most 100 ms for the bytes still in
		// flight, then destroy, so a late writer can never reach the next call.
		onExit = (code, signalName) => markExit(code, signalName);
		if (exitCode !== undefined) markExit(exitCode, exitSignal);
		stream.on("close", (code, signalName) => {
			markExit(code, signalName);
			// A close with no exit status settles after the same short grace; whether that is
			// a lost connection or a cancellation is decided in finish, where both are known.
			if (state.exited !== true) graceTimer = setTimeout(finish, 100);
		});
		stream.on("error", (error) => {
			if (state.settled) return;
			state.failure = new Error(`ssh-shell: the connection to host "${host.alias}" failed while the command was running: ${String(error?.message ?? error)}`);
			finish();
		});
		proc = {
			status: "running",
			exitCode: null,
			signal: null,
			sandbox: undefined,
			droppedBytes: 0,
			observed: {
				stdout: { readFrom: (offset) => stdout.readFrom(offset) },
				stderr: { readFrom: (offset) => stderr.readFrom(offset) },
			},
			done,
			kill: () => {
				// One cancellation per handle: a job kill that arrives while a timeout is
				// already cancelling must not report a second kill (or send a second
				// TERM/KILL pair).
				if (state.settled === true || state.cancelling === true) return false;
				beginCancel("kill");
				return true;
			},
			result: () => done.then(() => {
				if (state.failure !== undefined) throw state.failure;
				const out = stdout.final();
				const err = stderr.final();
				// A configuration failure (startup group or channel template) names the field
				// and the alias; a command failure keeps its own stderr unchanged. The marker
				// is consumed here, so it never reaches the caller.
				err.text = explainFailure({
					alias: host.alias,
					stderr: err.text,
					exitCode: state.exitCode,
					shellTemplate: host.shellTemplate,
				}).text;
				if (state.signalUnavailable === true) {
					// Surface the degraded cancellation in the family's own channel: the model
					// reads stderr, and silent is exactly what this must not be. `truncated`
					// is left alone on purpose — it means BYTES WERE DROPPED from that stream
					// (the collector's own fact), and an appended 114-byte annotation is not a
					// dropped byte. Marking it would report a truncation that never happened.
					err.text += (err.text.length === 0 || err.text.endsWith("\n") ? "" : "\n")
						+ "[ssh: this ssh2 build could not deliver a remote signal — the cancelled command may still be running on the host]\n";
				}
				return {
					exitCode: state.exitCode,
					signal: state.signal,
					timedOut: state.timedOut,
					aborted: state.aborted,
					timeoutMs: spec.timeoutMs,
					durationMs: Date.now() - startedAt,
					stdout: out,
					stderr: err,
				};
			}),
		};
		// The deadline applies to EVERY foreground call, signal or not. A caller signal is a
		// cancellation CHANNEL, not a replacement for the deadline: production foreground
		// calls always pass exec.signal, so arming the timer only in its absence meant a
		// call without a job registry could wait forever (review blocker). The retries
		// above already spent part of it, so what is armed here is the REMAINDER.
		if (hasDeadline) timeoutTimer = setTimeout(() => beginCancel("timeout"), Math.max(1, deadlineAt - Date.now()));
		if (spec.signal !== undefined) {
			// A signal that is already aborted wins the race: it is the first reason.
			if (spec.signal.aborted) beginCancel("abort");
			else spec.signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			// Wrapper mode: the script IS the payload; write it whole, then half-close
			// stdin so the remote template's base64 -d sees EOF. Passthrough sends no
			// stdin at all — the command text is already the channel line.
			if (invocation.stdin !== undefined) stream.write(invocation.stdin);
			// Passthrough sends no bytes, but stdin still half-closes so a remote command
			// that reads stdin sees EOF instead of waiting for input that will never come.
			stream.end();
		}
		catch (error) {
			finish();
			throw new Error(`ssh-shell: host "${host.alias}" could not send the command: ${String(error?.message ?? error)}`);
		}
		onStarted?.(proc);
		return proc;
	}
	/**
	 * Whether this ssh2 build exposes the protocol-level signal request the row needs.
	 *
	 * `Channel.signal()` is a silent no-op once stdin is half-closed (it requires
	 * `writable`, and every call is in that state after its script has been sent), so a
	 * cancelled command can only be killed through the protocol object — an INTERNAL of
	 * ssh2, which is why package.json pins `ssh2` to the verified 1.17 line. The
	 * capability is feature-detected ONCE per row: it is a property of the installed
	 * build, not of one channel.
	 * @param client - the pooled client (after its first dial).
	 * @returns true when the internal request path exists.
	 */
	protocolSignalsAvailable(client) {
		if (this.protocolSignalSupport === undefined)
			this.protocolSignalSupport = typeof client?._protocol?.signal === "function";
		return this.protocolSignalSupport === true;
	}
	/**
	 * Deliver one signal to a channel.
	 *
	 * The public `Channel.signal()` is tried first (it works while the channel is still
	 * writable); after the stdin half-close — the normal state — the request goes on the
	 * protocol object, which is valid until the channel CLOSES. If neither path exists
	 * the row says so ONCE through its logger and marks the handle, so the result can
	 * carry "the remote kill was unavailable" in stderr instead of pretending the
	 * cancellation worked.
	 * @param stream - the exec channel.
	 * @param name - the signal name ('TERM', 'KILL').
	 * @param state - the call's state (records an unavailable signal).
	 */
	signalChannel(stream, name, state) {
		try {
			stream.signal(name);
			if (stream.writable === true) return;
		}
		catch {
			// A channel that cannot signal is already closing; the protocol path is next.
		}
		const available = this.protocolSignalsAvailable(stream._client)
			&& stream.outgoing?.state !== "closed";
		if (available) {
			try {
				stream._client._protocol.signal(stream.outgoing.id, name);
				return;
			}
			catch {
				// The peer is gone; the close/settle path finishes the call.
			}
		}
		if (state !== undefined) state.signalUnavailable = true;
		this.warnOnce(
			"signal",
			`ssh-shell: this ssh2 build cannot deliver a remote signal after the command has been sent (${String(stream._client?.constructor?.name ?? "client")} exposes no usable protocol signal path); a cancelled command may keep running on the host. Install the pinned ssh2 (~1.17.0) this build was verified against.`,
		);
	}
	/**
	 * Run one spec on the remote host, and report exactly that.
	 *
	 * Same contract as the shared base's remote path (see shell-executor.js) — no local
	 * wrapper, no probe, `requireSandbox` fails closed, `sandbox: { mode, remote: true }`
	 * on the handle and the result — but the transport is a pooled ssh2 exec channel
	 * rather than a local `ssh.exe`.
	 * @param spec - the resolved execution spec.
	 * @param policy - the resolved file-effect policy (its mode is still reported).
	 * @returns the decorated handle.
	 */
	async remoteRun(spec, policy) {
		if (this.requireSandbox && policy.mode !== "danger-full-access") throw new Error(this.sandboxUnavailableMessage(policy));
		// The registry verdict and the session authorization gate BOTH run before any
		// connection exists: an unauthorized host never dials, and a rejected call
		// throws the gate's named ApprovalError (phase 'approval').
		const host = this.hostFor(spec);
		await this.authorizeHost({ host, toolName: "ssh_shell", agent: spec.agent, callId: spec.callId, signal: spec.signal });
		const facts = {
			mode: policy.mode,
			remote: true,
		};
		const proc = await this.openChannel(spec, (started) => {
			this.processFacts.set(started, { ...facts });
			started.sandbox = { ...facts };
		});
		return this.constructor.decorateResult(proc, (result) => ({
			...result,
			sandbox: { ...facts },
		}));
	}
	/**
	 * The argv of one persistent interactive session: the same client and target
	 * with a remote tty instead of `-T`, and no command, so ssh gives the remote
	 * login shell. The session's own `cwd` (where `ssh.exe` runs locally) is not
	 * used as a remote directory: the remote shell starts where its own login
	 * lands, and saying otherwise would be an invented fact.
	 * @returns argv for `ctx.subprocess.spawnTerminal`.
	 */
	terminalArgv(spec) {
		void spec;
		return buildSshArgv({ ...this.invocation(), command: void 0, interactive: true });
	}
	/**
	 * This dialect never confines, so there is no probe to gate a local wrapper
	 * with. Answering `false` would send the family down its unconfined path and
	 * report `unconfined: true` — a degradation fact about a confinement that was
	 * never attempted. Refusing by name keeps that from ever being reported.
	 */
	async confinedUsable() {
		throw new Error("ssh-shell: this dialect never confines — every run is routed to remoteRun() before the probe gate");
	}
	/** Unreachable through `execute`; explicit rather than inherited-plausible. */
	async confinedRun(spec, policy) {
		void spec;
		throw new Error(this.sandboxUnavailableMessage(policy));
	}
	/**
	 * The fail-closed sentence for `requireSandbox` on a dialect whose effects are
	 * remote: such a deployment demands a fence this host cannot provide, so the
	 * row refuses every command rather than running one unfenced in spirit.
	 */
	sandboxUnavailableMessage(policy) {
		return "ssh-shell: no sandbox can be applied to a command that runs on a remote host, so this row cannot satisfy requireSandbox under " + policy.mode + " mode. Turn requireSandbox off to accept remote runs, or retry the command with sandbox_permissions: \"danger-full-access\" and a justification if running it without a sandbox is intended.";
	}
};
export { SshShellExecutor, SshShellExecutor as default, DEFAULT_CONNECT_TIMEOUT_MS, assertConnectTimeoutMs, assertSshPort, assertSshTarget, buildSshArgv, candidateExists, candidateSshPaths, connectTimeoutSeconds, declaredSshPaths, resolveSshPath };
