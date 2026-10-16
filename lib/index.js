// dsh-win-multi-bash — self-contained Windows multi-bash plugin.
//
// This package carries the whole feature implementation, bundled from the
// DeepSeek Harness project's shell packages (see THIRD_PARTY_NOTICES),
// compiled to plain ESM JS:
//
//   lib/bash-git/       — GitBashExecutor (MSYS / Git for Windows)
//   lib/bash-wsl/       — WslBashExecutor (WSL distros, base64 payloads)
//   lib/tool-bash/      — defineShellTool factory + git_bash / wsl_bash
//                         instances, each owning its own executor
//                         (types/backend.js) instead of sharing the ctx.shell
//                         seat: dsh 0.1.7 removed ShellExecRequest.shell, the
//                         routing field the old shell-select design used.
//                         The shared prompt section's single owner row used to
//                         be a separate file here; it is now this package row
//                         itself, so the section cannot be switched off without
//                         the browser half going with it.
//   lib/vendor/         — helpers.js (bash-sandbox classification, including the
//                         anchored runner-failure rule the base runtime does
//                         not export) and bwrap-profiles.js (bwrap rules/args).
//   lib/client.js       — the browser half: the Plugins page's configuration
//                         form for the two tool rows.
//
// Only published @deepseek-ai base packages are imported (dsh-shell,
// dsh-sandbox, dsh-bash-local, dsh-tools, dsh-llm, ...), so the plugin runs
// on any standard deployment — no additional runtime packages required.
//
// The composition wiring lives in cordis.patch.yml.
import {
    SHELL_FAMILY_SECTION_NAME,
    markFamilySectionOwner,
    shellFamilySectionOrder,
    shellFamilySectionTextFor,
} from './tool-bash/types/shell-family.js';
// The dialect registry validates itself at import; this row calls it explicitly
// as well, because it is the one row every composition loads (the tool rows can
// all be switched off, and a broken declaration must still refuse the boot).
import z from '@deepseek-ai/schemastery';
import { validateShellDialects } from './shell-dialects.js';
import { SANDBOX_TEMP_GUARD_DEFAULT, SANDBOX_TEMP_WATCH_MS, setSandboxTempGuardEnabled, setSandboxTempWatchMs, startSandboxTempWatch } from './sandbox-temp-guard.js';

/** Row name; the Loader also uses it for logging and for the prompt-section owner. */
export const name = 'dsh-win-multi-bash';

/**
 * `systemPrompt` is the registry the family section belongs to; `tools` is read
 * at every assembly so the section can describe exactly the shell tools this
 * composition mounts. Without a tools registry there are no such tools, and the
 * row correctly never applies.
 */
export const inject = ['systemPrompt', 'tools'];

/**
 * The package row — the plugin's core row.
 *
 * It exists because the Web client's module system discovers a browser half by
 * resolving a Loader row's **bare package specifier** to its `package.json` and
 * reading `dsh.client` there (client-modules' `locatePkgJson` →
 * `exactPackageSpecifier`, which answers `undefined` for a subpath). The tool
 * rows this bundle inserts are subpaths, so none of them can carry that
 * declaration; without this row `lib/client.js` is never served and the tool
 * rows show no Configure page.
 *
 * It is also the owner of the one prompt section the bash family shares
 * (`tool:win-mb-bash`), which is why it is not an empty `apply` any more: the
 * section used to live in a row of its own, and merging the two removes a
 * switch that could only ever make the composition worse. The section's text is
 * resolved per assembly, so a composition that switched every tool row off
 * mounts no family tool and this section then contributes no text at all.
 */
/**
 * The package row's own configuration: the deployment-wide switches a reader expects at
 * the TOP of the plugin, not inside a shell row.
 *
 * Declaring it is also what makes the Host SERVE this row settings namespace, which is
 * the precondition for the client half's top-level card: the official plugin page's
 * config entries exist only while a namespace is served.
 */
/**
 * Both knobs are `.volatile()` for the same reason every tool knob is: that marker is
 * what makes the settings service address them as live, writable values. A plain
 * field is served read-only, and the Plugins page then says the row cannot be
 * configured — measured here as the strip reading `unavailable` instead of the form.
 */
export const Config = z.object({
  guardSandboxTemp: z.boolean().default(SANDBOX_TEMP_GUARD_DEFAULT).volatile(),
  tempWatchMs: z.natural().default(SANDBOX_TEMP_WATCH_MS).volatile()
});
export function apply(ctx, config = {}) {
    // The package row is the composition's front door: validate the dialect
    // registry here as well, so a broken declaration refuses the boot even in a
    // composition whose tool rows are all disabled (their own apply validates
    // too, and the registry validates at import — this is the row that always
    // loads).
    validateShellDialects();
    // The private-temp guard is driven from THIS row, not from the shell rows: it must
    // not depend on a shell command ever running (a row whose probe fails never
    // confines again), and the root the harness keeps for its own confined tools is a
    // directory no shell row is ever handed. This row is the one the composition
    // always mounts, so the guard is armed for the whole session.
    setSandboxTempGuardEnabled(config.guardSandboxTemp !== false);
    setSandboxTempWatchMs(config.tempWatchMs);
    startSandboxTempWatch(ctx, {
        enabled: config.guardSandboxTemp !== false,
        intervalMs: config.tempWatchMs,
        warn: (_key, message) => ctx.logger?.warn?.('dsh-win-multi-bash: ' + message)
    });
    // Cordis guarantees the injected services, so `systemPrompt` is present —
    // but the *shape* of that service is dsh's business, not ours. Feature-detect
    // the one method this row calls before touching it: this is boot-time code on
    // the row that also carries the browser half, and the section is guidance, not
    // behavior. A registry without `section` means "no prompt registration here",
    // which must cost the section and nothing else — never the row's apply.
    const { systemPrompt } = ctx;
    if (systemPrompt === null || systemPrompt === undefined || typeof systemPrompt.section !== 'function') return;
    systemPrompt.section({
        name: SHELL_FAMILY_SECTION_NAME,
        order: shellFamilySectionOrder(systemPrompt),
        text: ({ scope }) => shellFamilySectionTextFor(ctx, scope),
    });
    // Publish the registered fact the tool rows read (see
    // shell-family.js `familyRowComposed`): their descriptions are slim only
    // while this section is genuinely mounted. Scoped to the row's effect so a
    // row that goes away stops claiming ownership — and skipped entirely for a
    // context with no effect lifecycle, which is what the shape-only `apply`
    // probe hands in, so a bare object can never leave a stale claim behind.
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
            markFamilySectionOwner(true);
            return () => markFamilySectionOwner(false);
        });
    }
}
