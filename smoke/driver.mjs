#!/usr/bin/env node
/**
 * Smoke driver for the dsh-win-multi-bash plugin rows: boot the real app boot
 * path over the real runtime packages with the plugin's exact rows, verify the
 * git_bash / wsl_bash tools are registered, then execute one real command
 * through each AVAILABLE tool and through the base bundle's own `ctx.shell`
 * seat, and print a JSON report. Same boot pattern as the harness's own
 * windows-loader smoke spec.
 *
 * A `wsl.exe` on disk is not a usable WSL: GitHub-hosted Windows images install
 * WSL without a distribution. The driver still proves the row registered and
 * advertises its facts, but it can only run a real WSL command when a default
 * distribution actually answers; otherwise the run is reported as a skip.
 *
 * Usage: node driver.mjs <fixture.yml>
 */

import { spawnSync } from 'node:child_process'

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (!configPath) throw new Error('usage: node driver.mjs <fixture.yml>')

/** A default distribution that actually answers — not merely a launcher on disk. */
function hasUsableWsl() {
  try {
    const launcher = process.env.DSH_AUDIT_WSL ?? 'wsl.exe'
    return spawnSync(launcher, ['-e', 'true'], { timeout: 30000, stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const wslUsable = hasUsableWsl()

const ctx = await boot('dsh-win-multi-bash-smoke', resolveConfigPath(configPath, undefined))
try {
  const schemas = ctx.tools.schemas()
  const names = schemas.map((t) => t.name).sort()
  const gitBash = schemas.find((t) => t.name === 'git_bash')
  const wslBash = schemas.find((t) => t.name === 'wsl_bash')

  const report = {
    booted: true,
    toolNames: names,
    gitBashPresent: gitBash !== undefined,
    wslBashPresent: wslBash !== undefined,
    gitBashDescriptionHasMsys: gitBash?.description.includes('Git Bash') ?? false,
    wslBashDescriptionHasWsl: wslBash?.description.includes('WSL') ?? false,
    // Regression guard: our tools own their executors and never occupy the
    // seat, so the base bundle's pwsh executor — and with it every plugin that
    // injects `shell` — must still be alive while our rows are loaded.
    shellSeatPresent: ctx.shell !== undefined,
    wslUsable,
    skips: [],
    runs: {},
  }

  async function runTool(name, command, callId) {
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(callId),
        name,
        arguments: { command, description: `smoke ${name}` },
      })
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .replace(/\r\n/g, '\n')
      report.runs[name] = { ok: true, text: text.slice(0, 200) }
    } catch (error) {
      report.runs[name] = { ok: false, error: String(error?.message ?? error).slice(0, 300) }
    }
  }

  await runTool('git_bash', 'echo git-bash-ok', 'smoke-git-bash')
  if (wslUsable) {
    await runTool('wsl_bash', 'echo wsl-ok', 'smoke-wsl-bash')
  } else {
    report.skips.push('wsl_bash: no usable WSL distribution; registration and description were still asserted')
    console.log('… skipping wsl_bash real command: no usable WSL distribution on this host')
  }

  // The base bundle's seat: resolved and executed exactly as dsh's own
  // tool-pwsh would, proving our rows left `ctx.shell` intact.
  try {
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      command: 'echo pwsh-ok',
      signal: new AbortController().signal,
    }))).result()
    report.runs.pwsh = {
      ok: result.exitCode === 0,
      text: result.stdout.text.replace(/\r\n/g, '\n').slice(0, 200),
    }
  } catch (error) {
    report.runs.pwsh = { ok: false, error: String(error?.message ?? error).slice(0, 300) }
  }

  // A report is not a verdict. This entry point is what `npm test` runs, so a missing
  // tool or a failed command has to FAIL it: otherwise a plugin whose rows never
  // registered still exits 0 and the default entry point proves nothing. The JSON is
  // printed first so the diagnosis is still there for a human.
  console.log(JSON.stringify(report, null, 2))
  const failures = []
  if (!report.gitBashPresent) failures.push('git_bash is not registered')
  if (!report.wslBashPresent) failures.push('wsl_bash is not registered')
  if (!report.gitBashDescriptionHasMsys) failures.push('the git_bash description is missing its own facts')
  if (!report.wslBashDescriptionHasWsl) failures.push('the wsl_bash description is missing its own facts')
  if (!report.shellSeatPresent) failures.push("the base bundle's ctx.shell seat is gone")
  for (const [name, run] of Object.entries(report.runs)) if (run.ok !== true) failures.push(name + ': ' + (run.error ?? 'failed'))
  if (failures.length > 0) throw new Error('smoke driver failed: ' + failures.join('; '))
} finally {
  await ctx.fiber.dispose()
}
