/**
 * The `ssh_scp` tool: file transfer over SFTP, on the SAME pooled connection the
 * row's `ssh_shell` tool already uses.
 *
 * One row, one executor, one Config partition, one pool: a command and a transfer
 * therefore reuse the same TCP connection, the same known_hosts verification and
 * (Plan 3) the same authorization gate. This module registers the tool's surface —
 * name, description, parameters, output schema, execute — and nothing else; the
 * local-path policy and the SFTP runner arrive as their own modules so each can be
 * tested on its own.
 *
 * Foreground only: a transfer is never registered as a job (spec §10).
 * @module dsh-win-multi-bash/ssh-shell/scp-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aliasParameterDescription } from '../tool-bash/types/factory.js'

/** The two directions, one enum: the model names the action, never a separate tool. */
const SCP_ACTIONS = ['upload', 'download']

/**
 * The spec's per-operation ceiling (5 minutes) when the caller names none.
 * @type {number}
 */
const DEFAULT_SCP_TIMEOUT_MS = 300_000

/**
 * The model-facing description of `ssh_scp`.
 *
 * The three facts a caller can get wrong are stated up front: the REMOTE path form
 * (POSIX absolute, `/C:/...` on Windows OpenSSH — never a local `C:\...` path), the
 * LOCAL path rule (the session workspace, and what danger-full-access changes), and
 * the interaction contract (foreground, non-interactive, own deadline).
 * @param aliasInfo - `{ aliases, error? }` from the row's registry.
 * @returns the description.
 */
function scpDescription(aliasInfo) {
  return 'Transfer a file or a directory tree between this machine and one host of this row\'s ssh registry, over SFTP on the same pooled connection `ssh_shell` uses. '
    + 'action "upload" sends localPath to remotePath; action "download" brings remotePath to localPath. '
    + 'LOCAL paths resolve against the session workspace and must stay inside it: a path outside is refused unless the effective sandbox mode is danger-full-access, which allows it and says so in the result. '
    + 'REMOTE paths are absolute POSIX paths on the host — on a Windows OpenSSH host use the /C:/... drive form, never a C:\\... Windows path. '
    + 'recursive walks a directory tree; a directory without recursive is an error. '
    + 'Transfers are foreground only (no run_in_background), non-interactive (no stdin and no TTY), and have their own deadline (default 5 minutes). '
    + 'The result is { ok, bytes, files?, error? }; a failure names the alias and the phase and keeps the ssh2 message. '
    + aliasParameterDescription(aliasInfo)
}

/**
 * The structured failure the transfer path returns (never a thrown raw ssh2 error).
 * @param phase - where it failed: config | connect | host-key | auth | sftp | timeout | aborted | disconnected.
 * @param alias - the host alias the call named (or the row's default), when known.
 * @param message - the ssh2/plugin message, kept verbatim.
 * @param extra - optional fields (`aborted`).
 * @returns the error object the output schema describes.
 */
function scpFailure(phase, alias, message, extra = {}) {
  return { phase, alias, message, ...extra }
}

/**
 * Build the second tool this row serves.
 *
 * `register` receives the row's ONE executor and registers a tool that reads its host
 * registry and pool — it builds no engine of its own.
 * @returns the descriptor `defineShellTool` calls after the shell tool is registered.
 */
export function createScpTool() {
  return {
    toolName: 'ssh_scp',
    async register(ctx, { executor }) {
      const aliasInfo = typeof executor.aliasChoices === 'function' ? executor.aliasChoices() : { aliases: [] }
      ctx.tools.register(defineTool({
        name: 'ssh_scp',
        description: scpDescription(aliasInfo),
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: SCP_ACTIONS,
            description: 'upload sends localPath to remotePath; download brings remotePath to localPath.',
          },
          // The SAME alias parameter the shell tool serves: one rule (a named alias, or
          // exactly one default host) for every call on this row.
          alias: { type: 'string', description: aliasParameterDescription(aliasInfo) },
          localPath: {
            type: 'string',
            required: true,
            description: 'Path on THIS machine. Relative paths resolve against the session workspace and must stay inside it (danger-full-access allows an outside path and says so).',
          },
          remotePath: {
            type: 'string',
            required: true,
            description: 'Absolute POSIX path on the remote host; on a Windows OpenSSH host use the /C:/... drive form.',
          },
          recursive: {
            type: 'boolean',
            description: 'Walk a directory tree. Without it, a directory is an error.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Per-operation deadline in milliseconds (default ' + DEFAULT_SCP_TIMEOUT_MS + '); expiry aborts the SFTP stream and reports a timeout naming the alias and phase.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              bytes: { type: 'integer', required: true },
              files: { type: 'integer' },
              error: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  phase: { type: 'string', required: true },
                  alias: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                  aborted: { type: 'boolean' },
                },
              },
            },
          },
          // The family renders ONE text block per result; a transfer says what moved
          // (bytes, files) or which host/phase failed, never a file's contents.
          render: (_args, value) => [{
            type: 'text',
            text: value.ok === true
              ? `transferred ${value.bytes} byte(s)${value.files === undefined ? '' : ` in ${value.files} file(s)`}`
              : `transfer failed (${value.error.phase}, host "${value.error.alias}"): ${value.error.message}`,
          }],
        },
        async execute(args, exec) {
          void exec
          // The host rule is this row's rule, so validation is the executor's, not a
          // second copy here: a named alias must exist, and an omitted one needs the
          // row's single default (spec §8.1).
          const host = executor.hostFor({ alias: args.alias })
          return {
            ok: false,
            bytes: 0,
            error: scpFailure('sftp', host.alias, 'the SFTP transfer engine is not wired yet (Plan 2, Task 4)'),
          }
        },
      }))
    },
  }
}
