// dsh-win-multi-bash — self-contained Windows multi-bash plugin.
//
// This package carries the whole feature implementation, bundled from the
// DeepSeek Harness project's shell packages (see THIRD_PARTY_NOTICES),
// compiled to plain ESM JS:
//
//   lib/bash-git/       — GitBashExecutor (MSYS / Git for Windows)
//   lib/bash-wsl/       — WslBashExecutor (WSL distros, base64 payloads)
//   lib/tool-bash/      — defineShellTool factory + git_bash / wsl_bash
//                         instances, each owning its own executor
//                         (types/backend.js) instead of sharing the ctx.shell
//                         seat: dsh 0.1.7 removed ShellExecRequest.shell, the
//                         routing field the old shell-select design used.
//   lib/tool-bash/shell-prompt.js
//                       — the shared prompt section's single owner row.
//   lib/vendor/         — helpers.js (bash-sandbox classification, including the
//                         anchored runner-failure rule the base runtime does
//                         not export) and bwrap-profiles.js (bwrap rules/args).
//   lib/client.js       — the browser half: the Plugins page's configuration
//                         form for the two tool rows.
//
// Only published @deepseek-ai base packages are imported (dsh-shell,
// dsh-sandbox, dsh-bash-local, dsh-tools, dsh-llm, ...), so the plugin runs
// on any standard deployment — no additional runtime packages required.
//
// The composition wiring lives in cordis.patch.yml.
import {
    SHELL_FAMILY_SECTION_NAME,
    shellFamilySectionOrder,
    shellFamilySectionTextFor,
} from './tool-bash/types/shell-family.js';

/** Row name; the Loader also uses it for logging and for the prompt-section owner. */
export const name = 'dsh-win-multi-bash';

/**
 * `systemPrompt` is the registry the family section belongs to; `tools` is read
 * at every assembly so the section can describe exactly the shell tools this
 * composition mounts. Without a tools registry there are no such tools, and the
 * row correctly never applies.
 */
export const inject = ['systemPrompt', 'tools'];

/**
 * The package row — the plugin's core row.
 *
 * It exists because the Web client's module system discovers a browser half by
 * resolving a Loader row's **bare package specifier** to its `package.json` and
 * reading `dsh.client` there (client-modules' `locatePkgJson` →
 * `exactPackageSpecifier`, which answers `undefined` for a subpath). The tool
 * rows this bundle inserts are subpaths, so none of them can carry that
 * declaration; without this row `lib/client.js` is never served and the tool
 * rows show no Configure page.
 *
 * It is also the owner of the one prompt section the bash family shares
 * (`tool:win-mb-bash`), which is why it is not an empty `apply` any more: the
 * section used to live in a row of its own, and merging the two removes a
 * switch that could only ever make the composition worse. The section's text is
 * resolved per assembly, so a composition that switched every tool row off
 * mounts no family tool and this section then contributes no text at all.
 */
export function apply(ctx) {
    ctx.systemPrompt.section({
        name: SHELL_FAMILY_SECTION_NAME,
        order: shellFamilySectionOrder(ctx.systemPrompt),
        text: ({ scope }) => shellFamilySectionTextFor(ctx, scope),
    });
}
