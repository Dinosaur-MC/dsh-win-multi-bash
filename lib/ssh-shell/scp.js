/**
 * The transfer engine behind `ssh_scp`: SFTP on the row's pooled connection.
 *
 * One operation = one SFTP session on the client the pool already dialled, closed in
 * `finally`. Files stream with a byte counter (the result's `bytes` is what actually
 * crossed the wire, not what a stat said). A directory is walked recursively only when
 * the caller asked for it; a directory without `recursive` is a named error rather
 * than an empty result. Every failure comes back as `{ ok: false, bytes, error }`
 * naming the alias and the phase, with the ssh2 message kept: a caller must never have
 * to guess whether the connection, the host key or the file itself failed.
 *
 * Nothing here logs a key, a passphrase or a file's contents.
 * @module dsh-win-multi-bash/ssh-shell/scp
 */
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** The spec's per-operation ceiling when the caller names none (5 minutes). */
export const DEFAULT_SCP_TIMEOUT_MS = 300_000

/** A trailing separator never belongs on a remote path we build by joining. */
const trimSlash = (value) => value.length > 1 ? value.replace(/\/+$/, '') : value

/**
 * Join one remote (POSIX) path segment onto a base, without importing POSIX rules
 * from the host platform (this plugin runs on Windows, the remote does not).
 * @param base - the remote base path.
 * @param part - the relative segment.
 * @returns the joined remote path.
 */
export function remoteJoin(base, part) {
  if (part === '') return base
  return trimSlash(base) + '/' + part.replace(/^\/+/, '')
}

/**
 * The parent of a remote POSIX path (the remote root has itself as parent).
 * @param value - the remote path.
 * @returns the parent path.
 */
export function remoteDirname(value) {
  const trimmed = trimSlash(value)
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

/** The remote base name of a POSIX path. */
export function remoteBasename(value) {
  const trimmed = trimSlash(value)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** Whether an ssh2 stat/attrs mode says "directory". */
export function isDirectoryMode(mode) {
  return typeof mode === 'number' && (mode & 0o170000) === 0o040000
}

/**
 * A refusal the engine decided itself (a directory without recursive, an absent
 * remote path): its message IS the result, not a transport error to wrap.
 */
class NamedFailure extends Error {}

/**
 * The structured failure this engine returns.
 * @param phase - 'connect' (before any SFTP session existed) or 'sftp'.
 * @param alias - the host alias.
 * @param message - the underlying message, kept verbatim.
 * @param bytes - bytes already transferred before the failure.
 * @param extra - optional fields (`aborted`).
 * @returns the result object.
 */
function failure(phase, alias, message, bytes = 0, extra = {}) {
  return { ok: false, bytes, error: { phase, alias, message, ...extra } }
}

/** The one thing a failed operation must never do: swallow the reason. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open one SFTP session on an already-dialled client.
 * @param client - the pooled ssh2 client.
 * @returns the SFTP wrapper.
 */
function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))
  })
}

/** mkdir one remote directory, tolerating an existing one. */
function mkdirRemote(sftp, path) {
  return new Promise((resolve) => {
    sftp.mkdir(path, (error) => {
      // An existing directory is the goal, not a failure (ssh2 reports it as a
      // generic FAILURE because SFTP has no EEXIST status).
      void error
      resolve()
    })
  })
}

/** Create a remote directory and every missing ancestor, top-down. */
async function ensureRemoteDir(sftp, path) {
  const target = remoteDirname(trimSlash(path))
  if (target === '/' || target === '') return
  const parts = target.split('/').filter((part) => part.length > 0)
  let current = ''
  for (const part of parts) {
    current += '/' + part
    await mkdirRemote(sftp, current)
  }
}

/** Stat a remote path; `undefined` when it does not exist. */
function statRemote(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attrs) => {
      if (error === undefined || error === null) return resolve(attrs)
      // NO_SUCH_FILE (2) means "absent", which the caller reports; anything else is a
      // real failure (permission, connection) and must not look like a missing file.
      if (error.code === 2) return resolve(undefined)
      reject(error)
    })
  })
}

