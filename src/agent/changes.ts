// File changes proposed by the agent. Pure TypeScript without GTK: this module only validates proposals and
// computes their results; it never writes anything. Applying them to disk or the editor is done by the window after
// the user approves the diff (ui/chat.ts), so the model never changes files on its own.

import { matchMention, type SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';
import { NOTE_TOOLS, planNote, planSchema, type Planned } from './notechanges.js';

export interface Change {
    kind: 'create' | 'edit' | 'delete' | 'move';
    file: string;      // path relative to the project folder (for move: the source path)
    before: string;    // previous contents ('' for a new file)
    after: string;     // contents after the change is applied ('' for delete; same as before for move)
    reason: string;    // the model's reason, shown on the approval card
    to?: string;       // move only: the destination path
}

export const MAX_NEW_FILE_CHARS = 100_000;
const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

export const CHANGE_TOOLS: ToolSpec[] = [
    {
        name: 'create_file',
        description: 'Propose a new Markdown file in the work folder (e.g. notes, plans, a research summary). It is not written right away: the user sees the contents and then applies or rejects it. Fails if the name is already taken.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Relative path in the work folder, e.g. "plans/october.md" (folders are created if needed; dot files are not allowed)' },
                content: { type: 'string', description: 'The full contents of the file in Markdown' },
                reason: { type: 'string', description: 'One sentence: what this file is for' },
            },
            required: ['name', 'content', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'edit_file',
        description: 'Propose replacing a piece of text in an existing file. old_text must be exactly as in the file (read it first with read_file). By default old_text must appear exactly once (add surrounding lines if needed); with all=true every occurrence is replaced, e.g. renaming a name or date throughout the file. It is not written right away: the user sees the diff and then applies or rejects it.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                old_text: { type: 'string', description: 'The text being replaced, exactly as written (without line numbers)' },
                new_text: { type: 'string', description: 'Replacement for old_text; empty means deleting it' },
                all: { type: 'boolean', description: 'true = replace all occurrences (default false: there must be exactly one)' },
                reason: { type: 'string', description: 'One sentence: why this change' },
            },
            required: ['name', 'old_text', 'new_text', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'insert_text',
        description: 'Propose inserting new text into an existing file without replacing anything: at the start (after the frontmatter if there is one), at the end, or after a given line. For after_line, line_text must contain the contents of that line as returned by read_file (without the number) as a safeguard against miscounting. It is not written right away: the user sees the diff and then applies or rejects it.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                position: { type: 'string', enum: ['start', 'end', 'after_line'] },
                line: { type: 'integer', description: 'after_line only: the line number (from 1) the new text follows' },
                line_text: { type: 'string', description: 'after_line only: the contents of that line, to make sure the number is correct' },
                text: { type: 'string', description: 'The Markdown text to insert (one or more lines)' },
                reason: { type: 'string', description: 'One sentence: why this change' },
            },
            required: ['name', 'position', 'text', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'delete_file',
        description: 'Propose moving a Markdown file to the Trash (the user can recover it). Only if the user asked for it or the file is clearly a duplicate/obsolete. It is not carried out right away: the user sees the contents and then applies or rejects it.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                reason: { type: 'string', description: 'One sentence: why this file is being removed' },
            },
            required: ['name', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'move_file',
        description: 'Propose renaming or moving a Markdown file to another path in the work folder (folders are created if needed). The contents do not change; links in other files are not updated, so propose that change separately if needed. Fails if the destination already exists.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                destination: { type: 'string', description: 'The new relative path, e.g. "archive/meeting-oct-1.md"' },
                reason: { type: 'string', description: 'One sentence: why it is being moved' },
            },
            required: ['name', 'destination', 'reason'],
            additionalProperties: false,
        },
    },
    ...NOTE_TOOLS,
];

export const isChangeTool = (name: string): boolean => CHANGE_TOOLS.some(t => t.name === name);

export type PlanResult =
    | { ok: true; change: Change }
    | { ok: false; message: string; summary: string };   // message goes back to the model; summary is shown in the interface

