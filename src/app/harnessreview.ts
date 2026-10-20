// Reviewing a card's worktree: opens it in the content area, reads what the harness changed with git (on this computer
// or through the daemon on the agents' machine), collects the user's comments on the diff, and on request replies to
// the harness, merges the work into the base branch, keeps only the branch, or discards it. The card is found again
// by its `[branch:: …]` field, so a review works after Markwork was restarted too.

import { HARNESSES, cardProject, isActive, locateCard, type Run } from '../agent/harness.js';
import { isRemoteMachine } from '../agent/daemon/machines.js';
import { findWorktree, removeWorktree, type Worktree } from '../agent/worktree.js';
import { commandsRun, commentsReply, commitLeftovers, mergeWorktree, newLineNumbers, pullFromNotes, pullNote, pullRequestBody, readReview, uncommitLeftovers, type ChangedFile, type Commit, type LineComment, type MergeMethod, type RanCommand, type Review } from '../agent/worktreereview.js';
import type { SendVia } from '../forge/contribute.js';
import { GiteaProvider, isGiteaServer } from '../forge/gitea.js';
import { publishBranch, type PublishResult } from '../forge/publish.js';
import { forgeKind, parseRemote } from '../forge/remote.js';
import type { TokenStore } from '../forge/token.js';
import { ForgeError, type RepoRef, type Transport } from '../forge/types.js';
import { parseDiff, type DiffLine } from '../base/gitlog.js';
import { worktreeActivity, type ActivityKind } from '../markdown/journal.js';
import { cardBranch, cardMeta, parseBoard, type Board, type Card } from '../markdown/kanban.js';
import { readTextFile } from '../base/files.js';
import { platform } from '../platform/index.js';
import type { AppSettings } from '../base/settings.js';
import { _, fmt, ngettext } from '../base/i18n.js';
import type { Question } from './dialogs.js';
import { docFor, type DocumentHost } from './document.js';
import type { HarnessController } from './harness.js';

export type ReviewTab = 'changes' | 'summary' | 'log';

// What finishing the review can do, from the merge button and its menu.
export type FinishAction = MergeMethod | 'keep' | 'discard';

export interface SummaryView {
    answer: string;              // the harness's last answer ('' = none known)
    commands: RanCommand[];
    hasLog: boolean;
}

// The review page: it draws what it is given and reports the user's actions through the on* callbacks.
export interface ReviewView {
    onClose: () => void;
    onSelect: (index: number) => void;
    onInclude: (index: number, included: boolean) => void;
    onFinish: (action: FinishAction) => void;
    onPullRequest: () => void;
    onReply: () => void;
    onFolder: () => void;
    onTerminal: () => void;
    onTab: (tab: ReviewTab) => void;
    onLog: () => void;
    onBanner: () => void;
    onComment: (line: number, text: string) => void;     // a comment on line `line` of the diff shown
    setHeader(title: string, meta: string, base: string, local: boolean): void;
    setFiles(files: readonly ChangedFile[], included: readonly boolean[], comments: readonly number[], selected: number): void;
    setIncluded(included: readonly boolean[], blocked?: boolean): void;   // blocked = the boxes cannot change (a merge runs)
    setBusy(busy: boolean, label?: string): void;
    setCommits(commits: readonly Commit[], uncommitted: boolean): void;
    setStatus(text: string): void;
    setMessage(text: string): void;
    setDiff(lines: DiffLine[], commented: readonly number[]): void;   // commented = the lines that have a comment
    showTab(tab: ReviewTab): void;
    setSummary(view: SummaryView): void;
    setReplyCount(comments: number): void;
    setPullRequest(offer: PullOffer): void;
    setBanner(title: string | null, button?: string | null): void;
}

// The menu item that sends the branch to the forge as a pull request: whether it can be used, and why not.
export interface PullOffer {
    enabled: boolean;
    label: string;
    detail: string;      // what it does, or the reason it is off
}

// What the pull request dialog is shown, and what it answers.
export interface PullRequestOptions {
    repository: string;      // owner/repo on the server
    host: string;
    base: string;            // the branch the pull request asks to merge into
    branch: string;          // the branch that is pushed
    title: string;
    body: string;
    canPush: boolean;        // the token may push a branch to the repository itself
    uncommitted: boolean;    // the agent left changes that will be committed on the branch first
}

export interface PullRequestAnswer { title: string; body: string; via: SendVia }

