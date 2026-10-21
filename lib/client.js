/**
 * dsh-win-multi-bash — browser half.
 *
 * The tool rows carry their own configuration (the tool-layer switch
 * `enableRunInBackground` and the backend partition: paths, sandbox stance,
 * probe timeout, sandbox hardening, and the executor's command limits); the
 * core row's form carries the deployment-wide self-heal switch
 * (`guardSandboxTemp` / `tempWatchMs`). This module gives each row a
 * **Configure** page on the Web sidebar's Plugins page, through the
 * `plugins.row.config` slot keyed by `<package name>#<row id>`, so the options
 * are edited in the panel instead of by hand in `cordis.patch.yml`.
 *
 * It also labels the bundle itself: the plugin has a **core row** (the package
 * row, `win-mb-plugin`) that carries this browser half and owns the shared shell
 * prompt section, and the panel cannot mark a third-party row read-only — dsh's
 * plugin manager locks only its own protected modules, its own row, and rows the
 * profile patch cannot address. So the core row is named where a user reads it
 * instead: a note under the row list, through `plugins.detail.section`.
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
		/** The package this browser half belongs to; also the module's plugin name. */
		const PACKAGE_NAME = "dsh-win-multi-bash";

		//#region imports
		/**
		 * The platform's renderer is OPTIONAL here. This module is imported while the web
		 * shell boots, and a throw at import time is fatal for the whole boot:
		 * `web boot: N entries did not activate` and the desktop shell shows its crash
		 * dialog. Measured on this host (crash-2026-10-16T18-42-37-046Z-web-boot.log and
		 * ...T19-06-23-150Z-web-boot.log, both naming this module): a bare `require` in
		 * this position took the shell down. So both imports are attempted, and a
		 * deployment that answers neither contributes nothing instead of crashing.
		 */
		let React;
		let primitives;
		try {
			React = require("react");
		} catch (error) {
			React = undefined;
		}
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = undefined;
		}
		if (React === undefined || React === null || typeof React.createElement !== "function") {
			// No renderer: contribute a no-op plugin under the real name instead of an
			// anonymous empty module, so the entry still carries the platform triple.
			module.exports = { name: PACKAGE_NAME, inject: [], apply() {} };
			return module.exports;
		}
		const h = React.createElement;
		if (primitives === undefined || primitives === null) {
			/**
			 * Plain-DOM stand-ins with the surface the cards use, so a deployment without the
			 * primitives degrades to honest HTML instead of throwing inside a render.
			 */
			primitives = {
				SettingsForm: (props) => h("div", { className: "dshwmb-row" }, props?.children),
				Checkbox: (props) => h("input", { type: "checkbox", checked: props?.checked === true, disabled: props?.disabled, onChange: (event) => props?.onChange?.(event.target.checked) }),
				Button: (props) => h("button", { type: props?.type ?? "button", disabled: props?.disabled, onClick: props?.onClick }, props?.children),
				SegmentedControl: (props) => h("div", { className: "dshwmb-row" }, (props?.options ?? []).map((option) => h("button", { key: option.value ?? option.label, type: "button", disabled: props?.disabled, onClick: () => props?.onChange?.(option.value) }, option.label ?? String(option.value)))),
				SettingsValueField: (props) => h("input", { type: "text", value: props?.value ?? "", disabled: props?.disabled, onChange: (event) => props?.onChange?.(event.target.value) }),
			};
		}

		//#region locales
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.win-mb-bash";
		/** The core row's id, as `cordis.patch.yml` declares it. */
		const CORE_ROW_ID = "win-mb-plugin";
		/** English copy. */
		const en = {
			summary: "Configure the shell tool rows (git_bash, wsl_bash, msys2_bash, ssh_bash) and the interactive terminal row: paths, sandbox stance, command limits, and session shape.",
			coreNote: "This plugin inserts one row per shell tool (git_bash, wsl_bash, and the opt-in msys2_bash and ssh_bash), one row for the interactive terminal tool, and its core row. Configure each tool on its own row. Keep the core row enabled — it serves this page and owns the shared shell prompt section; with it off the tools still run and carry that guidance in their own descriptions, but the Configure controls on this page disappear.",
			unavailable: "This row is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving…",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidNumber: "Enter a number, or leave blank to use the default (got \"{value}\").",
			invalidNumberFormat: "This is a number, and it is saved as the number it names — not as the text you typed (got \"{value}\").",
			invalidPath: "Enter an absolute path, or leave blank to use the default (got \"{value}\").",
			invalidDistro: "A distribution name cannot contain spaces or quotes (got \"{value}\").",
			"option.auto": "auto",
			"option.none": "none",
			"option.bwrap": "bwrap",
			"option.once": "First unwrapped run only",
			// One title per wire name, the SAME string in both languages, so a reader can tell
			// the four shells apart at a glance. `tool.title.other` is the fallback for a name
			// this dictionary has no title for (a dialect added to the registry).
			"tool.title.git_bash": "Git Bash",
			"tool.title.wsl_bash": "WSL Bash",
			"tool.title.msys2_bash": "MSYS2 Bash",
			"tool.title.ssh_bash": "SSH remote shell",
			"tool.title.terminal": "Terminal",
			"tool.title.other": "Run command",
			// The terminal card's own copy, mirrored from the platform's `terminalBlockLabels`
			// (`dsh-client-ui-conversation`) and the locale base copy (`copy`/`copied`/`collapse`).
			"terminal.commandLine": "Command line {n}",
			"terminal.signal": "signal {signal}",
			"terminal.exitCode": "exit code {code}",
			"terminal.noExitCode": "no exit code",
			"terminal.running": "Running",
			"terminal.failed": "Failed",
			"terminal.done": "Done",
			"terminal.noOutput": "No output",
			"terminal.collapseAria": "Collapse output",
			"terminal.expandAria": "Expand the remaining {n} output lines",
			"terminal.expandRest": "… {n} more lines",
			"copy": "Copy",
			"copied": "Copied",
			"collapse": "Collapse",
			"row.input": "Input",
			"row.output": "Output",
			"row.inspect": "Inspect",
			"row.running": "Running",
			"row.failed": "Failed",
			"row.stopped": "Stopped",
			"option.always": "Every unwrapped run",
			"enableRunInBackground.label": "Background jobs",
			"enableRunInBackground.hint": "Whether this tool accepts run_in_background. The tool schema carries this argument, so it follows the row's next load.",
			"guardSandboxTemp.label": "Self-heal the sandbox temp directory",
			"guardSandboxTemp.hint": "When the DSH sandbox's private temp directory (`%TEMP%` + `dsh-<6>`) has been removed out of band — an OS temp cleaner, a manual delete — recreate it and restore its write grant before the next confined command, instead of letting every wrapped spawn fail with \"the runner refused a missing --temp\" (exit 127). Only a MISSING `dsh-<6>` direct child of an OS temp root, outside every workspace root, is ever touched, and nothing is ever deleted. Live: turning it off stops healing from the next command. Applies to the Windows ACL path (`git_bash`, `msys2_bash`); `wsl_bash` uses bwrap and has no such directory.",
			"tempWatchMs.label": "Self-heal check interval (ms)",
			"tempWatchMs.hint": "How often the guard scans the OS temp roots for a missing private root and rebuilds it (default 10000 ms; 1000 is the floor). A change applies from the next check — the package row is woken immediately, a shell row's own timer follows within one round.",
			"option.git_bash": "Git Bash",
			"option.wsl_bash": "WSL Bash",
			"option.msys2_bash": "MSYS2 Bash",
			"option.ssh_bash": "SSH remote shell",
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
			"sshPath.label": "SSH client executable",
			"sshPath.hint": "Pin an explicit ssh.exe. Empty probes the Windows OpenSSH client, then PATH (which finds a Git-for-Windows client).",
			"sshHost.label": "Remote host",
			"sshHost.hint": "The host to reach, or an alias from your ~/.ssh/config. Required: a row with no host refuses every call and names this field. The tool is pinned to this host — the model never chooses it — so an unset value cannot reach anywhere.",
			"sshUser.label": "Remote user",
			"sshUser.hint": "Optional login name. Empty lets the client decide (its own config file, then your local user name).",
			"sshPort.label": "Remote port",
			"sshPort.hint": "Optional TCP port. Empty uses ssh's own default (22, or whatever the client config says).",
			"acceptNewHostKeys.label": "Accept an unknown host key (trust on first use)",
			"acceptNewHostKeys.hint": "Off by default, and an unknown host then FAILS a one-shot call instead of asking — nothing here accepts a key on your behalf. On adds StrictHostKeyChecking=accept-new, so the first key seen for a host is learned into known_hosts. A CHANGED key still fails, and an unknown one still fails with this off.",
			"connectTimeoutMs.label": "Connection timeout (ms)",
			"connectTimeoutMs.hint": "Bounds the TCP/SSH handshake only (sent as ConnectTimeout in whole seconds, never below 1) and never the remote command — the command timeout does that. It keeps a blackholed address from eating the whole command budget.",
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
			summary: "配置各 shell 工具行（git_bash、wsl_bash、msys2_bash、ssh_bash）与交互式终端行（terminal）：路径、沙箱立场、命令限制与会话形态。",
			coreNote: "本插件为每个 shell 工具插入一行（git_bash、wsl_bash，以及按需开启的 msys2_bash、ssh_bash），再加一行交互式终端（terminal），以及核心行。工具各自在自己的行上配置。请保持核心行开启——本页由它提供，共有的那段 shell 提示词也归它所有；关掉后工具照旧可用（共有指导回落到各自的描述里），但本页的配置入口会消失。",
			unavailable: "该行当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			save: "保存",
			saving: "保存中…",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidNumber: "请填数字；留空表示使用默认值（当前为「{value}」）。",
			invalidNumberFormat: "这是数字，会按它命名的数值保存，而不是你输入的那串文本（当前为「{value}」）。",
			invalidPath: "请填绝对路径；留空表示使用默认值（当前为「{value}」）。",
			invalidDistro: "发行版名称不能包含空格或引号（当前为「{value}」）。",
			"option.auto": "自动",
			"option.none": "不限制",
			"option.bwrap": "bwrap",
			"option.once": "仅首条未包裹运行",
			// 每个线名一个标题，两种语言用同一个字符串，便于一眼分辨四个 shell。
			// `tool.title.other` 是字典里没有该名字时的回落（例如注册表新增了方言）。
			"tool.title.git_bash": "Git Bash",
			"tool.title.wsl_bash": "WSL Bash",
			"tool.title.msys2_bash": "MSYS2 Bash",
			"tool.title.ssh_bash": "SSH remote shell",
			"tool.title.terminal": "终端",
			"tool.title.other": "运行命令",
			// 终端卡片自身文案，对应平台的 `terminalBlockLabels`（dsh-client-ui-conversation）
			// 与 locale 基础词典（copy/copied/collapse）。
			"terminal.commandLine": "命令第 {n} 行",
			"terminal.signal": "信号 {signal}",
			"terminal.exitCode": "退出码 {code}",
			"terminal.noExitCode": "未正常退出",
			"terminal.running": "运行中",
			"terminal.failed": "失败",
			"terminal.done": "已完成",
			"terminal.noOutput": "无输出",
			"terminal.collapseAria": "收起输出",
			"terminal.expandAria": "展开其余 {n} 行输出",
			"terminal.expandRest": "… 其余 {n} 行",
			"copy": "复制",
			"copied": "复制成功",
			"collapse": "收起",
			"row.input": "输入",
			"row.output": "输出",
			"row.inspect": "查看",
			"row.running": "运行中",
			"row.failed": "失败",
			"row.stopped": "已停止",
			"option.always": "每条未包裹运行",
			"enableRunInBackground.label": "后台任务",
			"enableRunInBackground.hint": "该工具是否接受 run_in_background；该参数属于工具 schema，需该行下次加载后生效。",
			"guardSandboxTemp.label": "沙箱临时目录自愈",
			"guardSandboxTemp.hint": "当 DSH 沙箱的私有临时目录（`%TEMP%` 下的 `dsh-<6>`）被带外删除（系统临时文件清理器、手工删除）后，在下一条被包裹的命令之前重建它并恢复其写授权，而不是让之后每一次被包裹的 spawn 都因「runner 拒绝了不存在的 --temp」（exit 127）而失败。只有「不存在的、位于 OS 临时根之下且不在任何工作区根内的 `dsh-<6>` 直接子目录」才会被动到，且绝不删除任何东西。即时生效：关掉后从下一条命令起停止自愈。只作用于 Windows ACL 路径（`git_bash`、`msys2_bash`）；`wsl_bash` 用 bwrap，没有这个目录。",
			"tempWatchMs.label": "自愈检查间隔（毫秒）",
			"tempWatchMs.hint": "守护每隔这么久检查一次 %TEMP% 下的私有临时根；被带外删除时在下一次检查即重建（默认 10000 ms，下限 1000）。改动从下一次检查起生效——包行驱动会被立刻唤醒，工具行自己的定时器最多等一轮。",
			"option.git_bash": "Git Bash",
			"option.wsl_bash": "WSL Bash",
			"option.msys2_bash": "MSYS2 Bash",
			"option.ssh_bash": "SSH 远端 Shell",
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
			"sshPath.label": "SSH 客户端可执行文件",
			"sshPath.hint": "钉定显式 ssh.exe；留空先探测 Windows OpenSSH 客户端，再走 PATH（Git for Windows 自带的客户端就在 PATH 上）。",
			"sshHost.label": "远端主机",
			"sshHost.hint": "要连接的主机，或 ~/.ssh/config 里的别名。必填：未填主机的行会拒绝每一次调用并点名本字段。工具被钉定在该主机上（不由模型选择），所以留空不可能连到任何地方。",
			"sshUser.label": "远端用户",
			"sshUser.hint": "可选登录名；留空由客户端自行决定（先看它自己的配置文件，再用本机用户名）。",
			"sshPort.label": "远端端口",
			"sshPort.hint": "可选 TCP 端口；留空用 ssh 自己的默认值（22，或客户端配置文件里的值）。",
			"acceptNewHostKeys.label": "接受未知主机密钥（首次即信任）",
			"acceptNewHostKeys.hint": "默认关闭；关闭时未知主机会让单次调用直接失败，而不是向谁发问——本插件绝不以你的名义接受密钥。打开即追加 StrictHostKeyChecking=accept-new：某主机首次出现的密钥会记入 known_hosts。密钥发生变化时仍然失败；关闭时未知主机同样失败。",
			"connectTimeoutMs.label": "连接超时（毫秒）",
			"connectTimeoutMs.hint": "只限制 TCP/SSH 握手阶段（按整秒作为 ConnectTimeout 发送，最低 1 秒），绝不限制远端命令——那由命令超时负责。作用是别让黑洞地址吃掉整段命令预算。",
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
		const LEAF_RULES = { "cwd": "path", "bashPath": "path", "wslPath": "path", "wslDistro": "distro", "sshPath": "path" };
		/** The tool rows this bundle configures, in composition order. */
		const ROWS = [
			{
				rowId: "win-mb-tool-git",
				label: { en: "Git Bash", zh: "Git Bash" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
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
				rowId: "win-mb-tool-ssh",
				label: { en: "SSH remote shell", zh: "SSH 远端 Shell" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
					field(["sshBash", "cwd"], "text"),
					field(["sshBash", "timeoutMs"], "number"),
					field(["sshBash", "maxTimeoutMs"], "number"),
					field(["sshBash", "maxOutputBytes"], "number"),
					field(["sshBash", "maxSpillBytes"], "number"),
					field(["sshBash", "graceMs"], "number"),
					field(["sshBash", "sshPath"], "text"),
					field(["sshBash", "sshHost"], "text"),
					field(["sshBash", "sshUser"], "text"),
					field(["sshBash", "sshPort"], "number"),
					field(["sshBash", "acceptNewHostKeys"], "boolean"),
					field(["sshBash", "connectTimeoutMs"], "number"),
					field(["sshBash", "sandbox"], "enum", ["auto", "none"]),
					field(["sshBash", "probeTimeoutMs"], "number"),
					field(["sshBash", "requireSandbox"], "boolean"),
					field(["sshBash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-terminal",
				label: { en: "Interactive terminal", zh: "交互式终端" },
				fields: [
					field(["terminal", "defaultShell"], "enum", ["git_bash", "wsl_bash", "msys2_bash", "ssh_bash"]),
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
					field(["sshBash", "sshPath"], "text"),
					field(["sshBash", "sshHost"], "text"),
					field(["sshBash", "sshUser"], "text"),
					field(["sshBash", "sshPort"], "number"),
					field(["sshBash", "acceptNewHostKeys"], "boolean"),
					field(["sshBash", "connectTimeoutMs"], "number"),
				],
			},
		];
		/**
		 * The interactive session tool's three literals, from the registry: the wire
		 * name its keyed row is registered under, the row that carries its config, and
		 * the config partition the shell list is read from. Hand-keeping them here was
		 * the last place a rename could drift without a red.
		 */
		const TERMINAL_ROW_ID = "win-mb-tool-terminal";
		const TERMINAL_TOOL_NAME = "terminal";
		const TERMINAL_CONFIG_KEY = "terminal";
		//#endregion
		/** The slot key of one row's page: `<package name>#<row id>` (the platform's `rowConfigKey`). */
		const rowKey = (rowId) => `${PACKAGE_NAME}#${rowId}`;
		//#region conversation rows (the tool cards)
		/**
		 * The wire names this bundle renders its own conversation row for: the terminal
		 * row's own `defaultShell` list, i.e. the dialects the registry declares terminal
		 * capability for. The audit pins both sides against the host registry, so a dialect
		 * added there cannot quietly keep the generic `Tool call · <name>` row.
		 */
		const SHELL_TOOL_NAMES =
			ROWS.find((row) => row.rowId === TERMINAL_ROW_ID)?.fields.find((knob) => knob.key === `${TERMINAL_CONFIG_KEY}.defaultShell`)?.options ?? [];
		// The interactive tool's name is not a dialect, so it is not in the list above: it is
		// its own generated constant (`TERMINAL_TOOL_NAME`, next to the rows).
		/**
		 * The primitives a row shaped like the platform's own shell card is built from. When
		 * one is missing the rows are NOT registered at all: the platform's generic card is a
		 * plainer fallback, but it is one this module cannot break.
		 */
		const CARD_PRIMITIVES = ["DisclosureRow", "TextShimmer", "IconApiOutlineRegular", "IconInspectOutlineRegular"];
		/** The icon the platform's own bash/pwsh rows use (`VARIANT_ICONS.bash`). */
		const cardIcon = () => h(primitives.IconApiOutlineRegular, { size: 14 });
		/** Parse one call's argument JSON; `undefined` for anything that is not an object. */
		function parseCardArgs(argsRaw) {
			try {
				const parsed = JSON.parse(argsRaw);
				return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
			} catch (error) {
				return undefined;
			}
		}
		/** The first physical line of a display string. */
		function firstLine(text) {
			const newline = text.indexOf("\n");
			return newline === -1 ? text : text.slice(0, newline);
		}
		/**
		 * A call's collapsed summary, by the platform's own rule for its shell rows:
		 * `description` first, then `command` (the terminal row reads its own `action`), then
		 * the first non-empty string argument, then the raw text. Never empty: a call with no
		 * readable argument shows its own id.
		 */
		function cardSummary(view, argsRaw, callId) {
			if (typeof argsRaw !== "string" || argsRaw === "") return callId ?? "";
			const preferred = view === TERMINAL_TOOL_NAME ? ["action", "name", "sessionId"] : ["description", "command"];
			const args = parseCardArgs(argsRaw);
			if (args === undefined) return firstLine(argsRaw);
			for (const key of preferred) {
				const value = args[key];
				if (typeof value === "string" && value !== "") return firstLine(value);
			}
			for (const value of Object.values(args)) if (typeof value === "string" && value !== "") return firstLine(value);
			return firstLine(argsRaw);
		}
		/** Whether a block is a settled result (`kind` is the platform's own settled marker). */
		function isSettledBlock(block) {
			return typeof block === "object" && block !== null && "kind" in block;
		}
		/**
		 * One call's row state, from the platform's stage contract: `preparing`, `running`,
		 * then the settled verdict — `stopped` for an interrupted call, `error` for a failed
		 * one, `ok` otherwise.
		 */
		function cardState(phase, block) {
			if (!isSettledBlock(block)) return phase === "preparing" ? "preparing" : "running";
			if (block.error?.code === "interrupted") return "stopped";
			return block.isError ? "error" : "ok";
		}
		/** A settled call's result text: text blocks verbatim, any other block as JSON. */
		function cardOutput(block) {
			if (!isSettledBlock(block)) return null;
			const content = Array.isArray(block.content) ? block.content : [];
			const parts = [];
			for (const item of content) parts.push(item?.type === "text" ? String(item.text ?? "") : JSON.stringify(item, null, 2));
			if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`);
			return parts.join("\n") || null;
		}
		/** The INPUT half of the expanded body: the call's arguments, pretty-printed. */
		function cardInput(argsRaw) {
			if (typeof argsRaw !== "string" || argsRaw === "") return null;
			const args = parseCardArgs(argsRaw);
			return args === undefined ? argsRaw : JSON.stringify(args, null, 2);
		}
		/**
		 * The platform's INPUT/OUTPUT card for one expanded call: the arguments it was called
		 * with, then its result. `null` when there is neither. Pure, so the audit renders it
		 * without a renderer.
		 */
		function toolCardIo(props, state, inputText, outputText) {
			const t = textOf(props);
			const children = [];
			if (inputText !== null || outputText !== null) {
				const sections = [];
				if (inputText !== null)
					sections.push(
						h("div", { key: "input", className: "dshwmb-tool-iosection" },
							h("span", { key: "label", className: "dshwmb-tool-iolabel" }, t("row.input")),
							h("span", { key: "text", className: "dshwmb-tool-iotext" }, inputText)),
					);
				if (inputText !== null && outputText !== null)
					sections.push(h("span", { key: "divider", className: "dshwmb-tool-iodivider", "aria-hidden": true }));
				if (outputText !== null)
					sections.push(
						h("div", { key: "output", className: "dshwmb-tool-iosection" },
							h("span", { key: "label", className: "dshwmb-tool-iolabel" }, t("row.output")),
							h("span", { key: "text", className: "dshwmb-tool-iotext", "data-error": state === "error" ? "" : undefined }, outputText)),
					);
				children.push(h("div", { key: "io", className: "dshwmb-tool-io" }, ...sections));
			}
			return children.length === 0 ? null : children[0];
		}
		/**
		 * One expanded body: the card for this call — the platform's terminal card for a shell
		 * command, its INPUT/OUTPUT card otherwise — followed by the seat's inspect button,
		 * which is where the platform puts both.
		 */
		function toolCardBody(props, content) {
			const t = textOf(props);
			const children = [];
			if (content !== null && content !== undefined) children.push(content);
			if (typeof props?.inspect === "function")
				children.push(
					h("button", { key: "inspect", type: "button", className: "dshwmb-tool-inspect", onClick: props.inspect },
						h(primitives.IconInspectOutlineRegular, { key: "icon" }), t("row.inspect")),
				);
			return children.length === 0 ? null : h("div", { className: "dshwmb-tool-body" }, ...children);
		}

		/** Whether a path is absolute in either spelling the Host accepts (POSIX or Windows drive/UNC). */
		function isAbsoluteWorkspacePath(path) {
			return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\");
		}
		/** Resolve a Workspace-relative path into the Host-facing spelling, like the platform. */
		function resolveWorkspacePath(cwd, path) {
			if (isAbsoluteWorkspacePath(path)) return path;
			if (cwd === undefined || cwd === "") return path;
			const windows = /^[A-Za-z]:[/\\]/.test(cwd) || cwd.startsWith("\\\\");
			const separator = windows && cwd.includes("\\") ? "\\" : "/";
			return `${cwd.replace(/[/\\]+$/, "")}${separator}${path.replace(/^[/\\]+/, "")}`;
		}
		/** Collapse the `.`/`..` segments of a path body against a known root state. */
		function collapseSegments(body, rooted, separator = "/") {
			const kept = [];
			for (const segment of body.split(/[/\\]/)) {
				if (segment === "" || segment === ".") continue;
				if (segment === "..") {
					if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
					else if (!rooted) kept.push(segment);
					continue;
				}
				kept.push(segment);
			}
			return kept.join(separator);
		}
		/**
		 * Collapse `.`/`..` segments so the prompt label names the directory the command
		 * actually ran in, mirroring the platform's `normalizeSegments`: separators are
		 * preserved as authored, a `..` at a root is dropped, and a UNC share's server
		 * and share are root, not poppable segments.
		 * @param path - a joined or absolute path, possibly carrying `.`/`..` segments.
		 * @returns the same path with those segments resolved.
		 */
		function normalizeSegments(path) {
			if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path;
			const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path);
			if (unc !== null) {
				const [matched, server, share] = unc;
				const root = `\\\\${String(server)}\\${String(share)}`;
				const rest = collapseSegments(path.slice(matched.length), true);
				return rest === "" ? root : `${root}\\${rest}`;
			}
			const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
			const rooted = /^[/\\]/.test(path);
			const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
			const body = collapseSegments(path.slice(drive.length), rooted || drive !== "", separator);
			const leading = rooted ? separator : "";
			return drive === "" ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`;
		}
		/** The prompt cwd the platform's `resolveTerminalCwd` would show for one call. */
		function displayCwd(workdir, sessionCwd) {
			if (workdir === undefined || workdir === "") return sessionCwd;
			if (sessionCwd === undefined || sessionCwd === "") return normalizeSegments(workdir);
			return normalizeSegments(resolveWorkspacePath(sessionCwd, workdir));
		}
		/** A settled result's recorded absolute cwd, when the Host recorded one. */
		function recordedAbsoluteCwd(block) {
			const meta = block?.meta;
			if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
			const value = meta.cwd;
			return typeof value === "string" && isAbsoluteWorkspacePath(value) ? value : undefined;
		}
		/**
		 * The result notices that mean a shell result is NOT one settled foreground command:
		 * a promotion that is still running, a spill preview whose exit marker may be
		 * displaced, and a job read's dropped-bytes notice. The platform's own card skips the
		 * same shapes (its spill and persistent-call guards); these are this plugin's own
		 * renderer's literals (`lib/tool-bash/types/render.js`).
		 *
		 * Anchored to a whole LINE on purpose: the source that defines these markers, and any
		 * command that merely prints them inline, used to turn every such result into the
		 * generic body under the old `includes` probe — a false positive, not a notice.
		 */
		const UNSETTLED_NOTICE = /^\[(?:still running after |output truncated;|some output was dropped from memory;)[^\n]*\]\r?$/m;
		/**
		 * One settled shell result's status, by the marker contract both renderers share: a
		 * trailing `[killed by signal: X]` or `[exit code: N]` is extracted, and the absence of
		 * either means success — this plugin's renderer, like dsh's own, writes the exit marker
		 * only when the code is non-zero (`lib/tool-bash/types/render.js` `renderResult`).
		 */
		function shellStatus(text) {
			const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
			if (signal !== null) return { output: text.slice(0, signal.index), signal: signal[1] };
			const exit = /\n\[exit code: (\d+)\]$/.exec(text);
			if (exit !== null) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) };
			return { output: text, exitCode: 0 };
		}
		/**
		 * The terminal card for one call, or `null` for the generic INPUT/OUTPUT body: what
		 * the platform draws for its own `bash`/`pwsh`. A running call shows the card with no
		 * status; a settled one must be a single text block, not an error, and carry none of the
		 * unsettled notices above. The single `terminal` tool is deliberately NOT one of these:
		 * its call names an action rather than a command line, exactly like the platform's own
		 * `terminal_open`/`terminal_read` rows, which stay generic.
		 */
		function shellCard(props, argsRaw, output) {
			if (primitives.TerminalBlock === undefined || primitives.TerminalBlock === null) return null; // same test as the gate above
			if (!SHELL_TOOL_NAMES.includes(props?.toolName)) return null;
			const args = parseCardArgs(argsRaw);
			if (args === undefined) return null;
			const command = args.command;
			if (typeof command !== "string" || command.trim() === "") return null;
			const background = args.run_in_background === true;
			const workdir = typeof args.workdir === "string" && args.workdir !== "" ? args.workdir : undefined;
			// The platform's `TerminalBlock` shortens the prompt label to `~` for the home
			// directory, but only when the owner passes `home`; carry it like the platform does.
			const home = typeof props.home === "string" && props.home !== "" ? { home: props.home } : {};
			// The prompt cwd is the platform's `resolveTerminalCwd`: an absolute request is
			// used as-is, a relative one joins under the session workspace, and `.`/`..` are
			// collapsed. A settled result that recorded its actual cwd wins over the request.
			const settledCwd = isSettledBlock(props?.block) ? recordedAbsoluteCwd(props.block) : undefined;
			const cwd = settledCwd ?? displayCwd(workdir, props.cwd);
			if (!isSettledBlock(props?.block))
				return { command, cwd, ...home, output: undefined, exitCode: undefined, signal: undefined, running: true, ...(background ? { background: true } : {}) };
			if (props.block.isError === true) return null;
			// The platform's own shell card renders a background call with `background: true`
			// (header only, no status/output): a job id is not a command with a verdict.
			if (background) return { command, cwd, ...home, running: false, background: true };
			if (typeof output !== "string" || output === "") return null;
			if (UNSETTLED_NOTICE.test(output)) return null;
			const status = shellStatus(output);
			return { command, cwd, ...home, output: status.output, exitCode: status.exitCode, signal: status.signal, running: false };
		}
		/**
		 * The collapsed row's failure capsule, by the platform's own rule
		 * (`terminalExitLabel`): only a settled FOREGROUND call with a non-zero exit or a
		 * signal carries one. Running and background calls carry none, and a call with no
		 * terminal card (generic body) has nothing to label.
		 * @param card - the shell card, or null for the generic body.
		 * @param t - the row's localizer.
		 * @returns the localized capsule label, or null.
		 */
		function shellExitLabel(card, t) {
			if (card === null || card.running === true || card.background === true) return null;
			if (card.signal !== undefined) return fill(t("terminal.signal"), { signal: card.signal });
			if (typeof card.exitCode === "number" && card.exitCode !== 0) return fill(t("terminal.exitCode"), { code: card.exitCode });
			return null;
		}
		/** Fill a `{token}` template, so this plugin's labels need no interpolation support from `t`. */
		function fill(template, values) {
			let out = template;
			for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(String(value));
			return out;
		}
		/**
		 * The labels `TerminalBlock` requires, mirrored from the platform's own
		 * `terminalBlockLabels` (the wording of which lives in `dsh-client-ui-conversation`). The
		 * three base strings are ALSO carried here rather than relied on: the locale service does
		 * fall back to its `common` namespace, and this plugin shadows that with the same words.
		 */
		function terminalLabels(t) {
			return {
				commandLine: (line) => fill(t("terminal.commandLine"), { n: line }),
				signal: (signal) => fill(t("terminal.signal"), { signal }),
				exitCode: (code) => fill(t("terminal.exitCode"), { code }),
				noExitCode: t("terminal.noExitCode"),
				running: t("terminal.running"),
				failed: t("terminal.failed"),
				done: t("terminal.done"),
				copy: t("copy"),
				copied: t("copied"),
				noOutput: t("terminal.noOutput"),
				collapseAria: t("terminal.collapseAria"),
				collapse: t("collapse"),
				expandAria: (hidden) => fill(t("terminal.expandAria"), { n: hidden }),
			// The folded control reads `copy.expand(hidden)` (and `copy.expandAria` for its
			// aria-label) — reachable only when the card caps its lines, which ours does not
			// (`maxLines: Infinity`), so this is the difference between a landmine and a
			// contract. The platform's own copy for it lives in the CONVERSATION namespace,
			// which this plugin's entry→common lookup chain cannot reach: it must be ours.
			expand: (hidden) => fill(t("terminal.expandRest"), { n: hidden }),
			};
		}
		/** The terminal card itself, with this plugin's labels (the primitive carries its styles). */
		function terminalBody(card, t) {
			return h(primitives.TerminalBlock, { ...card, maxLines: Infinity, labels: terminalLabels(t), className: "dshwmb-tool-terminal" });
		}
		/**
		 * The disclosure shape the slot's owner supplies, for a direct render without one.
		 * The slot contract always hands `useDisclosure` over; this keeps a unit call (and
		 * an older deployment) renderable without a second state model.
		 */
		function useFallbackDisclosure() {
			const [expanded, setExpanded] = React.useState(false);
			return { expanded, setExpanded, toggle: () => setExpanded((value) => !value) };
		}
		/**
		 * One call's row title: the tool's OWN name, the same string in every language, so the
		 * four shells are told apart at a glance. A name this dictionary has no title for falls
		 * back to the shared "run command" copy instead of showing a raw locale key.
		 */
		function cardTitle(props, t) {
			const name = props?.toolName;
			if (typeof name !== "string" || name === "") return t("tool.title.other");
			const title = t(`tool.title.${name}`);
			return title === `tool.title.${name}` ? t("tool.title.other") : title;
		}

		/**
		 * One tool call's conversation row: the platform's own shell look — its disclosure
		 * chrome, the API glyph, the tool's own name as the title, the command as the summary,
		 * and the platform's terminal card as the body — for the wire names this bundle
		 * registers. The platform dispatches every call through the keyed `tool.call.toolview`
		 * seat by wire name, so a registered row REPLACES the generic one; the call, its
		 * arguments, its result and the chat anchors stay the platform's.
		 */
		function ToolCard(props) {
			const t = textOf(props);
			const view = props?.toolName === TERMINAL_TOOL_NAME ? TERMINAL_TOOL_NAME : "shell";
			// The seat's own disclosure hook: the open state then resets with the enclosing
			// Turn, like every platform-owned tool row, instead of living in a second state
			// model that survives the Turn it belongs to. A direct unit invocation (no slot
			// owner) falls back to the same shape.
			const useDisclosure = typeof props?.useDisclosure === "function" ? props.useDisclosure : useFallbackDisclosure;
			const { expanded, toggle: toggleExpanded } = useDisclosure();
			const settled = isSettledBlock(props?.block);
			const argsRaw = settled ? props.block.call?.argsRaw ?? "" : props?.phase === "start" ? props.block?.argsRaw ?? "" : null;
			const state = cardState(props?.phase, props?.block);
			const output = settled ? cardOutput(props.block) : null;
			const summary = argsRaw === null ? "" : cardSummary(view, argsRaw, props?.callId);
			// The platform's terminal card when this call is one settled foreground shell
			// command; the generic INPUT/OUTPUT card otherwise.
			const card = argsRaw === null ? null : shellCard(props, argsRaw, output);
			// The platform's collapsed-row failure capsule (its `terminalExitLabel`): a
			// settled foreground call with a non-zero exit or a signal carries one.
			const exitLabel = shellExitLabel(card, t);
			const settlement = state === "error" ? (output === null ? null : firstLine(output)) : state === "stopped" ? t("row.stopped") : null;
			const expandable = state !== "preparing" && argsRaw !== null;
			const open = expanded && expandable;
			const line = settlement ?? summary;
			return h(
				"div",
				{ className: "dshwmb-tool", "data-tool": props?.toolName, "data-state": state },
				state === "error" || state === "running" || state === "preparing"
					? h("span", { key: "status", className: "dshwmb-tool-visuallyhidden" }, state === "error" ? t("row.failed") : t("row.running"))
					: null,
				h(primitives.DisclosureRow, {
					key: "row",
					rowClassName: "dshwmb-tool-row",
					leadingClassName: "dshwmb-tool-leading",
					titleClassName: "dshwmb-tool-title",
					icon: cardIcon(),
					title: cardTitle(props, t),
					running: state === "running" || state === "preparing",
					open,
					expandable,
					expandOnRowClick: true,
					keepContentWhenOpen: true,
					onToggle: toggleExpanded,
					collapsedContent:
						line === ""
							? null
							: [
								h("span", { key: "sep", className: "dshwmb-tool-sep", "data-shimmer-decoration": true, "aria-hidden": true }),
								h(
									primitives.TextShimmer,
									{ key: "summary" },
									h(
										"span",
										{
											className: "dshwmb-tool-summary",
											"data-error": state === "error" ? "" : undefined,
											"data-stopped": state === "stopped" ? "" : undefined,
										},
										line,
									),
								),
								exitLabel === null
									? null
									: h(
										"span",
										{ key: "exit", className: "dshwmb-tool-exit" },
										h("span", { key: "dot", className: "dshwmb-tool-exit-dot", "aria-hidden": true }),
										exitLabel,
									),
							],
					children: open
						? toolCardBody(props, card !== null ? terminalBody(card, t) : toolCardIo(props, state, cardInput(argsRaw), output))
						: null,
				}),
			);
		}
		//#endregion
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
			if (knob.kind === "number") {
				if (!Number.isFinite(Number(trimmed))) return "number";
				// The save writes the NUMBER, so a spelling that names a different string
				// (`0x10`, `1e3`, `007`, `+5`) is reported instead of silently becoming
				// 16/1000/7 — a visible warning, never a rewrite: the box keeps what was typed
				// until the user changes it, and the value written is the number it named.
				return String(Number(trimmed)) === trimmed ? undefined : "numberFormat";
			}
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
		/**
		 * The package row itself, whose switches belong at the TOP of the plugin rather
		 * than inside a shell row. Its namespace is the row id the Host serves (exactly
		 * like the tool rows), but the seat it lands in is the official page bundle seat,
		 * keyed by the package name and rendered on the plugin's own page.
		 */
		const CORE_ROW = {
			rowId: CORE_ROW_ID,
			label: { en: "Win multi bash", zh: "Win multi bash" },
			fields: [
				field(["guardSandboxTemp"], "boolean"),
				field(["tempWatchMs"], "number"),
			],
		};
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
				? withValue(t(knob.invalidReason === "path" ? "invalidPath" : knob.invalidReason === "distro" ? "invalidDistro" : knob.invalidReason === "numberFormat" ? "invalidNumberFormat" : "invalidNumber"), String(knob.text).trim())
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
			const t = textOf(props);
			// A seat that does not hand over the form hook cannot render the form. Rather
			// than throwing (which leaves the page with an empty strip and no clue), say so
			// in one line: that line appearing IS the proof this contribution was reached.
			if (typeof props?.useRowForm !== "function") return h("p", { className: "dshwmb-hint" }, t("summary"));
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
			".dshwmb-note{margin:14px 0 0}",
			".dshwmb-tool{flex-direction:column;display:flex}",
			".dshwmb-tool-leading{flex-shrink:0}",
			".dshwmb-tool-title{font-weight:400}",
			".dshwmb-tool-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}",
			".dshwmb-tool-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden;color:var(--dsw-alias-label-tertiary)}",
			".dshwmb-tool-summary[data-error]{color:var(--dsw-alias-state-error-primary)}",
			".dshwmb-tool-summary[data-stopped]{color:var(--dsw-alias-state-warn-label)}",
			".dshwmb-tool-exit{white-space:nowrap;flex:none;align-items:center;gap:5px;margin-left:8px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;display:inline-flex;align-self:center}",
			".dshwmb-tool-exit-dot{background:var(--dsw-alias-state-error-primary);border-radius:50%;flex:none;width:4px;height:4px;corner-shape:round}",
			".dshwmb-tool-body{flex-direction:column;display:flex}",
			".dshwmb-tool-io{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);flex-direction:column;margin:4px 0 4px 4px;display:flex}",
			".dshwmb-tool-terminal{margin:4px 0 4px 4px;--dsl-terminal-font:var(--dsw-font-markdown-code-block-small);--dsl-terminal-line-height:18px;--dsl-terminal-output-max-height:224px;border:.5px solid var(--dsw-alias-border-l1)}",
			".dshwmb-tool-iosection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}",
			".dshwmb-tool-iolabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}",
			".dshwmb-tool-iodivider{background:var(--dsw-alias-border-l2);flex:none;height:.5px}",
			".dshwmb-tool-iotext{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}",
			".dshwmb-tool-iotext[data-error]{color:var(--dsw-alias-state-error-primary)}",
			".dshwmb-tool-inspect{border:.5px solid var(--dsw-alias-border-l3);corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}",
			".dshwmb-tool:hover .dshwmb-tool-inspect,.dshwmb-tool-inspect:focus-visible{opacity:1}",
			".dshwmb-tool-inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
			".dshwmb-tool-visuallyhidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}",
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
			/**
			 * Run one contribution and keep the rest. Activation happens during web boot, where a
			 * throw that escapes is reported as `web boot: N entries did not activate` and the shell
			 * shows its crash dialog — and inside `apply` it would silently drop every contribution
			 * registered after the throwing one (the row pages come first, the bundle card and the
			 * labels last). So each contribution is isolated; the outer guard stays as the last
			 * resort for a failure in this helper itself.
			 */
			const safely = (what, run) => {
				try {
					run();
				} catch (error) {
					ctx?.logger?.warn?.(`dsh-win-multi-bash: ${what} failed: ${error?.message ?? error}`);
				}
			};
			safely("dictionaries", () => ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-win-multi-bash: dictionaries"));
			safely("stylesheet", () => ctx.effect(() => installStyles(), "dsh-win-multi-bash: stylesheet"));
			for (const row of ROWS)
				safely(`${row.rowId} page`, () => {
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
				});
			// THE CONVERSATION ROWS. A call of ours should read like the platform's own shell
			// card rather than the generic `Tool call · <name>` row. The platform dispatches every
			// atomic call through the keyed `tool.call.toolview` seat BY WIRE NAME and a registered
			// row REPLACES the generic one — that seat is the documented extension point for the
			// package that owns the tool, and it is where the platform's own first-party rows live.
			// All or nothing: without the primitives the card is built from, the platform's own
			// generic row (today's behaviour) stays instead of a half-drawn one.
			safely("conversation rows", () => {
				// `undefined` OR `null`: a deployment that exposes a null member would pass an
			// undefined-only test and then render `h(null, …)`, which is exactly the "half-drawn
			// card" the all-or-nothing rule exists to prevent.
			const missing = CARD_PRIMITIVES.filter((name) => primitives[name] === undefined || primitives[name] === null);
				if (missing.length > 0) {
					ctx?.logger?.warn?.("dsh-win-multi-bash: tool rows not registered; missing primitives: " + missing.join(", "));
					return;
				}
				for (const toolName of [...SHELL_TOOL_NAMES, TERMINAL_TOOL_NAME])
					ctx.effect(
						() =>
							ctx.slots.inject("tool.call.toolview", () =>
								ctx.slots.register({ name: "tool.call.toolview", key: toolName, locale: NS }, ToolCard),
							),
						`dsh-win-multi-bash: ${toolName} conversation row`,
					);
			});
			// THE SWITCH, listed exactly once — on the page a reader reaches as this bundle
			// (`dsh-win-multi-bash`), never in the tool rows: one deployment-wide value governs
			// the guard, every row's inline pre-spawn check, and the driver. It is registered
			// under every key a deployment might ask that seat with — the package name, and the
			// namespace the core row serves — because a keyed seat simply ignores a key nobody
			// asks for. The switch is NOT offered on the core row's own page, and NOT as a
			// Settings section: the aggregator UI already draws that row's schema form by itself,
			// and a `settings.section` contribution showed the same form a second time — as an
			// unlabelled top-level entry, since a section registration here carries no label —
			// while the README promises this switch "listed exactly once, on the plugin's own
			// page". The bundle card below is that one place.
			safely("the core-row card", () => {
				const coreForm = new RowConfigForm(ctx.configForms.get(CORE_ROW_ID), CORE_ROW);
				ctx.effect(() => () => coreForm.dispose(), "dsh-win-multi-bash: " + CORE_ROW_ID + " form");
				// REGISTERED UNCONDITIONALLY, like the badge and the note — those two are the only
				// contributions measured to render here. The `whileServed` gate these cards used to
				// carry was the difference: this deployment never serves the core row's settings
				// namespace, so a gated registration simply never happened and the page kept showing
				// its empty strip. An unresolvable scope degrades inside the card instead.
				for (const seat of [
					["plugins.bundle.config", CORE_ROW_ID],
					["plugins.bundle.config", PACKAGE_NAME],
				]) {
					ctx.effect(
						() =>
							ctx.slots.inject(seat[0], () =>
								ctx.slots.register(
									{ name: seat[0], key: seat[1], locale: NS, inject: () => coreForm.inject() },
									RowConfigCard,
								),
							),
						`dsh-win-multi-bash: ${seat[0]} ${seat[1]}`
					);
				}
			});
			// The bundle's own page and the core row's page are the same subject to a
			// reader: say which row has to stay on and what its switch costs.
			for (const [slotName, component] of [
				["plugins.detail.section", CoreNote],
			]) {
				safely(slotName, () =>
					ctx.effect(
						() =>
							ctx.slots.inject(slotName, () =>
								ctx.slots.register({ name: slotName, id: `${PACKAGE_NAME}:core`, order: 100, locale: NS }, component),
							),
						`dsh-win-multi-bash: ${slotName}`,
					),
				);
			}
		}
		//#endregion

		/** The client entry exports the platform plugin triple, and nothing else. */
		exports.name = PACKAGE_NAME;
		/**
		 * The exported `apply` never throws. Activation happens during web boot, where an
		 * exception is reported as `web boot: N entries did not activate` and the shell
		 * shows its crash dialog — a far worse outcome than a card that did not appear.
		 * Every failure is logged; the rest of the UI keeps working.
		 */
		exports.apply = (ctx) => {
			try {
				apply(ctx);
			} catch (error) {
				ctx?.logger?.warn?.("dsh-win-multi-bash: client apply failed: " + (error?.message ?? error));
			}
		};
		exports.inject = inject;
		/** Private helpers the test seam hands over; they are never exported. */
		const __internals = () => ({ NS, ROWS, CORE_ROW, CORE_ROW_ID, rowKey, at, has, coerce, sameValue, plannedOp, planOps, RowConfigForm, RowConfigCard, CoreNote, ownedPage, installStyles, PACKAGE_NAME, STYLE_ID, en, zh, SHELL_TOOL_NAMES, TERMINAL_TOOL_NAME, CARD_PRIMITIVES, ToolCard, toolCardBody, toolCardIo, terminalBody, terminalLabels, cardTitle, shellCard, shellExitLabel, shellStatus, displayCwd, normalizeSegments, recordedAbsoluteCwd, fill, UNSETTLED_NOTICE, cardSummary, cardState, cardOutput, cardInput, parseCardArgs, firstLine, CSS });
		/**
		 * Test-only seam, never an export and never built in production: the helpers
		 * are constructed only when the audit installs the hook. The name is
		 * package-private (the platform owns the __DSH_ prefix), and a throwing hook
		 * must not take the page down.
		 */
		if (typeof globalThis.__dshWinMbClientTest__ === "function") {
			try {
				globalThis.__dshWinMbClientTest__(__internals());
			} catch {
				/* a test seam is not worth a failed boot */
			}
		}
		return module.exports;
	},
});