const fail = (message: string, summary: string): PlanResult => ({ ok: false, message, summary });
const asText = (v: unknown): string => typeof v === 'string' ? v : '';

// New file name: relative, without "..", without dot segments (hidden from the tree and not read by the assistant).
export function cleanNewName(raw: string): string | null {
    let name = raw.trim().replace(/^\.\//, '');
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return null;
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
    if (!MARKDOWN_EXTENSION.test(name)) name += '.md';
    return name;
}

// Turn a tool call into a Change, or an error message the model can use to fix its proposal.
export function planChange(name: string, rawArguments: string, files: SourceFile[]): PlanResult {
    const args = parseArguments(rawArguments);
    if (!args) return fail('The arguments are not a valid JSON object.', 'invalid arguments');
    const reason = asText(args.reason).trim();
    if (name === 'create_file') return planCreate(args, reason, files);

    const plan = lookup(EXISTING_FILE_TOOLS, name);
    if (!plan) return fail(`Tool "${name}" is not recognized.`, 'unknown tool');
    const raw = asText(args.name);
    if (!raw.trim()) return fail('The "name" argument is required.', 'empty name');
    const file = matchMention(raw, files);
    if (!file) return fail(`File "${raw}" was not found. Call list_files to see the existing names${name === 'edit_file' || name === 'insert_text' ? ', or use create_file for a new file' : ''}.`, 'file not found');
    return plan({ args, reason, file, files, edit: after => editResult(file, after, reason) });
}

// What a tool that works on an existing file gets: its arguments, the file, and `edit` for a contents change.
interface FileTarget {
    args: Record<string, unknown>;
    reason: string;
    file: SourceFile;
    files: SourceFile[];
    edit: (after: string) => PlanResult;
}

const EXISTING_FILE_TOOLS: Record<string, (t: FileTarget) => PlanResult> = {
    edit_file: planEdit,
    insert_text: planInsert,
    delete_file: ({ file, reason }) => ({ ok: true, change: { kind: 'delete', file: file.name, before: file.text, after: '', reason } }),
    move_file: planMove,
    edit_note: ({ args, file, edit }) => fromPlanned(planNote(args, file.name, file.text), edit),
    edit_schema: ({ args, file, edit }) => fromPlanned(planSchema(args, file.name, file.text), edit),
};

// The result of a note or schema plan as a PlanResult.
const fromPlanned = (planned: Planned, edit: (after: string) => PlanResult): PlanResult =>
    planned.ok ? edit(planned.after) : fail(planned.message, planned.summary);

// A handler from a table by a name the model chose; never an inherited property such as "toString".
const lookup = <T>(table: Record<string, T>, key: string): T | undefined => Object.hasOwn(table, key) ? table[key] : undefined;

function parseArguments(rawArguments: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(rawArguments || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

const editResult = (file: SourceFile, after: string, reason: string): PlanResult => after === file.text
    ? fail('Nothing changed.', 'no change')
    : { ok: true, change: { kind: 'edit', file: file.name, before: file.text, after, reason } };

function planCreate(args: Record<string, unknown>, reason: string, files: SourceFile[]): PlanResult {
    const raw = asText(args.name);
    const file = cleanNewName(raw);
    if (!file) return fail(`The name "${raw}" is not valid. Use a relative path without "..", without a leading dot or "/".`, 'invalid name');
    const taken = files.find(f => f.name.toLowerCase() === file.toLowerCase());
    if (taken) return fail(`File "${taken.name}" already exists. Use edit_file to change it, or choose another name.`, 'already exists');
    const text = asText(args.content);
    if (!text.trim()) return fail('The "content" argument is required.', 'empty content');
    if (text.length > MAX_NEW_FILE_CHARS) return fail('The content is too long for a single proposed file. Split it into several files.', 'too long');
    return { ok: true, change: { kind: 'create', file, before: '', after: text.endsWith('\n') ? text : `${text}\n`, reason } };
}

function planEdit({ args, file, edit }: FileTarget): PlanResult {
    const oldText = asText(args.old_text);
    if (!oldText) return fail('The "old_text" argument is required (the exact piece being replaced).', 'empty old_text');
    const count = file.text.split(oldText).length - 1;
    if (!count) return fail(`old_text was not found in ${file.name}. Re-read that part with read_file and copy it exactly, without line numbers.`, 'text does not match');
    const all = args.all === true;
    if (count > 1 && !all) return fail(`old_text appears ${count} times in ${file.name}. Extend it with surrounding lines until it is unique, or use all=true if every occurrence really has to be replaced.`, 'not unique');
    const newText = asText(args.new_text);
    if (newText === oldText) return fail('new_text is the same as old_text; nothing changes.', 'no change');
    if (all) return edit(file.text.split(oldText).join(newText));
    const at = file.text.indexOf(oldText);
    return edit(file.text.slice(0, at) + newText + file.text.slice(at + oldText.length));
}

function planInsert({ args, file, edit }: FileTarget): PlanResult {
    const text = asText(args.text).replace(/\n+$/, '');
    if (!text.trim()) return fail('The "text" argument is required.', 'empty text');
    const lines = file.text ? file.text.split('\n') : [];
    // A trailing blank line is just the end of the file, not a line that can be followed.
    const count = file.text.endsWith('\n') ? lines.length - 1 : lines.length;
    // A file without a newline at the end gets one only if the text is added at its end.
    const insertAt = (index: number): PlanResult => edit([...lines.slice(0, index), ...text.split('\n'), ...lines.slice(index)].join('\n') + (index === count && count === lines.length ? '\n' : ''));
    const position = asText(args.position);
    if (position === 'start') {
        const front = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(file.text);
        return insertAt(front ? front[0].replace(/\n$/, '').split('\n').length : 0);
    }
    if (position === 'end') return insertAt(count);
    if (position !== 'after_line') return fail('The "position" argument must be one of: start, end, after_line.', 'invalid position');
    const line = checkLine(args, file.name, lines, count);
    return typeof line === 'number' ? insertAt(line) : line;
}

// after_line: the line number must exist and its contents must match line_text, a guard against miscounting.
function checkLine(args: Record<string, unknown>, name: string, lines: string[], count: number): number | PlanResult {
    const line = typeof args.line === 'number' && Number.isInteger(args.line) ? args.line : 0;
    if (line < 1 || line > count) return fail(`The "line" argument must be 1–${count} for ${name}.`, 'invalid line');
    const wanted = args.line_text;
    if (typeof wanted !== 'string') return fail('The "line_text" argument is required for after_line: copy the contents of that line from read_file.', 'empty line_text');
    const actual = lines[line - 1];
    if (actual.trim() === wanted.trim()) return line;
    const near = lines.map((l, i) => l.trim() === wanted.trim() ? i + 1 : 0).filter(n => n).slice(0, 5);
    const hint = near.length ? ` line_text is on ${near.length === 1 ? 'line' : 'lines'} ${near.join(', ')}.` : ' Re-read the file with read_file.';
    return fail(`Line ${line} in ${name} contains "${actual.slice(0, 200)}", not line_text.${hint}`, 'line does not match');
}

function planMove({ args, reason, file, files }: FileTarget): PlanResult {
    const rawTarget = asText(args.destination);
    const to = cleanNewName(rawTarget);
    if (!to) return fail(`The destination "${rawTarget}" is not valid. Use a relative path without "..", without a leading dot or "/".`, 'invalid destination');
    if (to === file.name) return fail('The destination is the same as the current name.', 'no change');
    const taken = files.find(f => f.name.toLowerCase() === to.toLowerCase() && f !== file);
    if (taken) return fail(`File "${taken.name}" already exists; choose another destination.`, 'destination already exists');
    return { ok: true, change: { kind: 'move', file: file.name, to, before: file.text, after: file.text, reason } };
}

export function describeChange(c: Change): string {
    switch (c.kind) {
        case 'create': return `New file ${c.file}`;
        case 'delete': return `Delete ${c.file}`;
        case 'move': return `Move ${c.file} → ${c.to}`;
        default: return `Edit ${c.file}`;
    }
}

// ---------- File state relative to proposals ----------

// Paths touched by a change; a move touches the source and the destination.
export const changeFiles = (c: Change): string[] => c.kind === 'move' && c.to ? [c.file, c.to] : [c.file];

// Apply a change to the in-memory file list (the agent's copy of the manuscript); does not touch the disk.
export function applyToFiles(files: SourceFile[], c: Change): void {
    const index = files.findIndex(f => f.name === c.file);
    if (c.kind === 'delete' || c.kind === 'move') {
        if (index >= 0) files.splice(index, 1);
        if (c.kind === 'move' && c.to) files.push({ name: c.to, text: c.after });
    } else if (index >= 0) files[index].text = c.after;
    else files.push({ name: c.file, text: c.after });
}

// The inverse of an applied change, for the Undo button. Applying it still goes through the same preflight.
export function invertChange(c: Change): Change {
    const reason = `Undo: ${c.reason}`;
    switch (c.kind) {
        case 'create': return { kind: 'delete', file: c.file, before: c.after, after: '', reason };
        case 'delete': return { kind: 'create', file: c.file, before: '', after: c.before, reason };
        case 'move': return { kind: 'move', file: c.to ?? c.file, to: c.file, before: c.after, after: c.before, reason };
        default: return { kind: 'edit', file: c.file, before: c.after, after: c.before, reason };
    }
}

type Reader = (file: string) => string | null;   // null = the file does not exist

// Whether the actual contents equal the state before or after the change.
export function changeState(c: Change, read: Reader): 'before' | 'after' | 'other' {
    const at = read(c.file);
    switch (c.kind) {
        case 'create': return at === c.after ? 'after' : at === null ? 'before' : 'other';
        case 'delete': return at === null ? 'after' : at === c.before ? 'before' : 'other';
        case 'move': {
            const target = c.to ? read(c.to) : null;
            if (at === null && target === c.after) return 'after';
            return at === c.before && target === null ? 'before' : 'other';
        }
        default: return at === c.after ? 'after' : at === c.before ? 'before' : 'other';
    }
}

// Error message if the change can no longer be applied safely (contents changed since it was proposed), or null.
export function preflight(c: Change, read: Reader): string | null {
    const at = read(c.file);
    if (c.kind === 'create') return at === null ? null : `${c.file} already exists`;
    if (at === null) return `${c.file} no longer exists`;
    if (at !== c.before) return `${c.file} changed since it was proposed; ask for a new proposal`;
    if (c.kind === 'move' && c.to && read(c.to) !== null) return `${c.to} already exists`;
    return null;
}

// ---------- Diff preview ----------

// ---------- Diff ----------

interface Op {
    sign: ' ' | '-' | '+';
    text: string;
}

const MAX_LCS_CELLS = 4_000_000;

const splitLines = (text: string): string[] => text ? text.replace(/\n$/, '').split('\n') : [];

// Line diff: the common prefix and suffix are trimmed, the middle part is compared with LCS so that
// separate changes (e.g. a kanban card moving lists) do not show up as a single delete-add block.
// A middle part too large for LCS falls back to a single delete block followed by an add block.
function diffOps(before: string, after: string): Op[] {
    const a = splitLines(before), b = splitLines(after);
    const { head, tail } = commonEnds(a, b);
    return [
        ...a.slice(0, head).map(text => ({ sign: ' ' as const, text })),
        ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
        ...a.slice(a.length - tail).map(text => ({ sign: ' ' as const, text })),
    ];
}

// The number of equal lines at the start (head) and, after that, at the end (tail) of a and b.
function commonEnds(a: string[], b: string[]): { head: number; tail: number } {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { head, tail };
}

// The changed middle part: through LCS, or one delete block and one add block if it is empty on one side or too large.
function middleOps(ma: string[], mb: string[]): Op[] {
    const n = ma.length, m = mb.length;
    if (!n || !m || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
        return [...ma.map(text => ({ sign: '-' as const, text })), ...mb.map(text => ({ sign: '+' as const, text }))];
    }
    return walkLcs(ma, mb, lcsTable(ma, mb));
}

// lcs[i * (m + 1) + j] = LCS length of ma[i..] and mb[j..]
function lcsTable(ma: string[], mb: string[]): Int32Array {
    const n = ma.length, m = mb.length, w = m + 1;
    const lcs = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    return lcs;
}

// Follow the LCS table from the start: equal lines are kept; otherwise delete first, then add (like git).
function walkLcs(ma: string[], mb: string[], lcs: Int32Array): Op[] {
    const n = ma.length, m = mb.length, w = m + 1;
    const ops: Op[] = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && ma[i] === mb[j]) { ops.push({ sign: ' ', text: ma[i] }); i++; j++; }
        else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) ops.push({ sign: '-', text: ma[i++] });
        else ops.push({ sign: '+', text: mb[j++] });
    }
    return ops;
}

