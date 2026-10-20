// External harnesses (@pi cards): the card menu, choosing the project folder, answering/steering/replying to a run,
// and its log window. The runs themselves are managed by the Orchestrator this controller owns.

import { fileExists, insideName, readTextFile } from '../files.js';
import { platform } from '../platform/index.js';
import type { AppSettings } from '../settings.js';
import { findProgram, labelWorktree, Orchestrator, spawnHarness, type AdoptInfo } from '../orchestrator.js';
import { runGit } from '../git.js';
import { parseIsolation, type Isolation } from '../agent/worktree.js';
import type { GitRunner } from '../forge/contribute.js';
import { cardProject, checkProjectFolder, HARNESSES, isActive, locateCard as findCard, PROJECT_NAME, type HarnessAsk, type HarnessReply, type LinkedNote, type Run, type RunStatus } from '../agent/harness.js';
import { isRemoteMachine, LOCAL_MACHINE, machineProjectKey } from '../agent/daemon/machines.js';
import type { ConnectionState } from '../agent/daemon/connection.js';
import type { RunSummary } from '../agent/daemon/protocol.js';
import { openCommandLink, openSocketLink } from '../agent/daemon/streamlink.js';
import { DaemonHub, type Openers } from '../daemonhub.js';
import { adoptRun, daemonGit, daemonSpawner } from '../orchestratordaemon.js';
import type { MenuEntry } from './menu.js';
import { TraceFeed, type TraceUpdate } from '../agent/tracefeed.js';
import { harnessActivity, type ActivityKind } from '../markdown/journal.js';
import { assignCard, cardBranch, cardMeta, parseBoard, updateCard, type Board, type Card, type Position } from '../markdown/kanban.js';
import { noteSection, resolveWikiLink, type WikiLink } from '../markdown/wikilink.js';
import type { WorkspaceRepository } from '../workspace.js';
import { _, fmt } from '../i18n.js';
import type { Prompt } from './dialogs.js';
import { docFor, type DocumentHost } from './document.js';

// The run of a card on the board that is shown, for its badge: the card is named by its text.
export interface CardRun {
    card: string;
    status: RunStatus;
}

// The board on screen, as far as harness runs need it. The runs come with the board as data; a card's menu is asked for
// when the user opens it, and answered with entries whose action stays here (a token).
export interface HarnessBoard {
    setRuns(runs: readonly CardRun[]): void;   // the runs of the board's cards, when the board is shown and when one changes
    onCardMenu: (card: Card, at: Position) => Promise<HarnessMenuEntry[]>;
    onRunMenu: (token: number) => void;
}

// One entry of a card's menu as the board view gets it: the menu is the core's, the entry is chosen by its token (runMenu).
export interface HarnessMenuEntry {
    label: string;
    enabled?: boolean;
    token: number;
}

// A run's log window; one per run, raised again when it is already open.
// The frontend keeps a copy of the log (a TraceReplica) and is sent updates while its window is open.
export interface HarnessLogs {
    onClear: (runId: number) => void;       // the viewer asked for the log to be cleared
    onClosed: (runId: number) => void;      // the log window was closed
    show(runId: number, title: string): void;
    update(runId: number, update: TraceUpdate): void;
}

// What closing the window does with agents that are still working.
export type CloseAgentsChoice = 'cancel' | 'stop' | 'keep';

// The questions harness work asks the user; each answers null (or 'cancel') when dismissed.
export interface HarnessDialogs {
    chooseFolder(title: string): Promise<string | null>;
    answer(ask: HarnessAsk, agent: string): Promise<HarnessReply | null>;
    text(options: { title: string; label: string; context?: string; text?: string }): Promise<string | null>;
    // The folder of a project on another machine, which cannot be browsed from here.
    remoteFolder(prompt: Prompt): Promise<string | null>;   // the folder of a project on a remote machine (an absolute path)
    closeAgents(activity: { children: number; detachable: number; queued: number }): Promise<CloseAgentsChoice>;
}

export interface HarnessHost extends DocumentHost {
    readonly settings: AppSettings;
    readonly board: HarnessBoard;
    boardNow(): Board;                    // the board of the active document
    commitBoard(board: Board): void;      // a change made from the card menu: shown on the board and written (one undo step)
    readonly logs: HarnessLogs;
    readonly workspace: WorkspaceRepository;
    boardShown(file: string): boolean;    // the board in `file` is the one on screen
    updateBoardFile(file: string, edit: (board: Board) => Board): string | null;
    record(kind: ActivityKind, text: string): void;
    refreshHome(): void;
}

