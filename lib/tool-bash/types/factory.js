/**
 * Model-facing Consumer of the `ctx.shell` capability seam. Background calls
 * register process handles with `ctx.jobs`; their work uses job cancellation
 * rather than the tool-call signal after an id is returned.
 *
 * TODO(permissions): deployment policy belongs in `tools/pre-execute` and
 * sandboxing executors; see docs/architecture.md § Where new behavior goes.
 * @module @deepseek-ai/dsh-tool-bash/factory
 */
import z from '@deepseek-ai/schemastery';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ESCALATION_TARGETS, approveEscalation, canonicalPath, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import { ownExecutor } from "./backend.js";
import { processJob, processOutcome, processSources, ringDelta } from "./background.js";
import { parseExitStatus, renderJobRead, renderPromoted, renderResult } from "./render.js";
import { SHELL_FAMILY_ROW_SPECIFIER, composeToolDescription, familyRowComposed } from "./shell-family.js";
import { DIALECT_FACTS, dialectById, validateShellDialects } from "./registry.js";
/** The tool-layer keys every shell tool instance carries, before its backend partition. */
const TOOL_CONFIG = {
    enableRunInBackground: z.boolean().default(true).volatile(),
    /**
     * Self-heal the sandbox's private temp directory when it was removed out of
     * band (default on). The windows-acl rung caches one `%TEMP%\dsh-<6>` per
     * (session, workspaceRoot) for the provider's whole lifetime and its runner
     * refuses a missing `--temp` (exit 127), so losing that directory bricks
     * every later wrapped spawn of the session; see
     * `lib/sandbox-temp-guard.js` for the mechanism and its boundaries.
     *
     * Volatile on purpose: it is a live behaviour switch, not a deployment
     * stance, so turning it off stops healing from the next command — no reload.
     * It sits on the tool layer (not in a backend partition) for one structural
     * reason: the only legitimate source of the path is the confined argv, which
     * the executor — not the tool — holds, so the switch has to be readable from
     * the same config the executor's row is built with. Read by
     * `ShellExecutorBase.attachToolLayer`, which the factory below calls.
     */

    /**
     * Keep a foreground command that reaches its timeout running as a
     * background job instead of killing it (default true, matching dsh's own
     * bash tool). Applies only while background execution is available: with
     * `enableRunInBackground: false` or no job registry composed, the
     * executor's deadline kills the command exactly as before.
     *
     * Deliberately **not** volatile — it is a deployment behaviour switch, not
     * a knob the Plugins page edits (dsh declares it plain as well), so the
     * settings projection and the audit's `volatilePaths` stay unchanged.
     */
    promoteOnTimeout: z.boolean().default(true),
};
/**
 * The model-facing description of one shell tool instance: only what this
 * dialect owns — its shell and invocation, its path form, its variable syntax,
 * and at most one short dialect note. Everything the family shares (fresh
 * calls, exit markers, sandbox markers, truncation, path safety, background,
 * escalation) is registered once for the composition by the package row (see
 * ./shell-family.js), so no tool description repeats it.
 * @param dialect - the shell dialect the instance runs.
 * @returns the tool description passed to `defineTool`.
 */
export function shellDescription(dialect) {
    const facts = DIALECT_FACTS[dialect];
    if (facts === undefined)
        throw new Error(`unknown shell dialect "${dialect}"`);
    const note = facts.note === undefined ? '' : ` Note: ${facts.note}.`;
    return `Execute a ${facts.shell} command (${facts.invoke}) and return its stdout/stderr. `
        + `Paths use ${facts.paths}; read environment variables with ${facts.env}.`
        + note;
}
/**
 * Argument validation for one shell call. Exported (like {@link toNativeWorkdir}
 * and {@link resolveSessionWorkdir}) so the behaviour can be pinned directly:
 * it is the one place the plugin's escalation contract differs from the shared
 * `validateEscalationArgs` in the two ways dsh's own shell tools allow.
 * @param args - the parsed call arguments.
 * @param effectiveMode - the mode this call would run under, when a confining executor is mounted.
 */
export function validateShellArgs(args, effectiveMode) {
    if (args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string');
    }
    if (args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string');
    }
    if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
    }
    // Naming the mode already in force is not a widening, and dsh's own shell
    // tools accept it with no justification; the shared `validateEscalationArgs`
    // below would reject the pair (it requires a reason for any named mode).
    if (args.sandbox_permissions !== undefined && args.sandbox_permissions === effectiveMode)
        return;
    // An empty-string reason beside an absent escalation is a harmless model
    // artifact: normalize it away instead of rejecting the call for it.
    const justification = args.sandbox_permissions === undefined && args.justification?.trim() === ''
        ? undefined
        : args.justification;
    // The escalation pairing (sandbox_permissions ⇔ justification, non-empty) is
    // the shared rule both enforcing families validate identically.
    validateEscalationArgs(args.sandbox_permissions, justification);
}
function presentShellCall(args) {
    if (args.run_in_background === true) {
        return {
            card: 'generic',
            title: args.command,
            kind: 'execute',
            rawInput: args.command,
            content: [{ type: 'text', text: args.description }],
        };
    }
    return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...args.workdir !== undefined ? { cwd: args.workdir } : {},
    };
}
/**
 * Present completed foreground output as a terminal; background acknowledgements,
 * promotions, and execution errors use generic fenced output without an exit-status pill.
 */
