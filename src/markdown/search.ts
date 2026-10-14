// Search and replace across several documents (the Search panel in the sidebar). Pure string → data functions.

export interface SearchOptions {
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
}

export interface SearchHit {
    line: number;          // 0-based
    start: number;         // UTF-16 offsets inside the whole line
    end: number;
    before: string;        // the line cut around the match, for display
    match: string;
    after: string;
}

export interface FileHits {
    file: string;
    hits: SearchHit[];
}

export interface SearchResult {
    files: FileHits[];
    total: number;         // hits found (the list stops at `limit`)
    truncated: boolean;
}

export const MAX_HITS = 1000;
const CONTEXT = 48;        // characters kept on each side of a match

// The pattern for a query, or an error message when a regular expression is invalid. Empty query: null.
export function buildPattern(query: string, options: SearchOptions): RegExp | { error: string } | null {
    if (!query) return null;
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bounded = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
    try {
        return new RegExp(bounded, `gmu${options.caseSensitive ? '' : 'i'}`);
    } catch (e) {
        return { error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e) };
    }
}

function snippet(line: string, start: number, end: number): Pick<SearchHit, 'before' | 'match' | 'after'> {
    const lead = line.length - line.trimStart().length;
    const from = Math.max(lead, start - CONTEXT);
    const to = Math.min(line.length, end + CONTEXT);
    return {
        before: (from > lead ? '…' : '') + line.slice(from, start),
        match: line.slice(start, end),
        after: line.slice(end, to).trimEnd() + (to < line.length ? '…' : ''),
    };
}

// Matches of one document, line by line (a match never spans lines).
function hitsIn(text: string, pattern: RegExp, room: number): SearchHit[] {
    const hits: SearchHit[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < room; i++) {
        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        pattern.lastIndex = 0;
        for (let m = pattern.exec(line); m && hits.length < room; m = pattern.exec(line)) {
            if (m[0].length === 0) { pattern.lastIndex++; continue; }
            hits.push({ line: i, start: m.index, end: m.index + m[0].length, ...snippet(line, m.index, m.index + m[0].length) });
        }
    }
    return hits;
}

export function searchFiles(files: readonly { name: string; text: string }[], pattern: RegExp, limit = MAX_HITS): SearchResult {
    const result: SearchResult = { files: [], total: 0, truncated: false };
    for (const file of files) {
        if (result.total >= limit) { result.truncated = true; break; }
        const hits = hitsIn(file.text, pattern, limit - result.total);
        if (!hits.length) continue;
        result.files.push({ file: file.name, hits });
        result.total += hits.length;
    }
    return result;
}

// Replace every match in `text`. With a regular expression the replacement may use $1, $&, and so on; otherwise it is literal.
export function replaceMatches(text: string, pattern: RegExp, replacement: string, regex: boolean): { text: string; count: number } {
    let count = 0;
    const lines = text.split('\n').map(raw => {
        const cr = raw.endsWith('\r');
        const line = cr ? raw.slice(0, -1) : raw;
        pattern.lastIndex = 0;
        const replaced = line.replace(pattern, (...args: unknown[]) => {
            const matched = args[0] as string;
            if (matched.length === 0) return matched;
            count++;
            return regex ? expand(replacement, args) : replacement;
        });
        return cr ? `${replaced}\r` : replaced;
    });
    return { text: lines.join('\n'), count };
}

// $&, $1..$99, $<name>, and $$ the way String.replace understands them, for a match found in `replacer` form.
function expand(template: string, args: unknown[]): string {
    const groupsAt = typeof args[args.length - 1] === 'object' ? args.length - 1 : -1;
    const groups = groupsAt >= 0 ? args[groupsAt] as Record<string, string> : undefined;
    const captures = args.slice(1, groupsAt >= 0 ? groupsAt - 2 : args.length - 2) as (string | undefined)[];
    return template.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, token: string) => {
        if (token === '$') return '$';
        if (token === '&') return args[0] as string;
        if (token.startsWith('<')) return groups?.[token.slice(1, -1)] ?? '';
        const n = Number(token);
        return n >= 1 && n <= captures.length ? captures[n - 1] ?? '' : all;
    });
}

// ---------- Files to include and exclude ----------

const GLOB_CHARS = /[.+^${}()|[\]\\]/g;

// One glob as a regular expression over a path relative to the folder. A pattern without a slash ("*.md", "drafts")
// matches a file name or a folder name at any depth; one with a slash ("agenda/**") is anchored at the folder.
// A folder pattern also covers everything inside it. `*` stays within a folder, `**` crosses folders.
function globRegExp(glob: string): RegExp {
    const anchored = glob.includes('/');
    const body = glob.replace(/^\.?\//, '').replace(/\/$/, '/**')
        .replace(GLOB_CHARS, '\\$&')
        .replace(/\*\*\/?/g, m => m.endsWith('/') ? '(?:.*/)?' : '.*')
        .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return new RegExp(anchored ? `^${body}(?:/.*)?$` : `^(?:.*/)?${body}(?:/.*)?$`, 'i');
}

const patterns = (text: string): RegExp[] => text.split(',').map(p => p.trim()).filter(Boolean).map(globRegExp);

// The test for a file path, or null when both fields are empty. Excluding wins over including.
export function pathFilter(include: string, exclude: string): ((path: string) => boolean) | null {
    const yes = patterns(include), no = patterns(exclude);
    if (!yes.length && !no.length) return null;
    return path => (!yes.length || yes.some(r => r.test(path))) && !no.some(r => r.test(path));
}

// How many of the two fields hold a pattern, for the summary line.
export const activeFilters = (include: string, exclude: string): number =>
    [include, exclude].filter(text => patterns(text).length > 0).length;
