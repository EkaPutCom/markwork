// Agents over the protocol (docs/design/protocol.md 6.4, 6.5, and 7): the runs of a board's cards (`view.runs`), the log window
// of a run (`view.runlog.*`), the questions a harness and its card menu ask (`ask.folder`, `ask.harness.answer`, `ask.text`,
// `ask.remoteFolder`, `ask.closeAgents`), and the review of a card's worktree (`view.review`, `ask.review.*`, `ask.pullRequest`).
// What the user did comes back as `act.card.*`, `act.runlog.*`, and `act.review.*` (handlers/harness.ts). A run is named by its
// number and a card by its place and its text; the core checks both against what it holds.

import type { HarnessAsk, HarnessReply } from '../../agent/harness.js';
import type { ChangedFile, Commit, RanCommand } from '../../agent/worktreereview.js';
import type { SendVia } from '../../forge/contribute.js';
import type { FileStatus } from '../../forge/types.js';
import type { TraceUpdate } from '../../agent/tracefeed.js';
import type { DiffLine } from '../../base/gitlog.js';
import type { Prompt, Question } from '../dialogs.js';
import type { CardRun, CloseAgentsChoice, HarnessDialogs, HarnessLogs } from '../harness.js';
import type { FinishAction, PullOffer, PullRequestAnswer, PullRequestOptions, ReviewDialogs, ReviewTab, ReviewView, SummaryView } from '../harnessreview.js';
import type { Asks } from './asks.js';
import type { Wire } from './messages.js';

// What the renderer takes from here (types only).
export type { CardRun, CloseAgentsChoice, Commit, DiffLine, FinishAction, HarnessAsk, HarnessReply, PullOffer, PullRequestAnswer, PullRequestOptions, RanCommand, ReviewTab, SummaryView, TraceUpdate };

// The runs of the active board's cards, for their badges. The runs go with the board the user has open: a run of another
// board is not sent.
export class ProtocolRuns {
    constructor(private readonly wire: Wire, private readonly active: () => number) {}

    setRuns(runs: readonly CardRun[]): void { this.wire.notify('view.runs', { doc: this.active(), runs: [...runs] }); }
}

// A run's log window. The core opens it (`show`), sends the events as they come (`update`), and is told when the user clears
// the log or closes the window; a run that has no window open is not acted on.
export class ProtocolHarnessLogs implements HarnessLogs {
    onClear: HarnessLogs['onClear'] = () => {};
    onClosed: HarnessLogs['onClosed'] = () => {};
    private readonly open = new Set<number>();

    constructor(private readonly wire: Wire) {}

    show(runId: number, title: string): void {
        this.open.add(runId);
        this.wire.notify('view.runlog.open', { run: runId, title });
    }

    update(runId: number, update: TraceUpdate): void {
        if (this.open.has(runId)) this.wire.notify('view.runlog.update', { run: runId, update });
    }

    isOpen(runId: number): boolean { return this.open.has(runId); }

    // The window was closed: the core stops sending to it.
    closed(runId: number): void {
        if (!this.open.delete(runId)) return;
        this.onClosed(runId);
    }
}

// The answer to a harness's question, read against what it asked: a choice is one of its options, a confirmation is yes or no.
function readReply(ask: HarnessAsk, reply: unknown): HarnessReply | undefined {
    const r = reply as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== 'object') return undefined;
    if (r.cancelled === true) return { cancelled: true };
    if (ask.kind === 'confirm') return typeof r.confirmed === 'boolean' ? { confirmed: r.confirmed } : undefined;
    if (typeof r.value !== 'string') return undefined;
    if (ask.kind === 'select' && !ask.options.includes(r.value)) return undefined;
    return { value: r.value };
}

const CHOICES: readonly CloseAgentsChoice[] = ['cancel', 'stop', 'keep'];

export class ProtocolHarnessDialogs implements HarnessDialogs {
    constructor(private readonly asks: Asks) {}

    // A folder on this computer: the frontend's chooser. The core checks the path it gets (checkProjectFolder).
    chooseFolder(title: string): Promise<string | null> {
        return this.asks.ask<string | null>('ask.folder', { title }, r => typeof r.path === 'string' && r.path !== '' ? r.path : undefined, null);
    }

    // null = later: the harness keeps waiting.
    answer(ask: HarnessAsk, agent: string): Promise<HarnessReply | null> {
        return this.asks.ask<HarnessReply | null>('ask.harness.answer', { ask, agent }, r => readReply(ask, r.reply), null);
    }

    text(options: Parameters<HarnessDialogs['text']>[0]): Promise<string | null> {
        return this.asks.ask<string | null>('ask.text', { options }, r => typeof r.text === 'string' && r.text !== '' ? r.text : undefined, null);
    }

    remoteFolder(prompt: Prompt): Promise<string | null> { return this.asks.text('ask.remoteFolder', prompt); }

    closeAgents(activity: { children: number; detachable: number; queued: number }): Promise<CloseAgentsChoice> {
        return this.asks.choice('ask.closeAgents', { activity }, CHOICES, 'cancel');
    }
}

// ---------- The review of a card's worktree ----------

// A changed file as the page lists it: the diff itself is sent for the file that is selected, not for all of them.
export interface ReviewFile {
    path: string;
    oldPath: string | null;
    status: FileStatus;
    additions: number;
    deletions: number;
    binary: boolean;
}

