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
import { CLIENT_ROWS, LEAF_RULES } from '../lib/tool-bash/types/registry.js';

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
        lines.push(`\t\t\t\t\tfield(${path}, ${JSON.stringify(knob.kind)}${options}),`);
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
    return `${lines.join('\n')}\n`;
}

/** Replace the marked region in `source`; throws when the markers are missing or out of order. */
export function spliceClientRegistry(source) {
    const begin = source.indexOf(GENERATED_BEGIN);
    const endMarker = source.indexOf(GENERATED_END, begin === -1 ? 0 : begin);
    if (begin === -1) throw new Error(`gen-client-registry: ${GENERATED_BEGIN.trim()} not found in lib/client.js`);
    if (endMarker === -1) throw new Error(`gen-client-registry: ${GENERATED_END.trim()} not found after the region start`);
    const bodyStart = source.indexOf('\n', begin) + 1;
    const head = source.slice(0, bodyStart);
    const tail = source.slice(endMarker);
    return `${head}${renderClientRegistry()}${tail}`;
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
