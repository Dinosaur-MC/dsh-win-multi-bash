/**
 * The `ssh_scp` tool: file transfer over SFTP, on the SAME pooled connection the
 * row's `ssh_shell` tool already uses.
 *
 * One row, one executor, one Config partition, one pool: a command and a transfer
 * therefore reuse the same TCP connection, the same known_hosts verification and
 * (Plan 3) the same authorization gate. This module owns the tool's surface and its
 * request contract; the local-path policy ({@link resolveLocalPath}) and the SFTP
 * runner ({@link ScpRunner}) arrive as their own modules so each can be tested alone.
 *
 * ONE failure contract: every expected refusal — an unknown alias, a broken registry,
 * a bad remote path, a sandbox refusal, a stalled handshake, an SFTP failure — is a
 * STRUCTURED result (`{ ok: false, bytes, error: { phase, alias, message } }`), never a
 * raw throw. The only throw is the platform's abort, mirroring `ssh_shell`.
 *
 * Foreground only: a transfer is never registered as a job (spec §10).
 * @module dsh-win-multi-bash/ssh-shell/scp-tool
 */
import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { aliasParameterDescription, resolveSessionWorkdir, resolveStandingPolicySafe } from '../tool-bash/types/factory.js'
import { assertRemotePath } from './hosts.js'
import { resolveLocalPath } from './local-path.js'

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
 * (POSIX absolute, `/C:/...` on Windows OpenSSH — never a local `C:\\...` path), the
 * LOCAL path rule (the session workspace, and what danger-full-access changes), and
 * the interaction contract (foreground, non-interactive, own deadline).
 * @param aliasInfo - `{ aliases, error? }` from the row's registry.
 * @returns the description.
 */
function scpDescription(aliasInfo) {
  return 'Transfer a file or a directory tree between this machine and one host of this row\'s ssh registry, over SFTP on the same pooled connection `ssh_shell` uses. '
    + 'action "upload" sends localPath to remotePath; action "download" brings remotePath to localPath. '
    + 'LOCAL paths resolve against the session workspace and must stay inside it: a path outside is refused unless the effective sandbox mode is danger-full-access, which allows it and reports outsideWorkspace: true. '
    + 'REMOTE paths are absolute POSIX paths on the host — on a Windows OpenSSH host use the /C:/... drive form, never a C:\\... Windows path. '
    + 'recursive walks a directory tree (default false); a directory without recursive is an error. Empty directories are preserved. '
    + 'Transfers are foreground only (no run_in_background), non-interactive (no stdin and no TTY), and have their own deadline (default 5 minutes). '
    + 'The result is { ok, bytes, files?, error?, sandbox, outsideWorkspace? }; a failure names the alias and the phase and keeps the ssh2 message. '
    + aliasParameterDescription(aliasInfo)
}

/**
 * Attach the result's sandbox facts and the local-side disclosure.
 *
 * The transfer's REMOTE side is a remote effect, so the family fact is
 * `sandbox: { mode, remote: true }` exactly like a remote command — never a local
 * verdict. The LOCAL side genuinely was sandboxed, and when danger-full-access let it
 * leave the workspace the result says so (`outsideWorkspace: true`).
 * @param result - what the runner answered.
 * @param facts.mode - the effective sandbox mode.
 * @param facts.outsideWorkspace - whether the local path resolved outside the workspace.
 * @returns the tool's value, matching the output schema exactly.
 */
function scpResult(result, { mode, outsideWorkspace }) {
  const value = { ...result, sandbox: { mode, remote: true } }
  if (outsideWorkspace === true) value.outsideWorkspace = true
  return value
}

/**
 * One structured refusal, in the same shape every other failure uses.
 * @param phase - 'config' | 'sandbox' | 'connect' | 'sftp'.
 * @param alias - the alias the call named ('' when there is none).
 * @param message - the reason, verbatim.
 * @param mode - the effective sandbox mode, for the sandbox fact.
 * @returns the tool's value.
 */
function failureValue(phase, alias, message, mode) {
  return scpResult({ ok: false, bytes: 0, error: { phase, alias, message } }, { mode })
}

/**
 * The text one result renders to. It must cope with EVERY shape the schema allows:
 * a success with or without `files`, a failure, an abort.
 * @param _args - the call arguments (unused).
 * @param value - the result value.
 * @returns one content block.
 */
