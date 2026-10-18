// Daily journal: one plain Markdown file per day (journal/2026-10-08.md) containing the user's notes
// and the work activity of that day.
//
//   # Thursday, October 8, 2026
//
//   ## Today's focus
//
//   ## Notes
//
//   - 09:12 The reused iter makes opening files ~2x faster      ← quick capture (Ctrl+Shift+J)
//
//   ## Activity
//
//   - 10:42 Card “Release material” → In Progress in [[tasks]]              ← from the activity log and git
//   - 16:05 Commit `dd831a6` Speed up opening…
//
//   ## Summary
//
// Activity (cards moved, agent changes, harness results) is recorded throughout the day to a JSONL log in
// .markwork/activity, then merged into the Activity section when the journal is opened. Merging only adds lines
// that are not there yet, so the user's edits in that section are never overwritten.
//
// Pure TypeScript without GTK. Section titles are document content, not interface text, so they are not translated.

import { cardMeta, type Board } from './kanban.js';

export const JOURNAL_DIR = 'journal';
export const NOTES = 'Notes';
export const ACTIVITY = 'Activity';
const SECTIONS = ['Today\'s focus', NOTES, ACTIVITY, 'Summary'];

// Relative name of the journal file for the date "YYYY-MM-DD".
export const journalName = (date: string): string => `${JOURNAL_DIR}/${date}.md`;

// Date from the relative name of a journal file; null if it is not a journal file.
export function journalDate(name: string): string | null {
    const m = /^journal\/(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    return m ? m[1] : null;
}

// Initial journal contents. title = a human-readable date, composed by the caller according to the locale.
export function newJournal(title: string): string {
    return [`# ${title}`, ...SECTIONS.flatMap(s => ['', `## ${s}`])].join('\n') + '\n';
}

// Local time "HH:MM" for line stamps.
export function clock(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- Sections ----------

interface Span {
    head: number;   // index of the section heading line
    end: number;    // index of the line after the section content (the next heading, or the document length)
}

const FENCE = /^\s*(```|~~~)/;
const TOP_HEADING = /^#{1,2}\s/;

// Section "## <heading>" (case-insensitive); ends at the next level 1–2 heading. Lines inside code blocks are skipped.
function findSection(lines: string[], heading: string): Span | null {
    const want = heading.toLowerCase();
    let fenced = false, head = -1;
    for (let i = 0; i < lines.length; i++) {
        if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
        if (fenced || !TOP_HEADING.test(lines[i])) continue;
        if (head >= 0) return { head, end: i };
        if (/^##\s/.test(lines[i]) && lines[i].slice(3).trim().toLowerCase() === want) head = i;
    }
    return head >= 0 ? { head, end: lines.length } : null;
}

// Index after the last non-blank line in the section (right after the heading if the section is empty).
function lastFilled(lines: string[], span: Span): number {
    let at = span.end;
    while (at > span.head + 1 && !lines[at - 1].trim()) at--;
    return at;
}

// Append a line to the end of the section content; a missing section is created. A new Activity section is placed
// before Summary so the template order is kept; other sections go at the end of the document.
function appendToSection(text: string, heading: string, added: string[]): string {
    if (!added.length) return text;
    const lines = text.split('\n');
    const span = findSection(lines, heading);
    if (!span) {
        const before = heading === ACTIVITY ? findSection(lines, 'Summary') : null;
        const block = [`## ${heading}`, '', ...added, ''];
        if (before) {
            lines.splice(before.head, 0, ...block);
            return lines.join('\n');
        }
        const body = text.replace(/\s+$/, '');
        return `${body ? `${body}\n\n` : ''}${block.join('\n')}`;
    }
    const at = lastFilled(lines, span);
    // Empty section: one blank line after the heading. Afterwards there is always one blank line before the next heading.
    const insert = at === span.head + 1 ? ['', ...added] : added;
    const rest = lines.slice(at);
    const gap = rest.length && rest[0].trim() ? [''] : [];
    return [...lines.slice(0, at), ...insert, ...gap, ...rest].join('\n');
}

// Quick capture: "- HH:MM text" at the end of the Notes section. Newlines in the text are replaced with spaces (one note = one bullet).
export function addNote(text: string, time: string, note: string): string {
    const line = note.replace(/\s*\n\s*/g, ' ').trim();
    return line ? appendToSection(text, NOTES, [`- ${time} ${line}`]) : text;
}

// Add activity lines that are not yet in the Activity section (compared without surrounding whitespace).
export function mergeActivity(text: string, lines: string[]): string {
    const span = findSection(text.split('\n'), ACTIVITY);
    const present = new Set(span ? text.split('\n').slice(span.head + 1, span.end).map(l => l.trim()) : []);
    const seen = new Set<string>();
    const added = lines.filter(l => !present.has(l.trim()) && !seen.has(l) && seen.add(l));
    return appendToSection(text, ACTIVITY, added);
}

export interface JournalStats {
    notes: number;      // bullets in the Notes section
    activity: number;   // bullets in the Activity section
}

export function journalStats(text: string): JournalStats {
    const lines = text.split('\n');
    const count = (heading: string) => {
        const span = findSection(lines, heading);
        return span ? lines.slice(span.head + 1, span.end).filter(l => /^\s*[-*+]\s+\S/.test(l)).length : 0;
    };
    return { notes: count(NOTES), activity: count(ACTIVITY) };
}

// ---------- Activity ----------

export type ActivityKind = 'card' | 'agent' | 'harness' | 'commit';

export interface Activity {
    time: number;       // Unix seconds
    kind: ActivityKind;
    text: string;       // one Markdown line, without the time
}

const KINDS = new Set<string>(['card', 'agent', 'harness', 'commit']);

// One JSONL log line.
export const serializeActivity = (a: Activity): string => JSON.stringify({ time: a.time, kind: a.kind, text: a.text });

// JSONL log contents → activities. Corrupt lines (e.g. truncated writes) are skipped.
export function parseActivity(text: string): Activity[] {
    const out: Activity[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const v = JSON.parse(line) as Partial<Activity>;
            if (typeof v.time === 'number' && typeof v.text === 'string' && v.text && typeof v.kind === 'string' && KINDS.has(v.kind))
                out.push({ time: v.time, kind: v.kind, text: v.text.replace(/\n/g, ' ') });
        } catch {
            // skip
        }
    }
    return out;
}

