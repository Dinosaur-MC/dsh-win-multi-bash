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
/**
 * Node half of the package row itself.
 *
 * The row carrying this module exists for one reason: the Web client's module
 * system discovers a browser half by resolving a Loader row's **bare package
 * specifier** to its `package.json` and reading `dsh.client` there
 * (client-modules' `locatePkgJson` → `exactPackageSpecifier`, which answers
 * `undefined` for a subpath). The three runtime rows this bundle inserts —
 * `dsh-win-multi-bash/tool-shell-prompt`, `.../tool-git-bash`,
 * `.../tool-wsl-bash` — are all subpaths, so none of them can carry the
 * declaration; without this row `lib/client.js` is never served and the tool
 * rows show no Configure page.
 *
 * The empty `apply` is the documented shape for such a row (dsh's own
 * companion page packages do the same): it holds a Loader row and does nothing
 * on the host side.
 */
export function apply() {}
