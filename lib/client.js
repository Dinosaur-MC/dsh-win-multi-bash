/**
 * dsh-win-multi-bash — browser half.
 *
 * The tool rows carry their own configuration (the tool-layer switches
 * `enableRunInBackground` and `guardSandboxTemp`, plus the backend partition:
 * paths, sandbox stance, probe timeout, sandbox hardening, and the executor's
 * command limits). This module gives each row a
 * **Configure** page on the Web sidebar's Plugins page, through the
 * `plugins.row.config` slot keyed by `<package name>#<row id>`, so the options
 * are edited in the panel instead of by hand in `cordis.patch.yml`.
 *
 * It also labels the bundle itself: the plugin has a **core row** (the package
 * row, `win-mb-plugin`) that carries this browser half and owns the shared shell
 * prompt section, and the panel cannot mark a third-party row read-only — dsh's
 * plugin manager locks only its own protected modules, its own row, and rows the
 * profile patch cannot address. So the core row is named where a user reads it
 * instead: a badge beside the bundle's title and a note under the row list, both
 * through `plugins.detail.badge` / `plugins.detail.section`.
 *
 * Persistence is the platform's own: every knob is declared `.volatile()` in the
 * host half, which is exactly what makes it addressable by the settings service
 * (`ctx.configForms` here, `settings` on the host) and writable through the
 * profile's Cordis patch. This half owns no storage and no HTTP route.
 *
 * The form is staged, not live: a control writes nothing until **Save**; a save
 * is fenced by the revision its drafts were **read at** rather than the latest
 * one, so a write by someone else in the meantime is refused instead of
 * overwritten; it writes only the fields a draft actually changes; a save
 * already crossing the wire is not re-entered; and a save the Host refuses keeps
 * its drafts. See `dsh-settings` for the projection and the mutation contract,
 * and `dsh-client-ui-plugin-manager` for the slots.
 *
 * @module dsh-win-multi-bash/client
 */
