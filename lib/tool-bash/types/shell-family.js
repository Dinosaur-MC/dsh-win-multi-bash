/**
 * The shared half of the shell guidance: what every shell tool call in this
 * composition has in common, stated once for the whole family.
 *
 * Why the split exists (measured on 0.3.1: the two tool descriptions were 1299
 * and 2164 characters, 1117 of them byte-identical, and the same exit-status
 * paragraph was registered twice — once per tool instance):
 *  - A tool description is ambient only while that tool is mounted, so it can
 *    carry only what belongs to that tool. Anything the family shares belongs
 *    in one prompt section; anything dialect-specific (shell name, path form,
 *    MSYS note) stays with its own tool.
 *  - The section has exactly one owner — the package row itself, the row whose
 *    name is `SHELL_FAMILY_ROW_SPECIFIER` — because
 *    prompt sections live in one global layer keyed by name: two rows
 *    registering the same name throw, and two names carrying the same text are
 *    the duplication this module exists to remove.
 *  - Its text is a function of the tools actually mounted
 *    (`ctx.tools.get(name, scope)`, read at every assembly), which is what
 *    keeps git_bash and wsl_bash independently switchable: any subset — either
 *    one, both, or neither — renders exactly one correct copy, and a
 *    composition with neither renders nothing at all.
 *  - dsh's own tool-pwsh description repeats some of this prose and is not ours
 *    to edit. This section stays self-sufficient on purpose: our tools must
 *    carry their full guidance whether or not pwsh is in the composition, so we
 *    never read facts out of another row's description.
 * @module dsh-win-multi-bash/tool-bash/shell-family
 */
import { SHELL_FAMILY_SECTION_NAME, familyToolNames, remoteFamilyToolNames } from '../../shell-dialects.js';

/**
 * The tool names this plugin contributes to the shell family, and the name of
 * the one section that speaks for them — both derived from the dialect
 * registry (`lib/shell-dialects.js`), which is the only place that says which
 * shells exist. The section is named for the family rather than for one tool,
 * and the registry refuses to load a dialect whose tool name appears inside it.
 */
export const SHELL_FAMILY_TOOL_NAMES = familyToolNames();
export { SHELL_FAMILY_SECTION_NAME };

/**
 * The family tools whose file effects happen on another host (effects: remote).
 *
 * Static for the life of the module -- the registry is data -- so it is resolved
 * once here rather than rebuilt on every prompt assembly, which happens on every
 * request.
 */
const REMOTE_FAMILY_TOOL_NAMES = remoteFamilyToolNames();

/** Fresh-shell fact plus the `workdir` rule that replaces a persistent `cd`. */
const SHELL_CALL_SECTION = 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`.';

/**
 * The argument-ordering convention the whole family shares. dsh's own
 * `tool-bash` / `tool-pwsh` state it in their descriptions (and order their
 * schema properties the same way: `description` first, `command` second), so
 * the family tools state it once here rather than once per tool — a fact
 * stated here is stated only here, which is also what keeps it from being
 * repeated inside the tool descriptions this section exists to slim down.
 */
export const SHELL_ARGUMENT_ORDER_SECTION = 'Provide `description` before `command` in the arguments.';

/**
 * Cross-call exit-status guidance. It belongs in the prompt rather than the
 * tool schema because the trap is not about one call's arguments but about how
 * a multi-step command is composed: `;` never stops on failure, and a pipeline
 * reports only its last command's status — so the reflex of bounding long
 * output with `| tail`, which this runtime already truncates for the caller,
 * returns `tail`'s status instead of the command's.
 */
export const SHELL_EXIT_STATUS_SECTION = 'Check the [exit code: N] marker on every bash result; investigate failures before moving on. Chain dependent steps with `&&` or `set -o pipefail`: `;` never stops on failure, and `cmd | tail` returns the status of `tail`, not of `cmd`.';

/** Managed `$DSH_*` environment facts are the same for every shell tool. */
const SHELL_HARNESS_FACTS_SECTION = 'Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed.';

/** The confinement marker one shared classifier produces for every dialect. */
const SHELL_SANDBOX_SECTION = 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way.';

/**
 * The counterpart of {@link SHELL_SANDBOX_SECTION} for a dialect whose shell is
 * not on this machine.
 *
 * The sandbox sentence is a promise about the LOCAL file effects of the command
 * this host runs. For a remote dialect there are none to promise, so the section
 * must say the opposite rather than let a model read a local sandbox claim over
 * a command that executes elsewhere — and it must not invent a verdict for the
 * remote side either, which is why it names the structured fact instead.
 */
export const SHELL_REMOTE_SCOPE_SECTION = 'A shell that lives on another host runs outside this host\'s file sandbox: no sandbox verdict is claimed for it — its result carries `sandbox.remote: true` — and this host\'s `$DSH_*` facts do not cross the connection.';

/** Retention contract: the runtime truncates, so no call needs to bound output itself. */
const SHELL_OUTPUT_SECTION = 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.';

/** Path-safety rules shared by every dialect (MSYS, Linux, and pwsh alike). */
const SHELL_PATH_SAFETY_SECTION = 'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`.';

