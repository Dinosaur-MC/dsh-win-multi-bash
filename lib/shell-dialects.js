/**
 * The registry of shell dialects: **the one place** that says which shells this
 * plugin ships and what each one is.
 *
 * Everything else is derived from here (see ./tool-bash/types/registry.js, the
 * browser half's generated block, `cordis.patch.yml` rows, `package.json`
 * exports and the audit's dialect matrix) — adding a dialect is "one file plus
 * one declaration", and anything that was *not* updated is detected instead of
 * silently half-working:
 *
 *  - {@link validateShellDialects} runs at load time and again in the rows'
 *    `apply`, and **throws** on an incomplete registry (duplicate ids, a
 *    missing facts block, a stance list without `auto`, a tool name that
 *    collides with the family prompt section's name, a field that names
 *    someone else's config partition). Half-declared dialects therefore fail
 *    the boot instead of producing a tool no settings page can configure.
 *  - The audit regenerates the browser half's dialect block from this file and
 *    compares it byte-for-byte, because the browser half **cannot** import it:
 *    dsh serves a client plugin as one CommonJS factory whose `require` only
 *    reaches modules in the boot graph (bare package specifiers), so a relative
 *    or subpath import of a file in our own package is not resolvable there
 *    (measured: `dsh-client-modules` normalizes a specifier onto a graph row and
 *    answers `undefined` for a path or a subpath). The generated block plus the
 *    byte-comparison guard is the strongest available form of "one source".
 *
 * This module is pure data and pure functions on purpose — no `node:` imports,
 * no executor classes, no service access — so both halves and the audit can
 * read it.
 * @module dsh-win-multi-bash/shell-dialects
 */

/** The package that owns every dialect here (also the family section's row). */
export const PACKAGE_NAME = 'dsh-win-multi-bash';

/**
 * The one prompt section carrying the family's shared guidance. Named for the
 * plugin's tool family rather than for one tool, so no dialect owns it.
 */
export const SHELL_FAMILY_SECTION_NAME = 'tool:win-mb-bash';

/**
 * The knobs every dialect's executor inherits from `LocalBashExecutor`, in the
 * form's order. Shared by the host schema and the browser half's form, which is
 * why they live in the registry rather than in either one.
 */
export const EXECUTOR_LIMIT_FIELDS = [
    { leaf: 'cwd', kind: 'text', rule: 'path' },
    { leaf: 'timeoutMs', kind: 'number' },
    { leaf: 'maxTimeoutMs', kind: 'number' },
    { leaf: 'maxOutputBytes', kind: 'number' },
    { leaf: 'maxSpillBytes', kind: 'number' },
    { leaf: 'graceMs', kind: 'number' },
];

/**
 * Every dialect this plugin ships, in composition order.
 *
 * A declaration is data plus two strings that *name* code (`executor.module` /
 * `executor.export`) — never a class reference, so this file stays importable
 * from the browser half and from the audit without dragging in `node:fs`.
 *
 * Field meanings:
 *  - `toolName`  — the model-facing tool name, also the job kind. It must not be
 *    a substring of {@link SHELL_FAMILY_SECTION_NAME}, or the section name would
 *    read as belonging to that one tool (the audit has asserted this since the
 *    section was merged into the package row).
 *  - `rowId`     — the Loader row id, which is also the settings key and the
 *    browser slot key (`<package name>#<row id>`).
 *  - `specifier` / `entry` — the `package.json` export subpath the Loader row
 *    names, and the module file under `lib/tool-bash/types/` it resolves to.
 *  - `configKey` — the Config partition the dialect's own knobs live under; it is
 *    the partition the browser half's form edits.
 *  - `fields`    — the dialect-owned knobs of that partition, in form order,
 *    each with the validation rule its text must satisfy (the browser half's
 *    warning face) where one applies.
 *  - `sandboxStances` — the stance vocabulary. **Not merged across dialects**:
 *    the union would advertise a stance an executor cannot honour, so each
 *    dialect states exactly what its executor implements.
 *  - `family`    — whether the dialect joins the shared prompt section, and the
 *    key its facts are registered under.
 *  - `resolve`   — how the executable is located: the discovery kind plus the
 *    roots/environment the dialect's own resolver starts from.
 */
