/**
 * The SSH tool instance: owns a {@link SshShellExecutor} outright and drives it
 * directly, exactly like the other dialect rows. Its tool name, Config
 * partition and model-facing facts all come from the registry entry
 * (`lib/shell-dialects.js`, dialect `ssh`) — this file states only its dialect.
 *
 * This is the ONE-SHOT form of a remote shell: each call opens its own
 * connection, runs one command through the remote login shell and reports its
 * stdout/stderr and exit status. The PERSISTENT form is the `terminal` row,
 * which offers this dialect automatically because the declaration marks it
 * terminal-capable (`terminal: true`) — so neither this file nor the terminal
 * row has to name SSH anywhere.
 * @module dsh-win-multi-bash/tool-bash/ssh-shell
 */
import { SshShellExecutor } from "../../ssh-shell/index.js";
import { defineShellTool } from "./factory.js";
/** The SSH tool: owns the ssh backend. */
const tool = defineShellTool({
    dialectId: 'ssh',
    Executor: SshShellExecutor,
});
export const name = tool.name;
export const inject = tool.inject;
export const Config = tool.Config;
export const apply = tool.apply;
