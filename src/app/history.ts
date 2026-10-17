// The git history in the application layer: the History tab (the commits of the active file, the uncommitted files of its
// repository, the commit form) and the history viewer windows (one commit, or one file's uncommitted changes). The
// controller runs git (git.ts, through platform()) and the commit message writer (agent/commitmessage.ts); the views of a
// frontend only draw what they are sent and report what the user did through their on* actions (docs/design/protocol.md
// 6.5). A path a view sends back is only acted on when it is one the controller showed (4.4).

import { commitContent, commitDiff, commitFile, commitFiles, discardChanges, fileLog, recentSubjects, repoChanges, workingDiff,
    workingState, type GitFailure, type TextResult, type WorkingState } from '../git.js';
import { parseDiff, type ChangeKind, type Commit, type DiffLine, type FileChange } from '../gitlog.js';
import { writeCommitMessage, type CommitSources, type WriteResult } from '../agent/commitmessage.js';
import { Cancellable } from '../cancel.js';
import { fileExists, insideName, readTextFile } from '../files.js';
import { platform } from '../platform/index.js';
import { after, type Awaitable } from '../awaitable.js';
import { _, fmt } from '../i18n.js';
import { docFor, type Doc, type DocumentHost, type TextEditor } from './document.js';

// Commits loaded per request; a long history is loaded incrementally.
export const HISTORY_PAGE = 100;

const FAILURE_TEXT: Record<GitFailure, string> = {
    'no-git': _('git is not installed'),
    'no-repo': _('This file is not in a git repository'),
    'failed': _('The history could not be read'),
};

// The commits shown in the tab. A reload that finds the same commits sends the same list, so the view can keep its rows.
export interface HistoryLog {
    commits: Commit[];
    more: boolean;            // a next page may exist ("Load more")
    note: string;             // shown while the list is empty: loading, not a repository, no commits yet
}

// One uncommitted file of the repository; name is the path relative to the active file's folder (or the work folder).
export interface ChangedFile {
    path: string;
    kind: ChangeKind;
    name: string;
}

export interface HistoryChanges {
    file: string | null;          // the active file
    state: WorkingState | null;   // the active file against the last commit; null = no file, or git could not tell
    changed: ChangedFile[];
}

// What a discard came to: done, declined at the question, or an error to show.
export type DiscardOutcome = 'done' | 'declined' | { error: string };

export interface HistoryTabView {
    // What the user did; the controller sets these.
    onRefresh: () => void;
    onMore: () => void;                                                   // load the next page of commits
    onOpen: (hash: string) => void;                                       // a commit was clicked
    onOpenChanges: (path: string) => void;                                // the uncommitted changes of a file
    onCommit: (files: string[], message: string) => Promise<string | null>;   // an error, or null once committed
    onDiscard: (path: string) => Promise<DiscardOutcome>;
    onWrite: (files: string[]) => Promise<WriteResult>;                   // the assistant writes the message from these files
    onStopWriting: () => void;

    // What the controller shows.
    showLog(log: HistoryLog): void;
    showChanges(changes: HistoryChanges): void;
    messageText(text: string): void;                                      // the message written so far
}

// One viewer window: a commit's changes and the file at that commit, or (commit null) the file's uncommitted changes
// with a commit form.
export interface HistoryViewerSpec {
    file: string;
    commit: Commit | null;
}

// A diff to draw, or a sentence in its place (loading, empty, an error).
export type HistoryText = { lines: DiffLine[] } | { text: string };

// The viewer windows, named by a number the controller gives each one.
export interface HistoryViewersView {
    onCommit: (viewer: number, message: string) => Promise<string | null>;
    onDiscard: (viewer: number) => Promise<DiscardOutcome>;
    onWrite: (viewer: number) => Promise<WriteResult>;
    onStopWriting: (viewer: number) => void;
    onClosed: (viewer: number) => void;                                   // the user closed the window

    open(viewer: number, spec: HistoryViewerSpec): void;
    showDiff(viewer: number, diff: HistoryText): void;
    showContent(viewer: number, text: string): void;                      // the whole file at the commit
    messageText(viewer: number, text: string): void;
    close(viewer: number): void;                                          // done: the commit or discard went through
}

