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

/**
 * The launcher a host runs the delivered script with.
 *
 * The script itself is base64 on the channel's stdin, so no command text is ever
 * interpolated into this template — that is what makes command quoting safe on
 * any host whose template can launch a POSIX shell. A Windows host whose login
 * shell is `cmd.exe` overrides it with its Git Bash path.
 */
export const DEFAULT_SHELL_TEMPLATE = 'bash -c \'eval "$(base64 -d)"\''

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
    if (raw.approval !== undefined && raw.approval !== 'trusted' && raw.approval !== 'session') {
      return { ok: false, error: 'host "' + alias + '" approval must be trusted or session' }
    }
    if (raw.default === true) defaults += 1
    hosts.push({
      alias, host, port, user, keyPath,
      passphraseEnv: typeof raw.passphraseEnv === 'string' && raw.passphraseEnv !== '' ? raw.passphraseEnv : undefined,
      startupCommand: typeof raw.startupCommand === 'string' && raw.startupCommand !== '' ? raw.startupCommand : undefined,
      shellTemplate: typeof raw.shellTemplate === 'string' && raw.shellTemplate !== '' ? raw.shellTemplate : DEFAULT_SHELL_TEMPLATE,
      connectTimeoutMs: Number.isInteger(raw.connectTimeoutMs) && raw.connectTimeoutMs > 0 ? raw.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS,
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
 * Assert that a workdir names a directory on a POSIX host.
 *
 * The command runs where the SHELL runs, so a Windows path (drive letter, backslash,
 * UNC prefix) or a relative path cannot be honoured there: accepting either would
 * `cd` somewhere the caller never named and report it as the working directory. The
 * message says which path was refused and what a remote path looks like.
 * @param workdir - the path the caller named.
 * @returns the same path, when it is absolute and POSIX-shaped.
 */
export function assertRemoteWorkdir(workdir) {
  if (typeof workdir !== 'string' || workdir.length === 0)
    throw new Error('ssh-shell: a remote workdir must be a non-empty absolute POSIX path (e.g. /home/me/project)')
  if (/^[A-Za-z]:[\\/]/.test(workdir) || workdir.includes('\\') || workdir.startsWith('//'))
    throw new Error(`ssh-shell: workdir "${workdir}" is a local Windows path; a command runs on the remote host, so workdir must be an absolute POSIX path (e.g. /home/me/project)`)
  if (!workdir.startsWith('/'))
    throw new Error(`ssh-shell: workdir "${workdir}" is relative; a remote workdir must be absolute (e.g. /home/me/project)`)
  return workdir
}

/**
 * Assert that a path names a FILE or directory on a POSIX host.
 *
 * A transfer's remote side is a path on the other machine, so a local Windows path
 * cannot be honoured there: `C:\\...` would be a directory literally named "C:" with
 * backslashes in it. A Windows OpenSSH server serves a drive through the /C:/... form,
 * which starts with a slash and is therefore a valid POSIX absolute path. The message
 * says which path was refused and what the remote form looks like.
 * @param remotePath - the path the caller named.
 * @returns the same path, when it is absolute and POSIX-shaped.
 */
export function assertRemotePath(remotePath) {
  if (typeof remotePath !== 'string' || remotePath.length === 0)
    throw new Error('ssh_scp: remotePath must be a non-empty absolute POSIX path (e.g. /home/me/file.txt; on a Windows OpenSSH host /C:/Users/me/file.txt)')
  if (/^[A-Za-z]:[\\/]/.test(remotePath) || remotePath.includes('\\'))
    throw new Error(`ssh_scp: remotePath "${remotePath}" is a local Windows path; a transfer's remote side is on the other host, so remotePath must be an absolute POSIX path (on a Windows OpenSSH host use /C:/...)`)
  if (!remotePath.startsWith('/'))
    throw new Error(`ssh_scp: remotePath "${remotePath}" is relative; a remote path must be absolute (e.g. /home/me/file.txt)`)
  return remotePath
}
