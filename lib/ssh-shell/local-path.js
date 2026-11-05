/**
 * Local-path policy for `ssh_scp`: which file on THIS machine a transfer may touch.
 *
 * A transfer's remote side is a remote effect (the local file sandbox says nothing
 * about it), but its LOCAL side is an ordinary file effect on this host — so it obeys
 * the session's sandbox mode exactly like a command would. This module is lexical on
 * purpose: it decides whether a path is inside the workspace by resolving it, not by
 * walking the filesystem (the transfer itself is the only fs access, and a pre-flight
 * stat or realpath would be a second, racier one).
 *
 * The refusal sentence is the family's standard one (`sandboxDenialMarker`), so a
 * denied path is recognizable as a policy denial rather than a bug in the transfer.
 * @module dsh-win-multi-bash/ssh-shell/local-path
 */
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'

/** The one mode that allows a local path outside the workspace (spec §10, §14). */
const FULL_ACCESS = 'danger-full-access'

/**
 * Whether `candidate` resolves inside `root`.
 *
 * `relative()` answers an absolute path when the two sides live on different volumes
 * (a second drive on Windows), and a leading `..` when the walk leaves the root —
 * those are the two escape shapes, and both are refused here.
 * @param root - the workspace root.
 * @param candidate - the absolute path to judge.
 * @returns true when the candidate is the root or below it.
 */
export function isInsideRoot(root, candidate) {
  if (typeof root !== 'string' || root.length === 0) return false
  const from = resolvePath(root)
  const to = resolvePath(candidate)
  // Windows paths are case-insensitive: C:\Work and c:\work are the same directory.
  const rel = process.platform === 'win32'
    ? relative(from.toLowerCase(), to.toLowerCase())
    : relative(from, to)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel.split(/[\\/]/)[0] !== '..'
}

/**
 * Resolve the LOCAL side of a transfer, under the session's sandbox rule.
 *
 * - A relative path resolves against the session's working directory (never the
 *   agent's imagination of it).
 * - A path inside the workspace is always allowed.
 * - A path outside is allowed only under `danger-full-access`, and the result SAYS so
 *   (`outsideWorkspace: true`); otherwise the call is refused with the family's
 *   sandbox-denial sentence. Never silently clamped to the root: a transfer that
 *   quietly wrote somewhere else would be worse than a refusal.
 * @param options.sessionCwd - the session's working directory.
 * @param options.requested - the caller's `localPath` argument.
 * @param options.workspaceRoot - the workspace root the sandbox policy reports.
 * @param options.sandboxMode - the effective mode (`workspace-write` when absent).
 * @returns `{ path, outsideWorkspace, mode }` — the absolute path to transfer.
 */
export function resolveLocalPath({ sessionCwd, requested, workspaceRoot, sandboxMode }) {
  if (typeof requested !== 'string' || requested.trim().length === 0)
    throw new Error('ssh_scp: localPath is required')
  const mode = typeof sandboxMode === 'string' && sandboxMode.length > 0 ? sandboxMode : 'workspace-write'
  const base = typeof sessionCwd === 'string' && sessionCwd.length > 0
    ? sessionCwd
    : typeof workspaceRoot === 'string' && workspaceRoot.length > 0 ? workspaceRoot : undefined
  if (base === undefined)
    throw new Error('ssh_scp: this session has no working directory to resolve localPath against')
  const path = isAbsolute(requested) ? resolvePath(requested) : resolvePath(base, requested)
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    // Without a root there is nothing to judge against: fail closed unless the caller
    // already holds the one mode that makes the question moot.
    if (mode === FULL_ACCESS) return { path, outsideWorkspace: true, mode }
    throw new Error(`${sandboxDenialMarker(mode)} ssh_scp: no workspace root is known for this session, so localPath "${requested}" cannot be judged inside it; run with danger-full-access to allow it`)
  }
  if (isInsideRoot(workspaceRoot, path)) return { path, outsideWorkspace: false, mode }
  if (mode === FULL_ACCESS) return { path, outsideWorkspace: true, mode }
  throw new Error(`${sandboxDenialMarker(mode)} ssh_scp: localPath "${requested}" resolves to "${path}", outside this session's workspace; a transfer may only touch files inside it (danger-full-access allows an outside path)`)
}
