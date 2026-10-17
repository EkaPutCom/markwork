// Reviewing a card's worktree: opens it in the content area, reads what the harness changed with git (on this computer
// or through the daemon on the agents' machine), collects the user's comments on the diff, and on request replies to
// the harness, merges the work into the base branch, keeps only the branch, or discards it. The card is found again
// by its `[branch:: …]` field, so a review works after Markwork was restarted too.

import { HARNESSES, cardProject, isActive, locateCard, type Run } from '../agent/harness.js';
import { isRemoteMachine } from '../agent/daemon/machines.js';
import { findWorktree, removeWorktree, type Worktree } from '../agent/worktree.js';
import { commandsRun, commentsReply, mergeWorktree, newLineNumbers, readReview, type ChangedFile, type Commit, type LineComment, type MergeMethod, type RanCommand, type Review } from '../agent/worktreereview.js';
import { parseDiff, type DiffLine } from '../gitlog.js';
import { worktreeActivity, type ActivityKind } from '../markdown/journal.js';
import { cardBranch, cardMeta, parseBoard, type Board, type Card } from '../markdown/kanban.js';
import { readTextFile } from '../files.js';
import { platform, type OS } from '../platform/index.js';
import type { AppSettings } from '../settings.js';
import { _, fmt, ngettext } from '../i18n.js';
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
    setBanner(title: string | null, button?: string | null): void;
}

// The confirmations before merging or discarding; tests replace them with immediate answers.
export interface ReviewDialogs {
    merge(question: Question): Promise<boolean>;
    discard(question: Question): Promise<boolean>;
}

export interface ReviewHost extends DocumentHost {
    readonly reviewView: ReviewView;
    showReview(): void;                // the content area shows the review page
    openFolder(path: string): void;    // in the file manager
    readonly settings: AppSettings;
    readonly harness: Pick<HarnessController, 'orchestrator' | 'git' | 'machine' | 'machineLabel' | 'folderOf' | 'isolation' | 'showLog' | 'dialogs'>;
    showDocument(): void;
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
}

export class HarnessReviewController {
    private current: Open | null = null;
    private generation = 0;    // answers for a review that is no longer shown are dropped
    // Runs a terminal; tests replace it.
    launch: (argv: string[]) => boolean = argv => platform().processes.launch(argv);

    // dialogs: the frontend's confirmations; tests replace them with immediate answers.
    constructor(private readonly host: ReviewHost, public dialogs: ReviewDialogs) {
        const view = host.reviewView;
        view.onClose = () => this.close();
        view.onSelect = index => this.select(index);
        view.onInclude = (index, included) => this.include(index, included);
        view.onTab = tab => this.tab(tab);
        view.onComment = (line, text) => this.comment(line, text);
        view.onReply = () => this.reply();
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
        void this.load(generation, { board: boardFile, card: card.text, title: meta.title, agent: meta.agent ?? 'pi', project, folder, branch });
        return null;
    }

    private async load(generation: number, card: { board: string; card: string; title: string; agent: string; project: string; folder: string; branch: string }): Promise<void> {
        const git = this.host.harness.git;
        const found = await findWorktree(git, card.folder, card.branch);
        if (generation !== this.generation) return;
        if (!found.ok) { this.host.reviewView.setMessage(fmt(_('Cannot open the worktree: {error}'), { error: found.message })); return; }
        const read = await readReview(git, found.value);
        if (generation !== this.generation) return;
        if (!read.ok) { this.host.reviewView.setMessage(read.message); return; }
        const review = read.value;
        this.current = { ...card, wt: found.value, review, included: review.files.map(() => true), comments: [], selected: 0, lines: [] };
        this.render();
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
        for (const [program, ...args] of terminals(platform().os, c.wt.cwd, inside)) {
            if (platform().processes.findProgram(program) && this.launch([program, ...args])) return;
        }
        this.host.toast(target ? fmt(_('No terminal found; run: ssh -t {target} and cd {path}'), { target, path: c.wt.cwd }) : fmt(_('No terminal found; the worktree is {path}'), { path: c.wt.cwd }));
    }

    close(): void {
        this.generation++;
        this.current = null;
        this.host.showDocument();
    }
}

// The terminals to try, in order, each with a folder to start in, or a command to run (ssh to the agents' machine). Linux
// has the GNOME ones; macOS has Terminal; Windows has Windows Terminal, then a console window of cmd.
export function terminals(os: OS, folder: string, command: string[] | null): string[][] {
    if (os === 'darwin') {
        const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
        const script = command ? command.map(quote).join(' ') : `cd ${quote(folder)}`;
        const apple = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return [['osascript', '-e', `tell application "Terminal" to do script "${apple}"`, '-e', 'tell application "Terminal" to activate']];
    }
    if (os === 'win32') {
        return command
            ? [['wt.exe', ...command], ['cmd.exe', '/c', 'start', '', ...command]]
            : [['wt.exe', '-d', folder], ['cmd.exe', '/c', 'start', '', '/D', folder, 'cmd.exe']];
    }
    return command
        ? [['kgx', '--', ...command], ['ptyxis', '--', ...command], ['gnome-terminal', '--', ...command], ['xdg-terminal-exec', ...command]]
        : [['kgx', `--working-directory=${folder}`], ['ptyxis', `--working-directory=${folder}`], ['gnome-terminal', `--working-directory=${folder}`], ['xdg-terminal-exec', `--dir=${folder}`]];
}
