// Reviewing and merging one pull request: opens it in the content area, loads the changed files and their text from the
// forge, shows each as a note or as a raw diff, and merges on request. After a merge the folder is brought up to date with
// git when it is on the base branch. The forge itself comes from CollabController through `access`.

import { readTextFile } from '../files.js';
import { platform } from '../platform/index.js';
import { runGit } from '../git.js';
import { parseDiff, type DiffLine } from '../gitlog.js';
import type { GitRunner } from '../forge/contribute.js';
import { fileDiff, isBinaryDiff } from '../forge/diff.js';
import { abortLocalMerge, confirmMerged, finishLocalMerge, pendingMerge, preflight, startLocalMerge, unresolved, type LocalMerge, type PendingMerge } from '../forge/resolve.js';
import { ForgeError, type ForgeProvider, type MergeMethod, type PullComment, type PullFile, type PullRequest, type RepoRef } from '../forge/types.js';
import { diffNote, type NoteDiff } from '../markdown/notediff.js';
import { _, fmt, ngettext } from '../i18n.js';
import { docFor, type DocumentHost } from './document.js';

// One changed file of a pull request: as a note (null when it cannot be shown that way), and as a raw diff.
export interface FileView {
    rendered: DiffLine[] | null;
    raw: DiffLine[];
    note?: string;
}

// The review page: it draws what it is given and reports the user's actions through the on* callbacks.
export interface PullReviewView {
    onClose: () => void;
    onSelect: (path: string) => void;
    onMerge: (method: MergeMethod) => void;
    onBrowser: () => void;
    onComment: (text: string) => void;
    onResolve: () => void;
    onFinish: () => void;
    onAbort: () => void;
    setPull(pull: PullRequest): void;
    setResolving(files: number | null): void;     // conflicted files left in a local merge; null = no local merge
    setBusy(busy: boolean): void;
    setFiles(files: readonly PullFile[]): void;
    setMessage(text: string): void;
    setFileView(view: FileView): void;
    setDiscussion(pull: PullRequest, comments: readonly PullComment[]): void;
    setCommenting(busy: boolean): void;
    clearComment(): void;
}

// The confirmations before merging; tests replace them with immediate answers.
export interface PullDialogs {
    merge(pull: PullRequest, method: MergeMethod): Promise<boolean>;
    local(pull: PullRequest): Promise<boolean>;
    abort(pull: PullRequest): Promise<boolean>;
}

export interface PullHost extends DocumentHost {
    readonly pullView: PullReviewView;
    showPull(): void;              // the content area shows the review page
    showDocument(): void;          // the content area shows the active document again
    openUri(uri: string): void;
    saveAll(): boolean;            // write the open documents to disk; false = the user cancelled
    refreshTree(): void;
}

// What the review needs from the collaboration controller.
export interface PullAccess {
    provider(): ForgeProvider | null;
    changed(): void;               // a pull request changed on the forge: look again
    session(): { provider: ForgeProvider; repo: RepoRef; token: string } | null;
}

// A file bigger than this is not compared in the note view; the raw diff is still there.
const MAX_NOTE_CHARS = 300_000;
const NOTE_FILE = /\.(md|markdown|mdown|txt)$/i;

const METHOD_NAME: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };

// The merge method as the forge's own button calls it, translated.
export const mergeMethodName = (method: MergeMethod): string => _(METHOD_NAME[method]);

// The note view as diff lines: what changed in the fields, then the whole text with the changes marked.
export function noteLines(diff: NoteDiff): DiffLine[] {
    const lines: DiffLine[] = [];
    if (diff.fields.length) {
        lines.push({ kind: 'hunk', text: _('Fields') });
        for (const f of diff.fields) {
            if (f.before !== null) lines.push({ kind: 'del', text: `- ${f.key}: ${f.before}` });
            if (f.after !== null) lines.push({ kind: 'add', text: `+ ${f.key}: ${f.after}` });
        }
        lines.push({ kind: 'context', text: '' });
    }
    if (diff.body.some(l => l.kind !== 'same')) {
        lines.push({ kind: 'hunk', text: _('Text') });
        for (const l of diff.body) lines.push({ kind: l.kind === 'same' ? 'context' : l.kind, text: `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} ${l.text}` });
    }
    return lines;
}

export class PullReviewController {
    private pull: PullRequest | null = null;
    private files: readonly PullFile[] = [];
    private diff = '';
    private generation = 0;      // answers for a pull request that is no longer shown are dropped
    // The local merge in progress: where it started, and the files that conflicted.
    private local: { merge: LocalMerge; files: string[]; before: string } | null = null;
    git: GitRunner = runGit;
    // dialogs: the frontend's merge confirmations; tests replace them with immediate answers.
    constructor(private readonly host: PullHost, private readonly access: PullAccess, public dialogs: PullDialogs) {
        const view = host.pullView;
        view.onClose = () => this.close();
        view.onSelect = path => void this.select(path);
        view.onMerge = method => void this.merge(method);
        view.onComment = text => void this.comment(text);
        view.onResolve = () => void this.resolve();
        view.onFinish = () => void this.finish();
        view.onAbort = () => void this.abort();
        view.onBrowser = () => { if (this.pull?.url) this.host.openUri(this.pull.url); };
    }

