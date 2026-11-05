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

import { DEFAULT_APPROVAL_TIMEOUT_MS } from './hosts.js'

/**
 * A host's effective approval ceiling: ONLY 0 means wait forever; a negative,
 * fractional or out-of-range value falls back to the default instead of disabling
 * the timer.
 * @param host - a host entry (normalized or not).
 * @returns the timeout in ms (0 = no timer).
 */
function approvalTimeoutOf(host) {
  const value = host?.approvalTimeoutMs
  if (value === 0) return 0
  return Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : DEFAULT_APPROVAL_TIMEOUT_MS
}

/** The approval service's only granting outcome (its closed vocabulary). */
const GRANT = 'allowed-once'

/** How long a marked approval scope stays usable (the card is answered immediately, but be generous). */
export const ONE_SHOT_TTL_MS = 10 * 60 * 1000

/** The upper bound on marked call ids, so an unattended page cannot grow the map forever. */
export const ONE_SHOT_MAX = 256

/** The scopes an approval may be marked with: session-cached, or this call only. */
export const APPROVAL_SCOPES = ['once', 'session']

/** callId -> { scope, at }; consumed by the gate, TTL-pruned, and capped. */
const approvalScopes = new Map()

/** Drop expired entries and the oldest overflow beyond the cap. */
function pruneScopes(now) {
  for (const [callId, entry] of approvalScopes) if (now - entry.at > ONE_SHOT_TTL_MS) approvalScopes.delete(callId)
  while (approvalScopes.size > ONE_SHOT_MAX) approvalScopes.delete(approvalScopes.keys().next().value)
}

/**
 * Record how the pending approval is being answered: `once` (this call only) or
 * `session` (the gate may cache it). The mark is keyed by the platform call id.
 * @param callId - the platform tool-call id the approval belongs to.
 * @param scope - 'once' or 'session'.
 * @param now - the clock (injectable for the TTL/cap tests).
 * @returns whether a mark was recorded (a callId and a strict scope are required).
 */
export function markApprovalScope(callId, scope, now = Date.now()) {
  if (typeof callId !== 'string' || callId === '' || callId.length > 256) return false
  if (!APPROVAL_SCOPES.includes(scope)) return false
  pruneScopes(now)
  approvalScopes.set(callId, { scope, at: now })
  // Prune AFTER the insert too, so the map can never exceed the cap.
  pruneScopes(now)
  return true
}

/**
 * Drop the scope marked for this call, if any (used when the card's answer fails so
 * a stale mark cannot be consumed by a later, different answer). Only this key is
 * touched.
 * @param callId - the platform tool-call id.
 * @returns whether a mark existed.
 */
export function clearApprovalScope(callId) {
  if (typeof callId !== 'string' || callId === '') return false
  return approvalScopes.delete(callId)
}

/**
 * Consume the scope marked for this call, if any. A miss touches nothing else:
 * it must not evict unrelated (still pending) marks.
 * @param callId - the platform tool-call id.
 * @param now - the clock (injectable for the TTL test).
 * @returns 'once' | 'session' | undefined.
 */
export function consumeApprovalScope(callId, now = Date.now()) {
  if (typeof callId !== 'string' || callId === '') return undefined
  const entry = approvalScopes.get(callId)
  if (entry === undefined) return undefined
  approvalScopes.delete(callId)
  return now - entry.at > ONE_SHOT_TTL_MS ? undefined : entry.scope
}

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

/** A gate call without a session to authorize against (its own sentence, not "no answerer"). */
const NO_SESSION = 'no session context is available, so this host cannot be authorized for a session'

/** A gate call without the agent the approval service routes and audits under. */
const NO_AGENT = 'no agent context is available, so the approval request cannot be addressed'

/** The caller handed an agent and a session that disagree (a wiring mistake). */
const MISMATCH = 'the agent and the session disagree, so the request cannot be audited and cached under one session'

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
  // The platform's display copy is a localized record (`{ en, <locale>: … }`), not a
  // bare sentence: the shared card resolves it through the client locale, and our
  // own card falls back to `en`. The AUDIT reason above stays plain text.
  return { en: `${toolName}: allow this session to use ${describeHost(host)}? The grant lasts until this session ends.` }
}

