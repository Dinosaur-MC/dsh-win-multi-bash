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
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ESCALATION_TARGETS, approveEscalation, canonicalPath, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell';
import { processOutcome } from "./background.js";
import { parseExitStatus, renderProcessRead, renderResult } from "./render.js";
const DIALECT_FACTS = {
    posix: { shell: 'bash', invoke: 'bash -c', paths: 'POSIX paths', env: '$VAR', toolchain: 'the full Unix toolchain' },
    msys: { shell: 'Git Bash (MSYS2)', invoke: 'bash -c', paths: 'MSYS paths such as /d/WorkSpace or native C:\\...', env: '$VAR', toolchain: 'the Git for Windows toolchain (git, Windows .exe tools, POSIX utilities)', conversion: 'MSYS auto-converts leading-slash arguments to Windows paths whenever a native Windows executable is called, so POSIX paths get mangled (e.g. `wsl.exe -e ls /root` fails on `D:/Program Files/Git/root`); prefix such calls with `MSYS_NO_PATHCONV=1` to pass arguments verbatim' },
    wsl: { shell: 'WSL Linux', invoke: 'bash -c', paths: 'Linux paths such as /mnt/c/... (Windows paths auto-converted by wsl.exe)', env: '$VAR', toolchain: 'the Linux userland (apt, gcc, python, ...)', conversion: 'the command rides as a base64 payload, so quoting and Linux paths reach the distro verbatim (no MSYS-style mangling)' },
};
/** Runtime configuration schema for a shell tool instance. */
export const Config = z.object({
    enableRunInBackground: z.boolean().default(true),
});
/**
 * The model-facing description of one shell tool instance. The POSIX variant
 * keeps the legacy wording byte-for-byte (the ACP/headless tool-schema
 * fixtures pin it); msys/wsl instances describe their dialect facts.
 * @param dialect - the shell dialect the instance runs.
 * @param backgroundEnabled - whether `run_in_background` is advertised.
 * @param escalationModes - the escalation targets this composition advertises;
 *   empty adds no same-turn escalation guidance.
 * @returns the tool description passed to `defineTool`.
 */
export function shellDescription(dialect, backgroundEnabled, escalationModes) {
    const background = backgroundEnabled
        ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
        : 'Background execution is not available; long-running commands must finish within the timeout.';
    if (dialect === 'posix') {
        const base = 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
            + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
            + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
            + `Current harness environment facts are exposed through managed \`\$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. `
            + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
            + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
            + background;
        return base + escalationTail(escalationModes);
    }
    const facts = DIALECT_FACTS[dialect];
    const base = `Execute a ${facts.shell} command (${facts.invoke}) and return its stdout/stderr. `
        + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
        + 'pass `workdir` instead of using `cd`. '
        + `Paths use ${facts.paths}; read environment variables with ${facts.env}; ${facts.toolchain} is available. `
        + `Note: ${facts.conversion}. `
        + 'Non-zero exits are reported as `[exit code: N]`. '
        + `Current harness environment facts are exposed through managed \`\$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. `
        + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
        + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
        + background;
    return base + escalationTail(escalationModes);
}
/**
 * The same-turn escalation guidance appended after a denial marker. Kept in
 * one place because every dialect shares the exact approval contract.
 * @param escalationModes - the escalation targets this composition advertises.
 * @returns the guidance sentence, or '' when no escalation is advertised.
 */
function escalationTail(escalationModes) {
    if (escalationModes.length === 0)
        return '';
    return ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
        + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
        + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
        + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
        + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
        + 'approval prompt raised by that retry is how the user consents. If the session states approval '
        + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
        + 'Never escalate speculatively: ground the request in a real denial — normally the one this command '
        + 'just hit; escalating up front is fine only when this session already denied the same access. '
        + 'A rejected escalation is final for that command — stop and explain, never work around '
        + 'it — but it does not forbid attempting or escalating other commands later.';
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
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the filesystem identity of the session cwd and leave executor
 * defaulting as the fallback. A resolved sandbox-policy root wins so workdir
 * and confinement use the exact same per-call identity.
 */
function resolveWorkdir(modelWorkdir, exec, policyWorkspaceRoot) {
    const headerCwd = exec.agent?.session.header.cwd;
    const sessionCwd = policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd));
    if (modelWorkdir === undefined)
        return sessionCwd;
    if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
        return resolvePath(sessionCwd, modelWorkdir);
    }
    return modelWorkdir;
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
 * @param def - the instance definition: `toolName` (also the job kind),
 *   `shell` (routed to the selector executor when defined), and `dialect`.
 * @returns the complete plugin object (name/inject/Config/apply).
 */
export function defineShellTool(def) {
    return {
        name: `tool-${def.toolName}`,
        inject: ['tools', 'shell', 'systemPrompt', 'shellEnv'],
        Config,
        apply(ctx, config = {}) {
            const backgroundEnabled = config.enableRunInBackground ?? true;
            const defaultMode = ctx.shell.sandboxMode;
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
            // Cross-call guidance belongs in the prompt rather than one-call schema prose.
            ctx.systemPrompt.section({
                name: `tool:${def.toolName}`,
                order: 105,
                text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
            });
            ctx.tools.register(defineTool({
                name: def.toolName,
                description: shellDescription(def.dialect, backgroundEnabled, escalationModes),
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
                    workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
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
                        ...def.shell !== undefined ? { shell: def.shell } : {},
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
                        // Task preflight finishes before the starter can spawn a process.
                        const id = jobs.start({
                            kind: def.toolName,
                            label: args.command,
                            ...exec.agent ? { owner: exec.agent } : {},
                            run: () => {
                                const proc = ctx.shell.start(ctx.shell.resolve(request));
                                return {
                                    cancel: () => void proc.kill(),
                                    done: proc.done.then(() => processOutcome(proc)),
                                    readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
                                };
                            },
                        });
                        return { kind: 'background', jobId: id };
                    }
                    const result = await ctx.shell.run(ctx.shell.resolve({
                        ...request,
                        signal: exec.signal,
                    }));
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