/**
 * The session authorization gate (spec §11).
 *
 * `ssh_shell` and `ssh_scp` may only use a host the human authorized for THIS
 * session. Grants live in memory, keyed by the Session object and a host fingerprint:
 *
 *  - `trusted` on the host entry pre-authorizes headless use (never a prompt);
 *  - `session` (the default) asks once per session through `ctx.approval` and
 *    remembers the answer for that session object only — never on disk, never
 *    across sessions, lost when the plugin reloads;
 *  - editing ANY connection field changes the fingerprint, so the old grant is gone.
 *
 * Every failure is ONE named error with `phase: 'approval'` and the host
 * description, so both tools reuse the same sentence (ssh_scp wraps it in its
 * structured result). No key material is ever logged.
 * @module dsh-win-multi-bash/ssh-shell/approval
 */

/** The approval service's only granting outcome (its closed vocabulary). */
const GRANT = 'allowed-once'

/**
 * The grant key for one host: alias + host + port + user + keyPath + passphraseEnv.
 *
 * Only the NAME of a passphrase environment variable is part of the fingerprint —
 * never a secret value. The separator cannot occur in a configured field, so two
 * different hosts never collide.
 * @param host - the normalized host entry.
 * @returns the fingerprint string (an in-memory key, never displayed).
 */
export function fingerprintOf(host) {
  return [
    String(host?.alias ?? ''),
    String(host?.host ?? ''),
    String(host?.port ?? ''),
    String(host?.user ?? ''),
    String(host?.keyPath ?? ''),
    String(host?.passphraseEnv ?? ''),
  ].join('\u0000')
}

/**
 * The `user@host:port` a human recognizes (the user half omitted when none is set).
 * @param host - the normalized host entry.
 * @returns the target string.
 */
export function hostTarget(host) {
  const user = typeof host?.user === 'string' && host.user !== '' ? `${host.user}@` : ''
  return `${user}${String(host?.host ?? '')}:${String(host?.port ?? '')}`
}

/**
 * One human sentence naming the alias and the target, reused in errors and logs.
 * @param host - the normalized host entry.
 * @returns the description.
 */
export function describeHost(host) {
  return `host "${String(host?.alias ?? '')}" (${hostTarget(host)})`
}

/**
 * A gate refusal: a named error carrying the phase, the alias and the host
 * description. The message is the family's single sentence; tools add no wording.
 */
export class ApprovalError extends Error {
  /**
   * @param host - the host that was refused.
   * @param detail - why the call may not proceed.
   * @param outcome - the approval outcome, or a gate-only reason.
   */
  constructor(host, detail, outcome) {
    super(`ssh: ${describeHost(host)} is not authorized for this session: ${detail}`)
    this.name = 'ApprovalError'
    this.phase = 'approval'
    this.alias = host?.alias
    this.outcome = outcome
  }
}

/** The fail-closed sentence used when there is nobody to answer. */
const UNAVAILABLE = 'no approval answerer is available, so the request failed closed; set approval: trusted on this host (a deployment setting) to pre-authorize headless use'

/**
 * The request reason: what is asked, what the grant covers, and the consequence.
 * @param host - the host being authorized.
 * @param toolName - the tool asking.
 * @returns the model-facing reason.
 */
function reasonFor(host, toolName) {
  return `${toolName} wants to use ${describeHost(host)}. Allowing this grants THIS session only — the grant lives in memory until the session ends, and editing any connection field (host, port, user, key path or passphrase variable) asks again. Every command or transfer on this host then runs with this account.`
}

/**
 * The human sentence the dedicated card shows.
 * @param host - the host being authorized.
 * @param toolName - the tool asking.
 * @returns the display reason.
 */
function displayReasonFor(host, toolName) {
  return `${toolName}: allow this session to use ${describeHost(host)}? The grant lasts until this session ends.`
}

/**
 * Build the gate.
 * @param options.request - `ctx.approval.request` (or a fake in tests).
 * @param options.logger - one-line sink; never receives key material.
 * @param options.policy - optional `(session) => 'ask' | 'never'` reader, so a
 *   deterministic "never" session rejects without asking at all.
 * @returns the gate (`authorize`) plus the fingerprint helper.
 */
