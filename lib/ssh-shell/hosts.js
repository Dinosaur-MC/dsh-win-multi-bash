/**
 * The ssh_shell **host registry**: the array of remote hosts one row may reach,
 * and the pure validation that turns it into the objects the executor reads.
 *
 * Every host here is addressed by `alias`; nothing in the registry is ever
 * returned to the model as a secret. The fields are the ones the design binds
 * (docs/superpowers/specs/2026-11-05-ssh-shell-design.md §6):
 *
 *  - `alias`      — required, unique, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`;
 *  - `host`/`user` — required; no whitespace in the host (it is a hostname or IP);
 *  - `keyPath`    — required; the KEY FILE is the only credential (never a value);
 *  - `passphraseEnv` — the NAME of an environment variable, never the passphrase;
 *  - `startupCommand`/`shellTemplate` — the per-host POSIX startup snippet and the
 *    launcher that reads a base64 script from stdin;
 *  - `connectTimeoutMs` — the whole handshake+auth ceiling (default 30000);
 *  - `approvalTimeoutMs` — how long a session-authorization prompt may stay open
 *    (default 120000; `0` waits forever; configured range 0 or 1000..3600000);
 *  - `approval`   — `trusted` (never prompt) or `session` (default; ask once per
 *    session, see the authorization gate in a later plan);
 *  - `acceptNewHostKeys` — off by default; known_hosts is enforced strictly;
 *  - `default`    — at most ONE host may carry it; used when `alias` is omitted.
 *
 * Validation runs again at call time (the config is volatile and a running row
 * can be edited), so the messages here are the ones a deployment actually reads:
 * every failure names the field AND the alias that carries it.
 *
 * This module is pure data and pure functions — no `node:fs`, no ssh2 — so the
 * audit can pin it without a boot and a future GUI generator can read it.
 * @module dsh-win-multi-bash/ssh-shell/hosts
 */

/** The alias grammar: one path-ish token, never empty, never a leading separator. */
export const HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The SSH default port, used when a host declares none. */
export const DEFAULT_PORT = 22

/**
 * The whole handshake+authentication ceiling, in milliseconds.
 *
 * `ssh2`'s `readyTimeout` bounds the TCP/SSH handshake and the authentication
 * exchange — never the command, which the call's own `timeoutMs` bounds.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

/** How long a pending session-authorization prompt may stay open by default. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

/** The configured approval-timeout range (0 disables the timer). */
export const MIN_APPROVAL_TIMEOUT_MS = 1_000
export const MAX_APPROVAL_TIMEOUT_MS = 3_600_000

/**
 * No default launcher: an empty template is PRECISE PASSTHROUGH — the command
 * text goes to the remote login shell itself, with no extra shell hop. A saved
 * non-empty value is an explicit wrapper and keeps the base64/stdin path.
 */
export const DEFAULT_SHELL_TEMPLATE = undefined

/**
 * Validate and normalize one `sshShell.hosts` array.
 *
 * @param value - the raw configuration value (anything the config may hold).
 * @returns `{ ok: true, hosts }` with one normalized host per entry, or
 *   `{ ok: false, error }` naming the field and the alias.
 */
export function validateHosts(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'hosts must be an array' }
  const hosts = []
  const aliases = new Set()
  let defaults = 0
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return { ok: false, error: 'each host must be an object' }
    const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
    if (!HOST_ALIAS.test(alias)) return { ok: false, error: 'invalid alias ' + JSON.stringify(raw.alias) }
    if (aliases.has(alias)) return { ok: false, error: 'duplicate alias "' + alias + '"' }
    aliases.add(alias)
    const host = typeof raw.host === 'string' ? raw.host.trim() : ''
    if (host === '' || /\s/.test(host)) return { ok: false, error: 'host "' + alias + '" must be a non-empty hostname or IP' }
    const user = typeof raw.user === 'string' ? raw.user.trim() : ''
    if (user === '') return { ok: false, error: 'host "' + alias + '" needs a user' }
    const keyPath = typeof raw.keyPath === 'string' ? raw.keyPath.trim() : ''
    if (keyPath === '') return { ok: false, error: 'host "' + alias + '" needs a keyPath' }
    const port = raw.port === undefined ? DEFAULT_PORT : raw.port
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'host "' + alias + '" port must be 1..65535' }
    const approvalTimeoutMs = raw.approvalTimeoutMs === undefined || raw.approvalTimeoutMs === null ? DEFAULT_APPROVAL_TIMEOUT_MS : raw.approvalTimeoutMs
    if (!Number.isInteger(approvalTimeoutMs) || (approvalTimeoutMs !== 0 && (approvalTimeoutMs < MIN_APPROVAL_TIMEOUT_MS || approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS)))
      return { ok: false, error: 'host "' + alias + '" approvalTimeoutMs must be 0 (wait forever) or ' + MIN_APPROVAL_TIMEOUT_MS + '..' + MAX_APPROVAL_TIMEOUT_MS }
    if (raw.approval !== undefined && raw.approval !== 'trusted' && raw.approval !== 'session') {
      return { ok: false, error: 'host "' + alias + '" approval must be trusted or session' }
    }
    if (raw.default === true) defaults += 1
    hosts.push({
      alias, host, port, user, keyPath,
      passphraseEnv: typeof raw.passphraseEnv === 'string' && raw.passphraseEnv !== '' ? raw.passphraseEnv : undefined,
      startupCommand: typeof raw.startupCommand === 'string' && raw.startupCommand !== '' ? raw.startupCommand : undefined,
      shellTemplate: typeof raw.shellTemplate === 'string' && raw.shellTemplate.trim() !== '' ? raw.shellTemplate : DEFAULT_SHELL_TEMPLATE,
      connectTimeoutMs: Number.isInteger(raw.connectTimeoutMs) && raw.connectTimeoutMs > 0 ? raw.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS,
      approvalTimeoutMs,
      approval: raw.approval === 'trusted' ? 'trusted' : 'session',
      acceptNewHostKeys: raw.acceptNewHostKeys === true,
      default: raw.default === true,
      description: typeof raw.description === 'string' ? raw.description : undefined,
    })
  }
  if (defaults > 1) return { ok: false, error: 'more than one default host' }
  return { ok: true, hosts }
}