// The state of the connection to the machine the agents run on, for Home.
export interface AgentHostStatus {
    label: string;                          // "this computer", or the name of the machine
    state: ConnectionState;
    detail: string;                         // why it cannot connect, when it cannot
}

const LABEL_CARD_CHARS = 4000;   // see spawnMeta() in orchestrator.ts: a longer card is matched by its start

export class HarnessController {
    readonly orchestrator: Orchestrator;
    readonly hub: DaemonHub;
    // How links to the daemons are made; tests give their own to the constructor, or replace them later.
    openers: Openers;
    // Opens the review of a card's worktree; the window connects it.
    onReview: (file: string, card: Card, board: Board) => void = () => {};
    private following: string | null = null;        // the machine whose runs are watched
    private unwatch: (() => void) | null = null;
    private adoptMachine = '';
    private stopOnClose = false;
    private readonly trouble = new Set<string>();    // machines whose connection trouble the user was told about
    private readonly logged = new WeakSet<object>();   // results already recorded in the activity log

    // dialogs: the frontend's questions; tests replace them with immediate answers.
    // openers: given before anything connects, since the window's folder is followed while it is being built.
    constructor(private readonly host: HarnessHost, public dialogs: HarnessDialogs, openers: Openers = { socket: openSocketLink, command: openCommandLink }) {
        this.openers = openers;
        host.logs.onClear = runId => this.orchestrator.queue.runs.find(r => r.id === runId)?.trace.clear();
        host.logs.onClosed = runId => this.stopLog(runId);
        host.board.onCardMenu = async (card, at) => this.menu(card, at);
        host.board.onRunMenu = token => this.runMenu(token);
        this.orchestrator = new Orchestrator({
            workspace: () => host.root(),
            updateBoard: (file, edit) => host.updateBoardFile(file, edit),
            linkedNotes: (file, links) => this.linkedNotes(file, links),
            changed: (run, message) => {
                if (run.result && (run.status === 'done' || run.status === 'failed') && !this.logged.has(run.result)) {
                    this.logged.add(run.result);
                    host.record('harness', harnessActivity(HARNESSES[run.agent]?.label ?? run.agent, run.title, run.project, run.status === 'done'));
                }
                if (host.boardShown(run.board)) host.board.setRuns(this.runsOf(run.board));
                host.refreshHome();
                if (message) host.toast(message, run.worktree && run.status === 'done' ? { label: _('Review'), run: () => this.review(run) } : undefined);
            },
            notify: message => host.toast(message),
        });
        const settings = host.settings;
        this.hub = new DaemonHub({ machines: () => settings.machines, daemonCommand: () => settings.daemonCommand }, { socket: path => this.openers.socket(path), command: argv => this.openers.command(argv) });
        // With a machine chosen, the harness runs in the markworkd daemon there, which resolves the program by name.
        this.orchestrator.program = spec => this.machine ? spec.program : findProgram(spec.program);
        this.orchestrator.spawn = (argv, cwd, handlers, meta) => this.machine
            ? daemonSpawner(this.hub.connection(this.machine))(argv, cwd, handlers, meta)
            : spawnHarness(argv, cwd, handlers);
        this.orchestrator.git = (cwd, args) => this.git(cwd, args);
        this.orchestrator.isolation = (project, folder) => this.isolationOf(project, folder);
        this.orchestrator.adopter = (runId, upTo, handlers) => adoptRun(this.hub.connection(this.adoptMachine), runId, 1, handlers, {}, upTo);
        this.orchestrator.localFolders = !isRemoteMachine(this.machine);
        this.hub.onState((machine, state, detail) => this.machineState(machine, state, detail));
        settings.onChanged(['harness-machine', 'machines', 'daemon-command'], () => this.machineSettingsChanged());
    }

    // Where harnesses run: '' = children of this window, 'local' = the daemon on this computer, else an SSH machine.
    get machine(): string { return this.host.settings.harnessMachine; }

    // Git where the project folders are: on this computer (also when the daemon here runs the agents), or through
    // the daemon on an SSH machine.
    readonly git: GitRunner = (cwd, args) => isRemoteMachine(this.machine) ? daemonGit(this.hub.connection(this.machine))(cwd, args) : runGit(cwd, args);

