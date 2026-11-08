/**
 * The ONE place ssh2 is loaded. A deployment that installs this plugin without the
 * ssh2 dependency must still be able to LOAD every row: the SSH row is opt-in, and
 * the terminal row no longer touches ssh2 at all. Loading is therefore deferred to
 * first property access, and a missing dependency becomes a named error with a
 * stable code instead of a raw ERR_MODULE_NOT_FOUND at import time.
 *
 * The proxy forwards every property to the real module, so call sites keep using
 * `ssh2.Client` / `ssh2.utils` unchanged.
 * @module dsh-win-multi-bash/ssh-shell/ssh2
 */
import { createRequire } from 'node:module'

/** The sentence every missing-transport failure carries. */
export const SSH2_MISSING_MESSAGE = 'ssh2 is not installed for this deployment; install the package dependency'

let loaded
let loadError
try {
  loaded = createRequire(import.meta.url)('ssh2')
}
catch (error) {
  loadError = error
}

/** One named failure, carrying the original resolution error as its cause. */
function missingSsh2() {
  const error = new Error(SSH2_MISSING_MESSAGE)
  error.code = 'DSH_SSH2_MISSING'
  if (loadError !== undefined) error.cause = loadError
  return error
}

export default new Proxy({}, {
  get(_target, property) {
    if (loaded === undefined) throw missingSsh2()
    return loaded[property]
  },
})
