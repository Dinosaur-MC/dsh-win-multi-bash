/**
 * The Git Bash (MSYS) tool instance: owns a {@link GitBashExecutor} outright
 * and drives it directly. dsh 0.1.7 removed the shell seam's routing field
 * (`ShellExecRequest.shell`), so there is no shared selector to route through
 * any more — the tool itself is what knows it wants Git Bash.
 * @module dsh-win-multi-bash/tool-bash/git-bash
 */
import { GitBashExecutor } from "../../bash-git/index.js";
import { defineShellTool } from "./factory.js";
/** The Git Bash tool: owns the git-bash backend. */
const tool = defineShellTool({
    toolName: 'git_bash',
    Executor: GitBashExecutor,
    configKey: 'gitBash',
    dialect: 'msys',
});
export const name = tool.name;
export const inject = tool.inject;
export const Config = tool.Config;
export const apply = tool.apply;
//# sourceMappingURL=git-bash.js.map