    // The project's key in the settings: its name here, "machine:project" on another machine.
    projectKey(project: string): string {
        return isRemoteMachine(this.machine) ? machineProjectKey(this.machine, project) : project;
    }

    isolation(project: string): Isolation {
        return parseIsolation(this.host.settings.projectOptions[this.projectKey(project)]);
    }

    // A folder on this computer that is in no Git repository works as it always did, without asking git; one on
    // another machine is asked, and falls back the same way when git says it is not a repository.
    private isolationOf(project: string, folder: string): Isolation | null {
        const isolation = this.isolation(project);
        if (!isolation.worktrees) return null;
        return isRemoteMachine(this.machine) || inRepository(folder) ? isolation : null;
    }

    machineLabel(machine: string): string { return machine === LOCAL_MACHINE ? _('this computer') : machine; }

    // The connection to the machine agents run on, for Home; null when they run as children of this window.
    hostStatus(): AgentHostStatus | null {
        const machine = this.machine;
        if (!machine) return null;
        const known = this.hub.state(machine);
        return { label: this.machineLabel(machine), state: known?.state ?? 'idle', detail: known?.detail ?? '' };
    }

    private machineSettingsChanged(): void {
        this.hub.refresh();
        this.orchestrator.localFolders = !isRemoteMachine(this.machine);
        this.reconnect();
        this.host.refreshHome();
    }

    private machineState(machine: string, state: ConnectionState, detail: string): void {
        this.host.refreshHome();
        const label = this.machineLabel(machine);
        if (state === 'waiting' || state === 'failed') {
            if (this.trouble.has(machine)) return;
            this.trouble.add(machine);
            this.host.toast(fmt(_('Cannot reach {machine}: {detail}'), { machine: label, detail }));
        } else if (state === 'ready' && this.trouble.delete(machine)) {
            this.host.toast(fmt(_('Connected to {machine} again'), { machine: label }));
        }
    }

    // Watches the machine agents run on. Every time it connects, the runs it already has for our cards are followed
    // again: they went on while Markwork was closed (or the link was down), and what they did is in their log.
    reconnect(): void {
        const machine = this.machine;
        if (this.following === machine) return;
        this.unwatch?.();
        this.unwatch = null;
        this.following = null;
        if (!machine) return;
        try {
            const conn = this.hub.connection(machine);
            this.following = machine;
            this.unwatch = conn.watch({ snapshot: runs => this.adoptAll(machine, runs), state: () => {} });
        } catch (e) {
            this.host.toast(e instanceof Error ? e.message : String(e));
        }
    }

    // The work folder changed: runs left going for the boards of the new folder are followed too (the other folder's wait
    // on the daemon until it is shown again).
    folderChanged(): void {
        this.following = null;
        this.reconnect();
    }

    private adoptAll(machine: string, runs: RunSummary[]): void {
        this.adoptMachine = machine;
        for (const summary of runs) {
            const info = this.adoptInfo(machine, summary);
            if (!info) continue;
            const error = this.orchestrator.adopt(info);
            if (error) this.host.toast(fmt(_('Cannot follow {agent} again: {error}'), { agent: info.agent, error }));
        }
        this.host.refreshHome();
    }

    // Started from this computer, for a board of the work folder (not one of another folder or computer).
    private startedHere(labels: Record<string, string>): boolean {
        if (labels.host && labels.host !== platform().processes.hostName()) return false;
        const root = this.host.root();
        return !root || insideName(root, labels.board) !== null;
    }

    // A run on the daemon that is for a card of ours, on a board of the work folder: it carries the board, the card, and the computer that started it.
    private adoptInfo(machine: string, run: RunSummary): AdoptInfo | null {
        const l = run.labels ?? {};
        if (!l.agent || !l.board || !l.card || !HARNESSES[l.agent] || !this.startedHere(l)) return null;
        const card = this.cardText(l.board, l.card);
        if (!card || this.orchestrator.queue.active(l.board, card)) return null;
        const slots = Number(l.slots);
        return {
            runId: run.run, lastSeq: run.last_seq, board: l.board, card, title: l.title || cardMeta(card).title, agent: l.agent, project: l.project ?? '', folder: run.cwd,
            lane: l.lane || run.cwd, slots: Number.isInteger(slots) && slots > 0 ? slots : 1, worktree: labelWorktree(l, run.cwd), machine: this.machineLabel(machine),
        };
    }

