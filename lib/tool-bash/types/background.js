/**
 * Generic-task adaptation for background bash process handles.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
/**
 * Sandbox facts worth a job's terminal detail: a runner that never ran the
 * command, or a denial (with the escalation hint this composition offers).
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the markers to append, oldest first.
 */
function sandboxNotes(sandbox, escalationModes) {
    if (sandbox?.runnerFailed) {
        return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`];
    }
    if (sandbox?.denied) {
        const notes = [sandboxDenialMarker(sandbox.mode)];
        if (escalationModes.length > 0)
            notes.push(escalationHintMarker('command'));
        return notes;
    }
    return [];
}
/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering.
 *
 * Sandbox facts join the detail because a job's terminal reason is the one line
 * every reader sees — the model's status line, the roster row — and a
 * sandbox-denied background command must not read as an ordinary nonzero exit.
 * A foreground call that was promoted into a job reaches this same function, so
 * the notes are not optional for it either.
 * @param proc - the settled process handle.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc, escalationModes = []) {
    // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
    // infrastructure-failure outcome, then map it to task `failed`. Restricted
    // runner failures expose sandbox.runnerFailed, but unconfined spawn failures
    // still alias a signal-less kill; real nonzero command exits must remain
    // `completed`.
    const base = proc.status === 'killed'
        ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
        : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` };
    const notes = sandboxNotes(proc.sandbox, escalationModes);
    return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` };
}
/**
 * The ring chunks of one consuming registry read, as the shell tools render a
 * process read: stdout chunks in order, then every stderr chunk in one
 * `[stderr]` section, so the output a foreground call hands over when it stops
 * waiting reads exactly like the `job_output` reads that follow it.
 * @param chunks - the chunks since the model cursor, in offset order.
 * @returns the delta text, possibly empty.
 */
export function ringDelta(chunks) {
    const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('');
    const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('');
    const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : '';
    return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '');
}
/**
 * The process's non-consuming stream readers as registry pull sources. They
 * bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job; a read before the spawn yields nothing, and the
 * pump keeps the model's consuming cursor untouched. A rejected spawn's
 * stderr reader carries the provider's `subprocess failed before reporting an
 * outcome: …` note.
 *
 * As of dsh 0.1.7 the registry owns the output ring and pumps these sources
 * itself; a background handle no longer hands its reads back through the
 * starter's return value.
 * @param proc - the started process, once the starter has spawned it (or `undefined` before).
 * @returns one source per stream, stdout first.
 */
export function processSources(proc) {
    const source = (channel) => ({
        channel,
        read: (fromByte) => {
            const live = proc();
            return live === undefined
                ? { text: '', nextOffset: fromByte, lossy: false }
                : live.observed[channel].readFrom(fromByte);
        },
    });
    return [source('stdout'), source('stderr')];
}
/**
 * Adapt asynchronous shell preparation after job admission without exposing a
 * partial process. The returned hooks settle only once preparation AND the
 * process have; a cancel before the spawn aborts preparation, and a cancel
 * after it kills the process.
 * @param start - starts the process with the job-owned cancellation signal.
 * @param outcome - projects the settled process into the job outcome.
 * @returns synchronous job hooks whose `done` includes preparation and settlement.
 */
export function processJob(start, outcome) {
    const controller = new AbortController();
    let process;
    return {
        cancel: (reason) => {
            if (controller.signal.aborted)
                return;
            controller.abort(reason);
            process?.kill();
        },
        done: (async () => {
            try {
                process = await start(controller.signal);
                try {
                    if (controller.signal.aborted)
                        process.kill();
                }
                finally {
                    await process.done;
                }
                return outcome(process);
            }
            catch (error) {
                return {
                    status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
                    detail: error instanceof Error ? error.message : String(error),
                };
            }
        })(),
    };
}
//# sourceMappingURL=background.js.map