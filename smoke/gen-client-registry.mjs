/**
 * Render the browser half's registry-derived block from `lib/shell-dialects.js`.
 *
 * The browser half is a single CommonJS factory: dsh's client module loader
 * resolves every `require` onto a boot-graph specifier, and answers `undefined`
 * for a subpath or a relative path (measured on dsh-client-modules'
 * `exactPackageSpecifier`/`normalizeSpecifier`). It therefore cannot import
 * `lib/shell-dialects.js`, and a hand-written second list is exactly the drift
 * this refactor removes.
 *
 * So the block is *generated*: this module renders it, `--write` splices it into
 * `lib/client.js` between the marker lines below, and the audit calls
 * {@link renderClientRegistry} and compares the result with what the file
 * carries, byte for byte. A dialect added without regenerating the browser half
 * is a named red, not a silent half-working page.
 *
 * Usage:
 *   node smoke/gen-client-registry.mjs            # print the block
 *   node smoke/gen-client-registry.mjs --write    # splice it into lib/client.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_GATED_TOOL_NAMES, CLIENT_ROWS, LEAF_RULES, SHELL_FAMILY_TOOL_NAMES, TERMINAL_ROW } from '../lib/tool-bash/types/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js');

/** The line that opens the generated region in `lib/client.js`. */
export const GENERATED_BEGIN = '\t\t//#region registry-derived (generated)';
/** The line that closes it. */
export const GENERATED_END = '\t\t//#endregion';

/** Render one form row the way the browser half's `field()` helper takes it. */
function renderRow(row) {
    const lines = [];
    lines.push('\t\t\t{');
    lines.push(`\t\t\t\trowId: ${JSON.stringify(row.rowId)},`);
    lines.push(`\t\t\t\tlabel: { en: ${JSON.stringify(row.label.en)}, zh: ${JSON.stringify(row.label.zh)} },`);
    lines.push('\t\t\t\tfields: [');
    for (const knob of row.fields) {
        const path = `[${knob.path.map((segment) => JSON.stringify(segment)).join(', ')}]`;
        const options = knob.options === undefined
            ? ''
            : `, [${knob.options.map((option) => JSON.stringify(option)).join(', ')}]`;
        const extra = {};
        for (const key of ['group', 'defaultValue', 'copyKey', 'hintKey'])
            if (knob[key] !== undefined) extra[key] = knob[key];
        const extraArg = Object.keys(extra).length === 0
            ? ''
            : knob.options === undefined
                ? `, undefined, ${JSON.stringify(extra)}`
                : `, ${JSON.stringify(extra)}`;
        lines.push(`\t\t\t\t\tfield(${path}, ${JSON.stringify(knob.kind)}${options}${extraArg}),`);
    }
    lines.push('\t\t\t\t],');
    lines.push('\t\t\t},');
    return lines;
}

/**
 * The generated block's text, without the surrounding region markers.
 * @returns a string ending in a newline.
 */