export interface HistoryDialogs {
    // Before the changes of a file are thrown away; viewer = the window it was asked from, null = the History tab.
    discard(kind: ChangeKind, path: string, viewer: number | null): Awaitable<boolean>;
}

export interface HistoryHost<E extends TextEditor = TextEditor> extends DocumentHost<E> {
    readonly historyTab: HistoryTabView;
    readonly historyViewers: HistoryViewersView;
    saveAll(): boolean;           // write the open documents first, so no pending write brings the changes back; false = failed
    fileGone(doc: Doc<E>): void;
    refreshTree(): void;
}

// The model the commit message writer uses: the Assistant's key and model, read when it starts.
export type WriterSources = Pick<CommitSources, 'keyStore' | 'makeProvider' | 'model'>;

const TAB = 0;   // the writer of the tab; viewers are numbered from 1

export class HistoryController<E extends TextEditor = TextEditor> {
    private folder: string | null = null;      // the open folder; source of the changes list when there is no file yet
    private file: string | null | undefined;   // undefined = never shown
    private commits: Commit[] = [];
    private changed: FileChange[] = [];
    private token = 0;                         // stale git results (the file has changed) are ignored
    private viewerCount = 0;
    private readonly viewers = new Map<number, HistoryViewerSpec>();
    private readonly writing = new Map<number, Cancellable>();
    private readonly running = new Set<Promise<unknown>>();   // git reads not answered yet

    constructor(private readonly host: HistoryHost<E>, readonly dialogs: HistoryDialogs, private readonly writer: () => WriterSources) {
        this.connectTab(host.historyTab);
        this.connectViewers(host.historyViewers);
    }

    // Show this file's history. Calling again with the same file and folder does nothing unless force, so it is safe to call often.
    show(file: string | null, folder: string | null = this.folder, force = false): void {
        if (!force && file === this.file && folder === this.folder) return;
        const same = file === this.file;
        this.file = file;
        this.folder = folder;
        this.token++;
        // Reloading the same file does not empty the list first; the list is only replaced if its contents changed.
        if (!same) {
            this.commits = [];
            this.changed = [];
            this.host.historyTab.showChanges({ file, state: null, changed: [] });
            this.showLog(file ? _('Loading…') : _('Save the document to a file, and its git history will show up here'), false);
        }
        if (file) this.track(this.load(0, same));
        this.track(this.loadChanges());
    }

    // Read what is shown again (after a commit, or the window came back to the front).
    refresh(): void {
        if (this.file !== undefined) this.show(this.file, this.folder, true);
    }

    // Resolves once the git reads started so far have answered (tests wait for it before they dispose of a session).
    async settled(): Promise<void> {
        while (this.running.size) await Promise.all(this.running);
    }

    private track(work: Promise<unknown>): void {
        const done = work.catch(() => {}).finally(() => this.running.delete(done));
        this.running.add(done);
    }

    // Git results still being awaited are ignored, and a message being written stops.
    dispose(): void {
        this.token++;
        for (const cancellable of this.writing.values()) cancellable.cancel();
        this.writing.clear();
    }

    // ---------- The tab ----------

    private connectTab(tab: HistoryTabView): void {
        tab.onRefresh = () => this.refresh();
        tab.onMore = () => this.track(this.load(this.commits.length, false));
        tab.onOpen = hash => this.openCommit(hash);
        tab.onOpenChanges = path => this.openChanges(path);
        tab.onCommit = (files, message) => this.commitTab(files, message);
        tab.onDiscard = path => this.discardTab(path);
        tab.onWrite = files => this.write(TAB, this.known(files), text => this.host.historyTab.messageText(text));
        tab.onStopWriting = () => this.stopWriting(TAB);
    }

    private showLog(note: string, more: boolean): void {
        this.host.historyTab.showLog({ commits: [...this.commits], more, note });
    }

