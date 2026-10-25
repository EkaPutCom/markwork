// Checks the window's code against the rules of docs/design/ui.md ("What the guard checks"): colors only as tokens,
// controls only from ui/, text sizes only from the scale, inline style only for computed values, icon buttons only as
// IconButton, and none of the old theme.css classes that imitate a primitive. Run by `npm run test:core:node`.
//
// The old code does not follow the rules yet, so each file is held to a baseline (scripts/ui-baseline.json): it may
// have fewer findings of a rule than its baseline, never more, and a file not in the baseline has none. A line that
// breaks a rule on purpose says why in a comment on it or on the line above: `ui-allow: <reason>`.
//
//   node scripts/ui.mjs            check; exits 1 and lists every violation
//   node scripts/ui.mjs --update   lower the baseline to the counts now (it never raises one)
//   node scripts/ui.mjs --print    print the counts now, as the baseline file holds them

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';   // the oxc parser that Vite 8 already ships, as scripts/layers.mjs uses

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(root, 'electron', 'renderer');
const baselinePath = join(root, 'scripts', 'ui-baseline.json');

// What each rule means, for the report.
const RULES = {
    'color': 'a color value; use a token of globals.css (ui.md "Color")',
    'raw-element': 'a raw control; use the primitive from ui/ (ui.md "Primitives")',
    'font-size': 'a text size in px; use the scale (ui.md "Type")',
    'constant-style': 'an inline style of constants only; put it in a class (ui.md "Inline style")',
    'icon-button': 'a Button of an icon size; use IconButton (ui.md "Tooltip and title")',
    'old-class': 'a class of the old set in theme.css; use the primitive (ui.md "theme.css")',
};

const RAW = new Set(['button', 'input', 'select', 'textarea']);
const OLD_CLASSES = new Set(['button', 'flat', 'suggested', 'circular', 'icon-button', 'entry', 'chip', 'popover', 'dialog', 'check', 'radio', 'switch']);
const ICON_SIZES = new Set(['icon', 'icon-sm', 'icon-xs']);
const HUES = 'white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
// A color written in a string: #rgb … #rrggbbaa standing alone or in brackets, a color function, or a Tailwind class of
// its palette (`text-white`, `bg-red-500/50`).
const STRING_COLOR = new RegExp(`(^|[\\s(\\[,'"])#[0-9a-fA-F]{3,8}(?![\\w-])|\\b(rgba?|hsla?|oklch|oklab|lab|lch)\\(|\\b(bg|text|border|ring|fill|stroke|outline|from|via|to|shadow|decoration|divide|accent|caret|placeholder)-(${HUES})(-\\d{2,3})?\\b`);
const STRING_FONT_PX = /\btext-\[\d+(\.\d+)?px\]/;
// In CSS, a color inside a declaration's value; named colors only as whole words.
const CSS_COLOR = new RegExp(`#[0-9a-fA-F]{3,8}(?![\\w-])|\\b(rgba?|hsla?|oklch|oklab|lab|lch)\\(|(^|[\\s,(])(${HUES}|grey|silver|navy|maroon|olive|aqua|fuchsia|lime)(?=$|[\\s,);!])`);
const ALLOW = /ui-allow:/;

// ---------- Files ----------

function rendererFiles() {
    return readdirSync(renderer, { recursive: true })
        .map(f => f.split('\\').join('/'))
        .filter(f => /\.(tsx?|css)$/.test(f) && !f.endsWith('.d.ts') && f !== 'styles/globals.css');
}

// The line of an offset, 1-based.
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

// Whether a line, or the one above it, says why it may break a rule.
const allowed = (lines, line) => ALLOW.test(lines[line - 1] ?? '') || ALLOW.test(lines[line - 2] ?? '');

// ---------- CSS ----------

// The CSS with its comments blanked out, newlines kept so offsets still give the right line.
const stripCssComments = css => css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));

