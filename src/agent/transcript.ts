// A conversation with the assistant as a plain Markdown file (pure), so the history can be
// opened in the editor, searched, and diffed like a manuscript:
//
//   ---
//   title: "Contradiction in Raka's age"
//   model: deepseek-flash
//   created: 2026-10-04T14:20:00
//   ---
//
//   ## You
//   Is there a contradiction in Raka's age?
//
//   ## Assistant
//   Yes. In `chapter-01.md:12` …
//
// The assistant's own answer may contain a "## You" line; such a line gets a backslash
// in front of it when saved and the backslash is removed when read.

import { parseEvents, type ActionEvent } from './journal';
import type { WorkState } from './work';
import { parseWork } from './work';
import type { Turn } from './context';

export interface SavedChat {
    layout?: 'chat';
    title: string;
    model: string;
    created: string;   // local ISO without a zone, e.g. 2026-10-04T14:20:00
    turns: Turn[];
    events?: ActionEvent[];
    work?: WorkState | null;
}

const HEADINGS: Record<Turn['role'], string> = { user: 'You', assistant: 'Assistant' };
const MARKER = /^(\\*)## (You|Assistant)[ \t]*$/;
const TITLE_MAX = 60;

const escapeLine = (line: string): string => MARKER.test(line) ? `\\${line}` : line;
const unescapeLine = (line: string): string => {
    const m = MARKER.exec(line);
    return m && m[1] ? line.slice(1) : line;
};

// Title from the first question: the first line, whitespace collapsed, truncated.
export function titleFrom(question: string): string {
    const first = question.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
    if (!first) return 'Conversation';
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

// File name: date + simplified title, e.g. "2026-10-04-contradiction-in-rakas-age.md".
export function chatFileName(created: string, title: string): string {
    const slug = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    return `${created.slice(0, 10)}-${slug || 'conversation'}.md`;
}

export function serializeChat(chat: SavedChat): string {
    const head = ['---', `title: ${JSON.stringify(chat.title)}`, `model: ${chat.model}`, `created: ${chat.created}`, '---'];
    if (chat.layout === 'chat') head.splice(4, 0, 'layout: chat');
    if (chat.work) head.splice(4, 0, `work: ${JSON.stringify(chat.work)}`);
    if (chat.events?.length) head.splice(head.length - 1, 0, `actions: ${JSON.stringify(chat.events)}`);
    const body = chat.turns.map(t => `## ${HEADINGS[t.role]}\n${t.content.replace(/\n+$/, '').split('\n').map(escapeLine).join('\n')}`);
    return `${head.join('\n')}\n\n${body.join('\n\n')}\n`;
}

// An explicit chat layout can represent an empty session; unmarked files need conversation content.
export function parseChat(text: string): SavedChat | null {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const { meta, start } = parseFrontmatter(lines);
    const turns = parseTurns(lines.slice(start));
    const work = parseSavedWork(meta.work);
    const events = parseSavedEvents(meta.actions);
    const chatLayout = meta.layout === 'chat';
    if (!turns.length && !work && !events.length && !chatLayout) return null;
    return {
        ...(chatLayout ? { layout: 'chat' as const } : {}),
        title: parseTitle(meta.title) || titleFrom(turns.find(t => t.role === 'user')?.content ?? ''),
        model: meta.model ?? '',
        created: meta.created ?? '',
        turns,
        ...(work ? { work } : {}),
        ...(events.length ? { events } : {}),
    };
}

// "key: value" lines between the opening and closing ---; start = the first line after them (0 without frontmatter).
function parseFrontmatter(lines: string[]): { meta: Record<string, string>; start: number } {
    const meta: Record<string, string> = {};
    const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    if (end <= 0) return { meta, start: 0 };
    for (const line of lines.slice(1, end)) {
        const m = /^([a-z]+):\s*(.*)$/.exec(line);
        if (m) meta[m[1]] = m[2];
    }
    return { meta, start: end + 1 };
}

// The turns under "## You" and "## Assistant" headings; text before the first heading is ignored.
function parseTurns(lines: string[]): Turn[] {
    const turns: Turn[] = [];
    let current: { role: Turn['role']; lines: string[] } | null = null;
    const close = () => {
        if (current) turns.push({ role: current.role, content: current.lines.join('\n').replace(/^\n+|\n+$/g, '') });
    };
    for (const line of lines) {
        const m = MARKER.exec(line);
        if (m && !m[1]) {
            close();
            current = { role: m[2] === 'You' ? 'user' : 'assistant', lines: [] };
        } else {
            current?.lines.push(unescapeLine(line));
        }
    }
    close();
    return turns;
}

// The saved work plan, validated again: a file edited by hand must not bring in a state the app would not produce.
function parseSavedWork(raw: string | undefined): WorkState | null {
    let work: WorkState | null = null;
    try {
        const a = JSON.parse(raw ?? 'null');
        if (!a) return null;
        work = parseWork(JSON.stringify({ goal: a.goal, steps: a.steps.map((s: any) => ({ text: s.text, status: s.status })), note: a.note }));
        if (!work) return null;
        if (Number.isInteger(a.actionStart) && a.actionStart >= 0) work.actionStart = a.actionStart;
        const verification = savedVerification(a.verification);
        if (verification) work.verification = verification;
        const status = savedStatus(a.status, work);
        if (status) work.status = status;
    } catch { /* Broken metadata does not block the conversation text. */ }
    return work;
}

// A verification is kept only if every check is well formed; it passes only with at least one check, all passed.
function savedVerification(v: any): WorkState['verification'] | null {
    if (!v || typeof v.passed !== 'boolean' || !Array.isArray(v.checks)) return null;
    const checks = v.checks.filter((c: any) => c && typeof c.file === 'string' && typeof c.label === 'string' && typeof c.passed === 'boolean');
    if (checks.length !== v.checks.length) return null;
    return { passed: checks.length > 0 && checks.every((c: any) => c.passed), checks };
}

// A run that was still going is paused when reopened; "complete" stands only with a passed verification and all steps done.
function savedStatus(status: unknown, work: WorkState): WorkState['status'] | null {
    if (status !== 'running' && status !== 'paused' && status !== 'failed' && status !== 'complete') return null;
    const unfinished = status === 'complete' && (!work.verification?.passed || !work.steps.every(s => s.status === 'done'));
    return status === 'running' || unfinished ? 'paused' : status;
}

function parseSavedEvents(raw: string | undefined): ActionEvent[] {
    try { return parseEvents(JSON.parse(raw ?? '[]')); } catch { return []; /* A broken journal is skipped. */ }
}

// A JSON-quoted title; a broken one (edited by hand) gives '' so the first question is used instead.
function parseTitle(raw: string | undefined): string {
    const title = raw ?? '';
    try {
        return title.startsWith('"') ? JSON.parse(title) : title;
    } catch (e) {
        return '';
    }
}
