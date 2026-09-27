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
//   lib/vendor/         — helpers.js (bash-sandbox classification, including the
//                         anchored runner-failure rule the base runtime does
//                         not export) and bwrap-profiles.js (bwrap rules/args).
//
// Only published @deepseek-ai base packages are imported (dsh-shell,
// dsh-sandbox, dsh-bash-local, dsh-tools, dsh-llm, ...), so the plugin runs
// on any standard deployment — no additional runtime packages required.
//
// The composition wiring lives in cordis.patch.yml.
export {}