// The confirmations before merging, discarding, or sending; tests replace them with immediate answers.
export interface ReviewDialogs {
    merge(question: Question): Promise<boolean>;
    discard(question: Question): Promise<boolean>;
    pullRequest(options: PullRequestOptions): Promise<PullRequestAnswer | null>;   // null = cancelled
}

// What the pull request reaches outside the process through (the collaboration controller's services).
export interface ReviewServices {
    tokens: TokenStore;
    transport: Transport;
}

export interface ReviewHost extends DocumentHost {
    readonly reviewView: ReviewView;
    showReview(): void;                // the content area shows the review page
    openFolder(path: string): void;    // in the file manager
    readonly settings: AppSettings;
    readonly harness: Pick<HarnessController, 'orchestrator' | 'git' | 'machine' | 'machineLabel' | 'folderOf' | 'isolation' | 'showLog' | 'dialogs'>;
    showDocument(): void;
    openUri(uri: string): void;        // in the browser
    record(kind: ActivityKind, text: string): void;
}

interface Comment extends LineComment { file: number; index: number }

// The card under review and what was read about it.
interface Open {
    board: string;
    card: string;              // the card text when the review opened
    title: string;
    agent: string;
    project: string;
    folder: string;            // the project folder
    wt: Worktree;
    review: Review;
    included: boolean[];
    comments: Comment[];
    selected: number;
    lines: DiffLine[];
    forge: ForgeOrigin;
    pull: { number: number; url: string } | null;   // the pull request the card's notes say was opened
}

// Where the project's origin remote points, as far as a pull request goes: the repository, or why there is none.
interface ForgeOrigin { repo: RepoRef | null; why: string }

export class HarnessReviewController {
    private current: Open | null = null;
    private generation = 0;    // answers for a review that is no longer shown are dropped

    // dialogs: the frontend's confirmations; tests replace them with immediate answers.
    constructor(private readonly host: ReviewHost, public dialogs: ReviewDialogs, private readonly services: ReviewServices) {
        const view = host.reviewView;
        view.onClose = () => this.close();
        view.onSelect = index => this.select(index);
        view.onInclude = (index, included) => this.include(index, included);
        view.onTab = tab => this.tab(tab);
        view.onComment = (line, text) => this.comment(line, text);
        view.onReply = () => this.reply();
        view.onPullRequest = () => void this.pullRequest();
        view.onFinish = action => void this.finish(action);
        view.onFolder = () => this.openFolder();
        view.onTerminal = () => this.openTerminal();
        view.onLog = () => { const run = this.run(); if (run) this.host.harness.showLog(run); };
        view.onBanner = () => this.askToUpdate();
    }

    get showing(): Open | null { return this.current; }

    // Opens the review of a card on the board in `boardFile`. Returns an error message or null.
    open(boardFile: string, card: Card, board: Board): string | null {
        const branch = cardBranch(card.text);
        if (!branch) return 'the card has no worktree';
        const meta = cardMeta(card.text);
        const project = cardProject(board, card);
        if (!project) return 'the card has no project';
        const folder = this.host.harness.folderOf(project);
        if (!folder) return `the folder of project ${project} is not known here`;
        const generation = ++this.generation;
        this.current = null;
        const view = this.host.reviewView;
        view.setHeader(meta.title, fmt(_('{branch} · reading the changes…'), { branch }), '', !isRemoteMachine(this.host.harness.machine));
        view.setBanner(null);
        view.setFiles([], [], [], 0);
        view.setCommits([], false);
        view.setMessage(isRemoteMachine(this.host.harness.machine) ? fmt(_('Reading the changes from {machine}…'), { machine: this.host.harness.machine }) : _('Reading the changes…'));
        view.showTab('changes');
        this.host.showReview();
        void this.load(generation, { board: boardFile, card: card.text, title: meta.title, agent: meta.agent ?? 'pi', project, folder, branch }, pullFromNotes(card.notes));
        return null;
    }

    private async load(generation: number, card: { board: string; card: string; title: string; agent: string; project: string; folder: string; branch: string }, pull: Open['pull']): Promise<void> {
        const git = this.host.harness.git;
        const found = await findWorktree(git, card.folder, card.branch);
        if (generation !== this.generation) return;
        if (!found.ok) { this.host.reviewView.setMessage(fmt(_('Cannot open the worktree: {error}'), { error: found.message })); return; }
        const read = await readReview(git, found.value);
        if (generation !== this.generation) return;
        if (!read.ok) { this.host.reviewView.setMessage(read.message); return; }
        const review = read.value;
        const forge = await this.originOf(found.value);
        if (generation !== this.generation) return;
        this.current = { ...card, wt: found.value, review, included: review.files.map(() => true), comments: [], selected: 0, lines: [], forge, pull };
        this.render();
    }

