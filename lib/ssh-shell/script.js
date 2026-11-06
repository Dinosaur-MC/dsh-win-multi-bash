/**
 * The remote POSIX script one ssh_shell call runs, and the base64 payload that
 * carries it to the host.
 *
 * The command line on the channel is the host's STATIC `shellTemplate` (default
 * `bash -c 'eval "$(base64 -d)"'`), and the script below is what that template
 * decodes from stdin (spec §8.2). Nothing here is ever interpolated into a shell
 * string: the script IS the program the remote shell runs, which is what makes a
 * command containing quotes, `$` or newlines safe without any escaping of its own.
 *
 * The shape is fixed:
 *
 *     { <startupCommand>
 *     } || exit $?                          # only when a startup command is set
 *     cd -- <quoted workdir> || exit $?     # only when a workdir is given
 *     <command>
 *
 * The group closes on its OWN line on purpose. A one-line `{ <startup>; }` cannot
 * hold three legal POSIX snippets — measured with bash: a startup ending in a
 * comment swallows the closing brace (`export P=42 # setup` => syntax error, the
 * command never runs), a here-document needs its terminator alone on a line, and an
 * empty body (`;`) leaves `{ ; }`, which bash rejects outright. The newline costs
 * nothing and makes all three work.
 *
 * A guard that fails stops the call with its own status instead of running the
 * command in a half-prepared shell — that is the difference between "the command
 * failed" and "the command ran somewhere else than asked".
 * @module dsh-win-multi-bash/ssh-shell/script
 */

/**
 * Quote one value as a single POSIX shell word.
 *
 * Single quotes make every character literal; the only escape needed is the quote
 * itself, written by closing the quoted run, escaping one quote, and reopening it
 * (`'it'\''s'`). This is the ONLY place a foreign value enters the script, and it
 * is used for the workdir — never for the command.
 * @param value - the value to quote.
 * @returns one shell word, quotes included.
 */
export function quoteShell(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'"
}

/**
 * Build the script and its payload for one call.
 * @param options.startupCommand - the host's startup snippet, run before everything
 *   else; omitted (or blank) means no guard line.
 * @param options.workdir - an absolute POSIX path ON THE REMOTE HOST; omitted means
 *   "stay where the host's shell started".
 * @param options.command - the command; it is the script's body, verbatim.
 * @returns `{ script, payload }` — the text, and its base64 UTF-8 encoding.
 */
/** The startup group prints this marker on stderr before failing; the executor turns
 * it into a message that names the configured field, then removes it. The record
 * separator cannot appear in ordinary shell output. */
export const STARTUP_FAILED_MARKER = '\u001eDSH-STARTUP-FAILED\u001e';

/** Escape one literal for use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The first word of a shell command line (quotes stripped), or ''. */
function firstShellWord(template) {
  const match = String(template ?? '').trim().match(/^('[^']*'|"[^"]*"|\S+)/)
  if (match === null) return ''
  return match[1].replace(/^['"]|['"]$/g, '')
}

/**
 * Explain a failed call when the failure came from CONFIGURATION rather than the
 * command. A startup failure carries the sentinel; a missing shell template is a
 * 127 whose stderr names the template's first token but never the field.
 *
 * @returns `{ text, field }` — the text to report, and which configured field (if
 *   any) was identified. Ordinary failures return the original text and `null`.
 */
export function explainFailure({ alias, stderr, exitCode, shellTemplate }) {
  const raw = String(stderr ?? '')
  const name = alias === undefined || alias === null || alias === '' ? '(unnamed host)' : String(alias)
  if (raw.includes(STARTUP_FAILED_MARKER)) {
    const withoutMarker = raw.split(new RegExp(escapeRegExp(STARTUP_FAILED_MARKER) + '\\n?', 'g')).join('')
    const first = withoutMarker.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? 'the startup command failed'
    return {
      field: 'startupCommand',
      text: `ssh: host "${name}" started, but its 启动命令 (startupCommand) failed: ${first}`
        + (withoutMarker.trim() === '' ? '' : '\n' + withoutMarker),
    }
  }
  const word = firstShellWord(shellTemplate)
  if (exitCode === 127 && word !== '') {
    const candidates = [...new Set([word, word.replace(/\\/g, '')])]
    const found = candidates.some((candidate) =>
      new RegExp('(?:^|\\n)(?:[^\\n]*:\\s)?' + escapeRegExp(candidate) + ':\\s+(?:command not found|No such file or directory)', 'i').test(raw))
    if (found) {
      return {
        field: 'shellTemplate',
        text: `ssh: host "${name}" could not start its shell template (${word}): ${raw.trim()}`,
      }
    }
  }
  return { field: null, text: raw }
}

export function buildScript({ startupCommand, workdir, command }) {
  const lines = []
  if (typeof startupCommand === 'string') {
    const startup = startupCommand.trim()
    // Normalise the terminator: a configured trailing semicolon would otherwise
    // produce a doubled one, and a snippet that is only ';' has no body at all.
    const body = startup.replace(/[;\s]+$/, '')
    // A body that is ONLY comments has nothing to run, and an empty brace group is a
    // bash syntax error (measured: rc=2). Treat it as "no startup".
    const runnable = body.split('\n').some((line) => {
      const text = line.trim()
      return text.length > 0 && !text.startsWith('#')
    })
    // The group closes on its own line: see the module header (a comment, a
    // here-document or an empty body each break the one-line form under real bash).
    // Capture the group's status before printf overwrites `$?`; the call still
    // exits with the startup command's own code.
    if (runnable) lines.push('{ ' + body + '\n} || { __dsh_startup_rc=$?; printf "\\036DSH-STARTUP-FAILED\\036\\n" >&2; exit $__dsh_startup_rc; }')
  }
  // Only "not configured" is absent. The value is NEVER trimmed: a directory whose
  // name ends in a space is legal, and a whitespace-only path must attempt the cd
  // and fail honestly rather than silently running somewhere else.
  if (typeof workdir === 'string' && workdir.length > 0)
    lines.push('cd -- ' + quoteShell(workdir) + ' || exit $?')
  lines.push(String(command ?? ''))
  let script = lines.join('\n')
  // Exactly one trailing newline: a script without one can lose its last command on
  // some shells, and a second one is a harmless but noisy extra statement.
  if (!script.endsWith('\n')) script += '\n'
  return { script, payload: Buffer.from(script, 'utf8').toString('base64') }
}
