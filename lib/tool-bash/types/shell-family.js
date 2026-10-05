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
 *  - The section has exactly one owner — the `tool-shell-prompt` row — because
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

/** The tool names this plugin contributes to the shell family. */
export const SHELL_FAMILY_TOOL_NAMES = ['git_bash', 'wsl_bash'];

/**
 * The single prompt section carrying the family's shared guidance. Named for
 * the plugin's tool family rather than for one tool, so neither git_bash nor
 * wsl_bash owns it.
 */
export const SHELL_FAMILY_SECTION_NAME = 'tool:win-mb-bash';

/** Fresh-shell fact plus the `workdir` rule that replaces a persistent `cd`. */
const SHELL_CALL_SECTION = 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`.';

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
 * @returns the section text, with no fact stated twice.
 */
export function shellFamilySectionText({ background, escalation }) {
    return [
        SHELL_CALL_SECTION,
        SHELL_EXIT_STATUS_SECTION,
        SHELL_HARNESS_FACTS_SECTION,
        SHELL_SANDBOX_SECTION,
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
 * Whether the row that owns the shared shell prompt section is composed and
 * enabled. The tool descriptions carry only their dialect facts on the
 * assumption that section states the rest, so this is worth knowing: without
 * that row the shared guidance would silently vanish from the prompt.
 *
 * The Loader tree lists declared rows with their effective enablement before
 * they activate, so the answer does not depend on row order. A loader that
 * cannot be read answers `undefined` (treat as composed) — the default
 * composition has the row, and guessing the other way would duplicate prose.
 * @param ctx - a context that can reach the Loader (a row's own context).
 * @returns true/false when known, `undefined` when the loader is unreadable.
 */
export function familyRowComposed(ctx) {
    const loader = ctx.get?.('loader') ?? ctx.loader;
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
export function shellFamilySectionTextFor(ctx, scope) {
    const mounted = SHELL_FAMILY_TOOL_NAMES
        .map((toolName) => ctx.tools.get(toolName, scope))
        .filter((definition) => definition !== undefined);
    if (mounted.length === 0) return '';
    const advertises = (parameter) => mounted.some((definition) => definition.parameters?.properties?.[parameter] !== undefined);
    return shellFamilySectionText({
        background: advertises('run_in_background'),
        escalation: advertises('sandbox_permissions'),
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
export function composeToolDescription({ own, familyPresent, background, escalation }) {
    if (familyPresent !== false) return own;
    return `${own} ${shellFamilySectionText({ background, escalation })}`;
}

/**
 * Midpoint of the two placements dsh centrally allocates to shell tools, so the
 * family section sorts between `tool:bash` and `tool:pwsh` instead of ahead of
 * every other section. Resolved from the registry rather than hardcoded; the
 * literals below are only the fallback for a registry that stopped exposing
 * both names (the midpoint of TOOL_BASH 1000 / TOOL_PWSH 1010 at the time of
 * writing).
 * @param systemPrompt - the prompt registry the section is registered on.
 * @returns a finite order value strictly between TOOL_BASH and TOOL_PWSH.
 */
export function shellFamilySectionOrder(systemPrompt) {
    const bash = systemPrompt.getSectionOrder('TOOL_BASH');
    const pwsh = systemPrompt.getSectionOrder('TOOL_PWSH');
    if (Number.isFinite(bash) && Number.isFinite(pwsh) && pwsh > bash)
        return (bash + pwsh) / 2;
    if (Number.isFinite(bash))
        return bash + 1;
    if (Number.isFinite(pwsh))
        return pwsh - 1;
    return 1005;
}