    private async load(skip: number, keep: boolean): Promise<void> {
        const token = this.token, file = this.file;
        if (!file) return;
        const result = await fileLog(file, skip, HISTORY_PAGE);
        if (token !== this.token) return;
        if (!result.ok) {
            this.commits = [];
            return this.showLog(FAILURE_TEXT[result.reason], false);
        }
        if (skip === 0) {
            // Reloading a result identical to what is displayed: leave the list (and the pages loaded after it) alone.
            const shown = this.commits.slice(0, result.commits.length);
            if (keep && shown.length === result.commits.length && shown.every((c, i) => c.hash === result.commits[i].hash)) return;
            this.commits = [];
        }
        this.commits.push(...result.commits);
        this.showLog(_('There are no commits for this file yet'), result.commits.length === HISTORY_PAGE);
    }

    // The active file's state (the "uncommitted" button) and every uncommitted file of its repository.
    private async loadChanges(): Promise<void> {
        const token = this.token, file = this.file ?? null;
        const dir = file ? platform().paths.dirname(file) : this.folder;
        if (!dir) {
            this.changed = [];
            return this.host.historyTab.showChanges({ file, state: null, changed: [] });
        }
        const [state, repo] = await Promise.all([file ? workingState(file) : null, repoChanges(dir)]);
        if (token !== this.token) return;
        this.changed = repo.ok ? repo.changes : [];
        const name = (path: string) => insideName(dir, path) ?? path;
        this.host.historyTab.showChanges({
            file,
            state: state?.ok ? state.state : null,
            changed: this.changed.map(c => ({ path: c.path, kind: c.kind, name: name(c.path) })),
        });
    }

    // The files of a request that the tab was shown, in the order of the list.
    private known(files: string[]): string[] {
        return this.changed.filter(c => files.includes(c.path)).map(c => c.path);
    }

    private async commitTab(files: string[], message: string): Promise<string | null> {
        const chosen = this.known(files);
        if (!chosen.length) return _('Select the files to commit');
        return this.commit(message, () => commitFiles(chosen, message.trim()));
    }

    private async discardTab(path: string): Promise<DiscardOutcome> {
        const change = this.changed.find(c => c.path === path);
        if (!change) return { error: _('The file is no longer in the list of changes') };
        return this.discard(change.kind, path, null);
    }

    // ---------- The viewers ----------

    private connectViewers(viewers: HistoryViewersView): void {
        viewers.onCommit = (id, message) => this.commitViewer(id, message);
        viewers.onDiscard = id => this.discardViewer(id);
        viewers.onWrite = id => {
            const spec = this.viewers.get(id);
            if (!spec || spec.commit) return Promise.resolve({ ok: false, reason: 'failed', message: 'there is nothing to describe' });
            return this.write(id, [spec.file], text => this.host.historyViewers.messageText(id, text));
        };
        viewers.onStopWriting = id => this.stopWriting(id);
        viewers.onClosed = id => {
            this.viewers.delete(id);
            this.stopWriting(id);
        };
    }

    private openViewer(spec: HistoryViewerSpec): number {
        const id = ++this.viewerCount;
        this.viewers.set(id, spec);
        this.host.historyViewers.open(id, spec);
        return id;
    }

    // A commit of the active file's history: its changes against its parent and the file as it was.
    openCommit(hash: string): void {
        const commit = this.commits.find(c => c.hash === hash);
        if (!commit || !this.file) return;
        const file = this.file;
        const id = this.openViewer({ file, commit });
        const views = this.host.historyViewers;
        this.track(commitDiff(file, commit).then(result => {
            if (this.viewers.has(id)) views.showDiff(id, this.diffText(result, _('There are no content changes in this commit (for example only a rename)')));
        }));
        this.track(commitContent(file, commit).then(result => {
            if (this.viewers.has(id)) views.showContent(id, result.ok ? result.text : fmt(_('Failed to read the file contents:\n{message}'), { message: result.message }));
        }));
    }

