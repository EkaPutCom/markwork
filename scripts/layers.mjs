// Checks the direction of dependencies between layers (see "Layers and the direction of
// dependencies" in README.md) and the cyclomatic complexity of every function in src/ and scripts/.
// Run by `npm run build` and `npm run typecheck`; exits 1 and lists every violation.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';   // the oxc parser that Vite 8 already ships (TypeScript 7 has no JS API)

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const GTK = /^gi:\/\/(Gtk|Gdk|GdkPixbuf|GdkX11|Gsk|Adw|GtkSource|WebKit|Pango|Graphene)(\?|$)/;
const BASE = ['settings.ts', 'welcome.ts', 'files.ts', 'fileops.ts', 'workspace.ts', 'git.ts', 'gitlog.ts', 'config.ts', 'colors.ts', 'credentials.ts', 'cancel.ts', 'i18n.ts', 'awaitable.ts', 'activity.ts'];

// The core: everything below the interface. It reaches the runtime only through platform/index.ts, never through gi:// and
// never through platform/gjs/, so it can run on another runtime. GI_ALLOWED listed the core modules that still imported
// gi:// while they were moved behind the port; it is empty now that every one is. An entry may not be added back, and one
// has to go once its module is clean.
const isCore = f => /^(markdown|agent|forge)\//.test(f) || BASE.includes(f)
    || ['orchestrator.ts', 'orchestratordaemon.ts', 'daemonhub.ts', 'platform/index.ts'].includes(f);
const GI_ALLOWED = new Set([]);

