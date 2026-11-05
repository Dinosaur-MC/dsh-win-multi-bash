/**
 * The ssh_shell transport pool: **one ssh2 client per host alias**, reused by every
 * call that names it.
 *
 * Why a pool rather than a connection per call (design §5, §7): a cold ssh2
 * handshake plus key authentication costs the network round trip and several
 * milliseconds of crypto, and the row's own lifetime is the right scope for a
 * credential; per-call channels on one connection are also what makes calls
 * parallel-safe and isolated (spec §8.4). The pool therefore:
 *
 *  - dials lazily, on the first call for an alias, and hands the SAME client to
 *    every later call (two concurrent first calls share one dial: the record is
 *    published before its ready promise is awaited);
 *  - verifies the host key through ./known-hosts.js on every dial — `ssh2`
 *    auto-accepts without a verifier, so a missing verifier would be the bug;
 *  - reads the private key from the configured path and the passphrase only from the
 *    environment variable the host names (never from config, never logged);
 *  - drops a client from the pool as soon as it errors or closes, so the next call
 *    dials again instead of being handed a dead socket;
 *  - closes every client on disposal.
 *
 * Deliberately absent: an idle timeout (the pool lives with the row, spec §7) and any
 * concurrency cap (ctx.jobs and the server's MaxSessions are the limits, spec §5).
 * @module dsh-win-multi-bash/ssh-shell/pool
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { defaultKnownHostsPath, verifyHostKey } from './known-hosts.js'

/** How often ssh2 probes the peer on an otherwise idle connection (spec §7). */
export const KEEPALIVE_INTERVAL_MS = 15_000

/** How many unanswered keepalives mark the connection lost (spec §7). */
export const KEEPALIVE_COUNT_MAX = 3

/** The whole handshake+auth ceiling when a host declares none (hosts.js supplies 30 s). */
export const DEFAULT_READY_TIMEOUT_MS = 30_000

/** The home directory a `~` path expands from, Windows first. */
function homeDir(env) {
  return env.USERPROFILE || env.HOME || homedir()
}

/**
 * Expand a leading `~` the way a shell would, and nothing else.
 *
 * Key paths are configuration, so a `~` is the only expansion a deployment can
 * reasonably expect; any other relative path is handed to the filesystem as the
 * deployment wrote it (and fails there, naming the path).
 * @param path - the configured path.
 * @param env - the environment to read (defaults to the process environment).
 * @returns the path to open.
 */
export function expandHome(path, env = process.env) {
  const text = String(path ?? '')
  if (text === '~') return homeDir(env)
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homeDir(env), text.slice(2))
  return text
}

/**
 * One host's connection state: the client, and the promise that settles when it is
 * ready. The record IS the pool entry, so a failed dial can be removed by identity.
 */
class SshPoolRecord {
  constructor(entry) {
    this.alias = entry.alias
    this.entry = entry
    this.client = undefined
    this.ready = undefined
    this.verdict = undefined
    /** How many calls currently hold a lease on this client (spec §5 sharing). */
    this.refs = 0
    /**
     * Retired records keep serving their own leases but take no new ones, so the
     * next call dials a fresh connection. They are closed when the last lease is
     * released — never torn down under a running command or transfer.
     */
    this.retired = false
  }
}

/**
 * The pool itself: alias -> record.
 */
export class SshPool {
  /**
   * @param options.knownHostsPath - the file to verify host keys against (defaults to the deployment's).
   * @param options.log - one-line sink for a learned host key and other notices.
   * @param options.env - the environment used for `~` and passphrases (tests pass their own).
   */
  constructor({ knownHostsPath, log, env = process.env } = {}) {
    this.env = env
    this.knownHostsPath = knownHostsPath ?? defaultKnownHostsPath(env)
    this.log = typeof log === 'function' ? log : () => {}
    /** alias -> the CURRENT (non-retired) record. */
    this.records = new Map()
    /** client -> { record, count }: how many outstanding releases a client has. */
    this.leases = new Map()
  }

  /** The number of aliases with a current (non-retired) client, live or in flight. */
  size() {
    return this.records.size
  }

  /**
   * LEASE the pooled client for one host, dialling if this is the first call.
   *
   * The record is published BEFORE the dial is awaited, so two calls that arrive
   * together share one connection instead of racing to open two. Every lease MUST be
   * handed back with {@link release} — `ssh_shell`'s channel handle, `ssh_scp`'s
   * operation and the job settle path all do it in their own `finally` — because
   * that count is the only thing that lets {@link retire} close a client safely.
   * @param entry - the normalized host (see hosts.js).
   * @returns the ready ssh2 Client.
   */
  async get(entry) {
    if (entry === undefined || entry === null || typeof entry.alias !== 'string' || entry.alias.length === 0)
      throw new Error('ssh-shell: get() needs a host with an alias')
    let record = this.records.get(entry.alias)
    if (record === undefined) {
      record = new SshPoolRecord(entry)
      record.ready = this.connect(record)
      this.records.set(entry.alias, record)
    }
    record.refs += 1
    try {
      const client = await record.ready
      const lease = this.leases.get(client)
      if (lease === undefined) this.leases.set(client, { record, count: 1 })
      else lease.count += 1
      return client
    }
    catch (error) {
      record.refs = Math.max(0, record.refs - 1)
      if (this.records.get(entry.alias) === record) this.records.delete(entry.alias)
      throw error
    }
  }