    // The project's origin remote, read where the repository is, and whether a pull request can go there.
    private async originOf(wt: Worktree): Promise<ForgeOrigin> {
        const run = await this.host.harness.git(wt.repo, ['remote', 'get-url', 'origin']);
        const url = run?.status === 0 ? run.out.trim() : '';
        if (!url) return { repo: null, why: _('The project has no origin remote to send the branch to') };
        const repo = parseRemote(url);
        if (!repo) return { repo: null, why: _('The origin remote does not look like a hosted repository') };
        const kind = forgeKind(repo.host);
        if (kind === 'github') return { repo: null, why: _('Pull requests on GitHub are not supported yet; Forgejo and Gitea are') };
        if (kind === 'gitlab') return { repo: null, why: _('Pull requests on GitLab are not supported yet; Forgejo and Gitea are') };
        return { repo, why: '' };
    }

    private offer(): PullOffer {
        const c = this.current!;
        if (c.pull) return { enabled: true, label: fmt(_('Open Pull Request #{number}'), { number: c.pull.number }), detail: c.pull.url };
        const label = _('Create Pull Request…');
        if (!c.forge.repo) return { enabled: false, label, detail: c.forge.why };
        if (!c.review.files.length) return { enabled: false, label, detail: _('The agent changed nothing, so there is nothing to send') };
        return { enabled: true, label, detail: fmt(_('Push {branch} to {host} and ask for it to be merged'), { branch: c.wt.branch, host: c.forge.repo.host }) };
    }

    // The run of the card in this window, if there is one (none after a restart without the daemon).
    private run(): Run | null {
        const c = this.current;
        return c ? this.host.harness.orchestrator.queue.find(c.board, c.card) : null;
    }

    private render(): void {
        const c = this.current!;
        const view = this.host.reviewView;
        const machine = isRemoteMachine(this.host.harness.machine) ? fmt(_(' on {machine}'), { machine: this.host.harness.machine }) : '';
        const label = HARNESSES[c.agent]?.label ?? c.agent;
        view.setHeader(c.title, `${label}${machine} · ${c.wt.branch} · ${fmt(_('from {base} at {commit}'), { base: c.wt.base, commit: c.review.mergeBase.slice(0, 7) })}`, c.wt.base, !isRemoteMachine(this.host.harness.machine));
        view.setCommits(c.review.commits, c.review.uncommitted);
        this.renderFiles();
        this.renderBanner();
        view.setReplyCount(c.comments.length);
        view.setPullRequest(this.offer());
        const run = this.run();
        view.setSummary({ answer: run?.result?.summary ?? '', commands: run ? commandsRun(run.trace.events) : [], hasLog: !!run });
        const total = c.review.files.reduce((n, f) => n + f.additions, 0), removed = c.review.files.reduce((n, f) => n + f.deletions, 0);
        view.setStatus(fmt(ngettext('{n} file · +{add} −{del}', '{n} files · +{add} −{del}', c.review.files.length), { n: c.review.files.length, add: total, del: removed }));
        if (c.review.files.length) this.select(c.selected);
    }

    private renderFiles(): void {
        const c = this.current!;
        const counts = c.review.files.map((_f, i) => c.comments.filter(x => x.file === i).length);
        this.host.reviewView.setFiles(c.review.files, c.included, counts, c.selected);
        this.host.reviewView.setIncluded(c.included, this.blocked());
    }

    // The whole branch cannot merge while git says it would conflict; some of its files still may.
    private blocked(): boolean {
        const c = this.current!;
        return !!c.review.conflicts?.length && c.included.every(Boolean);
    }

    private renderBanner(): void {
        const c = this.current!, view = this.host.reviewView, r = c.review;
        const run = this.run();
        const agent = HARNESSES[c.agent]?.label ?? c.agent;
        if (run && isActive(run.status)) view.setBanner(fmt(_('{agent} is still working on this card; what you see may change.'), { agent }));
        else if (r.conflicts?.length) view.setBanner(fmt(ngettext('{base} moved on by {n} commit, and merging would conflict in {files}.', '{base} moved on by {n} commits, and merging would conflict in {files}.', r.behind), { base: c.wt.base, n: r.behind, files: r.conflicts.join(', ') }), fmt(_('Ask {agent} to Update Its Branch'), { agent }));
        else if (r.behind) view.setBanner(fmt(ngettext('{base} moved on by {n} commit since; this still merges cleanly.', '{base} moved on by {n} commits since; this still merges cleanly.', r.behind), { base: c.wt.base, n: r.behind }));
        else view.setBanner(null);
    }

