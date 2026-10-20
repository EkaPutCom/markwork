// Structure checks of a Markdown document to verify agent output: tables whose cell count does not match,
// empty or level-skipping headings, unclosed code blocks, and a list of local links. Pure.
// Each issue has a `key` without a line number, so an old issue that merely shifted lines is not treated as new.

import { ESCAPE_OR_CODE, RE, startsTable } from './syntax.js';
import { splitRow, tableEnd } from './table.js';

export interface Issue {
    line: number;   // 1-based
    key: string;    // issue identity without a line number
    text: string;   // for the model and user to read
}

export interface LocalLink {
    line: number;
    target: string;   // path as is, without #anchor or ?query, already decoded
}

// One pass per document: frontmatter and code blocks are skipped, tables/headings/links are collected together.
// Verified documents can be book-length and are parsed twice (before/after), so the regex only runs
// on lines that pass a cheap character filter.
export function scanDocument(text: string): { issues: Issue[]; links: LocalLink[] } {
    const scan = new Scanner(text.split('\n'));
    scan.run();
    return { issues: scan.issues, links: scan.links };
}

// The state of one pass: the open code fence and the level of the last heading.
class Scanner {
    readonly issues: Issue[] = [];
    readonly links: LocalLink[] = [];
    private fence: { ch: string; len: number; line: number } | null = null;
    private level = 0;

    constructor(private readonly lines: string[]) {}

    run(): void {
        const lines = this.lines;
        for (let i = bodyStart(lines); i < lines.length; i++) {
            const line = lines[i];
            // A code fence may be indented up to three spaces; looking at the first character after that is enough.
            let indent = 0;
            while (indent < 3 && line.charCodeAt(indent) === 32) indent++;
            const first = line.charAt(indent);
            if (this.codeFence(line, i, first)) continue;
            if (indent === 0 && first === '#' && this.heading(line, i)) continue;
            if (line.includes('|') && startsTable(lines, i)) { i = this.table(i); continue; }
            if (line.includes('](')) collectLinks(line, i, this.links);
        }
        const fence = this.fence;
        if (fence) this.issues.unshift({ line: fence.line + 1, key: `fence:${lines[fence.line].trim()}`, text: `code block opened at line ${fence.line + 1} is not closed` });
    }

    // Opens or closes a code block; true = the line belongs to one (an opening, a closing, or a line inside).
    private codeFence(line: string, i: number, first: string): boolean {
        const m = (first === '`' || first === '~') ? RE.fence.exec(line) : null;
        if (this.fence) {
            if (m && m[2][0] === this.fence.ch && m[2].length >= this.fence.len && !m[3].trim()) this.fence = null;
            return true;
        }
        if (!m || m[2][0] === '`' && m[3].includes('`')) return false;
        this.fence = { ch: m[2][0], len: m[2].length, line: i };
        return true;
    }

    // An ATX heading: empty, or skipping a level after the first heading. false = not a heading after all.
    private heading(line: string, i: number): boolean {
        const h = RE.heading.exec(line);
        if (!h) return false;
        const title = line.slice(h[0].length).replace(/\s+#+\s*$/, '').trim();
        const n = h[1].length;
        if (!title) this.issues.push({ line: i + 1, key: `heading-empty:${n}`, text: `empty heading at line ${i + 1}` });
        // A jump from the start of the document (e.g. straight to ##) is common in notes, so only jumps after the first heading count.
        else if (this.level && n > this.level + 1) this.issues.push({ line: i + 1, key: `heading-skip:${this.level}:${n}:${title}`, text: `heading "${title}" (line ${i + 1}) jumps from H${this.level} to H${n}` });
        this.level = n;
        return true;
    }

    // A table starting at line i: rows whose cell count differs from the header, and its links. Returns its last line.
    private table(i: number): number {
        const lines = this.lines;
        const end = tableEnd(lines, i);
        const columns = splitRow(lines[i]).length;
        const separator = splitRow(lines[i + 1]).length;
        const heading = lines[i].trim().slice(0, 60);
        if (separator !== columns) this.issues.push({ line: i + 2, key: `table-sep:${heading}`, text: `table at line ${i + 1}: header has ${columns} columns, separator has ${separator} columns` });
        for (let r = i + 2; r <= end; r++) {
            const cells = splitRow(lines[r]).length;
            if (cells !== columns) this.issues.push({ line: r + 1, key: `table-row:${heading}:${lines[r].trim().slice(0, 60)}`, text: `table at line ${r + 1}: ${cells} cells, header has ${columns} columns` });
        }
        for (let r = i; r <= end; r++) collectLinks(lines[r], r, this.links);
        return end;
    }
}

// The first line after the frontmatter (0 without one).
function bodyStart(lines: string[]): number {
    if (lines[0] !== '---') return 0;
    const end = lines.indexOf('---', 1);
    return end > 0 ? end + 1 : 0;
}

// Links and images to local paths (not URLs, not just #anchors), outside inline code.
function collectLinks(line: string, index: number, links: LocalLink[]): void {
    if (!line.includes('](')) return;
    const plain = line.replace(ESCAPE_OR_CODE(), m => ' '.repeat(m.length));
    for (const m of plain.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const raw = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('/')) continue;
        let target = raw.replace(/[#?].*$/, '');
        try { target = decodeURIComponent(target); } catch { /* leave as is */ }
        if (target) links.push({ line: index + 1, target });
    }
}

export const structureIssues = (text: string): Issue[] => scanDocument(text).issues;
export const localLinks = (text: string): LocalLink[] => scanDocument(text).links;

// Relative path of a link from file `from` → path relative to the project folder, or null if it leaves the folder.
export function resolveLink(from: string, target: string): string | null {
    const parts = from.split('/').slice(0, -1);
    for (const p of target.split('/')) {
        if (!p || p === '.') continue;
        if (p === '..') { if (!parts.length) return null; parts.pop(); }
        else parts.push(p);
    }
    return parts.join('/');
}

// Issues in `after` that are not in `before` (counted per key, so the same issue twice still counts).
export function newIssues(before: Issue[], after: Issue[]): Issue[] {
    const seen = new Map<string, number>();
    for (const i of before) seen.set(i.key, (seen.get(i.key) ?? 0) + 1);
    return after.filter(i => {
        const n = seen.get(i.key) ?? 0;
        if (n) { seen.set(i.key, n - 1); return false; }
        return true;
    });
}