export interface ReviewSnapshot {
    header: { title: string; meta: string; base: string; local: boolean } | null;
    files: ReviewFile[];
    included: boolean[];
    comments: number[];               // comments per file
    selected: number;
    blocked: boolean;                 // the boxes cannot change (a merge runs, or the branch conflicts)
    busy: string | null;              // what is being done ('' = something, unnamed); null = nothing
    commits: Commit[];
    uncommitted: boolean;
    status: string;
    message: string | null;           // shown instead of a diff
    diff: { lines: DiffLine[]; commented: number[] } | null;
    tab: ReviewTab;
    summary: SummaryView | null;
    replies: number;                  // comments the reply would carry
    pull: PullOffer | null;
    banner: { title: string; button: string | null } | null;
}

const TABS: readonly ReviewTab[] = ['changes', 'summary', 'log'];
const FINISH: readonly FinishAction[] = ['merge', 'squash', 'keep', 'discard'];

const emptyReview = (): ReviewSnapshot => ({
    header: null, files: [], included: [], comments: [], selected: 0, blocked: false, busy: null, commits: [], uncommitted: false,
    status: '', message: null, diff: null, tab: 'changes', summary: null, replies: 0, pull: null, banner: null,
});

// The review page. A review sets a dozen things on opening, so what follows in one turn goes out once, with the last values.
export class ProtocolReviewView implements ReviewView {
    onClose: ReviewView['onClose'] = () => {};
    onSelect: ReviewView['onSelect'] = () => {};
    onInclude: ReviewView['onInclude'] = () => {};
    onFinish: ReviewView['onFinish'] = () => {};
    onPullRequest: ReviewView['onPullRequest'] = () => {};
    onReply: ReviewView['onReply'] = () => {};
    onFolder: ReviewView['onFolder'] = () => {};
    onTerminal: ReviewView['onTerminal'] = () => {};
    onTab: ReviewView['onTab'] = () => {};
    onLog: ReviewView['onLog'] = () => {};
    onBanner: ReviewView['onBanner'] = () => {};
    onComment: ReviewView['onComment'] = () => {};

    private state: ReviewSnapshot = emptyReview();
    private queued = false;

    constructor(private readonly wire: Wire) {}

    private send(): void {
        if (this.queued) return;
        this.queued = true;
        void Promise.resolve().then(() => { this.queued = false; this.wire.notify('view.review', { ...this.state }); });
    }

    // What the frontend may name: a file of the list, a line of the diff shown. Anything else is refused by the handler.
    hasFile(index: number): boolean { return Number.isInteger(index) && index >= 0 && index < this.state.files.length; }
    hasLine(index: number): boolean { return Number.isInteger(index) && index >= 0 && index < (this.state.diff?.lines.length ?? 0); }
    static tab(value: unknown): ReviewTab | null { return TABS.includes(value as ReviewTab) ? value as ReviewTab : null; }
    static finish(value: unknown): FinishAction | null { return FINISH.includes(value as FinishAction) ? value as FinishAction : null; }

    setHeader(title: string, meta: string, base: string, local: boolean): void { this.state.header = { title, meta, base, local }; this.send(); }

    setFiles(files: readonly ChangedFile[], included: readonly boolean[], comments: readonly number[], selected: number): void {
        const s = this.state;
        s.files = files.map(f => ({ path: f.path, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary }));
        s.included = [...included];
        s.comments = [...comments];
        s.selected = selected;
        // A review that opens starts from nothing: what the one before it showed is not kept.
        if (!files.length) { s.diff = null; s.summary = null; s.pull = null; s.replies = 0; }
        this.send();
    }

    setIncluded(included: readonly boolean[], blocked = false): void { this.state.included = [...included]; this.state.blocked = blocked; this.send(); }
    setBusy(busy: boolean, label?: string): void { this.state.busy = busy ? label ?? '' : null; this.send(); }
    setCommits(commits: readonly Commit[], uncommitted: boolean): void { this.state.commits = [...commits]; this.state.uncommitted = uncommitted; this.send(); }
    setStatus(text: string): void { this.state.status = text; this.send(); }
    setMessage(text: string): void { this.state.message = text; this.state.diff = null; this.send(); }

    setDiff(lines: DiffLine[], commented: readonly number[]): void {
        this.state.diff = { lines: [...lines], commented: [...commented] };
        this.state.message = null;
        this.send();
    }

    showTab(tab: ReviewTab): void { this.state.tab = tab; this.send(); }
    setSummary(view: SummaryView): void { this.state.summary = view; this.send(); }
    setReplyCount(comments: number): void { this.state.replies = comments; this.send(); }
    setPullRequest(offer: PullOffer): void { this.state.pull = offer; this.send(); }
    setBanner(title: string | null, button?: string | null): void { this.state.banner = title === null ? null : { title, button: button ?? null }; this.send(); }
}

const VIA: readonly SendVia[] = ['fork', 'direct', 'agit'];

export class ProtocolReviewDialogs implements ReviewDialogs {
    constructor(private readonly asks: Asks) {}

    merge(question: Question): Promise<boolean> { return this.asks.question('ask.review.merge', question); }
    discard(question: Question): Promise<boolean> { return this.asks.question('ask.review.discard', question); }

    // The form that sends the branch as a pull request. The answer is read against the offer: a way the token cannot use is refused.
    pullRequest(options: PullRequestOptions): Promise<PullRequestAnswer | null> {
        return this.asks.ask<PullRequestAnswer | null>('ask.pullRequest', { options }, r => {
            const a = r.answer as Partial<PullRequestAnswer> | null | undefined;
            if (!a || typeof a.title !== 'string' || !a.title.trim() || typeof a.body !== 'string') return undefined;
            if (!VIA.includes(a.via as SendVia) || (a.via === 'direct' && !options.canPush)) return undefined;
            return { title: a.title, body: a.body, via: a.via as SendVia };
        }, null);
    }
}