    private select(index: number): void {
        const c = this.current;
        const file = c?.review.files[index];
        if (!c || !file) return;
        c.selected = index;
        c.lines = file.binary ? [] : parseDiff(file.part);
        const view = this.host.reviewView;
        if (file.binary) { view.setMessage(_('A binary file: there is no text to compare.')); return; }
        if (!c.lines.length) { view.setMessage(file.status === 'renamed' ? fmt(_('Renamed from {old}, unchanged.'), { old: file.oldPath ?? '' }) : _('No change in the text (only its mode).')); return; }
        view.setDiff(c.lines, c.comments.filter(x => x.file === index).map(x => x.index));
        view.showTab('changes');
    }

    private include(index: number, included: boolean): void {
        const c = this.current;
        if (!c) return;
        c.included[index] = included;
        this.host.reviewView.setIncluded(c.included, this.blocked());
    }

    private tab(tab: ReviewTab): void {
        if (tab === 'changes') this.select(this.current?.selected ?? 0);
        else this.host.reviewView.showTab(tab);
    }

    private comment(line: number, text: string): void {
        const c = this.current;
        const file = c?.review.files[c.selected];
        if (!c || !file) return;
        c.comments.push({ file: c.selected, index: line, path: file.path, line: newLineNumbers(c.lines)[line], quote: c.lines[line]?.text ?? '', text });
        this.renderFiles();
        this.host.reviewView.setReplyCount(c.comments.length);
        this.select(c.selected);
    }

    // The reply goes to the harness in the same worktree: the user's comments, which they can edit, and anything else.
    private reply(): void {
        const c = this.current;
        if (!c) return;
        const agent = HARNESSES[c.agent]?.label ?? c.agent;
        void Promise.resolve(this.host.harness.dialogs.text({
            title: fmt(_('Reply to {agent}'), { agent }),
            label: fmt(_('{agent} goes on in the same worktree; the card goes back to being worked on.'), { agent }),
            text: commentsReply(c.comments),
        })).then(text => {
            if (!text) return;
            this.continueWith(text);
        });
    }

    private continueWith(text: string): void {
        const c = this.current;
        if (!c) return;
        const card = this.cardNow();
        if (!card) { this.host.toast(_('The card is not on its board any more')); return; }
        const error = this.host.harness.orchestrator.continueInWorktree(c.board, card, c.wt, c.agent, c.project, c.folder, text, platform().paths.basename(c.board));
        if (error) { this.host.toast(fmt(_('Cannot reply: {error}'), { error })); return; }
        c.comments = [];
        this.close();
    }

    // The base moved on and the branch conflicts with it: the harness is asked to bring its branch up to date.
    private askToUpdate(): void {
        const c = this.current;
        if (!c?.review.conflicts?.length) return;
        this.continueWith(`The branch ${c.wt.base} moved on since you started, and merging your branch into it would conflict in ${c.review.conflicts.join(', ')}. `
            + `Merge ${c.wt.base} into your branch (git merge ${c.wt.base}), resolve the conflicts so both changes are kept, run the checks again, and commit.`);
    }

    // The card as it is on its board now, found by the text it had when the review opened.
    private cardNow(): Card | null {
        const c = this.current!;
        let text: string;
        try { text = docFor(this.host, c.board)?.editor.getText() ?? readTextFile(c.board); } catch { return null; }
        const board = parseBoard(text);
        const at = locateCard(board, c.card);
        return at ? board.columns[at.column].cards[at.index] : null;
    }