/**
 * Build the gate.
 * @param options.request - `ctx.approval.request` (or a fake in tests).
 * @param options.logger - one-line sink; never receives key material.
 * @param options.policy - optional `(session) => 'ask' | 'never'` reader, so a
 *   deterministic "never" session rejects without asking at all.
 * @param options.setTimeout - the approval-timeout timer (injectable for tests).
 * @param options.clearTimeout - the matching cancel (injectable for tests).
 * @returns the gate (`authorize`) plus the fingerprint helper.
 */
export function createApprovalGate({ request, logger, policy, setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout } = {}) {
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
    if (typeof session !== 'object' || session === null) {
      throw new ApprovalError(host, NO_SESSION, 'unavailable')
    }
    const fingerprint = fingerprintOf(host)
    // A cached grant needs neither an agent nor a live answerer: nothing is asked.
    if (granted(session, fingerprint)) return { granted: true }
    let sessionPolicy = 'ask'
    if (typeof policy === 'function') {
      try {
        sessionPolicy = policy(session)
      }
      catch (error) {
        // A policy reader that cannot answer must fail closed, not escape as a
        // TypeError from inside the gate.
        throw new ApprovalError(host, `the session approval policy could not be read: ${String(error?.message ?? error)}`, 'unavailable')
      }
    }
    if (sessionPolicy === 'never') {
      say('warn', `ssh approval: rejected for ${describeHost(host)} because the session approval policy is "never"`)
      throw new ApprovalError(host, 'the session approval policy is "never", so the request was rejected without asking', 'rejected')
    }
    if (typeof agent !== 'object' || agent === null) {
      // Never fabricate a principal: the approval service routes and audits under
      // the agent it is given, so asking without one would ask as nobody.
      throw new ApprovalError(host, NO_AGENT, 'unavailable')
    }
    if (agent.session !== session) {
      // The audit trail (agent.session) and the grant store (session) must be the
      // SAME session object; a wiring mistake here would authorize one session while
      // remembering the grant for another.
      throw new ApprovalError(host, MISMATCH, 'unavailable')
    }
    if (typeof request !== 'function') {
      say('warn', `ssh approval: unavailable for ${describeHost(host)} because no approval service is composed`)
      throw new ApprovalError(host, UNAVAILABLE, 'unavailable')
    }
    const cancelledError = () => new ApprovalError(host, 'the request was cancelled before it was answered', 'cancelled')
    // Private sentinel: the WAITER'S own signal aborted. It must be distinguishable from
    // an owner whose request resolved `cancelled` (which makes the waiter ask for itself).
    const WAITER_ABORT = Symbol('ssh-approval-waiter-abort')
    /** Wait for a shared ask, but let THIS caller's own abort settle the wait as cancelled. */
    const awaitShared = (promise) => {
      if (signal === undefined) return promise
      if (signal.aborted) return Promise.reject(WAITER_ABORT)
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(WAITER_ABORT)
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
          (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
          (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
        )
      })
    }
    // Ask, or wait for the ask already in flight for this host+session. The in-flight
    // entry carries the GRANT SCOPE: a one-shot approval belongs to the call that asked
    // for it, so a waiter behind it must run its OWN request instead of inheriting the
    // grant. A waiter behind a session approval may reuse it.
    for (;;) {
      if (granted(session, fingerprint)) return { granted: true }
      let pending = inFlight.get(session)
      if (pending === undefined) {
        pending = new Map()
        inFlight.set(session, pending)
      }
      const existing = pending.get(fingerprint)
      if (existing !== undefined) {
        let shared
        try {
          shared = await awaitShared(existing)
        }
        catch (error) {
          // A timed-out owner does NOT hand the waiter a fresh prompt: the waiter gets
          // the same timeout verdict.
          if (error instanceof ApprovalError && error.outcome === 'timeout') {
            if (pending.get(fingerprint) === existing) pending.delete(fingerprint)
            throw error
          }
          // THIS waiter was aborted: fail it, but never remove the owner's in-flight ask.
          // (An owner's `cancelled` outcome is NOT this sentinel: the waiter asks itself.)
          if (error === WAITER_ABORT) throw cancelledError()
          // Simultaneous abort + owner-cancel: the owner's rejection can win the
          // microtask race before our abort listener runs, so re-check the signal
          // BEFORE dropping the shared ask and starting a new prompt.
          if (signal?.aborted) throw cancelledError()
          // The owner's request failed or was refused; this caller asks for itself.
          if (pending.get(fingerprint) === existing) pending.delete(fingerprint)
          continue
        }
        if (shared?.scope === 'session') return { granted: true }
        // A once-scoped approval was consumed for the owner's call. Drop the in-flight
        // entry (so this caller's ask is a real new request) and go around again.
        if (pending.get(fingerprint) === existing) pending.delete(fingerprint)
        continue
      }
      const ask = (async () => {
        say('info', `ssh approval: asking for ${describeHost(host)} (${toolName})`)
        const approvalTimeoutMs = approvalTimeoutOf(host)
        let outcome
        let timer
        let timedOut = false
        let requestSignal = signal
        let timeoutController
        let unwireCombined
        if (approvalTimeoutMs > 0) {
          timeoutController = new AbortController()
          // Withdraw the pending card by aborting the request; keep the caller's own
          // abort wired in. Prefer AbortSignal.any; when it is unavailable, build the
          // combined controller ourselves so a timeout still aborts the request.
          if (signal === undefined) requestSignal = timeoutController.signal
          else if (typeof AbortSignal.any === 'function') requestSignal = AbortSignal.any([signal, timeoutController.signal])
          else {
            const combined = new AbortController()
            const onCallerAbort = () => combined.abort(signal.reason)
            if (signal.aborted) combined.abort(signal.reason)
            else signal.addEventListener('abort', onCallerAbort, { once: true })
            const onTimeoutAbort = () => combined.abort()
            timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true })
            unwireCombined = () => {
              signal.removeEventListener('abort', onCallerAbort)
              timeoutController.signal.removeEventListener('abort', onTimeoutAbort)
            }
            requestSignal = combined.signal
          }
        }
        const timeoutError = () => new ApprovalError(host, `approval timed out after ${approvalTimeoutMs} ms`, 'timeout')
        try {
          if (approvalTimeoutMs > 0) {
            const timeoutPromise = new Promise((_resolve, reject) => {
              timer = setTimer(() => {
                timedOut = true
                // REJECT FIRST: a request stub that settles synchronously on abort must
                // not win the race against the timeout it caused. Abort LAST.
                reject(timeoutError())
                timeoutController.abort()
              }, approvalTimeoutMs)
            })
            outcome = await Promise.race([
              request({
                agent,
                toolName,
                callId,
                reason: reasonFor(host, toolName),
                displayReason: displayReasonFor(host, toolName),
                signal: requestSignal,
              }),
              timeoutPromise,
            ])
          }
          else {
            outcome = await request({
              agent,
              toolName,
              callId,
              reason: reasonFor(host, toolName),
              displayReason: displayReasonFor(host, toolName),
              signal: requestSignal,
            })
          }
        }
        catch (error) {
          if (timedOut === true) {
            say('warn', `ssh approval: timed out after ${approvalTimeoutMs} ms: ${describeHost(host)} (${toolName})`)
            throw timeoutError()
          }
          // Fail closed, with the reason: a channel that cannot be asked is not a grant.
          say('warn', `ssh approval: the request for ${describeHost(host)} failed closed: ${String(error?.message ?? error)}`)
          throw new ApprovalError(host, `${UNAVAILABLE} (the approval request failed: ${String(error?.message ?? error)})`, 'unavailable')
        }
        finally {
          if (timer !== undefined) clearTimer(timer)
          if (unwireCombined !== undefined) unwireCombined()
        }
        // TIMEOUT WINS even if the aborted request resolved (cancelled, or even
        // allowed-once) before the rejection was observed: no grant, no scope consume.
        if (timedOut === true) {
          say('warn', `ssh approval: timed out after ${approvalTimeoutMs} ms: ${describeHost(host)} (${toolName})`)
          throw timeoutError()
        }
        if (outcome === GRANT) {
          const scope = consumeApprovalScope(callId)
          if (scope === 'session') {
            remember(session, fingerprint)
            say('info', `ssh approval: allowed for this session: ${describeHost(host)} (${toolName})`)
            return { scope: 'session' }
          }
          // `once`, or an UNMARKED call: fail closed as one-shot. Never cache a grant
          // whose scope the card did not explicitly declare as session.
          say('info', `ssh approval: allowed ONCE (${scope === 'once' ? 'marked' : 'unmarked'}, not cached): ${describeHost(host)} (${toolName})`)
          return { scope: 'once' }
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
        // Only this owner's entry may be removed; a waiter may already have replaced it.
        if (pending.get(fingerprint) === ask) pending.delete(fingerprint)
      }
    }
  }

  return { authorize, fingerprintOf }
}