/** List one remote directory: `[{ name, directory }]`. */
function readRemoteDir(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => {
      if (error !== undefined && error !== null) return reject(error)
      resolve((entries ?? []).map((entry) => ({
        name: entry.filename,
        directory: isDirectoryMode(entry.attrs?.mode),
      })))
    })
  })
}

/**
 * Stream one local file to the remote host, counting bytes actually read.
 * @returns the byte count.
 */
async function uploadFile(sftp, localPath, remotePath, live) {
  let bytes = 0
  const read = createReadStream(localPath)
  const write = sftp.createWriteStream(remotePath)
  read.on('data', (chunk) => { bytes += chunk.length })
  live.add(read)
  live.add(write)
  try {
    await pipeline(read, write)
    return bytes
  }
  finally {
    live.delete(read)
    live.delete(write)
  }
}

/**
 * Stream one remote file to the local host, counting bytes actually written.
 * @returns the byte count.
 */
async function downloadFile(sftp, remotePath, localPath, live) {
  let bytes = 0
  const read = sftp.createReadStream(remotePath)
  const write = createWriteStream(localPath)
  read.on('data', (chunk) => { bytes += chunk.length })
  live.add(read)
  live.add(write)
  try {
    await pipeline(read, write)
    return bytes
  }
  finally {
    live.delete(read)
    live.delete(write)
  }
}

/**
 * Walk a local directory tree, yielding `{ relative, absolute }` for every file.
 *
 * `relative` keeps the POSIX-shaped path under the root ('sub/x.txt'), because it is
 * joined onto a REMOTE base path — the host's separator must not leak into it.
 */
function* walkLocal(root, prefix = '') {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name)
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) yield* walkLocal(absolute, relative)
    else yield { relative, absolute }
  }
}

/** Walk a remote directory tree, yielding `{ relative, absolute }` for every file. */
async function* walkRemote(sftp, root, prefix = '') {
  for (const entry of await readRemoteDir(sftp, root)) {
    const absolute = remoteJoin(root, entry.name)
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.directory) yield* walkRemote(sftp, absolute, relative)
    else yield { relative, absolute }
  }
}

/**
 * The transfer runner: upload and download over the SAME pooled client.
 */
export class ScpRunner {
  /**
   * @param options.pool - the row's connection pool (`SshPool`).
   * @param options.logger - optional row logger; never receives file contents.
   */
  constructor({ pool, logger }) {
    this.pool = pool
    this.logger = logger
  }

  /**
   * Send a local file or directory tree to the remote host.
   * @param options.host - the normalized host entry.
   * @returns the structured result.
   */
  async upload({ host, localPath, remotePath, recursive = false, timeoutMs, signal }) {
    return this.run('upload', { host, localPath, remotePath, recursive, timeoutMs, signal })
  }

  /**
   * Bring a remote file or directory tree to this host.
   * @param options.host - the normalized host entry.
   * @returns the structured result.
   */
  async download({ host, localPath, remotePath, recursive = false, timeoutMs, signal }) {
    return this.run('download', { host, localPath, remotePath, recursive, timeoutMs, signal })
  }

