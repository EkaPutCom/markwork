// Collaboration over the protocol (docs/design/protocol.md 6.5 and 7): the pull request list of the sidebar (`view.collab`),
// the review page of one pull request (`view.pull`), the token dialog (`ask.token`), the merge questions (`ask.pull.*`),
// and the form that sends changes (`ask.sendChanges`). What the user did comes back as `act.collab.*` and `act.pull.*`
// (handlers/collab.ts). A pull request is named by its number, and only one the core listed is acted on.

import type { TokenSource } from '../../forge/token.js';
import type { FileStatus, MergeMethod, PullComment, PullFile, PullRequest, RepoRef } from '../../forge/types.js';
import type { SendVia } from '../../forge/contribute.js';
import type { FileChange } from '../../gitlog.js';
import { branchError } from '../../forge/contribute.js';
import type { CollabDialogs, CollabView } from '../collab.js';
import type { ContributeDialogs, SendChangesAnswer, SendChangesOptions } from '../contribute.js';
import type { Question } from '../dialogs.js';
import type { FileView, PullDialogs, PullReviewView } from '../pulls.js';
import { _ } from '../../i18n.js';
import type { Asks } from './asks.js';
import type { Wire } from './messages.js';

// What the renderer takes from here (types only).
export type { FileChange, FileStatus, FileView, MergeMethod, PullComment, PullFile, PullRequest, RepoRef, SendChangesAnswer, SendChangesOptions, SendVia, TokenSource };

// Notices that follow each other in one turn (a review sets a dozen things on opening) go out once, with the last values.
class Queued {
    private queued = false;
    constructor(private readonly send: () => void) {}

    schedule(): void {
        if (this.queued) return;
        this.queued = true;
        void Promise.resolve().then(() => { this.queued = false; this.send(); });
    }
}

// The pull requests tab: the note instead of the list, the server's label, and the list itself.
export interface CollabSnapshot {
    note: string | null;
    server: string | null;
    pulls: readonly PullRequest[];
}

export class ProtocolCollabPanel implements CollabView {
    onOpen: CollabView['onOpen'] = () => {};
    onRefresh: CollabView['onRefresh'] = () => {};
    onServer: CollabView['onServer'] = () => {};
    onSend: CollabView['onSend'] = () => {};

    private readonly state: CollabSnapshot = { note: null, server: null, pulls: [] };
    private readonly queue: Queued;

    constructor(wire: Wire) {
        this.queue = new Queued(() => wire.notify('view.collab', { ...this.state }));
    }

    setNote(text: string | null): void { this.state.note = text; this.queue.schedule(); }
    setServer(label: string | null): void { this.state.server = label; this.queue.schedule(); }
    // A list replaces the note: the list itself, or the sentence that there is nothing in it (as the GTK tab does).
    setPulls(pulls: readonly PullRequest[]): void {
        this.state.pulls = [...pulls];
        this.state.note = pulls.length ? null : _('No open pull requests');
        this.queue.schedule();
    }
}

// The review page. The file shown is the one the frontend chose (`select`), the first one when the files arrive.
export interface PullSnapshot {
    pull: PullRequest | null;
    files: readonly PullFile[];
    selected: string | null;
    fileView: FileView | null;
    message: string | null;           // shown instead of a file's changes (loading, an error, no files)
    comments: readonly PullComment[];
    busy: boolean;                    // the server is merging
    resolving: number | null;         // conflicted files left in a local merge; null = no local merge
    commenting: boolean;              // a comment is on its way
    cleared: number;                  // how many times the comment box was emptied
}

export class ProtocolPullView implements PullReviewView {
    onClose: PullReviewView['onClose'] = () => {};
    onSelect: PullReviewView['onSelect'] = () => {};
    onMerge: PullReviewView['onMerge'] = () => {};
    onBrowser: PullReviewView['onBrowser'] = () => {};
    onComment: PullReviewView['onComment'] = () => {};
    onResolve: PullReviewView['onResolve'] = () => {};
    onFinish: PullReviewView['onFinish'] = () => {};
    onAbort: PullReviewView['onAbort'] = () => {};

    private readonly state: PullSnapshot = {
        pull: null, files: [], selected: null, fileView: null, message: null, comments: [], busy: false, resolving: null, commenting: false, cleared: 0,
    };
    private readonly queue: Queued;

    constructor(wire: Wire) {
        this.queue = new Queued(() => wire.notify('view.pull', { ...this.state }));
    }

