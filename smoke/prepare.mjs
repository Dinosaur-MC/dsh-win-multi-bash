#!/usr/bin/env node
/**
 * Smoke bootstrap for dsh-win-multi-bash: the ONE Node entry that replaced two
 * PowerShell scripts (`run.ps1` for the driver smoke, `audit.ps1` for the suite).
 *
 * WHY NODE. Both scripts re-implemented the same junction setup, and `run.ps1` also
 * re-implemented the PLUGIN OWN Git Bash probe in PowerShell — two copies of a strategy
 * allowed to have one. Node needs no PowerShell dialect branch either (measured on this
 * machine: PowerShell 5.1 non-recursive `Remove-Item` on a junction throws
 * `System.NullReferenceException` while 7.6 removes it, which is why the scripts had to
 * shell out to `cmd /c rmdir`), and no UTF-8 BOM in its source.
 *
 * WHAT IT DOES
 *   1. Links the REAL runtime where the packaged code resolves `@deepseek-ai/*` by real
 *      path, refusing to overwrite anything that is not already the expected link:
 *        <pluginRoot>/node_modules/@deepseek-ai -> <profile>/node_modules/@deepseek-ai
 *        smoke/node_modules/@deepseek-ai        -> the same scope
 *        smoke/node_modules/dsh-win-multi-bash  -> the plugin root
 *   2. Generates the fixtures from `smoke/fixture.template.cordis.yml` into `.temp/smoke/`
 *      (covered by the `.temp` rule in `.gitignore`), substituting the runtime-conditional
 *      service rows and, for the pinned variant, the path the PLUGIN resolver finds.
 *   3. Runs the requested entry with this repository Node: the smoke driver (default) or
 *      the audit suite (`audit`).
 *   4. Tears the two `smoke/` links down in a `finally`, removing the link itself and never
 *      anything through it. `<pluginRoot>/node_modules/@deepseek-ai` is NOT removed: it
 *      belongs to the checkout. `--keep-links` skips the teardown when debugging a boot.
 *
 * Usage:
 *   node smoke/prepare.mjs               # npm test: driver smoke, default + pinned fixture
 *   node smoke/prepare.mjs audit         # npm run test:audit: the audit suite
 *   node smoke/prepare.mjs --keep-links  # leave smoke/node_modules linked afterwards
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBashPath } from '../lib/bash-git/index.js'

const smoke = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(smoke)
const runtimeScope = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
const nmDir = join(smoke, 'node_modules')
const linkPlugin = join(nmDir, 'dsh-win-multi-bash')
const linkScope = join(nmDir, '@deepseek-ai')
const pluginScope = join(pluginRoot, 'node_modules', '@deepseek-ai')
const fixtureDir = join(pluginRoot, '.temp', 'smoke')
const keepLinks = process.argv.includes('--keep-links')
const mode = process.argv.slice(2).find((argument) => !argument.startsWith('-')) || 'driver'

/**
 * Whether two paths name the same location. A junction target can come back with a
 * `\\?\` prefix, which is not part of the path, so the prefix is dropped before the
 * comparison (Windows paths compare case-insensitively).
 */
const samePath = (left, right) => {
  const clean = (value) => value.split('?').pop().split('/').join('\\').toLowerCase()
  return clean(left) === clean(right)
}

/**
 * Make sure `path` is a link to `target`, creating it when absent. An existing entry that
 * is not that link is REFUSED: this script may add to a node_modules tree, never repoint
 * something a human put there.
 * @returns true when this call created the link.
 */
function ensureLink(path, target) {
  if (existsSync(path)) {
    const stats = lstatSync(path)
    if (!stats.isSymbolicLink()) throw new Error(path + ' already exists and is not a junction: refusing to touch it')
    if (!samePath(readlinkSync(path), target)) throw new Error(path + ' points at ' + readlinkSync(path) + ', not ' + target + ': refusing to repoint it')
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'junction')
  return true
}

/** Run one entry with this repository Node and fail the bootstrap when it fails. */
function runEntry(label, argv) {
  console.log('\n=== ' + label + ' ===')
  const result = spawnSync(process.execPath, argv, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(label + ' exited with ' + result.status)
}

/** Remove the link itself; a non-recursive removal never descends into the target. */
function unlinkIfLink(path) {
  if (!existsSync(path)) return
  if (lstatSync(path).isSymbolicLink()) rmSync(path)
}

if (!existsSync(runtimeScope)) {
  throw new Error('runtime not found: ' + runtimeScope + ' (install or update the dsh profile runtime first)')
}
if (mode !== 'driver' && mode !== 'audit') {
  throw new Error('unknown mode: ' + mode + ' (expected "driver" or "audit")')
}

try {
  // 1. The links. The plugin-root scope belongs to the checkout: created when missing,
  //    never removed by this script.
  ensureLink(pluginScope, runtimeScope)
  ensureLink(linkPlugin, pluginRoot)
  ensureLink(linkScope, runtimeScope)

  // 2. The fixtures.
  mkdirSync(fixtureDir, { recursive: true })
  const template = readFileSync(join(smoke, 'fixture.template.cordis.yml'), 'utf8')
  // dsh 0.2.1-alpha.2 introduced @deepseek-ai/dsh-working-directory and made its own
  // tool-pwsh inject `workingDirectory`. That service comes from the working-directory
  // row, which injects the `fs` service the fs-sandbox row provides, so mirror that
  // minimal chain only when the runtime ships the package: one fixture stays valid on
  // every supported dsh version.
  const alpha2Rows = existsSync(join(runtimeScope, 'dsh-working-directory'))
    ? "- id: fs-sandbox\n  name: '@deepseek-ai/dsh-fs-sandbox'\n\n- id: working-directory\n  name: '@deepseek-ai/dsh-working-directory'\n"
    : ''
  const withRows = template.replaceAll('__ALPHA2_SERVICE_ROWS__', alpha2Rows)

  if (mode === 'audit') {
    runEntry('audit suite', [join(smoke, 'audit.test.mjs')])
  } else {
    const defaultFixture = join(fixtureDir, 'fixture.default.cordis.yml')
    writeFileSync(defaultFixture, withRows.replaceAll('__BASH_PATH__', ''))
    runEntry('driver: default (schema-default bash resolution)', [join(smoke, 'driver.mjs'), defaultFixture])
    // The pinned variant pins what the PLUGIN resolver finds, never a hardcoded path.
    const gitBash = process.env.DSH_AUDIT_GIT_BASH || resolveBashPath(undefined, process.env, process.platform) || ''
    if (gitBash.length > 0) {
      const pinnedFixture = join(fixtureDir, 'fixture.pinned.cordis.yml')
      writeFileSync(pinnedFixture, withRows.replaceAll('__BASH_PATH__', gitBash))
      runEntry('driver: pinned (explicit gitBash.bashPath -> ' + gitBash + ')', [join(smoke, 'driver.mjs'), pinnedFixture])
    } else {
      console.log('\n=== pinned (skipped: no Git Bash found on this machine) ===')
    }
  }
} finally {
  if (keepLinks) {
    console.log('\n(--keep-links: smoke/node_modules left linked)')
  } else {
    unlinkIfLink(linkPlugin)
    unlinkIfLink(linkScope)
    try { if (readdirSync(nmDir).length === 0) rmdirSync(nmDir) } catch { /* leave whatever is there */ }
  }
}
