/**
 * The SSH tool instance: owns a {@link SshShellExecutor} outright and drives it
 * directly, exactly like the other dialect rows. Its tool name, Config
 * partition and model-facing facts all come from the registry entry
 * (`lib/shell-dialects.js`, dialect `ssh`) — this file states only its dialect.
 *
 * This is the COMMAND form of a remote shell: each call resolves a host alias,
 * takes its own exec channel on the connection pooled per host (ssh2 — no local
 * `ssh.exe` runs), runs one command through the host's shell template and reports
 * the exit status with stdout/stderr kept apart. The PERSISTENT form is the
 * `terminal` row, which offers this dialect automatically because the declaration
 * marks it terminal-capable (`terminal: true`) — that form is the one that still
 * drives the OpenSSH client, through the row's single-host pins.
 *
 * The row serves a SECOND tool from the same executor: `ssh_scp` (file transfer over
 * SFTP). One executor means one Config partition, one host registry and one
 * connection pool, so a command and a transfer reuse the same TCP connection.
 * @module dsh-win-multi-bash/tool-bash/ssh-shell
 */
import { SshShellExecutor } from "../../ssh-shell/index.js";
import { createHostsTool } from "../../ssh-shell/hosts-tool.js";
import { createScpTool } from "../../ssh-shell/scp-tool.js";
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
export const apply = tool.apply;