    // The text of the card on the board that a run was started for, or null if the board or the card is gone.
    private cardText(boardFile: string, label: string): string | null {
        let text: string;
        try { text = docFor(this.host, boardFile)?.editor.getText() ?? readTextFile(boardFile); } catch { return null; }
        const cards = parseBoard(text).columns.flatMap(c => c.cards);
        const exact = cards.find(c => c.text === label);
        if (exact) return exact.text;
        return label.length >= LABEL_CARD_CHARS ? cards.find(c => c.text.startsWith(label))?.text ?? null : null;
    }

    // Asked when the window closes while agents work. false = the user cancelled.
    async confirmClose(): Promise<boolean> {
        const activity = this.orchestrator.activity();
        if (!activity.children && !activity.detachable) return true;
        const choice = await this.dialogs.closeAgents(activity);
        this.stopOnClose = choice === 'stop';
        return choice !== 'cancel';
    }

    // The status of the run for a card on the board that is shown, for its badge.
    status(card: Card): Run['status'] | null {
        const file = this.host.active().file;
        return (file && this.orchestrator.queue.find(file, card.text)?.status) || null;
    }

    // The runs of the cards of board `file`, one per card: its active run, or else its latest (as status() picks).
    runsOf(file: string): CardRun[] {
        const cards = new Set(this.orchestrator.queue.runs.filter(r => r.board === file).map(r => r.card));
        return [...cards].map(card => ({ card, status: this.orchestrator.queue.find(file, card)!.status }));
    }

    // Notes linked by the cards on the board `boardFile`, for the harness prompt context. Looked up with the same rules
    // as Ctrl+click; the document that is currently open is read from its editor so unsaved edits are included.
    private linkedNotes(boardFile: string, links: WikiLink[]): LinkedNote[] {
        const workspace = this.host.root();
        const root = workspace && insideName(workspace, boardFile) !== null ? workspace : platform().paths.dirname(boardFile);
        const from = insideName(root, boardFile) ?? platform().paths.basename(boardFile);
        const files = this.host.workspace.names(root);
        return links.map(link => {
            const file = resolveWikiLink(link.target, files, from);
            if (!file) return { link, file: null, text: null };
            const path = platform().paths.join(root, ...file.split('/'));
            let text: string;
            try {
                text = docFor(this.host, path)?.editor.getText() ?? readTextFile(path);
            } catch {
                return { link, file: null, text: null };
            }
            return { link, file, text: link.heading ? noteSection(text, link.heading) : text };
        });
    }

    // Card menu entries to assign, stop, and monitor harnesses. An entry is chosen with runMenu(token); the tokens of the
    // menu before this one are forgotten, as the board view only offers the latest.
    menu(card: Card, at: Position): HarnessMenuEntry[] {
        const entries = this.menuEntries(card, at);
        this.menuActions.clear();
        return entries.map(({ label, enabled, run }) => {
            const token = ++this.lastMenuToken;
            if (run) this.menuActions.set(token, run);
            return enabled === undefined ? { label, token } : { label, enabled, token };
        });
    }

    private readonly menuActions = new Map<number, () => void>();
    private lastMenuToken = 0;

    runMenu(token: number): void {
        this.menuActions.get(token)?.();
    }

    private menuEntries(card: Card, at: Position): MenuEntry[] {
        const file = this.host.active().file;
        const run = file ? this.orchestrator.queue.find(file, card.text) : null;
        const active = run && isActive(run.status) ? run : null;
        const review: MenuEntry[] = file && cardBranch(card.text) && !active
            ? [{ label: _('Review Changes'), run: () => this.onReview(file, card, this.host.boardNow()) }] : [];
        return [...review, ...this.assignEntries(card, at, !!file && !active), ...(run ? this.runEntries(run, active) : []), ...this.cardEntries(card, at, !active)];
    }

    // Opens the review of a finished run's card, found on its board by the text it has now.
    private review(run: Run): void {
        let text: string;
        try { text = docFor(this.host, run.board)?.editor.getText() ?? readTextFile(run.board); } catch { return; }
        const board = parseBoard(text);
        const at = findCard(board, run.card);
        if (at) this.onReview(run.board, board.columns[at.column].cards[at.index], board);
    }

    // "Work on it with …" for every harness; only on a saved board, for a card that is not done or already running.
    private assignEntries(card: Card, at: Position, free: boolean): MenuEntry[] {
        return Object.values(HARNESSES).map(spec => ({
            label: fmt(_('Work on it with {label}'), { label: spec.label }),
            enabled: free && card.done !== true,
            run: () => this.run(at, spec.name),
        }));
    }