    get current(): PullRequest | null { return this.pull; }

    // Another folder was opened: nothing of this one is shown any more, and its local merge is no longer ours to finish.
    folderChanged(): void {
        this.local = null;
        if (this.pull) this.close();
    }

    close(): void {
        this.generation++;
        this.pull = null;
        this.host.showDocument();
    }

    async open(pull: PullRequest): Promise<void> {
        const generation = ++this.generation;
        const { pullView } = this.host;
        this.pull = pull;
        this.files = [];
        this.diff = '';
        pullView.setPull(pull);
        pullView.setResolving(this.local?.merge.pull === pull.number ? this.remaining().length : null);
        void this.resume(pull, generation);
        pullView.setFiles([]);
        pullView.setDiscussion(pull, []);
        pullView.clearComment();
        pullView.setMessage(_('Loading…'));
        this.host.showPull();
        const provider = this.access.provider();
        if (!provider) return pullView.setMessage(_('Not connected to a server.'));
        try {
            const [files, diff, comments] = await Promise.all([provider.getFiles(pull.number), provider.getDiff(pull.number), this.comments(provider, pull)]);
            if (generation !== this.generation) return;
            this.files = files;
            this.diff = diff;
            pullView.setDiscussion(pull, comments);
            pullView.setFiles(files);
        } catch (e) {
            if (generation === this.generation) pullView.setMessage(e instanceof Error ? e.message : String(e));
        }
    }

    // A discussion that cannot be read does not keep the files from showing; the user is told and the list stays empty.
    private async comments(provider: ForgeProvider, pull: PullRequest): Promise<PullComment[]> {
        try {
            return await provider.listComments(pull.number);
        } catch (e) {
            this.host.toast(fmt(_('Could not read the discussion: {message}'), { message: e instanceof Error ? e.message : String(e) }));
            return [];
        }
    }

    async comment(text: string): Promise<void> {
        const pull = this.pull, provider = this.access.provider();
        if (!pull || !provider || !text.trim()) return;
        const { pullView } = this.host;
        pullView.setCommenting(true);
        try {
            await provider.addComment(pull.number, text.trim());
        } catch (e) {
            pullView.setCommenting(false);
            this.host.toast(fmt(_('The comment was not sent: {message}'), { message: e instanceof Error ? e.message : String(e) }));
            return;
        }
        const comments = await this.comments(provider, pull);
        if (this.pull?.number === pull.number) {
            pullView.setDiscussion(pull, comments);
            pullView.clearComment();
        }
        pullView.setCommenting(false);
        this.access.changed();
    }

    // Shows one file of the open pull request.
    async select(path: string): Promise<void> {
        const generation = this.generation, pull = this.pull, provider = this.access.provider();
        const file = this.files.find(f => f.path === path);
        if (!pull || !file || !provider) return;
        const raw = this.rawLines(path);
        if (!NOTE_FILE.test(path)) return this.host.pullView.setFileView({ rendered: null, raw, note: this.rawNote(path, raw) });
        this.host.pullView.setMessage(_('Loading…'));
        try {
            const view = await this.noteView(provider, pull, file, raw);
            if (generation === this.generation && pull === this.pull) this.host.pullView.setFileView(view);
        } catch (e) {
            if (generation === this.generation) this.host.pullView.setMessage(e instanceof Error ? e.message : String(e));
        }
    }

    private rawLines(path: string): DiffLine[] {
        const part = fileDiff(this.diff, path);
        return part && !isBinaryDiff(part) ? parseDiff(part) : [];
    }

    private rawNote(path: string, raw: DiffLine[]): string | undefined {
        if (raw.length) return undefined;
        return isBinaryDiff(fileDiff(this.diff, path)) ? _('This is a binary file; there is no text to compare.') : _('There is no text change to show (for example a rename without edits).');
    }

    private async noteView(provider: ForgeProvider, pull: PullRequest, file: PullFile, raw: DiffLine[]): Promise<FileView> {
        const [before, after] = await Promise.all([
            file.status === 'added' ? null : provider.getContent(file.previousPath ?? file.path, pull.baseSha),
            file.status === 'deleted' ? null : provider.getContent(file.path, pull.headSha),
        ]);
        if ((before?.length ?? 0) > MAX_NOTE_CHARS || (after?.length ?? 0) > MAX_NOTE_CHARS) {
            return { rendered: [], raw, note: _('This file is too large to compare as a note. The diff shows what changed.') };
        }
        const rendered = noteLines(diffNote(before, after));
        return { rendered, raw, ...(rendered.length ? {} : { note: _('The note itself did not change.') }) };
    }