  /**
   * Hand one lease back.
   *
   * The client is closed only when a RETIRED record reaches zero: a live record stays
   * in the pool for the next caller, which is what makes a concurrent command keep
   * running while a stalled transfer is being retired.
   * @param client - the client a previous {@link get} returned.
   * @returns true when this released a lease, false for an unknown/already-dead client.
   */
  release(client) {
    const lease = this.leases.get(client)
    if (lease === undefined) return false
    lease.count -= 1
    lease.record.refs = Math.max(0, lease.record.refs - 1)
    if (lease.count <= 0) this.leases.delete(client)
    if (lease.record.retired === true && lease.record.refs === 0) this.closeRecord(lease.record)
    return true
  }

  /**
   * Retire ONE host's current client: no new call joins it, and it closes when the
   * last lease is released.
   *
   * This is the surgical alternative to killing a shared connection: a transfer that
   * timed out before its SFTP session existed leaves a subsystem request pending on
   * the client forever, so NEW calls must dial fresh — but a concurrent command or
   * transfer holding a lease on that same client finishes normally.
   * @param alias - the host alias.
   * @param expectedClient - retire only when the record still holds THIS client (so a
   *   late timeout cannot retire a replacement dialled after the fact).
   * @returns true when a record was retired.
   */
  retire(alias, expectedClient) {
    const record = this.records.get(alias)
    if (record === undefined) return false
    if (expectedClient !== undefined && record.client !== expectedClient) return false
    record.retired = true
    this.records.delete(alias)
    if (record.refs === 0) this.closeRecord(record)
    return true
  }

  /** Close one record's client and forget its lease count. */
  closeRecord(record) {
    if (record.client !== undefined) this.leases.delete(record.client)
    try {
      record.client?.end()
    }
    catch {
      // The client already failed; nothing left to close.
    }
  }

  /** Close every client; idempotent, and the row calls it from its teardown. */
  dispose() {
    const records = new Set([...this.records.values()])
    for (const lease of this.leases.values()) records.add(lease.record)
    this.records.clear()
    this.leases.clear()
    for (const record of records) {
      try {
        record.client?.end()
      }
      catch {
        // A client that already failed is gone; nothing left to close.
      }
    }
  }

  /**
   * Dial and verify one host.
   * @param record - the pool record being filled in.
   * @returns the ready client.
   */
  async connect(record) {
    const entry = record.entry
    const keyPath = expandHome(entry.keyPath, this.env)
    let privateKey
    try {
      privateKey = readFileSync(keyPath)
    }
    catch (error) {
      throw new Error(`ssh-shell: cannot read the private key for host "${entry.alias}" at ${keyPath} (${String(error?.code ?? error?.message ?? error)})`)
    }
    const passphraseVar = typeof entry.passphraseEnv === 'string' && entry.passphraseEnv.length > 0 ? entry.passphraseEnv : undefined
    const passphrase = passphraseVar === undefined ? undefined : this.env[passphraseVar]
    const client = new ssh2.Client()
    record.client = client
    const drop = () => {
      if (this.records.get(entry.alias) === record) this.records.delete(entry.alias)
      if (record.client !== undefined) this.leases.delete(record.client)
    }
    client.on('error', drop)
    client.on('close', drop)
    const knownHostsPath = this.knownHostsPath
    const config = {
      host: entry.host,
      port: entry.port,
      username: entry.user,
      privateKey,
      ...passphrase === undefined ? {} : { passphrase },
      readyTimeout: Number.isInteger(entry.connectTimeoutMs) && entry.connectTimeoutMs > 0 ? entry.connectTimeoutMs : DEFAULT_READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      tryKeyboard: false,
      // The ONE host-key decision: the verifier from known-hosts.js. ssh2 accepts any
      // key when this hook is absent, so its presence is load-bearing, not optional.
      hostVerifier: (key) => {
        const verdict = verifyHostKey({
          host: entry.host,
          port: entry.port,
          key,
          knownHostsPath,
          acceptNewHostKeys: entry.acceptNewHostKeys === true,
        })
        record.verdict = verdict
        if (verdict.ok === true && verdict.warning !== undefined) this.log(verdict.warning)
        return verdict.ok === true
      },
    }
    const ready = new Promise((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      try {
        client.connect(config)
      }
      catch (error) {
        reject(error)
      }
    })
    try {
      await ready
    }
    catch (error) {
      drop()
      throw this.describe(record, error)
    }
    return client
  }

  /**
   * Turn a connect failure into a message that names the alias and the phase.
   *
   * A host-key refusal carries the verifier's own sentence (it names the file and
   * the fingerprints), so it is preferred over ssh2's generic "Host verification
   * failed"; an encrypted key with no passphrase names the environment variable.
   * @param record - the record whose dial failed.
   * @param error - the underlying failure.
   * @returns the error to throw.
   */
  describe(record, error) {
    const entry = record.entry
    const who = `${entry.user}@${entry.host}:${entry.port}`
    const verdict = record.verdict
    if (verdict !== undefined && verdict.ok === false)
      return new Error(`ssh-shell: host "${entry.alias}" (${who}) was refused: ${verdict.reason}`)
    const message = String(error?.message ?? error)
    const passphraseVar = typeof entry.passphraseEnv === 'string' && entry.passphraseEnv.length > 0 ? entry.passphraseEnv : undefined
    if (passphraseVar !== undefined && /encrypted|passphrase|bad decrypt/i.test(message))
      return new Error(`ssh-shell: the private key for host "${entry.alias}" is encrypted and ${passphraseVar} is not set to a usable passphrase (${message})`)
    return new Error(`ssh-shell: connecting to host "${entry.alias}" (${who}) failed: ${message}`)
  }
}