    // The card's run: answer or steer it while it is going, reply after it finished, stop it, and view its log.
    private runEntries(run: Run, active: Run | null): MenuEntry[] {
        const entries: MenuEntry[] = [];
        if (active?.status === 'waiting') entries.push({ label: fmt(_('Answer {agent}…'), { agent: active.agent }), run: () => this.answer(active) });
        if (active?.status === 'working') entries.push({ label: fmt(_('Steer {agent}…'), { agent: active.agent }), run: () => this.steer(active) });
        if (!active && run.result?.interrupted) entries.push({ label: fmt(_('Resume {agent}'), { agent: run.agent }), run: () => this.resumeInterrupted(run) });
        if (!active && run.result?.sessionId) entries.push({ label: fmt(_('Reply to {agent}…'), { agent: run.agent }), run: () => this.reply(run) });
        if (active) entries.push({ label: active.status === 'queued' ? _('Cancel Queue') : fmt(_('Stop {agent}'), { agent: active.agent }), run: () => this.orchestrator.stop(active) });
        entries.push({ label: fmt(_('View {agent} Log'), { agent: run.agent }), run: () => this.showLog(run) });
        return entries;
    }

    // Removing an assignment (when nothing runs) and changing the card's remembered project folder.
    private cardEntries(card: Card, at: Position, idle: boolean): MenuEntry[] {
        const entries: MenuEntry[] = [];
        if (cardMeta(card.text).agent && idle) entries.push({ label: _('Remove Assignment'), run: () => this.host.commitBoard(updateCard(this.host.boardNow(), at, { text: assignCard(card.text, null) })) });
        const project = cardProject(this.host.boardNow(), card);
        if (project && this.folderOf(project)) entries.push({ label: _('Change Project Folder…'), run: () => this.chooseProjectFolder(project) });
        return entries;
    }

    // Run a harness for a card on the active board. The project folder is asked once and then remembered in the settings.
    run(at: Position, agent: string): void {
        const file = this.host.active().file;
        if (!file) { this.host.toast(_('Save the board first before assigning cards')); return; }
        const card = this.host.boardNow().columns[at.column]?.cards[at.index];
        if (!card) return;
        const project = cardProject(this.host.boardNow(), card);
        if (project && this.folderOf(project)) {
            this.start(file, at, agent, project);
            return;
        }
        void this.chooseProjectFolder(project).then(folder => {
            if (!folder) return;
            // The folder dialog can stay open for a long time: the assigned card must still be on the same board.
            if (this.host.active().file !== file || this.host.boardNow().columns[at.column]?.cards[at.index]?.text !== card.text) {
                this.host.toast(_('The board changed while choosing a folder; assign the card again'));
                return;
            }
            if (!project) {
                // No project name yet: use the folder name and note it on the card so the next turn does not ask again.
                const tagged = `${card.text} #project/${folder.name}`;
                this.host.commitBoard(updateCard(this.host.boardNow(), at, { text: tagged }));
            }
            this.start(file, at, agent, project ?? folder.name);
        });
    }

    private start(file: string, at: Position, agent: string, project: string): void {
        const error = this.orchestrator.start(file, this.host.boardNow(), at, agent, project, this.folderOf(project)!, platform().paths.basename(file));
        if (error) this.host.toast(fmt(_('Cannot run {agent}: {error}'), { agent, error }));
    }

    // The folder of a project on the machine agents run on (this computer unless an SSH machine is chosen).
    folderOf(project: string): string | undefined {
        const machine = this.machine;
        return isRemoteMachine(machine) ? this.host.settings.machineProjects[machineProjectKey(machine, project)] : this.host.settings.projects[project];
    }

    // Choose a folder for project `name` (or a new project if null) and save the mapping.
    private chooseProjectFolder(name: string | null): Promise<{ name: string; path: string } | null> {
        const machine = this.machine;
        if (isRemoteMachine(machine)) {
            const prompt: Prompt = {
                title: name ? fmt(_('Project folder “{name}”'), { name }) : _('Choose a project folder'),
                label: fmt(_('The folder of the project on {machine} (an absolute path):'), { machine: this.machineLabel(machine) }),
                value: name ? this.folderOf(name) ?? '' : '', accept: _('Save'),
            };
            return this.dialogs.remoteFolder(prompt).then(path => this.mapProjectFolder(name, path));
        }
        return this.dialogs.chooseFolder(name ? fmt(_('Project folder “{name}”'), { name }) : _('Choose a project folder')).then(path => this.mapProjectFolder(name, path));
    }