export const SHELL_DIALECTS = [
    {
        id: 'msys',
        toolName: 'git_bash',
        rowId: 'win-mb-tool-git',
        configKey: 'gitBash',
        specifier: 'tool-git-bash',
        entry: 'git-bash',
        label: { en: 'Git Bash', zh: 'Git Bash' },
        executor: { module: '../../bash-git/index.js', export: 'GitBashExecutor' },
        argvStyle: 'msys',
        sandboxStances: ['auto', 'none'],
        fields: [{ leaf: 'bashPath', kind: 'text', rule: 'path' }],
        resolve: { kind: 'git', roots: ['%ProgramFiles%\\Git', '%ProgramFiles(x86)%\\Git', '%LocalAppData%\\Programs\\Git'] },
        family: { shared: true, facts: 'msys' },
        win32Only: true,
        facts: {
            shell: 'Git Bash (MSYS2)',
            invoke: 'bash -c',
            paths: 'MSYS form (`/d/WorkSpace` or `C:\\...`)',
            env: '$VAR',
            note: 'MSYS paths work inside Git Bash only — dsh\'s file tools (`read`, `write`, `edit`) on Windows take native `C:\\...` paths',
        },
    },
    {
        id: 'wsl',
        toolName: 'wsl_bash',
        rowId: 'win-mb-tool-wsl',
        configKey: 'wslBash',
        specifier: 'tool-wsl-bash',
        entry: 'wsl-bash',
        label: { en: 'WSL Bash', zh: 'WSL Bash' },
        executor: { module: '../../bash-wsl/index.js', export: 'WslBashExecutor' },
        argvStyle: 'wsl',
        sandboxStances: ['auto', 'none', 'bwrap'],
        fields: [
            { leaf: 'wslPath', kind: 'text', rule: 'path' },
            { leaf: 'wslDistro', kind: 'text', rule: 'distro' },
        ],
        resolve: { kind: 'wsl' },
        family: { shared: true, facts: 'wsl' },
        win32Only: true,
        facts: {
            shell: 'WSL Linux',
            invoke: 'bash -c',
            paths: 'Linux paths (`/mnt/c/...`)',
            env: '$VAR',
        },
    },
    {
        id: 'msys2',
        toolName: 'msys2_bash',
        rowId: 'win-mb-tool-msys2',
        configKey: 'msys2Bash',
        specifier: 'tool-msys2-bash',
        entry: 'msys2-bash',
        label: { en: 'MSYS2 Bash', zh: 'MSYS2 Bash' },
        executor: { module: '../../bash-msys2/index.js', export: 'Msys2BashExecutor' },
        argvStyle: 'msys',
        // MSYS2's bash is an MSYS runtime like Git Bash, so the windows-acl
        // runner cannot confine it either — the same two stances, declared here
        // rather than inherited, so a future change to one dialect's vocabulary
        // cannot silently change the other's.
        sandboxStances: ['auto', 'none'],
        fields: [{ leaf: 'bashPath', kind: 'text', rule: 'path' }],
        // Where MSYS2 lives, in probe order. The installed location is discovered
        // from the registry uninstall key on this host (`HKCU\…\Uninstall\
        // {4b1a4d1b-9712-45ad-b2cb-b1b1eaccd0ee}` → `D:\Local\msys64`), which is
        // why the default list is a probe order rather than one fixed path; the
        // `bashPath` knob is the per-machine pin.
        resolve: {
            kind: 'msys2',
            roots: ['%ProgramFiles%\\msys64', 'C:\\msys64', 'D:\\Local\\msys64'],
            env: { MSYSTEM: 'UCRT64' },
        },
        family: { shared: true, facts: 'msys2' },
        win32Only: true,
        // Opt-in: the row ships disabled and the user enables it in the panel.
        defaultEnabled: false,
        facts: {
            shell: 'MSYS2 UCRT64',
            invoke: 'bash -c',
            paths: 'MSYS2 form (`/c/...` for `C:`, `/d/...` for `D:`)',
            env: '$VAR',
            note: 'this is MSYS2\'s own bash (pacman-managed; `$MSYSTEM` is exported as UCRT64), not Git for Windows\' — its `/usr/bin` carries the MSYS2 packages, and `pacman` manages them',
        },
    },
];

/** One declaration by dialect id, or `undefined`. */
export function dialectById(id, dialects = SHELL_DIALECTS) {
    return dialects.find((dialect) => dialect.id === id);
}

