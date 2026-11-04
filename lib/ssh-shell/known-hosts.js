/**
 * known_hosts parsing and host-key verification for the ssh_shell transport.
 *
 * `ssh2` **auto-accepts** a host key when `hostVerifier` is not set (README), so the
 * verifier here is not an optional hardening step: it is the only thing standing
 * between a pooled connection and an unverified host. The policy is the design's
 * (docs/superpowers/specs/2026-11-05-ssh-shell-design.md §7.1):
 *
 *  - the files are read by us — plain entries, `[host]:port` entries, multiple key
 *    types, comments, blank lines, hashed names (`|1|salt|hmac`, HMAC-SHA1) and
 *    `@revoked` markers;
 *  - **known_hosts and known_hosts2 are read together** when both exist, and an
 *    entry in either file counts; one existing file is enough, and neither existing
 *    is the unknown-key case (fail closed);
 *  - the presented key is parsed with `ssh2.utils.parseKey` and its type and
 *    base64 blob must equal an entry's;
 *  - **no entry** refuses and names the expected file(s), with the BARE host name
 *    (what `ssh-keygen -F host` looks up);
 *  - a **changed** key refuses and names BOTH fingerprints;
 *  - a key marked `@revoked` is refused even when a plain entry would accept it,
 *    and `acceptNewHostKeys` never overrides a revocation (OpenSSH refuses those
 *    keys unconditionally);
 *  - `acceptNewHostKeys` accepts an unknown key with a warning, and never a
 *    changed or revoked one; it never writes a file (the warning says what to add).
 *
 * `@cert-authority` lines are parsed but NOT honoured: certificate-signed host keys
 * are outside this release (a later plan may add CA pinning). A deployment that
 * relies on a CA entry therefore gets the same strict known_hosts behaviour as one
 * that does not — refused unless the key is also a plain entry. That limitation is
 * repeated in the 0.8.0 migration notes.
 *
 * Everything here is synchronous and side-effect free: `hostVerifier` runs inside
 * the handshake, where an async decision would have to be awaited by ssh2 anyway.
 * Nothing secret is touched — a public key blob and a fingerprint are not secrets.
 * @module dsh-win-multi-bash/ssh-shell/known-hosts
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import ssh2 from 'ssh2'

/** The file names OpenSSH reads, in the order it reads them. */
export const KNOWN_HOSTS_NAMES = ['known_hosts', 'known_hosts2']

/** The hashed-entry grammar `ssh-keygen -H` writes: `|1|<salt b64>|<hmac b64>`. */
export const HASHED_ENTRY = /^\|1\|([^|]*)\|([^|]*)$/

/** The fingerprint form `ssh-keygen -l` prints, and every message here reuses. */
export const FINGERPRINT_PREFIX = 'SHA256:'

/** The markers known_hosts defines; only `revoked` changes a verdict here. */
export const KNOWN_HOSTS_MARKERS = ['cert-authority', 'revoked']

/**
 * The known_hosts file a deployment actually has.
 *
 * `$HOME/.ssh/known_hosts` and its `known_hosts2` sibling are both read by
 * OpenSSH; Windows spells HOME as `%USERPROFILE%`. An existing file wins over a
 * missing one, so a machine that only carries `known_hosts2` is not silently
 * treated as having no trusted hosts — and a machine with neither still gets the
 * canonical path back, because the refusal message must name the file to create.
 * (`verifyHostKey` reads the sibling too; this function picks the one to NAME.)
 * @param env - the environment to read (defaults to the process environment).
 * @returns the path to read and to name in a refusal.
 */
export function defaultKnownHostsPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  const sshDir = join(home, '.ssh')
  for (const name of KNOWN_HOSTS_NAMES) {
    const candidate = join(sshDir, name)
    if (existsSync(candidate)) return candidate
  }
  return join(sshDir, KNOWN_HOSTS_NAMES[0])
}

/**
 * Parse one known_hosts text into its entries.
 *
 * Blank lines, `#` comments and unparseable lines (fewer than the three fields)
 * are skipped. A marker line (`@cert-authority`, `@revoked`) is returned WITH its
 * marker (`marker` is absent on a plain entry). The verifier decides what a marker
 * means — parsing never silently drops a revocation.
 * @param text - the file contents (any newline style).
 * @returns one entry per line, with its 1-based line number.
 */
export function parseKnownHosts(text) {
  const entries = []
  if (typeof text !== 'string') return entries
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    let marker
    if (fields[0].startsWith('@')) {
      marker = fields[0].slice(1).toLowerCase()
      fields.shift()
    }
    if (fields.length < 3) continue
    const hosts = fields[0].split(',').filter((host) => host.length > 0)
    if (hosts.length === 0) continue
    const blob = Buffer.from(fields[2], 'base64')
    if (blob.length === 0) continue
    const entry = { hosts, type: fields[1], blob, line: index + 1 }
    if (marker !== undefined) entry.marker = marker
    entries.push(entry)
  }
  return entries
}

