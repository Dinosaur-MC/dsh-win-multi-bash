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
		// The menu portals to the document so the header's own overflow and stacking
		// cannot clip it (the first-party job list does the same). A deployment that
		// serves no `react-dom` falls back to rendering it in place.
		let createPortal;
		try {
			createPortal = require("react-dom").createPortal;
		} catch (error) {
			createPortal = undefined;
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
			summary: "Configure the shell tool rows (git_bash, wsl_bash, msys2_bash, ssh_shell) and the interactive terminal row: paths, sandbox stance, command limits, and session shape.",
			coreNote: "This plugin inserts one row per shell tool (git_bash, wsl_bash, and the opt-in msys2_bash and ssh_shell), one row for the interactive terminal tool, and its core row. Configure each tool on its own row. Keep the core row enabled — it serves this page and owns the shared shell prompt section; with it off the tools still run and carry that guidance in their own descriptions, but the Configure controls on this page disappear.",
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
			invalidHosts: "Enter a JSON array of host objects, or leave blank (got \"{value}\").",
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
			"tool.title.ssh_shell": "SSH remote shell",
			"tool.title.terminal": "Terminal",
			"tool.title.other": "Run command",
			// The dedicated SSH authorization card (a conversation.composer chain entry):
			// the reason text itself comes from the request, these are the fixed parts.
			"sshApproval.title": "Authorize this SSH host for the session",
			"sshApproval.waiting": "Waiting for approval",
			"sshApproval.detailAria": "Approval details",
			"sshApproval.scope": "Allowing grants THIS session only: the grant lives in memory until the session ends, and editing any connection field asks again.",
			"sshApproval.allow": "Allow for this session",
			"sshApproval.allowOnce": "Allow once",
			"sshApproval.allowSession": "Allow for this session",
			"sshApproval.oneShotNeedsCall": "This request has no usable call id, so neither allow action can record its scope; use Reject or the standard approval card.",
			"sshApproval.reject": "Reject",
			"sshApproval.settled": "This request is no longer pending.",
			"sshApproval.failed": "The answer could not be delivered. The request is still pending — try again, or answer it from the standard approval card.",
			// The terminal card's own copy, mirrored from the platform's `terminalBlockLabels`
			// (`dsh-client-ui-conversation`) and the locale base copy (`copy`/`copied`/`collapse`).
			"terminal.commandLine": "Command line {n}",
			"terminal.signal": "signal {signal}",
			"terminal.exitCode": "exit code {code}",
			"terminal.noExitCode": "no exit code",
			"terminal.running": "Running",
			"terminal.failed": "Failed",
			"terminal.done": "Done",
			"terminal.panel.label": "Terminal sessions",
			"terminal.panel.empty": "No terminal sessions are open.",
			"terminal.panel.stop": "Stop",
			"terminal.panel.unavailable": "This deployment cannot reach the terminal sessions.",
			"terminal.panel.liveCount": "{count} terminal session running",
			"terminal.panel.idleCount": "{count} terminal sessions",
			"terminal.panel.sectionLive": "Running",
			"terminal.panel.sectionSettled": "Finished {count}",
			"terminal.panel.statusRunning": "running",
			"terminal.panel.statusExited": "exited",
			"terminal.panel.statusStopped": "stopped",
			"terminal.panel.statusIdle": "idle timeout",
			"terminal.panel.statusTransport": "transport failed",
			"terminal.panel.statusClosed": "closed",
			"terminal.panel.statusStartup": "died at startup",
			"terminal.panel.statusExitCode": "exit {code}",
			"terminal.panel.clear": "Clear",
			"terminal.panel.clearAria": "Clear the finished sessions",
			"terminal.panel.foldSettled": "Hide the finished sessions",
			"terminal.panel.unfoldSettled": "Show the finished sessions",
			"terminal.panel.confirm": "Click again to confirm",
			"terminal.panel.confirmAction": "Confirm",
			"terminal.panel.durationTitle": "Elapsed",
			"terminal.panel.durationSeconds": "{seconds}s",
			"terminal.panel.durationMinutes": "{minutes}m {seconds}s",
			"terminal.panel.durationHours": "{hours}h {minutes}m",
			"terminal.panel.expandAria": "Show the session output",
			"terminal.panel.collapseAria": "Hide the session output",
			"terminal.panel.loading": "Loading…",
			"terminal.panel.noOutput": "(no output)",
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
			"enableRunInBackground.hint": "When on, this tool accepts run_in_background. The change takes effect after this row reloads.",
			"promoteOnTimeout.label": "Promote on timeout",
			"promoteOnTimeout.hint": "Keep a foreground command that reaches its timeout running as a background job instead of killing it. Needs Background jobs; with them off the deadline kills the command as before.",
			"guardSandboxTemp.label": "Self-heal the sandbox temp directory",
			"guardSandboxTemp.hint": "Repairs the sandbox temp directory before a confined spawn, and watches it while the command runs. Applies to every confined spawn in this deployment.",
			"tempWatchMs.label": "Self-heal check interval (ms)",
			"tempWatchMs.hint": "How often the temp directory is checked while a command runs.",
			"option.git_bash": "Git Bash",
			"option.wsl_bash": "WSL Bash",
			"option.msys2_bash": "MSYS2 Bash",
			"option.ssh_shell": "SSH remote shell",
			"defaultShell.label": "Default shell for new sessions",
			"defaultShell.hint": "Which dialect an open starts when the call names no shell. Only the dialects that declare an interactive session are offered.",
			"maxSessions.label": "Maximum open sessions per conversation",
			"maxSessions.hint": "How many live sessions one conversation may hold. Opening one more is refused by name. Sessions are process-local, reclaimed when idle, and ended with action close.",
			"maxSessionsTotal.label": "Maximum open sessions on this host",
			"maxSessionsTotal.hint": "Deployment-wide ceiling across all conversations. Reaching it refuses new sessions with a message that names this limit instead of the per-conversation one.",
			"quietNoticeMs.label": "State sample interval (ms)",
			"quietNoticeMs.hint": "Sampling interval for session activity, in ms. The state is sampled at this interval and only a change between active and quiet is announced; 0 disables those change notices.",
			"idleMs.label": "Idle timeout (ms)",
			"idleMs.hint": "A session with no send/read/signal for this long is terminated and removed. A stale id then says it was reclaimed instead of looking unknown. Set 0 to never reclaim on idleness.",
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
			"maxOutputBytes.hint": "Inline output cap; beyond it output spills to a file and the first bytes stay inline.",
			"maxSpillBytes.label": "Spill file cap (bytes)",
			"maxSpillBytes.hint": "Cap for the spilled-output file; reaching it truncates the spill (the inline part is unaffected).",
			"graceMs.label": "Grace before a forced kill (ms)",
			"graceMs.hint": "How long the command may keep flushing after a stop before it is killed outright.",
			"bashPath.label": "Git Bash executable",
			"bashPath.hint": "Pin an explicit bash.exe. Empty probes Git for Windows instead (PATH, well-known installs, then the registry).",
			"wslPath.label": "WSL launcher (wsl.exe)",
			"wslPath.hint": "Blank uses wsl.exe from the standard Windows location, then PATH. Pick the distribution with the next field.",
			"wslDistro.label": "Distribution",
			"wslDistro.hint": "Pin a distribution by name. Empty uses the FIRST distribution WSL lists, which is not necessarily the default one — name it here to be sure.",
			"sshPath.label": "SSH client executable",
			"sshPath.hint": "Pin an explicit ssh.exe. Empty probes the Windows OpenSSH client, then PATH (which finds a Git-for-Windows client).",
			"hosts.label": "Hosts",
			"hosts.hint": "A host is one remote machine this tool may reach. The four required fields are the alias (the name a call uses to pick it), the host address, the login user and the private-key file. At most one host may be the Default host; only then may a call omit the alias. Session authorization: session asks once per conversation, trusted never asks (use it for unattended work). Approval timeout: blank = 120000 ms, 0 = wait forever. The passphrase field holds an ENVIRONMENT VARIABLE NAME, never the secret itself.",
			// The hosts TABLE (lib/client.js HostsEditor): controls, inline warnings, and the
			// approval select's two values. The knob's own hosts.hint above stays the
			// one-paragraph description of the registry.
			"hosts.add": "Add host",
			"hosts.remove": "Remove host",
			"hosts.test": "Test connection",
			"hosts.testing": "Testing…",
			"hosts.save": "Save hosts",
			"hosts.expand": "Expand",
			"hosts.collapse": "Collapse",
			"hosts.untitled": "(untitled host)",
			"hosts.errorCount": "{value} problems",
			"hosts.addBlocked": "Fix the highlighted fields in the current hosts first.",
			"hosts.testOk": "Connection OK (fingerprint {value}).",
			"hosts.testOkPlain": "Connection OK.",
			"hosts.testFailed": "Connection test failed: {value}",
			"hosts.testNeedsFix": "Fix this host's highlighted fields before testing it.",
			"hosts.testWarning": "Host key note: {value}",
			"hosts.invalidField": "This field is invalid.",
			"hosts.row": "Host {value}",
			"hosts.empty": "No hosts yet. Add one to make this tool usable.",
			"hosts.invalidSummary": "This table cannot be saved yet: fix the highlighted fields (an invalid host would never work).",
			"hosts.invalidLegacy": "This saved draft is not a host table any more. Re-enter the hosts below (or reset the field) so the table can be saved.",
			"hosts.required": "{value} is required.",
			"hosts.aliasInvalid": "An alias starts with a letter or digit and may contain only letters, digits, dots, underscores and dashes.",
			"hosts.aliasDuplicate": "This alias is already used by another host.",
			"hosts.hostInvalid": "A host is a hostname or IP address with no spaces.",
			"hosts.portInvalid": "A port is a whole number from 1 to 65535, or blank for 22.",
			"hosts.defaultDuplicate": "Only one host may be the default.",
			"hosts.timeoutInvalid": "The connect timeout is a positive whole number of milliseconds, or blank for 30000.",
			"hosts.approvalTimeoutInvalid": "The approval timeout is 0 (wait forever) or a whole number from 1000 to 3600000 milliseconds; blank uses 120000.",
			"hosts.field.alias": "Alias",
			"hosts.field.host": "Host",
			"hosts.field.port": "Port",
			"hosts.field.user": "User",
			"hosts.field.keyPath": "Key file",
			"hosts.field.passphraseEnv": "Passphrase env var",
			"hosts.field.startupCommand": "Startup command",
			"hosts.field.shellTemplate": "Shell template",
			"hosts.field.connectTimeoutMs": "Connect timeout (ms)",
			"hosts.field.approvalTimeoutMs": "Approval timeout (ms)",
			"hosts.field.approval": "Session authorization",
			"hosts.field.acceptNewHostKeys": "Accept new host keys",
			"hosts.field.default": "Default host",
			"hosts.field.description": "Description",
  "hosts.flow": "Test uses the current unsaved values (host key + key authentication, no command is executed); edits are written only after Save.",
  "hosts.clear": "Clear host table",
  "hosts.clearConfirm": "Confirm clear",
  "hosts.defaultBadge": "Default",
  "hosts.advancedShow": "Advanced settings",
  "hosts.advancedHide": "Hide advanced",
  "hosts.clearHint": "This clears every host on the table. It is staged until Save.",
  "cancel": "Cancel",
  "defaultHint": "Blank = {value}.",
  "group.session": "Session",
  "group.output": "Output and waiting",
  "group.backends": "Backend executables",
  "group.ssh": "SSH session",
  "requireSandboxRemote.label": "Allow only danger-full-access runs",
  "requireSandboxRemote.hint": "Remote commands are never governed by the local sandbox; with this on every run is refused unless danger-full-access.",
  "sandboxBwrap.hint": "auto probes and degrades honestly; none never confines; bwrap (WSL only) refuses to run unconfined.",
  "sandboxNoBwrap.hint": "auto probes and degrades honestly; none never confines.",
  "hosts.field.alias.hint": "Used by a call to select this host; starts with a letter or digit, may contain . _ -",
  "hosts.field.host.hint": "Hostname or IP address of the remote machine.",
  "hosts.field.port.hint": "TCP port; blank = 22.",
  "hosts.field.user.hint": "Login user on the remote host.",
  "hosts.field.keyPath.hint": "Path to the private key; supports ~. Read only on this machine; never uploaded.",
  "hosts.field.passphraseEnv.hint": "Environment variable NAME holding the passphrase, not the secret itself. Read locally; never stored.",
  "hosts.field.startupCommand.hint": "Runs at the head of every call's script; spaces and newlines are kept verbatim, and multiple lines are allowed. A non-zero exit fails that call.",
  "hosts.field.shellTemplate.hint": "This channel's command line; spaces and newlines are kept verbatim. The script itself is sent base64 on stdin; blank uses bash -c 'eval \"$(base64 -d)\"'.",
  "hosts.field.connectTimeoutMs.hint": "Handshake + authentication ceiling; blank = 30000 ms.",
  "hosts.field.approvalTimeoutMs.hint": "How long a pending approval may stay open; blank = 120000 ms; 0 = wait forever.",
  "hosts.field.approval.hint": "session: ask once per conversation on first use. trusted: never ask; for unattended work.",
  "hosts.field.acceptNewHostKeys.hint": "Accept a key missing from known_hosts once; never writes that file. Does not bypass a changed or revoked key.",
  "hosts.field.default.hint": "At most one host may be the default; only then may a call omit the alias.",
  "hosts.field.description.hint": "Shown only; does not affect behavior.",
  "gitBash.bashPath.label": "Git Bash executable",
  "gitBash.bashPath.hint": "Empty probes, in order: Git roots inferred from PATH entries shaped like cmd/bin with a real git.exe; Program Files then Program Files (x86) layouts; every fixed drive's Program Files; then every PATH entry. Only real files are used, never the WSL launcher.",
  "wslBash.wslPath.label": "WSL launcher (wsl.exe)",
  "wslBash.wslPath.hint": "Blank uses wsl.exe from the standard Windows location, then PATH. Pick the distribution with the next field.",
  "wslBash.wslDistro.label": "WSL distribution",
  "wslBash.wslDistro.hint": "Distribution name; blank uses the FIRST distribution WSL lists (not necessarily the default one), so name it here to be sure.",
  "msys2Bash.bashPath.label": "MSYS2 bash executable",
  "msys2Bash.bashPath.hint": "Empty probes MSYS2 UCRT64 (then PATH).",
  "sshShell.sshPath.label": "ssh executable",
  "sshShell.sshPath.hint": "The OpenSSH client this row starts for interactive sessions; empty probes the Windows OpenSSH feature, then PATH.",
  "sshShell.sshHost.label": "SSH session host",
  "sshShell.sshHost.hint": "The host an interactive session opens. An unset host refuses opening a session. This row starts ssh.exe, so it does not read the command row host registry.",
  "sshShell.sshUser.label": "SSH session user",
  "sshShell.sshUser.hint": "Optional login name. Empty lets ssh decide (its config, then your local user name).",
  "sshShell.sshPort.label": "SSH session port",
  "sshShell.sshPort.hint": "Optional TCP port. Blank = 22 (or the client config).",
  "sshShell.acceptNewHostKeys.label": "Accept an unknown host key (session)",
  "sshShell.acceptNewHostKeys.hint": "Uses ssh.exe with accept-new: the first key for an unknown host is learned into known_hosts. A changed or revoked key is still refused.",
  "sshShell.connectTimeoutMs.label": "SSH session connect timeout (ms)",
  "sshShell.connectTimeoutMs.hint": "Handshake ceiling in whole seconds (minimum 1); does not bound the session itself. Blank = 15000 ms.",
			"hosts.approval.session": "session (ask once per session)",
			"hosts.approval.trusted": "trusted (never ask)",
			"sshHost.label": "Remote host",
			"sshHost.hint": "The host an interactive session opens. An unset host refuses opening a session. This row starts ssh.exe, so it does not read the command row host registry.",
			"sshUser.label": "Remote user",
			"sshUser.hint": "Optional login name. Empty lets ssh decide (its config, then your local user name).",
			"sshPort.label": "Remote port",
			"sshPort.hint": "Optional TCP port. Blank = 22 (or the client config).",
			"acceptNewHostKeys.label": "Accept an unknown host key (trust on first use)",
			"acceptNewHostKeys.hint": "Uses ssh.exe with accept-new: the first key for an unknown host is learned into known_hosts. A changed or revoked key is still refused.",
			"connectTimeoutMs.label": "Connection timeout (ms)",
			"connectTimeoutMs.hint": "Handshake + authentication ceiling in whole seconds (minimum 1); does not bound the session itself. Blank = 15000 ms.",
			"sandbox.label": "Sandbox stance",
			"sandbox.hint": "auto probes and degrades honestly; none never confines; bwrap (WSL only) refuses to run unconfined.",
			"probeTimeoutMs.label": "Sandbox probe timeout (ms)",
			"probeTimeoutMs.hint": "How long the confinement probe may take before it is treated as a failure.",
			"requireSandbox.label": "Refuse runs when no sandbox can be applied",
			"requireSandbox.hint": "Local: a failed confinement probe refuses read-only and workspace-write calls instead of degrading. danger-full-access still runs.",
			"sandboxNotice.label": "Unwrapped-run notice",
			"sandboxNotice.hint": "How often a run that the sandbox did not wrap says so. once (default): this row explains itself on its first such run and stays quiet afterwards — the structured sandbox.unconfined fact still rides on every result. always: every such run keeps the short note.",
		};
		/** Simplified Chinese copy. */
		const zh = {
			summary: "配置各 shell 工具行（git_bash、wsl_bash、msys2_bash、ssh_shell）与交互式终端行（terminal）：路径、沙箱立场、命令限制与会话形态。",
			coreNote: "本插件为每个 shell 工具插入一行（git_bash、wsl_bash，以及按需开启的 msys2_bash、ssh_shell），再加一行交互式终端（terminal），以及核心行。工具各自在自己的行上配置。请保持核心行开启——本页由它提供，共有的那段 shell 提示词也归它所有；关掉后工具照旧可用（共有指导回落到各自的描述里），但本页的配置入口会消失。",
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
			invalidHosts: "请填主机对象的 JSON 数组；留空表示不配置（当前为「{value}」）。",
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
			"tool.title.ssh_shell": "SSH remote shell",
			"tool.title.terminal": "终端",
			"tool.title.other": "运行命令",
			// 专用 SSH 授权卡（conversation.composer 链式条目）：理由文本来自请求本身，
			// 这里只是固定部分。
			"sshApproval.title": "授权本次会话使用该 SSH 主机",
			"sshApproval.waiting": "等待审批",
			"sshApproval.detailAria": "审批详情",
			"sshApproval.scope": "允许仅对本次会话生效：授权保存在内存中，直到会话结束；修改任一连接字段会重新询问。",
			"sshApproval.allow": "本次会话允许",
			"sshApproval.allowOnce": "允许一次",
			"sshApproval.allowSession": "本次会话允许",
			"sshApproval.oneShotNeedsCall": "该请求没有可用的 call id，两个允许按钮都无法登记授权范围；请用“拒绝”或标准审批卡。",
			"sshApproval.reject": "拒绝",
			"sshApproval.settled": "该请求已不再等待答复。",
			"sshApproval.failed": "答复未能送达。该请求仍在等待——请重试，或改用标准审批卡答复。",
			// 终端卡片自身文案，对应平台的 `terminalBlockLabels`（dsh-client-ui-conversation）
			// 与 locale 基础词典（copy/copied/collapse）。
			"terminal.commandLine": "命令第 {n} 行",
			"terminal.signal": "信号 {signal}",
			"terminal.exitCode": "退出码 {code}",
			"terminal.noExitCode": "未正常退出",
			"terminal.running": "运行中",
			"terminal.failed": "失败",
			"terminal.done": "已完成",
			"terminal.panel.label": "终端会话",
			"terminal.panel.empty": "当前没有打开的终端会话。",
			"terminal.panel.stop": "停止",
			"terminal.panel.unavailable": "此部署无法访问终端会话。",
			"terminal.panel.liveCount": "{count} 个终端会话运行中",
			"terminal.panel.idleCount": "{count} 个终端会话",
			"terminal.panel.sectionLive": "进行中",
			"terminal.panel.sectionSettled": "已结束 {count}",
			"terminal.panel.statusRunning": "运行中",
			"terminal.panel.statusExited": "已退出",
			"terminal.panel.statusStopped": "已手动停止",
			"terminal.panel.statusIdle": "空闲回收",
			"terminal.panel.statusTransport": "连接中断",
			"terminal.panel.statusClosed": "已关闭",
			"terminal.panel.statusStartup": "启动即退出",
			"terminal.panel.statusExitCode": "退出码 {code}",
			"terminal.panel.clear": "清空",
			"terminal.panel.clearAria": "清空已结束的会话",
			"terminal.panel.foldSettled": "收起已结束的会话",
			"terminal.panel.unfoldSettled": "展开已结束的会话",
			"terminal.panel.confirm": "再次点击确认停止",
			"terminal.panel.confirmAction": "确认停止",
			"terminal.panel.durationTitle": "已运行",
			"terminal.panel.durationSeconds": "{seconds}秒",
			"terminal.panel.durationMinutes": "{minutes}分{seconds}秒",
			"terminal.panel.durationHours": "{hours}小时{minutes}分",
			"terminal.panel.expandAria": "展开会话输出",
			"terminal.panel.collapseAria": "收起会话输出",
			"terminal.panel.loading": "加载中…",
			"terminal.panel.noOutput": "（无输出）",
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
			"enableRunInBackground.hint": "开启后该工具才接受 run_in_background；改动在该行下次加载后生效。",
			"promoteOnTimeout.label": "超时转后台",
			"promoteOnTimeout.hint": "前台命令到达超时时不终止，改为转入后台任务继续运行；需要开启「后台任务」，否则仍按原样终止。",
			"guardSandboxTemp.label": "沙箱临时目录自愈",
			"guardSandboxTemp.hint": "在受限进程启动前修复沙箱临时目录，并在命令运行期间持续观察。作用于本部署所有受限启动。",
			"tempWatchMs.label": "自愈检查间隔（毫秒）",
			"tempWatchMs.hint": "命令运行期间检查临时目录的间隔。",
			"option.git_bash": "Git Bash",
			"option.wsl_bash": "WSL Bash",
			"option.msys2_bash": "MSYS2 Bash",
			"option.ssh_shell": "SSH 远端 Shell",
			"defaultShell.label": "新会话默认 shell",
			"defaultShell.hint": "调用未传 shell 时，open 启动哪个方言；只列出声明了交互会话能力的方言。",
			"maxSessions.label": "每会话可开终端数",
			"maxSessions.hint": "单个对话最多同时持有多少个活动会话；超出时再开会被具名拒绝。会话是进程内的，空闲会被回收；用 close 主动结束。",
			"maxSessionsTotal.label": "本机终端总数上限",
			"maxSessionsTotal.hint": "所有对话合计的活动会话上限，达到后新开会被拒绝，且提示会点名这条上限而不是「每会话」那条。",
			"quietNoticeMs.label": "状态采样间隔（毫秒）",
			"quietNoticeMs.hint": "会话活跃状态的采样间隔（毫秒）：按此间隔采样，只在活跃与安静之间发生变化时提示；0 关闭这类变化提示。",
			"idleMs.label": "空闲回收（毫秒）",
			"idleMs.hint": "这段时间内没有 send/read/signal 的会话会被终止并移除；之后用旧 id 会被告知「已被空闲回收」，而不是含糊的 unknown。设为 0 表示不按空闲回收。",
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
			"maxOutputBytes.hint": "内联输出上限；超出后输出转存到文件，前面的字节仍以内联保留。",
			"maxSpillBytes.label": "转存文件上限（字节）",
			"maxSpillBytes.hint": "转存输出文件的上限；达到上限后转存内容被截断（不影响内联部分）。",
			"graceMs.label": "强制终止前的宽限（毫秒）",
			"graceMs.hint": "停止后允许命令继续冲刷输出的时长；超过后直接强杀。",
			"bashPath.label": "Git Bash 可执行文件",
			"bashPath.hint": "钉定显式 bash.exe；留空则自动探测 Git for Windows（PATH、常见安装位置、注册表）。",
			"wslPath.label": "WSL 启动器（wsl.exe）",
			"wslPath.hint": "留空时使用 Windows 标准位置的 wsl.exe（随后查 PATH）。要选发行版请用下一项。",
			"wslDistro.label": "发行版",
			"wslDistro.hint": "按名钉定发行版；留空使用 WSL 列出的第一个（不一定是默认发行版）——要确保选对就写在这里。",
			"sshPath.label": "SSH 客户端可执行文件",
			"sshPath.hint": "钉定显式 ssh.exe；留空先探测 Windows OpenSSH 客户端，再走 PATH（Git for Windows 自带的客户端就在 PATH 上）。",
			"hosts.label": "主机表",
			"hosts.hint": "主机是此工具可访问的一台远端机器。四个必填字段是别名（调用时用它选主机）、主机地址、登录用户和私钥文件。全表最多一台“默认主机”，设了它调用才可省略别名。会话授权：session 每个会话第一次使用时问一次，trusted 从不询问（用于无人值守）。审批超时：留空 = 120000 毫秒，0 = 一直等待。口令字段填的是环境变量名，不是口令本身。",
			// 主机表（lib/client.js HostsEditor）的控件、行内提示与 approval 下拉的两个值。
			// 上方 hosts.hint 仍是主机注册表的一段式说明。
			"hosts.add": "添加主机",
			"hosts.remove": "移除主机",
			"hosts.test": "测试连接",
			"hosts.testing": "测试中…",
			"hosts.save": "保存主机",
			"hosts.expand": "展开",
			"hosts.collapse": "收起",
			"hosts.untitled": "（未命名主机）",
			"hosts.errorCount": "{value} 个问题",
			"hosts.addBlocked": "请先修正当前主机的高亮字段。",
			"hosts.testOk": "连接成功（指纹 {value}）。",
			"hosts.testOkPlain": "连接成功。",
			"hosts.testFailed": "连接测试失败：{value}",
			"hosts.testNeedsFix": "请先修正该主机的高亮字段再测试。",
			"hosts.testWarning": "主机密钥提示：{value}",
			"hosts.invalidField": "该字段无效。",
			"hosts.row": "主机 {value}",
			"hosts.invalidLegacy": "已保存的草稿不再是主机表。请在下方重新填写主机（或重置该字段）后再保存。",
			"hosts.invalidSummary": "此表暂时无法保存：请修正高亮字段（无效主机会导致该工具不可用）。",
			"hosts.empty": "还没有主机。添加一台后本工具才可用。",
			"hosts.required": "{value}为必填。",
			"hosts.aliasInvalid": "别名以字母或数字开头，只能包含字母、数字、点、下划线和短横线。",
			"hosts.aliasDuplicate": "该别名已被另一台主机使用。",
			"hosts.hostInvalid": "主机名或 IP 地址不能含空格。",
			"hosts.portInvalid": "端口是 1 到 65535 的整数；留空表示 22。",
			"hosts.defaultDuplicate": "只能有一台默认主机。",
			"hosts.timeoutInvalid": "连接超时是正的整数毫秒；留空表示 30000。",
			"hosts.approvalTimeoutInvalid": "审批超时为 0（一直等待）或 1000–3600000 的整数毫秒；留空表示 120000。",
			"hosts.field.alias": "别名",
			"hosts.field.host": "主机",
			"hosts.field.port": "端口",
			"hosts.field.user": "用户",
			"hosts.field.keyPath": "密钥文件",
			"hosts.field.passphraseEnv": "口令环境变量",
			"hosts.field.startupCommand": "启动命令",
			"hosts.field.shellTemplate": "Shell 模板",
			"hosts.field.connectTimeoutMs": "连接超时（毫秒）",
			"hosts.field.approvalTimeoutMs": "审批超时（毫秒）",
			"hosts.field.approval": "会话授权",
			"hosts.field.acceptNewHostKeys": "接受新主机密钥",
			"hosts.field.default": "默认主机",
			"hosts.field.description": "描述",
  "hosts.flow": "“测试”使用当前未保存的值（校验主机密钥并做密钥认证，不执行命令）；改动需点保存才写入。",
  "hosts.clear": "清空主机表",
  "hosts.clearConfirm": "确认清空",
  "hosts.defaultBadge": "默认",
  "hosts.advancedShow": "高级设置",
  "hosts.advancedHide": "收起高级设置",
  "hosts.clearHint": "将清空整张主机表；点保存后才会写入。",
  "cancel": "取消",
  "defaultHint": "留空 = {value}。",
  "group.session": "会话",
  "group.output": "输出与等待",
  "group.backends": "各后端启动程序",
  "group.ssh": "SSH 会话",
  "requireSandboxRemote.label": "只允许 danger-full-access 运行",
  "requireSandboxRemote.hint": "远端命令不受本地沙箱约束；开启后除 danger-full-access 外一律拒绝。",
  "sandboxBwrap.hint": "auto 探测并如实降级；none 从不限制；bwrap（仅 WSL）拒绝无沙箱运行。",
  "sandboxNoBwrap.hint": "auto 探测并如实降级；none 从不限制。",
  "hosts.field.alias.hint": "调用时用它选主机；字母或数字开头，可含 . _ -",
  "hosts.field.host.hint": "远端机器的主机名或 IP。",
  "hosts.field.port.hint": "TCP 端口；留空 = 22。",
  "hosts.field.user.hint": "远端主机的登录用户。",
  "hosts.field.keyPath.hint": "私钥路径，支持 ~；只在本机读取，不会上传。",
  "hosts.field.passphraseEnv.hint": "保存口令的环境变量名，不是口令本身；只在本机读取，不保存。",
  "hosts.field.startupCommand.hint": "每次调用都会先执行这段；空格与换行原样保留，允许写多行。它以非零退出时该次调用失败。",
  "hosts.field.shellTemplate.hint": "该通道的命令行；空格与换行原样保留。脚本本身经 base64 从 stdin 传入；留空使用 bash -c 'eval \"$(base64 -d)\"'。",
  "hosts.field.connectTimeoutMs.hint": "连接与认证上限；留空 = 30000 毫秒。",
  "hosts.field.approvalTimeoutMs.hint": "审批等待上限；留空 = 120000 毫秒；0 = 一直等待。",
  "hosts.field.approval.hint": "session：每个会话第一次使用时问一次。trusted：从不询问，用于无人值守。",
  "hosts.field.acceptNewHostKeys.hint": "只接受 known_hosts 里没有的密钥一次，且从不写入该文件；不能绕过已变更或被吊销的密钥。",
  "hosts.field.default.hint": "全表最多一台；设了才能在调用里省略别名。",
  "hosts.field.description.hint": "仅显示，不影响行为。",
  "gitBash.bashPath.label": "Git Bash 可执行文件",
  "gitBash.bashPath.hint": "留空时依次探测：PATH 中形如 cmd/bin 且带真实 git.exe 的 Git 根；Program Files 与 Program Files (x86) 布局；各固定盘的 Program Files；最后是每个 PATH 项。只使用真实文件，绝不使用 WSL 启动器。",
  "wslBash.wslPath.label": "WSL 启动器（wsl.exe）",
  "wslBash.wslPath.hint": "留空时使用 Windows 标准位置的 wsl.exe（随后查 PATH）。要选发行版请用下一项。",
  "wslBash.wslDistro.label": "WSL 发行版",
  "wslBash.wslDistro.hint": "发行版名称；留空使用 WSL 列出的第一个（不一定是默认发行版）——要确保选对就写在这里。",
  "msys2Bash.bashPath.label": "MSYS2 bash 可执行文件",
  "msys2Bash.bashPath.hint": "留空时探测 MSYS2 UCRT64（随后查 PATH）。",
  "sshShell.sshPath.label": "ssh 可执行文件",
  "sshShell.sshPath.hint": "终端行用来打开交互会话的 OpenSSH 客户端；留空时探测 Windows OpenSSH 功能，再查 PATH。",
  "sshShell.sshHost.label": "SSH 会话主机",
  "sshShell.sshHost.hint": "交互式会话连接的主机。留空会拒绝打开会话。终端行使用 ssh.exe，不读取命令行的主机表。",
  "sshShell.sshUser.label": "SSH 会话用户",
  "sshShell.sshUser.hint": "可选登录名。留空由 ssh 决定（先看客户端配置，再用本机用户名）。",
  "sshShell.sshPort.label": "SSH 会话端口",
  "sshShell.sshPort.hint": "可选 TCP 端口。留空 = 22（或客户端配置）。",
  "sshShell.acceptNewHostKeys.label": "接受未知主机密钥（会话）",
  "sshShell.acceptNewHostKeys.hint": "通过 ssh.exe 的 accept-new：未知主机的首个密钥写入 known_hosts。已变更或被吊销的密钥仍拒绝。",
  "sshShell.connectTimeoutMs.label": "SSH 会话连接超时（毫秒）",
  "sshShell.connectTimeoutMs.hint": "握手上限，按整秒发送（最小 1）；不限制会话本身。留空 = 15000 毫秒。",
			"hosts.approval.session": "session（每个会话询问一次）",
			"hosts.approval.trusted": "trusted（从不询问）",
			"sshHost.label": "远端主机",
			"sshHost.hint": "交互式会话连接的主机。留空会拒绝打开会话。终端行使用 ssh.exe，不读取命令行的主机表。",
			"sshUser.label": "远端用户",
			"sshUser.hint": "可选登录名。留空由 ssh 决定（先看客户端配置，再用本机用户名）。",
			"sshPort.label": "远端端口",
			"sshPort.hint": "可选 TCP 端口。留空 = 22（或客户端配置）。",
			"acceptNewHostKeys.label": "接受未知主机密钥（首次即信任）",
			"acceptNewHostKeys.hint": "通过 ssh.exe 的 accept-new：未知主机的首个密钥写入 known_hosts。已变更或被吊销的密钥仍拒绝。",
			"connectTimeoutMs.label": "连接超时（毫秒）",
			"connectTimeoutMs.hint": "握手与认证的总上限，按整秒发送（最小 1）；不限制会话本身。留空 = 15000 毫秒。",
			"sandbox.label": "沙箱立场",
			"sandbox.hint": "auto 探测并如实降级；none 从不限制；bwrap（仅 WSL）拒绝无沙箱运行。",
			"probeTimeoutMs.label": "沙箱探测超时（毫秒）",
			"probeTimeoutMs.hint": "探测限制能力最多耗时多久，超时按失败处理。",
			"requireSandbox.label": "无法应用沙箱时拒绝运行",
			"requireSandbox.hint": "本地：限制探测失败时 read-only / workspace-write 直接拒绝而非降级。danger-full-access 仍放行。",
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
		const field = (path, kind, options, extra) => ({ key: path.join("."), path, kind, options, ...extra });
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
					field(["promoteOnTimeout"], "boolean"),
					field(["gitBash", "cwd"], "text"),
					field(["gitBash", "timeoutMs"], "number", undefined, {"defaultValue":120000}),
					field(["gitBash", "maxTimeoutMs"], "number", undefined, {"defaultValue":600000}),
					field(["gitBash", "maxOutputBytes"], "number", undefined, {"defaultValue":64000}),
					field(["gitBash", "maxSpillBytes"], "number", undefined, {"defaultValue":67108864}),
					field(["gitBash", "graceMs"], "number", undefined, {"defaultValue":3000}),
					field(["gitBash", "bashPath"], "text"),
					field(["gitBash", "sandbox"], "enum", ["auto", "none"], {"hintKey":"sandboxNoBwrap"}),
					field(["gitBash", "probeTimeoutMs"], "number", undefined, {"defaultValue":4000}),
					field(["gitBash", "requireSandbox"], "boolean"),
					field(["gitBash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-wsl",
				label: { en: "WSL Bash", zh: "WSL Bash" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
					field(["promoteOnTimeout"], "boolean"),
					field(["wslBash", "cwd"], "text"),
					field(["wslBash", "timeoutMs"], "number", undefined, {"defaultValue":120000}),
					field(["wslBash", "maxTimeoutMs"], "number", undefined, {"defaultValue":600000}),
					field(["wslBash", "maxOutputBytes"], "number", undefined, {"defaultValue":64000}),
					field(["wslBash", "maxSpillBytes"], "number", undefined, {"defaultValue":67108864}),
					field(["wslBash", "graceMs"], "number", undefined, {"defaultValue":3000}),
					field(["wslBash", "wslPath"], "text"),
					field(["wslBash", "wslDistro"], "text"),
					field(["wslBash", "sandbox"], "enum", ["auto", "none", "bwrap"], {"hintKey":"sandboxBwrap"}),
					field(["wslBash", "probeTimeoutMs"], "number", undefined, {"defaultValue":8000}),
					field(["wslBash", "requireSandbox"], "boolean"),
					field(["wslBash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-msys2",
				label: { en: "MSYS2 Bash", zh: "MSYS2 Bash" },
				fields: [
					field(["enableRunInBackground"], "boolean"),
					field(["promoteOnTimeout"], "boolean"),
					field(["msys2Bash", "cwd"], "text"),
					field(["msys2Bash", "timeoutMs"], "number", undefined, {"defaultValue":120000}),
					field(["msys2Bash", "maxTimeoutMs"], "number", undefined, {"defaultValue":600000}),
					field(["msys2Bash", "maxOutputBytes"], "number", undefined, {"defaultValue":64000}),
					field(["msys2Bash", "maxSpillBytes"], "number", undefined, {"defaultValue":67108864}),
					field(["msys2Bash", "graceMs"], "number", undefined, {"defaultValue":3000}),
					field(["msys2Bash", "bashPath"], "text"),
					field(["msys2Bash", "sandbox"], "enum", ["auto", "none"], {"hintKey":"sandboxNoBwrap"}),
					field(["msys2Bash", "probeTimeoutMs"], "number", undefined, {"defaultValue":4000}),
					field(["msys2Bash", "requireSandbox"], "boolean"),
					field(["msys2Bash", "sandboxNotice"], "enum", ["once", "always"]),
				],
			},
			{
				rowId: "win-mb-tool-ssh",
				label: { en: "SSH remote shell", zh: "SSH 远端 Shell" },
				fields: [
					field(["sshShell", "hosts"], "hosts"),
					field(["sshShell", "requireSandbox"], "boolean", undefined, {"copyKey":"requireSandboxRemote"}),
					field(["enableRunInBackground"], "boolean"),
					field(["promoteOnTimeout"], "boolean"),
					field(["sshShell", "cwd"], "text"),
					field(["sshShell", "timeoutMs"], "number", undefined, {"defaultValue":120000}),
					field(["sshShell", "maxTimeoutMs"], "number", undefined, {"defaultValue":600000}),
					field(["sshShell", "maxOutputBytes"], "number", undefined, {"defaultValue":64000}),
					field(["sshShell", "maxSpillBytes"], "number", undefined, {"defaultValue":67108864}),
					field(["sshShell", "graceMs"], "number", undefined, {"defaultValue":3000}),
				],
			},
			{
				rowId: "win-mb-tool-terminal",
				label: { en: "Interactive terminal", zh: "交互式终端" },
				fields: [
					field(["terminal", "defaultShell"], "enum", ["git_bash", "wsl_bash", "msys2_bash", "ssh_shell"], {"group":"session"}),
					field(["terminal", "maxSessions"], "number", undefined, {"group":"session","defaultValue":8}),
					field(["terminal", "maxSessionsTotal"], "number", undefined, {"group":"session","defaultValue":32}),
					field(["terminal", "idleMs"], "number", undefined, {"group":"session","defaultValue":600000}),
					field(["terminal", "quietNoticeMs"], "number", undefined, {"group":"session","defaultValue":60000}),
					field(["terminal", "allowUnconfined"], "boolean", undefined, {"group":"session"}),
					field(["terminal", "rows"], "number", undefined, {"group":"output","defaultValue":30}),
					field(["terminal", "cols"], "number", undefined, {"group":"output","defaultValue":110}),
					field(["terminal", "maxBufferBytes"], "number", undefined, {"group":"output","defaultValue":1048576}),
					field(["terminal", "waitMs"], "number", undefined, {"group":"output","defaultValue":10000}),
					field(["terminal", "quietMs"], "number", undefined, {"group":"output","defaultValue":500}),
					field(["terminal", "maxWaitMs"], "number", undefined, {"group":"output","defaultValue":120000}),
					field(["gitBash", "bashPath"], "text", undefined, {"group":"backends"}),
					field(["wslBash", "wslPath"], "text", undefined, {"group":"backends"}),
					field(["wslBash", "wslDistro"], "text", undefined, {"group":"backends"}),
					field(["msys2Bash", "bashPath"], "text", undefined, {"group":"backends"}),
					field(["sshShell", "sshPath"], "text", undefined, {"group":"ssh"}),
					field(["sshShell", "sshHost"], "text", undefined, {"group":"ssh"}),
					field(["sshShell", "sshUser"], "text", undefined, {"group":"ssh"}),
					field(["sshShell", "sshPort"], "number", undefined, {"group":"ssh"}),
					field(["sshShell", "acceptNewHostKeys"], "boolean", undefined, {"group":"ssh"}),
					field(["sshShell", "connectTimeoutMs"], "number", undefined, {"group":"ssh"}),
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
		/**
		 * The tools whose host authorization uses this bundle's own approval card
		 * (the remote dialect's tool plus the extra tools its row serves), from the
		 * registry. A rename reddens here instead of silently falling back to the
		 * platform card.
		 */
		const APPROVAL_GATED_TOOL_NAMES = ["ssh_shell", "ssh_scp"];
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
			// The host registry is an ARRAY of objects. The table stages the array
			// itself; a JSON string is still accepted for a deployment that saved a
			// draft before the table existed (and for the form's own clear path). A
			// draft that is neither an array nor parseable JSON plans no write: saving
			// it would store a string in a field the Host validates as an array.
			if (kind === "hosts") {
				// Editor rows carry a row id for stable React identity; it is NOT part of
				// the registry, so the write value drops it here (one place, so the plan,
				// the comparison and the save all see the same clean objects).
				if (Array.isArray(draft))
					return draft.map((entry) => {
						if (entry === null || typeof entry !== "object") return entry;
						const { __rowId, ...host } = entry;
						return host;
					});
				const raw = typeof draft === "string" ? draft : "";
				try {
					const value = JSON.parse(raw);
					return Array.isArray(value) ? value : undefined;
				} catch {
					return undefined;
				}
			}
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
			// A registry shown as the TABLE carries per-row warnings inline (see
			// hostRowErrors); only a legacy JSON-string draft is checked here, and that
			// warning is display-only - the save refuses to plan that write.
			if (knob.kind === "hosts") {
				try {
					return Array.isArray(JSON.parse(trimmed)) ? undefined : "hosts";
				} catch {
					return "hosts";
				}
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
			// A structured value is compared structurally: two saves of the same array
			// are one edit, even though the objects differ by identity.
			if (kind === "hosts") return JSON.stringify(current ?? []) === JSON.stringify(next ?? []);
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
			// The hosts table is the one field whose warnings BLOCK a write: a host with
			// a missing alias, a bad port or a duplicate alias is a row the Host refuses
			// to use, so saving it would persist a table that cannot work. The check reads
			// the coerced VALUE, so a legacy JSON draft obeys the same rule.
			if (knob.kind === "hosts") {
				if (hostsValueProblem(value) !== undefined) return undefined;
				if (hostRowErrors(hostRowsFrom(value)).some((errors) => Object.keys(errors).length > 0)) return undefined;
			}
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
				field(["tempWatchMs"], "number", undefined, { defaultValue: 10000 }),
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
					// A DRAFT is already the text the user typed: re-encoding it would show a
					// quoted JSON string and escape every keystroke on the next render (the
					// control is controlled). Only a STORED array is rendered as JSON.
					const text = shown === undefined || shown === null
						? ""
						: knob.kind === "hosts" && typeof shown !== "string"
							? JSON.stringify(shown, null, 2)
							: String(shown);
					// The host registry renders as a TABLE of rows; the text above stays the
					// JSON form only for the legacy draft path and the plan comparison.
					const rows = knob.kind === "hosts" ? hostRowsFrom(shown) : undefined;
					// The hosts table is invalid when ANY row is: a warning here is not only
					// cosmetic, it blocks the write (plannedOp refuses the same rows). A
					// legacy JSON-string draft that does not parse keeps its old warning.
					const hostsInvalid = rows !== undefined && hostRowErrors(rows).some((errors) => Object.keys(errors).length > 0);
					let fieldReason;
					if (knob.kind === "hosts") {
						const legacy = typeof shown === "string" ? invalidReason(knob, text) : undefined;
						// The value may also be structurally unusable (a null/primitive entry in a
						// legacy or hand-edited array): the table then has no row to highlight, so
						// the field warning must carry it.
						let list = shown;
						if (typeof list === "string") {
							try {
								list = JSON.parse(list);
							}
							catch {
								list = undefined;
							}
						}
						// An UNSET field is a valid empty inventory (the row is simply absent); a
						// present value must be a host array.
						fieldReason = legacy ?? (shown === undefined
							? undefined
							: hostsValueProblem(Array.isArray(list) ? list : undefined) !== undefined || hostsInvalid ? "hosts" : undefined);
					}
					else fieldReason = invalidReason(knob, text);
					// The badge answers for the write, not for the draft: a draft that
					// changes nothing leaves the user layer exactly as it already is.
					const op = plannedOp(knob, staged, snapshot);
					return {
						key: knob.key,
						kind: knob.kind,
						path: knob.path,
						options: knob.options,
						group: knob.group,
						defaultValue: knob.defaultValue,
						text,
						rows,
						rowErrors: rows === undefined ? undefined : hostRowErrors(rows),
						value: shown,
						checked: shown === true,
						overridden: op === undefined ? has(snapshot.user, knob.path) : op.op === "set",
						// Display only (A3): the warning shown for a value this backend's
						// own rules cannot use. It never gates the write — see `project`'s
						// `invalid` below.
						invalid: fieldReason !== undefined,
						invalidReason: fieldReason,
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
					dirty: plan.length > 0 || fields.some((entry) => entry.invalid && (entry.kind === "number" || entry.kind === "hosts")),
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
				// The hosts table stages the ARRAY of host objects; an empty table is an
				// explicit empty inventory, not a clear (clearing the field is resetField,
				// or the legacy blank-string draft below).
				if (knob.kind === "hosts" && Array.isArray(draft)) {
					this.stage(key, { op: "set", draft });
					return;
				}
				// Trim decides emptiness too: whitespace-only is a clear, exactly like
				// an empty box, and never an error (A3).
				const empty = (knob.kind === "text" || knob.kind === "number" || knob.kind === "hosts") && String(draft).trim().length === 0;
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

		//#region host registry editor (the sshShell.hosts table)
		/**
		 * The fields one host card edits, in the order ssh-shell/hosts.js declares them.
		 * `kind` decides the control; `leaf` is both the object key and the dictionary
		 * suffix (`hosts.field.<leaf>`).
		 */
		const HOST_FIELDS = [
			// The five fields needed to reach a host stay visible; the rest sit behind
			// 高级设置 so the card is not a fourteen-input wall.
			{ leaf: "alias" },
			{ leaf: "host" },
			{ leaf: "port", numeric: true },
			{ leaf: "user" },
			{ leaf: "keyPath" },
			{ leaf: "passphraseEnv", advanced: true },
			{ leaf: "startupCommand", advanced: true, textarea: true, code: true },
			{ leaf: "shellTemplate", advanced: true, textarea: true, code: true },
			{ leaf: "connectTimeoutMs", numeric: true, advanced: true },
			{ leaf: "approvalTimeoutMs", numeric: true, advanced: true },
			{ leaf: "approval", kind: "select", advanced: true },
			{ leaf: "acceptNewHostKeys", kind: "checkbox", advanced: true },
			{ leaf: "default", kind: "radio" },
			{ leaf: "description", textarea: true, advanced: true },
		];
		/** The alias grammar the Host validates with, mirrored so the card can warn before a save. */
		/** The Host default for `shellTemplate` (shown as the empty textarea's placeholder). */
		const DEFAULT_SHELL_TEMPLATE = `bash -c 'eval "$(base64 -d)"'`;
		const HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
		/** Monotonic id source for editor rows; never saved (coerce drops `__rowId`). */
		let nextHostRowId = 0;
		/** One editable row: text controls hold strings, flags booleans, approval a select value. */
		function blankHostRow() {
			const row = { __rowId: `host-${++nextHostRowId}` };
			for (const field of HOST_FIELDS) row[field.leaf] = field.kind === "checkbox" || field.kind === "radio" ? false : field.kind === "select" ? "session" : "";
			return row;
		}
		/**
		 * The value a sshShell.hosts field shows, as editor rows.
		 *
		 * A stored value is an array of host objects; a legacy JSON TEXT draft (from the
		 * pre-table form) parses the same way, so an in-flight draft is not lost. The
		 * editor only ever emits objects, which is what the Host validates.
		 * @param value - the field's shown value (array, JSON string, or undefined).
		 * @returns one row per host, in registry order.
		 */
		function hostRowsFrom(value) {
			let list = value;
			if (typeof list === "string") {
				try {
					list = JSON.parse(list);
				}
				catch {
					list = [];
				}
			}
			if (!Array.isArray(list)) return [];
			const text = (entry, leaf) => (typeof entry[leaf] === "string" ? entry[leaf] : "");
			// A row keeps the id it was staged with; a STORED host (which never carries one)
			// gets an index-based id, stable while the stored order is.
			return list.filter((entry) => entry !== null && typeof entry === "object").map((entry, index) => ({
				__rowId: typeof entry.__rowId === "string" && entry.__rowId !== "" ? entry.__rowId : `stored-${index}`,
				alias: text(entry, "alias"),
				host: text(entry, "host"),
				port: entry.port === undefined || entry.port === null ? "" : String(entry.port),
				user: text(entry, "user"),
				keyPath: text(entry, "keyPath"),
				passphraseEnv: text(entry, "passphraseEnv"),
				startupCommand: text(entry, "startupCommand"),
				shellTemplate: text(entry, "shellTemplate"),
				connectTimeoutMs: entry.connectTimeoutMs === undefined || entry.connectTimeoutMs === null ? "" : String(entry.connectTimeoutMs),
				approvalTimeoutMs: entry.approvalTimeoutMs === undefined || entry.approvalTimeoutMs === null ? "" : String(entry.approvalTimeoutMs),
				approval: entry.approval === "trusted" ? "trusted" : "session",
				acceptNewHostKeys: entry.acceptNewHostKeys === true,
				default: entry.default === true,
				description: text(entry, "description"),
			}));
		}
		/**
		 * One row as the host object a save writes.
		 *
		 * Blank strings are DROPPED (the field is cleared, not stored as ""), numbers
		 * become numbers, and a numeric spelling that is not a number is kept as typed
		 * so the inline warning is about what the user actually wrote — the Host then
		 * reports the invalid entry by alias, never silently "repairs" it.
		 * @param row - one editor row.
		 * @returns the host object.
		 */
		// These leaves carry user-authored text (shell snippets, the description): a
		// space or newline is content, not padding. Trimming them on every keystroke
		// ate the space that was just typed, because the editor rebuilds its rows from
		// the staged object on the next render.
		const VERBATIM_HOST_LEAVES = new Set(["startupCommand", "shellTemplate", "description"]);
		function hostObjectFromRow(row) {
			const object = {};
			for (const field of HOST_FIELDS) {
				if (field.kind === "checkbox" || field.kind === "radio") continue;
				if (field.kind === "select") {
					object[field.leaf] = row[field.leaf] === "trusted" ? "trusted" : "session";
					continue;
				}
				const raw = typeof row[field.leaf] === "string" ? row[field.leaf] : "";
				// Verbatim leaves keep their leading/trailing whitespace; only an empty
				// (whitespace-only) value drops the field.
				const text = VERBATIM_HOST_LEAVES.has(field.leaf) ? raw : raw.trim();
				if (text.trim() === "") continue;
				object[field.leaf] = field.numeric && /^\d+$/.test(text.trim()) ? Number(text.trim()) : text;
			}
			if (row.acceptNewHostKeys === true) object.acceptNewHostKeys = true;
			if (row.default === true) object.default = true;
			return object;
		}
		/** The array a save carries: one object per row, blanks cleared, flags only when set. */
		function hostObjectsFrom(rows) {
			return (Array.isArray(rows) ? rows : []).map(hostObjectFromRow);
		}
		/**
		 * The array the TABLE stages: clean host objects plus the editor row id.
		 *
		 * The id keeps React identity stable across add/remove/edit (a key derived from
		 * the index would move focus and IME state to a different row when a row above
		 * it disappears). `coerce` strips it, so it is never saved.
		 * @param rows - editor rows.
		 * @returns the staged draft.
		 */
		function hostDraftFrom(rows) {
			return (Array.isArray(rows) ? rows : []).map((row) => ({
				...hostObjectFromRow(row),
				__rowId: typeof row.__rowId === "string" && row.__rowId !== "" ? row.__rowId : `host-${++nextHostRowId}`,
			}));
		}
		/**
		 * The inline warnings per row, keyed by field.
		 *
		 * These mirror ssh-shell/hosts.js: an alias is required, unique and
		 * grammar-shaped; host/user/keyPath are required; the port is 1..65535; the
		 * connect timeout is a positive whole number. Every row defaults to one
		 * DEFAULT-eligible radio, so exclusivity is decided by setDefault, not here.
		 * @param rows - the editor rows.
		 * @returns one error map per row (`{}` when the row is complete).
		 */
		function hostRowErrors(rows) {
			const list = Array.isArray(rows) ? rows : [];
			const counts = new Map();
			const defaults = list.filter((row) => row.default === true).length;
			const aliasOf = (row) => (typeof row.alias === "string" ? row.alias.trim() : "");
			for (const row of list) {
				const alias = aliasOf(row);
				if (alias !== "") counts.set(alias, (counts.get(alias) ?? 0) + 1);
			}
			return list.map((row) => {
				const errors = {};
				const text = (leaf) => (typeof row[leaf] === "string" ? row[leaf].trim() : "");
				const alias = aliasOf(row);
				if (alias === "") errors.alias = "required";
				else if (!HOST_ALIAS_PATTERN.test(alias)) errors.alias = "aliasFormat";
				else if ((counts.get(alias) ?? 0) > 1) errors.alias = "aliasDuplicate";
				const host = text("host");
				if (host === "") errors.host = "required";
				else if (/\s/.test(host)) errors.host = "hostFormat";
				if (text("user") === "") errors.user = "required";
				if (text("keyPath") === "") errors.keyPath = "required";
				const port = text("port");
				if (port !== "" && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) errors.port = "portRange";
				const timeout = text("connectTimeoutMs");
				if (timeout !== "" && (!/^\d+$/.test(timeout) || Number(timeout) <= 0)) errors.connectTimeoutMs = "timeoutRange";
				const approvalTimeout = text("approvalTimeoutMs");
				if (approvalTimeout !== "") {
					const value = Number(approvalTimeout);
					if (!/^\d+$/.test(approvalTimeout) || (value !== 0 && (value < 1000 || value > 3600000))) errors.approvalTimeoutMs = "approvalTimeoutRange";
				}
				// At most one host may be the default (spec §6). The radio enforces this while
				// editing, but a stored or hand-edited array can carry two, so the table reports
				// it like any other invalid row and the save is blocked.
				if (defaults > 1) errors.default = "defaultDuplicate";
				return errors;
			});
		}
		/**
		 * Whether a hosts VALUE is structurally usable: an array whose entries are
		 * plain objects. A null or a primitive entry would render an empty/partial
		 * row and then be saved, so it is refused before the write (and reported as
		 * the field's own warning).
		 * @param value - the coerced hosts value.
		 * @returns 'hosts' when unusable, undefined when every entry is an object.
		 */
		function hostsValueProblem(value) {
			if (!Array.isArray(value)) return "hosts";
			if (value.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) return "hosts";
			return undefined;
		}
		/** The localized sentence for one row warning. */
		function hostErrorText(t, code, leaf) {
			if (code === "required") return withValue(t("hosts.required"), t(`hosts.field.${leaf}`));
			if (code === "aliasFormat") return t("hosts.aliasInvalid");
			if (code === "aliasDuplicate") return t("hosts.aliasDuplicate");
			if (code === "hostFormat") return t("hosts.hostInvalid");
			if (code === "portRange") return t("hosts.portInvalid");
			if (code === "timeoutRange") return t("hosts.timeoutInvalid");
			if (code === "approvalTimeoutRange") return t("hosts.approvalTimeoutInvalid");
			if (code === "defaultDuplicate") return t("hosts.defaultDuplicate");
			// Never return a bare template: a future code without a sentence must not
			// render `{value}` literally (the bug this table already had once).
			return t("hosts.invalidField");
		}
		/**
		 * One host test over the plugin's `/win-mb/hosts.test` endpoint.
		 *
		 * Plain fetch, no legacy RPC: the endpoint only exists on a host that also
		 * serves the rest of this route. The result is a VALUE so the button can show
		 * either answer, and a non-2xx envelope still contributes its message.
		 * @param row - the editor row, staged as the saved host object.
		 * @param fetchImpl - the deployment's fetch (injected so a test never dials).
		 * @returns `{ ok: true, fingerprint? }` or `{ ok: false, message }`.
		 */
		async function testHostConnection(row, fetchImpl = fetch) {
			const response = await fetchImpl("/win-mb/hosts.test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ host: hostObjectFromRow(row) }),
			});
			let body;
			let unparsed = false;
			try {
				body = await response.json();
			}
			catch {
				body = undefined;
				unparsed = true;
			}
			if (!response.ok) {
				const message = typeof body?.error?.message === "string" && body.error.message !== "" ? body.error.message : response.status === 404 ? "the hosts test endpoint is not registered on this host (is the terminal row disabled?)" : `HTTP ${response.status}`;
				return { ok: false, message };
			}
			// A 200 that is not our JSON is an SPA fallback for a route this host never
			// registered — the same cause as a 404, so it gets the same sentence.
			if (unparsed === true)
				return { ok: false, message: "the hosts test endpoint is not registered on this host (is the terminal row disabled?)" };
			if (body?.ok === true)
				return {
					ok: true,
					fingerprint: typeof body.value?.fingerprint === "string" ? body.value.fingerprint : undefined,
					warning: typeof body.value?.warning === "string" && body.value.warning !== "" ? body.value.warning : undefined,
				};
			const message = typeof body?.error?.message === "string" && body.error.message !== "" ? body.error.message : "the host test failed without a message";
			return { ok: false, message };
		}
		/**
		 * Record the approval scope (`once` | `session`) for one tool call before the
		 * card answers. The gate consumes it: `session` may be cached, everything else
		 * (including an unmarked call) is granted for this call only.
		 *
		 * A failure here throws and the caller must NOT answer the approval — otherwise
		 * the gate would treat an explicitly chosen session grant as a one-shot (or cache
		 * an explicitly one-shot grant, under the old bug).
		 * @param callId - the platform tool-call id (`pending.callId`).
		 * @param scope - 'once' or 'session'.
		 * @param fetchImpl - the deployment's fetch (injected so tests never post).
		 * @returns the mark acknowledgement.
		 */
		async function markHostApprovalScope(callId, scope, fetchImpl = fetch) {
			const response = await fetchImpl("/win-mb/hosts.approvalScope", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ callId, scope }),
			});
			let body;
			try {
				body = await response.json();
			}
			catch {
				body = undefined;
			}
			if (response.ok === true && body?.ok === true) return;
			const message = typeof body?.error?.message === "string" && body.error.message !== "" ? body.error.message : `the one-shot mark failed with HTTP ${response.status}`;
			throw new Error(message);
		}
		/**
		 * Best-effort removal of a scope mark whose answer failed, so a stale once/session
		 * mark cannot be consumed by a later, different answer. Failures are ignored: the
		 * card has already shown the primary failure and must not double-report.
		 * @param callId - the platform tool-call id.
		 * @param fetchImpl - the deployment's fetch (injected so tests never post).
		 */
		async function clearHostApprovalScope(callId, fetchImpl = fetch) {
			const response = await fetchImpl("/win-mb/hosts.approvalScope", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ callId, scope: "clear" }),
			});
			if (response.ok !== true) throw new Error(`the scope clear failed with HTTP ${response.status}`);
			// The route's own envelope, not the SPA fallback: a 200 HTML page must not read
			// as a successful clear.
			let body;
			try {
				body = await response.json();
			}
			catch {
				throw new Error("the scope clear returned a non-JSON body");
			}
			if (body?.ok !== true) throw new Error("the scope clear was refused");
		}
		/**
		 * The hosts table: one card per host, every registry field, `default` an exclusive
		 * radio (the Host allows at most one) and `approval` a select. Every edit is
		 * pushed up as the ARRAY of host objects, so the form's plan/dirty/save path is
		 * the same one every other control uses. No navigation, no JSON text.
		 * @param props - slot props plus this card's `knob` and edit actions.
		 */
		function HostsEditor(props) {
			const { knob, disabled, t, edit, resetField } = props;
			// The in-table Save is the form's own action; a seat without one (a test, a
			// partial settings API) still renders, with the button disabled.
			const save = typeof props.save === "function" ? props.save : undefined;
			// The probe call is injectable so a delayed answer can be exercised without a network.
			const probeRow = typeof props.testHost === "function" ? props.testHost : testHostConnection;
			// One counter per EDITOR, not per module: a late probe from this instance must not
			// leak into another table, and Reset counts as an edit.
			const generation = React.useRef(0);
			const rows = Array.isArray(knob.rows) ? knob.rows : [];
			const errors = Array.isArray(knob.rowErrors) ? knob.rowErrors : [];
			// Per-row test state, keyed by the stable row id: a test result belongs to one
			// host, not to a position that add/remove can shift.
			const [tests, setTests] = React.useState({});
			// Advanced fields are collapsed per row by default and remembered by stable
			// row id for as long as the page is open.
			const [advancedRows, setAdvancedRows] = React.useState(props.advancedRows !== null && typeof props.advancedRows === "object" ? { ...props.advancedRows } : {});
			// Collapse overrides by the same stable id. A row whose alias is empty starts
			// OPEN (a new row must be fillable); a named row starts closed. The optional
			// `expandedRows` prop is a controlled initial map (the audit uses it to render
			// a named row open); production passes nothing.
			const [expandedRows, setExpandedRows] = React.useState(props.expandedRows ?? {});
			// Clearing the registry is destructive and staged: the first click arms,
			// the second performs it.
			const [confirmClear, setConfirmClear] = React.useState(false);
			// The form stores the ARRAY OF HOST OBJECTS, so every keystroke stages the
			// object form: blanks are dropped, numbers become numbers, flags only when
			// set. The editor rows are rebuilt from that value on the next render, so
			// what the user sees and what a save carries cannot drift apart.
			const change = (next) => {
				if (disabled === true) return;
				// Any edit can change what a previous test measured, so no stale result stays
				// and an answer still in flight can never be applied.
				generation.current += 1;
				setTests({});
				edit(knob.key, hostDraftFrom(next));
			};
			const reset = () => {
				if (disabled === true) return;
				// A reset is an edit for test purposes: a probe started before it is stale.
				generation.current += 1;
				setTests({});
				resetField(knob.key);
			};
			const expandRow = (row, next) => setExpandedRows((previous) => ({ ...previous, [row.__rowId]: next }));
			const rowExpanded = (row) => {
				const explicit = expandedRows[row.__rowId];
				if (explicit !== undefined) return explicit;
				return (typeof row.alias === "string" ? row.alias.trim() : "") === "";
			};
			const replace = (index, patch) => {
				// Typing happens in an open row: keep it open even once its alias is non-empty.
				expandRow(rows[index], true);
				change(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
			};
			// The Host allows at most ONE default; marking a row clears every other row.
			const setDefault = (index) => change(rows.map((row, at) => ({ ...row, default: at === index })));
			/**
			 * Run one row's connection test and remember the answer against that row.
			 * @param index - the row's current position.
			 */
			const testOne = async (index) => {
				if (disabled === true) return;
				const row = rows[index];
				const key = row.__rowId;
				const started = generation.current;
				setTests((previous) => ({ ...previous, [key]: { status: "testing" } }));
				let result;
				try {
					result = await probeRow(row);
				}
				catch (error) {
					result = { ok: false, message: String(error?.message ?? error) };
				}
				// A probe that resolves after the row changed (or was removed) is stale.
				if (started !== generation.current) return;
				setTests((previous) => ({
					...previous,
					[key]: result.ok === true
						? { status: "ok", fingerprint: result.fingerprint, warning: result.warning }
						: { status: "failed", message: result.message },
				}));
			};
			const base = `win-mb-${knob.key.replace(/\./g, "-")}`;
			const rowId = (index) => `${base}-${index}`;
			const warning = (index, leaf) => {
				const code = errors[index]?.[leaf];
				if (code === undefined) return null;
				return h("span", { key: "error", className: "dshwmb-host-error", role: "alert" }, hostErrorText(t, code, leaf));
			};
			const control = (index, row, field) => {
				const id = `${rowId(index)}-${field.leaf}`;
				const label = t(`hosts.field.${field.leaf}`);
				const hintKey = `hosts.field.${field.leaf}.hint`;
				const hintText = t(hintKey);
				const hint = hintText === hintKey ? null : h("p", { className: "dshwmb-host-hint", title: hintText }, hintText);
				if (field.kind === "checkbox" || field.kind === "radio") {
					const isDefault = field.kind === "radio";
					return h("div", { key: field.leaf, className: "dshwmb-host-flag" },
						h("input", {
							id,
							type: isDefault ? "radio" : "checkbox",
							name: isDefault ? `${base}-default` : undefined,
							checked: isDefault ? row.default === true : row.acceptNewHostKeys === true,
							disabled,
							"data-row": index,
							"data-field": field.leaf,
							onChange: (event) => (isDefault ? setDefault(index) : replace(index, { [field.leaf]: event?.target?.checked === true })),
						}),
						h("label", { htmlFor: id }, label),
						hint,
						warning(index, field.leaf));
				}
				if (field.kind === "select")
					return h("div", { key: field.leaf, className: "dshwmb-host-field" },
						h("label", { htmlFor: id }, label),
						h("select", {
							id,
							value: row.approval === "trusted" ? "trusted" : "session",
							disabled,
							"data-row": index,
							"data-field": field.leaf,
							onChange: (event) => replace(index, { approval: event?.target?.value === "trusted" ? "trusted" : "session" }),
						},
							h("option", { key: "session", value: "session" }, t("hosts.approval.session")),
							h("option", { key: "trusted", value: "trusted" }, t("hosts.approval.trusted"))),
						hint,
						warning(index, field.leaf));
				const value = typeof row[field.leaf] === "string" ? row[field.leaf] : "";
				return h("div", { key: field.leaf, className: field.textarea === true ? "dshwmb-host-field dshwmb-host-field-wide" : "dshwmb-host-field" },
					h("label", { htmlFor: id }, label),
					field.textarea === true
						? h("textarea", {
							id,
							value,
							disabled,
							// Snippets may legitimately span multiple lines; grow with the
							// content up to a readable ceiling instead of hiding it.
							rows: field.code === true ? Math.min(6, Math.max(2, value.split("\n").length)) : 2,
							className: field.code === true ? "dshwmb-host-code" : undefined,
							placeholder: field.leaf === "shellTemplate" ? DEFAULT_SHELL_TEMPLATE : undefined,
							spellCheck: field.code === true ? false : undefined,
							"data-row": index,
							"data-field": field.leaf,
							onChange: (event) => replace(index, { [field.leaf]: event?.target?.value ?? "" }),
						})
						: h("input", {
							id,
							type: "text",
							inputMode: field.numeric === true ? "numeric" : undefined,
							value,
							disabled,
							"data-row": index,
							"data-field": field.leaf,
							onChange: (event) => replace(index, { [field.leaf]: event?.target?.value ?? "" }),
						}),
					hint,
					warning(index, field.leaf));
			};
			const tableInvalid = rows.some((_row, at) => Object.keys(errors[at] ?? {}).length > 0);
			return h("div", { className: "dshwmb-row dshwmb-hosts", "data-field": knob.key },
				h("div", { className: "dshwmb-host-head" },
					h("p", { className: "dshwmb-label" }, t("hosts.label")),
					knob.overridden === true
						? confirmClear === true
							? h("span", { className: "dshwmb-host-clear" },
								h("span", { className: "dshwmb-host-clear-hint" }, t("hosts.clearHint")),
								h(primitives.Button, { key: "confirm", variant: "outline", size: "sm", type: "button", disabled, onClick: () => { setConfirmClear(false); reset(); } }, t("hosts.clearConfirm")),
								h(primitives.Button, { key: "cancel", variant: "ghost", size: "sm", type: "button", disabled, onClick: () => setConfirmClear(false) }, t("cancel")))
							: h(primitives.Button, { key: "clear", variant: "ghost", size: "sm", type: "button", disabled, onClick: () => setConfirmClear(true) }, t("hosts.clear"))
						: null),
				h("p", { className: "dshwmb-host-intro" }, t("hosts.hint")),
				h("p", { className: "dshwmb-host-intro dshwmb-host-flow" }, t("hosts.flow")),
				// A legacy draft that no longer parses has no row to highlight, so the
				// table-level warning says what to do with it instead.
				knob.invalid === true
					? h("p", { className: "dshwmb-host-error", role: "alert" }, typeof knob.value === "string" && rows.length === 0 ? t("hosts.invalidLegacy") : t("hosts.invalidSummary"))
					: null,
				rows.length === 0 ? h("p", { className: "dshwmb-host-empty" }, t("hosts.empty")) : null,
				rows.map((row, index) => {
					const tested = tests[row.__rowId];
					const testing = tested?.status === "testing";
					const expanded = rowExpanded(row);
					// A test would only repeat the row error, so the button refuses until the
					// row is complete (and says why through its title).
					const rowErrorCount = Object.keys(errors[index] ?? {}).length;
					const invalidRow = rowErrorCount > 0;
					const alias = typeof row.alias === "string" ? row.alias.trim() : "";
					const host = typeof row.host === "string" ? row.host.trim() : "";
					const user = typeof row.user === "string" ? row.user.trim() : "";
					const portText = typeof row.port === "string" ? row.port.trim() : "";
					const port = /^\d+$/.test(portText) ? portText : "22";
					// The summary is the connection TARGET, never alias@host: an alias is a name,
					// not a login user. Port is the effective one (row value or 22).
					const target = host === "" ? "" : user === "" ? `${host}:${port}` : `${user}@${host}:${port}`;
					const summary = target !== "" ? target : alias !== "" ? alias : t("hosts.untitled");
					const aliasToken = alias !== "" ? alias : t("hosts.untitled");
					// A field with an error can never be hidden behind the disclosure: the
					// row auto-expands its advanced section until the error is fixed.
					const advancedHasError = HOST_FIELDS.some((field) => field.advanced === true && errors[index]?.[field.leaf] !== undefined);
					const advancedShown = advancedRows[row.__rowId] === true || advancedHasError;
					const cells = [];
					for (const field of HOST_FIELDS) {
						if (field.advanced === true && !advancedShown) continue;
						// One divider marks where the optional description begins.
						if (field.leaf === "description") cells.push(h("div", { key: "divider", className: "dshwmb-host-divider" }));
						cells.push(control(index, row, field));
					}
					return h("fieldset", { key: row.__rowId, className: expanded ? "dshwmb-host" : "dshwmb-host dshwmb-host-collapsed", "data-row": index, "data-row-id": row.__rowId },
						h("legend", { className: "dshwmb-host-legend" },
							h("span", { className: "dshwmb-host-heading" },
								h(primitives.Button, {
									variant: "ghost",
									size: "sm",
									type: "button",
									"data-action": "toggle",
									"data-row": index,
									"aria-expanded": expanded,
									title: expanded ? t("hosts.collapse") : t("hosts.expand"),
									onClick: () => expandRow(row, !expanded),
								}, expanded ? t("hosts.collapse") : t("hosts.expand")),
								h("span", null, withValue(t("hosts.row"), String(index + 1))),
								h("code", { className: "dshwmb-host-alias", "data-role": "alias" }, aliasToken),
								row.default === true ? h("span", { className: "dshwmb-host-default", "data-role": "default" }, t("hosts.defaultBadge")) : null,
								invalidRow ? h("span", { className: "dshwmb-host-summary-error", role: "alert" }, withValue(t("hosts.errorCount"), String(rowErrorCount))) : null),
							h("span", { className: "dshwmb-host-summary", "data-role": "target", title: summary }, summary),
							h("span", { className: "dshwmb-host-legend-actions" },
								h(primitives.Button, {
									variant: "ghost",
									size: "sm",
									type: "button",
									"data-action": "advanced",
									"data-row": index,
									"aria-expanded": advancedShown,
									disabled,
									onClick: () => setAdvancedRows((current) => ({ ...current, [row.__rowId]: !advancedShown })),
								}, advancedShown ? t("hosts.advancedHide") : t("hosts.advancedShow")),
								h(primitives.Button, {
									variant: "ghost",
									size: "sm",
									type: "button",
									disabled: disabled === true || testing || invalidRow,
									title: invalidRow ? t("hosts.testNeedsFix") : undefined,
									"data-action": "test",
									"data-row": index,
									onClick: () => { void testOne(index); },
								}, testing ? t("hosts.testing") : t("hosts.test")),
								h(primitives.Button, { variant: "ghost", size: "sm", type: "button", disabled, "data-action": "remove", "data-row": index, onClick: () => change(rows.filter((_row, at) => at !== index)) }, t("hosts.remove")))),
						expanded ? h("div", { className: "dshwmb-host-grid" }, cells) : null,
						tested?.status === "ok"
							? h("div", { className: "dshwmb-host-test dshwmb-host-test-ok" },
								h("p", { role: "status" }, tested.fingerprint === undefined ? t("hosts.testOkPlain") : withValue(t("hosts.testOk"), tested.fingerprint)),
								tested.warning === undefined ? null : h("p", { className: "dshwmb-host-test-warning" }, withValue(t("hosts.testWarning"), tested.warning)))
							: tested?.status === "failed"
								? h("p", { className: "dshwmb-host-test dshwmb-host-test-failed", role: "alert" }, withValue(t("hosts.testFailed"), tested.message))
								: null);
				}),
				h("div", { className: "dshwmb-host-actions" },
					h(primitives.Button, { type: "button", variant: "secondary", size: "sm", disabled: disabled === true || tableInvalid, title: tableInvalid ? t("hosts.addBlocked") : undefined, "data-action": "add", onClick: () => change([...rows, blankHostRow()]) }, t("hosts.add")),
					h(primitives.Button, { type: "button", variant: "primary", size: "sm", disabled: disabled === true || tableInvalid || save === undefined, "data-action": "save", onClick: () => { if (save !== undefined) save(); } }, t("hosts.save"))));
		}
		//#endregion
		//#region card
		/** One knob's control: a staged value field, a checkbox, or a segmented choice. */
		function fieldControl(knob, disabled, props, t) {
			// The ssh host registry is the TABLE: one card per host, with its own inline
			// warnings and an exclusive default radio. Nothing here is a text box over
			// JSON, and the value it stages is the array of host objects.
			if (knob.kind === "hosts")
				return h(HostsEditor, { key: knob.key, knob, disabled, t, edit: props.edit, resetField: props.resetField, save: props.save });
			// The warning names the value it is about (A3: visible, localized, and
			// specific) — composed here rather than in the dictionary so a `$` in the
			// value can never be read as a replacement pattern.
			const invalidLabel = knob.invalid
				? withValue(t(knob.invalidReason === "path" ? "invalidPath" : knob.invalidReason === "distro" ? "invalidDistro" : knob.invalidReason === "numberFormat" ? "invalidNumberFormat" : knob.invalidReason === "hosts" ? "invalidHosts" : "invalidNumber"), String(knob.text).trim())
				: t("invalidNumber");
			// Copy is keyed by FULL partition+leaf first, then by leaf. A leaf-only key
			// made gitBash.bashPath and msys2Bash.bashPath share one label, and the
			// terminal row inherited command-row wording.
			const copyPath = typeof knob.copyKey === "string" ? knob.copyKey : knob.key;
			const copyLeaf = copyPath.split(".").pop();
			const copyText = (suffix) => {
				const fullKey = `${copyPath}.${suffix}`;
				const full = t(fullKey);
				return full !== fullKey ? full : t(`${copyLeaf}.${suffix}`);
			};
			const overrideHint = typeof knob.hintKey === "string" ? t(`${knob.hintKey}.hint`) : undefined;
			const baseHint = overrideHint !== undefined && overrideHint !== `${knob.hintKey}.hint` ? overrideHint : copyText("hint");
			const shownHint = knob.defaultValue === undefined ? baseHint : `${baseHint} ${withValue(t("defaultHint"), String(knob.defaultValue))}`;
			const shared = {
				id: `win-mb-${knob.key.replace(/\./g, "-")}`,
				label: copyText("label"),
				hint: shownHint,
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
				...state.fields.flatMap((knob, index) => {
					const previous = index === 0 ? undefined : state.fields[index - 1].group;
					const heading = knob.group !== undefined && knob.group !== previous
						? [h("h3", { key: `group-${knob.group}`, className: "dshwmb-group", role: "heading", "aria-level": 3 }, t(`group.${knob.group}`))]
						: [];
					return [...heading, fieldControl(knob, disabled, props, t)];
				}),
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
			".dshwmb-term-root{position:relative;display:inline-flex;align-items:center}",
			".dshwmb-term-trigger{display:inline-flex;align-items:center;gap:3px;min-height:28px;padding:3px 2px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}",
			".dshwmb-term-trigger:hover,.dshwmb-term-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}",
			".dshwmb-term-trigger svg{transition:transform 120ms ease}",
			".dshwmb-term-chev-open{transform:rotate(180deg)}",
			".dshwmb-term-glyph{display:inline-flex;flex:none;align-items:center;color:var(--dsw-alias-label-secondary)}",
			".dshwmb-term-count{margin:0 5px}",
			".dshwmb-term-surface{position:fixed;z-index:100;box-sizing:border-box;display:flex;flex-direction:column;width:500px;max-width:min(560px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 140px));overflow:hidden;isolation:isolate;background:var(--dsw-menu-surface-fill,var(--dsw-specific-menu,var(--dsw-alias-bg-base)));backdrop-filter:var(--dsw-menu-backdrop-filter,none);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent)}",
			".dshwmb-term-body{display:flex;flex-direction:column;gap:1px;min-height:0;margin:0;padding:4px;overflow:auto;list-style:none}",
			".dshwmb-term-section{display:flex;align-items:center;justify-content:space-between;margin:4px 4px 1px;padding:4px 0 3px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dshwmb-term-section:first-child{margin-top:0;border-top:0}",
			".dshwmb-term-section-settled{margin-top:2px}",
			".dshwmb-term-item{display:flex;flex-direction:column}",
			".dshwmb-term-section-toggle,.dshwmb-term-section-clear{display:inline-flex;gap:3px;align-items:center;padding:2px 4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;cursor:pointer}",
			".dshwmb-term-section-toggle:hover,.dshwmb-term-section-clear:hover,.dshwmb-term-section-toggle:focus-visible,.dshwmb-term-section-clear:focus-visible{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary)}",
			".dshwmb-term-schev{transform:rotate(-90deg);transition:transform 120ms ease}",
			".dshwmb-term-schev-open{transform:none}",,
			".dshwmb-term-rowline{display:flex;gap:6px;align-items:stretch}",
			".dshwmb-term-rowline-live{padding:4px 8px 4px 2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l2)}",
			".dshwmb-term-rowline-live:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}",
			".dshwmb-term-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
			".dshwmb-term-dot-ongoing{background:var(--dsw-alias-brand-primary,#4d6bfe)}",
			".dshwmb-term-dot-done{background:var(--dsw-alias-state-success-primary)}",
			".dshwmb-term-dot-stopped{background:var(--dsw-alias-state-warn-primary)}",
			".dshwmb-term-dot-failed{background:var(--dsw-alias-state-error-primary)}",
			".dshwmb-term-dot-muted{background:var(--dsw-alias-label-tertiary)}",,
						".dshwmb-term-kind{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px}",
			".dshwmb-term-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px}",
			".dshwmb-term-status{flex:none;max-width:40%;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;white-space:nowrap;text-overflow:ellipsis}",
			".dshwmb-term-duration{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}",
			".dshwmb-term-stop{display:inline-flex;flex:none;align-items:center;align-self:center;justify-content:center;width:20px;height:20px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dshwmb-term-stop:hover,.dshwmb-term-stop:focus-visible{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}",
			".dshwmb-term-stop:disabled{opacity:.5;cursor:default}",
			".dshwmb-term-stop-armed,.dshwmb-term-stop-armed:hover{gap:4px;width:auto;padding:0 7px;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}",
			".dshwmb-term-stop-failed{color:var(--dsw-alias-state-error-primary)}",
			".dshwmb-term-stop-glyph{font-size:8px;line-height:1}",
			".dshwmb-term-stop-label{font-size:11px;line-height:18px;white-space:nowrap}",
			".dshwmb-term-row{display:flex;align-items:center;gap:6px;box-sizing:border-box;flex:1;width:100%;min-width:0;min-height:28px;padding:4px 7px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer}",
			".dshwmb-term-row:hover,.dshwmb-term-row:focus-visible{background:var(--dsw-alias-fill-l1)}",
			".dshwmb-term-rowline-live .dshwmb-term-row:hover{background:transparent}",
			".dshwmb-term-chevbox{display:inline-flex;flex:none;align-items:center;align-self:center;justify-content:center;width:20px;height:20px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu)}",
			".dshwmb-term-chev{color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease}",
			".dshwmb-term-chev-open{transform:rotate(180deg)}",
			".dshwmb-term-chev-trigger{color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease}",
			".dshwmb-term-chev-trigger-open{transform:rotate(180deg)}",
			".dshwmb-term-panel{margin:4px 8px 8px;padding:8px 10px;max-height:288px;overflow:auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block)}",
			".dshwmb-term-output{margin:0;font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}",
			".dshwmb-term-notice{padding:4px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dshwmb-term-empty,.dshwmb-term-error{padding:8px 12px;font-size:12px;opacity:.7}",
			".dshwmb-term-error{color:var(--dsw-alias-state-error-primary);opacity:1}",
			// A faithful copy of the platform approval card (padding/border/background/strip/body/actions).
			".dshwmb-ap-root{display:flex;flex-direction:column;align-items:center;padding:8px calc(var(--dsh-composer-side-clearance) + 16px) 12px}",
			".dshwmb-ap-card{overflow:hidden;width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
			".dshwmb-ap-strip{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:18px}",
			".dshwmb-ap-body{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;max-height:var(--dsh-composer-text-max-height);overflow-y:auto;padding:12px 16px 0}",
			".dshwmb-ap-heading{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px}",
			".dshwmb-ap-headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}",
			".dshwmb-ap-description{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			".dshwmb-ap-command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;word-break:break-all}",
			".dshwmb-ap-settled{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshwmb-ap-action-row{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:14px 16px}",
			"@media (hover:hover){.dshwmb-ap-reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);--dsh-button-outline-color:transparent}}",
			".dshwmb-ap-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:0 16px 12px}",
			".dshwmb-hosts{display:flex;flex-direction:column;gap:8px}",
			".dshwmb-host-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dshwmb-host-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshwmb-host{margin:0;padding:8px 10px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1)}",
			".dshwmb-host-legend{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600;flex-wrap:nowrap}",
			".dshwmb-host-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshwmb-host-flow{margin-top:-4px}",
			".dshwmb-host-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:12px 16px;margin-top:8px}",
			".dshwmb-host-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dshwmb-host-field-wide{grid-column:1/-1}",
			".dshwmb-host-field label,.dshwmb-host-flag label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}",
			".dshwmb-host-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}",
			".dshwmb-host-divider{grid-column:1/-1;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:2px}",
			".dshwmb-host-field input,.dshwmb-host-field select,.dshwmb-host-field textarea{box-sizing:border-box;width:100%;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
			".dshwmb-host-code{font-family:var(--ds-font-family-code);font-size:12px;line-height:16px;resize:vertical;min-height:44px}",
			".dshwmb-host-field input:focus-visible,.dshwmb-host-field select:focus-visible,.dshwmb-host-field textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
			".dshwmb-host-flag{grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dshwmb-host-flag .dshwmb-host-hint{flex:1 1 100%;margin-top:-2px}",
			".dshwmb-host-error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}",
			".dshwmb-host-heading{display:flex;gap:6px;align-items:center;min-width:0}",
			".dshwmb-host-summary{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".dshwmb-host-alias{font-family:var(--dsw-font-family-mono,monospace);font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-fill-secondary,rgba(127,127,127,.12));border-radius:4px;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}",
			".dshwmb-host-default{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-line-border,rgba(127,127,127,.35));border-radius:999px;padding:0 6px;white-space:nowrap}",
			".dshwmb-host-summary-error{color:var(--dsw-alias-state-error-primary);font-size:11px;font-weight:400;white-space:nowrap}",
			".dshwmb-host-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			".dshwmb-host-legend-actions{display:flex;gap:6px;align-items:center;margin-left:auto;flex:none}",
			"@media (max-width:640px){.dshwmb-host-grid{grid-template-columns:minmax(0,1fr)}}",
			".dshwmb-host-test{margin:4px 0 0;font-size:11px;line-height:16px}",
			".dshwmb-host-test-ok{color:var(--dsw-alias-label-secondary)}",
			".dshwmb-host-test-failed{color:var(--dsw-alias-state-error-primary)}",
			".dshwmb-host-test-warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}",
		].join("");
		//#region session authorization card (conversation.composer chain entry)
		/**
		 * Whether a pending interaction is an SSH host authorization this card owns.
		 *
		 * The composer is a CHAIN: returning null lets the next entry (the platform's
		 * shared approval composer at priority 1) claim the request, so this matcher
		 * must be strict — a settled request, another tool's approval, or a non-approval
		 * interaction all fall through.
		 * @param pending - the composer chain's `pendingInteraction`.
		 * @returns the pending approval when this card owns it, else null.
		 */
		function sshApprovalMatch(pending) {
			if (typeof pending !== "object" || pending === null) return null;
			if (pending.kind !== "approval") return null;
			if (typeof pending.answer !== "function") return null;
			if (!APPROVAL_GATED_TOOL_NAMES.includes(pending.toolName)) return null;
			if (pending.answerable === false) return null;
			return pending;
		}
		/**
		 * The human sentence a pending approval carries, in the reader's language when
		 * the host can resolve it. `displayReason` is a localized record (`{en, zh, …}`),
		 * with a plain sentence tolerated; `reason` is the asker's fallback copy.
		 * Pure, so the audit renders it without a renderer.
		 * @param pending - the pending approval.
		 * @param resolver - optional locale resolver from the slot's inject.
		 * @returns the sentence to show, or "".
		 */
		function sshApprovalReason(pending, resolver) {
			const display = pending?.displayReason;
			if (display !== undefined && typeof resolver === "function") {
				try {
					const text = resolver(display);
					if (typeof text === "string" && text !== "") return text;
				}
				catch {
					// A resolver from an older host must not cost the card its sentence.
				}
			}
			if (typeof display === "string" && display !== "") return display;
			if (typeof display === "object" && display !== null) {
				if (typeof display.en === "string" && display.en !== "") return display.en;
				for (const value of Object.values(display)) if (typeof value === "string" && value !== "") return value;
			}
			return typeof pending?.reason === "string" ? pending.reason : "";
		}
		/**
		 * The SSH authorization card: a faithful copy of the platform approval card
		 * (same root/card/strip/body/heading/action-row structure and tokens) with ONE
		 * added action — the session grant as the primary button.
		 *
		 * No navigation and no new RPC: the buttons answer the pending interaction.
		 * The SSH gate's vocabulary has `allowed-once` / `rejected` only, and its
		 * `allowed-once` is exactly the grant that lasts for the session (kept in
		 * memory by the row), so both allow buttons send `allowed-once`; the added
		 * button only makes that durable choice the primary one. A synchronous throw
		 * from `answer` still reaches the failure path (buttons come back + alert).
		 * @param props - the slot props: `matched` is the pending approval.
		 */
		function SshApprovalCard(props) {
			const pending = props?.matched;
			const t = textOf(props);
			const [submitting, setSubmitting] = React.useState(false);
			const [settled, setSettled] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			// The platform card's waiting latch: a rapid second click never answers twice.
			const waiting = React.useRef(false);
			// The platform card's IME guards: a composing keystroke is not a decision.
			const composing = React.useRef(false);
			const compositionEnded = React.useRef(false);
			// Settled means the request itself is over (answered here, or the platform
			// withdrew it). A failed submit is NOT settled: the call is still pending and
			// the buttons must come back so the human can try again.
			const settledNow = settled === true || pending?.answerable === false;
			const canAnswer = typeof pending === "object" && pending !== null && typeof pending.answer === "function" && settledNow === false;
			const reason = sshApprovalReason(pending, props?.resolver);
			const title = reason === "" ? t("sshApproval.title") : reason;
			const approvalCallId = typeof pending?.callId === "string" ? pending.callId : "";
			// Mirror the route bound: a call id is usable only as a 1..256-char string.
			const callIdMissing = approvalCallId === "" || approvalCallId.length > 256;
			const markedCallId = React.useRef(undefined);
			const disabled = submitting === true || canAnswer === false;
			// Both allow actions need the call id: the scope they declare is what the gate
			// reads. Without it the card disables them rather than silently grant something
			// narrower/different than the label says.
			const allowDisabled = disabled || callIdMissing;
			const markScope = typeof props.markApprovalScope === "function" ? props.markApprovalScope : markHostApprovalScope;
			const clearScope = typeof props.clearApprovalScope === "function" ? props.clearApprovalScope : clearHostApprovalScope;
			/**
			 * Failure path shared by every action: buttons come back, the alert shows, and a
			 * scope mark written for THIS attempt is cleared so it cannot leak into a later
			 * answer. The pending approval itself is untouched.
			 */
			const failNow = () => {
				waiting.current = false;
				const marked = markedCallId.current;
				markedCallId.current = undefined;
				if (marked !== undefined) {
					try {
						void Promise.resolve(clearScope(marked)).catch(() => {});
					}
					catch { /* best effort: the primary failure is already shown */ }
				}
				setFailed(true);
				setSubmitting(false);
			};
			/** Send one outcome; the caller has already taken the waiting latch. */
			const deliver = (outcome) => {
				// The call is made synchronously (the caller may rely on that), but a
				// SYNCHRONOUS throw must still land in the failure path: otherwise
				// `setSubmitting(true)` is never undone and the card deadlocks.
				let result;
				try {
					result = pending.answer(outcome);
				}
				catch {
					failNow();
					return;
				}
				Promise.resolve(result).then(
					() => setSettled(true),
					failNow,
				);
			};
			/** Reject needs no scope mark: the gate refuses without caching anything. */
			const answer = (outcome) => {
				if (canAnswer === false || submitting === true || waiting.current === true) return;
				waiting.current = true;
				setSubmitting(true);
				setFailed(false);
				deliver(outcome);
			};
			/**
			 * Mark the chosen scope FIRST, then answer only after the mark succeeded. An
			 * `allowed-once` answer is cached by the gate only when the mark says `session`;
			 * a failed mark must leave the approval pending (never answer it).
			 */
			const answerWithScope = async (scope, outcome) => {
				if (canAnswer === false || submitting === true || waiting.current === true) return;
				if (callIdMissing === true) {
					waiting.current = true;
					setSubmitting(true);
					failNow();
					return;
				}
				waiting.current = true;
				setSubmitting(true);
				setFailed(false);
				try {
					await markScope(approvalCallId, scope);
					markedCallId.current = approvalCallId;
				}
				catch {
					failNow();
					return;
				}
				if (typeof pending?.answer !== "function" || pending?.answerable === false) {
					failNow();
					return;
				}
				deliver(outcome);
			};
			const allowOnce = () => answerWithScope("once", "allowed-once");
			const allowSession = () => answerWithScope("session", "allowed-once");
			/** The platform card's keyboard contract: Enter allows once, Escape rejects. */
			const onKeyDown = (event) => {
				if (event?.defaultPrevented === true) return;
				if (typeof document !== "undefined" && event?.currentTarget !== undefined && event.currentTarget?.contains?.(document.activeElement) !== true) return;
				const target = event?.target;
				if (typeof target?.closest === "function" && target.closest("input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"\"]") !== null) return;
				if (event?.key !== "Enter" && event?.key !== "Escape") return;
				if (event.key === "Enter" && typeof target?.closest === "function" && target.closest("button, a[href], [role=\"button\"]") !== null) return;
				if (event?.ctrlKey === true || event?.metaKey === true || event?.altKey === true || event?.shiftKey === true) return;
				event?.preventDefault?.();
				event?.stopPropagation?.();
				if (event?.repeat === true || composing.current === true || compositionEnded.current === true || event?.nativeEvent?.isComposing === true || event?.keyCode === 229) return;
				if (event.key === "Enter") {
					void allowOnce();
					return;
				}
				answer("rejected");
			};
			const Button = primitives.Button;
			const StateDot = primitives.StateDot;
			return h("div", {
				className: "dshwmb-ap-root",
				"data-approval-key": typeof pending?.key === "string" ? pending.key : undefined,
				"aria-busy": submitting === true,
				onKeyDown,
				onKeyUpCapture: () => { compositionEnded.current = false; },
				onCompositionStartCapture: () => { composing.current = true; },
				onCompositionEndCapture: () => { composing.current = false; compositionEnded.current = true; },
			},
				h("div", { className: "dshwmb-ap-card" },
					h("div", { className: "dshwmb-ap-strip" },
						StateDot === undefined ? null : h(StateDot, { state: submitting === true ? "ongoing" : "warning" }),
						t("sshApproval.waiting")),
					h("div", { className: "dshwmb-ap-body", tabIndex: 0, role: "group", "aria-label": t("sshApproval.detailAria"), "data-approval-scroll": "" },
						h("div", { className: "dshwmb-ap-heading" }, h("div", { className: "dshwmb-ap-headline" }, title)),
						h("p", { className: "dshwmb-ap-description" }, t("sshApproval.scope")),
						settledNow ? h("p", { className: "dshwmb-ap-settled" }, t("sshApproval.settled")) : null),
					h("div", { className: "dshwmb-ap-action-row" },
						h(Button, { key: "reject", variant: "outline", className: "dshwmb-ap-reject", disabled, onClick: () => answer("rejected") }, t("sshApproval.reject")),
						h(Button, { key: "allow-once", variant: "outline", disabled: allowDisabled, title: callIdMissing ? t("sshApproval.oneShotNeedsCall") : undefined, onClick: () => { void allowOnce(); } }, t("sshApproval.allowOnce")),
						h(Button, { key: "allow-session", variant: "primary", disabled: allowDisabled, title: callIdMissing ? t("sshApproval.oneShotNeedsCall") : undefined, onClick: () => { void allowSession(); } }, t("sshApproval.allowSession")))),
				settledNow === false && failed === true ? h("div", { className: "dshwmb-ap-error", role: "alert" }, t("sshApproval.failed")) : null);
		}
		//#endregion
		/** The style tag's platform name (client-only edit), `<owner id>/<file>` as the presets tag theirs. */
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
		 * One session endpoint over the Host's `/win-mb` prefix route, with the legacy
		 * Connection-RPC channel as the fallback.
		 *
		 * The fallback is deliberately narrow: it applies only when the route is ABSENT
		 * (404/405) or the request never reached the Host (fetch threw). Every other HTTP
		 * failure surfaces with its status — retrying a 400 over RPC would hide the reason
		 * in a channel that cannot report it. A 2xx without a JSON body is an error too.
		 * @param fetchImpl - the deployment's fetch (injected so the decision is testable).
		 * @param connection - the injected connection, for the legacy channel.
		 * @param endpoint - `sessions.list`, `sessions.tail`, `sessions.clear` or `sessions.stop`.
		 * @param payload - the JSON body.
		 * @returns the parsed result envelope.
		 */
		async function callSessionEndpoint(fetchImpl, connection, endpoint, payload) {
			let response;
			try {
				response = await fetchImpl(`/win-mb/${endpoint}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload ?? {}),
				});
			} catch {
				return connection.rpc.call('/win-mb', endpoint, payload);
			}
			if (response.status === 404 || response.status === 405)
				return connection.rpc.call('/win-mb', endpoint, payload);
			const contentType = response.headers.get('content-type') ?? '';
			if (!response.ok) {
				let detail = `the session request failed with HTTP ${response.status}`;
				if (contentType.includes('application/json')) {
					try {
						const body = await response.json();
						if (typeof body?.error?.message === 'string' && body.error.message !== '') detail = body.error.message;
					} catch { /* keep the status sentence */ }
				}
				throw new Error(detail);
			}
			if (contentType.includes('application/json')) return await response.json();
			throw new Error(`the session request returned HTTP ${response.status} without a JSON answer`);
		}
		/**
		 * The Session header's terminal list, modelled on the background-job list:
		 * a dot + count trigger that opens a list of the deployment's PTY sessions,
		 * each row carrying a live dot, its shell badge, cwd, elapsed time and a
		 * two-press stop.
		 *
		 * Data rides a prefix route on the host's own web server (`/win-mb`), whose
		 * handler applies the deployment's Connection RPC trust fence (`requestRejection`)
		 * before anything else; a Host that lacks the route is retried over Connection RPC,
		 * so there is no second, unauthenticated HTTP surface. The control renders nothing
		 * while no session exists, exactly like the job list.
		 * @param props - slot props: the dictionary translator and the injected connection.
		 * @returns the trigger plus, while open, the session list.
		 */
		/**
		 * The Session header's terminal list.
		 * @param props - slot props: the translator, the injected connection, and the
		 * conversation this header belongs to (`sessionId`), which scopes the list the
		 * same way the tool's own `list` is scoped to its owner.
		 * @returns the trigger plus, while open, the session list.
		 */
		function TerminalHeaderAction({ t, connection, sessionId }) {
			// The panel is a floating layer: measuring it after paint spends a frame, and the
			// platform's own `useAnchoredPosition` uses a layout effect. The audit's render
			// stub has no `useLayoutEffect`, hence the fallback.
			const useLayoutResult = typeof React.useLayoutEffect === "function" ? React.useLayoutEffect : React.useEffect;
			const [open, setOpen] = React.useState(false);
			const [sessions, setSessions] = React.useState([]);
			const [error, setError] = React.useState("");
			const [phase, setPhase] = React.useState({ id: "", state: "idle" });
			const [now, setNow] = React.useState(() => Date.now());
			// Several rows may be open at once: a panel that only keeps one loses the
			// comparison the reader opened it for (the job list deliberately folds, but a
			// terminal panel is about watching parallel shells).
			const [expandedIds, setExpandedIds] = React.useState([]);
			/** Whether the finished section is unfolded (the settled rows are history). */
			const [settledOpen, setSettledOpen] = React.useState(true);
			/** The running/idle mode the automatic fold last applied (see below). */
			const autoSettledRef = React.useRef(null);
			const [tails, setTails] = React.useState({});
			const [tailBusy, setTailBusy] = React.useState({});
			/** One output element per expanded row, keyed by session id. */
			const outputRefs = React.useRef({});
			/** Whether each expanded output follows its end (scrolled up = pinned off). */
			const pinnedRefs = React.useRef({});
			// The poll callbacks must see the latest list/tails without being rebuilt on
			// every render (a new callback would restart the interval each tick).
			const sessionsRef = React.useRef([]);
			sessionsRef.current = sessions;
			const tailsRef = React.useRef({});
			tailsRef.current = tails;
			const expandedIdsRef = React.useRef([]);
			expandedIdsRef.current = expandedIds;
			const triggerRef = React.useRef(null);
			const rootRef = React.useRef(null);
			/** The popover itself, measured so the clamp uses its real size. */
			const menuRef = React.useRef(null);
			const [pos, setPos] = React.useState(null);
			/** The endpoint call; the route-vs-RPC decision lives in one helper. */
			const callSession = React.useCallback((endpoint, payload) => callSessionEndpoint(fetch, connection, endpoint, payload), [connection]);
			const load = React.useCallback(async () => {
				if (connection === undefined || connection === null) {
					setError(t("terminal.panel.unavailable"));
					return;
				}
				try {
					// Scope to this conversation: another conversation's terminals are its own
					// business, and the panel must not offer to stop them either.
					const ownerKey = typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
					const result = await callSession("sessions.list", ownerKey === undefined ? {} : { ownerKey });
					if (result?.ok === false) throw new Error(String(result?.error?.message ?? "the session list failed"));
					const next = Array.isArray(result?.value?.sessions) ? result.value.sessions : [];
					const previous = sessionsRef.current;
					setSessions(next);
					// A row that just ended may have printed between the last tail read and the
					// exit; take one final read, or the panel shows a truncated ending.
					for (const session of next) {
						const before = previous.find((entry) => entry.sessionId === session.sessionId);
						if (before !== undefined && before.status === "running" && session.status !== "running"
							&& expandedIdsRef.current.includes(session.sessionId)) {
							void readTail(session.sessionId, false, true);
						}
					}
					// Rows that left the registry (evicted by retention, or cleared by another
					// tab) must not leave their retained tail behind in this one.
					setTails((current) => {
						const alive = new Set(next.map((session) => session.sessionId));
						const kept = Object.entries(current).filter(([id]) => alive.has(id));
						return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
					});
					setError("");
				} catch (failure) {
					setError(String(failure?.message ?? failure));
				}
				// The dictionary is static per deployment; keeping `t` out of the deps keeps
				// `load` stable so the 2 s poll is not torn down on every render.
			}, [callSession, connection, sessionId]);
			/** Drop this conversation's retained finished rows; the section empties on the next load. */
			const clearFinished = React.useCallback(async () => {
				if (connection === undefined || connection === null) return;
				try {
					const ownerKey = typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
					const result = await callSession("sessions.clear", ownerKey === undefined ? {} : { ownerKey });
					if (result?.ok === false) throw new Error(String(result?.error?.message ?? "clearing the finished sessions failed"));
					// The rows are gone server-side: drop the browser copies too, or every
					// cleared row keeps up to 64 KiB of output and a detached <pre> for the
					// life of the page.
					setExpandedIds([]);
					setTails({});
					outputRefs.current = {};
					pinnedRefs.current = {};
					await load();
				} catch (failure) {
					setError(String(failure?.message ?? failure));
				}
			}, [callSession, connection, load, sessionId]);
			// The trigger only exists while at least one session does, so the list must be
			// sampled BEFORE the panel is opened: gating the poll on `open` left the
			// control with an empty registry and it rendered nothing, which made opening
			// it impossible. Closed polls run at 5 s, an open panel at 2 s.
			// Finished sessions are background noise while something runs, and the whole
			// list once nothing does: fold them automatically in the first case, unfold in
			// the second. A manual toggle holds until the running/idle mode flips.
			React.useEffect(() => {
				const hasLive = sessions.some((session) => session.status === "running");
				if (autoSettledRef.current === hasLive) return;
				autoSettledRef.current = hasLive;
				setSettledOpen(hasLive === false);
			}, [sessions]);
			React.useEffect(() => {
				load();
				const timer = setInterval(load, open === true ? 2000 : 5000);
				return () => clearInterval(timer);
			}, [open, load]);
			React.useEffect(() => {
				if (open !== true) return undefined;
				setNow(Date.now());
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [open]);
			// A portaled dialog must own focus: Tab from the trigger otherwise never
			// reaches it. Closing returns focus to the trigger that opened it.
			React.useEffect(() => {
				if (open !== true) return undefined;
				const panel = menuRef.current;
				if (panel !== null && panel !== undefined && typeof panel.focus === "function") panel.focus({ preventScroll: true });
				return () => {
					const trigger = triggerRef.current;
					if (trigger !== null && trigger !== undefined && typeof trigger.focus === "function") trigger.focus({ preventScroll: true });
				};
			}, [open]);
			// Anchor the popover to the trigger and dismiss it like any other menu: no
			// overlay, a press outside it or Escape closes it, and a resize re-anchors.
			useLayoutResult(() => {
				if (open !== true) return undefined;
				// The platform's own geometry (ui-primitives `useAnchoredPosition`): hang
				// from the trigger's left edge below it with a 5 px gap, then clamp the
				// panel inside a 12 px viewport margin using its measured size.
				const place = () => {
					const anchor = triggerRef.current;
					if (anchor === null || typeof window === "undefined") return;
					const rect = anchor.getBoundingClientRect();
					const panel = menuRef.current;
					const width = panel?.offsetWidth ?? 500;
					const height = panel?.offsetHeight ?? 320;
					const margin = 12;
					const gap = 5;
					// Same top edge as the platform's `overlayTopMargin`, with one deliberate
					// divergence: it does not cap at the anchor, we do, so a panel opened from
					// the header always stays next to the header instead of being pushed down
					// by the desktop frame's reserved strip.
					let topMargin = margin;
					if (typeof getComputedStyle === "function") {
						const root = document.documentElement;
						const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue("--dsh-frame-top-clearance"));
						if (!Number.isNaN(clearance)) {
							const cap = rect.top >= 0 ? rect.bottom + gap : Number.POSITIVE_INFINITY;
							const frame = root.hasAttribute("data-fullscreen") ? 0 : clearance;
							topMargin = Math.max(margin, Math.min(frame + 20, cap));
						}
					}
					const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
					// The panel grows with the session list: cap its height to the room below
					// the trigger so it scrolls internally instead of being clamped upward over
					// the header (a tall panel used to end up above its own trigger).
					const available = window.innerHeight - rect.bottom - gap - margin;
					const maxHeight = Math.round(Math.max(120, Math.min(480, available)));
					const top = Math.min(Math.max(rect.bottom + gap, topMargin), window.innerHeight - height - margin);
					const nextLeft = Math.round(left);
					// Never above the top margin, whatever the bottom clamp says.
					const nextTop = Math.round(Math.max(topMargin, top));
					// Scroll events fire per wheel tick, including inside the popover; an
					// unchanged position must not re-render the whole subtree.
					setPos((current) => (current !== null && current.left === nextLeft && current.top === nextTop && current.maxHeight === maxHeight ? current : { left: nextLeft, top: nextTop, maxHeight }));
				};
				place();
				const onPointer = (event) => {
					const target = event.target;
					const inside = target !== null && typeof target.closest === "function" ? target.closest("[data-dshwmb-term-menu]") : null;
					const root = rootRef.current;
					if (inside !== null || (root !== null && root.contains(target) === true)) return;
					setOpen(false);
				};
				const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
				document.addEventListener("mousedown", onPointer);
				document.addEventListener("keydown", onKey);
				window.addEventListener("resize", place);
				// Capture phase: a scroller inside the page moves the anchor too.
				window.addEventListener("scroll", place, true);
				let observer = null;
				if (typeof ResizeObserver !== "undefined" && menuRef.current !== null) {
					observer = new ResizeObserver(place);
					observer.observe(menuRef.current);
				}
				return () => {
					document.removeEventListener("mousedown", onPointer);
					document.removeEventListener("keydown", onKey);
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
					observer?.disconnect();
						// Drop the stale coordinates: a reopen must measure again, not paint
						// at the previous anchor and then jump.
						setPos(null);
				};
			}, [open]);
			// An armed stop disarms on a timer; a rejected one keeps its hint briefly.
			React.useEffect(() => {
				if (phase.id === "" || phase.state === "idle" || phase.state === "pending") return undefined;
				const timer = setTimeout(() => setPhase({ id: "", state: "idle" }), phase.state === "armed" ? 3000 : 4000);
				return () => clearTimeout(timer);
			}, [phase]);
			const stop = async (sessionId) => {
				if (phase.id !== sessionId || phase.state !== "armed") {
					setPhase({ id: sessionId, state: "armed" });
					return;
				}
				setPhase({ id: sessionId, state: "pending" });
				try {
					const result = await callSession("sessions.stop", { sessionId });
					if (result?.ok === false) throw new Error(String(result?.error?.message ?? "the session did not stop"));
					setPhase({ id: "", state: "idle" });
					await load();
				} catch (failure) {
					setError(String(failure?.message ?? failure));
					setPhase({ id: sessionId, state: "failed" });
				}
			};
			const readTail = React.useCallback(async (id, busy, force) => {
				if (connection === undefined || connection === null) return;
				// A finished session cannot grow: read it once, then stop asking.
				const known = tailsRef.current[id] !== undefined;
				const row = sessionsRef.current.find((session) => session.sessionId === id);
				if (force !== true && known === true && row !== undefined && row.status !== "running") return;
				if (busy === true) setTailBusy((current) => ({ ...current, [id]: true }));
				try {
					const result = await callSession("sessions.tail", { sessionId: id });
					if (result?.ok === false) {
						const message = String(result?.error?.message ?? "the session output could not be read");
						// The row left the registry (retention evicted it): collapse instead of
						// blinking a banner at every poll.
						if (/is gone|no session/.test(message)) {
							setExpandedIds((current) => current.filter((entry) => entry !== id));
							return;
						}
						throw new Error(message);
					}
					const text = String(result?.value?.tail?.output ?? "");
					// A read that started before Clear/close may resolve after the row is gone;
					// landing it would resurrect the entry Clear just dropped.
					if (expandedIdsRef.current.includes(id) === false && tailsRef.current[id] === undefined) return;
					setTails((current) => (current[id] === text ? current : { ...current, [id]: text }));
				} catch (failure) {
					setError(String(failure?.message ?? failure));
				} finally {
					if (busy === true) setTailBusy((current) => { const next = { ...current }; delete next[id]; return next; });
				}
			}, [callSession, connection]);
			// Expanding a row reads its retained output; the timer below keeps it current,
			// so an expanded terminal does not freeze at the frame it was opened on.
			const toggleRow = (session) => {
				const id = session.sessionId;
				setExpandedIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
				// Opening a row always starts at its end, whatever the reader did last time.
				pinnedRefs.current[id] = true;
			};
			// A running session prints while its row is open, so the expanded view polls
			// the retained tail instead of caching the first snapshot.
			const expandedKey = expandedIds.join(",");
			React.useEffect(() => {
				if (open !== true || expandedIds.length === 0) return undefined;
				for (const id of expandedIds) void readTail(id, tailsRef.current[id] === undefined);
				const timer = setInterval(() => {
					for (const id of expandedIds) void readTail(id, false);
				}, 1500);
				return () => clearInterval(timer);
			}, [open, expandedKey, readTail]);
			// Follow the end of the output, like a terminal, unless the reader scrolled up.
			useLayoutResult(() => {
				for (const id of expandedIds) {
					const element = outputRefs.current[id];
					if (element === null || element === undefined || pinnedRefs.current[id] === false) continue;
					element.scrollTop = element.scrollHeight;
				}
				// Remounting (panel reopened, section unfolded) detaches the <pre> and React
				// resets scrollTop to 0; re-run then, and let the ref callback repin too.
			}, [tails, expandedKey, open, settledOpen]);
			React.useEffect(() => {
				if (sessions.length === 0 && open === true) {
					setOpen(false);
					setPos(null);
				}
			}, [sessions, open]);
			const live = sessions.filter((session) => session.status === "running");
			const settled = sessions.filter((session) => session.status !== "running");
			if (sessions.length === 0) return null;
			const countLabel = live.length > 0
				? fill(t("terminal.panel.liveCount"), { count: String(live.length) })
				: fill(t("terminal.panel.idleCount"), { count: String(sessions.length) });
			// A running row's clock ticks with `now`; a finished row's stops at its last
			// activity, the timestamp the host stamps when the session is retained.
			const elapsed = (startedAt, endedAt) => {
				const end = endedAt === undefined ? now : Number(endedAt ?? now);
				const seconds = Math.max(0, Math.floor((end - Number(startedAt ?? end)) / 1000));
				if (seconds < 60) return fill(t("terminal.panel.durationSeconds"), { seconds: String(seconds) });
				const minutes = Math.floor(seconds / 60);
				if (minutes < 60) return fill(t("terminal.panel.durationMinutes"), { minutes: String(minutes), seconds: String(seconds % 60) });
				return fill(t("terminal.panel.durationHours"), { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) });
			};
			// The platform's `chevron-down-outline` artwork, inlined: same 16×16 viewBox,
			// 1px regular stroke and round joins as ui-primitives' icon. The sprite form
			// (`<use href="#dsw-icon-…">`) renders nothing unless ui-theme has injected
			// that symbol, which is why the expand affordance disappeared.
			const chevron = (className) => h("svg", {
				className,
				width: 12,
				height: 12,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			}, h("path", { d: "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" }));
			const stopButton = (session) => {
				const state = phase.id === session.sessionId ? phase.state : "idle";
				const label = state === "armed" ? t("terminal.panel.confirm") : t("terminal.panel.stop");
				const className = state === "armed"
					? "dshwmb-term-stop dshwmb-term-stop-armed"
					: state === "failed" ? "dshwmb-term-stop dshwmb-term-stop-failed" : "dshwmb-term-stop";
				return h("button", {
					type: "button",
					className,
					"data-stop-state": state,
					disabled: state === "pending",
					"aria-label": label,
					title: label,
					onClick: () => { void stop(session.sessionId); },
				},
					h("span", { className: "dshwmb-term-stop-glyph", "aria-hidden": "true" }, "\u25a0"),
					state === "armed" ? h("span", { className: "dshwmb-term-stop-label" }, t("terminal.panel.confirmAction")) : null);
			};
			/** Which ending a session had, from the structured reason the host sends. */
			const endReasonOf = (session) => (typeof session.endedReason === "string" ? session.endedReason : "ended");
			/** The status word: the ending, not just exited-or-not. */
			const statusOf = (session) => {
				if (session.status === "running") return t("terminal.panel.statusRunning");
				const reason = endReasonOf(session);
				if (reason === "stopped") return t("terminal.panel.statusStopped");
				if (reason === "idle") return t("terminal.panel.statusIdle");
				if (reason === "transport") return t("terminal.panel.statusTransport");
				if (reason === "closed" || reason === "disposed" || reason === "cancelled") return t("terminal.panel.statusClosed");
				if (reason === "startup") return t("terminal.panel.statusStartup");
				if (typeof session.exitCode === "number" && session.exitCode !== 0) {
					return fill(t("terminal.panel.statusExitCode"), { code: String(session.exitCode) });
				}
				return t("terminal.panel.statusExited");
			};
			/** The dot's tone: one colour per kind of ending, not one grey for all. */
			const toneOf = (session) => {
				if (session.status === "running") return "ongoing";
				const reason = endReasonOf(session);
				if (reason === "transport") return "failed";
				if (reason === "stopped" || reason === "idle") return "stopped";
				if (reason === "closed" || reason === "disposed" || reason === "cancelled") return "muted";
				if (typeof session.exitCode === "number" && session.exitCode !== 0) return "failed";
				return "done";
			};
			const row = (session) => {
				const running = session.status === "running";
				const id = session.sessionId;
				const expanded = expandedIds.includes(id);
				// One line, like the job list: dot, shell badge, name, status, elapsed, chevron.
				const label = session.name === undefined || session.name === "" ? session.cwd : session.name;
				const status = statusOf(session);
				const body = h(React.Fragment, null,
					h("span", { className: `dshwmb-term-dot dshwmb-term-dot-${toneOf(session)}` }),
					h("span", { className: "dshwmb-term-kind" }, session.shell),
					h("span", { className: "dshwmb-term-label", title: session.cwd }, label),
					h("span", { className: "dshwmb-term-status", title: session.cwd }, status),
					h("span", { className: "dshwmb-term-duration", title: t("terminal.panel.durationTitle") }, elapsed(session.startedAt, running ? undefined : session.lastActiveAt)),
					h("span", { className: "dshwmb-term-chevbox" },
						chevron(expanded ? "dshwmb-term-chev dshwmb-term-chev-open" : "dshwmb-term-chev")));
				return h("li", { className: "dshwmb-term-item", key: id },
					h("div", { className: running ? "dshwmb-term-rowline dshwmb-term-rowline-live" : "dshwmb-term-rowline" },
						h("button", {
							type: "button",
							className: "dshwmb-term-row",
							"aria-expanded": expanded,
							"aria-label": `${label}, ${status}, ${expanded ? t("terminal.panel.collapseAria") : t("terminal.panel.expandAria")}`,
							onClick: () => { void toggleRow(session); },
						}, body),
						running ? stopButton(session) : null),
					expanded ? h("div", { className: "dshwmb-term-panel" },
						tailBusy[id] === true
							? h("div", { className: "dshwmb-term-notice" }, t("terminal.panel.loading"))
							: h("pre", {
								className: "dshwmb-term-output",
								ref: (element) => {
									outputRefs.current[id] = element;
									if (element !== null && pinnedRefs.current[id] !== false) element.scrollTop = element.scrollHeight;
								},
								onScroll: (event) => {
									const element = event.currentTarget;
									pinnedRefs.current[id] = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
								},
							}, tails[id] === undefined || tails[id] === "" ? t("terminal.panel.noOutput") : tails[id])) : null);
			};
			const section = (label) => h("li", { className: "dshwmb-term-section", "aria-hidden": "true" }, label);
			// The finished section carries both controls the job list puts on its settled
			// line: a fold toggle and a clear action, so the history can be hidden or
			// dropped without stopping anything that is still running.
			const settledSection = () => h("li", { className: "dshwmb-term-section dshwmb-term-section-settled" },
				h("button", {
					type: "button",
					className: "dshwmb-term-section-toggle",
					"aria-expanded": settledOpen,
					"aria-label": settledOpen ? t("terminal.panel.foldSettled") : t("terminal.panel.unfoldSettled"),
					onClick: () => setSettledOpen((current) => current !== true),
				},
					chevron(settledOpen ? "dshwmb-term-schev dshwmb-term-schev-open" : "dshwmb-term-schev"),
					h("span", null, fill(t("terminal.panel.sectionSettled"), { count: String(settled.length) }))),
				h("button", {
					type: "button",
					className: "dshwmb-term-section-clear",
					"aria-label": t("terminal.panel.clearAria"),
					onClick: () => { void clearFinished(); },
				}, t("terminal.panel.clear")));
			const surface = h("div", {
				className: "dshwmb-term-surface",
				role: "dialog",
				tabIndex: -1,
				"aria-label": t("terminal.panel.label"),
				"data-dshwmb-term-menu": "true",
				ref: menuRef,
				style: pos === null
					? { visibility: "hidden", top: "0px", left: "0px" }
					: { top: `${pos.top}px`, left: `${pos.left}px`, maxHeight: `${pos.maxHeight}px` },
			},
				error !== "" ? h("div", { className: "dshwmb-term-error" }, error) : null,
				sessions.length === 0 ? h("div", { className: "dshwmb-term-empty" }, t("terminal.panel.empty")) : null,
				h("ul", { className: "dshwmb-term-body" },
					live.length > 0 ? section(t("terminal.panel.sectionLive")) : null,
					live.map(row),
					settled.length > 0 ? settledSection() : null,
					settledOpen ? settled.map(row) : null));
			const menu = open === true
				? typeof document !== "undefined" && createPortal !== undefined
					? createPortal(surface, document.body)
					: surface
				: null;
			return h("div", { className: "dshwmb-term-root", ref: rootRef },
				h("button", {
					ref: triggerRef,
					type: "button",
					className: "dshwmb-term-trigger",
					"aria-expanded": open,
					"aria-haspopup": "dialog",
					"aria-label": countLabel,
					onClick: () => { setNow(Date.now()); setPos(null); setOpen((current) => current !== true); },
				},
					// The header mark reads as a shell prompt (`>_`), matching what the panel
					// lists; the live count beside it already says whether anything runs.
					h("span", { className: "dshwmb-term-glyph", "aria-hidden": "true" },
						h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
							strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" },
							h("path", { d: "M3.5 4.5 7 8l-3.5 3.5" }),
							h("path", { d: "M8.5 11.5h4" }))),
					h("span", { className: "dshwmb-term-count" }, countLabel),
					chevron(open === true ? "dshwmb-term-chev-trigger dshwmb-term-chev-trigger-open" : "dshwmb-term-chev-trigger")),
				menu);
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
			safely("terminal session panel", () => {
				let connection;
				try {
					connection = ctx.get?.("connection");
				} catch {
					connection = undefined;
				}
				if (typeof connection?.rpc?.call !== "function") return;
				ctx.effect(
					() =>
						ctx.slots.inject("conversation.session.header.actions", () =>
							ctx.slots.register(
								{
									name: "conversation.session.header.actions",
									id: `${PACKAGE_NAME}:terminal-sessions`,
									// After the job list (order 20): background work keeps its place in
									// the band, and a session panel is not work that started first.
									order: 30,
									locale: NS,
									inject: () => ({ connection }),
								},
								TerminalHeaderAction,
							),
						),
					"dsh-win-multi-bash: terminal session panel",
				);
			});
			// THE SSH AUTHORIZATION CARD. A conversation.composer CHAIN entry at priority 0:
			// it claims only this bundle's own pending host authorizations and returns null
			// for everything else, so the platform's shared approval composer (priority 1)
			// keeps the standard card. Answering goes through the pending request's own
			// answer(), i.e. the host's existing session-grant path: no new RPC.
			safely("ssh approval card", () => {
				if (typeof ctx.slots?.inject !== "function" || typeof ctx.slots?.register !== "function") return;
				ctx.effect(
					() => ctx.slots.inject("conversation.composer", () => ctx.slots.register(
						{
							name: "conversation.composer",
							priority: 0,
							select: (props) => sshApprovalMatch(props?.pendingInteraction),
							locale: NS,
							inject: () => ({
								resolver: (text) => (typeof ctx.locale?.resolveText === "function" ? ctx.locale.resolveText(text) : undefined),
							}),
						},
						SshApprovalCard,
					)),
					"dsh-win-multi-bash: ssh approval card",
				);
			});
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
		const __internals = () => ({ NS, APPROVAL_GATED_TOOL_NAMES, sshApprovalMatch, sshApprovalReason, SshApprovalCard, HOST_FIELDS, DEFAULT_SHELL_TEMPLATE, blankHostRow, hostRowsFrom, hostObjectFromRow, hostObjectsFrom, hostDraftFrom, hostRowErrors, hostsValueProblem, HostsEditor, testHostConnection, markHostApprovalScope, clearHostApprovalScope, callSessionEndpoint, ROWS, CORE_ROW, CORE_ROW_ID, rowKey, at, has, coerce, sameValue, plannedOp, planOps, RowConfigForm, RowConfigCard, CoreNote, ownedPage, installStyles, PACKAGE_NAME, STYLE_ID, en, zh, SHELL_TOOL_NAMES, TERMINAL_TOOL_NAME, CARD_PRIMITIVES, ToolCard, toolCardBody, toolCardIo, terminalBody, terminalLabels, cardTitle, shellCard, shellExitLabel, shellStatus, displayCwd, normalizeSegments, recordedAbsoluteCwd, fill, UNSETTLED_NOTICE, cardSummary, cardState, cardOutput, cardInput, parseCardArgs, firstLine, CSS });
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
