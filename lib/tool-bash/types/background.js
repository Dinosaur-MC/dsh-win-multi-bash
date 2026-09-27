/**
 * Generic-task adaptation for background bash process handles.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */
/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc) {
    // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
    // infrastructure-failure outcome, then map it to task `failed`. Restricted
    // runner failures expose sandbox.runnerFailed, but unconfined spawn failures
    // still alias a signal-less kill; real nonzero command exits must remain
    // `completed`.
    if (proc.status === 'killed') {
        return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' };
    }
    return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` };
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