/**
 * The transfer engine behind `ssh_scp`: SFTP on the row's pooled connection.
 *
 * One operation = one SFTP session on the client the pool already dialled, closed in
 * `finally`. Files stream with a byte counter (the result's `bytes` is what actually
 * crossed the wire, not what a stat said). A directory is walked recursively only when
 * the caller asked for it; a directory without `recursive` is a named error rather
 * than an empty result, and a recursive walk preserves EMPTY directories on both sides.
 * Every failure comes back as `{ ok: false, bytes, error }` naming the alias and the
 * phase, with the ssh2 message kept: a caller must never have to guess whether the
 * connection, the host key or the file itself failed.
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
 * A refusal the engine decided itself (a directory without `recursive`, an absent
 * remote path): its message is the result, not a transport error to wrap.
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

/**
 * mkdir one remote directory, tolerating an existing directory and nothing else.
 *
 * SFTP has no EEXIST status — ssh2 reports "already there" as a generic FAILURE — so
 * the failure is only benign when a stat says the path IS a directory. A permission
 * denial, or a FILE sitting where the directory belongs, must surface instead of
 * disappearing into a successful result.
 * @param sftp - the session.
 * @param path - the absolute remote directory to create.
 */
function mkdirRemote(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (error) => {
      if (error === undefined || error === null) return resolve()
      sftp.stat(path, (statError, attrs) => {
        if (statError === undefined || statError === null) {
          if (isDirectoryMode(attrs?.mode)) return resolve()
          return reject(new Error(`remote path "${path}" already exists and is not a directory`))
        }
        reject(error)
      })
    })
  })
}

/**
 * Create a remote directory and every missing ancestor, INCLUDING the directory
 * itself: a recursive transfer must preserve empty directories, not only the parents
 * of the files it happens to carry.
 * @param sftp - the session.
 * @param path - the absolute remote directory.
 */
async function ensureRemoteDirPath(sftp, path) {
  const parts = trimSlash(path).split('/').filter((part) => part.length > 0)
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
 * Walk a local directory tree, yielding every entry (directories included, so an
 * empty directory still appears).
 *
 * `relative` keeps the POSIX-shaped path under the root ('sub/x.txt'), because it is
 * joined onto a REMOTE base path — the host's separator must not leak into it.
 */
function* walkLocal(root, prefix = '') {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name)
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) {
      yield { relative, absolute, directory: true }
      yield* walkLocal(absolute, relative)
    }
    else {
      yield { relative, absolute, directory: false }
    }
  }
}

