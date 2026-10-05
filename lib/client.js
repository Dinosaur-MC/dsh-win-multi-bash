/**
 * dsh-win-multi-bash — browser half.
 *
 * The two tool rows carry their own configuration (`enableRunInBackground` plus
 * the backend partition: paths, sandbox stance, probe timeout, sandbox
 * hardening, and the executor's command limits). This module gives each row a
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
 * The form is staged, not live: a control writes nothing until **Save**, a save
 * is fenced by the revision its drafts were read at, and a save the Host refuses
 * keeps its drafts. See `dsh-settings` for the projection and the mutation
 * contract, and `dsh-client-ui-plugin-manager` for the slots.
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
			summary: "Configure the Git Bash and WSL tool rows: paths, sandbox stance, and command limits.",
			coreBadge: "core row",
			coreNote: "This plugin is three rows: its core row and one row per tool (git_bash, wsl_bash). Configure each tool on its own row. Keep the core row enabled — it serves this page and owns the shared shell prompt section; with it off the tools still run and carry that guidance in their own descriptions, but the Configure controls on this page disappear.",
			unavailable: "This row is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving…",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			"option.auto": "auto",
			"option.none": "none",
			"option.bwrap": "bwrap",
			"enableRunInBackground.label": "Background jobs",
			"enableRunInBackground.hint": "Whether this tool accepts run_in_background. The tool schema carries this argument, so it follows the row's next load.",
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
		};
		/** Simplified Chinese copy. */
		const zh = {
			summary: "配置 Git Bash 与 WSL 两个工具行：路径、沙箱立场与命令限制。",
			coreBadge: "核心行",
			coreNote: "本插件共三行：核心行 + 每个工具一行（git_bash、wsl_bash）。工具各自在自己的行上配置。请保持核心行开启——本页由它提供，共有的那段 shell 提示词也归它所有；关掉后工具照旧可用（共有指导回落到各自的描述里），但本页的配置入口会消失。",
			unavailable: "该行当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			save: "保存",
			saving: "保存中…",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidNumber: "请填数字；留空表示使用默认值。",
			"option.auto": "自动",
			"option.none": "不限制",
			"option.bwrap": "bwrap",
			"enableRunInBackground.label": "后台任务",
			"enableRunInBackground.hint": "该工具是否接受 run_in_background；该参数属于工具 schema，需该行下次加载后生效。",
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
		/** The knobs every backend shares: the executor's own command limits. */
		const limitFields = (partition) => [
			field([partition, "cwd"], "text"),
			field([partition, "timeoutMs"], "number"),
			field([partition, "maxTimeoutMs"], "number"),
			field([partition, "maxOutputBytes"], "number"),
			field([partition, "maxSpillBytes"], "number"),
			field([partition, "graceMs"], "number"),
		];
		/** What the two tool rows expose, in form order. */
		const ROWS = [
			{
				rowId: "win-mb-tool-git",
				fields: [
					field(["enableRunInBackground"], "boolean"),
					...limitFields("gitBash"),
					field(["gitBash", "bashPath"], "text"),
					field(["gitBash", "sandbox"], "enum", ["auto", "none"]),
					field(["gitBash", "probeTimeoutMs"], "number"),
					field(["gitBash", "requireSandbox"], "boolean"),
				],
			},
			{
				rowId: "win-mb-tool-wsl",
				fields: [
					field(["enableRunInBackground"], "boolean"),
					...limitFields("wslBash"),
					field(["wslBash", "wslPath"], "text"),
					field(["wslBash", "wslDistro"], "text"),
					field(["wslBash", "sandbox"], "enum", ["auto", "none", "bwrap"]),
					field(["wslBash", "probeTimeoutMs"], "number"),
					field(["wslBash", "requireSandbox"], "boolean"),
				],
			},
		];
		/** The slot key of one row's page: `<package name>#<row id>`. */
		const rowKey = (rowId) => `dsh-win-multi-bash#${rowId}`;
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
			return String(draft);
		}
		/**
		 * The ordered writes one save sends: a clear for every reset and a set for
		 * every staged value. A draft no control accepts contributes no write —
		 * the form still blocks the save, rather than dropping the edit.
		 * @param fields - the row's knobs.
		 * @param staged - field key → `{ op: 'set', draft }` or `{ op: 'unset' }`.
		 * @returns the path ops `mutate` takes.
		 */
		function planOps(fields, staged) {
			const ops = [];
			for (const knob of fields) {
				const entry = staged.get(knob.key);
				if (entry === undefined) continue;
				if (entry.op === "unset") {
					ops.push({ op: "unset", path: knob.path });
					continue;
				}
				const value = coerce(knob.kind, entry.draft);
				if (value === undefined) continue;
				ops.push({ op: "set", path: knob.path, value });
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
					return {
						key: knob.key,
						kind: knob.kind,
						path: knob.path,
						options: knob.options,
						text,
						value: shown,
						checked: shown === true,
						// A staged draft answers for itself, so the badge previews the save.
						overridden: staged === undefined ? has(snapshot.user, knob.path) : staged.op === "set",
						invalid: knob.kind === "number" && text.trim().length > 0 && !Number.isFinite(Number(text.trim())),
					};
				});
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable === true,
					dirty: this.staged.size > 0,
					invalid: fields.some((entry) => entry.invalid),
					saving: this.saving,
					failed: this.failed,
					fields,
				};
			}
			/** Stage one control's draft; an emptied text control stages a clear. */
			edit(key, draft) {
				const knob = this.row.fields.find((entry) => entry.key === key);
				if (knob === undefined) return;
				const empty = (knob.kind === "text" || knob.kind === "number") && String(draft).length === 0;
				this.staged.set(key, empty ? { op: "unset" } : { op: "set", draft });
				this.failed = false;
				this.store.publish();
			}
			/** Stage a clear, so saving lets the field re-inherit the composition layer. */
			resetField(key) {
				this.staged.set(key, { op: "unset" });
				this.failed = false;
				this.store.publish();
			}
			/** Drop every staged draft. */
			discard() {
				this.staged.clear();
				this.failed = false;
				this.store.publish();
			}
			/** Write every staged draft in one revision-fenced mutation. */
			async save() {
				const snapshot = this.scope.getSnapshot();
				const ops = planOps(this.row.fields, this.staged);
				if (snapshot.writable !== true || ops.length === 0) return;
				this.saving = true;
				this.failed = false;
				this.store.publish();
				let accepted = false;
				try {
					accepted = await this.scope.mutate(ops, snapshot.revision);
				} catch {
					accepted = false;
				}
				this.saving = false;
				if (accepted) this.staged.clear();
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
			const shared = {
				id: `win-mb-${knob.key.replace(/\./g, "-")}`,
				label: t(`${knob.key.split(".").pop()}.label`),
				hint: t(`${knob.key.split(".").pop()}.hint`),
				overridden: knob.overridden,
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: t("invalidNumber"),
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
			if (props.view === "summary") return t("summary");
			const state = props.useRowForm((snapshot) => snapshot);
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
		/** Install the stylesheet once, guarded for a host that serves this twice. */
		function installStyles() {
			if (typeof document === "undefined" || document.querySelector("style[data-plugin='dsh-win-multi-bash']") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-win-multi-bash";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		/**
		 * Give each tool row its Configure page on the Plugins page, while the host
		 * serves that row's settings namespace.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-win-multi-bash: dictionaries");
			installStyles();
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
		exports.__internals = { ROWS, rowKey, at, has, coerce, planOps, RowConfigForm, RowConfigCard, CoreBadge, CoreNote, ownedPage, CORE_ROW_ID, PACKAGE_NAME, en, zh };
		return module.exports;
	},
});
