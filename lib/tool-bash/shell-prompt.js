/**
 * Deprecated `win-mb-shell-prompt` row (`dsh-win-multi-bash/tool-shell-prompt`).
 *
 * The family's shared prompt section used to be owned by a row of its own; the
 * package row owns it now, because a row whose only effect is "state this
 * guidance somewhere else" is a switch that can only ever make the composition
 * worse. Keeping the row declared while the new owner also registers would
 * register the same section name twice — which throws — so this module
 * registers the section **only while the package row is absent**, which is
 * exactly the old wiring, and logs the one migration step otherwise.
 *
 * A profile updated by re-running `install.ps1` (its managed block is replaced
 * by marker) drops this row, and the bundle patch that ships with the package
 * no longer inserts it. Until then the old wiring keeps working: the section is
 * still registered once for the family, and the tool descriptions stay slim.
 * @module dsh-win-multi-bash/tool-shell-prompt
 */
import {
    SHELL_FAMILY_SECTION_NAME,
    SHELL_FAMILY_ROW_SPECIFIER,
    familyRowComposed,
    shellFamilySectionOrder,
    shellFamilySectionTextFor,
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
    const owner = familyRowComposed(ctx);
    ctx.logger?.warn?.(`dsh-win-multi-bash: the win-mb-shell-prompt row is obsolete — "${SHELL_FAMILY_ROW_SPECIFIER}" now owns the shared shell prompt section. Re-run install.ps1 (or delete the row) to drop this one.`);
    // The package row owns the section whenever it is composed (and the modern
    // wiring is the default, so an unknown answer keeps this row inert too).
    if (owner !== false) return;
    ctx.systemPrompt.section({
        name: SHELL_FAMILY_SECTION_NAME,
        order: shellFamilySectionOrder(ctx.systemPrompt),
        text: ({ scope }) => shellFamilySectionTextFor(ctx, scope),
    });
}