/**
 * The fingerprint of one public key blob: SHA256, base64, no padding.
 * @param blob - the OpenSSH public key blob.
 * @returns `SHA256:<base64>`.
 */
export function fingerprintOf(blob) {
  return FINGERPRINT_PREFIX + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/**
 * The host spelling a message uses: the BARE lowercased host on the default port,
 * the bracketed form otherwise.
 *
 * `ssh-keygen -F host` looks a bare name up; a refusal that said `[host]:22` would
 * send the reader to an entry that tool does not match. The bracketed form is only
 * a MATCHING candidate for port 22, never the name a message suggests.
 * @param host - the configured host.
 * @param port - the configured port (default 22).
 * @returns the spelling to show and to suggest.
 */
export function displayName(host, port) {
  const name = String(host ?? '').trim().toLowerCase()
  const effective = port === undefined ? 22 : port
  return effective === 22 ? name : `[${name}]:${effective}`
}

/**
 * The names a connection looks up in known_hosts.
 *
 * OpenSSH writes the bare hostname for the default port and `[host]:port`
 * otherwise; the bare form is also accepted for port 22 because a file may carry
 * either spelling for the default port. Hostnames are case-insensitive.
 * @param host - the configured host.
 * @param port - the configured port (default 22).
 * @returns the candidate names, most specific last.
 */
export function candidateNames(host, port) {
  const bare = String(host ?? '').trim().toLowerCase()
  const effective = port === undefined ? 22 : port
  return effective === 22 ? [bare, `[${bare}]:22`] : [`[${bare}]:${effective}`]
}

/**
 * The files one verification reads: the named file, plus its known_hosts sibling
 * when the name is one of OpenSSH's own (so a custom/test path is never widened
 * into an unrelated directory).
 * @param options.knownHostsPath - the configured path.
 * @param options.knownHostsPaths - an explicit file list (wins when given).
 * @returns the paths, deduplicated; empty when nothing was configured.
 */
export function hostFiles({ knownHostsPath, knownHostsPaths } = {}) {
  if (Array.isArray(knownHostsPaths) && knownHostsPaths.length > 0)
    return [...new Set(knownHostsPaths)]
  if (typeof knownHostsPath !== 'string' || knownHostsPath.length === 0) return []
  const files = [knownHostsPath]
  if (KNOWN_HOSTS_NAMES.includes(basename(knownHostsPath)))
    for (const name of KNOWN_HOSTS_NAMES) {
      const candidate = join(dirname(knownHostsPath), name)
      if (!files.includes(candidate)) files.push(candidate)
    }
  return files
}

/**
 * Whether one entry name covers one candidate name.
 *
 * A hashed name is compared as HMAC-SHA1(salt, candidate), the way `ssh-keygen -H`
 * makes it; a literal name is compared case-insensitively. A malformed hashed
 * field never matches (it cannot name a host).
 * @param entryName - one element of an entry's host list.
 * @param candidate - one candidate name (already lowercased).
 * @returns true when the entry covers that candidate.
 */
function entryCovers(entryName, candidate) {
  const hashed = HASHED_ENTRY.exec(entryName)
  if (hashed === null) return entryName.toLowerCase() === candidate
  try {
    const salt = Buffer.from(hashed[1], 'base64')
    const expected = Buffer.from(hashed[2], 'base64')
    const actual = createHmac('sha1', salt).update(candidate).digest()
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  catch {
    return false
  }
}

/**
 * Parse the key ssh2's `hostVerifier` hands over, refusing anything unusable.
 *
 * ssh2 passes the raw public key blob; `parseKey` also accepts the `type blob`
 * text form, and can answer an array for a multi-key input — neither is a host
 * key, so both are refused by name instead of crashing the handshake.
 * @param key - the presented key (Buffer of the public blob).
 * @returns `{ type, blob }`.
 * @throws when the presented bytes are not one usable public key.
 */
function presentedKey(key) {
  let parsed
  try {
    parsed = ssh2.utils.parseKey(key)
  }
  catch (error) {
    throw new Error('the host presented a key that could not be parsed (' + String(error?.message ?? error) + ')')
  }
  if (parsed === undefined || parsed === null || Array.isArray(parsed))
    throw new Error('the host presented a key that is not one public key')
  const blob = parsed.getPublicSSH()
  if (!Buffer.isBuffer(blob) || blob.length === 0)
    throw new Error('the host presented a key with no public blob')
  return { type: parsed.type, blob }
}

/** Whether one entry holds exactly the presented key. */
function sameKey(entry, presented) {
  return entry.type === presented.type && entry.blob.equals(presented.blob)
}

/** The sentence an unreadable (but present) file fails with — fail closed. */
function unreadable(path, error) {
  return `cannot read known_hosts at ${path} (${String(error?.code ?? error?.message ?? error)}); refusing the connection rather than trusting a file the process cannot inspect`
}

/**
 * Verify one presented host key against the known_hosts files.
 *
 * **Fails closed in every ambiguous case**: an unreadable file is a configuration
 * error (not an unknown key, so `acceptNewHostKeys` does not bypass it), a changed
 * key is refused even when `acceptNewHostKeys` is on, and a `@revoked` key is
 * refused unconditionally. Only an entry-less host is learnable.
 * @param options.host - the configured host name.
 * @param options.port - the configured port.
 * @param options.key - the presented public key blob.
 * @param options.knownHostsPath - the file to verify against (its known_hosts sibling is read too).
 * @param options.knownHostsPaths - an explicit file list, when a caller resolves its own.
 * @param options.acceptNewHostKeys - whether an UNKNOWN key may be learned (warning only, never written).
 * @returns `{ ok: true, fingerprint, warning? }` or `{ ok: false, fingerprint, reason }`.
 */
export function verifyHostKey({ host, port, key, knownHostsPath, knownHostsPaths, acceptNewHostKeys = false }) {
  let presented
  try {
    presented = presentedKey(key)
  }
  catch (error) {
    return { ok: false, fingerprint: undefined, reason: String(error?.message ?? error) }
  }
  const fingerprint = fingerprintOf(presented.blob)
  const names = candidateNames(host, port)
  const label = displayName(host, port)
  const files = hostFiles({ knownHostsPath, knownHostsPaths })
  const entries = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    }
    catch (error) {
      if (error?.code === 'ENOENT') continue
      return { ok: false, fingerprint, reason: unreadable(file, error) }
    }
    for (const entry of parseKnownHosts(text)) entries.push({ ...entry, file })
  }
  const covers = (entry) => entry.hosts.some((entryName) => names.some((name) => entryCovers(entryName, name)))
  // Revocation outranks every other verdict, including acceptNewHostKeys: OpenSSH
  // refuses a @revoked key unconditionally, and a pool that silently re-learned one
  // would undo the operator's decision.
  const revoked = entries.find((entry) => entry.marker === 'revoked' && covers(entry) && sameKey(entry, presented))
  if (revoked !== undefined) {
    return {
      ok: false,
      fingerprint,
      reason: `host key for ${label} is marked @revoked in ${revoked.file} (${fingerprint}); refusing the connection`,
    }
  }
  const covering = entries.filter((entry) => entry.marker === undefined && covers(entry))
  if (covering.length === 0) return unknownKey({ presented, fingerprint, label, files, acceptNewHostKeys })
  const same = covering.find((entry) => sameKey(entry, presented))
  if (same !== undefined) return { ok: true, fingerprint }
  // A changed key: BOTH fingerprints, because the human has to decide which side is
  // the intruder. This branch never consults acceptNewHostKeys.
  const stored = covering[0]
  return {
    ok: false,
    fingerprint,
    reason: `host key mismatch for ${label}: ${stored.file} stores ${fingerprintOf(stored.blob)}, the host presented ${fingerprint}`,
  }
}

/**
 * The verdict for a key no entry covers: refused, or learned with a warning.
 * @param options.presented - the parsed presented key.
 * @param options.fingerprint - its fingerprint.
 * @param options.label - the host spelling for messages (bare on the default port).
 * @param options.files - the files that were read.
 * @param options.acceptNewHostKeys - the per-host switch.
 * @returns the verdict.
 */
function unknownKey({ presented, fingerprint, label, files, acceptNewHostKeys }) {
  const where = files.length === 0 ? 'no known_hosts file is configured' : files.join(', ')
  if (acceptNewHostKeys === true) {
    const entry = `${label} ${presented.type} ${presented.blob.toString('base64')}`
    return {
      ok: true,
      fingerprint,
      warning: `the host key for ${label} (${fingerprint}) is not in ${where}; it was accepted because acceptNewHostKeys is on for this host. Add this line to the known_hosts file to make the trust explicit: ${entry}`,
    }
  }
  return {
    ok: false,
    fingerprint,
    reason: `host key not found in known_hosts (${where}) for ${label}; the presented key is ${fingerprint}. Add the host key to that file (or set acceptNewHostKeys on this host to accept it once, which never writes the file)`,
  }
}