interface Hunk {
    oldStart: number;   // starting line number (1-based; 0 if empty)
    oldCount: number;
    newStart: number;
    newCount: number;
    ops: Op[];
}

// Group changes into hunks with `context` lines around them; nearby hunks are merged.
function hunksOf(ops: Op[], context: number): Hunk[] {
    const changed = ops.map((o, i) => o.sign === ' ' ? -1 : i).filter(i => i >= 0);
    if (!changed.length) return [];
    const ranges: [number, number][] = [];
    for (const i of changed) {
        const from = Math.max(0, i - context), to = Math.min(ops.length, i + context + 1);
        const last = ranges[ranges.length - 1];
        if (last && from <= last[1]) last[1] = to;
        else ranges.push([from, to]);
    }
    return ranges.map(([from, to]) => {
        const slice = ops.slice(from, to);
        const before = ops.slice(0, from);
        const oldBefore = before.filter(o => o.sign !== '+').length, newBefore = before.filter(o => o.sign !== '-').length;
        const oldCount = slice.filter(o => o.sign !== '+').length, newCount = slice.filter(o => o.sign !== '-').length;
        return { oldStart: oldCount ? oldBefore + 1 : oldBefore, oldCount, newStart: newCount ? newBefore + 1 : newBefore, newCount, ops: slice };
    });
}