    async merge(method: MergeMethod): Promise<void> {
        const pull = this.pull, provider = this.access.provider();
        if (!pull || !provider || pull.state !== 'open') return;
        if (!await this.dialogs.merge(pull, method)) return;
        const { pullView } = this.host;
        pullView.setBusy(true);
        try {
            await provider.merge(pull.number, method);
        } catch (e) {
            pullView.setBusy(false);
            pullView.setPull(pull);
            this.host.toast(e instanceof ForgeError || e instanceof Error ? e.message : String(e));
            return;
        }
        pullView.setBusy(false);
        this.access.changed();
        const merged = await provider.getPull(pull.number).catch(() => ({ ...pull, state: 'merged' as const }));
        if (this.pull?.number === pull.number) { this.pull = merged; pullView.setPull(merged); }
        this.host.toast(await this.bringUpToDate(merged));
    }

    // The files of the local merge that still have conflict markers (a file that cannot be read has none).
    private remaining(): string[] {
        const local = this.local;
        if (!local) return [];
        return unresolved(local.files, path => { try { return readTextFile(path); } catch (e) { return ''; } });
    }

    // A merge, an abort, or a pull changes files on disk under documents that are already open. Those documents take the disk
    // contents, or they would show the old text while the file has markers (and saving them would write the old text back over the
    // merge). The open documents were saved before git ran, so no edit is lost.
    private reloadOpen(): void {
        for (const doc of this.host.docs()) {
            if (!doc.file || doc.editor.isModified()) continue;
            let text: string;
            try { text = readTextFile(doc.file); } catch (e) { continue; }
            if (text === doc.editor.getText()) continue;
            doc.editor.replaceText(text);
            doc.editor.setModified(false);
        }
    }