    // A file's uncommitted changes against the last commit, with a form to commit or discard them.
    openChanges(path: string): void {
        if (path !== this.file && !this.changed.some(c => c.path === path)) return;
        const id = this.openViewer({ file: path, commit: null });
        this.track(workingDiff(path).then(result => {
            if (this.viewers.has(id)) this.host.historyViewers.showDiff(id, this.diffText(result, _('There are no uncommitted changes')));
        }));
    }

    private diffText(result: TextResult, empty: string): HistoryText {
        if (!result.ok) return { text: fmt(_('Failed to read the changes:\n{message}'), { message: result.message }) };
        const lines = parseDiff(result.text);
        return lines.length ? { lines } : { text: empty };
    }

    private async commitViewer(id: number, message: string): Promise<string | null> {
        const spec = this.viewers.get(id);
        if (!spec || spec.commit) return _('There is nothing to commit here');
        const error = await this.commit(message, () => commitFile(spec.file, message.trim()));
        if (!error) this.closeViewer(id);
        return error;
    }

    // Asks with the state git reports now, not the one the window was opened with.
    private async discardViewer(id: number): Promise<DiscardOutcome> {
        const spec = this.viewers.get(id);
        if (!spec || spec.commit) return 'declined';
        const state = await workingState(spec.file);
        if (!this.viewers.has(id) || !state.ok || state.state === 'clean') return 'declined';
        const outcome = await this.discard(state.state === 'untracked' ? 'untracked' : 'modified', spec.file, id);
        if (outcome === 'done') this.closeViewer(id);
        return outcome;
    }

    private closeViewer(id: number): void {
        if (!this.viewers.delete(id)) return;
        this.stopWriting(id);
        this.host.historyViewers.close(id);
    }

    // ---------- Commit, discard, and the message writer ----------

    // The open documents are saved first; on success the message box is emptied by the view, and the history is read again.
    private async commit(message: string, run: () => Promise<TextResult>): Promise<string | null> {
        if (!message.trim()) return _('Enter a commit message first');
        if (!this.host.saveAll()) return _('The document failed to save; the commit was cancelled');
        const result = await run();
        if (!result.ok) return fmt(_('Commit failed: {message}'), { message: result.message });
        this.host.toast(_('Committed successfully'));
        this.refresh();
        return null;
    }

    private async discard(kind: ChangeKind, path: string, viewer: number | null): Promise<DiscardOutcome> {
        if (!await after(this.dialogs.discard(kind, path, viewer), yes => yes)) return 'declined';
        if (viewer !== null && !this.viewers.has(viewer)) return 'declined';
        if (!this.host.saveAll()) return { error: _('The document failed to save; the changes were not discarded') };
        const result = await discardChanges([path]);
        if (!result.ok) return { error: fmt(_('Could not discard the changes: {message}'), { message: result.message }) };
        this.discarded([path]);
        return 'done';
    }

    // The uncommitted changes of these files were thrown away on disk: an open document takes the file's contents again (one
    // undo step, as when the assistant writes to it), or loses its file when the file is gone (a new file that went to the Trash).
    private discarded(paths: string[]): void {
        for (const path of paths) {
            const doc = docFor(this.host, path);
            if (!doc) continue;
            if (fileExists(path)) {
                const disk = readTextFile(path);
                doc.editor.update(text => text === disk ? null : disk);
                doc.editor.setModified(false);
            } else this.host.fileGone(doc);
        }
        this.host.toast(_('The changes were discarded'));
        this.host.refreshTree();
        this.refresh();
    }

    private async write(form: number, files: string[], onText: (text: string) => void): Promise<WriteResult> {
        if (!files.length) return { ok: false, reason: 'failed', message: 'there is nothing to describe' };
        this.stopWriting(form);
        const cancellable = new Cancellable();
        this.writing.set(form, cancellable);
        try {
            return await writeCommitMessage({ ...this.writer(), diff: workingDiff, subjects: recentSubjects }, files, onText, cancellable);
        } finally {
            if (this.writing.get(form) === cancellable) this.writing.delete(form);
        }
    }

    private stopWriting(form: number): void {
        this.writing.get(form)?.cancel();
        this.writing.delete(form);
    }
}
