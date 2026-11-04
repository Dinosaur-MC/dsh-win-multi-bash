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
 *     { <startupCommand>; } || exit $?      # only when a startup command is set
 *     cd -- <quoted workdir> || exit $?     # only when a workdir is given
 *     <command>
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
export function buildScript({ startupCommand, workdir, command }) {
  const lines = []
  const startup = typeof startupCommand === 'string' ? startupCommand.trim() : ''
  if (startup.length > 0) {
    // Normalise the terminator: a configured trailing semicolon would otherwise
    // produce `;;`, which a POSIX shell rejects outright.
    const body = startup.replace(/[;\s]+$/, '')
    lines.push('{ ' + body + '; } || exit $?')
  }
  const directory = typeof workdir === 'string' ? workdir.trim() : ''
  if (directory.length > 0) lines.push('cd -- ' + quoteShell(directory) + ' || exit $?')
  lines.push(String(command ?? ''))
  let script = lines.join('\n')
  // Exactly one trailing newline: a script without one can lose its last command on
  // some shells, and a second one is a harmless but noisy extra statement.
  if (!script.endsWith('\n')) script += '\n'
  return { script, payload: Buffer.from(script, 'utf8').toString('base64') }
}
