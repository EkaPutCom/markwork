// Reviewing and merging one pull request: opens it in the content area, loads the changed files and their text from the
// forge, shows each as a note or as a raw diff, and merges on request. After a merge the folder is brought up to date with
// git when it is on the base branch. The forge itself comes from CollabController through `access`.

import Gio from 'gi://Gio';
import type Gtk from 'gi://Gtk?version=4.0';
import { runGit } from '../git.js';
import { parseDiff, type DiffLine } from '../gitlog.js';
import { fileDiff, isBinaryDiff } from '../forge/diff.js';
import { ForgeError, type ForgeProvider, type MergeMethod, type PullFile, type PullRequest } from '../forge/types.js';
import { diffNote, type NoteDiff } from '../markdown/notediff.js';
import { mergeDialog } from '../ui/dialogs.js';
import type { FileView, PullView } from '../ui/pullview.js';
import { _, fmt } from '../i18n.js';
import type { DocumentHost } from './doc.js';

export interface PullHost extends DocumentHost {
    readonly content: Gtk.Stack;
    readonly pullView: PullView;
    showDocument(): void;          // the content area shows the active document again
    refreshTree(): void;
}

// What the review needs from the collaboration controller.
export interface PullAccess {
    provider(): ForgeProvider | null;
    changed(): void;               // a pull request changed on the forge: look again
}

// A file bigger than this is not compared in the note view; the raw diff is still there.
const MAX_NOTE_CHARS = 300_000;
const NOTE_FILE = /\.(md|markdown|mdown|txt)$/i;

const METHOD_NAME: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };

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
    // The merge confirmation; tests replace it with an immediate answer.
    dialogs: { merge: (pull: PullRequest, method: MergeMethod) => Promise<boolean> } = {
        merge: (pull, method) => mergeDialog(this.host.win, fmt(_('Merge pull request #{number}?'), { number: pull.number }),
            fmt(_('“{title}” will be merged into {base} on the server with “{method}”. Everybody who uses this repository sees it.'), { title: pull.title, base: pull.baseRef, method: _(METHOD_NAME[method]) })),
    };

    constructor(private readonly host: PullHost, private readonly access: PullAccess) {
        const view = host.pullView;
        view.onClose = () => this.close();
        view.onSelect = path => void this.select(path);
        view.onMerge = method => void this.merge(method);
        view.onBrowser = () => { if (this.pull?.url) Gio.AppInfo.launch_default_for_uri(this.pull.url, null); };
    }

    get current(): PullRequest | null { return this.pull; }

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
        pullView.setFiles([]);
        pullView.setMessage(_('Loading…'));
        this.host.content.visible_child_name = 'pull';
        const provider = this.access.provider();
        if (!provider) return pullView.setMessage(_('Not connected to a server.'));
        try {
            const [files, diff] = await Promise.all([provider.getFiles(pull.number), provider.getDiff(pull.number)]);
            if (generation !== this.generation) return;
            this.files = files;
            this.diff = diff;
            pullView.setFiles(files);
        } catch (e) {
            if (generation === this.generation) pullView.setMessage(e instanceof Error ? e.message : String(e));
        }
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
        return fmt(_('{done}. The folder is up to date.'), { done });
    }
}
