/**
 * The SSH row's host-endpoint route.
 *
 * The hosts table's "Test connection" and the per-session approval-scope marker
 * belong to the SSH row: they speak to ssh2 (probe/pool/known_hosts), and the
 * terminal row must stay free of that transport. This module owns the endpoints
 * and their `/win-mb-ssh` prefix channel; the terminal row carries sessions only.
 *
 * Envelopes are the SAME values the terminal dispatcher used to return:
 * `{ ok: true, value }` or `{ ok: false, error: { code, phase?, message, details } }`.
 * @module dsh-win-multi-bash/ssh-shell/hosts-route
 */
import { probeHost as defaultProbeHost } from './probe.js'
import { clearApprovalScope as defaultClearApprovalScope, markApprovalScope as defaultMarkApprovalScope } from './approval.js'

/** The HTTP route prefix owned by this row. */
export const HOSTS_ROUTE_PATH = '/win-mb-ssh'

/** The 64 KiB cap on one host-route request body. */
const HOSTS_ROUTE_MAX_BYTES = 65536

/**
 * The hosts-table endpoint dispatcher. Only `hosts.test` and
 * `hosts.approvalScope` live here; the session endpoints stayed on the terminal
 * row.
 * @param options.probeHost - the host prober (injectable so a test never dials).
 * @param options.markApprovalScope - the approval-scope marker (injectable for tests).
 * @param options.clearApprovalScope - the scope clearer (injectable for tests).
 * @returns one async endpoint dispatcher.
 */
export function createHostsDispatch({ probeHost = defaultProbeHost, markApprovalScope = defaultMarkApprovalScope, clearApprovalScope = defaultClearApprovalScope } = {}) {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'hosts.approvalScope') {
        const callId = typeof payload?.callId === 'string' ? payload.callId : ''
        const scope = payload?.scope
        const validCall = callId !== '' && callId.length <= 256
        if (validCall !== true || (scope !== 'once' && scope !== 'session' && scope !== 'clear'))
          return { ok: false, error: { code: 'hosts/bad-request', message: 'terminal: hosts.approvalScope needs a callId (<=256 chars) and scope once|session|clear', details: {} } }
        if (scope === 'clear') {
          clearApprovalScope(callId)
          return { ok: true }
        }
        if (markApprovalScope(callId, scope) !== true)
          return { ok: false, error: { code: 'hosts/bad-request', message: 'terminal: the approval scope could not be recorded', details: {} } }
        return { ok: true }
      }
      if (endpoint === 'hosts.test') {
        const host = payload?.host
        if (host === null || typeof host !== 'object' || Array.isArray(host))
          return { ok: false, error: { code: 'hosts/test-failed', phase: 'config', message: 'terminal: hosts.test needs one host object', details: {} } }
        let result
        try {
          result = await probeHost(host)
        }
        catch (error) {
          // A missing transport is a CONFIGURATION fact, not a failed connection.
          if (error?.code === 'DSH_SSH2_MISSING')
            return { ok: false, error: { code: 'hosts/test-failed', phase: 'config', message: 'ssh-shell: ' + error.message, details: {} } }
          return { ok: false, error: { code: 'hosts/test-failed', phase: 'connect', message: 'ssh-shell: the host test failed: ' + String(error?.message ?? error), details: {} } }
        }
        if (result?.ok === true) {
          const value = {}
          if (typeof result.fingerprint === 'string') value.fingerprint = result.fingerprint
          if (typeof result.warning === 'string' && result.warning !== '') value.warning = result.warning
          return { ok: true, value }
        }
        return {
          ok: false,
          error: {
            code: 'hosts/test-failed',
            phase: typeof result?.phase === 'string' ? result.phase : 'connect',
            message: String(result?.message ?? 'ssh-shell: the host test failed'),
            details: {},
          },
        }
      }
      return { ok: false, error: { code: 'ssh-shell/unknown-endpoint', message: 'ssh-shell: unknown hosts endpoint ' + JSON.stringify(endpoint), details: {} } }
    }
    catch (error) {
      return { ok: false, error: { code: 'ssh-shell/failure', message: String(error?.message ?? error), details: {} } }
    }
  }
}

/**
 * The HTTP handler for the `/win-mb-ssh` prefix route.
 *
 * Same trust fence and body rules as the terminal route: host admission first
 * (503 without a fence, the rejection status echoed), POST only, JSON only,
 * 64 KiB cap, then one small endpoint dispatcher.
 * @param options - the host context, the dispatcher and an optional byte cap.
 * @returns one async `(req, res)` handler.
 */
