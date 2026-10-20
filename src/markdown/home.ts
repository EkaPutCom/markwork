// Data for the Home page: due dates from kanban boards, unprocessed inbox items, recent files,
// and a time-based greeting. Pure TypeScript; the window reads files and settings.
// The source of truth remains the Markdown files, so there is no index or database that can go stale:
// everything is recomputed every time Home is shown.

import { cardMeta, dueStatus, parseBoard, type Board, type Card, type DueStatus, type Position } from './kanban.js';
import { isList, isStructured } from './layout.js';
import { below } from './paths.js';

export interface HomeFile {
    name: string;    // relative to the work folder
    text: string;
}

export interface Task {
    file: string;           // relative name of the board
    at: Position;
    card: string;           // card text when read, to make sure the card has not changed before writing
    box: boolean;           // the card has a checkbox ("- [ ]"); without it, unchecking restores a plain bullet
    title: string;
    project: string | null;
    due: string;            // "YYYY-MM-DD"
    status: DueStatus;
    days: number;           // day difference from today; negative = overdue
}

// A column whose title looks like this holds finished cards even without checkboxes.
const DONE_COLUMN = /^(done|complete(d)?)$/i;
const DAY = 24 * 60 * 60 * 1000;

const daysBetween = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

// Unfinished cards (of a board, a list, or a table) whose due date is overdue, today, or within the next two days, ordered by due date.
// projectOf determines the card's project name (see cardProject in agent/harness.ts); this layer does not know about it.
export function dueTasks(files: HomeFile[], today: string, projectOf: (board: Board, card: Card) => string | null = () => null): Task[] {
    const tasks: Task[] = [];
    for (const file of files) {
        if (!isStructured(file.text)) continue;
        const board = parseBoard(file.text);
        board.columns.forEach((column, c) => {
            if (DONE_COLUMN.test(column.title.trim())) return;
            column.cards.forEach((card, index) => {
                if (card.done === true) return;
                const meta = cardMeta(card.text);
                if (!meta.due) return;
                const status = dueStatus(meta.due, today);
                if (status === 'later') return;
                tasks.push({
                    file: file.name, at: { column: c, index }, card: card.text, box: card.done === false, title: meta.title,
                    project: projectOf(board, card), due: meta.due, status, days: daysBetween(today, meta.due),
                });
            });
        });
    }
    return tasks.sort((a, b) => a.due.localeCompare(b.due) || a.file.localeCompare(b.file) || a.at.column - b.at.column || a.at.index - b.at.index);
}

export interface InboxCount {
    file: string;
    open: number;    // items that are not checked
}

// Inboxes that still have unprocessed items, the largest first.
export function openInboxes(files: HomeFile[]): InboxCount[] {
    return files
        .filter(f => isList(f.text))
        .map(f => ({ file: f.name, open: parseBoard(f.text).columns.flatMap(c => c.cards).filter(card => card.done !== true).length }))
        .filter(i => i.open > 0)
        .sort((a, b) => b.open - a.open || a.file.localeCompare(b.file));
}

// ---------- Recent files ----------

export interface RecentFile {
    path: string;
    time: number;    // Unix seconds of the last time it was opened
}

export const MAX_RECENT = 30;

// Record a path as the last opened: move it to the front without duplicates.
export function rememberRecent(list: RecentFile[], path: string, time: number, max = MAX_RECENT): RecentFile[] {
    return [{ path, time }, ...list.filter(r => r.path !== path)].slice(0, max);
}

// Replace a path after a file is moved or its parent folder is renamed.
export function moveRecent(list: RecentFile[], from: string, to: string): RecentFile[] {
    return list.map(r => r.path === from ? { ...r, path: to } : below(from, r.path) ? { ...r, path: to + r.path.slice(from.length) } : r);
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export interface RecentSplit {
    resume: RecentFile[];    // "Continue" cards: the latest file from different folders
    others: RecentFile[];    // the rest for the "Recent files" list
}

// Continue cards represent different work places (one per folder), so several files from the
// same folder do not fill all the cards. Files that do not make it into a card show up in the recent list.
export function splitRecent(list: RecentFile[], cards = 4, rows = 6): RecentSplit {
    const resume: RecentFile[] = [];
    const folders = new Set<string>();
    for (const r of list) {
        if (resume.length >= cards) break;
        const folder = parentOf(r.path);
        if (folders.has(folder)) continue;
        folders.add(folder);
        resume.push(r);
    }
    return { resume, others: list.filter(r => !resume.includes(r)).slice(0, rows) };
}

// ---------- Greeting ----------

export type DayPart = 'morning' | 'midday' | 'afternoon' | 'evening';

// Greeting time-of-day split: morning, midday, afternoon, evening.
export function dayPart(hour: number): DayPart {
    if (hour >= 4 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 15) return 'midday';
    if (hour >= 15 && hour < 18) return 'afternoon';
    return 'evening';
}

// Local date "YYYY-MM-DD", the same as the card due date format.
export function localDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