    private mapProjectFolder(name: string | null, path: string | null): { name: string; path: string } | null {
        if (!path) return null;
        const project = name ?? platform().paths.basename(path).replace(/\s+/g, '-');
        const machine = this.machine;
        const remote = isRemoteMachine(machine);
        // A folder on another machine cannot be checked from here; the daemon there allows only its own roots.
        const problem = !PROJECT_NAME.test(project) ? fmt(_('the folder name "{name}" cannot be used as a project name'), { name: project })
            : remote ? (path.startsWith('/') ? null : _('the project folder must be an absolute path'))
            : checkProjectFolder(path, this.host.root());
        if (problem) { this.host.toast(fmt(_('Project folder rejected: {problem}'), { problem })); return null; }
        if (remote) this.host.settings.machineProjects = { ...this.host.settings.machineProjects, [machineProjectKey(machine, project)]: path };
        else this.host.settings.projects = { ...this.host.settings.projects, [project]: path };
        return { name: project, path };
    }

    answer(run: Run): void {
        if (!run.ask) return;
        void this.dialogs.answer(run.ask, run.agent).then(reply => {
            if (!reply) return;   // Later: the harness keeps waiting
            const error = this.orchestrator.answer(run, reply);
            if (error) this.host.toast(fmt(_('The answer was not sent: {error}'), { error }));
        });
    }

    private steer(run: Run): void {
        void this.dialogs.text({ title: fmt(_('Steering for {agent}'), { agent: run.agent }), label: fmt(_('{agent} receives it before its next step, without stopping the work.'), { agent: run.agent }) }).then(text => {
            if (!text) return;
            const error = this.orchestrator.steer(run, text);
            this.host.toast(error ? fmt(_('The steering was not sent: {error}'), { error }) : fmt(_('Steering sent to {agent}'), { agent: run.agent }));
        });
    }

    private resumeInterrupted(run: Run): void {
        const error = this.orchestrator.resumeInterrupted(run);
        if (error) this.host.toast(fmt(_('Cannot resume {agent}: {error}'), { agent: run.agent, error }));
    }

    private reply(run: Run): void {
        void this.dialogs.text({ title: fmt(_('Reply to {agent}'), { agent: run.agent }), label: fmt(_('The {agent} session continues with this reply; the card goes back to being worked on.'), { agent: run.agent }), context: run.result?.summary || undefined }).then(text => {
            if (!text) return;
            const error = this.orchestrator.resume(run, text);
            if (error) this.host.toast(fmt(_('Cannot reply to {agent}: {error}'), { agent: run.agent, error }));
        });
    }

    // Open a run's log window (or raise it) and send it the log, then what changes in it while the window is open.
    showLog(run: Run): void {
        this.host.logs.show(run.id, fmt(_('{agent} Log — {title}'), { agent: run.agent, title: run.title }));
        if (this.logFeeds.has(run.id)) return;
        const feed = new TraceFeed(run.trace, update => this.host.logs.update(run.id, update));
        this.logFeeds.set(run.id, feed);
        feed.start();
    }

    private readonly logFeeds = new Map<number, TraceFeed>();

    private stopLog(runId: number): void {
        this.logFeeds.get(runId)?.stop();
        this.logFeeds.delete(runId);
    }

    // From Home: an agent that is waiting for an answer is asked right away; one that is working shows its log; a queued one opens its board.
    open(id: number): void {
        const run = this.orchestrator.queue.runs.find(r => r.id === id);
        if (!run) return;
        if (run.status === 'waiting') this.answer(run);
        else if (run.status === 'working') this.showLog(run);
        else this.host.openInTab(run.board);
    }

    dispose(): void {
        for (const runId of [...this.logFeeds.keys()]) this.stopLog(runId);
        this.unwatch?.();
        this.orchestrator.dispose(this.stopOnClose);
        this.hub.dispose();
    }
}

// Whether a folder on this computer is inside a Git repository: it or a folder above it has a .git (a folder, or a
// file in a worktree or submodule).
function inRepository(folder: string): boolean {
    const { paths } = platform();
    // Up to the root, which is its own parent (/ here, C:\ on Windows).
    for (let dir = folder; ; dir = paths.dirname(dir)) {
        if (fileExists(paths.join(dir, '.git'))) return true;
        if (paths.dirname(dir) === dir) return false;
    }
}