function renderScp(_args, value) {
  const sandbox = value?.sandbox
  // The remote fact describes the transfer's OTHER side, so it is true whenever the
  // schema carries it. The LOCAL-side sentence is only true once a local path was
  // actually resolved: a config/sandbox refusal never had a local side to describe.
  const remoteNote = sandbox === undefined ? '' : ' [sandbox: remote — the transfer\'s other side runs on the host]'
  const phase = value?.error?.phase
  const where = `${value?.outsideWorkspace === true ? 'OUTSIDE' : 'inside'} the workspace`
  // The local claim must match what actually happened: a transfer that never left
  // this machine (connect phase) only RESOLVED a local path; a refused path resolved
  // nothing at all, so it gets no note.
  const localNote = value?.ok === true || phase === 'sftp'
    ? ` (local side ${where})`
    : phase === 'connect'
      ? ` (local path resolved ${where})`
      : ''
  if (value?.ok === true) {
    const files = value.files === undefined ? '' : ` in ${value.files} file(s)`
    return [{ type: 'text', text: `transferred ${value.bytes} byte(s)${files}${localNote}${remoteNote}` }]
  }
  const error = value?.error
  if (error === undefined) return [{ type: 'text', text: `transfer failed${remoteNote}` }]
  const aborted = error.aborted === true ? ' (aborted)' : ''
  return [{ type: 'text', text: `transfer failed (${error.phase}, host "${error.alias}")${aborted}: ${error.message}${localNote}${remoteNote}` }]
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
      // The session's own sandbox policy — the same service and the same call shape the
      // shell tool uses; a deployment without it resolves `undefined` and the local-path
      // rule fails closed unless the caller already holds danger-full-access.
      const sandboxPolicy = ctx.sandboxPolicy
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
            description: 'Path on THIS machine. Relative paths resolve against the session workspace and must stay inside it (danger-full-access allows an outside path and reports outsideWorkspace: true).',
          },
          remotePath: {
            type: 'string',
            required: true,
            description: 'Absolute POSIX path on the remote host; on a Windows OpenSSH host use the /C:/... drive form (a C:\\... Windows path is refused).',
          },
          recursive: {
            type: 'boolean',
            description: 'Walk a directory tree, preserving empty directories. Defaults to false; a directory without it is an error.',
          },
          timeoutMs: {
            type: 'integer',
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
              sandbox: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  mode: { type: 'string', required: true },
                  remote: { type: 'boolean', required: true },
                },
              },
              outsideWorkspace: { type: 'boolean' },
            },
          },
          render: renderScp,
        },
        async execute(args, exec) {
          const policy = resolveStandingPolicySafe(sandboxPolicy, exec)
          const mode = typeof policy?.mode === 'string' && policy.mode.length > 0 ? policy.mode : 'workspace-write'
          const alias = typeof args.alias === 'string' ? args.alias : ''
          // The HOST comes first: a broken registry or an unknown alias is the truth a
          // caller needs, and it must not be masked by a path complaint about a transfer
          // that could never be addressed anywhere.
          let host
          try {
            // The same §8.1 host rule the shell tool applies, and the same registry
            // verdict: a broken registry or an unknown alias answers with its message.
            host = executor.hostFor({ alias: args.alias })
          }
          catch (error) {
            return failureValue('config', alias, error.message, mode)
          }
          let remotePath
          try {
            remotePath = assertRemotePath(args.remotePath)
          }
          catch (error) {
            return failureValue('config', alias, error.message, mode)
          }
          if (typeof args.localPath !== 'string' || args.localPath.trim().length === 0)
            return failureValue('config', alias, 'ssh_scp: localPath must be a non-empty path', mode)
          let resolved
          try {
            // The REAL session directory: the host's own resolved session cwd, never
            // the process cwd. On this row the policy may be absent (a remote row never
            // confines), in which case the helper falls back to the session header.
            const sessionCwd = await resolveSessionWorkdir(ctx, exec, policy?.workspaceRoot)
            resolved = resolveLocalPath({
              sessionCwd,
              requested: args.localPath,
              workspaceRoot: policy?.workspaceRoot,
              sandboxMode: mode,
            })
          }
          catch (error) {
            // A refused local path is a policy denial, not a malformed request.
            return failureValue('sandbox', alias, error.message, mode)
          }
          const result = await executor.transferRunner()[args.action === 'upload' ? 'upload' : 'download']({
            host,
            localPath: resolved.path,
            remotePath,
            recursive: args.recursive === true,
            timeoutMs: args.timeoutMs,
            signal: exec.signal,
          })
          if (result.error?.aborted === true) {
            // Cancellation is the one non-result: the platform's abort, exactly as
            // ssh_shell reports it.
            const error = new HarnessError('tool call aborted', TOOL_ABORTED)
            error.name = 'AbortError'
            throw error
          }
          return scpResult(result, { mode, outsideWorkspace: resolved.outsideWorkspace })
        },
      }))
    },
  }
}