    // The frontend chose a file of the list: the review shows it.
    select(path: string): void {
        this.state.selected = path;
        this.onSelect(path);
    }

    setPull(pull: PullRequest): void { this.state.pull = pull; this.queue.schedule(); }
    setResolving(files: number | null): void { this.state.resolving = files; this.queue.schedule(); }
    setBusy(busy: boolean): void { this.state.busy = busy; this.queue.schedule(); }
    setCommenting(busy: boolean): void { this.state.commenting = busy; this.queue.schedule(); }
    clearComment(): void { this.state.cleared++; this.queue.schedule(); }

    // The first file is shown as soon as the list arrives, as the list of the GTK page selects its first row.
    setFiles(files: readonly PullFile[]): void {
        this.state.files = [...files];
        this.state.selected = files[0]?.path ?? null;
        this.state.fileView = null;
        this.queue.schedule();
        if (files.length) this.onSelect(files[0].path);
        else this.setMessage('This pull request changes no files.');
    }

    setMessage(text: string): void {
        this.state.fileView = null;
        this.state.message = text;
        this.queue.schedule();
    }

    setFileView(view: FileView): void {
        this.state.fileView = view;
        this.state.message = null;
        this.queue.schedule();
    }

    setDiscussion(pull: PullRequest, comments: readonly PullComment[]): void {
        this.state.pull = pull;
        this.state.comments = [...comments];
        this.queue.schedule();
    }
}

// The merge questions are `Question`s, written and translated by the controller; the frontend draws them.
export class ProtocolPullDialogs implements PullDialogs {
    constructor(private readonly asks: Asks) {}

    merge(question: Question): Promise<boolean> { return this.asks.question('ask.pull.merge', question); }
    local(question: Question): Promise<boolean> { return this.asks.question('ask.pull.local', question); }
    abort(question: Question): Promise<boolean> { return this.asks.question('ask.pull.abort', question); }
}

// The token dialog: `ask.token` carries the repository and where the token in use comes from. While it is open its Test
// button sends `act.collab.testToken` with the number of the ask, and the core tries the typed token without saving it.
export class ProtocolCollabDialogs implements CollabDialogs {
    // The controller sets it (CollabController.test): resolves to a sentence for the user, rejects with the reason.
    onTestToken: CollabDialogs['onTestToken'] = () => Promise.reject(new Error('there is no server to test against'));
    private asking: { id: number; repo: RepoRef } | null = null;
    private count = 0;

    constructor(private readonly asks: Asks) {}

    // null = cancelled, '' = forget the saved token.
    async token(repo: RepoRef, hasToken: boolean, source: TokenSource | undefined): Promise<string | null> {
        const id = ++this.count;
        this.asking = { id, repo };
        try {
            return await this.asks.ask<string | null>('ask.token', { ask: id, repo, hasToken, source: source ?? null },
                r => typeof r.token === 'string' ? r.token : undefined, null);
        } finally {
            if (this.asking?.id === id) this.asking = null;
        }
    }

    // The Test button of the dialog that is open; an ask that is over is stale.
    test(ask: number, token: string): Promise<string> {
        if (this.asking?.id !== ask) return Promise.reject(new StaleAsk());
        return this.onTestToken(this.asking.repo, token);
    }
}

export class StaleAsk extends Error {
    constructor() { super('that dialog is closed'); }
}

const VIA: readonly SendVia[] = ['fork', 'direct', 'agit'];

// The form that sends the changes. The answer is read against what was offered: only files of the list, a way that is allowed.
export class ProtocolContributeDialogs implements ContributeDialogs {
    constructor(private readonly asks: Asks) {}

    send(options: SendChangesOptions): Promise<SendChangesAnswer | null> {
        const offered = new Set(options.changes.map(c => c.path));
        return this.asks.ask<SendChangesAnswer | null>('ask.sendChanges', { options }, r => {
            const a = r.answer as Partial<SendChangesAnswer> | null | undefined;
            if (!a || typeof a.title !== 'string' || typeof a.body !== 'string' || typeof a.branch !== 'string') return undefined;
            if (!VIA.includes(a.via as SendVia) || (a.via === 'direct' && !options.canPush)) return undefined;
            if (!Array.isArray(a.files) || a.files.some(f => typeof f !== 'string' || !offered.has(f))) return undefined;
            if (branchError(a.branch)) return undefined;
            return { title: a.title, body: a.body, branch: a.branch, via: a.via as SendVia, files: a.files as string[] };
        }, null);
    }
}
