/**
 * Backend ownership for the bundled shell tools.
 *
 * dsh 0.1.7 removed the routing field from the shell seam: `ShellExecRequest`
 * no longer carries `shell`, so the pre-0.1.7 design — one selector executor
 * occupying `ctx.shell` and dispatching each request to a named backend — has
 * no routing input left. The tool is what knows which shell it wants, so each
 * tool now owns exactly one executor instance and drives it directly. The
 * `ctx.shell` seat is left entirely to the base bundle's own executor
 * (`pwsh-sandbox` on win32), which also frees every plugin that injects
 * `shell` (dsh's `tool-pwsh`, `permission-presets`, …) from waiting on us.
 *
 * `ShellExecutor` is a cordis `Service`: constructing one registers it under
 * `shell` on the context it is handed, and a second registration on the same
 * context throws (cordis' standard duplicate-service behavior). An owned
 * executor is therefore built on a child fiber whose `shell` scope is
 * isolated, so it never contends for the seat.
 *
 * @module dsh-win-multi-bash/tool-bash/backend
 */

/** Services every bundled executor needs before it can be constructed. */
const EXECUTOR_INJECT = ['subprocess', 'sandbox', 'sandboxPolicy'];

/**
 * Build one executor instance on an isolated child fiber.
 * @param ctx - the owning tool's context; the tool must already inject
 *   {@link EXECUTOR_INJECT} so those services are present here.
 * @param Executor - the executor class to construct.
 * @param config - the executor's resolved config partition.
 * @returns the instance plus the fiber that owns it; dispose the fiber to tear
 *   the backend down with the tool.
 */
export function ownExecutor(ctx, Executor, config) {
    const fiber = ctx.plugin({
        inject: EXECUTOR_INJECT,
        apply: () => {},
    });
    const backendCtx = fiber.ctx.isolate('shell', Symbol(Executor.name));
    return { executor: new Executor(backendCtx, config), fiber };
}