    private async finish(action: FinishAction): Promise<void> {
        const c = this.current;
        if (!c) return;
        const run = this.run();
        if (run && isActive(run.status)) { this.host.toast(_('Wait until the agent has finished, or stop it first')); return; }
        if (action === 'discard') return this.discard(c);
        if (action === 'keep') return this.keep(c);
        const files = c.included.every(Boolean) ? null : c.review.files.filter((_f, i) => c.included[i]);
        const partial = files ? fmt(_('Only {count} of {all} files are taken; the others stay out.'), { count: files.length, all: c.review.files.length }) : null;
        if (!await this.dialogs.merge({
            message: fmt(_('Merge “{title}” into {base}?'), { title: c.title, base: c.wt.base }),
            detail: [action === 'squash' || partial ? _('Everything becomes one commit on the base branch of the project folder.') : _('A merge commit joins the branch to the base branch of the project folder.'),
                partial, _('The worktree is removed afterwards.')].filter(Boolean).join(' '),
            accept: _('Merge'),
        })) return;
        const generation = this.generation;
        this.host.reviewView.setBusy(true, _('Merging…'));
        const keepBranch = this.host.harness.isolation(c.project).afterMerge === 'keep-branch';
        const merged = await mergeWorktree(this.host.harness.git, c.wt, { method: action, files, message: c.title, keepBranch });
        if (generation !== this.generation) return;
        this.host.reviewView.setBusy(false);
        if (!merged.ok) {
            this.host.reviewView.setIncluded(c.included, this.blocked());
            this.host.toast(fmt(_('Not merged: {error}'), { error: merged.message }));
            return;
        }
        const how = files ? fmt(_('{count} of {all} files'), { count: files.length, all: c.review.files.length }) : action === 'squash' ? _('squashed') : _('merge commit');
        this.closed(c, `↳ merged into ${c.wt.base} ${this.host.harness.orchestrator.stamp()} (${how}, ${merged.value.slice(0, 7)})`, true);
        this.host.record('harness', worktreeActivity(c.title, c.project, { merged: c.wt.base }));
        this.host.toast(fmt(_('Merged “{title}” into {base}'), { title: c.title, base: c.wt.base }));
    }

    // Sends the branch to the forge and opens a pull request. Nothing leaves this computer before the user has confirmed the
    // dialog; the questions before it only read from the server. The worktree stays, and so does the card in Review, so the
    // user can reply to the comments the pull request gets. A step that fails leaves both as they were.
    private async pullRequest(): Promise<void> {
        const c = this.current;
        if (!c) return;
        if (c.pull) { this.host.openUri(c.pull.url); return; }
        const repo = c.forge.repo, offer = this.offer();
        if (!repo || !offer.enabled) { this.host.toast(offer.detail); return; }
        const run = this.run();
        if (run && isActive(run.status)) { this.host.toast(_('Wait until the agent has finished, or stop it first')); return; }
        const generation = this.generation;
        const view = this.host.reviewView;
        view.setBusy(true, fmt(_('Asking {host}…'), { host: repo.host }));
        const ready = await this.askServer(repo);
        if (generation !== this.generation) return;
        view.setBusy(false);
        if (typeof ready === 'string') { this.host.toast(ready); return; }
        const answer = await this.dialogs.pullRequest({
            repository: `${repo.owner}/${repo.repo}`, host: repo.host, base: c.wt.base, branch: c.wt.branch, title: c.title,
            body: pullRequestBody(run?.result?.summary ?? '', c.review.commits, c.review.uncommitted), canPush: ready.canPush, uncommitted: c.review.uncommitted,
        });
        if (!answer || generation !== this.generation) return;
        view.setBusy(true, _('Sending…'));
        const sent = await this.publish(c, repo, ready, answer);
        if (generation !== this.generation) return;
        view.setBusy(false);
        if (!sent.ok) this.host.toast(fmt(_('Not sent: {error}'), { error: sent.message }));
        else this.sent(c, sent.pull);
    }

    // The leftovers are committed, the branch is pushed, the pull request is opened; when the push fails the commit is taken back.
    private async publish(c: Open, repo: RepoRef, ready: { provider: GiteaProvider; token: string }, answer: PullRequestAnswer): Promise<PublishResult> {
        const git = this.host.harness.git;
        const committed = await commitLeftovers(git, c.wt, answer.title);
        if (!committed.ok) return { ok: false, message: committed.message, pushed: false };
        const sent = await publishBranch({ provider: ready.provider, repo, token: ready.token, git }, {
            cwd: c.wt.path, branch: c.wt.branch, base: c.wt.base, title: answer.title, body: answer.body, via: answer.via,
        });
        if (!sent.ok && !sent.pushed && committed.value) await uncommitLeftovers(git, c.wt);
        return sent;
    }