// Activities → "- HH:MM text" lines in time order (the original order is kept for equal times).
export function activityLines(events: Activity[]): string[] {
    return events
        .map((a, i) => ({ a, i }))
        .sort((x, y) => x.a.time - y.a.time || x.i - y.i)
        .map(({ a }) => `- ${clock(new Date(a.time * 1000))} ${a.text}`);
}

// A [[...]] link to a file relative path without the Markdown extension, so it can be opened with Ctrl+click from the journal.
export const fileLink = (name: string): string => `[[${name.replace(/\.(md|markdown|mdown|mkd)$/i, '')}]]`;

const quote = (title: string): string => `“${title.length > 80 ? `${title.slice(0, 77)}…` : title}”`;

// Board changes worth recording: a card moved columns, a card was checked as done, and a new card.
// Cards are recognized by their text; a card whose text was edited is not recorded (not a work event).
export function boardEvents(before: Board, after: Board, board: string): string[] {
    const where = new Map<string, { column: string; done: boolean | null }[]>();
    for (const column of before.columns)
        for (const card of column.cards) where.set(card.text, [...(where.get(card.text) ?? []), { column: column.title, done: card.done }]);
    const total = (b: Board) => b.columns.reduce((n, c) => n + c.cards.length, 0);
    let added = Math.max(0, total(after) - total(before));
    const link = fileLink(board);
    const events: string[] = [];
    const fresh: string[] = [];
    for (const column of after.columns) {
        for (const card of column.cards) {
            const title = quote(cardMeta(card.text).title);
            const list = where.get(card.text);
            const was = list?.find(w => w.column === column.title) ?? list?.[0];
            if (!was) {
                fresh.push(`New card ${title} in ${column.title.trim()} · ${link}`);
                continue;
            }
            list!.splice(list!.indexOf(was), 1);
            if (was.column !== column.title) events.push(`Card ${title} → ${column.title.trim()} · ${link}`);
            else if (was.done !== true && card.done === true) events.push(`Card ${title} done · ${link}`);
        }
    }
    // A card whose text was edited also looks "new"; only the increase in the number of cards is counted.
    for (const line of fresh.reverse()) if (added-- > 0) events.push(line);
    return events;
}

export interface ChangeSummary {
    kind: 'create' | 'edit' | 'delete' | 'move';
    file: string;
    to?: string;
}

// Agent changes applied by the user → one compact line.
export function agentActivity(changes: ChangeSummary[]): string | null {
    if (!changes.length) return null;
    const verb = (c: ChangeSummary) => c.kind === 'create' ? 'created' : c.kind === 'delete' ? 'removed' : c.kind === 'move' ? 'moved' : 'changed';
    const parts = new Map<string, string[]>();
    for (const c of changes) {
        const target = c.kind === 'move' && c.to ? `${fileLink(c.file)} to ${fileLink(c.to)}` : c.kind === 'delete' ? `\`${c.file}\`` : fileLink(c.file);
        const list = parts.get(verb(c)) ?? [];
        if (!list.includes(target)) list.push(target);
        parts.set(verb(c), list);
    }
    return `Agent ${[...parts].map(([v, files]) => `${v} ${files.join(', ')}`).join('; ')}`;
}

export function commitActivity(hash: string, subject: string): string {
    return `Commit \`${hash}\` ${subject.replace(/\s+/g, ' ').trim()}`;
}

export function harnessActivity(agent: string, title: string, project: string, ok: boolean): string {
    return `${agent} ${ok ? 'finished' : 'failed'} ${quote(title)} in project ${project}`;
}

// The user finished reviewing a card's worktree: its work was merged into the base branch, or thrown away.
export function worktreeActivity(title: string, project: string, outcome: { merged: string } | { discarded: true } | { pull: string }): string {
    if ('pull' in outcome) return `Opened a pull request for ${quote(title)} in project ${project}: ${outcome.pull}`;
    return 'merged' in outcome ? `Merged ${quote(title)} into ${outcome.merged} in project ${project}` : `Discarded the work on ${quote(title)} in project ${project}`;
}