/**
 * One host by alias from a normalized list, or `undefined`.
 * @param hosts - the normalized hosts.
 * @param alias - the requested alias.
 * @returns the entry, or undefined when this row does not declare it.
 */
export function findHost(hosts, alias) {
  return hosts.find((entry) => entry.alias === alias)
}

/**
 * The host a call reaches when it names no alias (at most one may be `default`).
 * @param hosts - the normalized hosts.
 * @returns the default entry, or undefined when none is marked.
 */
export function defaultHost(hosts) {
  return hosts.find((entry) => entry.default === true)
}

/**
 * Assert that a workdir is absolute on the REMOTE host.
 *
 * Both remote forms are legal because the family decides the cd: a POSIX login
 * shell gets `cd -- <quoted>` with `/...`, a cmd login shell gets `cd /d` with a
 * Windows drive (`X:\\` or `X:/`). UNC is validated here only so the error is
 * about the path form rather than a relative one, but a cmd family REFUSES it later
 * (`cd /d` cannot enter a UNC path; use pushd inside the command). A POSIX host
 * given a Windows path is NOT refused here — the remote shell reports its own error.
 * Only a relative path is refused before dialling.
 * @param workdir - the path the caller named.
 * @returns the same path, when it is absolute in either form.
 */
export function assertRemoteWorkdir(workdir) {
  const example = 'POSIX /... or Windows X:\\...'
  if (typeof workdir !== 'string' || workdir.trim().length === 0)
    throw new Error(`ssh-shell: a remote workdir must be a non-empty absolute path on the remote host (${example})`)
  const drive = /^[A-Za-z]:[\\/]/.test(workdir)
  const unc = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(workdir)
  const posix = workdir.startsWith('/') && !workdir.startsWith('//')
  if (!drive && !unc && !posix)
    throw new Error(`ssh-shell: workdir "${workdir}" must be an absolute path on the remote host (${example})`)
  return workdir
}

/**
 * Normalize and validate a transfer's remote path.
 *
 * The remote side belongs to the other machine, so a local relative path cannot be
 * honoured. Three absolute forms are accepted and normalized once, before any SFTP
 * call: POSIX `/...` (including the `/C:/...` drive form) is unchanged, a Windows
 * drive path becomes `/X:/...` with forward slashes and an upper-case drive letter
 * (SFTP on Windows OpenSSH serves drives that way), and a UNC path is passed through
 * unchanged because the server owns its share syntax.
 * @param remotePath - the path the caller named.
 * @returns the path to hand to SFTP.
 */
export function normalizeRemotePath(remotePath) {
  const absolute = 'must be absolute on the remote host (POSIX /..., Windows C:\\..., or \\\\server\\share)'
  if (typeof remotePath !== 'string' || remotePath.length === 0)
    throw new Error(`ssh_scp: ${absolute}`)
  // UNC first: it starts with a backslash but is already absolute. SFTP is
  // POSIX-shaped even on Windows, so hand it //server/share, never the local
  // backslash spelling.
  if (remotePath.startsWith('\\\\') || remotePath.startsWith('//'))
    return '//' + remotePath.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const drive = /^([A-Za-z]):[\\/]/.exec(remotePath)
  if (drive !== null) {
    const rest = remotePath.slice(2).replace(/\\/g, '/')
    return `/${drive[1].toUpperCase()}:${rest.startsWith('/') ? rest : '/' + rest}`
  }
  if (remotePath.startsWith('/'))
    return remotePath
  throw new Error(`ssh_scp: remotePath "${remotePath}" ${absolute}`)
}

/**
 * Assert that a path names a FILE or directory on the remote host.
 * @param remotePath - the path the caller named.
 * @returns the normalized path to hand to SFTP (see {@link normalizeRemotePath}).
 */
export function assertRemotePath(remotePath) {
  return normalizeRemotePath(remotePath)
}