function presentShellResult(args, result) {
    const block = result.content.length === 1 ? result.content[0] : undefined;
    if (block === undefined || block.type !== 'text')
        return undefined;
    const raw = block.text;
    const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true;
    const isPromoted = result.value?.kind === 'promoted';
    // Background acknowledgements, promotions, and errors have no terminal exit status.
    if (isBackground || isPromoted || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] };
    }
    // The exit marker becomes the card's exit pill, so it leaves the output body.
    const { body, ...exit } = parseExitStatus(raw);
    return { card: 'terminal', output: body, ...exit };
}
/**
 * Translate the bash-dialect drive forms a model may hand in as `workdir` into
 * the native path the process spawn needs. `node:path` calls `/d/WorkSpace` and
 * the WSL automount view `/mnt/d/WorkSpace` absolute, but Windows resolves them
 * against the current drive (`G:\g\LAB\...`), so the spawn fails and reports
 * ENOENT against the shell executable — `bash.exe` / `wsl.exe` — which reads as
 * a missing shell rather than an unusable directory. Only a single-letter first
 * segment (optionally under `/mnt/`) whose drive exists qualifies, so MSYS POSIX
 * roots (`/etc`, `/usr`, `/tmp`, `/dev`, …) and distro-side paths (`/mnt/data`)
 * are never drive-mapped.
 * @param workdir - an absolute model-supplied workdir.
 * @returns its native Windows form, or the input when it is not a drive form.
 */
export function toNativeWorkdir(workdir) {
    if (process.platform !== 'win32')
        return workdir;
    const match = /^(?:\/mnt)?\/([A-Za-z])(?:\/(.*))?$/.exec(workdir);
    if (match === null)
        return workdir;
    const drive = match[1].toUpperCase();
    if (!existsSync(`${drive}:\\`))
        return workdir;
    const rest = match[2];
    return rest === undefined ? `${drive}:\\` : `${drive}:\\${rest.replace(/\//g, '\\')}`;
}
/**
 * The session's *current* directory, read from the mutable service when the
 * runtime has one. dsh ≥ 0.2.1-alpha.2 keeps the session header's `cwd` as the
 * immutable original project and moves the effective directory in
 * `ctx.workingDirectory` (`working_directory(cd: …)` commits a
 * `working-directory/change`); dsh's own bash/pwsh tools resolve every call
 * through `workingDirectory.ensure(...)`, so a shell that read the header
 * instead would silently run in the directory the model left behind.
 *
 * The service is probed, never injected: it does not exist on 0.2.0-rc.2 /
 * alpha.1, and naming it in `inject` would leave both tool rows permanently
 * pending there. A runtime without the service — and a context that mounts no
 * such service — keeps the previous header/policy reading exactly.
 * @param ctx - the tool row's context.
 * @param exec - the execution being routed.
 * @returns the effective directory, or `undefined` when the runtime cannot answer.
 */
async function effectiveSessionDirectory(ctx, exec) {
    if (exec.agent === undefined)
        return undefined;
    const service = ctx.get?.('workingDirectory');
    if (service === undefined || typeof service.ensure !== 'function')
        return undefined;
    // `ensure` also repairs a session whose directory disappeared (dsh restores
    // the original project and notifies); letting it throw is the same contract
    // dsh's own tools rely on.
    return await service.ensure(exec.agent, exec.signal);
}
/**
 * The default working directory of a call that names no `workdir`: the
 * session's current directory when the runtime exposes one, otherwise the
 * resolved sandbox-policy root (so workdir and confinement still share one
 * per-call identity where that is all the runtime offers), and finally the
 * immutable session header. With the mutable directory in play the policy root
 * stays what it is — the confinement boundary — exactly as in dsh's own shell
 * tools; the command's cwd is the session's.
 * @param ctx - the tool row's context.
 * @param exec - the execution being routed.
 * @param policyWorkspaceRoot - the resolved policy root, when a confining executor is mounted.
 * @returns the directory to hand the executor, or `undefined` to let it default.
 */
export async function resolveSessionWorkdir(ctx, exec, policyWorkspaceRoot) {
    const effective = await effectiveSessionDirectory(ctx, exec);
    if (effective !== undefined)
        return canonicalPath(effective);
    const headerCwd = exec.agent?.session.header.cwd;
    return policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd));
}
/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the resolved session directory and leave executor defaulting as
 * the fallback. An absolute dialect-form workdir is translated to its native
 * form (see {@link toNativeWorkdir}) because the executor hands the value
 * straight to `spawn` as the child's `cwd`.
 * @param modelWorkdir - the model-supplied `workdir`, if any.
 * @param sessionCwd - the resolved default from {@link resolveSessionWorkdir}.
 * @returns the workdir to hand the executor, or `undefined` to let it default.
 */
