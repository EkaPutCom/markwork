// A diff laid out the way VS Code shows one: line numbers read from the hunk headers, a removed line paired with the line
// that replaced it, and inside such a pair the words that changed. Side by side puts the old text left and the new right,
// with an empty filler where one side has no line; inline keeps one column with both line numbers.

// The shape of base/gitlog's DiffLine, restated: markdown/ takes nothing from outside it.
type DiffKind = 'add' | 'del' | 'hunk' | 'context';
interface DiffLine { kind: DiffKind; text: string }

export interface DiffSpan { text: string; changed: boolean }

// One side of a row. number is null where the lines carry no hunk header to count from (a caption such as "Fields").
export interface DiffCell { kind: Exclude<DiffKind, 'hunk'>; number: number | null; spans: DiffSpan[] }

export type SideRow = { kind: 'hunk'; text: string } | { kind: 'line'; left: DiffCell | null; right: DiffCell | null };

export type InlineRow = { kind: 'hunk'; text: string }
    | { kind: Exclude<DiffKind, 'hunk'>; old: number | null; new: number | null; spans: DiffSpan[] };

const HUNK = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)/;
const MAX_TOKENS = 400;   // past this a pair is marked as a whole: the word diff is quadratic

// The text of a line without its marker; "\ No newline at end of file" is not a line of the file.
const body = (l: DiffLine) => l.kind === 'hunk' ? l.text : /^[-+ ]/.test(l.text) ? l.text.slice(1) : l.text;
const isNote = (l: DiffLine) => l.kind === 'context' && l.text.startsWith('\\');

const tokens = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];

// The words of two lines, each marked changed when it is not in their longest common sequence.
export function wordDiff(before: string, after: string): [DiffSpan[], DiffSpan[]] {
    const a = tokens(before), b = tokens(after);
    if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return [[{ text: before, changed: true }], [{ text: after, changed: true }]];
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const left: DiffSpan[] = [], right: DiffSpan[] = [];
    const push = (spans: DiffSpan[], text: string, changed: boolean) => {
        const last = spans[spans.length - 1];
        if (last && last.changed === changed) last.text += text; else spans.push({ text, changed });
    };
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { push(left, a[i++], false); push(right, b[j++], false); }
        else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) push(right, b[j++], true);
        else push(left, a[i++], true);
    }
    return [left, right];
}

const whole = (text: string): DiffSpan[] => [{ text, changed: false }];

// The lines split into hunk captions and runs: context lines one by one, and each block of removed lines with the added
// lines that follow it, paired in order.
type Run = { kind: 'hunk'; text: string } | { kind: 'context'; old: number | null; new: number | null; text: string }
    | { kind: 'change'; dels: DiffCell[]; adds: DiffCell[] };

function header(text: string): { old: number | null; new: number | null; text: string } {
    const m = HUNK.exec(text);
    return m ? { old: Number(m[2]), new: Number(m[3]), text: m[1] } : { old: null, new: null, text };
}

const next = (n: number | null) => n === null ? null : n + 1;

function runs(lines: DiffLine[]): Run[] {
    const out: Run[] = [];
    let old: number | null = null, now: number | null = null;
    for (const l of lines) {
        if (isNote(l)) continue;
        if (l.kind === 'hunk') { const h = header(l.text); old = h.old; now = h.new; out.push({ kind: 'hunk', text: h.text }); continue; }
        if (l.kind === 'context') { out.push({ kind: 'context', old, new: now, text: body(l) }); old = next(old); now = next(now); continue; }
        let last = out[out.length - 1];
        if (last?.kind !== 'change' || (l.kind === 'del' && last.adds.length)) { last = { kind: 'change', dels: [], adds: [] }; out.push(last); }
        if (l.kind === 'del') { last.dels.push({ kind: 'del', number: old, spans: whole(body(l)) }); old = next(old); }
        else { last.adds.push({ kind: 'add', number: now, spans: whole(body(l)) }); now = next(now); }
    }
    for (const r of out) if (r.kind === 'change') markWords(r.dels, r.adds);
    return out;
}

function markWords(dels: DiffCell[], adds: DiffCell[]): void {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++)
        [dels[k].spans, adds[k].spans] = wordDiff(dels[k].spans[0].text, adds[k].spans[0].text);
}

export function sideBySide(lines: DiffLine[]): SideRow[] {
    const rows: SideRow[] = [];
    for (const r of runs(lines)) {
        if (r.kind === 'hunk') rows.push(r);
        else if (r.kind === 'context') rows.push({ kind: 'line', left: { kind: 'context', number: r.old, spans: whole(r.text) }, right: { kind: 'context', number: r.new, spans: whole(r.text) } });
        else for (let k = 0; k < Math.max(r.dels.length, r.adds.length); k++) rows.push({ kind: 'line', left: r.dels[k] ?? null, right: r.adds[k] ?? null });
    }
    return rows;
}

export function inline(lines: DiffLine[]): InlineRow[] {
    const rows: InlineRow[] = [];
    for (const r of runs(lines)) {
        if (r.kind === 'hunk') rows.push(r);
        else if (r.kind === 'context') rows.push({ kind: 'context', old: r.old, new: r.new, spans: whole(r.text) });
        else {
            for (const c of r.dels) rows.push({ kind: 'del', old: c.number, new: null, spans: c.spans });
            for (const c of r.adds) rows.push({ kind: 'add', old: null, new: c.number, spans: c.spans });
        }
    }
    return rows;
}
