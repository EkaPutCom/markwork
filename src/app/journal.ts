// The daily journal and the activity log behind it: opening today's journal, quick capture, the end-of-day
// summary through the Assistant, and recording work activity (cards, agent changes, harness runs).

import { readTextFile, writeTextFile, flushWrites, fileExists, insideName } from '../files.js';
import { platform } from '../platform/index.js';
import { commitsBetween } from '../git.js';
import { readActivity, recordActivity } from '../activity.js';
import type { HomeJournal } from './home.js';
import { localDate } from '../markdown/home.js';
import { activityLines, addNote, boardEvents, clock, commitActivity, journalName, journalStats, mergeActivity, newJournal, type Activity, type ActivityKind } from '../markdown/journal.js';
import type { Board } from '../markdown/kanban.js';
import { _, fmt } from '../i18n.js';
import type { Prompt } from './dialogs.js';
import { docFor, errorMessage, type Doc, type DocumentHost } from './document.js';

// What the journal needs from the Assistant: whether it is working, and a way to ask it something.
export interface JournalChat {
    readonly busy: boolean;
    ask(question: string): Promise<void>;
}

// The quick capture question ("Add to Journal"); null = cancelled.
export interface JournalDialogs {
    capture(prompt: Prompt): Promise<string | null>;
}

export interface JournalHost extends DocumentHost {
    readonly chat: JournalChat;
    write(path: string, text: string): boolean;   // shows an error dialog on failure
    refreshTree(): void;
    refreshHome(): void;
    projectName(path: string | null): string | null;
    showChat(): void;
}

export class JournalController {
    // dialogs: the frontend's quick capture dialog; tests replace it with an immediate answer.
    constructor(private readonly host: JournalHost, public dialogs: JournalDialogs) {}

    private path(date: string): string | null {
        const root = this.host.root();
        return root ? platform().paths.join(root, ...journalName(date).split('/')) : null;
    }

    // Journal title, e.g. "Thursday, October 8, 2026", by the system locale like the date on Home.
    private title(date: string): string {
        const [y, m, d] = date.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }

    // Record work activity to the work folder's daily log; without a work folder there is no journal, so it is skipped.
    record(kind: ActivityKind, text: string, time = Math.floor(Date.now() / 1000)): void {
        const root = this.host.root();
        if (root) recordActivity(root, { time, kind, text });
    }

    // Board changes (in the work folder) → card activity.
    recordBoard(file: string | null, before: Board, after: Board): void {
        const root = this.host.root();
        const name = root && file ? insideName(root, file) : null;
        if (!name) return;
        for (const text of boardEvents(before, after, name)) this.record('card', text);
    }

    // Ctrl+Alt+J: open today's journal (created from the template if missing), then fill in the Activity section.
    // Returns the Promise of filling in the activity (for tests), or null if the journal cannot be opened.
    open(now = new Date()): Promise<void> | null {
        const date = localDate(now);
        const path = this.path(date);
        if (!path) {
            this.host.toast(_('Open a work folder first to write a journal'));
            return null;
        }
        if (!docFor(this.host, path) && !fileExists(path)) {
            platform().fs.makeDirs(platform().paths.dirname(path), 0o755);
            if (!this.host.write(path, newJournal(this.title(date)))) return null;
            this.host.refreshTree();
        }
        if (!this.host.openInTab(path)) return null;
        return this.fillActivity(this.host.active(), date);
    }

    // Merge that day's activity (log + git commits) into the Activity section of the journal open in `doc`.
    // Only lines that are not there yet are added, as a single undo step.
    private async fillActivity(doc: Doc, date: string): Promise<void> {
        const root = this.host.root(), path = doc.file;
        if (!root || !path) return;
        const [y, m, d] = date.split('-').map(Number);
        const since = Math.floor(new Date(y, m - 1, d).getTime() / 1000), until = Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000);
        const commits = await commitsBetween(root, since, until);
        // git runs in the background: the tab may already have been closed or switched to another file.
        if (!this.host.docs().includes(doc) || doc.file !== path) return;
        const events: Activity[] = [...readActivity(root, date), ...commits.map(c => ({ time: c.time, kind: 'commit' as const, text: commitActivity(c.short, c.subject) }))];
        const text = doc.editor.getText();
        const next = mergeActivity(text, activityLines(events));
        if (next !== text) doc.editor.replaceText(next);
    }

    // Ctrl+Shift+J: record one line in today's journal without leaving the document being worked on.
    capture(): void {
        if (!this.host.root()) {
            this.host.toast(_('Open a work folder first to write a journal'));
            return;
        }
        const prompt = { title: _('Add to Journal'), label: _('Recorded in today\'s journal with the current time.'), accept: _('Add') };
        void this.dialogs.capture(prompt).then(note => { if (note) this.addNote(note); });
    }

    // An open journal is changed through its editor (one undo step); one that is not open is written directly to disk.
    addNote(note: string, now = new Date()): boolean {
        const date = localDate(now);
        const path = this.path(date);
        if (!path) return false;
        const doc = docFor(this.host, path);
        try {
            if (doc) doc.editor.replaceText(addNote(doc.editor.getText(), clock(now), note));
            else {
                flushWrites(path);
                const text = fileExists(path) ? readTextFile(path) : newJournal(this.title(date));
                platform().fs.makeDirs(platform().paths.dirname(path), 0o755);
                writeTextFile(path, addNote(text, clock(now), note));
                this.host.refreshTree();
            }
        } catch (e) {
            this.host.toast(fmt(_('Failed to write the journal: {error}'), { error: errorMessage(e) }));
            return false;
        }
        this.host.toast(_('Recorded in today\'s journal'));
        this.host.refreshHome();
        return true;
    }

    // Close the day: open the journal, then ask the Assistant to propose a summary. The proposal is still reviewed in the
    // review window like any other agent change; nothing is written without approval.
    // Returns the Promise of the question to the Assistant (for tests), or null if it did not run.
    summarize(): Promise<void> | null {
        const chat = this.host.chat;
        if (chat.busy) {
            this.host.toast(_('The Assistant is working; wait until it finishes'));
            return null;
        }
        const filling = this.open();
        if (!filling) return null;
        const name = this.host.projectName(this.host.active().file);
        this.host.showChat();
        return filling.then(() => chat.ask(
            `Close the day: read the journal ${name} (the active document), then propose a short summary under the heading "## Summary" with insert_text: ` +
            'what was finished, what got in the way, and what continues tomorrow. Use only the contents of the journal and the files it links; do not change other sections.'));
    }

    // Today's journal row on Home.
    summary(root: string, date: string): HomeJournal | null {
        const path = this.path(date)!;
        const doc = docFor(this.host, path);
        let text: string | null = null;
        try {
            text = doc ? doc.editor.getText() : fileExists(path) ? readTextFile(path) : null;
        } catch (e) {
            // unreadable: shown as not written yet
        }
        return { exists: text !== null, notes: text ? journalStats(text).notes : 0, activity: readActivity(root, date).length };
    }
}