function resolveWorkdir(modelWorkdir, sessionCwd) {
    if (modelWorkdir === undefined)
        return sessionCwd;
    if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
        return resolvePath(sessionCwd, modelWorkdir);
    }
    return toNativeWorkdir(modelWorkdir);
}
/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalShellResult(result, cwd, stopped) {
    const output = (stream) => ({
        text: stream.text,
        truncated: stream.truncated,
        ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
    });
    return {
        // The directory the command actually ran in, resolved from the same spec
        // the executor received. The client card reads it through
        // `presentationMeta`; like dsh's own shell results it is not optional.
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        // A kill from outside this call (the human's `job_kill`, a parallel
        // stop) is not a command failure: the reason tells the model not to
        // retry. Only the job-backed foreground path can know it.
        ...stopped !== undefined ? { stopped } : {},
        timeoutMs: result.timeoutMs,
        stdout: output(result.stdout),
        stderr: output(result.stderr),
        ...result.sandbox !== undefined ? {
            sandbox: {
                mode: result.sandbox.mode,
                // Optional on purpose: a confined failure whose stderr matched no
                // known denial signature has no `denied` at all (see `denialFacts`
                // in vendor/helpers.js), and inventing `false` there would state a
                // fact the executor cannot support.
                ...result.sandbox.denied !== undefined ? { denied: result.sandbox.denied } : {},
                ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
                ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
                // Present only for a run that was NOT wrapped: it is the difference
                // between "this composition composes no sandbox" (field absent) and
                // "a sandbox was requested but this command ran without one".
                ...result.sandbox.unconfined !== undefined ? { unconfined: result.sandbox.unconfined } : {},
                // Present only for a dialect whose effects are NOT on this host:
                // the local sandbox does not govern the command, so no `denied`,
                // `enforcement` or `unconfined` accompanies it.
                ...result.sandbox.remote !== undefined ? { remote: result.sandbox.remote } : {},
            },
        } : {},
    };
}
/** Canonical background-handle properties shared by the shell output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
    kind: { type: 'string', required: true, const: 'background' },
    jobId: { type: 'string', required: true },
    cwd: { type: 'string', required: true },
};
/**
 * Build a model-facing shell tool plugin. The instance name doubles as the
 * tool name, the approval subject, the prompt section name (`tool:<toolName>`),
 * and the `ctx.jobs` kind; the instance module declares its kind in
 * {@link JobKindMap} via declaration merging.
 *
 * The tool owns its executor outright (see `./backend.js`): dsh 0.1.7 dropped
 * the shell seam's routing field, so a tool can no longer ask a shared seat
 * for a-backend-by-name. `def.Executor` is constructed once per tool load and
 * driven directly, leaving `ctx.shell` to the base bundle's own executor.
 * @param def - the instance definition: `dialectId` (the shell dialect this
 *   instance runs, looked up in the registry) and `Executor` (the backend class
 *   to own). The tool name, the Config partition and the model-facing facts all
 *   come from the declaration — a tool module states its dialect and nothing
 *   else, so there is no second place to keep them in sync.
 * @returns the complete plugin object (name/inject/Config/apply).
 */
