/**
 * Generic-task adaptation for background bash process handles.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
// The unconfined notes have ONE source: `render.js` owns both wordings for the
// foreground result, and this import keeps the job's terminal detail from
// drifting into a second copy of either sentence — and so does the REMOTE note,
// so a job can never describe one of these runs in words the foreground does not use.
import { remoteSandboxMarker, unconfinedDetailMarker, unconfinedMarker, unmatchedDialectMarker } from './render.js';
/**
 * Sandbox facts worth a job's terminal detail: a run whose file effects happened
 * on another host, a runner that never ran the command, a denial (with the
 * escalation hint this composition offers), or a run that was meant to be confined
 * but was not.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @param options.unconfinedIsAutomatic - whether THIS TOOL degraded to an
 *   unconfined run itself (`sandbox: auto` with a failed probe) rather than
 *   being told to run unconfined (`sandbox: none`). Exactly the foreground rule:
 *   only the tool's own degradation is announced; an explicit `none` keeps the
 *   fact and stays quiet, and a wrapped run never carries either (default `false`).
 * @param options.unconfinedDetail - whether this is the row's FIRST automatic
 *   degradation (default `false`): then the full explanation rides along, and
 *   every later one carries the short marker unless `unconfinedSilent` says the
 *   row's `sandboxNotice` is `once` — the same rule the foreground uses.
 * @param options.unconfinedSilent - whether the announcement is suppressed
 *   entirely (default `false`); the settled fact still rides on the process.
 * @returns the markers to append, oldest first.
 */
function sandboxNotes(sandbox, escalationModes, options = {}) {
    // A REMOTE run first, and regardless of success: its sandbox block carries no
    // local verdict to report (see `remoteRun`), so every later branch here would be
    // a claim about a sandbox that never ran on this host. The unmatched-denial
    // branch is the one that used to catch it — a failing `ssh.exe` (its own exit
    // 255, from a connection error) satisfies that branch exactly, so the terminal
    // detail of a failed remote call read "this backend's denial dialect did not
    // match" for a host that never answered. This is the sentence the foreground
    // renders, taken from the same source, and it states the shape of the block
    // rather than warning about a failure, so a successful remote job carries it too.
    if (sandbox?.remote === true) {
        return [remoteSandboxMarker(sandbox.mode)];
    }
    if (sandbox?.runnerFailed) {
        return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`];
    }
    if (sandbox?.denied) {
        const notes = [sandboxDenialMarker(sandbox.mode)];
        if (escalationModes.length > 0)
            notes.push(escalationHintMarker('command'));
        return notes;
    }
    // Not wrapped: say so, or a background command the sandbox never covered
    // reads exactly like a confined one. Cannot coincide with a denial (an
    // unconfined run has nothing to deny).
    if (sandbox?.unconfined === true && options.unconfinedIsAutomatic === true) {
        if (options.unconfinedSilent === true) return [];
        return [options.unconfinedDetail === true
                ? unconfinedDetailMarker(sandbox.mode)
                : unconfinedMarker(sandbox.mode)];
    }
    // A confined run that FAILED with no matching denial signature (so the fact
    // carries no `denied` at all): name the unknown dialect rather than let the
    // terminal detail read as a plain command failure.
    if (sandbox !== undefined
        && sandbox.denied === undefined
        && sandbox.runnerFailed === undefined
        && sandbox.unconfined === undefined
        && options.failed === true) {
        return [unmatchedDialectMarker()];
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
 * @param options.unconfinedIsAutomatic - as {@link sandboxNotes}: announce an
 *   unconfined sandbox only when this tool degraded to it itself.
 * @param options.unconfinedDetail - as {@link sandboxNotes}: the row's first
 *   automatic degradation carries the full explanation, later ones the short mark.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc, escalationModes = [], options = {}) {
    // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
    // infrastructure-failure outcome, then map it to task `failed`. Restricted
    // runner failures expose sandbox.runnerFailed, but unconfined spawn failures
    // still alias a signal-less kill; real nonzero command exits must remain
    // `completed`.
    const base = proc.status === 'killed'
        ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
        : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` };
    const notes = sandboxNotes(proc.sandbox, escalationModes, {
        ...options,
        failed: proc.status === 'killed' || (proc.exitCode ?? 0) !== 0,
    });
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