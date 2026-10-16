/**
 * Read-only derivations of the shell dialect registry for the host half.
 *
 * `lib/shell-dialects.js` is the single source; this module is the shape the
 * host code, the composition and the audit consume. Nothing here holds a
 * dialect list of its own — every export below is computed from the registry at
 * load, and a violation of the registry's invariants refuses to load (see
 * `validateShellDialects`).
 *
 * Why this is a separate module from the registry: the browser half must stay
 * importable by dsh's client module loader (one CommonJS factory whose `require`
 * only reaches boot-graph specifiers), so it carries a *generated* copy of the
 * form rows instead of importing anything. The audit regenerates that copy from
 * here and fails on any byte difference — that guard is what keeps the browser
 * half from silently drifting.
 * @module dsh-win-multi-bash/tool-bash/registry
 */
import {
    EXECUTOR_LIMIT_FIELDS,
    PACKAGE_NAME,
    REGISTRY_ERROR_PREFIX,
    SHELL_DIALECTS,
    SHELL_FAMILY_SECTION_NAME,
    TERMINAL_FIELDS,
    TERMINAL_ROW,
    TOOL_LAYER_FIELDS,
    clientRows,
    dialectById,
    dialectFacts,
    exportSubpaths,
    familyToolNames,
    leafRules,
    patchRows,
    terminalBackends,
    terminalRows,
    validateShellDialects,
} from '../../shell-dialects.js';

export {
    EXECUTOR_LIMIT_FIELDS,
    PACKAGE_NAME,
    REGISTRY_ERROR_PREFIX,
    SHELL_DIALECTS,
    SHELL_FAMILY_SECTION_NAME,
    TERMINAL_FIELDS,
    TERMINAL_ROW,
    TOOL_LAYER_FIELDS,
    clientRows,
    dialectById,
    dialectFacts,
    exportSubpaths,
    familyToolNames,
    leafRules,
    patchRows,
    terminalBackends,
    terminalRows,
    validateShellDialects,
};

/** Refuse to load a composition whose registry cannot describe itself. */
validateShellDialects();

/** Facts per dialect key, as `shellDescription` reads them. */
export const DIALECT_FACTS = dialectFacts();

/** The tool names the shared family prompt section speaks for. */
export const SHELL_FAMILY_TOOL_NAMES = familyToolNames();

/** The browser half's form rows (the generated copy must equal this). */
export const CLIENT_ROWS = clientRows();

/** Leaf → syntax rule for the browser half's visible warnings. */
export const LEAF_RULES = leafRules();

/** The rows `cordis.patch.yml` must declare, in composition order. */
export const PATCH_ROWS = patchRows();

/** The `package.json` `exports` map these rows load code through. */
export const EXPORT_SUBPATHS = exportSubpaths();

/**
 * The dialects an interactive session may be opened in, in composition order.
 * The `terminal` tool's `shell` argument is exactly this list, so a shell the
 * registry does not declare can never be asked for.
 */
export const TERMINAL_BACKENDS = terminalBackends();

/** The terminal row's form fields (the browser half's generated copy must equal this). */
export const TERMINAL_ROWS = terminalRows();

/**
 * The tool instances the composition registers: the dialect's tool name, the
 * module the Loader loads, and the config partition that tool owns. This is the
 * table the audit iterates instead of naming git_bash / wsl_bash by hand.
 */
export const TOOL_INSTANCES = SHELL_DIALECTS.map((dialect) => ({
    id: dialect.id,
    toolName: dialect.toolName,
    rowId: dialect.rowId,
    configKey: dialect.configKey,
    specifier: dialect.specifier,
    entry: dialect.entry,
    label: dialect.label,
    sandboxStances: [...dialect.sandboxStances],
    argvStyle: dialect.argvStyle,
    win32Only: dialect.win32Only,
    executor: { ...dialect.executor },
    resolve: { ...dialect.resolve },
}));