// [files the rule applies to, what they may not import, why]. Targets are src-relative paths of
// local modules or gi:// specifiers.
const rules = [
    [f => f.startsWith('markdown/'), t => t.startsWith('gi://') || !t.startsWith('markdown/'), 'markdown/ only holds string → data functions: no GI, nothing outside markdown/'],
    [f => f.startsWith('agent/'), t => GTK.test(t) || /^(ui|editor|window)\//.test(t) || t === 'window.ts', 'agent/ is free of GTK and knows nothing about the editor, widgets, or the window'],
    [f => f.startsWith('forge/'), t => GTK.test(t) || /^(ui|editor|window|agent)\//.test(t) || t === 'window.ts', 'forge/ talks to Git hosting services: free of GTK and knows nothing about widgets, the editor, the window, or the agent'],
    [f => f.startsWith('editor/'), t => /^(ui|window|agent)\//.test(t) || t === 'window.ts', 'editor/ knows nothing about files, menus, the sidebar, or the agent'],
    [f => f.startsWith('ui/') || f.startsWith('window/') || f === 'actions.ts', t => t === 'window.ts', 'only app.ts composes MainWindow; components and controllers get a host interface'],
    [f => BASE.includes(f), t => /^(ui|editor|agent|window)\//.test(t) || t === 'window.ts', 'base modules do not reach up into the layers above them'],
    [f => f === 'orchestrator.ts' || f === 'orchestratordaemon.ts' || f === 'daemonhub.ts', t => GTK.test(t) || /^(ui|editor|window)\//.test(t) || t === 'window.ts', 'the orchestrator runs harness processes for window/harness.ts; it uses agent/, markdown/, and base modules, never GTK, widgets, or the window'],
    [f => isCore(f) && !GI_ALLOWED.has(f), t => t.startsWith('gi://'), 'the core reaches the runtime through platform() (platform/index.ts), not gi://'],
    [isCore, t => t.startsWith('platform/gjs/'), 'the core uses the platform port, never its GJS implementation; entry points install it'],
    [isCore, t => t.startsWith('gjs:'), 'the core does not use GJS built-in modules; what it needs is in the platform port'],
    [isCore, t => t.startsWith('app/'), 'the core does not know the application layer above it'],
    [f => f.startsWith('app/'), t => t.startsWith('gi://') || t.startsWith('gjs:') || t.startsWith('platform/gjs/') || !(isCore(t) || t.startsWith('app/')),
        'app/ is the application layer every frontend shares: it imports only the core and app/, never GI, widgets, or the window'],
    [isCore, t => !t.startsWith('gi://') && !t.startsWith('gjs:') && !isCore(t), 'the core imports only the core, so it is free of GI all the way down, not only in its own imports'],
    [f => f === 'platform/index.ts', () => true, 'platform/index.ts is the contract and imports nothing'],
    [f => f === 'platform/terminals.ts', t => t !== 'platform/index.ts', 'platform/terminals.ts is shared by both ports and imports only the contract'],
    [f => f.startsWith('platform/gjs/'), t => /^(ui|editor|window|agent|forge|markdown)\//.test(t) || t === 'window.ts', 'platform/gjs/ implements the port with GI and base modules; it knows nothing about the layers that use it'],
    [f => f.startsWith('platform/node/'), t => t.startsWith('gi://') || t.startsWith('gjs:') || !(t.startsWith('node:') || t.startsWith('platform/node/') || t === 'platform/index.ts' || t === 'platform/terminals.ts'),
        'platform/node/ implements the port with Node built-ins only: the contract, the shared terminal list, and its own files, nothing above it'],
    [f => !f.startsWith('platform/node/'), t => t.startsWith('node:') || t.startsWith('platform/node/'), 'only platform/node/ uses Node built-ins; the rest reaches them through platform(), and only an entry point installs it'],
];

const GJS_BUILTINS = new Set(['system', 'gettext', 'cairo', 'console', 'byteArray', 'mainloop']);
const files = readdirSync(src, { recursive: true }).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts')).map(f => f.split('\\').join('/'));
const IMPORT = /(?:^|\n)\s*(?:import|export)(\s+type\b)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const errors = [];
const giImporters = new Set();
const valueImports = new Map();   // src-relative module → the local modules it imports for their values (not `import type`)
for (const file of files) {
    const text = readFileSync(join(src, file), 'utf8');
    for (const m of text.matchAll(IMPORT)) {
        const spec = m[2] ?? m[3] ?? m[4];
        let target = spec;
        if (spec.startsWith('.')) {
            target = relative(src, normalize(join(src, dirname(file), spec.split('?')[0]))).split('\\').join('/').replace(/\.js$/, '.ts');
        } else if (GJS_BUILTINS.has(spec)) {
            target = `gjs:${spec}`;   // a GJS built-in module (system, gettext, cairo)
        } else if (spec.startsWith('node:')) {
            target = spec;   // a Node built-in module
        } else if (!spec.startsWith('gi://')) continue;   // npm packages
        if (target.startsWith('gi://')) giImporters.add(file);
        if (!m[1] && spec.startsWith('.')) valueImports.set(file, [...valueImports.get(file) ?? [], target]);
        for (const [applies, forbidden, why] of rules) {
            if (applies(file) && forbidden(target)) errors.push(`src/${file}: imports ${spec} (${why})`);
        }
    }
}

// ---------- System specifics stay in the port ----------
//
// What differs between Linux, macOS, and Windows (the system's name, the GNOME terminals, the keyring program) is written
// once in platform/ (platform/node/dirs.ts, platform/terminals.ts, the GJS and Node ports), where tests/unit/crossos.ts
// runs it for all three systems. The core and app/ ask the port; they never test `process.platform` or name such a program.
const SYSTEM_SPECIFIC = /process\.platform|\b(kgx|ptyxis|gnome-terminal|xdg-terminal-exec|secret-tool|osascript)\b/;
for (const file of files.filter(f => (isCore(f) || f.startsWith('app/')) && !f.startsWith('platform/'))) {
    const hit = SYSTEM_SPECIFIC.exec(readFileSync(join(src, file), 'utf8'));
    if (hit) errors.push(`src/${file}: mentions "${hit[0]}" (what differs per system belongs in platform/, behind platform(); see "The foundation for other frontends" in AGENT.md)`);
}

// ---------- Views do not act ----------
//
// A component in ui/ draws and reports; the work it starts goes through app/ (or the window), so the same work can later
// be asked for by a frontend in another process (docs/design/protocol.md, section 13). A core module "acts" when it
// reaches the runtime: it imports platform/index.ts, directly or through other modules (i18n.ts does not count, it only
// translates text). ui/ may import such a module for its types (`import type`), and pure core modules freely.
// UI_ACTS_ALLOWED listed the imports that still did it while they were moved (the Assistant, History, and the file tree);
// it is empty now and may not grow.
const UI_ACTS_ALLOWED = new Set([]);
const acting = new Map();
const acts = file => {
    if (!acting.has(file)) {
        acting.set(file, false);   // a cycle does not act by itself
        acting.set(file, file === 'platform/index.ts' || (valueImports.get(file) ?? []).some(t => t !== 'i18n.ts' && acts(t)));
    }
    return acting.get(file);
};
const uiActs = new Set();
for (const file of files.filter(f => f.startsWith('ui/'))) {
    for (const target of valueImports.get(file) ?? []) {
        if (!(isCore(target) || target === 'fileops.ts') || target === 'i18n.ts' || !acts(target)) continue;
        const pair = `${file} -> ${target}`;
        uiActs.add(pair);
        if (!UI_ACTS_ALLOWED.has(pair)) errors.push(`src/${file}: imports ${target}, which reaches the runtime (a view draws and reports; the work goes through app/, see docs/design/protocol.md section 13; import its types with \`import type\`)`);
    }
}
for (const pair of UI_ACTS_ALLOWED) {
    if (!uiActs.has(pair)) errors.push(`scripts/layers.mjs: ${pair} is no longer an import that acts; remove it from UI_ACTS_ALLOWED`);
}

// ---------- The Electron renderer is a view ----------
//
// electron/renderer/ draws in a browser page and talks to the core in the main process over the protocol. From src/ it
// takes only what runs anywhere: the pure Markdown modules, the protocol's messages, wire, document mirror, and change
// math, the command list, the git log parser, and the agent log's pure modules (the log is kept and drawn here); dialogs, the history and collaboration views and the forge's types, the screen, the search and tree views, and the platform contract only for their types. Never node:, gi://,
// or a port, and nothing that reaches the runtime for its values (see "Views do not act" above).
const renderer = join(root, 'electron', 'renderer');
const RENDERER_VALUES = t => t.startsWith('markdown/')
    || ['app/protocol/messages.ts', 'app/protocol/wire.ts', 'app/protocol/mirror.ts', 'app/protocol/changes.ts', 'app/commands.ts', 'gitlog.ts',
    'agent/trace.ts', 'agent/tracefeed.ts', 'agent/tracetree.ts', 'agent/logrows.ts'].includes(t);
const RENDERER_TYPES = t => RENDERER_VALUES(t) || ['app/protocol/screen.ts', 'app/protocol/search.ts', 'app/protocol/tree.ts', 'app/protocol/preferences.ts', 'app/protocol/schema.ts', 'app/protocol/chat.ts', 'app/protocol/history.ts', 'app/protocol/collab.ts', 'forge/types.ts', 'app/dialogs.ts', 'platform/index.ts'].includes(t);
const rendererFiles = readdirSync(renderer, { recursive: true }).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).map(f => f.split('\\').join('/'));
for (const file of rendererFiles) {
    const text = readFileSync(join(renderer, file), 'utf8');
    for (const m of text.matchAll(IMPORT)) {
        const spec = m[2] ?? m[3] ?? m[4];
        const where = `electron/renderer/${file}: imports ${spec}`;
        if (spec.startsWith('node:') || spec.startsWith('gi://') || GJS_BUILTINS.has(spec)) {
            errors.push(`${where} (the renderer is a browser page: no Node, GI, or GJS built-ins)`);
            continue;
        }
        if (!spec.startsWith('.')) continue;   // npm packages
        const path = normalize(join(renderer, dirname(file), spec.split('?')[0]));
        if (!relative(renderer, path).startsWith('..')) continue;   // the renderer's own files
        const target = relative(src, path).split('\\').join('/').replace(/\.js$/, '.ts');
        if (target.startsWith('..')) errors.push(`${where} (the renderer imports only its own files and the shared parts of src/)`);
        else if (m[1] ? !RENDERER_TYPES(target) : !RENDERER_VALUES(target)) {
            errors.push(`${where} (from src/ the renderer takes ${m[1] ? 'types only from markdown/, app/protocol/, app/commands.ts, app/dialogs.ts, and platform/index.ts' : 'values only from markdown/, app/protocol/ messages, wire, mirror, and changes, and app/commands.ts; import other types with `import type`'})`);
        } else if (!m[1] && acts(target)) {
            errors.push(`${where} (it reaches the runtime; the renderer gets that work from the main process over the protocol)`);
        }
    }
}

for (const file of GI_ALLOWED) {
    if (!files.includes(file)) errors.push(`scripts/layers.mjs: GI_ALLOWED lists ${file}, which no longer exists; remove the entry`);
    else if (!giImporters.has(file)) errors.push(`scripts/layers.mjs: src/${file} no longer imports gi://; remove it from GI_ALLOWED`);
}

// ---------- Cyclomatic complexity ----------
//
// McCabe, counted like ESLint's `complexity` rule: 1 + if, ?:, &&, ||, ??, &&=, ||=, ??=, a case with a test, for,
// for-in, for-of, while, do-while, catch. A nested function (callback, arrow) is counted on its own.
// Optional chaining and default parameters are not counted.
const MAX_COMPLEXITY = 15;
// Exceptions, as 'path name': complexity. Empty since every function that was above the limit when it was
// introduced has been split. An entry may not grow and has to go once its function is at or below the limit.
const COMPLEXITY_ALLOWED = {};

const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'StaticBlock']);
const BRANCH = new Set(['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause']);
const LOGICAL = new Set(['&&', '||', '??', '&&=', '||=', '??=']);
const keyName = key => key?.type === 'Identifier' || key?.type === 'PrivateIdentifier' ? key.name : key?.type === 'Literal' ? String(key.value) : '[computed]';
const text = (source, node) => source.slice(node.start, node.end).split('\n')[0];

// A readable, stable name: Class.method, the variable or property it is assigned to, or the call it is passed to.
function functionName(node, parents, source) {
    const parent = parents.at(-1);
    const owner = parents.findLast(p => (p.type === 'ClassDeclaration' || p.type === 'ClassExpression') && p.id);
    const cls = owner ? `${owner.id.name}.` : '';
    if (node.type === 'StaticBlock') return `${cls}static{}`;
    if (node.id) return `${cls}${node.id.name}`;
    if (parent.type === 'MethodDefinition') return `${cls}${parent.kind === 'constructor' ? 'constructor' : keyName(parent.key)}`;
    if (parent.type === 'PropertyDefinition') return `${cls}${keyName(parent.key)}`;
    if (parent.type === 'VariableDeclarator') return `${cls}${keyName(parent.id)}`;
    if (parent.type === 'Property') return `${cls}${keyName(parent.key)}`;
    if (parent.type === 'AssignmentExpression') return text(source, parent.left).replace(/^this\./, '').slice(0, 50);
    if (parent.type === 'CallExpression' || parent.type === 'NewExpression') return `(callback of ${text(source, parent.callee).slice(0, 40)})`;
    return '(anonymous)';
}

// How much a node adds to the complexity of the function it is in: 1 for a decision, otherwise 0.
const decisions = node =>
    BRANCH.has(node.type) || node.type === 'SwitchCase' && !!node.test
    || (node.type === 'LogicalExpression' || node.type === 'AssignmentExpression') && LOGICAL.has(node.operator) ? 1 : 0;

// The child nodes of an ESTree node, in source order.
function* children(node) {
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') yield child; }
        else if (value && typeof value.type === 'string') yield value;
    }
}

function complexities(file, source) {
    const found = [];
    const visit = (node, parents, current) => {
        if (FUNCTION.has(node.type)) {
            current = { name: functionName(node, parents, source), line: source.slice(0, node.start).split('\n').length, cc: 1 };
            found.push(current);
        } else if (current) {
            current.cc += decisions(node);
        }
        parents.push(node);
        for (const child of children(node)) visit(child, parents, current);
        parents.pop();
    };
    visit(parseAst(source, { lang: /\.tsx?$/.test(file) ? 'ts' : 'js' }, file), [], null);
    return found;
}

const scripts = join(root, 'scripts');
const checked = [
    ...files.map(f => [`src/${f}`, join(src, f)]),
    ...readdirSync(scripts).filter(f => /\.(ts|mjs)$/.test(f) && !f.endsWith('.d.ts')).map(f => [`scripts/${f}`, join(scripts, f)]),
];
const seen = new Map();
let functions = 0;
for (const [name, path] of checked) {
    for (const fn of complexities(name, readFileSync(path, 'utf8'))) {
        functions++;
        const key = `${name} ${fn.name}`;
        const allowed = COMPLEXITY_ALLOWED[key];
        if (allowed !== undefined) seen.set(key, Math.max(seen.get(key) ?? 0, fn.cc));
        if (fn.cc > Math.max(MAX_COMPLEXITY, allowed ?? 0)) {
            errors.push(`${name}:${fn.line}: ${fn.name} has cyclomatic complexity ${fn.cc} (limit ${allowed ?? MAX_COMPLEXITY}${allowed ? ', may not grow' : ''}); split it into smaller functions`);
        }
    }
}
for (const [key, allowed] of Object.entries(COMPLEXITY_ALLOWED)) {
    const now = seen.get(key);
    if (now === undefined) errors.push(`scripts/layers.mjs: COMPLEXITY_ALLOWED lists ${key}, which no longer exists; remove the entry`);
    else if (now <= MAX_COMPLEXITY) errors.push(`scripts/layers.mjs: ${key} is now ${now}, within the limit; remove it from COMPLEXITY_ALLOWED`);
    else if (now < allowed) errors.push(`scripts/layers.mjs: ${key} went down to ${now}; lower its COMPLEXITY_ALLOWED entry from ${allowed}`);
}

if (errors.length) {
    console.error(`Layer and complexity violations:\n  ${errors.join('\n  ')}`);
    process.exit(1);
}
console.log(`Layer rules: ${files.length} modules and ${rendererFiles.length} renderer files checked, ${GI_ALLOWED.size} core modules still on gi://, ${UI_ACTS_ALLOWED.size} views still acting; complexity: ${functions} functions within ${MAX_COMPLEXITY} or their allowance`);