function checkCss(source, report) {
    const lines = source.split('\n');
    const css = stripCssComments(source);
    for (const m of css.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
        const [, property, value] = m;
        const line = lineAt(css, m.index);
        if (allowed(lines, line)) continue;
        if (CSS_COLOR.test(value)) report('color', line, `${property}: ${value.trim()}`);
        if (/^(font-size|font)$/.test(property) && /(?<![\d./])\d+(\.\d+)?px/.test(value)) report('font-size', line, `${property}: ${value.trim()}`);   // a line height after / is not a size
    }
}

// ---------- TypeScript and TSX ----------

// The child nodes of an ESTree node, in source order.
function* children(node) {
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') yield child; }
        else if (value && typeof value.type === 'string') yield value;
    }
}

function* walk(node) {
    yield node;
    for (const child of children(node)) yield* walk(child);
}

// The text of a string node: a literal's value or a template piece's cooked text.
function stringOf(node) {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateElement') return node.value.cooked ?? node.value.raw;
    return null;
}

// Every class name written in the strings under a node (a className's value, a classList call's arguments).
function classNamesUnder(node) {
    const names = [];
    for (const n of walk(node)) {
        const text = stringOf(n);
        if (text !== null) names.push(...text.split(/\s+/).filter(Boolean));
    }
    return names;
}

const attributeName = attribute => attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' ? attribute.name.name : null;

// The string value of a JSX attribute: size="icon" or size={'icon'}.
function attributeString(attribute) {
    const value = attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : attribute.value;
    return value ? stringOf(value) : null;
}

// Whether an expression is a constant: a literal, a template without expressions, a negative number.
function constant(node) {
    if (node.type === 'Literal') return true;
    if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
    if (node.type === 'UnaryExpression') return constant(node.argument);
    return false;
}

// The object of style={{…}} or style={{…} as CSSProperties}, if it is one.
function styleObject(attribute) {
    let expression = attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : null;
    while (expression && (expression.type === 'TSAsExpression' || expression.type === 'TSSatisfiesExpression')) expression = expression.expression;
    return expression?.type === 'ObjectExpression' ? expression : null;
}

function checkStyle(attribute, report) {
    const object = styleObject(attribute);
    if (!object || object.properties.length === 0) return;
    if (object.properties.every(p => p.type === 'Property' && !p.shorthand && constant(p.value))) report('constant-style', attribute.start, 'style={{…}}');
}

function checkOpeningElement(node, file, report) {
    const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
    const inUi = file.startsWith('ui/');
    if (!inUi && RAW.has(name)) report('raw-element', node.start, `<${name}>`);
    for (const attribute of node.attributes) {
        const key = attributeName(attribute);
        if (key === 'className') checkClasses(attribute, report);
        else if (key === 'style') checkStyle(attribute, report);
        else if (key === 'size' && name === 'Button' && !inUi && ICON_SIZES.has(attributeString(attribute))) report('icon-button', node.start, `<Button size="${attributeString(attribute)}">`);
    }
}

function checkClasses(node, report) {
    for (const name of classNamesUnder(node)) if (OLD_CLASSES.has(name)) report('old-class', node.start, `class "${name}"`);
}

// A widget in lib/ sets classes without JSX: el.className = '…', el.classList.add('…'), { className: '…' }, or the
// string arguments of a helper of its own (`button('button flat', …)`); document.createElement('button') is a member
// call, so a tag name is not taken for a class.
function classSetter(node) {
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.property.name === 'className') return node.right;
    if (node.type === 'Property' && node.key.type === 'Identifier' && node.key.name === 'className') return node.value;
    const callee = node.type === 'CallExpression' ? node.callee : null;
    if (callee?.type === 'Identifier') return { list: node.arguments.filter(a => stringOf(a) !== null) };
    const isClassList = callee?.type === 'MemberExpression' && callee.object.type === 'MemberExpression' && callee.object.property.name === 'classList';
    return isClassList && ['add', 'toggle', 'replace'].includes(callee.property.name) ? { list: node.arguments } : null;
}

function checkStrings(node, report) {
    const text = stringOf(node);
    if (text === null) return;
    const color = STRING_COLOR.exec(text);
    if (color) report('color', node.start, `"${color[0].trim()}"`);
    const size = STRING_FONT_PX.exec(text);
    if (size) report('font-size', node.start, `"${size[0]}"`);
}

