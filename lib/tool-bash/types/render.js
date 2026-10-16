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
 * The SHORT marker every **automatically degraded** run carries: the policy
 * asked for confinement, no usable sandbox was found, and the command ran
 * unprotected. It is emitted on every such run, because the model must never
 * mistake one of them for a confined one; the reason and the two ways out are
 * stated once per tool row by {@link unconfinedDetailMarker}.
 *
 * An explicit `sandbox: none` also reports `sandbox.unconfined`, but it is the
 * deployment's own configuration rather than a surprise: the tool layer passes
 * `unconfinedIsAutomatic` only for the `auto` stance, so that case stays quiet.
 * @param mode - the policy mode the run was *supposed* to enforce.
 * @returns the marker line.
 */
export function unconfinedMarker(mode) {
    return `[sandbox: not applied — ran unconfined under ${mode} mode; reason and fix stated once per plugin load]`;
}
/**
 * The FULL explanation, emitted only for the FIRST automatically degraded run of
 * a given tool row (the row-scoped latch lives in the tool factory's `apply`):
 * what went wrong and both ways out. Wording follows the other sandbox notices —
 * same `[sandbox: …]` frame, and the same "here is the way out" ending as the
 * runner-failure error in the executors.
 * @param mode - the policy mode the run was *supposed* to enforce.
 * @returns the marker line.
 */
export function unconfinedDetailMarker(mode) {
    return `[sandbox: not applied — the confinement probe found no usable sandbox, so this command ran unconfined under ${mode} mode; repair the sandbox or set sandbox: none on this tool row to accept unconfined runs]`;
}
/**
 * The marker a confined run carries when it FAILED and its stderr matched none
 * of the denial signatures this host knows: the sandbox may or may not be the
 * reason, and the `denied` field is deliberately absent rather than false. The
 * wording points at the evidence instead of guessing.
 * @returns the marker line.
 */
export function unmatchedDialectMarker() {
    return '[sandbox: the command failed without matching this backend\'s denial dialect; see stderr]';
}

/**
 * The marker a REMOTE dialect's run carries.
 *
 * The local file sandbox governs the file effects of a command THIS host runs.
 * For a command that runs on another host there are no such effects to govern, so
 * no verdict is available: `denied` was never observed, `enforcement` never
 * happened, and `unconfined` — which means "a sandbox was asked for and could not
 * be applied" — would misdescribe a deliberate non-application. The structured
 * fact is `sandbox.remote: true`; this is what the model reads for it, on every
 * such run (there is no probe to fail, so there is nothing to explain once).
 * @param mode - the policy mode that was in force. Reported as the configuration
 *   fact it is, never as a claim about confinement.
 * @returns the marker line.
 */
export function remoteSandboxMarker(mode) {
    return `[sandbox: not applicable — this command runs on a remote host, so the local file sandbox (${mode} mode) was not applied and no verdict is claimed for its effects]`;
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
 * @param options.unconfinedDetail - whether this announcement is the row's FIRST
 *   automatic degradation: only then does the full explanation ride along, every
 *   later one carries just the short marker (default `false`).
 * @param options.unconfinedSilent - whether the announcement is suppressed
 *   entirely (`sandboxNotice: once` after the row's first degradation): the
 *   structured `sandbox.unconfined` fact still rides on the result, so nothing
 *   is hidden — only the repeated sentence is (default `false`).
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
    // A remote command has no local file effects, so the sandbox axis does not
    // apply to it at all: one honest sentence, and no borrowed verdict.
    const remoteSandbox = result.sandbox?.remote === true;
    // Keep the exit marker last because parseExitStatus anchors there.
    if (remoteSandbox) {
        markers.push(remoteSandboxMarker(result.sandbox.mode));
    }
    else if (result.sandbox?.denied) {
        markers.push(sandboxDenialMarker(result.sandbox.mode));
        // Hint only when the composition exposes escalation, before the final exit marker.
        if (escalationModes.length > 0) {
            markers.push(escalationHintMarker('command'));
        }
    }
    // A run that was meant to be confined but was not: say so, or the model reads
    // an ordinary successful result while its files were never fenced. Cannot
    // coincide with a denial (an unconfined run has nothing to deny).
    // Both remaining branches describe a LOCAL confinement decision, so a remote run
    // never enters them: an unmatched-denial message would blame a sandbox that was
    // never there, and an unconfined message would report a degradation that was
    // never attempted.
    if (!remoteSandbox && result.sandbox?.unconfined === true && options.unconfinedIsAutomatic === true) {
        if (options.unconfinedSilent !== true) {
            markers.push(options.unconfinedDetail === true
                ? unconfinedDetailMarker(result.sandbox.mode)
                : unconfinedMarker(result.sandbox.mode));
        }
    }
    // A confined run that FAILED with no matching denial signature: the fact has
    // no `denied` at all (see `denialFacts`), so say the sandbox is not the known
    // cause instead of letting the failure read as a plain command error.
    else if (!remoteSandbox && result.sandbox !== undefined
        && result.sandbox.denied === undefined
        && result.sandbox.unconfined === undefined
        && result.sandbox.runnerFailed === undefined
        && (result.exitCode !== 0 || result.signal !== null || result.timedOut === true)) {
        markers.push(unmatchedDialectMarker());
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
 * @param options.unconfinedDetail - as {@link renderResult}: this promotion is
 *   the row's first degradation, so the full explanation rides along (default `false`).
 * @param options.unconfinedSilent - as {@link renderResult}: suppress the
 *   announcement entirely (default `false`).
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderJobRead(delta, lossy, spillPaths, sandbox, escalationModes = [], options = {}) {
    const notices = [];
    if (lossy) {
        notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`);
    }
    if (sandbox?.remote === true) {
        // Same fact as {@link renderResult}, for the promoted path.
        notices.push(remoteSandboxMarker(sandbox.mode));
    }
    else if (sandbox?.runnerFailed) {
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
        if (options.unconfinedSilent !== true) {
            notices.push(options.unconfinedDetail === true
                ? unconfinedDetailMarker(sandbox.mode)
                : unconfinedMarker(sandbox.mode));
        }
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