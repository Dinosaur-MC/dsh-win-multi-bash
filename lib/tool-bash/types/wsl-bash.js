/**
 * The WSL bash tool instance: owns a {@link WslBashExecutor} outright and
 * drives it directly. dsh 0.1.7 removed the shell seam's routing field
 * (`ShellExecRequest.shell`), so there is no shared selector to route through
 * any more — the tool itself is what knows it wants WSL.
 * @module dsh-win-multi-bash/tool-bash/wsl-bash
 */
import { WslBashExecutor } from "../../bash-wsl/index.js";
import { defineShellTool } from "./factory.js";
/** The WSL bash tool: owns the wsl-bash backend. */
const tool = defineShellTool({
    // The dialect id is the whole declaration: tool name, Config partition and
    // model-facing facts all come from the registry entry (`lib/shell-dialects.js`).
    dialectId: 'wsl',
    Executor: WslBashExecutor,
});
export const name = tool.name;
export const inject = tool.inject;
export const Config = tool.Config;
export const apply = tool.apply;
//# sourceMappingURL=wsl-bash.js.map