function checkScript(source, file, report) {
    const program = parseAst(source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file);
    for (const node of walk(program)) {
        checkStrings(node, report);
        if (node.type === 'JSXOpeningElement') { checkOpeningElement(node, file, report); continue; }
        const setter = file.endsWith('.ts') ? classSetter(node) : null;
        if (setter) for (const part of setter.list ?? [setter]) checkClasses(part, report);
    }
}

// ---------- Counting ----------

// The findings in one file, as [rule, line, what] lists.
function findingsOf(file) {
    const source = readFileSync(join(renderer, file), 'utf8');
    const lines = source.split('\n');
    const found = [];
    const css = file.endsWith('.css');
    const report = (rule, at, what) => {
        const line = css ? at : lineAt(source, at);
        if (css || !allowed(lines, line)) found.push([rule, line, what]);
    };
    if (css) checkCss(source, report);
    else checkScript(source, file, report);
    return found;
}

// The counts per file and rule, sorted, without empty entries: the shape of the baseline file.
function countsOf(findings) {
    const counts = {};
    for (const [file, list] of [...findings].sort(([a], [b]) => a.localeCompare(b))) {
        for (const [rule] of list) {
            counts[file] ??= {};
            counts[file][rule] = (counts[file][rule] ?? 0) + 1;
        }
    }
    return counts;
}

function readBaseline() {
    try { return JSON.parse(readFileSync(baselinePath, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

// The baseline with every count lowered to the one now; files and rules at zero go.
function lowered(baseline, counts) {
    const next = {};
    for (const [file, rules] of Object.entries(baseline)) {
        for (const [rule, allowedCount] of Object.entries(rules)) {
            const now = Math.min(allowedCount, counts[file]?.[rule] ?? 0);
            if (now > 0) (next[file] ??= {})[rule] = now;
        }
    }
    return next;
}

function compare(findings, counts, baseline) {
    const errors = [];
    for (const [file, rules] of Object.entries(counts)) {
        for (const [rule, now] of Object.entries(rules)) {
            const limit = baseline[file]?.[rule] ?? 0;
            if (now <= limit) continue;
            const where = findings.get(file).filter(([r]) => r === rule).map(([, line, what]) => `\n      ${line}: ${what}`).join('');
            errors.push(`electron/renderer/${file}: ${now} × ${RULES[rule]} (baseline ${limit}):${where}`);
        }
    }
    for (const [file, rules] of Object.entries(baseline)) {
        for (const [rule, limit] of Object.entries(rules)) {
            const now = counts[file]?.[rule] ?? 0;
            if (now < limit) errors.push(`electron/renderer/${file}: ${rule} went down from ${limit} to ${now}; lower the baseline with \`node scripts/ui.mjs --update\``);
        }
    }
    return errors;
}

const files = rendererFiles();
const findings = new Map(files.map(f => [f, findingsOf(f)]));
const counts = countsOf(findings);
const baseline = readBaseline();

const listFilter = process.argv.includes('--list') ? process.argv[process.argv.indexOf('--list') + 1] ?? '' : null;
if (listFilter !== null) {
    for (const [file, list] of findings) {
        if (file.includes(listFilter)) for (const [rule, line, what] of list) console.log(`electron/renderer/${file}:${line}: ${rule}: ${what}`);
    }
} else if (process.argv.includes('--print')) {
    console.log(JSON.stringify(counts, null, 4));
} else if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, JSON.stringify(lowered(baseline, counts), null, 4) + '\n');
    console.log(`UI baseline lowered to the counts now (${baselinePath.slice(root.length + 1)})`);
} else {
    const errors = compare(findings, counts, baseline);
    if (errors.length) {
        console.error(`UI rule violations (docs/design/ui.md):\n  ${errors.join('\n  ')}`);
        process.exit(1);
    }
    const total = Object.values(baseline).flatMap(Object.values).reduce((a, b) => a + b, 0);
    console.log(`UI rules: ${files.length} renderer files checked; ${total} old findings left in the baseline`);
}