/**
 * The dialect-owned facts, keyed the way `shellDescription` reads them (by the
 * declaration's `family.facts` key). A dialect that does not join the family is
 * absent here by construction — it has no shared section to keep distinct.
 */
export function dialectFacts(dialects = SHELL_DIALECTS) {
    return Object.fromEntries(dialects
        .filter((dialect) => dialect.family?.facts !== undefined)
        .map((dialect) => [dialect.family.facts, dialect.facts]));
}

/** The tool names the shared family prompt section speaks for, in order. */
export function familyToolNames(dialects = SHELL_DIALECTS) {
    return dialects.filter((dialect) => dialect.family?.shared === true).map((dialect) => dialect.toolName);
}

/**
 * The browser half's form rows, derived. Kept here (not in the browser half) so
 * the host, the generator and the audit read one shape; the browser half carries
 * the generated copy of this output — see the module header.
 * @returns `[{ rowId, label, fields }]`, fields as `{ key, path, kind, options? }`.
 */
export function clientRows(dialects = SHELL_DIALECTS) {
    return dialects.map((dialect) => ({
        rowId: dialect.rowId,
        label: dialect.label,
        fields: [
            { key: 'enableRunInBackground', path: ['enableRunInBackground'], kind: 'boolean' },
            ...EXECUTOR_LIMIT_FIELDS.map((limit) => ({
                key: `${dialect.configKey}.${limit.leaf}`,
                path: [dialect.configKey, limit.leaf],
                kind: limit.kind,
            })),
            ...(dialect.fields ?? []).map((own) => ({
                key: `${dialect.configKey}.${own.leaf}`,
                path: [dialect.configKey, own.leaf],
                kind: own.kind,
                ...own.options === undefined ? {} : { options: own.options },
            })),
            {
                key: `${dialect.configKey}.sandbox`,
                path: [dialect.configKey, 'sandbox'],
                kind: 'enum',
                options: dialect.sandboxStances,
            },
            { key: `${dialect.configKey}.probeTimeoutMs`, path: [dialect.configKey, 'probeTimeoutMs'], kind: 'number' },
            { key: `${dialect.configKey}.requireSandbox`, path: [dialect.configKey, 'requireSandbox'], kind: 'boolean' },
        ],
    }));
}

/**
 * The syntax rule a text knob's leaf is checked against, derived from the
 * dialects' own declarations plus the shared limits. The browser half warns on a
 * value that breaks its rule; the host answers the existence question at use
 * time (the browser has no filesystem).
 */
export function leafRules(dialects = SHELL_DIALECTS) {
    const rules = Object.fromEntries(EXECUTOR_LIMIT_FIELDS
        .filter((limit) => limit.rule !== undefined)
        .map((limit) => [limit.leaf, limit.rule]));
    for (const dialect of dialects)
        for (const own of dialect.fields ?? [])
            if (own.rule !== undefined) rules[own.leaf] = own.rule;
    return rules;
}

/**
 * The `package.json` `exports` entries the dialect rows load code through, plus
 * the two the composition itself needs. The audit asserts the manifest carries
 * exactly these (a dialect whose subpath is missing cannot be loaded at all).
 */
export function exportSubpaths(dialects = SHELL_DIALECTS) {
    return {
        '.': './lib/index.js',
        './client': './lib/client.js',
        './factory': './lib/tool-bash/types/factory.js',
        './shell-family': './lib/tool-bash/types/shell-family.js',
        './registry': './lib/tool-bash/types/registry.js',
        ...Object.fromEntries(dialects.map((dialect) => [`./${dialect.specifier}`, `./lib/tool-bash/types/${dialect.entry}.js`])),
        './package.json': './package.json',
    };
}

/**
 * The rows this plugin inserts, derived in composition order: the package row
 * (which owns the prompt section and the browser half) followed by one row per
 * dialect. `cordis.patch.yml` is a static file the Loader reads, so these are
 * its declared shape rather than its generator — the audit compares the two and
 * fails on any drift.
 */
export function patchRows(dialects = SHELL_DIALECTS) {
    return [
        { id: 'win-mb-plugin', name: PACKAGE_NAME, win32Only: true, disabledByDefault: false },
        ...dialects.map((dialect) => ({
            id: dialect.rowId,
            name: `${PACKAGE_NAME}/${dialect.specifier}`,
            win32Only: dialect.win32Only === true,
            // Opt-in dialects ship disabled and are enabled per composition.
            disabledByDefault: dialect.defaultEnabled === false,
        })),
    ];
}