export function renderClientRegistry() {
    const lines = [];
    lines.push('\t\t/**');
    lines.push('\t\t * Syntax rule per text knob leaf, from the dialect registry. The browser');
    lines.push('\t\t * has no filesystem: this decides the visible warning only, and the');
    lines.push('\t\t * executor answers the existence question at use time.');
    lines.push('\t\t */');
    lines.push(`\t\tconst LEAF_RULES = { ${Object.entries(LEAF_RULES).map(([leaf, rule]) => `${JSON.stringify(leaf)}: ${JSON.stringify(rule)}`).join(', ')} };`);
    lines.push('\t\t/** The tool rows this bundle configures, in composition order. */');
    lines.push('\t\tconst ROWS = [');
    for (const row of CLIENT_ROWS) lines.push(...renderRow(row));
    lines.push('\t\t];');
    lines.push('\t\t/** The tool cards this bundle renders itself: every dialect tool in the shared');
    lines.push('\t\t * family, INDEPENDENT of which dialects can host a terminal. A command-only');
    lines.push('\t\t * dialect (ssh_shell) still needs its own card. */');
    lines.push(`\t\tconst SHELL_TOOL_NAMES = [${SHELL_FAMILY_TOOL_NAMES.map((name) => JSON.stringify(name)).join(', ')}];`);
    lines.push('\t\t/**');
    lines.push('\t\t * The interactive session tool\'s three literals, from the registry: the wire');
    lines.push('\t\t * name its keyed row is registered under, the row that carries its config, and');
    lines.push('\t\t * the config partition the shell list is read from. Hand-keeping them here was');
    lines.push('\t\t * the last place a rename could drift without a red.');
    lines.push('\t\t */');
    lines.push(`\t\tconst TERMINAL_ROW_ID = ${JSON.stringify(TERMINAL_ROW.rowId)};`);
    lines.push(`\t\tconst TERMINAL_TOOL_NAME = ${JSON.stringify(TERMINAL_ROW.toolName)};`);
    lines.push(`\t\tconst TERMINAL_CONFIG_KEY = ${JSON.stringify(TERMINAL_ROW.configKey)};`);
    lines.push('\t\t/**');
    lines.push('\t\t * The tools whose host authorization uses this bundle\'s own approval card');
    lines.push('\t\t * (the remote dialect\'s tool plus the extra tools its row serves), from the');
    lines.push('\t\t * registry. A rename reddens here instead of silently falling back to the');
    lines.push('\t\t * platform card.');
    lines.push('\t\t */');
    lines.push(`\t\tconst APPROVAL_GATED_TOOL_NAMES = [${APPROVAL_GATED_TOOL_NAMES.map((name) => JSON.stringify(name)).join(', ')}];`);
    return `${lines.join('\n')}\n`;
}

/** Replace the marked region in `source`; throws when the markers are missing or out of order. */
export function spliceClientRegistry(source) {
    const begin = source.indexOf(GENERATED_BEGIN);
    const endMarker = source.indexOf(GENERATED_END, begin === -1 ? 0 : begin);
    if (begin === -1) throw new Error(`gen-client-registry: ${GENERATED_BEGIN.trim()} not found in lib/client.js`);
    if (endMarker === -1) throw new Error(`gen-client-registry: ${GENERATED_END.trim()} not found after the region start`);
    // A region that was appended twice would leave two copies of the generated
    // `const` declarations in one factory scope: the browser then throws
    // `Identifier ... has already been declared`. Refuse the source instead of
    // silently replacing only the first copy.
    if (source.indexOf(GENERATED_BEGIN, begin + 1) !== -1)
        throw new Error('gen-client-registry: more than one generated region in lib/client.js; restore the file from git before writing');
    const bodyStart = source.indexOf('\n', begin) + 1;
    const head = source.slice(0, bodyStart);
    const tail = source.slice(endMarker);
    const next = `${head}${renderClientRegistry()}${tail}`;
    // One top-level declaration per generated name, in the whole factory. This
    // catches a hand-edit or a partial splice that still parses individually.
    for (const name of ['ROWS', 'SHELL_TOOL_NAMES', 'TERMINAL_ROW_ID', 'TERMINAL_TOOL_NAME', 'TERMINAL_CONFIG_KEY', 'APPROVAL_GATED_TOOL_NAMES']) {
        const count = next.split(`const ${name} =`).length - 1;
        if (count !== 1) throw new Error(`gen-client-registry: lib/client.js declares ${name} ${count} times; expected exactly once`);
    }
    return next;
}

/** The region's current text in a client source, or `undefined` when unmarked. */
export function currentClientRegistry(source) {
    const begin = source.indexOf(GENERATED_BEGIN);
    if (begin === -1) return undefined;
    const bodyStart = source.indexOf('\n', begin) + 1;
    const endMarker = source.indexOf(GENERATED_END, bodyStart);
    if (endMarker === -1) return undefined;
    return source.slice(bodyStart, endMarker);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gen-client-registry.mjs')) {
    const source = readFileSync(CLIENT_PATH, 'utf8');
    const next = spliceClientRegistry(source);
    if (process.argv.includes('--write')) {
        writeFileSync(CLIENT_PATH, next);
        console.log(`gen-client-registry: wrote ${CLIENT_ROWS.length} rows into lib/client.js`);
    } else {
        process.stdout.write(renderClientRegistry());
    }
}
