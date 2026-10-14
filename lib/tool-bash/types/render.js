/**
 * Model-facing result rendering for the bash tool.
 *
 * @module @deepseek-ai/dsh-tool-bash/render
 */
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output) {
    if (!output.truncated)
        return output.text;
    return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`;
}
/**
 * The marker an **automatically degraded** run carries: the policy asked for
 * confinement, the probe found no usable sandbox, and the command ran
 * unprotected. Wording follows the other sandbox notices — same `[sandbox: …]`
 * frame, and the same "here is the way out" ending as the runner-failure error
 * in the executors.
 *
 * An explicit `sandbox: none` also reports `sandbox.unconfined`, but it is the
 * deployment's own configuration rather than a surprise: the tool layer passes
 * `unconfinedIsAutomatic` only for the `auto` stance, so that case stays quiet.
 * @param mode - the policy mode the run was *supposed* to enforce.
 * @returns the marker line.
 */
export function unconfinedMarker(mode) {
    return `[sandbox: not applied — the confinement probe found no usable sandbox, so this command ran unconfined under ${mode} mode; repair the sandbox or set sandbox: none on this tool row to accept unconfined runs]`;
}
/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results.
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - the escalation targets this composition advertises;
 *   non-empty adds the same-turn escalation hint after a denial marker
 *   (default `[]`: no hint).
 * @param options.unconfinedIsAutomatic - whether THIS TOOL degraded to an
 *   unconfined run itself (`sandbox: auto` with a failed probe) rather than
 *   being told to run unconfined (`sandbox: none`); only the former is announced
 *   (default `false`).
 * @returns the model-facing text: output body (or `(no output)`), then any timeout/signal/exit markers, each on its own line.
 */
export function renderResult(result, escalationModes = [], options = {}) {
    const out = streamText(result.stdout);
    const err = streamText(result.stderr);
    let body = out;
    if (err.length > 0) {
        // Single newline between sections (stdout usually ends with one already).
        if (body.length > 0 && !body.endsWith('\n'))
            body += '\n';
        body += `[stderr]\n${err}`;
    }
    if (body.length === 0)
        body = '(no output)';
    const markers = [];
    // Keep the exit marker last because parseExitStatus anchors there.
    if (result.sandbox?.denied) {
        markers.push(sandboxDenialMarker(result.sandbox.mode));
        // Hint only when the composition exposes escalation, before the final exit marker.
        if (escalationModes.length > 0) {
            markers.push(escalationHintMarker('command'));
        }
    }
    // A run that was meant to be confined but was not: say so, or the model reads
    // an ordinary successful result while its files were never fenced. Cannot
    // coincide with a denial (an unconfined run has nothing to deny).
    if (result.sandbox?.unconfined === true && options.unconfinedIsAutomatic === true) {
        markers.push(unconfinedMarker(result.sandbox.mode));
    }
    // A command may trap SIGTERM and exit 0 after timeout; still report interruption.
    if (result.timedOut)
        markers.push(`[timed out after ${result.timeoutMs}ms]`);
    // A kill from outside the call (the human stopping its job) is not a command
    // failure: the reason tells the model not to retry. Same position and wording
    // as dsh's own shell renderer.
    if (result.stopped !== undefined)
        markers.push(`[stopped: ${result.stopped}]`);
    if (result.signal !== null) {
        markers.push(`[killed by signal: ${result.signal}]`);
    }
    else if (result.exitCode !== 0) {
        markers.push(`[exit code: ${result.exitCode}]`);
    }
    if (markers.length === 0)
        return body;
    if (!body.endsWith('\n'))
        body += '\n';
    return body + markers.join('\n');
}
/**
 * Shape a foreground call that stopped waiting into the text the model sees:
 * the output captured so far (one consuming registry read taken at that point,
 * so `job_output` continues exactly where this result stops), then the
 * still-running marker and the job hand-off guidance. Wording is dsh's
 * (`tool-bash/render.ts` `renderPromoted`), so the same sentence appears
 * whether the shell is `bash`, `git_bash` or `wsl_bash`.
 * @param promoted - the promoted result value: the job id, the expired wait, and the output so far.
 * @returns the model-facing text for a promoted call.
 */
export function renderPromoted(promoted) {
    const body = promoted.output.length > 0
        ? promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`
        : '';
    return `${body}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\n`
        + 'The command keeps running in the background. You will be notified when it finishes; '
        + 'read newer output with job_output, stop it with job_kill.';
}
/**
 * Shape the one consuming registry read a foreground call embeds in its result
 * when it stops waiting: the output produced so far, plus the dropped-output
 * notice (naming the job's spill files) when the model cursor fell behind the
 * ring, and the sandbox notices. Later `job_output` reads render the same ring
 * through the job tools.
 *
 * The loss notice is not decoration: the read taken here advances the cursor to
 * the ring's total, so the bytes it reports as dropped are the model's last
 * chance to learn they ever existed. Without it a promoted long-running command
 * hands back a plausible-looking prefix and no pointer to the retained output.
 * @param delta - the read's chunks as rendered text.
 * @param lossy - whether bytes before the delta were evicted unread.
 * @param spillPaths - the complete-stream files the job currently advertises.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @param options.unconfinedIsAutomatic - as {@link renderResult}: announce an
 *   unconfined sandbox only when this tool degraded to it itself (default `false`).
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderJobRead(delta, lossy, spillPaths, sandbox, escalationModes = [], options = {}) {
    const notices = [];
    if (lossy) {
        notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`);
    }
    if (sandbox?.runnerFailed) {
        notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`);
    }
    else if (sandbox?.denied) {
        notices.push(sandboxDenialMarker(sandbox.mode));
        if (escalationModes.length > 0) {
            notices.push(escalationHintMarker('command'));
        }
    }
    else if (sandbox?.unconfined === true && options.unconfinedIsAutomatic === true) {
        // Same fact as {@link renderResult}, for the promoted path: the seeded
        // read is the model's first sight of a call that stopped waiting.
        notices.push(unconfinedMarker(sandbox.mode));
    }
    if (notices.length === 0)
        return delta;
    return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`;
}
/**
 * The exit-status parse is the shared marker-contract half of the shell-tool
 * rendering story, owned by `@deepseek-ai/dsh-shell` so `dsh-tool-pwsh` reuses
 * it (its renderer emits the same markers). Re-exported here to keep
 * `../src/render.ts` a single import root for bash-tool consumers.
 */
export { parseExitStatus } from '@deepseek-ai/dsh-shell';
//# sourceMappingURL=render.js.map