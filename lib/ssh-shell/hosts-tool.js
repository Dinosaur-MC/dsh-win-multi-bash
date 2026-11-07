/**
 * The `ssh_hosts` tool: a READ-ONLY inventory of the row's configured hosts.
 *
 * It reads the executor's normalized registry and never dials, never asks for
 * approval, and never returns credential material. The two snippet fields are
 * reduced to booleans so a caller can see whether a host carries them without the
 * text (which may contain paths or environment names) leaving the config store.
 * @module dsh-win-multi-bash/ssh-shell/hosts-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** The only approval values the schema (and a direct call) accepts. */
const APPROVALS = ['session', 'trusted']

/**
 * Filter + project the registry. Pure, so the ordering/sanitising contract can be
 * pinned without a tool runtime.
 * @param hosts - normalized hosts from the executor, in configured order.
 * @param args.query - case-insensitive substring over alias, host, user, description.
 * @param args.approval - 'session' | 'trusted'.
 * @param args.defaultOnly - only the row's default host.
 * @returns `{ hosts, total, matched }`.
 */
export function inventoryHosts(hosts, { query, approval, defaultOnly } = {}) {
    if (approval !== undefined && !APPROVALS.includes(approval))
        throw new Error('ssh_hosts: approval must be "session" or "trusted"')
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    const source = Array.isArray(hosts) ? hosts : []
    const matched = source.filter((host) => {
        if (approval !== undefined && host.approval !== approval) return false
        if (defaultOnly === true && host.default !== true) return false
        if (needle === '') return true
        return [host.alias, host.host, host.user, host.description]
            .some((value) => String(value ?? '').toLowerCase().includes(needle))
    })
    return {
        total: source.length,
        matched: matched.length,
        hosts: matched.map((host) => ({
            alias: host.alias,
            user: host.user,
            host: host.host,
            port: host.port,
            approval: host.approval,
            default: host.default === true,
            description: typeof host.description === 'string' ? host.description : '',
            hasStartupCommand: typeof host.startupCommand === 'string' && host.startupCommand.trim() !== '',
            hasShellTemplate: typeof host.shellTemplate === 'string' && host.shellTemplate.trim() !== '',
        })),
    }
}

/**
 * Shape the model-facing text. It is deliberately a compact table over the SAME
 * sanitized projection the JSON carries; no key path or passphrase variable is
 * ever printed.
 * @param _args - the call arguments.
 * @param value - the tool value.
 */
function renderHosts(_args, value) {
    if (typeof value.invalid === 'string') {
        return [{ type: 'text', text: `ssh_hosts: sshShell.hosts is invalid (${value.invalid}); every ssh call fails until it is fixed.` }]
    }
    if (value.matched === 0) {
        const empty = value.total === 0
            ? 'No ssh hosts are configured. Add one on the SSH Configure page (sshShell.hosts).'
            : 'No configured host matches these filters.'
        return [{ type: 'text', text: empty + ` (total ${value.total}, matched 0)` }]
    }
    const lines = value.hosts.map((host) => {
        const tags = [host.approval, host.default ? 'default' : undefined,
            host.hasStartupCommand ? 'startup' : undefined,
            host.hasShellTemplate ? 'template' : undefined].filter(Boolean).join(', ')
        const description = host.description === '' ? '' : ` — ${host.description}`
        return `- ${host.alias}: ${host.user}@${host.host}:${host.port} (${tags})${description}`
    })
    return [{
        type: 'text',
        text: `ssh hosts (${value.matched}/${value.total}):\n` + lines.join('\n'),
    }]
}

/** Build the third tool this row serves. */
export function createHostsTool() {
    return {
        toolName: 'ssh_hosts',
        async register(ctx, { executor }) {
            ctx.tools.register(defineTool({
                name: 'ssh_hosts',
                description: 'List the ssh row\'s configured hosts, read-only and without connecting. '
                    + 'Optional filters: query matches alias/host/user/description (case-insensitive), '
                    + 'approval selects session or trusted, defaultOnly keeps the default host. '
                    + 'Returns each host\'s alias, user, host, port, approval, default, description, '
                    + 'hasStartupCommand and hasShellTemplate — never a key path, passphrase variable or other credential. '
                    + 'total is the configured count, matched the filtered count. '
                    + 'No connection is opened and no approval is requested; an empty registry is a successful empty list.',
                parameters: {
                    query: { type: 'string', description: 'Case-insensitive substring over alias, host, user and description.' },
                    approval: { type: 'string', enum: APPROVALS, description: 'Keep only hosts with this authorization mode.' },
                    defaultOnly: { type: 'boolean', description: 'Keep only the host marked default.' },
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            hosts: {
                                type: 'array',
                                required: true,
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        alias: { type: 'string', required: true },
                                        user: { type: 'string', required: true },
                                        host: { type: 'string', required: true },
                                        port: { type: 'integer', required: true },
                                        approval: { type: 'string', required: true },
                                        default: { type: 'boolean', required: true },
                                        description: { type: 'string', required: true },
                                        hasStartupCommand: { type: 'boolean', required: true },
                                        hasShellTemplate: { type: 'boolean', required: true },
                                    },
                                },
                            },
                            total: { type: 'integer', required: true },
                            matched: { type: 'integer', required: true },
                            // Present only when the registry failed validation; the
                            // tool then reports a structured failure, never "empty".
                            invalid: { type: 'string' },
                        },
                    },
                    render: renderHosts,
                },
                async execute(args) {
                    // Read the VERDICT, not the getter that flattens it: an invalid
                    // registry must not masquerade as a successfully empty one.
                    const verdict = typeof executor.hostRegistry === 'function'
                        ? executor.hostRegistry()
                        : { ok: true, hosts: executor.hosts ?? [] }
                    if (verdict.ok !== true)
                        return { hosts: [], total: 0, matched: 0, invalid: verdict.error ?? 'the host registry failed validation' }
                    return inventoryHosts(verdict.hosts ?? [], args ?? {})
                },
            }))
        },
    }
}
