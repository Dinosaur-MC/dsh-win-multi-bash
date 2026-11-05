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
 * is `config` (the row or the key file is unusable), `host-key` (known_hosts said
 * no), `auth` (the server rejected the credential) or `connect` (no handshake, or
 * the total deadline expired). Messages name the alias and user@host:port, and
 * never include key material or the passphrase.
 * @module dsh-win-multi-bash/ssh-shell/probe
 */
import { readFileSync } from 'node:fs'
import ssh2 from 'ssh2'
import { validateHosts } from './hosts.js'
import { expandHome } from './pool.js'
import { defaultKnownHostsPath, verifyHostKey } from './known-hosts.js'

/** The total deadline slack over the host's handshake+auth ceiling. */
export const PROBE_DEADLINE_SLACK_MS = 1_000

/** The label every failure message names: alias plus connection target. */
function labelOf(entry) {
  return entry.alias + ' (' + entry.user + '@' + entry.host + ':' + entry.port + ')'
}

/**
 * Probe one raw host row (the object the hosts table would save).
 * @param rawHost - one unvalidated host object from the editor.
 * @param options.env - the environment (key path home + passphrase variable).
 * @param options.knownHostsPath - the known_hosts file (defaults to the deployment's).
 * @param options.deadlineMs - the total handshake+auth deadline.
 * @param options.Client - the ssh2 client constructor (injectable for tests).
 * @returns `{ ok: true, fingerprint? }` or `{ ok: false, phase, message }`.
 */
export async function probeHost(rawHost, options = {}) {
  const env = options.env ?? process.env
  const Client = options.Client ?? ssh2.Client
  const validated = validateHosts([rawHost])
  if (validated.ok !== true) {
    const alias = rawHost !== null && typeof rawHost === 'object' && typeof rawHost.alias === 'string' && rawHost.alias.trim() !== '' ? rawHost.alias.trim() : '(unnamed host)'
    return { ok: false, phase: 'config', message: 'ssh-shell: cannot test host "' + alias + '": ' + validated.error }
  }
  const entry = validated.hosts[0]
  const label = labelOf(entry)
  const keyPath = expandHome(entry.keyPath, env)
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
  const deadlineMs = Number.isInteger(options.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : entry.connectTimeoutMs + PROBE_DEADLINE_SLACK_MS
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
    const timer = setTimeout(() => finish({
      ok: false,
      phase: 'connect',
      message: 'ssh-shell: testing host "' + label + '" timed out after ' + deadlineMs + ' ms',
    }), deadlineMs)
    client.once('ready', () => {
      if (verdict?.ok === false) {
        finish({ ok: false, phase: 'host-key', message: 'ssh-shell: host key verification failed for "' + label + '": ' + verdict.reason })
        return
      }
      finish(verdict?.fingerprint === undefined ? { ok: true } : { ok: true, fingerprint: verdict.fingerprint })
    })
    client.once('error', (error) => {
      const text = String(error?.message ?? error)
      if (verdict?.ok === false) {
        finish({ ok: false, phase: 'host-key', message: 'ssh-shell: host key verification failed for "' + label + '": ' + verdict.reason })
        return
      }
      if (/authentication|All configured authentication|Permission denied|no passphrase/i.test(text)) {
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
          verdict = verifyHostKey({
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