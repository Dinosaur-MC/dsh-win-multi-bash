// dsh-win-multi-bash — self-contained Windows multi-bash plugin.
//
// This package carries the whole feature implementation, bundled from the
// DeepSeek Harness project's shell packages (see THIRD_PARTY_NOTICES),
// compiled to plain ESM JS:
//
//   lib/shell-select/   — ShellSelectExecutor (the ctx.shell selector)
//   lib/bash-git/       — GitBashExecutor (MSYS / Git for Windows)
//   lib/bash-wsl/       — WslBashExecutor (WSL distros, base64 payloads)
//   lib/tool-bash/      — defineShellTool factory + git_bash / wsl_bash instances
//   lib/vendor/         — helpers.js (bash-sandbox classification) and
//                         bwrap-profiles.js (bwrap rules/args) — the two
//                         helper modules not exported by the base runtime.
//
// Only published @deepseek-ai base packages are imported (dsh-shell,
// dsh-sandbox, dsh-pwsh-sandbox, dsh-tools, dsh-llm, ...), so the plugin runs
// on any standard deployment — no additional runtime packages required.
//
// The composition wiring lives in cordis.patch.yml.
export {}
