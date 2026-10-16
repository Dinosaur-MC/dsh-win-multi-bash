/**
 * The MSYS2 tool instance: owns a {@link Msys2BashExecutor} outright and drives
 * it directly, exactly like the other dialect rows. Its tool name, Config
 * partition and model-facing facts all come from the registry entry
 * (`lib/shell-dialects.js`, dialect `msys2`) — this file states only its
 * dialect.
 * @module dsh-win-multi-bash/tool-bash/msys2-bash
 */
import { Msys2BashExecutor } from "../../bash-msys2/index.js";
import { defineShellTool } from "./factory.js";
/** The MSYS2 tool: owns the msys2-bash backend. */
const tool = defineShellTool({
    dialectId: 'msys2',
    Executor: Msys2BashExecutor,
});
export const name = tool.name;
export const inject = tool.inject;
export const Config = tool.Config;
export const apply = tool.apply;
