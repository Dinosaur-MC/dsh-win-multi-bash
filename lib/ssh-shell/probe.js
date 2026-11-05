/**
 * The hosts table's "Test connection": validate ONE unsaved host row and dial it,
 * with no command execution and no pool entry left behind.
 *
 * Why a separate module rather than a pool method: the row is NOT saved yet, so it
 * cannot be looked up by alias and must not enter the pool (which is keyed by alias
 * and reused by calls). This is a one-shot handshake: validate the row, read the key,
 * verify the host key against known_hosts, authenticate, hang up.
 *
 * Failure is a VALUE, not a throw: `{ ok: false, phase, message }`, where the phase
 * is `config` (the row, the key file, or the credential's parse/passphrase is
 * unusable, or the requested ceiling is absurd), `host-key` (known_hosts said no,
 * or the key was never verified), `auth` (the server rejected the credential) or
 * `connect` (no handshake, socket loss, or the total deadline expired). Messages
 * name the alias and user@host:port, and never include key material or passphrase.
 * @module dsh-win-multi-bash/ssh-shell/probe
 */
import { readFileSync, statSync } from 'node:fs'
import ssh2 from 'ssh2'
import { validateHosts } from './hosts.js'
import { expandHome } from './pool.js'
import { defaultKnownHostsPath, verifyHostKey } from './known-hosts.js'

/** The total deadline slack over the host's handshake+auth ceiling. */
export const PROBE_DEADLINE_SLACK_MS = 1_000

/** The hard ceiling on one test: no unsaved value may hold the host for minutes. */
export const MAX_PROBE_TIMEOUT_MS = 300_000

/** The largest private-key file a test will read (a real key is a few KiB). */
export const MAX_KEY_BYTES = 1_048_576

/** The label every failure message names: alias plus connection target. */
function labelOf(entry) {
  return entry.alias + ' (' + entry.user + '@' + entry.host + ':' + entry.port + ')'
}

/**
 * Probe one raw host row (the object the hosts table would save).
 * @param rawHost - one unvalidated host object from the editor.
 * @param options.env - the environment (key path home + passphrase variable).
 * @param options.knownHostsPath - the known_hosts file (defaults to the deployment's).
 * @param options.deadlineMs - the total handshake+auth deadline (clamped to the cap).
 * @param options.Client - the ssh2 client constructor (injectable for tests).
 * @param options.verifyHostKey - the host-key verifier (injectable for tests).
 * @param options.setTimeout - the timer used for the total deadline (injectable for tests).
 * @returns `{ ok: true, fingerprint?, warning? }` or `{ ok: false, phase, message }`.
 */
