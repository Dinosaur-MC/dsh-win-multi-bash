/**
 * Bundled bwrap profile helpers for the dsh-win-multi-bash plugin.
 *
 * Extracted from `@deepseek-ai/dsh-sandbox-local/profiles` (which the base
 * runtime does NOT export as a subpath, and which pulls in the landlock
 * native addon at top level). Only the bwrap parts the bundled wsl-bash
 * executor needs are kept, self-contained.
 *
 * @module dsh-win-multi-bash/vendor/bwrap-profiles
 */

/**
 * Structured runner-failure evidence for the bwrap runner (shared with in-distro consumers).
 * Anchored to the line start: bwrap's own diagnostics always begin with
 * `bwrap: `, so a wrapped command echoing the same text mid-line is not
 * misread as a runner failure.
 */
export const BWRAP_RUNNER_FAILURE_RULES = [{ fatalSignatures: ['bwrap: '], anchored: true }];

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy) {
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'];
    if (policy.mode === 'workspace-write') {
        args.push('--tmpfs', '/tmp');
        args.push('--bind', policy.workspaceRoot, policy.workspaceRoot);
    }
    return args;
}
