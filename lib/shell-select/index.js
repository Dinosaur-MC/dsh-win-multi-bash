import z from "@deepseek-ai/schemastery";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { SHELL_SETTINGS_NAMESPACE, ShellExecutor } from "@deepseek-ai/dsh-shell";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";
import { GitBashExecutor } from "../bash-git/index.js";
import { WslBashExecutor } from "../bash-wsl/index.js";
import { SandboxPwshExecutor } from "@deepseek-ai/dsh-pwsh-sandbox";
import { assertServiceableBashConfig } from "@deepseek-ai/dsh-bash-local";
import { assertServiceablePwshConfig } from "@deepseek-ai/dsh-pwsh-local";
//#region lib/types/index.js
/**
* Selector Service Provider for the bash capability seam: occupies the single
* `ctx.shell` seat and routes each request to one of several backends held as
* plain instances. The tool name selects the backend (`request.shell`); a
* request without one goes to the configured `default`. Backends are
* constructed on their own child fibers with isolated `shell`/`settings`
* scopes so their inherited Service registration and settings wiring cannot
* collide with this executor's own seat. win32 compositions only; POSIX
* compositions keep a single backend directly on the seat.
* @module @deepseek-ai/dsh-shell-select
*/
/** Error code for routing to an unknown or disabled backend. */
const SHELL_BACKEND_UNAVAILABLE = "SHELL_BACKEND_UNAVAILABLE";
const DEFAULT_FACTORIES = {
	"git-bash": (ctx, config) => new GitBashExecutor(ctx, GitBashExecutor.Config(config)),
	"wsl-bash": (ctx, config) => new WslBashExecutor(ctx, WslBashExecutor.Config(config)),
	pwsh: (ctx, config) => new SandboxPwshExecutor(ctx, SandboxPwshExecutor.Config(config))
};
/**
* Selector executor over the bash capability seam. Registers as `ctx.shell`
* (the single seat), routes every request to one enabled backend by name, and
* stamps the chosen name on the resolved spec as `shellBackend`. Enabled
* names without a factory fail loud at the first rebuild; routing to an
* unbuilt name throws `SHELL_BACKEND_UNAVAILABLE`.
*/
var ShellSelectExecutor = class ShellSelectExecutor extends ShellExecutor {
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
	static Config = z.object({
		backends: z.array(z.string()).default([
			"git-bash",
			"wsl-bash",
			"pwsh"
		]),
		default: z.string().default("pwsh"),
		gitBash: GitBashExecutor.Config.default({}),
		wslBash: WslBashExecutor.Config.default({}),
		pwsh: SandboxPwshExecutor.Config.default({})
	});
	/** Test hook: replace backend construction wholesale (mirrors the sandbox-local internals pattern). */
	internals = {};
	/** The currently authoritative config: the settings section, or the composition entry. */
	source;
	backends = /* @__PURE__ */ new Map();
	fibers = [];
	constructor(ctx, config) {
		super(ctx);
		const entry = config;
		assertServiceableBashConfig(entry.gitBash);
		assertServiceableBashConfig(entry.wslBash);
		assertServiceablePwshConfig(entry.pwsh);
		this.source = () => entry;
		installSettingsSection(ctx, SHELL_SETTINGS_NAMESPACE, ShellSelectExecutor.Config, entry, {
			validate: (value) => {
				const v = value;
				assertServiceableBashConfig(v.gitBash);
				assertServiceableBashConfig(v.wslBash);
				assertServiceablePwshConfig(v.pwsh);
			},
			setSource: (current) => {
				this.source = current;
			},
			onChange: () => {
				this.rebuildBackends(this.config);
			}
		});
	}
	/** Validated config (schemastery applied the defaults before construction). */
	get config() {
		return this.source();
	}
	/** The first sandbox mode any enabled backend declares (tool-layer advertisement). */
	get sandboxMode() {
		this.ensureBackends();
		for (const name of this.config.backends) {
			const mode = this.backends.get(name)?.sandboxMode;
			if (mode !== void 0) return mode;
		}
	}
	resolve(request) {
		this.ensureBackends();
		const name = request.shell ?? this.config.default;
		return {
			...this.requireBackend(name).resolve(request),
			shellBackend: name
		};
	}
	run(spec) {
		this.ensureBackends();
		return this.requireBackend(spec.shellBackend ?? this.config.default).run(spec);
	}
	start(spec) {
		this.ensureBackends();
		return this.requireBackend(spec.shellBackend ?? this.config.default).start(spec);
	}
	requireBackend(name) {
		const backend = this.backends.get(name);
		if (backend === void 0) throw new HarnessError(`shell-select: backend "${name}" is not enabled (enabled: ${[...this.backends.keys()].join(", ")})`, SHELL_BACKEND_UNAVAILABLE);
		return backend;
	}
	/** The first rebuild runs at first use, after the internals hook is installed. */
	ensureBackends() {
		if (this.backends.size > 0) return;
		this.rebuildBackends(this.config);
	}
	/**
	* Construct one backend per enabled name on its own child fiber with
	* isolated shell/settings scopes (see the class doc), or throw for an
	* unknown name. Old fibers are disposed first so rebuilds never leak.
	*/
	rebuildBackends(entry) {
		for (const fiber of this.fibers.splice(0)) fiber.dispose();
		this.backends.clear();
		for (const name of entry.backends) {
			const factory = this.internals.factories?.[name] ?? DEFAULT_FACTORIES[name];
			if (factory === void 0) throw new Error(`shell-select: unknown backend "${name}" (enabled: ${entry.backends.join(", ")})`);
			const fiber = this.ctx.plugin({
				inject: [
					"subprocess",
					"sandbox",
					"sandboxPolicy"
				],
				apply: () => {}
			});
			this.fibers.push(fiber);
			const backendCtx = fiber.ctx.isolate("shell", Symbol(name)).isolate("settings", Symbol(name));
			this.backends.set(name, factory(backendCtx, backendConfig(name, entry)));
		}
	}
};
/**
* The config partition for one backend name. Names without a dedicated
* partition (test-hook factories) receive an empty config; the owning factory
* decides what it needs.
*/
function backendConfig(name, entry) {
	switch (name) {
		case "git-bash": return entry.gitBash;
		case "wsl-bash": return entry.wslBash;
		case "pwsh": return entry.pwsh;
		default: return {};
	}
}
//#endregion
export { SHELL_BACKEND_UNAVAILABLE, ShellSelectExecutor, ShellSelectExecutor as default };