/** Walk a remote directory tree, yielding every entry (directories included). */
async function* walkRemote(sftp, root, prefix = '') {
  for (const entry of await readRemoteDir(sftp, root)) {
    const absolute = remoteJoin(root, entry.name)
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.directory) {
      yield { relative, absolute, directory: true }
      yield* walkRemote(sftp, absolute, relative)
    }
    else {
      yield { relative, absolute, directory: false }
    }
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
   * The deadline and the caller's signal are armed at the TOP and race the WHOLE
   * operation — the pool dial, the SFTP handshake and the transfer. Every one of those
   * awaits can stall on a server that never answers, and `client.sftp(cb)` has no
   * timeout of its own, so racing only the transfer would let a call hang before it
   * ever started. A session that arrives after a cancellation is closed by the
   * operation's own `finally`, so cancelling never leaks one.
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
    const cancelledPromise = new Promise((resolve) => { cancelResolve = resolve })
    const cancel = (kind) => {
      if (cancelled !== undefined) return
      cancelled = kind
      abortLive()
      cancelResolve(kind)
    }
    const onAbort = () => cancel('abort')

    // Armed BEFORE the first await: a subsystem request that is never answered is as
    // much a hang as a stalled transfer.
    timer = setTimeout(() => cancel('timeout'), deadline)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })

    // ONE release path for a lease that may be handed back by the caller-visible
    // cancellation branch OR by the operation's own finally — never twice, and never
    // forgotten when the operation is parked forever in `await openSftp`.
    let leasedClient
    let released = false
    const releaseLease = () => {
      if (leasedClient === undefined || released) return
      released = true
      try {
        this.pool.release?.(leasedClient)
      }
      catch {
        // Releasing a client the pool no longer knows is not a transfer failure.
      }
    }
    const operation = (async () => {
      let session
      try {
        leasedClient = await this.pool.get(host)
        if (cancelled !== undefined) return
        session = await openSftp(leasedClient)
        sftp = session
        phase = 'sftp'
        // The cancellation may have happened while the subsystem request was in flight:
        // report it, and let the finally close the late session.
        if (cancelled !== undefined) return
        if (direction === 'upload') {
          const local = statSync(localPath)
          if (local.isDirectory()) {
            if (!recursive) throw new NamedFailure(`localPath "${localPath}" is a directory; pass recursive: true to transfer a tree`)
            // The tree's own root exists even when it is empty.
            await ensureRemoteDirPath(sftp, remotePath)
            for (const entry of walkLocal(localPath)) {
              const target = remoteJoin(remotePath, entry.relative)
              if (entry.directory) {
                await ensureRemoteDirPath(sftp, target)
                continue
              }
              await ensureRemoteDirPath(sftp, remoteDirname(target))
              bytes += await uploadFile(sftp, entry.absolute, target, live)
              files += 1
            }
            return
          }
          await ensureRemoteDirPath(sftp, remoteDirname(remotePath))
          bytes = await uploadFile(sftp, localPath, remotePath, live)
          files = 1
          return
        }
        const remote = await statRemote(sftp, remotePath)
        if (remote === undefined) throw new NamedFailure(`remotePath "${remotePath}" does not exist on "${host.host}"`)
        if (isDirectoryMode(remote.mode)) {
          if (!recursive) throw new NamedFailure(`remotePath "${remotePath}" is a directory; pass recursive: true to transfer a tree`)
          // The tree's own root exists locally even when it is empty.
          mkdirSync(localPath, { recursive: true })
          for await (const entry of walkRemote(sftp, remotePath)) {
            const target = join(localPath, entry.relative)
            if (entry.directory) {
              mkdirSync(target, { recursive: true })
              continue
            }
            mkdirSync(dirname(target), { recursive: true })
            bytes += await downloadFile(sftp, entry.absolute, target, live)
            files += 1
          }
          return
        }
        mkdirSync(dirname(localPath), { recursive: true })
        bytes = await downloadFile(sftp, remotePath, localPath, live)
        files = 1
      }
      finally {
        // Covers every exit, including the late-session-after-cancel path.
        try {
          session?.end()
        }
        catch {
          // Closing an already-closed session is not a failure of the transfer.
        }
        // The lease ends when the operation does, whatever ended it.
        releaseLease()
      }
    })()
    // The race may abandon this promise; its late rejection is not a failure to report.
    operation.catch(() => {})
    try {
      const outcome = await Promise.race([
        operation.then(() => ({ kind: 'done' })),
        cancelledPromise.then((kind) => ({ kind })),
      ])
      if (outcome.kind !== 'done') {
        // ANY cancellation may leave a parked request on the pooled client: a subsystem
        // request nobody answers (phase 'connect') AND an OPEN/transfer request the
        // server never answers once the session exists (phase 'sftp') both park the
        // operation forever, so its finally never runs. Hand THIS call's lease back
        // here, then retire exactly the client it leased: the pool closes it with its
        // last lease (refs 0 => the parked request rejects), while a concurrent command
        // or transfer holding its own lease keeps the connection alive. With no lease
        // yet there is nothing to retire — the operation releases it once `get` resolves.
        // The REPORTED phase stays what the call reached ('connect' or 'sftp').
        if (leasedClient !== undefined) {
          releaseLease()
          try {
            this.pool.retire?.(alias, leasedClient)
          }
          catch {
            // A pool without leases cannot be retired; the transfer still reports out.
          }
        }
        return this.cancelledResult(outcome.kind, alias, phase, bytes, deadline)
      }
    }
    catch (error) {
      if (cancelled !== undefined) return this.cancelledResult(cancelled, alias, phase, bytes, deadline)
      if (error instanceof NamedFailure) return failure('sftp', alias, error.message, bytes)
      return failure(phase, alias, describe(error), bytes)
    }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    this.logger?.debug?.(`ssh_scp: ${direction} of ${files} file(s), ${bytes} byte(s) on "${alias}"`)
    return { ok: true, bytes, files }
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
