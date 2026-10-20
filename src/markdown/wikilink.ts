// Obsidian-style links between documents: [[Note]], [[Note|other text]], [[folder/Note#Section]].
// Pure: used by the inline parser (highlighting), HTML export, link clicks, and name suggestions while typing [[.
//
// The target is matched against Markdown file names in the project folder without extension and case-insensitively,
// so [[daily note]] finds "Journal/Daily Note.md". A target containing '/' is matched against
// the end of its path. Paths are always relative to the project folder and use '/'.

import { ESCAPE_OR_CODE, RE } from './syntax.js';

export interface WikiLink {
    target: string;    // note name or path, without #section
    heading: string;   // text after '#', '' if absent
    alias: string;     // text after '|', '' if absent
}

// Pattern [[...]] on one line. The contents must not contain '[', ']', or a newline; '\0' is a character
// already masked by the inline parser (inline code).
export const WIKILINK = (): RegExp => /\[\[([^[\]\0\n|]+)(?:\|([^[\]\0\n]*))?\]\]/g;

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;

// Contents between [[ and ]] → its parts.
export function parseWikiLink(inner: string): WikiLink {
    const bar = inner.indexOf('|');
    const ref = bar < 0 ? inner : inner.slice(0, bar);
    const alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
    const hash = ref.indexOf('#');
    return {
        target: (hash < 0 ? ref : ref.slice(0, hash)).trim(),
        heading: hash < 0 ? '' : ref.slice(hash + 1).trim(),
        alias,
    };
}

// Visible text for a link: the alias if present, otherwise the target together with its section.
export const wikiLabel = (link: WikiLink): string =>
    link.alias || [link.target, link.heading].filter(Boolean).join(' › ');

const stem = (path: string): string => path.replace(MARKDOWN_EXT, '');
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fold = (s: string): string => s.normalize('NFC').toLowerCase();

// The project file (relative path) the target points to, or null. `from` = relative path of the document containing the link
// (null for a document outside the project); if several files share the name, the one closest to it wins,
// then the one with the shortest path, like Obsidian.
export function resolveWikiLink(target: string, files: string[], from: string | null): string | null {
    const want = fold(stem(target.trim().replace(/^\.?\//, '')));
    if (!want) return null;
    const hasDir = want.includes('/');
    const matches = files.filter(f => {
        if (!MARKDOWN_EXT.test(f)) return false;
        const s = fold(stem(f));
        return hasDir ? s === want || s.endsWith(`/${want}`) : fold(stem(baseName(f))) === want;
    });
    if (!matches.length) return null;
    const here = from === null ? null : dirName(from);
    const score = (f: string) => {
        const d = dirName(f);
        if (here !== null && d === here) return 0;
        if (here !== null && here.startsWith(d ? `${d}/` : '')) return 1;   // the parent folder of the document
        return 2;
    };
    return matches.sort((a, b) => score(a) - score(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

// Relative path for a new note from a target that does not exist yet, or null if the name is unsafe.
// A target without a folder is created next to the document that links to it; a target with a folder is relative to the project.
export function newNotePath(target: string, from: string | null): string | null {
    const clean = target.trim().replace(/^\.?\//, '');
    const parts = clean.split('/');
    if (!clean || parts.some(p => !p.trim() || p === '.' || p === '..' || p.startsWith('.'))) return null;
    if (/[\0\\:*?"<>|]/.test(clean)) return null;
    const name = MARKDOWN_EXT.test(clean) ? clean : `${clean}.md`;
    if (parts.length > 1) return name;
    const dir = from === null ? '' : dirName(from);
    return dir ? `${dir}/${name}` : name;
}

// The most compact text for linking file `file`: the name without extension if unique in the project,
// otherwise the path without extension.
export function wikiTargetFor(file: string, files: string[]): string {
    const name = fold(stem(baseName(file)));
    const twins = files.filter(f => MARKDOWN_EXT.test(f) && fold(stem(baseName(f))) === name).length;
    return twins > 1 ? stem(file) : stem(baseName(file));
}

// The part being typed after an unclosed [[ in the text before the cursor, or null.
// Suggestions stop after '|' (alias) and '#' (section) because neither is a file name.
export function wikiQuery(beforeCursor: string): string | null {
    const open = beforeCursor.lastIndexOf('[[');
    if (open < 0) return null;
    const typed = beforeCursor.slice(open + 2);
    if (/[[\]|#\n]/.test(typed)) return null;
    // `code` before an unclosed [[: inside inline code there are no links.
    if ((beforeCursor.slice(0, open).match(/`/g)?.length ?? 0) % 2) return null;
    return typed;
}

// Markdown files that match the typed text, most relevant first: name prefix, word prefix,
// then a fragment anywhere in the path. Empty text = all files alphabetically.
export function suggestNotes(query: string, files: string[], limit = 8): string[] {
    const q = fold(query.trim());
    const ranked: [number, string][] = [];
    for (const f of files) {
        if (!MARKDOWN_EXT.test(f)) continue;
        const name = fold(stem(baseName(f)));
        const path = fold(stem(f));
        let rank: number;
        if (!q) rank = 0;
        else if (name.startsWith(q)) rank = 0;
        else if (name.split(/[\s_-]+/).some(w => w.startsWith(q))) rank = 1;
        else if (path.includes(q)) rank = 2;
        else continue;
        ranked.push([rank, f]);
    }
    ranked.sort((a, b) => a[0] - b[0] || baseName(a[1]).localeCompare(baseName(b[1]), 'id', { numeric: true }) || a[1].localeCompare(b[1]));
    return ranked.slice(0, limit).map(r => r[1]);
}

// All [[links]] in the text (outside inline code), without duplicates by target and section, in order of appearance.
export function wikiLinksIn(text: string): WikiLink[] {
    const seen = new Set<string>();
    const out: WikiLink[] = [];
    const plain = text.replace(ESCAPE_OR_CODE(), m => ' '.repeat(m.length));
    for (const m of plain.matchAll(WIKILINK())) {
        const link = parseWikiLink(m[0].slice(2, -2));
        const key = `${fold(link.target)}#${fold(link.heading)}`;
        if (!link.target || seen.has(key)) continue;
        seen.add(key);
        out.push(link);
    }
    return out;
}

// The part of the document under heading `heading` (case-insensitive) up to the next heading of the
// same or higher level, including the heading itself. null if the heading does not exist. Code blocks are skipped.
export function noteSection(text: string, heading: string): string | null {
    const want = fold(heading.trim());
    const lines = text.split('\n');
    let fence = '', start = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
        const f = RE.fence.exec(lines[i]);
        if (f && (!fence || f[2].startsWith(fence))) { fence = fence ? '' : f[2][0].repeat(3); continue; }
        if (fence) continue;
        const h = RE.heading.exec(lines[i]);
        if (!h) continue;
        const n = h[1].length;
        if (start >= 0 && n <= level) return lines.slice(start, i).join('\n').trimEnd();
        if (start < 0 && fold(lines[i].slice(h[0].length).replace(/\s+#+\s*$/, '').trim()) === want) { start = i; level = n; }
    }
    return start < 0 ? null : lines.slice(start).join('\n').trimEnd();
}