export function defineShellTool(def) {
    // Startup gate, once per row: a registry that cannot describe itself (a
    // duplicate id, a dialect with no facts, a tool name that collides with the
    // shared section's name, a knob pointing at another partition) refuses to
    // load here rather than registering a tool no settings page can configure.
    validateShellDialects();
    const dialect = dialectById(def.dialectId);
    if (dialect === undefined)
        throw new Error(`unknown shell dialect id "${def.dialectId}"`);
    const declaration = {
        toolName: dialect.toolName,
        configKey: dialect.configKey,
        dialect: dialect.id,
    };
    // The executor's own schema is *copied* into this row's partition rather
    // than `.default({})`-ed on the class: that call writes `meta.default` in
    // place on the shared static, so a second tool row (or any other consumer
    // of the same executor class) would inherit a default it never declared.
    // Spreading `.dict` is the same expansion the executors' own `deriveConfig`
    // uses, and it preserves every field schema and its volatile metadata.
    const BackendConfig = z.object({ ...def.Executor.Config.dict }).default({});
    const Config = z.object({
        ...TOOL_CONFIG,
        [declaration.configKey]: BackendConfig,
    });
    return {
        name: `tool-${declaration.toolName}`,
        // The tool registers no prompt section of its own: the family's shared
        // guidance is owned by the package row (see ./shell-family.js), so this
        // row needs no `systemPrompt`.
        // The last three are the owned executor's own requirements; injecting
        // them here is what lets the backend be built during apply.
        inject: ['tools', 'shellEnv', 'subprocess', 'sandbox', 'sandboxPolicy'],
        Config,
        async apply(ctx, config = {}) {
            // Volatile: the loader hands a live reference, so a saved value is
            // read here rather than off a snapshot.
            const backgroundEnabled = config.enableRunInBackground?.get() ?? true;
            // The advertised parameter follows the CONFIG alone — never a
            // service-availability snapshot taken at apply time. dsh's own tool
            // reads the registry per call and re-registers when it comes or
            // goes; this factory does not re-register, so latching a registry
            // read here would make the schema depend on boot timing. Measured
            // 2026-10-13: with the latch a single commit passed 3/3 on an idle
            // host and lost `run_in_background` entirely (audit red) in six
            // consecutive runs elsewhere, with nothing in the output saying so.
            // Availability is enforced where it is actually known: the call
            // path reads `ctx.get('jobs')` and fails loudly when it is absent.
            const background = backgroundEnabled;
            // Keeping a timed-out command needs the whole background surface:
            // the registry at execution time and the switch that lets the model
            // collect/stop jobs. With either one absent this is the previous
            // deadline-kill tool, exactly as dsh composes it
            // (`(config.promoteOnTimeout ?? true) && backgroundEnabled`).
            const promote = (config.promoteOnTimeout ?? true) && background;
            // The sandbox stance is what separates the two ways a run can come back
            // unconfined: `auto` means WE degraded it (the probe failed), `none`
            // means the deployment asked for no sandbox. Only the former is worth a
            // sentence in the result — the latter is expected configuration and must
            // not nag on every call. The executors report the fact either way
            // (`sandbox.unconfined`); this decides whether the model hears it.
            const unconfinedIsAutomatic = config[declaration.configKey]?.sandbox?.get() === 'auto';
            /**
             * ROW-scoped latch for the unconfined announcement: the first automatic
             * degradation of this tool row carries the full explanation (what failed,
             * and both ways out), every later one carries only the short marker, so a
             * deployment whose probe fails does not repeat 200 characters per call.
             *
             * Who takes it: whichever channel first DELIVERS an announcement to the
             * model — a foreground result, a promoted call's seeded read, or a real
             * background job's terminal detail. A foreground call is registered as a
             * job too, but its outcome is discarded when the call settles while it
             * waits (the tool removes the record), so that provisional outcome emits
             * only the short marker and never takes the latch; otherwise the discarded
             * text would eat the explanation the model is about to be shown.
             *
             * Boundaries, stated as they are rather than as one would like them:
             * - Only a result that really was unconfined takes it: a wrapped run,
             *   `sandbox: none` and `danger-full-access` never do, so the first
             *   *degraded* call still gets the full text even if other calls ran first.
             * - `dsh` renders a tool result once, so per-result consumption is exact;
             *   two runs that settle in the same tick still cannot both take it (the
             *   check-and-take is synchronous), but which one is "first" is
             *   first-to-report, not first-to-start.
             * - The latch lives in this `apply` scope, so re-applying the row (config
             *   reload, plugin HMR, another profile composing the same row) resets it
             *   and the explanation appears once more. Each tool row has its own latch,
             *   so git_bash and wsl_bash each explain themselves once.
             * - It is deliberately not strictly once-only across processes: making it
             *   so would need state this layer does not own, and pretending otherwise
             *   would just be a comment that lies.
             */
            let unconfinedDetailPending = true;
            /**
             * How often an automatically degraded run announces itself, from the
             * row's own partition (`once` unless configured otherwise):
             *
             * - `once` spends the row's single explanation on its first such run
             *   and stays silent afterwards. Repeating the same sentence on every
             *   call only pushes real output out of the context window, and the
             *   structured `sandbox.unconfined` fact still rides on every result.
             * - `always` keeps the short per-run marker after that first one.
             *
             * An explicit `sandbox: none` and `danger-full-access` stay quiet
             * under both levels (see `unconfinedIsAutomatic`).
             */
            const sandboxNoticeLevel = config[declaration.configKey]?.sandboxNotice?.get() ?? 'once';
            /**
             * Whether the `jobs` registry serving this row takes `JobSpec.toolCall`.
             * Probed once per ROW, not per job: a runtime that rejects the field would
             * otherwise reject it again on every background call. Nothing measured
             * needs this (alpha.2 and rc.2 both accept and ignore it — see the note in
             * `startJob`), so the verdict only ever flips on a runtime that names the
             * field in its rejection.
             */
            let jobToolCallSupported = true;
            /** The conservative answer: announce nothing. */
            const QUIET_UNCONFINED = { unconfinedIsAutomatic: false };
            /** Is this settled sandbox fact a run WE degraded to unconfined? */
            const isAutomaticUnconfined = (sandbox) => unconfinedIsAutomatic && sandbox?.unconfined === true;
            /** The model-facing channels: take the latch, so the first one explains. */
            const unconfinedLatch = (sandbox) => {
                if (!isAutomaticUnconfined(sandbox)) return QUIET_UNCONFINED;
                const detail = unconfinedDetailPending;
                unconfinedDetailPending = false;
                return {
                    unconfinedIsAutomatic: true,
                    unconfinedDetail: detail,
                    unconfinedSilent: !detail && sandboxNoticeLevel === 'once'
                };
            };
            /** A provisional (waited-on) job outcome: announce, but never take the latch. */
            const unconfinedProvisional = (proc) => (isAutomaticUnconfined(proc?.sandbox)
                ? {
                    unconfinedIsAutomatic: true,
                    unconfinedDetail: false,
                    unconfinedSilent: sandboxNoticeLevel === 'once'
                }
                : QUIET_UNCONFINED);
            const familyPresent = familyRowComposed(ctx);
            if (!familyPresent) ctx.logger?.warn?.(`tool-${declaration.toolName}: the row that owns the shared shell prompt section (${SHELL_FAMILY_ROW_SPECIFIER}) is not composed, so this tool's description carries that guidance itself. Re-enable that row to state it once for the whole family.`);
            const { executor } = ownExecutor(ctx, def.Executor, config[declaration.configKey]);
            // Hand the tool-layer knobs over: the executor's confine path is where
            // the private-temp guard has to read its switch and the standing
            // workspace root, and neither is inside the backend partition above.
            executor.attachToolLayer?.(void 0, ctx);
            // The confinement probe is async on 0.1.7 (the provider's `confine`
            // returns a promise), so the escalation surface settles before the
            // tool registers: a tool never advertises a confinement it cannot
            // reach.
            //
            // A backend whose probe fails *loud* is deliberately swallowed here
            // — that is the documented lazy contract: an explicit
            // `sandbox: bwrap` without bubblewrap must not brick the tool row
            // at load. It advertises no confinement now and its error
            // resurfaces at the first routed command.
            let defaultMode;
            try {
                defaultMode = await executor.resolveSandboxMode();
            }
            catch {
                defaultMode = undefined;
            }
            const escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS;
            // No `sandboxPolicy === undefined` guard here: `inject` above names
            // the service, so cordis refuses to run this apply without it —
            // whenever `defaultMode` is defined (the only case that reads the
            // policy), the service is present by construction. dsh's own
            // tool-bash carries the same-looking throw and *is* reachable,
            // because that row does not inject `sandboxPolicy`. A deployment
            // that mounted a confining executor with no policy service never
            // gets here at all: the row stays pending on the missing service,
            // which is the diagnostic. That is why the throw that used to sit
            // here is gone rather than kept as unfalsifiable-looking code.
            const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy');
            /** Resolve the complete standing policy for this call when a confining executor is mounted. */
            const resolveSandboxPolicy = (exec) => sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
            /**
             * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
             * anything executes, delegating the shared fail-closed sequence (strict
             * widening, channel resolution, outcome mapping) to
             * {@link approveEscalation}. This tool contributes only the composition
             * guard (the fields are unadvertised without a sandboxing executor, yet
             * schema validation checks advertised keys only, so an unadvertised
             * `sandbox_permissions` still reaches execute) and the approval
             * ingredients. The shared policy resolver is required whenever the executor
             * advertises confinement, so a split composition fails at tool-plugin load.
             */
            const approveShellEscalation = (mode, justification, exec, standingPolicy) => {
                if (escalationModes.length === 0) {
                    throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)');
                }
                const effectiveMode = standingPolicy.mode;
                return approveEscalation({ requestedMode: mode, justification, effectiveMode, subject: 'command' }, {
                    approver: ctx.get('approval'),
                    agent: exec.agent,
                    callId: exec.callId,
                    toolName: declaration.toolName,
                    signal: exec.signal,
                });
            };
            /**
             * Register one command with the job registry. The process spawns
             * inside the starter, after the registry admitted the job, so the
             * pull sources bind lazily through the `proc` closure; a refused
             * registration throws before anything runs.
             * @param jobs - the registry to register with.
             * @param exec - the execution being routed (its agent owns the job).
             * @param spec - the resolved exec spec the starter runs.
             * @param label - the job's one-line label (the command).
             * @returns the job id, a reader for the spawned process, and the outside kill's reason.
             */
            const startJob = (jobs, exec, spec, label, outcomeTakesLatch) => {
                let proc;
                let stopped;
                const jobSpec = {
                    kind: declaration.toolName,
                    label,
                    ...exec.agent ? { owner: exec.agent.id } : {},
                    output: processSources(() => proc),
                    run: () => {
                        const hooks = processJob(async (signal) => {
                            proc = await executor.execute({ ...spec, signal });
                            return proc;
                        }, (started) => processOutcome(started, escalationModes, outcomeTakesLatch
                            ? unconfinedLatch(started.sandbox)
                            : unconfinedProvisional(started)));
                        return {
                            done: hooks.done,
                            // A kill from outside this call (the human's, a
                            // parallel job_kill) reaches the process here; its
                            // reason is what the model reads back.
                            cancel: (reason) => {
                                stopped = reason;
                                hooks.cancel(reason);
                            },
                        };
                    },
                };
                /**
                 * The tool-call identity 0.2.1-alpha.3 records with a job.
                 *
                 * `JobSpec.toolCall?` is new in alpha.3: it is what puts "which tool
                 * call created this job" into the durable `job/registered` /
                 * `job/settled` payloads and into the public job view. The shape is
                 * the official tools' (`tool-pwsh/src/index.ts:289`,
                 * `tool-bash/src/index.ts:272`):
                 * `{ callId: exec.callId, rootCallId: exec.rootCallId }`.
                 *
                 * Two facts this is built around, both MEASURED rather than assumed
                 * (`.temp/quality/jobstoolcall-m1.md`):
                 * - `exec.callId` and `exec.rootCallId` are read by `dsh-tools` in
                 *   rc.2, alpha.2 and alpha.3 alike, but each key is only included when
                 *   it really holds a value: an absent one must not become an
                 *   `undefined` key on a runtime that predates the field.
                 * - A runtime that does not know the field ACCEPTS and ignores it —
                 *   alpha.2 and rc.2 share the same `jobs.start`, which validates only
                 *   `kind`/`label`/`outputLimitBytes`/`owner` and stores only its own
                 *   fields — so no generation needs the fallback below. It is kept for
                 *   a future runtime that validates its spec strictly: a rejection that
                 *   NAMES the field marks this row unsupported (settled once, the same
                 *   shape the bwrap verdict and the dialect discovery use) and the job
                 *   is registered without it. Every other failure — a full owner, no
                 *   controller — is re-thrown untouched, so nothing else changes.
                 *
                 * The retry assumes a field rejection happens while the spec is being
                 * validated, before anything is registered; that holds for both
                 * implementations read above. A runtime that registered a job and then
                 * rejected the field would run it twice, which is why the retry is
                 * limited to errors that name the field at all.
                 */
                let toolCallSupported = jobToolCallSupported;
                const start = (job) => {
                    if (!toolCallSupported) return jobs.start(job);
                    const toolCall = {
                        ...exec.callId !== void 0 ? { callId: exec.callId } : {},
                        ...exec.rootCallId !== void 0 ? { rootCallId: exec.rootCallId } : {},
                    };
                    if (Object.keys(toolCall).length === 0) return jobs.start(job);
                    try {
                        return jobs.start({ ...job, toolCall });
                    } catch (error) {
                        if (!/toolCall/i.test(String(error?.message ?? ''))) throw error;
                        toolCallSupported = false;
                        jobToolCallSupported = false;
                        return jobs.start(job);
                    }
                };
                // `jobs.start` returns the id itself (rc.2/alpha.2/alpha.3 all end in
                // `return id`), which is also how the official tools consume it.
                const id = start(jobSpec);
                return { id, process: () => proc, stopped: () => stopped };
            };
            /**
             * Wait on a registered foreground command until it settles or the
             * deadline passes. A wait that expires hands the still-running job
             * to the model instead of killing it, and the one consuming read
             * taken here is what `job_output` continues from.
             */
            const waitOnJob = async (jobs, attached, exec, spec) => {
                const owner = exec.agent?.id;
                const timeoutMs = spec.timeoutMs;
                /**
                 * Stop the job on this call's own account and stay on it until it
                 * settles, so the settlement is `awaited` and no completion notice
                 * follows a result this call already carries; the record then
                 * leaves with the call, as the model never saw the id.
                 */
                const stop = async (reason) => {
                    jobs.kill(attached.id, owner, reason);
                    const settled = await jobs.wait(attached.id, timeoutMs, owner);
                    if (settled.status !== 'running' && settled.status !== 'stopping')
                        jobs.remove(attached.id, owner);
                    return settled;
                };
                let view;
                try {
                    view = await jobs.wait(attached.id, timeoutMs, owner, exec.signal);
                }
                catch {
                    // A wait on the caller's own live job rejects only for the
                    // caller's abort: the model's call is over, so the command
                    // goes with it, as under the deadline kill.
                    await stop('tool call aborted');
                    const error = new HarnessError('tool call aborted', TOOL_ABORTED);
                    error.name = 'AbortError';
                    throw error;
                }
                if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
                    // The wait expired while preparation still ran: nothing is
                    // running to keep, so this is the deadline's preparation
                    // timeout, with the settled empty result the executor's own
                    // deadline would have given.
                    await stop('timed out during preparation');
                    return {
                        kind: 'foreground',
                        cwd: spec.workdir,
                        exitCode: null,
                        signal: null,
                        timedOut: true,
                        aborted: false,
                        timeoutMs,
                        stdout: { text: '', truncated: false },
                        stderr: { text: '', truncated: false },
                        // Nothing ran, so the only honest fact is the policy's own mode — and for a
                        // REMOTE dialect even `denied: false` would be a local verdict about a command
                        // that never started here.
                        ...spec.sandboxPolicy !== undefined
                            ? { sandbox: declaration.effects === 'remote' ? { mode: spec.sandboxPolicy.mode, remote: true } : { mode: spec.sandboxPolicy.mode, denied: false } }
                            : {},
                    };
                }
                if (view.status === 'running' || view.status === 'stopping') {
                    // The wait timed out and the job keeps running: one consuming
                    // read seeds the result with the output so far. The read's own
                    // loss/denial notices must travel with it — this read advances
                    // the model's cursor, so anything it drops is unreportable later.
                    const read = jobs.read(attached.id, owner);
                    // No `sandbox` field, deliberately: the base bundle's own `pwsh`/`bash`
                    // tools shape this branch as `{ kind, jobId, timeoutMs, output }` too, and
                    // carry the fact that does exist — the job's sandbox facts, when they are
                    // already stamped — inside the returned TEXT (`renderJobRead` below). An
                    // extra field here would also have to be added to `output.schema`, and a
                    // value key the schema does not declare makes the runtime drop it whole.
                    return {
                        kind: 'promoted',
                        cwd: spec.workdir,
                        jobId: attached.id,
                        timeoutMs,
                        output: renderJobRead(ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], attached.process()?.sandbox, escalationModes, unconfinedLatch(attached.process()?.sandbox)),
                    };
                }
                // Settled while the call waited: the model never saw the id, so
                // the record leaves the registry with this result.
                jobs.remove(attached.id, owner);
                const process = attached.process();
                // No process was published: the starter failed before the spawn,
                // and the job's terminal detail is the failure the foreground
                // projection would have rejected with.
                if (process === undefined)
                    throw new Error(view.detail);
                const result = await process.result();
                return { kind: 'foreground', ...canonicalShellResult(result, spec.workdir, attached.stopped()) };
            };
            ctx.tools.register(defineTool({
                name: declaration.toolName,
                description: composeToolDescription({
                    own: shellDescription(declaration.dialect),
                    familyPresent,
                    background,
                    escalation: escalationModes.length > 0,
                    // Read from the ONE place that declares where a dialect's file
                    // effects happen, so the fallback prose cannot claim a local sandbox
                    // over a command that runs elsewhere.
                    localSandbox: dialect.effects !== 'remote',
                    remote: dialect.effects === 'remote',
                }),
                parameters: {
                    // `description` first, `command` second — the order dsh's own
                    // bash/pwsh tools declare (and the order their descriptions
                    // tell the model to emit); the shared ordering sentence
                    // lives in the family section, not in each tool.
                    description: {
                        type: 'string',
                        required: true,
                        description: 'Clear, concise description of what this command does in active voice, '
                            + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
                            + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
                    },
                    command: { type: 'string', required: true, description: 'The bash command to execute.' },
                    timeoutMs: {
                        type: 'number',
                        description: promote
                            ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
                            : 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
                    },
                    workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it. Native (`C:\\...`), MSYS drive (`/c/...`) and WSL automount (`/mnt/c/...`) forms are all accepted.' },
                    ...background ? {
                        run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
                    } : {},
                    ...escalationModes.length > 0 ? {
                        sandbox_permissions: {
                            type: 'string',
                            enum: [...escalationModes],
                            description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
                        },
                        justification: {
                            type: 'string',
                            description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
                        },
                    } : {},
                },
                output: {
                    schema: {
                        oneOf: [
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: BACKGROUND_OUTPUT_PROPERTIES,
                            },
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    kind: { type: 'string', required: true, const: 'promoted' },
                                    cwd: { type: 'string', required: true },
                                    jobId: { type: 'string', required: true },
                                    timeoutMs: { type: 'number', required: true },
                                    output: { type: 'string', required: true },
                                },
                            },
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    kind: { type: 'string', required: true, const: 'foreground' },
                                    cwd: { type: 'string', required: true },
                                    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                                    signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                                    timedOut: { type: 'boolean', required: true },
                                    aborted: { type: 'boolean', required: true },
                                    stopped: { type: 'string' },
                                    timeoutMs: { type: 'number', required: true },
                                    stdout: {
                                        type: 'object',
                                        additionalProperties: false,
                                        required: true,
                                        properties: {
                                            text: { type: 'string', required: true },
                                            truncated: { type: 'boolean', required: true },
                                            spillPath: { type: 'string' },
                                        },
                                    },
                                    stderr: {
                                        type: 'object',
                                        additionalProperties: false,
                                        required: true,
                                        properties: {
                                            text: { type: 'string', required: true },
                                            truncated: { type: 'boolean', required: true },
                                            spillPath: { type: 'string' },
                                        },
                                    },
                                    sandbox: {
                                        type: 'object',
                                        additionalProperties: false,
                                        properties: {
                                            mode: { type: 'string', required: true },
                                            // Optional: a confined failure that matched no
                                            // known denial signature omits it (the renderer
                                            // says so in words instead of asserting false).
                                            denied: { type: 'boolean' },
                                            enforcement: { type: 'string' },
                                            runnerFailed: { type: 'boolean' },
                                            // Optional, and `additionalProperties: false` means
                                            // an undeclared field would be STRIPPED before the
                                            // value reaches the renderer — the schema is what
                                            // lets the fact travel.
                                            unconfined: { type: 'boolean' },
                                            // The fact a REMOTE dialect reports instead of a
                                            // verdict: the local file sandbox does not apply.
                                            remote: { type: 'boolean' },
                                        },
                                    },
                                },
                            },
                        ],
                    },
                    render: (_args, value) => [{
                            type: 'text',
                            text: value.kind === 'background'
                                ? `started background job ${value.jobId}`
                                : value.kind === 'promoted'
                                    ? renderPromoted(value)
                                    : renderResult(value, escalationModes, unconfinedLatch(value.sandbox)),
                        }],
                    // The card shows the directory the command actually ran in,
                    // resolved per call (session cwd, policy root, or the model's
                    // `workdir`) rather than the client's session fallback.
                    presentationMeta: (_args, value) => ({ cwd: value.cwd }),
                },
                async execute(args, exec) {
                    // Description is display metadata; workdir defaults to the caller's session.
                    const standingPolicy = resolveSandboxPolicy(exec);
                    // Validation needs the effective mode: naming it is not a widening.
                    validateShellArgs(args, standingPolicy?.mode);
                    const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
                        ? await approveShellEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
                        : undefined;
                    const policy = approvedMode === undefined
                        ? standingPolicy
                        : { ...standingPolicy, mode: approvedMode };
                    const sessionCwd = await resolveSessionWorkdir(ctx, exec, standingPolicy?.workspaceRoot);
                    const workdir = resolveWorkdir(args.workdir, sessionCwd);
                    const dshEnv = ctx.shellEnv.collect(exec);
                    const request = {
                        command: args.command,
                        ...workdir !== undefined ? { workdir } : {},
                        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
                        dshEnv,
                        ...policy !== undefined ? { sandboxPolicy: policy } : {},
                    };
                    if (args.run_in_background === true) {
                        // Undeclared keys are allowed, so schema omission also needs enforcement.
                        if (!backgroundEnabled) {
                            throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)');
                        }
                        const jobs = ctx.get('jobs');
                        if (jobs === undefined) {
                            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
                        }
                        // The caller owns cancellation until ctx.jobs commits detached ownership.
                        if (exec.signal.aborted) {
                            const error = new HarnessError('tool call aborted', TOOL_ABORTED);
                            error.name = 'AbortError';
                            throw error;
                        }
                        // No deadline for a background command, and the process is
                        // spawned inside the starter, after the registry admitted it,
                        // so the pull sources bind lazily through the `proc` closure.
                        const spec = executor.resolve({ ...request, onExpiry: 'none' });
                        const id = startJob(jobs, exec, spec, args.command, true).id;
                        // Same shape as the base bundle's background handle
                        // (`kind`/`jobId`), plus the cwd this plugin reports: no
                        // `sandbox` field, because a job that has not run yet has no
                        // sandbox fact to state — the promotion and the job tools are
                        // where those facts are reported as they become known.
                        return { kind: 'background', jobId: id, cwd: spec.workdir };
                    }
                    // A foreground call is a job the tool waits on while a
                    // registry and promotion are both available: the command is
                    // visible and killable from the moment it starts, and a wait
                    // that expires hands the still-running job to the model.
                    // Admission refused at the start (the owner's job limit, no
                    // controller) runs the command under the deadline kill
                    // instead, exactly as a composition without a registry does.
                    const jobs = ctx.get('jobs');
                    if (jobs !== undefined && promote) {
                        const spec = executor.resolve({ ...request, onExpiry: 'none' });
                        let attached;
                        try {
                            attached = startJob(jobs, exec, spec, args.command, false);
                        }
                        catch (error) {
                            ctx.logger?.warn?.(`tool-${declaration.toolName}: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`);
                        }
                        if (attached !== undefined)
                            return await waitOnJob(jobs, attached, exec, spec);
                    }
                    // Foreground is a property of awaiting the handle's result, not
                    // of the call: the same `execute` also serves `run_in_background`.
                    const spec = executor.resolve({
                        ...request,
                        signal: exec.signal,
                    });
                    const result = await (await executor.execute(spec)).result();
                    if (result.aborted) {
                        const error = new HarnessError('tool call aborted', TOOL_ABORTED);
                        error.name = 'AbortError';
                        throw error;
                    }
                    return { kind: 'foreground', ...canonicalShellResult(result, spec.workdir) };
                },
                presentCall: presentShellCall,
                presentResult: presentShellResult,
            }));
        },
    };
}
//# sourceMappingURL=factory.js.map