  /**
   * Run one operation: resolve the client, open ONE SFTP session, transfer, close.
   *
   * The deadline and the caller's signal both abort the in-flight streams and end the
   * session, so neither can leave a transfer waiting forever.
   * @param direction - 'upload' or 'download'.
   * @returns the structured result.
   */
  async run(direction, { host, localPath, remotePath, recursive = false, timeoutMs, signal }) {
    const alias = host?.alias ?? ''
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SCP_TIMEOUT_MS
    let phase = 'connect'
    let bytes = 0
    let files = 0
    let cancelled
    let sftp
    let timer
    let cancelResolve
    const live = new Set()
    /** Stop the transfer now, whichever trigger asked first. */
    const abortLive = () => {
      for (const stream of live) {
        try {
          stream.destroy()
        }
        catch {
          // An already-destroyed stream is the same outcome.
        }
      }
      try {
        sftp?.end()
      }
      catch {
        // The session is already gone.
      }
    }
    // A stalled SFTP server never answers OPEN, so destroying the stream is not enough
    // to end the call: the transfer is RACED against this promise, and the race is what
    // the caller waits on.
    const cancelledPromise = new Promise((resolve) => { cancelResolve = resolve })
    const cancel = (kind) => {
      if (cancelled !== undefined) return
      cancelled = kind
      abortLive()
      cancelResolve(kind)
    }
    const onAbort = () => cancel('abort')
    try {
      const client = await this.pool.get(host)
      sftp = await openSftp(client)
      phase = 'sftp'
      // Armed only once a session exists: a connect/host-key failure is reported by
      // the pool, with its own message, and must not be relabelled a timeout.
      timer = setTimeout(() => cancel('timeout'), deadline)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })

      const work = (async () => {
        if (direction === 'upload') {
          const local = statSync(localPath)
          if (local.isDirectory()) {
            if (!recursive) throw new NamedFailure(`localPath "${localPath}" is a directory; pass recursive: true to transfer a tree`)
            for (const entry of walkLocal(localPath)) {
              const target = remoteJoin(remotePath, entry.relative)
              await ensureRemoteDir(sftp, target)
              bytes += await uploadFile(sftp, entry.absolute, target, live)
              files += 1
            }
          }
          else {
            await ensureRemoteDir(sftp, remotePath)
            bytes = await uploadFile(sftp, localPath, remotePath, live)
            files = 1
          }
          return
        }
        const remote = await statRemote(sftp, remotePath)
        if (remote === undefined) throw new NamedFailure(`remotePath "${remotePath}" does not exist on "${host.host}"`)
        if (isDirectoryMode(remote.mode)) {
          if (!recursive) throw new NamedFailure(`remotePath "${remotePath}" is a directory; pass recursive: true to transfer a tree`)
          for await (const entry of walkRemote(sftp, remotePath)) {
            const target = join(localPath, entry.relative)
            mkdirSync(dirname(target), { recursive: true })
            bytes += await downloadFile(sftp, entry.absolute, target, live)
            files += 1
          }
          return
        }
        mkdirSync(dirname(localPath), { recursive: true })
        bytes = await downloadFile(sftp, remotePath, localPath, live)
        files = 1
      })()
      // The race may abandon this promise; its late rejection is not a failure to report.
      work.catch(() => {})
      const outcome = await Promise.race([
        work.then(() => ({ kind: 'done' })),
        cancelledPromise.then((kind) => ({ kind })),
      ])
      if (outcome.kind !== 'done') return this.cancelledResult(outcome.kind, alias, phase, bytes, deadline)
      this.logger?.debug?.(`ssh_scp: ${direction} of ${files} file(s), ${bytes} byte(s) on "${alias}"`)
      return { ok: true, bytes, files }
    }
    catch (error) {
      if (cancelled !== undefined) return this.cancelledResult(cancelled, alias, phase, bytes, deadline)
      if (error instanceof NamedFailure) return failure('sftp', alias, error.message, bytes)
      return failure(phase, alias, describe(error), bytes)
    }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      try {
        sftp?.end()
      }
      catch {
        // Closing an already-closed session is not a failure of the transfer.
      }
    }
  }
  /**
   * The structured result for a cancellation (timeout or caller abort).
   * @param kind - 'timeout' or 'abort'.
   * @returns the result object.
   */
  cancelledResult(kind, alias, phase, bytes, deadline) {
    if (kind === 'abort') return failure(phase, alias, 'the transfer was aborted by the caller', bytes, { aborted: true })
    return failure(phase, alias, `the transfer timed out after ${deadline} ms`, bytes)
  }
}
