/**
 * The SSH dialect: **a shell that is not on this machine**.
 *
 * It is a dialect like any other — one executor file plus one declaration in
 * `lib/shell-dialects.js` — and it reuses the family's argv loading, result
 * shape and audit guards. What it cannot reuse is the *file sandbox*, and the
 * whole of this module's unusual shape follows from that one fact:
 *
 *  - **No local wrapper, ever.** `ctx.sandbox.confine()` wraps a local argv so
 *    that the child's *file effects* are fenced. For `ssh.exe` there is no such
 *    effect to fence: the effects happen on the remote host, and fencing the
 *    client would only restrict which local config/known_hosts/keys it may read
 *    — a different axis. Wrapping it would in fact BREAK the client, which must
 *    read `~/.ssh/*` and write `known_hosts`, all outside the workspace root.
 *    So the dialect declares `effects: 'remote'` and the shared
 *    `ShellExecutorBase.execute` routes every run to `remoteRun`, which applies
 *    no sandbox and reports the honest fact `sandbox: { mode, remote: true }`
 *    instead of a verdict nobody observed (`denied`, `enforcement`,
 *    `unconfined` and `runnerFailed` are all absent, and the renderer says so in
 *    words rather than inventing `false`).
 *  - **The one-shot form never prompts.** `-o BatchMode=yes` is a constant, not
 *    a knob: with no local tty a prompt could not be answered anyway, and an
 *    unanswered one would hang until the deadline. Measured on this host
 *    (OpenSSH 10.3p1): an unknown host key fails at once with `Host key
 *    verification failed.` and rc 255 instead of asking. The way to answer a
 *    prompt is the interactive session form (see `terminalArgv`), where a real
 *    PTY carries the fingerprint/password/passphrase question to the model.
 *  - **No remote tty**: `-T` keeps stdout and stderr separate on the wire, so
 *    the family's two-stream result shape stays meaningful. That choice costs
 *    remote cleanup — measured: `ssh -T host 'sleep N'` survives `kill -9` of
 *    the local client (no PTY ⇒ sshd does not signal the command; it only closes
 *    the channel), while the `-t` session form does reap the remote process
 *    group. Both facts are stated to the model rather than papered over.
 *  - **The option surface is closed.** Every option is a declared, typed field;
 *    there is no free-form `sshOptions` string, so configuration can never
 *    inject an argv element. The target itself is validated ({@link assertSshTarget})
 *    so it can never be read as an option either, and `--` ends option parsing
 *    as a second, structural line of defence.
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
import { defaultHost, findHost, validateHosts } from "./hosts.js";
import { SshPool } from "./pool.js";
import { buildScript } from "./script.js";

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
	 * TODO(Plan 1, Task 7 — recorded by review): the CALL path must surface THIS
	 * verdict, not a generic "no hosts configured" — a stale or malformed array has
	 * to throw `hostRegistry().error` (which names the field and the alias), and an
	 * optional boot-time `warnOnce` should make it visible before the first call.
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
	 * The host one spec targets: an explicit entry, an alias, or the row's default.
	 *
	 * TODO(Plan 1, Task 7): the empty-registry branch must name the registry verdict
	 * (`hostRegistry().error`: the field and the alias), not this generic sentence.
	 * @param spec - the resolved execution spec, optionally carrying host/alias.
	 * @returns the normalized host entry.
	 */
	hostFor(spec) {
		const hosts = this.hosts;
		if (spec?.host !== undefined && spec.host !== null) return spec.host;
		if (typeof spec?.alias === "string" && spec.alias.length > 0) {
			const found = findHost(hosts, spec.alias);
			if (found !== undefined) return found;
			const known = hosts.map((host) => host.alias).join(", ");
			throw new Error(`ssh-shell: no host with alias "${spec.alias}"; this row declares ${known.length > 0 ? known : "no hosts"}`);
		}
		if (hosts.length === 0) throw new Error("ssh-shell: no hosts configured; add them to the sshShell.hosts array on this row");
		return defaultHost(hosts) ?? hosts[0];
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
		const client = await this.sshPool().get(host);
		const maxOutputBytes = positiveLimit(this.config?.maxOutputBytes?.get?.(), 64e3);
		const maxSpillBytes = positiveLimit(this.config?.maxSpillBytes?.get?.(), 64 * 1024 * 1024);
		const built = buildScript({
			startupCommand: host.startupCommand,
			workdir: spec.remoteWorkdir,
			command: spec.command,
		});
		let stream;
		let exitCode;
		let exitSignal;
		let onExit;
		try {
			stream = await new Promise((resolve, reject) => {
				client.exec(host.shellTemplate ?? undefined, (error, accepted) => {
					if (error !== undefined && error !== null) return reject(error);
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
		}
		catch (error) {
			throw new Error(`ssh-shell: host "${host.alias}" could not open an exec channel: ${String(error?.message ?? error)}`);
		}
		const stdout = this.createStream(maxOutputBytes, maxSpillBytes);
		const stderr = this.createStream(maxOutputBytes, maxSpillBytes);
		const startedAt = Date.now();
		const state = { settled: false, exitCode: null, signal: null, timedOut: false, aborted: false, killed: false, lateBytes: 0 };
		let finish;
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
				proc.status = state.killed === true || state.timedOut === true || state.aborted === true ? "killed" : "completed";
				proc.exitCode = state.exitCode;
				proc.signal = state.signal;
				resolve();
			};
		});
		let graceTimer;
		let timeoutTimer;
		const onAbort = () => {
			if (state.settled) return;
			state.aborted = true;
			void cancel();
		};
		// TERM immediately, KILL after the 2 s grace, then close: the order a shell user
		// expects and the only order that stops a process ignoring SIGTERM.
		const cancel = async () => {
			if (state.settled) return;
			this.signalChannel(stream, "TERM");
			await delayMs(2000);
			if (state.settled) return;
			this.signalChannel(stream, "KILL");
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
		// ssh2's client channel reports the exit status on 'close' (measured: it emits
		// `close` with (code, signal) and no 'exit' event at all in 1.x). The 'exit'
		// listener stays for versions that do emit it; both paths apply the SAME settle
		// rule — wait at most 100 ms for the bytes still in flight, then destroy, so a
		// late writer can never reach the next call.
		onExit = (code, signalName) => {
			if (code !== undefined) state.exitCode = code ?? null;
			if (signalName !== undefined) state.signal = signalName ?? null;
			graceTimer = setTimeout(finish, 100);
		};
		// Replay an exit that arrived before the settler existed.
		if (exitCode !== undefined) onExit(exitCode, exitSignal);
		stream.on("close", (code, signalName) => {
			if (state.exitCode === null && code !== undefined) state.exitCode = code ?? null;
			if (state.signal === null && signalName !== undefined) state.signal = signalName ?? null;
			graceTimer = setTimeout(finish, 100);
		});
		stream.on("error", () => finish());
		const proc = {
			status: "running",
			exitCode: null,
			signal: null,
			sandbox: undefined,
			observed: {
				stdout: { readFrom: (offset) => stdout.readFrom(offset) },
				stderr: { readFrom: (offset) => stderr.readFrom(offset) },
			},
			done,
			kill: () => {
				if (state.settled) return false;
				state.killed = true;
				void cancel();
				return true;
			},
			result: () => done.then(() => ({
				exitCode: state.exitCode,
				signal: state.signal,
				timedOut: state.timedOut,
				aborted: state.aborted,
				timeoutMs: spec.timeoutMs,
				durationMs: Date.now() - startedAt,
				stdout: stdout.final(),
				stderr: stderr.final(),
			})),
		};
		// Armed only after the handle exists: an already-aborted signal or an immediate
		// timeout would otherwise settle a handle whose fields are not defined yet.
		if (Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 && spec.onExpiry !== "none" && spec.signal === undefined) {
			timeoutTimer = setTimeout(() => {
				if (state.settled) return;
				state.timedOut = true;
				void cancel();
			}, spec.timeoutMs);
		}
		if (spec.signal !== undefined) {
			if (spec.signal.aborted) onAbort();
			else spec.signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			// The script IS the payload: write it whole, then half-close stdin so the
			// remote template's base64 -d sees EOF.
			stream.write(built.payload);
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
	 * Deliver one signal to a channel.
	 *
	 * `Channel.signal()` refuses once the channel's stdin is half-closed (the
	 * implementation requires `writable`), which is exactly the state our calls are in
	 * after the script has been sent — but a channel request is valid until the channel
	 * CLOSES, so the request is sent on the protocol object in that case. Measured
	 * against a real server: the request reaches the peer either way; ssh2's own server
	 * fixture simply drops post-EOF requests, which is why the cancellation tests
	 * observe this call.
	 * @param stream - the exec channel.
	 * @param name - the signal name ('TERM', 'KILL').
	 */
	signalChannel(stream, name) {
		let sent = false;
		try {
			stream.signal(name);
			sent = stream.writable === true;
		}
		catch {
			// A channel that cannot signal is already closing.
		}
		if (sent) return;
		try {
			const protocol = stream._client?._protocol;
			if (protocol?.signal !== undefined && stream.outgoing?.state !== "closed") protocol.signal(stream.outgoing.id, name);
		}
		catch {
			// The peer is gone; the close/settle path finishes the call.
		}
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