export async function probeHost(rawHost, options = {}) {
  const env = options.env ?? process.env
  const Client = options.Client ?? ssh2.Client
  const verify = options.verifyHostKey ?? verifyHostKey
  const schedule = options.setTimeout ?? setTimeout
  const validated = validateHosts([rawHost])
  if (validated.ok !== true) {
    const alias = rawHost !== null && typeof rawHost === 'object' && typeof rawHost.alias === 'string' && rawHost.alias.trim() !== '' ? rawHost.alias.trim() : '(unnamed host)'
    return { ok: false, phase: 'config', message: 'ssh-shell: cannot test host "' + alias + '": ' + validated.error }
  }
  const entry = validated.hosts[0]
  const label = labelOf(entry)
  if (entry.connectTimeoutMs > MAX_PROBE_TIMEOUT_MS) {
    return {
      ok: false,
      phase: 'config',
      message: 'ssh-shell: host "' + label + '" asks for a ' + entry.connectTimeoutMs + ' ms connect timeout; the test ceiling is ' + MAX_PROBE_TIMEOUT_MS + ' ms',
    }
  }
  const keyPath = expandHome(entry.keyPath, env)
  let keyFile
  try {
    keyFile = statSync(keyPath)
  }
  catch (error) {
    return {
      ok: false,
      phase: 'config',
      message: 'ssh-shell: cannot read the private key for host "' + label + '" at ' + keyPath + ' (' + String(error?.code ?? error?.message ?? error) + ')',
    }
  }
  if (keyFile.isFile() !== true) {
    return { ok: false, phase: 'config', message: 'ssh-shell: the private key for host "' + label + '" is not a regular file: ' + keyPath }
  }
  if (keyFile.size > MAX_KEY_BYTES) {
    return { ok: false, phase: 'config', message: 'ssh-shell: the private key for host "' + label + '" is ' + keyFile.size + ' bytes (the test read cap is ' + MAX_KEY_BYTES + '): ' + keyPath }
  }
  let privateKey
  try {
    privateKey = readFileSync(keyPath)
  }
  catch (error) {
    return {
      ok: false,
      phase: 'config',
      message: 'ssh-shell: cannot read the private key for host "' + label + '" at ' + keyPath + ' (' + String(error?.code ?? error?.message ?? error) + ')',
    }
  }
  const passphrase = entry.passphraseEnv === undefined ? undefined : env[entry.passphraseEnv]
  const knownHostsPath = options.knownHostsPath ?? defaultKnownHostsPath(env)
  const requestedDeadline = Number.isInteger(options.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : entry.connectTimeoutMs + PROBE_DEADLINE_SLACK_MS
  const deadlineMs = Math.min(requestedDeadline, MAX_PROBE_TIMEOUT_MS)
  return await new Promise((resolve) => {
    let settled = false
    let verdict
    const client = new Client()
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.end()
      }
      catch {
        // A client that already failed is gone; nothing left to close.
      }
      resolve(result)
    }
    const hostKeyFailure = () => finish({ ok: false, phase: 'host-key', message: 'ssh-shell: host key verification failed for "' + label + '": ' + (verdict?.reason ?? 'the host key was not verified') })
    const timer = schedule(() => finish({
      ok: false,
      phase: 'connect',
      message: 'ssh-shell: testing host "' + label + '" timed out after ' + deadlineMs + ' ms',
    }), deadlineMs)
    client.once('ready', () => {
      // Fail closed: ssh2 calls the verifier on a real handshake, so a ready without
      // one is not evidence that the key was checked.
      if (verdict?.ok !== true) {
        hostKeyFailure()
        return
      }
      finish({
        ok: true,
        ...verdict.fingerprint === undefined ? {} : { fingerprint: verdict.fingerprint },
        ...typeof verdict.warning === 'string' && verdict.warning !== '' ? { warning: verdict.warning } : {},
      })
    })
    client.once('close', () => {
      // A verifier that already said no keeps that verdict: the socket closing is the
      // consequence, not a different failure.
      if (verdict?.ok === false) {
        hostKeyFailure()
        return
      }
      finish({ ok: false, phase: 'connect', message: 'ssh-shell: the connection to "' + label + '" closed before it was ready' })
    })
    client.once('error', (error) => {
      const text = String(error?.message ?? error)
      if (verdict?.ok === false) {
        hostKeyFailure()
        return
      }
      // An encrypted key without a passphrase, or one ssh2 cannot parse, is a
      // credential/config problem — not a network one.
      if (/passphrase|privateKey|private key|Cannot parse|parse error|bad key/i.test(text)) {
        finish({ ok: false, phase: 'config', message: 'ssh-shell: cannot use the private key for host "' + label + '": ' + text })
        return
      }
      if (/authentication|All configured authentication|Permission denied/i.test(text)) {
        finish({ ok: false, phase: 'auth', message: 'ssh-shell: authentication failed for "' + label + '": ' + text })
        return
      }
      finish({ ok: false, phase: 'connect', message: 'ssh-shell: cannot connect to "' + label + '": ' + text })
    })
    try {
      client.connect({
        host: entry.host,
        port: entry.port,
        username: entry.user,
        privateKey,
        ...passphrase === undefined ? {} : { passphrase },
        readyTimeout: entry.connectTimeoutMs,
        hostVerifier: (key) => {
          verdict = verify({
            host: entry.host,
            port: entry.port,
            key,
            knownHostsPath,
            acceptNewHostKeys: entry.acceptNewHostKeys === true,
          })
          return verdict.ok === true
        },
      })
    }
    catch (error) {
      finish({ ok: false, phase: 'connect', message: 'ssh-shell: cannot connect to "' + label + '": ' + String(error?.message ?? error) })
    }
  })
}