/** Prefix every validation failure carries, so the failure names its source. */
export const REGISTRY_ERROR_PREFIX = 'dsh-win-multi-bash: shell dialect registry invalid: ';

/**
 * Validate one registry declaration list; throw on the first violation.
 *
 * These are the invariants that used to be maintained by hand across eight
 * files. They are checked here (load time and again in the rows' `apply`) so a
 * broken declaration refuses to load rather than shipping a tool that is
 * registered but unconfigurable, or a prompt section silently claiming a tool's
 * name.
 * @param dialects - the declaration list to check (defaults to the shipped one).
 */
export function validateShellDialects(dialects = SHELL_DIALECTS) {
    const fail = (message) => {
        throw new Error(`${REGISTRY_ERROR_PREFIX}${message}`);
    };
    if (!Array.isArray(dialects) || dialects.length === 0) fail('expected a non-empty list of dialect declarations');
    const unique = (values, what) => {
        const seen = new Set();
        for (const value of values) {
            if (value === undefined || value === null || value === '')
                fail(`a dialect declares no ${what}`);
            if (seen.has(value)) fail(`duplicate ${what} "${value}"`);
            seen.add(value);
        }
    };
    unique(dialects.map((dialect) => dialect.id), 'dialect id');
    unique(dialects.map((dialect) => dialect.rowId), 'rowId');
    unique(dialects.map((dialect) => dialect.toolName), 'toolName');
    unique(dialects.map((dialect) => dialect.configKey), 'configKey');
    unique(dialects.map((dialect) => dialect.specifier), 'export specifier');
    unique(dialects.map((dialect) => dialect.entry), 'module entry');
    for (const dialect of dialects) {
        const who = `dialect "${dialect.id}"`;
        // The family section is named for the family, never for one tool: a tool
        // name inside it would read as that tool owning the shared guidance.
        if (SHELL_FAMILY_SECTION_NAME.includes(dialect.toolName))
            fail(`${who}: tool name "${dialect.toolName}" collides with the family section name "${SHELL_FAMILY_SECTION_NAME}"`);
        if (!Array.isArray(dialect.sandboxStances) || dialect.sandboxStances.length === 0)
            fail(`${who}: declares no sandboxStances`);
        if (!dialect.sandboxStances.includes('auto'))
            fail(`${who}: sandboxStances must include "auto"`);
        if (dialect.family?.shared === true && (typeof dialect.family.facts !== 'string' || dialect.family.facts.length === 0))
            fail(`${who}: is family-shared but declares no facts key`);
        if (dialect.facts === undefined || typeof dialect.facts.shell !== 'string' || dialect.facts.shell.length === 0)
            fail(`${who}: declares no dialect facts (shell/invoke/paths/env)`);
        for (const key of ['invoke', 'paths', 'env'])
            if (typeof dialect.facts[key] !== 'string' || dialect.facts[key].length === 0)
                fail(`${who}: facts.${key} is missing`);
        if (typeof dialect.executor?.module !== 'string' || typeof dialect.executor?.export !== 'string')
            fail(`${who}: declares no executor { module, export }`);
        if (dialect.win32Only !== true && dialect.win32Only !== false)
            fail(`${who}: declares no win32Only flag`);
        if (dialect.defaultEnabled !== undefined && typeof dialect.defaultEnabled !== 'boolean')
            fail(`${who}: defaultEnabled must be a boolean when declared`);
        if (dialect.label === undefined || typeof dialect.label.en !== 'string' || typeof dialect.label.zh !== 'string')
            fail(`${who}: declares no label`);
        // Rule 2, made structural: every knob the browser form edits for this
        // dialect must live in THIS dialect's partition, so `configKey` and the
        // form's partition cannot drift apart.
        const rows = clientRows([dialect]);
        for (const knob of rows[0].fields) {
            const partition = knob.path[0];
            if (partition !== dialect.configKey && partition !== 'enableRunInBackground')
                fail(`${who}: form field "${knob.key}" names another partition ("${partition}")`);
        }
        const ownLeaves = (dialect.fields ?? []).map((own) => own.leaf);
        unique(ownLeaves, `${who} field leaf`);
    }
}
