/**
 * Internal sandbox-result classification helpers.
 *
 * @module @deepseek-ai/dsh-bash-sandbox/helpers
 */
import { accessSync, constants, statSync } from 'node:fs';
/** Node-local spawn codes proven to identify executable resolution or permission failure. */
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT']);
/** Whether the caller-owned spawn cwd can be entered. */
function isUsableWorkdir(path) {
    try {
        if (!statSync(path).isDirectory())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Attribute only Node ENOENT/EACCES failures whose error path equals argv[0]
 * after independently ruling out the caller-owned cwd. A supplied error path
 * must exactly identify the runner; without one, the syscall must. With a
 * usable cwd, these codes describe resolution or execute permission for that
 * argv[0] or its shebang interpreter.
 * The workdir is checked at classification time, not atomically with spawn;
 * concurrent path replacement may change attribution but cannot permit an
 * unconfined execution.
 * @param error - the original spawn rejection.
 * @param runnerProgram - provider argv[0], the executable that establishes confinement.
 * @param workdir - the caller-owned spawn cwd, checked independently for usability.
 * @returns whether the rejection has executable-specific runner evidence.
 */
export function isRunnerSpawnFailure(error, runnerProgram, workdir) {
    if (runnerProgram === undefined || !isUsableWorkdir(workdir))
        return false;
    if (typeof error !== 'object' || error === null)
        return false;
    const { code, path, syscall } = error;
    if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code))
        return false;
    if (typeof syscall !== 'string')
        return false;
    const exactSyscall = `spawn ${runnerProgram}`;
    if (path === undefined)
        return syscall === exactSyscall;
    if (typeof path !== 'string' || path.length === 0 || path !== runnerProgram)
        return false;
    return syscall === 'spawn' || syscall === exactSyscall;
}
/**
 * Classify a failed run against the selected backend's denial dialect.
 * @param result - settled foreground run.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @returns whether the failed run matches that denial dialect.
 */
export function classifyDenial(result, signatures) {
    return matchesSignature(result.exitCode, result.stderr.text, signatures);
}
/**
 * Classify one settled process against the selected backend's structured
 * runner-failure rules. Each rule requires a nonzero exit, its optional
 * exit-code gate, and a fatal signature on one stderr line after exact
 * informational lines are excluded. A rule may set `anchored: true` to match
 * the signature only at the line start (bwrap's own diagnostics always begin
 * with its prefix; a wrapped command echoing the same text mid-line is then
 * not misread as a runner failure).
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text, left unchanged.
 * @param rules - structured runner-failure rules from the active wrap.
 * @returns the first matching fatal line, or undefined when evidence is insufficient.
 */
export function classifyRunnerFailure(exitCode, stderr, rules) {
    if (exitCode === null || exitCode === 0)
        return undefined;
    const lines = stderr.split(/\r?\n/);
    for (const rule of rules) {
        if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode))
            continue;
        const informationalLines = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()));
        // An empty or whitespace-only substring is not meaningful runner evidence.
        // Ignore it while keeping any valid signatures beside it active.
        const fatalSignatures = rule.fatalSignatures
            .filter(signature => signature.trim().length > 0)
            .map(signature => signature.toLowerCase());
        const anchored = rule.anchored === true;
        for (const line of lines) {
            const lowered = line.toLowerCase();
            if (informationalLines.has(lowered))
                continue;
            if (fatalSignatures.some(signature => anchored ? lowered.startsWith(signature) : lowered.includes(signature)))
                return { detail: line };
        }
    }
    return undefined;
}
/**
 * Match a non-zero exit against case-insensitive stderr signatures.
 * @param exitCode - process exit code; null means signal termination.
 * @param stderr - collected stderr text.
 * @param signatures - substrings identifying the selected backend's dialect.
 * @returns whether this is a non-zero exit whose stderr matches a signature.
 */
export function matchesSignature(exitCode, stderr, signatures) {
    if (exitCode === null || exitCode === 0)
        return false;
    const lowered = stderr.toLowerCase();
    return signatures.some(signature => lowered.includes(signature.toLowerCase()));
}
/**
 * The `denied` fact for a confined run — or its deliberate ABSENCE.
 *
 * The provider ships a fixed English dialect per backend, but the text a denial
 * produces is written by whatever program the command ran, in whatever language
 * the host is set to (`cmd.exe` on a zh-CN Windows prints "拒绝访问。" while the
 * provider only lists English substrings). Reporting `denied: false` for such a
 * run invents a fact: "the sandbox did not deny this" is not something a failed
 * run with unknown stderr can support. So:
 * - a signature matches            → `{denied: true}` (the sandbox denied it);
 * - the run succeeded (exit 0)     → `{denied: false}` (nothing was denied);
 * - a failure matches nothing      → `{}` — the field is left out, and the
 *   renderer says so in words instead of asserting a falsehood.
 * @param exitCode - settled exit code; null means signal termination.
 * @param stderr - collected stderr text.
 * @param signatures - provider signatures ∪ whatever this host taught us.
 * @returns the sandbox fact fragment to merge into the result.
 */
export function denialFacts(exitCode, stderr, signatures) {
    if (matchesSignature(exitCode, stderr, signatures))
        return { denied: true };
    if (exitCode === 0)
        return { denied: false };
    return {};
}
/**
 * Learn one denial signature from a probe write that the sandbox refused.
 *
 * The text is whatever the child printed, so it is trimmed down to the stable
 * part: the last non-empty line, with the caller-supplied tokens (the probe's
 * path segments) and any remaining path- or token-shaped runs replaced by a
 * space. A result shorter than 4 or longer than 120 characters is refused —
 * too short to identify a dialect, too long to be a signature.
 *
 * Known limit, stated rather than hidden: a host whose refusal text is not
 * UTF-8 (a localized Windows message captured through a UTF-8 decode) yields
 * replacement characters. They still match consistently against the same decode
 * of the same program's later output, so the signature is kept rather than
 * dropped — but it is only as meaningful as the console code page makes it.
 * @param stderr - raw stderr text from the refused write.
 * @param redact - caller-known tokens (probe file name, probe path, root) to strip.
 * @returns the learned signature, or undefined when nothing usable came back.
 */
export function learnedDenialSignature(stderr, redact = []) {
    if (typeof stderr !== 'string')
        return undefined;
    const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined)
        return undefined;
    let text = last;
    for (const token of redact) {
        if (typeof token !== 'string' || token.length === 0)
            continue;
        text = text.split(token).join(' ');
        text = text.split(token.replaceAll('\\', '/')).join(' ');
    }
    const trimmed = text
        // the shell's own diagnostic prefix (`bash: line 3: …`) — the line number
        // moves with the payload's shape, so it can never be part of a signature
        .replace(/^[^\s:]+:\s*line\s+\d+:\s*/i, ' ')
        // native drive paths and POSIX paths (with or without a trailing token)
        .replace(/[A-Za-z]:\\[^\s]*|\/(?:[^\s/]+\/)*[^\s]*/g, ' ')
        // random-looking tokens (the probe name's suffix, hex ids)
        .replace(/[0-9a-f]{8,}/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s:;,.!?—-]+/, '')
        .replace(/[\s:;,.!?—-]+$/, '')
        .trim();
    if (trimmed.length < 4 || trimmed.length > 120)
        return undefined;
    return trimmed;
}
//# sourceMappingURL=helpers.js.map