/** Advertised only while some mounted family tool offers `run_in_background`. */
export const SHELL_BACKGROUND_SECTION = 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.';

/**
 * The same-turn escalation guidance appended after a denial marker. Kept in one
 * place because every dialect shares the exact approval contract, and included
 * only while some mounted family tool advertises `sandbox_permissions`. The
 * opening clause names that dependency because the section speaks for the whole
 * family: a tool that advertises no such parameter has nothing to escalate
 * with, and its own schema is what says so.
 */
export const SHELL_ESCALATION_SECTION = 'Where a shell tool advertises `sandbox_permissions`: attempting a command the sandbox may deny is safe and expected — run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.';

/**
 * Compose the family section from the facts that hold for the mounted set.
 * @param advertised - what the mounted family tools advertise this composition.
 * @param advertised.background - some mounted family tool offers `run_in_background`.
 * @param advertised.escalation - some mounted family tool offers `sandbox_permissions`.
 * @param advertised.localSandbox - some mounted family tool runs its command on THIS
 *   host, so the file-sandbox contract is true for at least one mounted tool
 *   (default `true`: a composition that says nothing about remote shells keeps the
 *   sandbox sentence it has always had).
 * @param advertised.remote - some mounted family tool runs its command on ANOTHER
 *   host, which adds {@link SHELL_REMOTE_SCOPE_SECTION} and can drop the local
 *   sandbox sentence (default `false`).
 * @param advertised.harnessFacts - this composition actually forwards the managed
 *   `$DSH_*` facts to the child (a `shellEnv` service is composed). Default
 *   `true`: a caller that says nothing keeps the sentence it has always had, and
 *   only a definite "no service" drops it — the section must never promise
 *   variables the child will not receive.
 * @returns the section text, with no fact stated twice.
 */
export function shellFamilySectionText({ background, escalation, localSandbox = true, remote = false, harnessFacts = true }) {
    return [
        SHELL_ARGUMENT_ORDER_SECTION,
        SHELL_CALL_SECTION,
        SHELL_EXIT_STATUS_SECTION,
        ...harnessFacts ? [SHELL_HARNESS_FACTS_SECTION] : [],
        ...localSandbox ? [SHELL_SANDBOX_SECTION] : [],
        ...remote ? [SHELL_REMOTE_SCOPE_SECTION] : [],
        SHELL_OUTPUT_SECTION,
        SHELL_PATH_SAFETY_SECTION,
        ...background ? [SHELL_BACKGROUND_SECTION] : [],
        ...escalation ? [SHELL_ESCALATION_SECTION] : [],
    ].join(' ');
}

/**
 * The Loader specifier of the row that owns the family section. After the row
 * merge that is the package row itself — the row whose `name` is the bare
 * package specifier, which is also the row the Web client needs in order to
 * find `dsh.client` and serve the browser half. Exported so the tool rows can
 * tell whether that owner is composed: the section is the only carrier of the
 * shared guidance, and the tool descriptions were slimmed on that assumption,
 * so their absence has to be detected rather than assumed away.
 */
export const SHELL_FAMILY_ROW_SPECIFIER = 'dsh-win-multi-bash';

/**
 * Whether the owner row registered the section in **this module instance**.
 * The Loader-name heuristic below is a declaration-site guess; this is the
 * registered fact, set by the row right after `systemPrompt.section()` returns
 * and cleared by its disposer. It answers `true` only when the section is
 * genuinely mounted, so it can never make a tool description slimmer than the
 * prompt it relies on — it only rescues compositions the name heuristic cannot
 * read (a hand-wired row whose `name` is not the bare package specifier, e.g.
 * `dsh-win-multi-bash/lib/index.js`). The module is shared by the package row
 * and both tool rows (one file, one instance), which is what makes the flag
 * visible across them.
 */