// Git-style diff for the review window: hunks with 3 lines of context. Empty if there is no difference.
export function unifiedDiff(before: string, after: string, context = 3): string {
    return hunksOf(diffOps(before, after), context).map(h =>
        [`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, ...h.ops.map(o => `${o.sign}${o.text}`)].join('\n')).join('\n');
}

export interface DiffLine {
    sign: ' ' | '+' | '-' | '…';
    text: string;
}

export interface DiffPreview {
    lines: DiffLine[];
    added: number;
    removed: number;
}

const CONTEXT_LINES = 2;
const MAX_PREVIEW_LINES = 60;

// Short summary: the number of added/removed lines and the lines themselves (2 lines of context, truncated if long).
export function diffPreview(before: string, after: string): DiffPreview {
    const ops = diffOps(before, after);
    const hunks = hunksOf(ops, CONTEXT_LINES);
    const lines: DiffLine[] = [];
    hunks.forEach((h, i) => {
        if (i > 0 || h.oldStart > 1) lines.push({ sign: '…', text: '' });
        lines.push(...h.ops.map(o => ({ sign: o.sign, text: o.text })));
    });
    const last = hunks[hunks.length - 1];
    if (last && last.oldStart + last.oldCount - 1 < splitLines(before).length) lines.push({ sign: '…', text: '' });
    if (lines.length > MAX_PREVIEW_LINES) {
        const hidden = lines.length - MAX_PREVIEW_LINES;
        lines.length = MAX_PREVIEW_LINES;
        lines.push({ sign: '…', text: `${hidden} more lines` });
    }
    return { lines, added: ops.filter(o => o.sign === '+').length, removed: ops.filter(o => o.sign === '-').length };
}
