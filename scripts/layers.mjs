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
const BASE = ['settings.ts', 'files.ts', 'workspace.ts', 'git.ts', 'gitlog.ts', 'config.ts', 'colors.ts'];

// [files the rule applies to, what they may not import, why]. Targets are src-relative paths of
// local modules or gi:// specifiers.
const rules = [
    [f => f.startsWith('markdown/'), t => t.startsWith('gi://') || !t.startsWith('markdown/'), 'markdown/ only holds string → data functions: no GI, nothing outside markdown/'],
    [f => f.startsWith('agent/'), t => GTK.test(t) || /^(ui|editor|window)\//.test(t) || t === 'window.ts', 'agent/ is free of GTK and knows nothing about the editor, widgets, or the window'],
    [f => f.startsWith('forge/'), t => GTK.test(t) || /^(ui|editor|window|agent)\//.test(t) || t === 'window.ts', 'forge/ talks to Git hosting services: free of GTK and knows nothing about widgets, the editor, the window, or the agent'],
    [f => f.startsWith('editor/'), t => /^(ui|window|agent)\//.test(t) || t === 'window.ts', 'editor/ knows nothing about files, menus, the sidebar, or the agent'],
    [f => f.startsWith('ui/') || f.startsWith('window/') || f === 'actions.ts', t => t === 'window.ts', 'only app.ts composes MainWindow; components and controllers get a host interface'],
    [f => BASE.includes(f), t => /^(ui|editor|agent|window)\//.test(t) || t === 'window.ts', 'base modules do not reach up into the layers above them'],
    [f => f === 'orchestrator.ts' || f === 'orchestratordaemon.ts', t => GTK.test(t) || /^(ui|editor|window)\//.test(t) || t === 'window.ts', 'the orchestrator runs harness processes for window/harness.ts; it uses agent/, markdown/, and base modules, never GTK, widgets, or the window'],
];

const files = readdirSync(src, { recursive: true }).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts')).map(f => f.split('\\').join('/'));
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const errors = [];
for (const file of files) {
    const text = readFileSync(join(src, file), 'utf8');
    for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3];
        let target = spec;
        if (spec.startsWith('.')) {
            target = relative(src, normalize(join(src, dirname(file), spec.split('?')[0]))).split('\\').join('/').replace(/\.js$/, '.ts');
        } else if (!spec.startsWith('gi://')) continue;   // gjs built-ins (system, cairo) and npm packages
        for (const [applies, forbidden, why] of rules) {
            if (applies(file) && forbidden(target)) errors.push(`src/${file}: imports ${spec} (${why})`);
        }
    }
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
console.log(`Layer rules: ${files.length} modules checked; complexity: ${functions} functions within ${MAX_COMPLEXITY} or their allowance`);
