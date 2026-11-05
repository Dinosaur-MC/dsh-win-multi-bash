/**
 * Channel-open refusal retry (spec §5).
 *
 * An SSH server at its MaxSessions limit answers a new channel with
 * "administratively prohibited" (or refuses the session outright). That is a
 * TRANSIENT capacity refusal, not a failure of the command, so the row retries the
 * OPEN — never the command — with a bounded backoff, and reports the server's own
 * words when it gives up. Everything else (authentication, host keys, a lost
 * connection) is a real failure and is never retried here.
 * @module dsh-win-multi-bash/ssh-shell/retry
 */

/** The backoff steps, before the cap (spec §5: 100/200/400, capped at 1 s). */
export const RETRY_DELAYS_MS = [100, 200, 400]

/** No single backoff waits longer than this (spec §5). */
export const RETRY_DELAY_CAP_MS = 1000

/**
 * Total attempts allowed when the call has NO deadline (a background job, whose
 * lifetime is the job's, not a call's): four attempts, i.e. three backoffs.
 */
export const BACKGROUND_RETRY_ATTEMPTS = 4

/** The one pattern set that identifies a channel-open refusal. */
const REFUSAL_PATTERN = /administratively prohibited|channel open failure|open failed|MaxSessions|resource shortage|no more sessions/i

/**
 * Whether an error is a channel-open refusal worth retrying.
 *
 * Deliberately narrow: a timeout, an encrypted-key failure or a dropped connection
 * must reach the caller unchanged instead of being retried into a longer wait.
 * @param error - the underlying client error.
 * @returns true when the server refused the OPEN for capacity.
 */
export function isChannelRefusal(error) {
  const text = typeof error === 'string' ? error : String(error?.message ?? '')
  return REFUSAL_PATTERN.test(text)
}

/**
 * Whether a refused SFTP SUBSYSTEM request should be retried.
 *
 * ssh2 collapses the reason for a refused session into this one message for
 * `client.sftp()`, so the channel-open text above never reaches the caller: a
 * MaxSessions refusal and "sftp is not enabled" look identical here. The transfer
 * therefore retries this message a BOUNDED number of times (never until the whole
 * deadline), which rides out a capacity refusal and still ends promptly on a
 * permanent one — reporting the server's words either way.
 * @param error - the underlying client error.
 * @returns true when the subsystem request was refused.
 */
export function isSubsystemRefusal(error) {
  const text = typeof error === 'string' ? error : String(error?.message ?? '')
  return /unable to start subsystem/i.test(text)
}

/**
 * The backoff after the given number of failed attempts (1-based).
 * @param failures - how many attempts have failed so far.
 * @returns the delay in milliseconds, capped.
 */
export function retryDelayMs(failures) {
  const raw = RETRY_DELAYS_MS[failures - 1]
  return Math.min(raw === undefined ? RETRY_DELAY_CAP_MS : raw, RETRY_DELAY_CAP_MS)
}

/**
 * The error for a cancellation that arrived before any command ran (an abort during
 * the open/backoff wait). It carries the family's AbortError name so the tool layer
 * reports the same abort as a caller cancellation.
 * @returns the error to throw.
 */
export function abortedBeforeStart() {
  const error = new Error('ssh-shell: the call was aborted before the command started')
  error.name = 'AbortError'
  return error
}

/**
 * The error for a run of refusals that will not be retried again: the LAST server
 * refusal verbatim, wrapped with the alias and the open phase, plus why the retrying
 * stopped. Never a synthesized "timed out": the command never ran.
 */
export class ChannelRefusalExhausted extends Error {
  /**
   * @param alias - the host alias.
   * @param lastRefusal - the server's last refusal.
   * @param note - why retrying stopped (deadline or attempt budget).
   */
  constructor(alias, lastRefusal, note) {
    const detail = lastRefusal === undefined
      ? 'no channel could be opened'
      : String(lastRefusal?.message ?? lastRefusal)
    super(`ssh-shell: host "${alias}" could not open an exec channel: ${detail}${note === undefined ? '' : ` (${note})`}`)
    this.name = 'ChannelRefusalExhausted'
  }
}
