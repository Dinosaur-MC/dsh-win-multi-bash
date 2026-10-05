/**
 * The `win-mb-shell-prompt` row: the single owner of the shell family's shared
 * prompt section (see ./types/shell-family.js for why one owner, and why the
 * text is a function of the mounted tools).
 *
 * It owns no tool and no executor — it exists so the guidance git_bash and
 * wsl_bash have in common is registered once for the composition instead of
 * once per tool, while both tools stay independently switchable.
 * @module dsh-win-multi-bash/tool-bash/shell-prompt
 */
import {
    SHELL_FAMILY_SECTION_NAME,
    SHELL_FAMILY_TOOL_NAMES,
    shellFamilySectionOrder,
    shellFamilySectionText,
} from './types/shell-family.js';

export const name = 'tool-shell-prompt';

/**
 * `systemPrompt` is the registry the section belongs to; `tools` is read at
 * assembly time to decide what the section may claim, so this row must apply
 * only once the registry exists. Without a tools registry there are no shell
 * tools to describe and the row correctly never applies.
 */
export const inject = ['systemPrompt', 'tools'];

export function apply(ctx) {
    ctx.systemPrompt.section({
        name: SHELL_FAMILY_SECTION_NAME,
        order: shellFamilySectionOrder(ctx.systemPrompt),
        text: ({ scope }) => {
            const mounted = SHELL_FAMILY_TOOL_NAMES
                .map((toolName) => ctx.tools.get(toolName, scope))
                .filter((definition) => definition !== undefined);
            // No family tool in this composition: the guidance would describe
            // nothing, and an empty section is dropped from the rendered prompt.
            if (mounted.length === 0)
                return '';
            const advertises = (parameter) => mounted.some((definition) => definition.parameters?.properties?.[parameter] !== undefined);
            return shellFamilySectionText({
                background: advertises('run_in_background'),
                escalation: advertises('sandbox_permissions'),
            });
        },
    });
}