window.__ModuleLoader__.load({
	id: "dsh-win-multi-bash",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;

		//#region locales
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.win-mb-bash";
		/** The package this browser half belongs to; every detail contribution filters on it. */
		const PACKAGE_NAME = "dsh-win-multi-bash";
		/** The core row's id, as `cordis.patch.yml` declares it. */
		const CORE_ROW_ID = "win-mb-plugin";
		/** English copy. */
		const en = {
			summary: "Configure the shell tool rows (git_bash, wsl_bash, msys2_bash) and the interactive terminal row: paths, sandbox stance, command limits, and session shape.",
			coreBadge: "core row",
			coreNote: "This plugin inserts one row per shell tool (git_bash, wsl_bash, and the opt-in msys2_bash), one row for the interactive terminal tool, and its core row. Configure each tool on its own row. Keep the core row enabled — it serves this page and owns the shared shell prompt section; with it off the tools still run and carry that guidance in their own descriptions, but the Configure controls on this page disappear.",
			unavailable: "This row is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving…",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidNumber: "Enter a number, or leave blank to use the default (got \"{value}\").",
			invalidPath: "Enter an absolute path, or leave blank to use the default (got \"{value}\").",
			invalidDistro: "A distribution name cannot contain spaces or quotes (got \"{value}\").",
			"option.auto": "auto",
			"option.none": "none",
			"option.bwrap": "bwrap",
			"option.once": "First unwrapped run only",
			"option.always": "Every unwrapped run",
			"enableRunInBackground.label": "Background jobs",
			"enableRunInBackground.hint": "Whether this tool accepts run_in_background. The tool schema carries this argument, so it follows the row's next load.",
			"guardSandboxTemp.label": "Self-heal the sandbox temp directory",
			"guardSandboxTemp.hint": "When the DSH sandbox's private temp directory (`%TEMP%` + `dsh-<6>`) has been removed out of band — an OS temp cleaner, a manual delete — recreate it and restore its write grant before the next confined command, instead of letting every wrapped spawn fail with \"the runner refused a missing --temp\" (exit 127). Only a MISSING `dsh-<6>` direct child of an OS temp root, outside every workspace root, is ever touched, and nothing is ever deleted. Live: turning it off stops healing from the next command. Applies to the Windows ACL path (`git_bash`, `msys2_bash`); `wsl_bash` uses bwrap and has no such directory.",
			"option.git_bash": "Git Bash",
			"option.wsl_bash": "WSL Bash",
			"option.msys2_bash": "MSYS2 Bash",
			"defaultShell.label": "Default shell for new sessions",
			"defaultShell.hint": "Which dialect an open starts when the call names no shell. Only the dialects that declare an interactive session are offered.",
			"maxSessions.label": "Maximum open sessions",
			"maxSessions.hint": "Opening one more is refused by name. Sessions are process-local, reclaimed when idle, and ended with action close.",
			"idleMs.label": "Idle timeout (ms)",
			"idleMs.hint": "A session with no send/read/signal for this long is terminated and removed. A stale id then says it was reclaimed instead of looking unknown.",
			"rows.label": "Terminal rows",
			"rows.hint": "Initial terminal height (also the default for a resize passed to send).",
			"cols.label": "Terminal columns",
			"cols.hint": "Initial terminal width. Ordinary output wraps at this width, so a wider value keeps lines readable.",
			"maxBufferBytes.label": "Retained output per session (bytes)",
			"maxBufferBytes.hint": "Retention cap for one session's scrollback. Older output is dropped and the next read reports it (truncated); seq 1 200000 measured 1.42 MiB.",
			"waitMs.label": "Default wait for output to settle (ms)",
			"waitMs.hint": "How long send/signal hold before returning partial output. Silence ends the wait early — and it means the output went quiet, NOT that the command finished.",
			"quietMs.label": "Silence threshold (ms)",
			"quietMs.hint": "How long output must be silent to count as settled. The measured worst-case gap between chunks is 216 ms, so 500 leaves headroom.",
			"maxWaitMs.label": "Maximum wait a call may request (ms)",
			"maxWaitMs.hint": "A waitMs above this is clamped to it, so one call can never hold a session longer than this.",
			"allowUnconfined.label": "Allow unconfined sessions",
			"allowUnconfined.hint": "A PTY session cannot be file-sandboxed, so opening one runs unconfined. With this off, open is refused instead while every other action stays available.",
			"cwd.label": "Default working directory",
			"cwd.hint": "Used when a call passes no workdir; empty means the session workspace.",
			"timeoutMs.label": "Default command timeout (ms)",
			"timeoutMs.hint": "How long one command may run before it is terminated. A background job ignores it: it runs until it finishes or is cancelled.",
			"maxTimeoutMs.label": "Maximum timeout a call may request (ms)",
			"maxTimeoutMs.hint": "A call asking for more is clamped to this. It never applies to a background job.",
			"maxOutputBytes.label": "Output cap per stream (bytes)",
			"maxOutputBytes.hint": "Output beyond this spills to a temporary file instead of being lost.",
			"maxSpillBytes.label": "Spill file cap (bytes)",
			"maxSpillBytes.hint": "How much of that spilled output is retained.",
			"graceMs.label": "Grace before a forced kill (ms)",
			"graceMs.hint": "How long a terminated command may still flush before it is killed outright.",
			"bashPath.label": "Git Bash executable",
			"bashPath.hint": "Pin an explicit bash.exe. Empty probes Git for Windows instead (PATH, well-known installs, then the registry).",
			"wslPath.label": "WSL launcher",
			"wslPath.hint": "Pin an explicit wsl.exe. Empty uses the standard Windows location.",
			"wslDistro.label": "Distribution",
			"wslDistro.hint": "Pin a distribution by name. Empty uses the first one WSL lists.",
			"sandbox.label": "Sandbox stance",
			"sandbox.hint": "auto probes and degrades honestly; none never confines; bwrap (WSL only) refuses to run unconfined.",
			"probeTimeoutMs.label": "Sandbox probe timeout (ms)",
			"probeTimeoutMs.hint": "How long the confinement probe may take before it is treated as a failure.",
			"requireSandbox.label": "Refuse unconfined runs when the probe fails",
			"requireSandbox.hint": "With it on, read-only and workspace-write calls are refused instead of degrading; danger-full-access still runs.",
			"sandboxNotice.label": "Unwrapped-run notice",
			"sandboxNotice.hint": "How often a run that the sandbox did not wrap says so. once (default): this row explains itself on its first such run and stays quiet afterwards — the structured sandbox.unconfined fact still rides on every result. always: every such run keeps the short note.",
		};
		/** Simplified Chinese copy. */
		const zh = {
			summary: "配置各 shell 工具行（git_bash、wsl_bash、msys2_bash）与交互式终端行（terminal）：路径、沙箱立场、命令限制与会话形态。",
			coreBadge: "核心行",
			coreNote: "本插件为每个 shell 工具插入一行（git_bash、wsl_bash，以及按需开启的 msys2_bash），再加一行交互式终端（terminal），以及核心行。工具各自在自己的行上配置。请保持核心行开启——本页由它提供，共有的那段 shell 提示词也归它所有；关掉后工具照旧可用（共有指导回落到各自的描述里），但本页的配置入口会消失。",
			unavailable: "该行当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			save: "保存",
			saving: "保存中…",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidNumber: "请填数字；留空表示使用默认值（当前为「{value}」）。",
			invalidPath: "请填绝对路径；留空表示使用默认值（当前为「{value}」）。",
			invalidDistro: "发行版名称不能包含空格或引号（当前为「{value}」）。",
			"option.auto": "自动",
			"option.none": "不限制",
			"option.bwrap": "bwrap",
			"option.once": "仅首条未包裹运行",
			"option.always": "每条未包裹运行",
			"enableRunInBackground.label": "后台任务",
			"enableRunInBackground.hint": "该工具是否接受 run_in_background；该参数属于工具 schema，需该行下次加载后生效。",
			"guardSandboxTemp.label": "沙箱临时目录自愈",
			"guardSandboxTemp.hint": "当 DSH 沙箱的私有临时目录（`%TEMP%` 下的 `dsh-<6>`）被带外删除（系统临时文件清理器、手工删除）后，在下一条被包裹的命令之前重建它并恢复其写授权，而不是让之后每一次被包裹的 spawn 都因「runner 拒绝了不存在的 --temp」（exit 127）而失败。只有「不存在的、位于 OS 临时根之下且不在任何工作区根内的 `dsh-<6>` 直接子目录」才会被动到，且绝不删除任何东西。即时生效：关掉后从下一条命令起停止自愈。只作用于 Windows ACL 路径（`git_bash`、`msys2_bash`）；`wsl_bash` 用 bwrap，没有这个目录。",
			"option.git_bash": "Git Bash",
			"option.wsl_bash": "WSL Bash",
			"option.msys2_bash": "MSYS2 Bash",
			"defaultShell.label": "新会话默认 shell",
			"defaultShell.hint": "调用未传 shell 时，open 启动哪个方言；只列出声明了交互会话能力的方言。",
			"maxSessions.label": "会话数上限",
			"maxSessions.hint": "超出时再开会被具名拒绝。会话是进程内的，空闲会被回收；用 close 主动结束。",
			"idleMs.label": "空闲回收（毫秒）",
			"idleMs.hint": "这段时间内没有 send/read/signal 的会话会被终止并移除；之后用旧 id 会被告知「已被空闲回收」，而不是含糊的 unknown。",
			"rows.label": "终端行数",
			"rows.hint": "初始终端高度（也是 send 时 resize 的默认值）。",
			"cols.label": "终端列数",
			"cols.hint": "初始终端宽度。普通输出会按此宽度折行，宽一些更可读。",
			"maxBufferBytes.label": "单会话输出保留（字节）",
			"maxBufferBytes.hint": "单个会话回滚缓冲的上限；更早的输出会被丢弃，并在下次读取时如实上报（truncated）。实测 seq 1 200000 为 1.42 MiB。",
			"waitMs.label": "默认等待输出静止（毫秒）",
			"waitMs.hint": "send/signal 最多持有多久才返回部分输出。静默会提前结束等待——它表示输出安静了，不是命令结束了。",
			"quietMs.label": "静默阈值（毫秒）",
			"quietMs.hint": "输出持续安静多久才算静止。实测块间最大间隔 216 ms，故取 500 留出余量。",
			"maxWaitMs.label": "单次调用可请求的最大等待（毫秒）",
			"maxWaitMs.hint": "超过该值的 waitMs 会被压到该上限，因此单次调用不会把会话占住更久。",
			"allowUnconfined.label": "允许未包裹会话",
			"allowUnconfined.hint": "PTY 会话无法被文件沙箱包裹，因此开启会话即未包裹运行。关掉后 open 会被拒绝，其余 action 不受影响。",
			"cwd.label": "默认工作目录",
			"cwd.hint": "调用未传 workdir 时使用；留空表示会话工作区。",
			"timeoutMs.label": "默认命令超时（毫秒）",
			"timeoutMs.hint": "单条命令允许运行多久，超时即终止。后台任务不受此限制：它一直跑到结束或被取消。",
			"maxTimeoutMs.label": "单次调用可请求的最大超时（毫秒）",
			"maxTimeoutMs.hint": "调用请求更大值时会被压到该上限；该上限对后台任务不生效。",
			"maxOutputBytes.label": "单流输出上限（字节）",
			"maxOutputBytes.hint": "超出部分转存到临时文件，而不是被丢弃。",
			"maxSpillBytes.label": "转存文件上限（字节）",
			"maxSpillBytes.hint": "转存输出保留多少。",
			"graceMs.label": "强制终止前的宽限（毫秒）",
			"graceMs.hint": "命令被终止后仍可冲刷输出的时间。",
			"bashPath.label": "Git Bash 可执行文件",
			"bashPath.hint": "钉定显式 bash.exe；留空则自动探测 Git for Windows（PATH、常见安装位置、注册表）。",
			"wslPath.label": "WSL 启动器",
			"wslPath.hint": "钉定显式 wsl.exe；留空使用 Windows 标准位置。",
			"wslDistro.label": "发行版",
			"wslDistro.hint": "按名钉定发行版；留空使用 WSL 列出的第一个。",
			"sandbox.label": "沙箱立场",
			"sandbox.hint": "auto 探测并如实降级；none 从不限制；bwrap（仅 WSL）拒绝无沙箱运行。",
			"probeTimeoutMs.label": "沙箱探测超时（毫秒）",
			"probeTimeoutMs.hint": "探测限制能力最多耗时多久，超时按失败处理。",
			"requireSandbox.label": "探测失败时拒绝无沙箱运行",
			"requireSandbox.hint": "开启后 read-only / workspace-write 直接拒绝而非降级；danger-full-access 仍放行。",
			"sandboxNotice.label": "未包裹运行提示",
			"sandboxNotice.hint": "沙箱没包裹住的运行要提示几次。once（默认）：该行只在第一条这类运行上说明一次，之后保持安静——结构化的 sandbox.unconfined 事实仍在每条结果里。always：每条这类运行都保留那句短提示。",
		};
		//#endregion

		//#region fields
		/**
		 * One editable knob. `path` addresses it inside the row's config, `kind`
		 * picks the control, and `key` names its copy in the dictionary
		 * (`<key>.label` / `<key>.hint`). Every path here is `.volatile()` in the
		 * host half — the settings service refuses anything else, and the host
		 * audit pins that list.
		 */
		const field = (path, kind, options) => ({ key: path.join("."), path, kind, options });
		//#region registry-derived (generated)
		/**
		 * Syntax rule per text knob leaf, from the dialect registry. The browser
		 * has no filesystem: this decides the visible warning only, and the
		 * executor answers the existence question at use time.
		 */
		const LEAF_RULES = { "cwd": "path", "bashPath": "path", "wslPath": "path", "wslDistro": "distro" };
		/** The tool rows this bundle configures, in composition order. */
		const ROWS = [
			{
				rowId: "win-mb-tool-git",
				label: { en: "Git Bash", zh: "Git Bash" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
					field(["guardSandboxTemp"], "boolean"),
					field(["gitBash", "cwd"], "text"),
					field(["gitBash", "timeoutMs"], "number"),
					field(["gitBash", "maxTimeoutMs"], "number"),
					field(["gitBash", "maxOutputBytes"], "number"),
					field(["gitBash", "maxSpillBytes"], "number"),
					field(["gitBash", "graceMs"], "number"),
					field(["gitBash", "bashPath"], "text"),
					field(["gitBash", "sandbox"], "enum", ["auto", "none"]),
					field(["gitBash", "probeTimeoutMs"], "number"),
					field(["gitBash", "requireSandbox"], "boolean"),
					field(["gitBash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-wsl",
				label: { en: "WSL Bash", zh: "WSL Bash" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
					field(["guardSandboxTemp"], "boolean"),
					field(["wslBash", "cwd"], "text"),
					field(["wslBash", "timeoutMs"], "number"),
					field(["wslBash", "maxTimeoutMs"], "number"),
					field(["wslBash", "maxOutputBytes"], "number"),
					field(["wslBash", "maxSpillBytes"], "number"),
					field(["wslBash", "graceMs"], "number"),
					field(["wslBash", "wslPath"], "text"),
					field(["wslBash", "wslDistro"], "text"),
					field(["wslBash", "sandbox"], "enum", ["auto", "none", "bwrap"]),
					field(["wslBash", "probeTimeoutMs"], "number"),
					field(["wslBash", "requireSandbox"], "boolean"),
					field(["wslBash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-msys2",
				label: { en: "MSYS2 Bash", zh: "MSYS2 Bash" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
					field(["guardSandboxTemp"], "boolean"),
					field(["msys2Bash", "cwd"], "text"),
					field(["msys2Bash", "timeoutMs"], "number"),
					field(["msys2Bash", "maxTimeoutMs"], "number"),
					field(["msys2Bash", "maxOutputBytes"], "number"),
					field(["msys2Bash", "maxSpillBytes"], "number"),
					field(["msys2Bash", "graceMs"], "number"),
					field(["msys2Bash", "bashPath"], "text"),
					field(["msys2Bash", "sandbox"], "enum", ["auto", "none"]),
					field(["msys2Bash", "probeTimeoutMs"], "number"),
					field(["msys2Bash", "requireSandbox"], "boolean"),
					field(["msys2Bash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-terminal",
				label: { en: "Interactive terminal", zh: "交互式终端" },
				fields: [
					field(["terminal", "defaultShell"], "enum", ["git_bash", "wsl_bash", "msys2_bash"]),
					field(["terminal", "maxSessions"], "number"),
					field(["terminal", "idleMs"], "number"),
					field(["terminal", "rows"], "number"),
					field(["terminal", "cols"], "number"),
					field(["terminal", "maxBufferBytes"], "number"),
					field(["terminal", "waitMs"], "number"),
					field(["terminal", "quietMs"], "number"),
					field(["terminal", "maxWaitMs"], "number"),
					field(["terminal", "allowUnconfined"], "boolean"),
					field(["gitBash", "bashPath"], "text"),
					field(["wslBash", "wslPath"], "text"),
					field(["wslBash", "wslDistro"], "text"),
					field(["msys2Bash", "bashPath"], "text"),
				],
			},
		];
		//#endregion
		/** The slot key of one row's page: `<package name>#<row id>` (the platform's `rowConfigKey`). */
		const rowKey = (rowId) => `${PACKAGE_NAME}#${rowId}`;
		//#endregion

		//#region form model
		/** Read a nested path out of a settings layer, `undefined` when absent. */
		function at(layer, path) {
			let node = layer;
			for (const key of path) {
				if (node === null || typeof node !== "object") return undefined;
				node = node[key];
			}
			return node;
		}
		/** Whether a settings layer carries this path at all (what marks a field overridden). */
		function has(layer, path) {
			let node = layer;
			for (const key of path) {
				if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return false;
				node = node[key];
			}
			return true;
		}
		/**
		 * Turn one staged draft into the value a write carries.
		 *
		 * A text draft is TRIMMED here, so what the field stores is what the user
		 * meant by it (`'  C:\Git\bash.exe  '` saves as `'C:\Git\bash.exe'`) and the
		 * form echoes the trimmed value back after the write. Trimming applies to
		 * drafts only: a value that is already stored is never rewritten to its
		 * trimmed form (see `invalidReason`'s note on stored values).
		 * @returns the value, or `undefined` for a draft no control accepts.
		 */
		function coerce(kind, draft) {
			if (kind === "number") {
				if (typeof draft === "number") return Number.isFinite(draft) ? draft : undefined;
				const text = String(draft).trim();
				if (text.length === 0) return undefined;
				const value = Number(text);
				return Number.isFinite(value) ? value : undefined;
			}
			if (kind === "boolean") return draft === true;
			return String(draft).trim();
		}
		/** Absolute in either dialect these fields accept: `C:\…`, `\\server\…`, `/c/…`, `/…`. */
		function isAbsolutePath(text) {
			return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\") || text.startsWith("/");
		}
		/**
		 * Why a shown text cannot be written by this backend's own rules — or
		 * `undefined` when it can.
		 *
		 * The boundary, stated so no one mistakes it for more than it is: this is a
		 * SYNTAX check. The browser has no filesystem, so "does this bash.exe exist?"
		 * is deliberately NOT answered here — the executor answers it at use time,
		 * warns once, and falls back there (see the executors' `warnAboutMissing*`).
		 *
		 * The reason is used for one thing only: the visible warning. It never
		 * suppresses, rewrites or repairs a write — the user's input wins (A3), and a
		 * value already in the config layer stays byte-for-byte as it is until the
		 * user saves over it.
		 * @param knob - the field being typed into.
		 * @param text - the shown text (draft or stored value).
		 * @returns `'number' | 'path' | 'distro'`, or `undefined` when acceptable.
		 */
		function invalidReason(knob, text) {
			const trimmed = String(text).trim();
			// An empty control is a clear (it inherits again), never an error.
			if (trimmed.length === 0) return undefined;
			if (knob.kind === "number") return Number.isFinite(Number(trimmed)) ? undefined : "number";
			if (knob.kind !== "text") return undefined;
			const leaf = knob.key.split(".").pop();
			const rule = LEAF_RULES[leaf];
			if (rule === "distro") return /[\s"']/.test(trimmed) ? "distro" : undefined;
			if (rule === "path") return isAbsolutePath(trimmed) ? undefined : "path";
			return undefined;
		}
		/** Fill a dictionary entry's `{value}` with the offending text. */
		function withValue(template, value) {
			return template.split("{value}").join(value);
		}
		/**
		 * Whether a write would leave the field exactly as the section already
		 * resolves it. `current` is the schema-resolved read — the same value the
		 * control renders — so an inherited field compares against what it
		 * inherits, not against its own layer.
		 */
		function sameValue(kind, current, next) {
			if (kind === "number") {
				const left = typeof current === "number" ? current : Number(current);
				const right = Number(next);
				return Number.isFinite(left) && Number.isFinite(right) ? left === right : Object.is(current, next);
			}
			// What a checkbox shows is `value === true`, so two writes it cannot tell
			// apart are the same edit.
			if (kind === "boolean") return (current === true) === (next === true);
			return current === next;
		}
		/**
		 * The one write a staged draft produces, or `undefined` when it would change
		 * nothing: an emptied control the user layer never carried, a value the
		 * section already resolves to, and a draft no control accepts (the form
		 * blocks that save) each plan no write. The plan, the dirty flag and the
		 * overridden badge all read this single decision, so the card previews
		 * exactly what a save would do.
		 * @param knob - the knob the draft belongs to.
		 * @param entry - its staged draft, if any.
		 * @param snapshot - the settings snapshot the draft is compared against.
		 * @returns the path op `mutate` takes, or `undefined` for no write.
		 */
		function plannedOp(knob, entry, snapshot) {
			if (entry === undefined) return undefined;
			if (entry.op === "unset") return has(snapshot.user, knob.path) ? { op: "unset", path: knob.path } : undefined;
			const value = coerce(knob.kind, entry.draft);
			if (value === undefined) return undefined;
			if (sameValue(knob.kind, at(snapshot.value, knob.path), value)) return undefined;
			return { op: "set", path: knob.path, value };
		}
		/**
		 * The ordered writes one save sends, in the row's own (schema) order.
		 * @param fields - the row's knobs.
		 * @param staged - field key → `{ op: 'set', draft }` or `{ op: 'unset' }`.
		 * @param snapshot - the settings snapshot the drafts are compared against.
		 * @returns the path ops `mutate` takes.
		 */
		function planOps(fields, staged, snapshot) {
			const ops = [];
			for (const knob of fields) {
				const op = plannedOp(knob, staged.get(knob.key), snapshot);
				if (op !== undefined) ops.push(op);
			}
			return ops;
		}
		/** A minimal snapshot store: one cached snapshot, replaced on publish. */
		function storeOf(compute) {
			let snapshot = compute();
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				publish: () => {
					snapshot = compute();
					for (const listener of [...listeners]) listener();
				},
			};
		}
		/**
		 * One row's staged form over its settings namespace. Drafts live here, not
		 * in React state, so the card's component stays a pure function of the
		 * injected store (the shape every shipped settings page uses).
		 */
		class RowConfigForm {
			/** @param scope - the settings form the host serves for this row id. */
			constructor(scope, row) {
				this.scope = scope;
				this.row = row;
				this.staged = new Map();
				/**
				 * The read the batch's first draft was staged against. Save fences
				 * its mutation with this revision, not the latest mirrored one, so a
				 * concurrent write is refused instead of silently overwritten; it is
				 * dropped when the drafts are (acceptance, discard), exactly like the
				 * platform's own settings-form model.
				 */
				this.baseline = undefined;
				this.saving = false;
				this.failed = false;
				this.store = storeOf(() => this.project());
				this.unsubscribe = scope.subscribe(() => this.store.publish());
			}
			/** Everything the card renders, recomputed as a whole on every change. */
			project() {
				const snapshot = this.scope.getSnapshot();
				const fields = this.row.fields.map((knob) => {
					const staged = this.staged.get(knob.key);
					const stored = at(snapshot.value, knob.path);
					const inherited = at(snapshot.base, knob.path);
					const shown = staged === undefined ? stored : staged.op === "unset" ? inherited : staged.draft;
					const text = shown === undefined || shown === null ? "" : String(shown);
					// The badge answers for the write, not for the draft: a draft that
					// changes nothing leaves the user layer exactly as it already is.
					const op = plannedOp(knob, staged, snapshot);
					return {
						key: knob.key,
						kind: knob.kind,
						path: knob.path,
						options: knob.options,
						text,
						value: shown,
						checked: shown === true,
						overridden: op === undefined ? has(snapshot.user, knob.path) : op.op === "set",
						// Display only (A3): the warning shown for a value this backend's
						// own rules cannot use. It never gates the write — see `project`'s
						// `invalid` below.
						invalid: invalidReason(knob, text) !== undefined,
						invalidReason: invalidReason(knob, text),
					};
				});
				const plan = planOps(this.row.fields, this.staged, snapshot);
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable === true,
					// Dirty means "Save has something to do". A non-finite number is the
					// one edit with nothing to send (`coerce` refuses it), so it keeps
					// the form dirty for the user to fix; every other invalid value is
					// still written exactly as typed, so its warning does not.
					dirty: plan.length > 0 || fields.some((entry) => entry.invalid && entry.kind === "number"),
					// A3: an invalid value is a WARNING, never a blocker. Reporting it as
					// `invalid` here would make the platform refuse the save, and the
					// user's input has to win: the value they typed is what gets stored.
					invalid: false,
					saving: this.saving,
					failed: this.failed,
					fields,
				};
			}
			/** This row's knob with that key, or `undefined` for a key no control renders. */
			knobOf(key) {
				return this.row.fields.find((entry) => entry.key === key);
			}
			/**
			 * Stage one draft for a known knob, remembering the read the whole batch
			 * is fenced against. Every action that writes a draft goes through here,
			 * so an unknown key can never leave a draft in the map that no control
			 * renders and no write carries. (The platform model throws for an unknown
			 * field; these actions arrive through the slot, where a no-op beats
			 * taking the page down — the answer `edit` has always given.)
			 */
			stage(key, entry) {
				this.baseline ??= this.scope.getSnapshot();
				this.staged.set(key, entry);
				this.failed = false;
				this.store.publish();
			}
			/** Stage one control's draft; an emptied (or blank) text control stages a clear. */
			edit(key, draft) {
				const knob = this.knobOf(key);
				if (knob === undefined) return;
				// Trim decides emptiness too: whitespace-only is a clear, exactly like
				// an empty box, and never an error (A3).
				const empty = (knob.kind === "text" || knob.kind === "number") && String(draft).trim().length === 0;
				this.stage(key, empty ? { op: "unset" } : { op: "set", draft });
			}
			/** Stage a clear, so saving lets the field re-inherit the composition layer. */
			resetField(key) {
				if (this.knobOf(key) === undefined) return;
				this.stage(key, { op: "unset" });
			}
			/** Drop every staged draft. */
			discard() {
				this.staged.clear();
				this.baseline = undefined;
				this.failed = false;
				this.store.publish();
			}
			/** Write every staged draft in one revision-fenced mutation. */
			async save() {
				const snapshot = this.scope.getSnapshot();
				const ops = planOps(this.row.fields, this.staged, snapshot);
				// A save already crossing the wire is not re-entered (platform:
				// `form-model.ts:302` `if (this.saving) return`). A second write would
				// carry the baseline the first one already spent, the Host would refuse
				// that stale fence, and the refusal would raise a failure banner over
				// drafts the first save had just cleared — nothing left to correct.
				if (snapshot.writable !== true || this.saving || ops.length === 0) return;
				this.saving = true;
				this.failed = false;
				this.store.publish();
				let accepted = false;
				try {
					accepted = await this.scope.mutate(ops, this.baseline?.revision);
				} catch {
					accepted = false;
				}
				this.saving = false;
				if (accepted) {
					this.staged.clear();
					this.baseline = undefined;
				}
				this.failed = !accepted;
				this.store.publish();
			}
			/** The face the slot registration injects: the store and the edit actions. */
			inject() {
				return {
					hooks: { rowForm: this.store },
					edit: (key, draft) => this.edit(key, draft),
					resetField: (key) => this.resetField(key),
					discard: () => this.discard(),
					save: () => this.save(),
				};
			}
			dispose() {
				this.unsubscribe();
			}
		}
		//#endregion

		//#region card
		/** One knob's control: a staged value field, a checkbox, or a segmented choice. */
		function fieldControl(knob, disabled, props, t) {
			// The warning names the value it is about (A3: visible, localized, and
			// specific) — composed here rather than in the dictionary so a `$` in the
			// value can never be read as a replacement pattern.
			const invalidLabel = knob.invalid
				? withValue(t(knob.invalidReason === "path" ? "invalidPath" : knob.invalidReason === "distro" ? "invalidDistro" : "invalidNumber"), String(knob.text).trim())
				: t("invalidNumber");
			const shared = {
				id: `win-mb-${knob.key.replace(/\./g, "-")}`,
				label: t(`${knob.key.split(".").pop()}.label`),
				hint: t(`${knob.key.split(".").pop()}.hint`),
				overridden: knob.overridden,
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel,
				disabled,
			};
			if (knob.kind === "text" || knob.kind === "number")
				return h(primitives.SettingsValueField, {
					...shared,
					key: knob.key,
					text: knob.text,
					invalid: knob.invalid,
					numeric: knob.kind === "number",
					onEdit: (text) => props.edit(knob.key, text),
					onReset: () => props.resetField(knob.key),
				});
			if (knob.kind === "boolean")
				return h(
					"div",
					{ key: knob.key, className: "dshwmb-row" },
					h(primitives.Checkbox, {
						label: shared.label,
						checked: knob.checked,
						disabled,
						onChange: (next) => props.edit(knob.key, next),
					}),
					h("p", { className: "dshwmb-hint" }, shared.hint),
					knob.overridden
						? h(primitives.Button, { variant: "ghost", size: "sm", type: "button", disabled, onClick: () => props.resetField(knob.key) }, shared.resetLabel)
						: null,
				);
			return h(
				"div",
				{ key: knob.key, className: "dshwmb-row" },
				h("p", { className: "dshwmb-label" }, shared.label),
				h(primitives.SegmentedControl, {
					id: shared.id,
					value: String(knob.value ?? ""),
					label: shared.label,
					disabled,
					options: knob.options.map((option) => ({ value: option, label: t(`option.${option}`) })),
					onChange: (next) => props.edit(knob.key, next),
				}),
				h("p", { className: "dshwmb-hint" }, shared.hint),
				knob.overridden
					? h(primitives.Button, { variant: "ghost", size: "sm", type: "button", disabled, onClick: () => props.resetField(knob.key) }, shared.resetLabel)
					: null,
			);
		}
		/**
		 * One row's configuration page as the Plugins page renders it. No React
		 * state: the store and the actions arrive through the slot's inject, and
		 * the page drops every draft when it unmounts.
		 */
		function RowConfigCard(props) {
			const t = props.t;
			// The hook runs before the view branch: a summary render must keep the
			// same hook order as a page render, so one instance can render either
			// face (the shipped settings cards read their form the same way).
			const state = props.useRowForm((snapshot) => snapshot);
			if (props.view === "summary") return t("summary");
			const disabled = state.writable !== true;
			return h(
				primitives.SettingsForm,
				{
					labels: {
						unavailable: t("unavailable"),
						readOnly: t("readOnly"),
						saveFailed: t("saveFailed"),
						save: t("save"),
						saving: t("saving"),
					},
					state,
					onSave: props.save,
					onDiscard: props.discard,
				},
				...state.fields.map((knob) => fieldControl(knob, disabled, props, t)),
			);
		}
		//#endregion

		//#region detail page
		/** The page's localizer, or the English copy when the slot hands none over. */
		function textOf(props) {
			return typeof props?.t === "function" ? props.t : (key) => en[key] ?? key;
		}

		/**
		 * The detail pages this bundle owns: the bundle's own page, and the core
		 * row's page. Every other subject (another package, or one of the tool
		 * rows) renders nothing, which is what the slots expect of a contribution
		 * that has nothing to say about the subject.
		 * @param subject - the page subject the slot renders with.
		 * @returns the owned page's kind, or `undefined` for a foreign subject.
		 */
		function ownedPage(subject) {
			if (subject === null || typeof subject !== "object") return undefined;
			if (subject.kind === "bundle" && subject.pkg?.name === PACKAGE_NAME) return "bundle";
			if (subject.kind === "row" && subject.pkg?.name === PACKAGE_NAME && subject.row?.rowId === CORE_ROW_ID) return "core-row";
			return undefined;
		}

		/**
		 * Tags the bundle's title with its core row. dsh cannot make a third-party
		 * row read-only, so the row that must stay enabled is named where a user
		 * actually reads it.
		 */
		function CoreBadge(props) {
			const t = textOf(props);
			if (ownedPage(props?.subject) === undefined) return null;
			return h("span", { className: "dshwmb-badge" }, t("coreBadge"));
		}

		/** Says which row is which, and what switching the core one off costs. */
		function CoreNote(props) {
			const t = textOf(props);
			if (ownedPage(props?.subject) === undefined) return null;
			return h("section", { className: "dshwmb-note" }, h("p", { className: "dshwmb-hint" }, t("coreNote")));
		}
		//#endregion

		//#region plugin
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "configForms"];
		/** This plugin's own layout, injected once per document. */
		const CSS = [
			".dshwmb-row{margin:0 0 14px}",
			".dshwmb-label{margin:0 0 6px;font-size:13px;font-weight:500}",
			".dshwmb-hint{margin:6px 0 0;font-size:12px;opacity:.65;line-height:1.5}",
			".dshwmb-badge{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:9px;border:1px solid currentColor;font-size:11px;font-weight:500;opacity:.75;vertical-align:middle}",
			".dshwmb-note{margin:14px 0 0}",
		].join("");
		/** The style tag's platform name, `<owner id>/<file>` as the presets tag theirs. */
		const STYLE_ID = `${PACKAGE_NAME}/client.js`;
		/**
		 * Install the stylesheet once per document, tagged so the module system can
		 * reclaim it (`data-plugin`) and named the way the platform's own injectors
		 * name theirs (`data-plugin-css`).
		 * @returns the disposer removing the tag **this** call installed, if it did;
		 * the caller registers it so unloading the plugin takes its style with it.
		 * A host that serves no document — or no `head` to append to — gets no
		 * stylesheet and no exception: this runs inside an effect, so a throw here
		 * would take both Configure pages and the core-row label down with it.
		 */
		function installStyles() {
			if (typeof document === "undefined" || document.head === undefined || document.head === null) return () => {};
			if (document.querySelector(`style[data-plugin='${PACKAGE_NAME}']`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = PACKAGE_NAME;
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/**
		 * Give each tool row its Configure page on the Plugins page, while the host
		 * serves that row's settings namespace.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-win-multi-bash: dictionaries");
			ctx.effect(() => installStyles(), "dsh-win-multi-bash: stylesheet");
			for (const row of ROWS) {
				const form = new RowConfigForm(ctx.configForms.get(row.rowId), row);
				ctx.effect(() => () => form.dispose(), `dsh-win-multi-bash: ${row.rowId} form`);
				ctx.effect(
					() =>
						ctx.configForms.whileServed([row.rowId], () =>
							ctx.slots.inject("plugins.row.config", () =>
								ctx.slots.register(
									{
										name: "plugins.row.config",
										key: rowKey(row.rowId),
										locale: NS,
										inject: () => form.inject(),
									},
									RowConfigCard,
								),
							),
						),
					`dsh-win-multi-bash: ${row.rowId} page`,
				);
			}
			// The bundle's own page and the core row's page are the same subject to a
			// reader: label the row that has to stay on, and say what its switch costs.
			for (const [slotName, component] of [
				["plugins.detail.badge", CoreBadge],
				["plugins.detail.section", CoreNote],
			]) {
				ctx.effect(
					() =>
						ctx.slots.inject(slotName, () =>
							ctx.slots.register({ name: slotName, id: `${PACKAGE_NAME}:core`, order: 100, locale: NS }, component),
						),
					`dsh-win-multi-bash: ${slotName}`,
				);
			}
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		/** Pure helpers the audit exercises without a renderer. */
		exports.__internals = { ROWS, rowKey, at, has, coerce, sameValue, plannedOp, planOps, RowConfigForm, RowConfigCard, CoreBadge, CoreNote, ownedPage, installStyles, CORE_ROW_ID, PACKAGE_NAME, STYLE_ID, en, zh };
		return module.exports;
	},
});