    // What a local merge of this pull request needs from the server; a message when the server cannot say.
    private async mergeFor(pull: PullRequest, folder: string): Promise<LocalMerge | string> {
        const session = this.access.session();
        if (!session) return _('Not connected to a server.');
        try {
            const [target, login] = await Promise.all([session.provider.repoInfo(), session.provider.currentUser()]);
            if (!target) return _('The server does not know this repository, or the token cannot see it.');
            return { folder, base: pull.baseRef, cloneUrl: target.cloneUrl, pull: pull.number, title: pull.title, login, token: session.token };
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }

    // The merge lives in git, but the app's note of it (which files, where to go back to) does not survive a restart. When the
    // folder is in the middle of a merge of this pull request, the note is made again, so Finish and Abort work.
    private async resume(pull: PullRequest, generation: number): Promise<void> {
        const folder = this.host.root();
        if (this.local || !folder || pull.state !== 'open') return;
        const pending = await pendingMerge(this.git, folder);
        if (!pending || pending.pull !== pull.number || this.local) return;
        const merge = await this.mergeFor(pull, folder);
        if (typeof merge === 'string' || this.local || generation !== this.generation) return;
        this.local = { merge, files: pending.conflicts, before: pending.before };
        this.host.pullView.setResolving(this.remaining().length);
    }

    // After the merge started (now or in an earlier run): the open documents show what is on disk, and the files that conflict
    // open in source mode, where the markers are plain text.
    private showMerge(files: readonly string[]): void {
        this.host.refreshTree();
        this.reloadOpen();
        for (const file of files) {
            this.host.openInTab(file);
            // The editor would otherwise render the markers as Markdown: `=======` becomes a heading underline and `>>>>>>>` a quote.
            docFor(this.host, file)?.editor.setMode('source', true);
        }
        // A tab that is already the active one is not switched to by openInTab(), so the review would stay in front of it.
        if (files.length) this.host.showDocument();
        else this.host.pullView.setResolving(0);
    }

    // The folder is already in the middle of a merge. If it is this pull request's, carry on with it; otherwise say whose it is.
    private async carryOn(pull: PullRequest, folder: string, pending: PendingMerge): Promise<void> {
        if (pending.pull !== pull.number) {
            return this.host.toast(pending.pull !== null
                ? fmt(_('A merge for pull request #{number} is already in progress in this folder. Open that pull request to finish or abort it.'), { number: pending.pull })
                : _('A merge is already in progress in this folder. Finish or abort it first.'));
        }
        const merge = await this.mergeFor(pull, folder);
        if (typeof merge === 'string') return this.host.toast(merge);
        this.local = { merge, files: pending.conflicts, before: pending.before };
        this.showMerge(pending.conflicts);
        this.host.pullView.setResolving(this.remaining().length);
        this.host.toast(pending.conflicts.length
            ? fmt(ngettext('This merge was already started in this folder. {count} file still has conflicts; edit it, then choose Finish and push.', 'This merge was already started in this folder. {count} files still have conflicts; edit them, then choose Finish and push.', pending.conflicts.length), { count: pending.conflicts.length })
            : _('This merge was already started in this folder. Choose Finish and push to send it to the server.'));
    }

    // Merges the open pull request into the base branch in the user's folder, and opens the files that conflict.
    async resolve(): Promise<void> {
        const pull = this.pull, folder = this.host.root();
        if (!pull || !this.access.session() || !folder || pull.state !== 'open') return;
        if (!this.host.saveAll()) return;
        const pending = await pendingMerge(this.git, folder);
        if (pending) return this.carryOn(pull, folder, pending);
        const problem = await preflight(this.git, folder, pull.baseRef);
        if (problem) return this.host.toast(problem);
        if (!await this.dialogs.local(pull)) return;
        const merge = await this.mergeFor(pull, folder);
        if (typeof merge === 'string') return this.host.toast(merge);
        const started = await startLocalMerge(this.git, merge);
        if (!started.ok) return this.host.toast(started.message);
        this.local = { merge, files: started.conflicts, before: started.before };
        this.showMerge(started.conflicts);
        // Opening the files puts a document in front of the review; the review is back from the list.
        this.host.toast(started.conflicts.length ? fmt(ngettext('{count} file has conflicts. Edit it, then open the pull request again and choose Finish and push.', '{count} files have conflicts. Edit them, then open the pull request again and choose Finish and push.', started.conflicts.length), { count: started.conflicts.length }) : _('Merged without conflicts. Choose Finish and push to send it to the server.'));
    }

    // Commits the resolution and pushes the base branch; the server then sees the pull request as merged.
    async finish(): Promise<void> {
        const local = this.local, pull = this.pull;
        if (!local || !pull || local.merge.pull !== pull.number) return;
        if (!this.host.saveAll()) return;
        const left = this.remaining();
        this.host.pullView.setResolving(left.length);
        if (left.length) return this.host.toast(fmt(_('Still has conflict markers: {files}'), { files: left.map(f => platform().paths.basename(f)).join(', ') }));
        const result = await finishLocalMerge(this.git, local.merge, local.files);
        if (!result.ok) return this.host.toast(result.message);
        this.local = null;
        this.host.pullView.setResolving(null);
        this.host.refreshTree();
        const provider = this.access.provider();
        const head = (await this.git(local.merge.folder, ['rev-parse', 'HEAD']))?.out.trim() ?? '';
        const recorded = provider && head ? await confirmMerged(provider, pull.number, head) : { ok: false as const, message: _('it is not connected to a server') };
        this.access.changed();
        const merged = provider ? await provider.getPull(pull.number).catch(() => null) : null;
        if (merged && this.pull?.number === pull.number) { this.pull = merged; this.host.pullView.setPull(merged); }
        this.host.toast(recorded.ok
            ? fmt(_('Pushed. Pull request #{number} is merged on the server.'), { number: pull.number })
            : fmt(_('Pushed, but pull request #{number} is not marked as merged: {message}'), { number: pull.number, message: recorded.message }));
    }

    // Gives the folder back as it was before the local merge.
    async abort(): Promise<void> {
        const local = this.local, pull = this.pull, folder = this.host.root();
        if (!local || !pull || !folder || local.merge.pull !== pull.number) return;
        if (!await this.dialogs.abort(pull)) return;
        const result = await abortLocalMerge(this.git, folder, local.before);
        if (!result.ok) return this.host.toast(result.message);
        this.local = null;
        this.host.pullView.setResolving(null);
        this.host.refreshTree();
        this.reloadOpen();
        this.host.toast(_('The merge was undone.'));
    }

    // The merge happened on the server. When the folder is on the base branch, git brings it up to date; otherwise it is
    // left alone: switching a branch under the user's feet is not this feature's decision.
    private async bringUpToDate(pull: PullRequest): Promise<string> {
        const root = this.host.root();
        const done = fmt(_('Merged pull request #{number}'), { number: pull.number });
        if (!root) return done;
        const branch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const current = branch?.status === 0 ? branch.out.trim() : '';
        if (current !== pull.baseRef) return fmt(_('{done}. The folder is on {branch}, not {base}, so it was not updated.'), { done, branch: current || '?', base: pull.baseRef });
        const pulled = await runGit(root, ['pull', '--ff-only']);
        if (pulled?.status !== 0) return fmt(_('{done}, but git pull failed: {message}'), { done, message: (pulled?.err.trim() || pulled?.out.trim() || 'git is not available').split('\n')[0] });
        this.host.refreshTree();
        this.reloadOpen();
        return fmt(_('{done}. The folder is up to date.'), { done });
    }
}