let familySectionOwnerRegistered = false;

/**
 * Record that the owner row's section registration is live (or has been
 * disposed). Called by the owner row only; exported because that row is a
 * different entry file of this package.
 * @param registered - whether the section is currently registered.
 */
export function markFamilySectionOwner(registered) {
    familySectionOwnerRegistered = registered;
}

/**
 * Whether the row that owns the shared shell prompt section is composed and
 * enabled. The tool descriptions carry only their dialect facts on the
 * assumption that section states the rest, so this is worth knowing: without
 * that row the shared guidance would silently vanish from the prompt.
 *
 * The Loader tree lists declared rows with their effective enablement before
 * they activate, so the answer does not depend on row order. A loader that
 * cannot be read answers `undefined` (treat as composed) — the default
 * composition has the row, and guessing the other way would duplicate prose.
 *
 * Residual limits, both on the conservative side except where noted:
 *  - The name heuristic accepts only the bare package specifier
 *    ({@link SHELL_FAMILY_ROW_SPECIFIER}). A row wired by path is invisible to
 *    it; the registered-flag check above covers that case whenever the owner
 *    row has applied first, but a *tool* row that applies before a path-wired
 *    owner still reads `false` and repeats the shared guidance in its own
 *    description (duplication, never loss). Wiring the row by its bare package
 *    name — which the Web client needs anyway — avoids this entirely.
 *  - The answer is taken once, at the tool row's apply. A live
 *    enable/disable of the owner row after that does not recompute the
 *    description; dsh's own tools re-register on such changes
 *    (`ctx.inject` + a fresh `tools.register`), which this factory does not
 *    do. The window is HMR-only: a fresh boot recomputes.
 * @param ctx - a context that can reach the Loader (a row's own context).
 * @returns true/false when known, `undefined` when the loader is unreadable.
 */
export function familyRowComposed(ctx) {
    if (familySectionOwnerRegistered) return true;
    // Probe-safe: `ctx.get('loader')` throws on a live context that does not provide
    // the service, and the dotted fallback (`ctx.loader`) throws the same way. A row
    // that cannot read the loader must answer `undefined`, never fail its own apply.
    let loader;
    try {
        loader = ctx.get?.('loader');
    } catch {
        loader = undefined;
    }
    if (loader === undefined) {
        // The property form is how a plain mock (and an older composition) exposes it;
        // reading it can throw on a live context, which is not a row failure.
        try {
            loader = ctx.loader;
        } catch {
            return undefined;
        }
    }
    if (loader === undefined || typeof loader.entries !== 'function') return undefined;
    for (const entry of loader.entries()) {
        if (entry.options?.name !== SHELL_FAMILY_ROW_SPECIFIER) continue;
        return entry.disabled !== true;
    }
    return false;
}

/**
 * The family section text for one assembly, resolved from the tools actually
 * mounted: it states nothing about a tool that is not there (a tool that
 * advertises no `sandbox_permissions` also gets no escalation paragraph), and
 * with no family tool mounted it renders no text at all — the section is then
 * empty and dropped from the rendered prompt.
 * @param ctx - a context with the `tools` service.
 * @param scope - the assembly scope `tools.get` takes.
 * @returns the section text, or `''` when this composition mounts no family tool.
 */
/**
 * Whether this composition forwards the managed `$DSH_*` facts to a child.
 *
 * Probed, not injected: the sentence must not promise variables the child will
 * not receive, and a context without the probe API (the audit's mocks) falls back
 * to the plain property.
 * @param ctx - the context the section is being assembled for.
 * @returns true when a `shellEnv` service with `collect` is reachable.
 */
