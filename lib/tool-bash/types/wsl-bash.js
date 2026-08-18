/**
 * The WSL bash tool instance: routes `request.shell` to the 'wsl-bash'
 * backend so a selector executor can serve it beside pwsh and Git Bash.
 * @module @deepseek-ai/dsh-tool-bash/wsl-bash
 */
import { defineShellTool } from "./factory.js";
/** The WSL bash tool: routes request.shell to the 'wsl-bash' backend. */
const tool = defineShellTool({ toolName: 'wsl_bash', shell: 'wsl-bash', dialect: 'wsl' });
export const name = tool.name;
export const inject = tool.inject;
export const Config = tool.Config;
export const apply = tool.apply;
//# sourceMappingURL=wsl-bash.js.map