    // The checks that only read from the server: the server is a Forgejo or Gitea, the user has a token for it, the token
    // sees the repository. Returns what sending needs, or a sentence for the user.
    private async askServer(repo: RepoRef): Promise<{ provider: GiteaProvider; token: string; canPush: boolean } | string> {
        const saved = await this.services.tokens.get(repo.host);
        if (!saved) return fmt(_('Add an access token for {host} first: open the project folder and use “Connect to a server…” in the Pull Requests tab.'), { host: repo.host });
        if (!await isGiteaServer(repo, saved.token, this.services.transport)) return fmt(_('{host} does not look like a Forgejo or Gitea server.'), { host: repo.host });
        const provider = new GiteaProvider(repo, saved.token, this.services.transport);
        try {
            const info = await provider.repoInfo();
            if (!info) return _('The server does not know this repository, or the token cannot see it.');
            return { provider, token: saved.token, canPush: info.canPush };
        } catch (e) {
            return e instanceof ForgeError || e instanceof Error ? e.message : String(e);
        }
    }

    private sent(c: Open, pull: { number: number; url: string } | null): void {
        const orchestrator = this.host.harness.orchestrator;
        const note = pull ? pullNote(pull.number, pull.url, orchestrator.stamp()) : `↳ branch ${c.wt.branch} sent for review ${orchestrator.stamp()}`;
        const error = orchestrator.noteCard(c.board, c.card, note);
        if (error) this.host.toast(fmt(_('The card was not updated: {error}'), { error }));
        this.host.record('harness', worktreeActivity(c.title, c.project, { pull: pull?.url ?? c.wt.branch }));
        if (!pull) { this.host.toast(fmt(_('Sent {branch}; the pull request appears in the list on the server shortly'), { branch: c.wt.branch })); return; }
        c.pull = pull;
        this.host.reviewView.setPullRequest(this.offer());
        this.host.toast(fmt(_('Opened pull request #{number}'), { number: pull.number }), { label: _('Open'), run: () => this.host.openUri(pull.url) });
    }

    private async keep(c: Open): Promise<void> {
        const removed = await removeWorktree(this.host.harness.git, c.wt, true);
        if (!removed.ok) { this.host.toast(removed.message); return; }
        this.closed(c, `↳ worktree removed ${this.host.harness.orchestrator.stamp()}; the branch ${c.wt.branch} is kept`, false);
        this.host.toast(fmt(_('The branch {branch} is kept; its worktree is removed'), { branch: c.wt.branch }));
    }

    private async discard(c: Open): Promise<void> {
        if (!await this.dialogs.discard({
            message: fmt(_('Discard the Work on “{title}”?'), { title: c.title }),
            detail: fmt(_('The worktree and the branch {branch} are deleted, with every change in them. The project folder is not touched.'), { branch: c.wt.branch }),
            accept: _('Discard'), destructive: true,
        })) return;
        const removed = await removeWorktree(this.host.harness.git, c.wt);
        if (!removed.ok) { this.host.toast(removed.message); return; }
        this.closed(c, `↳ ${HARNESSES[c.agent]?.label ?? c.agent}'s work discarded ${this.host.harness.orchestrator.stamp()}`, false);
        this.host.record('harness', worktreeActivity(c.title, c.project, { discarded: true }));
        this.host.toast(fmt(_('The work on “{title}” was discarded'), { title: c.title }));
    }

    // The worktree is gone: the card forgets its branch and gets a note; the review closes.
    private closed(c: Open, note: string, merged: boolean): void {
        const error = this.host.harness.orchestrator.closeWorktree(c.board, c.card, note, merged);
        if (error) this.host.toast(fmt(_('The card was not updated: {error}'), { error }));
        this.close();
    }

    private openFolder(): void {
        const c = this.current;
        if (!c) return;
        this.host.openFolder(c.wt.cwd);
    }

    // A terminal in the worktree: here, or through ssh on the agents' machine.
    private openTerminal(): void {
        const c = this.current;
        if (!c) return;
        const machine = this.host.harness.machine;
        const target = isRemoteMachine(machine) ? this.host.settings.machines[machine] : null;
        const inside = target ? ['ssh', '-t', '--', target, `cd '${c.wt.cwd.replace(/'/g, `'\\''`)}' && exec "$SHELL" -l`] : null;
        if (platform().processes.openTerminal(c.wt.cwd, inside)) return;
        this.host.toast(target ? fmt(_('No terminal found; run: ssh -t {target} and cd {path}'), { target, path: c.wt.cwd }) : fmt(_('No terminal found; the worktree is {path}'), { path: c.wt.cwd }));
    }

    close(): void {
        this.generation++;
        this.current = null;
        this.host.showDocument();
    }
}
