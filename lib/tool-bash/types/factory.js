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
import { processJob, processOutcome, processSources } from "./background.js";
import { parseExitStatus, renderResult } from "./render.js";
/**
 * The dialect-owned facts of this plugin's two shell tools. Everything they
 * share lives in one registered prompt section instead (see
 * ./shell-family.js), so a fact stated here is stated only here.
 */
const DIALECT_FACTS = {
    msys: {
        shell: 'Git Bash (MSYS2)',
        invoke: 'bash -c',
        paths: 'MSYS form (`/d/WorkSpace` or `C:\\...`)',
        env: '$VAR',
        note: 'MSYS paths work inside Git Bash only — dsh\'s file tools (`read`, `write`, `edit`) on Windows take native `C:\\...` paths',
    },
    wsl: {
        shell: 'WSL Linux',
        invoke: 'bash -c',
        paths: 'Linux paths (`/mnt/c/...`)',
        env: '$VAR',
    },
};
/** The tool-layer keys every shell tool instance carries, before its backend partition. */
const TOOL_CONFIG = {
    enableRunInBackground: z.boolean().default(true).volatile(),
};
/**
 * The model-facing description of one shell tool instance: only what this
 * dialect owns — its shell and invocation, its path form, its variable syntax,
 * and at most one short dialect note. Everything the family shares (fresh
 * calls, exit markers, sandbox markers, truncation, path safety, background,
 * escalation) is registered once for the composition by the
 * `tool-shell-prompt` row, so no tool description repeats it.
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
function validateShellArgs(args) {
    if (args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string');
    }
    if (args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string');
    }
    if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
    }
    // The escalation pairing (sandbox_permissions ⇔ justification, non-empty) is
    // the shared rule both enforcing families validate identically.
    validateEscalationArgs(args.sandbox_permissions, args.justification);
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
 * Present completed foreground output as a terminal; background acknowledgements
 * and execution errors use generic fenced output without an exit-status pill.
 */
function presentShellResult(args, result) {
    const block = result.content.length === 1 ? result.content[0] : undefined;
    if (block === undefined || block.type !== 'text')
        return undefined;
    const raw = block.text;
    const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true;
    // Background acknowledgements and errors have no terminal exit status.
    if (isBackground || result.isError) {
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
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the filesystem identity of the session cwd and leave executor
 * defaulting as the fallback. A resolved sandbox-policy root wins so workdir
 * and confinement use the exact same per-call identity. An absolute dialect-form
 * workdir is translated to its native form (see {@link toNativeWorkdir}) because
 * the executor hands the value straight to `spawn` as the child's `cwd`.
 */
function resolveWorkdir(modelWorkdir, exec, policyWorkspaceRoot) {
    const headerCwd = exec.agent?.session.header.cwd;
    const sessionCwd = policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd));
    if (modelWorkdir === undefined)
        return sessionCwd;
    if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
        return resolvePath(sessionCwd, modelWorkdir);
    }
    return toNativeWorkdir(modelWorkdir);
}
/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalShellResult(result) {
    const output = (stream) => ({
        text: stream.text,
        truncated: stream.truncated,
        ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
    });
    return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        timeoutMs: result.timeoutMs,
        stdout: output(result.stdout),
        stderr: output(result.stderr),
        ...result.sandbox !== undefined ? {
            sandbox: {
                mode: result.sandbox.mode,
                denied: result.sandbox.denied,
                ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
                ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
            },
        } : {},
    };
}
/** Canonical background-handle properties shared by the shell output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
    kind: { type: 'string', required: true, const: 'background' },
    jobId: { type: 'string', required: true },
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
 * @param def - the instance definition: `toolName` (also the job kind),
 *   `dialect`, `Executor` (the backend class to own), and `configKey` (the
 *   Config partition that backend's settings live under).
 * @returns the complete plugin object (name/inject/Config/apply).
 */
export function defineShellTool(def) {
    const Config = z.object({
        ...TOOL_CONFIG,
        [def.configKey]: def.Executor.Config.default({}),
    });
    return {
        name: `tool-${def.toolName}`,
        // The tool registers no prompt section of its own: the family's shared
        // guidance is owned by the separate `tool-shell-prompt` row (see
        // ./shell-family.js), so this row needs no `systemPrompt`.
        // The last three are the owned executor's own requirements; injecting
        // them here is what lets the backend be built during apply.
        inject: ['tools', 'shellEnv', 'subprocess', 'sandbox', 'sandboxPolicy'],
        Config,
        async apply(ctx, config = {}) {
            // Volatile: the loader hands a live reference, so a saved value is
            // read here rather than off a snapshot.
            const backgroundEnabled = config.enableRunInBackground?.get() ?? true;
            const { executor } = ownExecutor(ctx, def.Executor, config[def.configKey]);
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
            const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy');
            if (defaultMode !== undefined && sandboxPolicy === undefined) {
                throw new Error(`tool-${def.toolName}: the mounted bash executor confines but ctx.sandboxPolicy is missing`);
            }
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
                    toolName: def.toolName,
                    signal: exec.signal,
                });
            };
            ctx.tools.register(defineTool({
                name: def.toolName,
                description: shellDescription(def.dialect),
                parameters: {
                    command: { type: 'string', required: true, description: 'The bash command to execute.' },
                    description: {
                        type: 'string',
                        required: true,
                        description: 'Clear, concise description of what this command does in active voice, '
                            + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
                            + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
                    },
                    timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
                    workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it. Native (`C:\\...`), MSYS drive (`/c/...`) and WSL automount (`/mnt/c/...`) forms are all accepted.' },
                    ...backgroundEnabled ? {
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
                                    kind: { type: 'string', required: true, const: 'foreground' },
                                    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                                    signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                                    timedOut: { type: 'boolean', required: true },
                                    aborted: { type: 'boolean', required: true },
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
                                            denied: { type: 'boolean', required: true },
                                            enforcement: { type: 'string' },
                                            runnerFailed: { type: 'boolean' },
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
                                : renderResult(value, escalationModes),
                        }],
                },
                async execute(args, exec) {
                    validateShellArgs(args);
                    // Description is display metadata; workdir defaults to the caller's session.
                    const standingPolicy = resolveSandboxPolicy(exec);
                    const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
                        ? await approveShellEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
                        : undefined;
                    const policy = approvedMode === undefined
                        ? standingPolicy
                        : { ...standingPolicy, mode: approvedMode };
                    const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot);
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
                        let proc;
                        // Task preflight finishes before the starter can spawn a process.
                        const id = jobs.start({
                            kind: def.toolName,
                            label: args.command,
                            ...exec.agent ? { owner: exec.agent.id } : {},
                            output: processSources(() => proc),
                            run: () => {
                                const hooks = processJob(async (signal) => {
                                    proc = await executor.execute({ ...spec, signal });
                                    return proc;
                                }, (started) => processOutcome(started));
                                return { done: hooks.done, cancel: (reason) => hooks.cancel(reason) };
                            },
                        });
                        return { kind: 'background', jobId: id };
                    }
                    // Foreground is a property of awaiting the handle's result, not
                    // of the call: the same `execute` also serves `run_in_background`.
                    const result = await (await executor.execute(executor.resolve({
                        ...request,
                        signal: exec.signal,
                    }))).result();
                    if (result.aborted) {
                        const error = new HarnessError('tool call aborted', TOOL_ABORTED);
                        error.name = 'AbortError';
                        throw error;
                    }
                    return { kind: 'foreground', ...canonicalShellResult(result) };
                },
                presentCall: presentShellCall,
                presentResult: presentShellResult,
            }));
        },
    };
}
//# sourceMappingURL=factory.js.map