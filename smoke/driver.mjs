#!/usr/bin/env node
/**
 * Smoke driver for the dsh-win-multi-bash plugin rows: boot the real app boot
 * path over the real runtime packages with the plugin's exact rows, verify the
 * git_bash / wsl_bash tools are registered, then execute one real command
 * through each and through the base bundle's own `ctx.shell` seat, and print a
 * JSON report. Same boot pattern as the harness's own windows-loader smoke
 * spec.
 *
 * Usage: node driver.mjs <fixture.yml>
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (!configPath) throw new Error('usage: node driver.mjs <fixture.yml>')

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
  await runTool('wsl_bash', 'echo wsl-ok', 'smoke-wsl-bash')

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

  console.log(JSON.stringify(report, null, 2))
} finally {
  await ctx.fiber.dispose()
}