export function createHostsRouteHandler({ hostCtx, dispatch, maxBytes = HOSTS_ROUTE_MAX_BYTES }) {
  const badRequest = (res, message) => {
    if (res.headersSent === true) { res.end(); return }
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'ssh-shell/bad-request', message: String(message), details: {} } }))
  }
  return async (req, res) => {
    try {
      if (typeof hostCtx?.connection?.requestRejection !== 'function') {
        if (res.headersSent !== true) res.writeHead(503)
        res.end()
        return
      }
      const rejection = hostCtx.connection.requestRejection(req)
      if (rejection !== undefined) {
        if (res.headersSent !== true) res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        if (res.headersSent !== true) res.writeHead(405, { Allow: 'POST' })
        res.end()
        return
      }
      const contentType = typeof req.headers?.['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
      if (!contentType.includes('application/json')) {
        if (res.headersSent !== true) res.writeHead(415)
        res.end('unsupported media type')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const prefix = HOSTS_ROUTE_PATH + '/'
      const endpoint = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
      if (endpoint === '') {
        if (res.headersSent !== true) res.writeHead(404)
        res.end()
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBytes) {
          badRequest(res, 'ssh-shell: the hosts request body exceeds ' + maxBytes + ' bytes')
          return
        }
        chunks.push(chunk)
      }
      let payload = {}
      if (chunks.length > 0) {
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        }
        catch (error) {
          badRequest(res, error?.message ?? error)
          return
        }
      }
      const result = await dispatch(endpoint, payload)
      if (res.headersSent !== true) res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    }
    catch (error) {
      badRequest(res, error?.message ?? error)
    }
  }
}

/**
 * Register the `/win-mb-ssh` prefix route on one web server.
 * @param webServer - the injected host web server.
 * @param handler - the route handler.
 * @param warn - the row's warning sink.
 * @returns the disposer, or undefined when the route could not be registered.
 */
export function registerHostsRoute(webServer, handler, warn) {
  if (typeof webServer?.register !== 'function') return undefined
  let dispose
  try {
    dispose = webServer.register({ kind: 'prefix', path: HOSTS_ROUTE_PATH, handler })
  }
  catch (error) {
    warn?.('ssh-shell: registering the hosts route failed: ' + String(error?.message ?? error))
    return undefined
  }
  return () => {
    try {
      if (typeof dispose === 'function') dispose()
    }
    catch (error) {
      warn?.('ssh-shell: disposing the hosts route failed: ' + String(error?.message ?? error))
    }
  }
}

/**
 * The channel registration for one apply: a prefix route when the host exposes a
 * web server, the legacy Connection-RPC channel otherwise.
 *
 * REPLACE-ON-INJECT for the same reason as the terminal row: Cordis can hand a
 * new host context to the callback while the row stays mounted, so stale
 * registrations are disposed before the replacement is built.
 * @param options - the row context (for `effect`), the dispatcher and warning sink.
 * @returns one `(hostCtx) => void` registrar.
 */
export function createHostsChannelRegistrar({ ctx, dispatch, warn }) {
  let routeDispose
  let channelDispose
  const clearRoute = () => {
    const dispose = routeDispose
    routeDispose = undefined
    if (typeof dispose === 'function') dispose()
  }
  const clearChannel = () => {
    const dispose = channelDispose
    channelDispose = undefined
    if (typeof dispose === 'function') dispose()
  }
  ctx.effect(() => () => {
    clearRoute()
    clearChannel()
  }, 'dsh-win-multi-bash: ssh hosts channel')
  return (hostCtx) => {
    if (typeof hostCtx?.webServer?.register === 'function') {
      clearRoute()
      clearChannel()
      const dispose = registerHostsRoute(hostCtx.webServer, createHostsRouteHandler({ hostCtx, dispatch }), warn)
      if (typeof dispose === 'function') routeDispose = dispose
      return
    }
    let connection
    try {
      // Registration on the ROOT connection: rpc.handle reads the owner's
      // webServer through the calling fiber, and a sub-fiber without that
      // inject throws `cannot get property "webServer" without inject`.
      connection = ctx.root?.get?.('connection') ?? hostCtx?.get?.('connection') ?? hostCtx?.connection
    }
    catch {
      connection = undefined
    }
    if (typeof connection?.rpc?.handle !== 'function') return
    clearChannel()
    clearRoute()
    const dispose = connection.rpc.handle(HOSTS_ROUTE_PATH, (endpoint, payload) => dispatch(endpoint, payload))
    if (typeof dispose === 'function') channelDispose = dispose
  }
}
