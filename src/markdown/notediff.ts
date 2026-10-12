// What changed in a note between two versions, in the terms of a note: the frontmatter fields, and the text below them
// line by line. Pure: the caller supplies both versions (null = the file does not exist on that side).

export interface FieldChange { key: string; before: string | null; after: string | null }

export interface TextLine { kind: 'same' | 'add' | 'del'; text: string }

export interface NoteDiff {
    fields: FieldChange[];
    body: TextLine[];
}

// Above this many lines on either side the line diff is skipped (all removed, all added) rather than computed:
// the table is quadratic, and a diff of a book is not something anybody reads line by line.
export const MAX_DIFF_LINES = 2000;

interface Split { fields: Map<string, string>; order: string[]; body: string[] }

// `---` … `---` at the top of the text with one `key: value` per line. Nested YAML is not understood; such lines are
// kept as a key of their own (the whole line), so a change in them still shows.
function split(text: string | null): Split {
    const result: Split = { fields: new Map(), order: [], body: [] };
    if (text === null) return result;
    const lines = text.replace(/\n$/, '').split('\n');
    let start = 0;
    if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) {
            for (const line of lines.slice(1, end)) {
                const colon = line.indexOf(':');
                const key = colon > 0 && !/^\s/.test(line) ? line.slice(0, colon).trim() : line;
                const value = colon > 0 && !/^\s/.test(line) ? line.slice(colon + 1).trim() : '';
                if (!result.fields.has(key)) result.order.push(key);
                result.fields.set(key, value);
            }
            start = end + 1;
        }
    }
    result.body = lines.slice(start);
    return result;
}

function fieldChanges(before: Split, after: Split): FieldChange[] {
    const keys = [...before.order, ...after.order.filter(k => !before.fields.has(k))];
    const changes: FieldChange[] = [];
    for (const key of keys) {
        const a = before.fields.get(key) ?? null, b = after.fields.get(key) ?? null;
        if (a !== b) changes.push({ key, before: a, after: b });
    }
    return changes;
}

// Longest common subsequence over the lines that differ after the shared start and end are set aside.
function lineDiff(a: string[], b: string[]): TextLine[] {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
    const same = (lines: string[]): TextLine[] => lines.map(text => ({ kind: 'same', text }));
    return [...same(a.slice(0, head)), ...middle(midA, midB), ...same(a.slice(a.length - tail))];
}

const removed = (lines: string[]): TextLine[] => lines.map(text => ({ kind: 'del', text }));
const added = (lines: string[]): TextLine[] => lines.map(text => ({ kind: 'add', text }));

// table[i][j] = length of the longest common subsequence of a[i..] and b[j..]
function commonLengths(a: string[], b: string[]): number[][] {
    const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    return table;
}

function middle(a: string[], b: string[]): TextLine[] {
    if (!a.length || !b.length || a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return [...removed(a), ...added(b)];
    const table = commonLengths(a, b);
    const out: TextLine[] = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
        // A removed line comes before the line that replaces it, as in git's own diffs.
        else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1])) out.push({ kind: 'del', text: a[i++] });
        else out.push({ kind: 'add', text: b[j++] });
    }
    return out;
}

export function diffNote(before: string | null, after: string | null): NoteDiff {
    const a = split(before), b = split(after);
    return { fields: fieldChanges(a, b), body: lineDiff(a.body, b.body) };
}

// How many lines were added and removed in the text (not counting the fields).
export function countChanges(diff: NoteDiff): { added: number; removed: number } {
    return { added: diff.body.filter(l => l.kind === 'add').length, removed: diff.body.filter(l => l.kind === 'del').length };
}
