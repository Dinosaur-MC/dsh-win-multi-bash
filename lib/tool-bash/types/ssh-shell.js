/**
 * The SSH tool instance: owns a {@link SshShellExecutor} outright and drives it
 * directly, exactly like the other dialect rows. Its tool name, Config
 * partition and model-facing facts all come from the registry entry
 * (`lib/shell-dialects.js`, dialect `ssh`) — this file states only its dialect.
 *
 * This is the COMMAND form of a remote shell: each call resolves a host alias,
 * takes its own exec channel on the connection pooled per host (ssh2 — no local
 * `ssh.exe` runs), runs one command through the host's shell template and reports
 * the exit status with stdout/stderr kept apart. It is NOT a terminal backend:
 * the terminal row carries local shells only, and a persistent remote PTY would
 * bypass the host-authorization gate.
 *
 * It also owns the hosts-table HTTP route (`/win-mb-ssh`) used by the Plugins page
 * for "Test connection" and the per-call approval-scope marker. Keeping that route
 * here is what lets a deployment without ssh2 load the terminal row at all.
 *
 * The row serves a SECOND tool from the same executor: `ssh_scp` (file transfer over
 * SFTP). One executor means one Config partition, one host registry and one
 * connection pool, so a command and a transfer reuse the same TCP connection.
 * @module dsh-win-multi-bash/tool-bash/ssh-shell
 */
import { SshShellExecutor } from "../../ssh-shell/index.js";
import { createHostsTool } from "../../ssh-shell/hosts-tool.js";
import { createScpTool } from "../../ssh-shell/scp-tool.js";
import { createHostsChannelRegistrar, createHostsDispatch } from "../../ssh-shell/hosts-route.js";
import { defineShellTool } from "./factory.js";
/** The SSH tool row: `ssh_shell` plus `ssh_scp`, both on this one executor. */
const tool = defineShellTool({
    dialectId: 'ssh',
    Executor: SshShellExecutor,
    // ssh_hosts reads the same registry but is NOT approval-gated (no dial): it is
    // registered as an extra tool without joining extraToolNames.
    extraTools: [createScpTool(), createHostsTool()],
});
export const name = tool.name;
export const inject = tool.inject;
export const Config = tool.Config;
/**
 * The row's apply: the family tool registration, then this row's OWN host route.
 *
 * The route is registered from the row that needs ssh2, never from the terminal
 * row: a local-shell row must not own SSH logic or its import graph.
 * @param ctx - the row context.
 * @param config - the resolved row config.
 */
export async function apply(ctx, config) {
    await tool.apply(ctx, config);
    const warn = (message) => ctx.logger?.warn?.(message);
    const dispatch = createHostsDispatch();
    const register = createHostsChannelRegistrar({ ctx, dispatch, warn });
    ctx.inject(['webServer', 'connection'], (hostCtx) => {
        register(hostCtx);
    });
}