export function probeHarnessFacts(ctx) {
    try {
        const service = ctx.get?.('shellEnv') ?? ctx.shellEnv;
        return typeof service?.collect === 'function';
    }
    catch {
        return false;
    }
}
export function shellFamilySectionTextFor(ctx, scope) {
    // Probed, not injected: the registry owner row is the one that must survive a
    // composition without this service, and a missing registry can only mean
    // "no family tool is mounted", which the empty result already says. The direct
    // property is the fallback for a context whose shape predates the probe API
    // (the audit's mocks), never for a proxied one — that read is guarded.
    let tools;
    try {
        tools = ctx.get?.('tools') ?? ctx.tools;
    }
    catch {
        tools = undefined;
    }
    if (typeof tools?.get !== 'function') return '';
    // The name is kept beside the definition: remote-ness is a property of the
    // DIALECT, not of the definition a mounted tool registers, so it can only be
    // read from the registry that declares it. That mapping is static, so it is
    // resolved once per module load instead of once per prompt assembly.
    const mounted = SHELL_FAMILY_TOOL_NAMES
        .map((toolName) => ({ toolName, definition: tools.get(toolName, scope) }))
        .filter((entry) => entry.definition !== undefined);
    if (mounted.length === 0) return '';
    const advertises = (parameter) => mounted.some((entry) => entry.definition.parameters?.properties?.[parameter] !== undefined);
    const remoteNames = REMOTE_FAMILY_TOOL_NAMES;
    return shellFamilySectionText({
        background: advertises('run_in_background'),
        escalation: advertises('sandbox_permissions'),
        // An all-remote set gets NO local sandbox sentence, and a mixed set gets
        // both — which is exactly the composition the section speaks for.
        localSandbox: mounted.some((entry) => !remoteNames.includes(entry.toolName)),
        remote: mounted.some((entry) => remoteNames.includes(entry.toolName)),
        harnessFacts: probeHarnessFacts(ctx),
    });
}

/**
 * One tool's model-facing description. Normally that is only its dialect facts —
 * the family section carries the rest once for the whole composition. When the
 * owning row is **not** composed (a user switched it off, or wired a subset of
 * the patch by hand), the shared text falls back into this description instead,
 * so the model never silently loses the exit-marker, sandbox, truncation,
 * path-safety, background and escalation guidance. The duplicated prose is the
 * price of that fallback, and it only exists in a configuration that has no
 * section at all.
 * @param own - the dialect-owned description from {@link shellDescription}.
 * @param familyPresent - whether the section's owning row is composed and enabled;
 *   only a definite `false` falls back, because an unknown state must never
 *   duplicate prose the section would also state.
 * @param advertised - what this tool advertises, as {@link shellFamilySectionText} takes.
 * @returns the description to register.
 */
export function composeToolDescription({ own, familyPresent, background, escalation, localSandbox, remote, harnessFacts }) {
    if (familyPresent !== false) return own;
    return `${own} ${shellFamilySectionText({ background, escalation, localSandbox, remote, harnessFacts })}`;
}

/**
 * Midpoint of the two placements dsh centrally allocates to shell tools, so the
 * family section sorts between `tool:bash` and `tool:pwsh` instead of ahead of
 * every other section. Resolved from the registry rather than hardcoded; the
 * literals below are only the fallback for a registry that stopped exposing
 * both names (the midpoint of TOOL_BASH 1000 / TOOL_PWSH 1010 at the time of
 * writing).
 *
 * `getSectionOrder` is a dsh-internal registry API, so it is feature-detected
 * and never allowed to throw. This runs inside the core row's `apply`, i.e. at
 * boot, on the very row that also carries the browser half — and the order
 * only decides *placement*, never behavior, so a deployment whose registry
 * moved or dropped the call must degrade to the fallback instead of failing
 * the row. Plugins that pass the registry's runtime smoke use the same shape
 * (`typeof registry.getSectionOrder !== 'function'` → branch away).
 * @param systemPrompt - the prompt registry the section is registered on.
 * @returns a finite order value strictly between TOOL_BASH and TOOL_PWSH.
 */
export function shellFamilySectionOrder(systemPrompt) {
    const read = (name) => {
        if (systemPrompt === null || systemPrompt === undefined || typeof systemPrompt.getSectionOrder !== 'function') return undefined;
        try {
            return systemPrompt.getSectionOrder(name);
        } catch {
            return undefined;
        }
    };
    const bash = read('TOOL_BASH');
    const pwsh = read('TOOL_PWSH');
    if (Number.isFinite(bash) && Number.isFinite(pwsh) && pwsh > bash)
        return (bash + pwsh) / 2;
    if (Number.isFinite(bash))
        return bash + 1;
    if (Number.isFinite(pwsh))
        return pwsh - 1;
    return 1005;
}
