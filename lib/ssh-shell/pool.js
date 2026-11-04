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
    this.records = new Map()
  }

  /** The number of aliases with a live or in-flight client. */
  size() {
    return this.records.size
  }

  /**
   * The pooled client for one host, dialling if this is the first call.
   *
   * The record is published BEFORE the dial is awaited, so two calls that arrive
   * together share one connection instead of racing to open two.
   * @param entry - the normalized host (see hosts.js).
   * @returns the ready ssh2 Client.
   */
  async get(entry) {
    if (entry === undefined || entry === null || typeof entry.alias !== 'string' || entry.alias.length === 0)
      throw new Error('ssh-shell: get() needs a host with an alias')
    const existing = this.records.get(entry.alias)
    if (existing !== undefined) return existing.ready
    const record = new SshPoolRecord(entry)
    record.ready = this.connect(record)
    this.records.set(entry.alias, record)
    try {
      return await record.ready
    }
    catch (error) {
      if (this.records.get(entry.alias) === record) this.records.delete(entry.alias)
      throw error
    }
  }

  /** Close every client; idempotent, and the row calls it from its teardown. */
  dispose() {
    const records = [...this.records.values()]
    this.records.clear()
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
