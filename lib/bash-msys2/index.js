/**
 * The MSYS2 dialect: **MSYS2's own bash** (on this host
 * `D:\Local\msys64\usr\bin\bash.exe`, discovered from the HKCU uninstall key),
 * not Git for Windows'.
 *
 * It reuses the MSYS half of the mechanism by extending the Git Bash executor
 * rather than copying it, because the two really do share it: MSYS2's bash is an
 * MSYS runtime, so the windows-acl runner cannot confine it either (a failed
 * probe degrades to `unconfined: true`, or fails closed under
 * `requireSandbox`), the argv shape is the same (`bash.exe -c <command>`), and
 * the confinement-runner failure handling is identical.
 *
 * What differs — and is therefore the whole of this module:
 *  - **discovery**: the MSYS2 installation (its declared roots, then a
 *    `bashPath` pin), never Git for Windows' registry/PATH inference;
 *  - **environment**: `MSYSTEM` (exported as the declaration says) plus a PATH
 *    rooted at the MSYS2 installation, so its own packages are visible inside;
 *  - **facts**: the description says MSYS2 (pacman-managed, `$MSYSTEM`), which is
 *    what tells the model this is not Git Bash;
 *  - **the symlink rule is the MSYS one** (inherited): a symlinked `bash.exe` is
 *    refused, because MSYS derives its root from the real path.
 * @module dsh-win-multi-bash/bash-msys2
 */
import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { basename, dirname, join } from "node:path";
import { GitBashExecutor, candidateExists } from "../bash-git/index.js";
import { deriveConfig, sharedStanceConfig } from "../shell-executor.js";
import { SANDBOX_NOTICE_LEVELS, dialectById } from "../shell-dialects.js";
/** The declaration this module implements (roots, environment, stances, facts). */
const DIALECT = dialectById("msys2");
/** Expand `%VAR%` references the way the declaration's roots are written. */
function expandRoot(root, env = process.env) {
	return root.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}
/** `<root>\usr\bin\bash.exe` for every declared root that can hold one, in order. */
function declaredBashPaths(env = process.env) {
	return (DIALECT.resolve.roots ?? [])
		.map((root) => join(expandRoot(root, env), "usr", "bin", "bash.exe"));
}
/**
 * The MSYS2 installation root behind one bash.exe, or `undefined` when the path
 * is not `<root>\usr\bin\bash.exe`.
 */
function msys2RootOf(bashPath) {
	if (bashPath === undefined) return undefined;
	const bin = dirname(bashPath);
	const usr = dirname(bin);
	if (basename(bin).toLowerCase() !== "bin") return undefined;
	if (basename(usr).toLowerCase() !== "usr") return undefined;
	return dirname(usr);
}
/**
 * The PATH handed to MSYS2's bash: its own `usr\bin` and the toolchain dir of the
 * environment the declaration names, prepended to the inherited PATH — the same
 * reasoning as the Git Bash executor's `gitToolPath` (the spawn environment is
 * the scrubbed parent env with explicit overrides, so without this the MSYS2
 * toolchain would be invisible inside bash even though bash.exe is spawned by
 * absolute path).
 */
function msys2ToolPath(bashPath, inheritedPath, env = process.env) {
	const root = msys2RootOf(bashPath);
	const msystem = (DIALECT.resolve.env?.MSYSTEM ?? "UCRT64").toLowerCase();
	// The toolchain directory comes FIRST: this dialect declares that environment, so
	// `python` / `gcc` must resolve from `ucrt64\bin`, not from the MSYS `/usr/bin`
	// variants — the same order a real MSYS2 shell gives them.
	const own = root === undefined ? [dirname(bashPath)] : [
		join(root, msystem, "bin"),
		join(root, "usr", "local", "bin"),
		join(root, "usr", "bin"),
	];
	return [...own, inheritedPath].filter((entry) => entry.length > 0).join(";");
}
/**
 * MSYS2 executor: the Git Bash executor's MSYS confinement machinery, driven by
 * the MSYS2 declaration's discovery and environment.
 */
var Msys2BashExecutor = class extends GitBashExecutor {
	/** The dialect prefix every warning from this row carries. */
	static logName = "bash-msys2";
	static Config = deriveConfig(LocalBashExecutor.Config, {
		bashPath: z.string().volatile(),
		// The stance vocabulary and the probe deadline come from the declaration,
		// never from the git dialect this executor inherits its mechanism from.
		...sharedStanceConfig(DIALECT.sandboxStances, 4e3, SANDBOX_NOTICE_LEVELS)
	});
	/**
	 * The candidate bash.exe paths, in probe order.
	 *
	 * BOTH sources are functions and are CALLED here, exactly as the git dialect
	 * calls its own hooks (`(this.internals.resolveBashPath ?? ((value) => …))(…)`).
	 * Returning the function itself made every caller throw — `tryBashPath`'s
	 * `for…of` and `bashPath`'s error message both iterate it — so an UNPINNED
	 * MSYS2 row could never auto-discover its own installation. The audit's MSYS2
	 * tests all pin `bashPath`, which short-circuits this method, so it took a live
	 * session opening the unpinned dialect to find it.
	 * @returns the candidate paths; the declaration-driven probe unless a hook overrides it.
	 */
	msys2Candidates() {
		return (this.internals.msys2Candidates ?? declaredBashPaths)();
	}
	/** The resolved bash.exe, honouring a pin and warning once when it is stale. */
	tryBashPath() {
		const configured = this.config.bashPath.get();
		if (configured !== void 0 && configured.length > 0) {
			if (candidateExists(configured)) return configured;
			this.warnOnce("bashPath", `msys2Bash.bashPath ${JSON.stringify(configured)} does not exist; falling back to auto-discovery (${(DIALECT.resolve.roots ?? []).join(", ")}).`);
		} else if (this.internals.resolveBashPath !== undefined) {
			return this.internals.resolveBashPath(undefined);
		}
		for (const candidate of this.msys2Candidates()) if (candidateExists(candidate)) return candidate;
		return void 0;
	}
	bashPath() {
		const path = this.tryBashPath();
		if (path !== void 0) return path;
		throw new Error(`bash-msys2: MSYS2 was not found (probed ${this.msys2Candidates().join(", ")}). Install MSYS2 or set msys2Bash.bashPath.`);
	}
	/** The fail-closed sentence names this dialect, not Git Bash. */
	sandboxUnavailableMessage(policy) {
		return "bash-msys2: sandbox unavailable — the windows-acl runner cannot confine MSYS2 bash (probe failed); refusing to run unconfined under " + policy.mode + " mode. Fix the sandbox or retry the command with sandbox_permissions: \"danger-full-access\" and a justification.";
	}
	/**
	 * Spawn with the MSYS2 environment: `MSYSTEM` as declared, and a PATH rooted at
	 * the installation so its own packages (`pacman`, its `git`, …) resolve.
	 */
	resolve(request) {
		const bashPath = this.tryBashPath();
		const env = bashPath === void 0 ? request.env : {
			...request.env,
			...DIALECT.resolve.env,
			PATH: msys2ToolPath(bashPath, request.env?.PATH ?? process.env.PATH ?? "")
		};
		// NOT the Git executor's resolve: it rewrites PATH around the Git toolchain and
		// re-prepends `usr/bin`, undoing exactly the precedence above.
		return {
			...LocalBashExecutor.prototype.resolve.call(this, { ...request, env }),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
};
export { Msys2BashExecutor, Msys2BashExecutor as default, candidateExists, declaredBashPaths, msys2RootOf, msys2ToolPath };