export function createApprovalGate({ request, logger, policy } = {}) {
  /** Session -> Set<fingerprint>: the session's grants, in memory only. */
  const grants = new WeakMap()
  /** Session -> Map<fingerprint, Promise>: one in-flight ask per host and session. */
  const inFlight = new WeakMap()
  /**
   * Log one line, tolerating a sink that throws (logging is never fatal here).
   * @param level - 'info' or 'warn'.
   * @param text - the line (alias + target + tool only, no key material).
   */
  const say = (level, text) => {
    try {
      logger?.[level]?.(text)
    }
    catch {
      // A throwing logger must not change the authorization outcome.
    }
  }
  const granted = (session, fingerprint) => grants.get(session)?.has(fingerprint) === true
  /**
   * Record the session grant for one fingerprint.
   * @param session - the session object the grant belongs to.
   * @param fingerprint - the host fingerprint.
   */
  const remember = (session, fingerprint) => {
    let set = grants.get(session)
    if (set === undefined) {
      set = new Set()
      grants.set(session, set)
    }
    set.add(fingerprint)
  }

  /**
   * Authorize one use of one host in one session.
   *
   * Runs BEFORE any connection or channel: a call that cannot be authorized never
   * dials. Concurrent misses for the same host share ONE in-flight request.
   * @param options.session - the session the grant belongs to (required).
   * @param options.agent - the calling agent, when the tool has one (the approval
   *   service reads `agent.session`).
   * @param options.host - the normalized host entry.
   * @param options.toolName - `ssh_shell` or `ssh_scp`.
   * @param options.callId - the calling tool call, when known.
   * @param options.signal - the caller's abort signal.
   * @returns `{ granted: true }` when the host may be used.
   * @throws {ApprovalError} for every refusal.
   */
  async function authorize({ session, agent, host, toolName, callId, signal }) {
    if (host?.approval === 'trusted') return { granted: true, trusted: true }
    if (session === undefined || session === null) {
      throw new ApprovalError(host, UNAVAILABLE, 'unavailable')
    }
    const fingerprint = fingerprintOf(host)
    if (granted(session, fingerprint)) return { granted: true }
    if (typeof policy === 'function' && policy(session) === 'never') {
      say('warn', `ssh approval: rejected for ${describeHost(host)} because the session approval policy is "never"`)
      throw new ApprovalError(host, 'the session approval policy is "never", so the request was rejected without asking', 'rejected')
    }
    if (typeof request !== 'function') {
      say('warn', `ssh approval: unavailable for ${describeHost(host)} because no approval service is composed`)
      throw new ApprovalError(host, UNAVAILABLE, 'unavailable')
    }
    let pending = inFlight.get(session)
    if (pending === undefined) {
      pending = new Map()
      inFlight.set(session, pending)
    }
    const existing = pending.get(fingerprint)
    if (existing !== undefined) {
      await existing
      return { granted: true }
    }
    const ask = (async () => {
      say('info', `ssh approval: asking for ${describeHost(host)} (${toolName})`)
      let outcome
      try {
        outcome = await request({
          agent: agent ?? { session },
          toolName,
          callId,
          reason: reasonFor(host, toolName),
          displayReason: displayReasonFor(host, toolName),
          signal,
        })
      }
      catch (error) {
        // Fail closed, with the reason: a channel that cannot be asked is not a grant.
        say('warn', `ssh approval: the request for ${describeHost(host)} failed closed: ${String(error?.message ?? error)}`)
        throw new ApprovalError(host, `${UNAVAILABLE} (the approval request failed: ${String(error?.message ?? error)})`, 'unavailable')
      }
      if (outcome === GRANT) {
        remember(session, fingerprint)
        say('info', `ssh approval: allowed for this session: ${describeHost(host)} (${toolName})`)
        return
      }
      if (outcome === 'rejected') {
        say('warn', `ssh approval: rejected: ${describeHost(host)} (${toolName})`)
        throw new ApprovalError(host, 'the request was rejected', 'rejected')
      }
      if (outcome === 'cancelled') {
        say('warn', `ssh approval: cancelled: ${describeHost(host)} (${toolName})`)
        throw new ApprovalError(host, 'the request was cancelled before it was answered', 'cancelled')
      }
      say('warn', `ssh approval: unavailable: ${describeHost(host)} (${toolName})`)
      throw new ApprovalError(host, UNAVAILABLE, 'unavailable')
    })()
    pending.set(fingerprint, ask)
    try {
      await ask
      return { granted: true }
    }
    finally {
      // A later miss after a rejection must be able to ask again.
      pending.delete(fingerprint)
    }
  }

  return { authorize, fingerprintOf }
}
