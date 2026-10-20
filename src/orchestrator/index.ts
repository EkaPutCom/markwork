// Markwork as a harness orchestrator: kanban cards that are assigned (e.g. "@pi") are worked on by an external agent program
// in its own project folder. Here the process is run (async), its output is read line by
// line, permission/input requests are passed to the user and their answers sent back through stdin, and the card
// is moved according to its status. The pure parts (prompt, RPC commands, JSON reader, queue) are in agent/harness.ts.
// Markwork writes nothing to the project folder; only its own board is written. When the project isolates its cards, each
// card gets a Git worktree of its own first (agent/worktree.ts) and the harness works there.

import { assignCard, cardMeta, moveCard, setCardBranch, updateCard, type Board, type Card, type Position } from '../markdown/kanban.js';
import {
    buildPrompt, cardWikiLinks, checkProjectFolder, describeReply, endsWithQuestion, HARNESSES, locateCard, PiReader, resultNote, rpcGetState,
    rpcPrompt, rpcSteer, rpcUiResponse, RunQueue, stageColumn, type HarnessReply, type HarnessSpec, type LinkedNote, type NewRun, type PiSignal, type Run,
} from '../agent/harness.js';
import { createWorktree, removeWorktree, type Isolation, type Worktree } from '../agent/worktree.js';
import type { GitRunner } from '../forge/contribute.js';
import type { WikiLink } from '../markdown/wikilink.js';
import { platform } from '../platform/index.js';
import { _, fmt } from '../base/i18n.js';

export interface HarnessProcess {
    write(line: string): boolean;   // one JSONL command to stdin; false if stdin is already closed or failed
    closeInput(): void;             // close stdin: the RPC harness finishes in an orderly way
    stop(): void;
    // Let go without stopping: the process lives elsewhere (a daemon) and goes on when this window is closed. When
    // a harness has no detach, closing the window stops it, so it is not left running without a monitor.
    detach?(): void;
}

export interface SpawnHandlers {
    line(text: string, ts?: number): void;   // one line of the harness's stdout; ts = when it was printed (Unix ms), if known
    // interrupted = the harness did not end by itself: the daemon that held it went away (its session can be resumed).
    exit(status: number, stderr: string, interrupted?: boolean): void;
    // Only for a run that is followed again after Markwork was closed: its history is replayed first.
    input?(line: string): void;              // a line that was sent to the harness (an answer, a reply, steering)
    caughtUp?(): void;                       // the history is delivered; what comes next is live
}

// What a spawner that keeps runs elsewhere (the markworkd daemon) records about a run so it can be found again
// after Markwork was closed: the lane makes runs of one project take turns (`slots` of them at a time), the labels
// say which card and which worktree it is for.
export interface SpawnMeta {
    lane: string;
    slots?: number;      // 1 when absent
    labels: Record<string, string>;
}

// Throws if the program cannot be run. The local spawner ignores meta.
export type Spawner = (argv: string[], cwd: string, handlers: SpawnHandlers, meta?: SpawnMeta) => HarnessProcess;

// This computer's processes, through the platform (platform/node/process.ts).
export const spawnHarness: Spawner = (argv, cwd, handlers) => platform().processes.spawn(argv, cwd, handlers);

// Apps launched from the desktop menu often do not inherit the shell PATH; the platform also looks in ~/.local/bin and the like.
export const findProgram = (name: string): string | null => platform().processes.findProgram(name);

export interface OrchestratorHost {
    workspace(): string | null;
    // Read the notes linked with [[...]] from the cards on that board, for the prompt context.
    linkedNotes(boardFile: string, links: WikiLink[]): LinkedNote[];
    // Change the board at that path (open in a tab or on disk). Returns an error message or null.
    updateBoard(file: string, edit: (board: Board) => Board): string | null;
    // A run's status changed: redraw the board, notify.
    changed(run: Run, message: string | null): void;
    // A message about a card before its run exists (its worktree is being made, or could not be).
    notify?(message: string): void;
}

interface Live {
    reader: PiReader;
    proc: HarnessProcess | null;
    stopped: boolean;
    askTimer: ReturnType<typeof setTimeout> | null;
    // A run followed again after Markwork was closed replays its history first. Signals in it are old news: only the
    // last one that nothing answered afterwards is acted on, once the replay is over.
    replaying: boolean;
    pending: PiSignal | null;
    pendingTs: number;
}

const newLive = (reader: PiReader, replaying = false): Live => ({ reader, proc: null, stopped: false, askTimer: null, replaying, pending: null, pendingTs: 0 });

// A run found on the daemon that belongs to a card of ours.
export interface AdoptInfo {
    runId: string;
    lastSeq: number;      // the run's last record when it was found: the replay ends there
    board: string;
    card: string;
    title: string;
    agent: string;
    project: string;
    folder: string;
    lane?: string;        // the run's lane on this side; the folder when absent
    slots?: number;
    worktree?: Worktree | null;
    machine: string;      // for the log
}

// Follows a run that is already on a daemon: delivers its history to the handlers, then what comes live.
export type Adopter = (runId: string, upTo: number, handlers: SpawnHandlers) => HarnessProcess;

export class Orchestrator {
    readonly queue = new RunQueue();
    spawn: Spawner = spawnHarness;
    adopter: Adopter | null = null;
    // false when the project folders are on another machine: this computer can neither check them nor keep the
    // harness out of Markwork's work folder; the daemon there checks its own folders.
    localFolders = true;
    program: (spec: HarnessSpec) => string | null = spec => findProgram(spec.program);
    stamp: () => string = () => {
        const d = new Date();
        const two = (n: number) => String(n).padStart(2, '0');
        return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
    };
    // Git where the project folders are (this computer, or the machine of the daemon), for the worktrees.
    git: GitRunner = async () => null;
    // How a project's cards are isolated; null = they work in the project folder itself, one at a time.
    isolation: (project: string, folder: string) => Isolation | null = () => null;
    private readonly preparing = new Set<string>();   // cards whose worktree is being made: board + "\n" + card text
    private readonly live = new Map<number, Live>();
    private disposed = false;
    private prompts = 0;

    constructor(private readonly host: OrchestratorHost) {}

    // Assign a card to a harness and run it (or queue it if the project folder is being worked on).
    // Returns an error message or null.
    start(boardFile: string, board: Board, at: Position, agent: string, project: string, folder: string, boardName: string): string | null {
        const spec = HARNESSES[agent];
        if (!spec) return fmt(_('unknown harness "{agent}"'), { agent });
        const card = board.columns[at.column]?.cards[at.index];
        if (!card) return 'card not found';
        if (this.queue.active(boardFile, card.text) || this.preparing.has(`${boardFile}\n${card.text}`)) return 'this card is already being worked on';
        const problem = this.localFolders ? checkProjectFolder(folder, this.host.workspace()) : null;
        if (problem) return problem;
        if (this.localFolders && !platform().fs.isDirectory(folder)) return `the project folder does not exist: ${folder}`;

        const text = assignCard(card.text, agent);
        if (text !== card.text) {
            const error = this.editCard(boardFile, card.text, (b, pos) => updateCard(b, pos, { text }));
            if (error) return error;
        }
        const assigned = { ...card, text };
        const links = cardWikiLinks(assigned);
        const notes = links.length ? this.host.linkedNotes(boardFile, links) : [];
        const isolation = this.isolation(project, folder);
        const base = { board: boardFile, card: text, title: shortTitle(text), agent, project, folder, session: null };
        if (!isolation?.worktrees) {
            this.begin({ ...base, prompt: buildPrompt(assigned, project, boardName, notes) }, fmt(_('Project folder: {folder}'), { folder }));
            return null;
        }
        const key = `${boardFile}\n${text}`;
        this.preparing.add(key);
        // On another machine every git step is a round trip through the daemon, so it can take a moment.
        if (!this.localFolders) this.host.notify?.(fmt(_('Making a worktree for “{title}”…'), { title: base.title }));
        void createWorktree(this.git, { folder, title: base.title, isolation }).then(made => {
            this.preparing.delete(key);
            if (made.ok) this.startInWorktree(base, assigned, made.value, isolation, boardName, notes);
            else if (made.notRepo && !this.disposed) this.begin({ ...base, prompt: buildPrompt(assigned, project, boardName, notes) }, fmt(_('Project folder: {folder} (not a Git repository, so no worktree)'), { folder }));
            else if (!this.disposed) this.host.notify?.(fmt(_('Cannot make a worktree for “{title}”: {error}'), { title: base.title, error: made.message }));
        });
        return null;
    }

    // The worktree exists: the card notes its branch (so the card is found with its worktree after a restart), and
    // the run is queued in the project's lane, which lets `slots` cards work at the same time.
    private startInWorktree(base: Omit<NewRun, 'prompt'>, card: Card, wt: Worktree, isolation: Isolation, boardName: string, notes: LinkedNote[]): void {
        const text = setCardBranch(card.text, wt.branch);
        const error = this.disposed ? 'the window was closed' : this.editCard(base.board, card.text, (b, pos) => updateCard(b, pos, { text }));
        if (error) {
            void removeWorktree(this.git, wt);
            if (!this.disposed) this.host.notify?.(fmt(_('Cannot run {agent} on “{title}”: {error}'), { agent: base.agent, title: base.title, error }));
            return;
        }
        const prompt = buildPrompt({ ...card, text }, base.project, boardName, notes, wt);
        const where = fmt(_('Worktree: {path}\nBranch {branch} from {base}'), { path: wt.cwd, branch: wt.branch, base: wt.base });
        this.begin({ ...base, card: text, folder: wt.cwd, lane: base.folder, slots: Math.max(1, isolation.slots), worktree: wt, prompt }, where);
    }

    private begin(run: NewRun, where: string): void {
        const added = this.queue.add(run);
        added.trace.add('turn', fmt(_('{agent} for “{title}”'), { agent: HARNESSES[added.agent].label, title: added.title }), `${where}\n\n${added.prompt}`);
        this.enqueue(added);
    }

    // Continue the session of a finished run with the user's reply (e.g. a question not ending in "?").
    resume(previous: Run, message: string): string | null {
        const text = message.trim();
        if (!text) return 'empty reply';
        if (!previous.result?.sessionId) return 'the pi session for this card is unknown';
        if (this.queue.active(previous.board, previous.card)) return 'this card is already being worked on';
        if (this.localFolders && !platform().fs.isDirectory(previous.folder)) return `the project folder does not exist: ${previous.folder}`;
        // The same log is reused so the conversation with the harness reads as a whole.
        const run = this.queue.add({ ...previous, prompt: text, session: previous.result.sessionId }, previous.trace);
        run.trace.add('turn', _('Your reply'), text);
        this.enqueue(run);
        return null;
    }

    // Continue a run that was interrupted (its daemon went away) in the same session, with a fixed prompt: the user
    // only confirms. Never started by itself, so a daemon that keeps dying cannot cause a restart loop.
    resumeInterrupted(previous: Run): string | null {
        if (!previous.result?.interrupted) return 'this run was not interrupted';
        return this.resume(previous, RESUME_PROMPT);
    }

    // Continue a card's work in its worktree with the user's reply (often their comments on the diff): in the same
    // harness session when this window still has it, otherwise in a new one that is told what the card is and what
    // it did so far. Returns an error message or null.
    continueInWorktree(boardFile: string, card: Card, wt: Worktree, agent: string, project: string, folder: string, message: string, boardName: string): string | null {
        const text = message.trim();
        if (!text) return 'empty reply';
        if (!HARNESSES[agent]) return fmt(_('unknown harness "{agent}"'), { agent });
        if (this.queue.active(boardFile, card.text)) return 'this card is already being worked on';
        if (this.localFolders && !platform().fs.isDirectory(wt.cwd)) return `the worktree does not exist: ${wt.cwd}`;
        const previous = this.queue.find(boardFile, card.text);
        if (previous?.result?.sessionId && previous.worktree?.path === wt.path) return this.resume(previous, text);
        const isolation = this.isolation(project, folder);
        const prompt = `${buildPrompt(card, project, boardName, [], wt)}\n\nYou worked on this card before; your changes are in this worktree. The user reviewed them:\n\n${text}`;
        const where = fmt(_('Worktree: {path}\nBranch {branch} from {base}'), { path: wt.cwd, branch: wt.branch, base: wt.base });
        this.begin({ board: boardFile, card: card.text, title: shortTitle(card.text), agent, project, folder: wt.cwd, lane: folder, slots: Math.max(1, isolation?.slots ?? 1), worktree: wt, prompt, session: null }, where);
        return null;
    }

    // The card's worktree is done with (merged or discarded): the card forgets its branch, gets a note, and a merged one
    // moves to Done. Returns an error message or null.
    closeWorktree(boardFile: string, cardText: string, note: string, toDone: boolean): string | null {
        return this.editCard(boardFile, cardText, (b, pos) => {
            const card = b.columns[pos.column].cards[pos.index];
            const closed = updateCard(b, pos, { text: setCardBranch(card.text, null), notes: [...card.notes, note], ...(toDone ? { done: true } : {}) });
            const done = toDone ? stageColumn(closed, 'done') : -1;
            return done >= 0 && done !== pos.column ? moveCard(closed, pos, { column: done, index: Infinity }) : closed;
        });
    }

    // A note under the card and nothing else changed, so the card is still found by its text (a pull request was opened for
    // its branch). Returns an error message or null.
    noteCard(boardFile: string, cardText: string, note: string): string | null {
        return this.editCard(boardFile, cardText, (b, pos) => updateCard(b, pos, { notes: [...b.columns[pos.column].cards[pos.index].notes, note] }));
    }

    // Answer what the harness is waiting for. Returns an error message or null.
    answer(run: Run, reply: HarnessReply): string | null {
        const live = this.live.get(run.id);
        const ask = run.ask;
        if (!live?.proc || run.status !== 'waiting' || !ask) return 'pi is not waiting for an answer';
        if (live.askTimer) { clearTimeout(live.askTimer); live.askTimer = null; }
        if (ask.kind === 'question') {
            if ('value' in reply && reply.value.trim()) {
                live.reader.restart();
                if (!live.proc.write(rpcPrompt(reply.value.trim(), `markwork-${++this.prompts}`))) return 'pi no longer accepts input';
                run.trace.add('turn', _('Your answer'), reply.value.trim());
            } else {
                // Not replied to: the run finishes as usual with pi's last answer.
                run.trace.add('note', _('Ended without replying'));
                this.queue.resume(run);
                live.proc.closeInput();
                this.host.changed(run, null);
                return null;
            }
        } else {
            if (!live.proc.write(rpcUiResponse(ask.id!, reply))) return 'pi no longer accepts input';
            run.trace.add('note', fmt(_('Answer: {reply}'), { reply: describeReply(ask, reply) }), ask.title);
        }
        this.queue.resume(run);
        this.host.changed(run, null);
        return null;
    }

    // Extra steering while the harness works; received by the harness before the next model call.
    steer(run: Run, message: string): string | null {
        const live = this.live.get(run.id);
        const text = message.trim();
        if (!text) return 'empty steering';
        if (!live?.proc || run.status !== 'working') return 'pi is not working';
        if (!live.proc.write(rpcSteer(text))) return 'pi no longer accepts input';
        run.trace.add('turn', _('Your steering'), text);
        return null;
    }

    stop(run: Run): void {
        const live = this.live.get(run.id);
        if (!live) return;
        live.stopped = true;
        if (run.status === 'queued') this.finish(run, 0, '');
        else live.proc?.stop();
    }

    // The window is closed: stop the harnesses that are children of this window so they are not left without a
    // monitor, and let go of those that live in a daemon, which keeps them going.
    dispose(stopDetachable = false): void {
        this.disposed = true;
        for (const run of this.queue.runs) {
            const live = this.live.get(run.id);
            if (live?.askTimer) { clearTimeout(live.askTimer); live.askTimer = null; }
            if ((run.status !== 'working' && run.status !== 'waiting') || !live?.proc) continue;
            if (live.proc.detach && !stopDetachable) live.proc.detach();
            else { live.stopped = true; live.proc.stop(); }
        }
    }

    private enqueue(run: Run): void {
        const spec = HARNESSES[run.agent];
        this.live.set(run.id, newLive(new PiReader(run.trace)));
        if (run.status === 'working') this.launch(run);
        else this.host.changed(run, run.slots > 1
            ? fmt(_('{agent} already works on {count} cards in {project}; this card is waiting its turn'), { agent: spec.label, count: run.slots, project: run.project })
            : fmt(_('{agent} is working on another card in {project}; this card is waiting its turn'), { agent: spec.label, project: run.project }));
    }

    private launch(run: Run): void {
        const spec = HARNESSES[run.agent];
        const live = this.live.get(run.id)!;
        const program = this.program(spec);
        if (!program) {
            run.trace.add('error', fmt(_('{agent} not found'), { agent: spec.label }), fmt(_('The program "{program}" is not in PATH or ~/.local/bin.'), { program: spec.program }));
            this.finish(run, 127, fmt(_('program "{program}" not found'), { program: spec.program }));
            return;
        }
        const doing = this.editCard(run.board, run.card, (b, pos) => {
            const column = stageColumn(b, 'doing');
            return column < 0 || column === pos.column ? b : moveCard(b, pos, { column, index: Infinity });
        });
        if (doing) run.trace.add('note', _('Card not moved'), doing);
        try {
            live.proc = this.spawn([program, ...spec.args(run.title, run.session)], run.folder, this.handlersFor(run, live), spawnMeta(run));
        } catch (e) {
            this.finish(run, 127, e instanceof Error ? e.message : String(e));
            return;
        }
        live.proc.write(rpcGetState());
        live.proc.write(rpcPrompt(run.prompt, `markwork-${++this.prompts}`));
        this.host.changed(run, fmt(_('{agent} started working on “{title}”'), { agent: spec.label, title: run.title }));
    }

    private handlersFor(run: Run, live: Live): SpawnHandlers {
        return {
            line: (text, ts) => {
                if (this.disposed) return;
                const signal = live.reader.line(text);
                if (!signal) return;
                if (live.replaying) { live.pending = signal; live.pendingTs = ts ?? 0; } else this.onSignal(run, signal);
            },
            input: () => { if (live.replaying) live.pending = null; },   // something was sent after it: it was dealt with
            caughtUp: () => { live.replaying = false; this.flushReplay(run, live); },
            exit: (status, stderr, interrupted) => this.finish(run, status, stderr, interrupted),
        };
    }

    // The history of a run followed again is over: act on the last signal that nothing answered.
    private flushReplay(run: Run, live: Live): void {
        const signal = live.pending;
        if (!live.proc || live.replaying || !signal) return;
        live.pending = null;
        if (signal.type === 'ask' && signal.ask.timeout && live.pendingTs && Date.now() - live.pendingTs > signal.ask.timeout) {
            // The harness gave up waiting while we were away and used its default answer.
            run.trace.add('note', _('Answer time ran out'), fmt(_('{agent} used its default answer for: {question}'), { agent: HARNESSES[run.agent]?.label ?? run.agent, question: signal.ask.title }));
            return;
        }
        this.onSignal(run, signal);
    }

    // Follows a run that is already on the daemon: this window was closed while it worked. Its history is replayed
    // into the log, and what it is waiting for (if anything) is asked again. Returns an error message or null.
    adopt(info: AdoptInfo): string | null {
        const spec = HARNESSES[info.agent];
        if (!spec) return fmt(_('unknown harness "{agent}"'), { agent: info.agent });
        if (!this.adopter) return 'there is no daemon to follow the run on';
        if (this.queue.active(info.board, info.card)) return 'this card is already being worked on';
        const run = this.queue.addRunning({ board: info.board, card: info.card, title: info.title, agent: info.agent, project: info.project, folder: info.folder, lane: info.lane ?? info.folder, slots: info.slots ?? 1, worktree: info.worktree ?? null, prompt: '', session: null });
        const live = newLive(new PiReader(run.trace), true);
        this.live.set(run.id, live);
        run.trace.add('turn', fmt(_('{agent} for “{title}”'), { agent: spec.label, title: run.title }), fmt(_('Found again on {machine} after Markwork was closed; its history follows.'), { machine: info.machine }));
        live.proc = this.adopter(info.runId, info.lastSeq, this.handlersFor(run, live));
        this.flushReplay(run, live);   // the replay may already have been delivered inside adopter()
        this.host.changed(run, fmt(_('Following {agent} again on “{title}”'), { agent: spec.label, title: run.title }));
        return null;
    }

    // What is running now, for the question asked when the window closes. Children of this window end with it;
    // runs that live in a daemon can be left going. Queued cards live only in this window and do not start later.
    activity(): { children: number; detachable: number; queued: number } {
        let children = 0, detachable = 0, queued = 0;
        for (const run of this.queue.runs) {
            const proc = this.live.get(run.id)?.proc;
            if (run.status === 'queued') queued++;
            else if ((run.status === 'working' || run.status === 'waiting') && proc) {
                if (proc.detach) detachable++;
                else children++;
            }
        }
        return { children, detachable, queued };
    }

    private onSignal(run: Run, signal: PiSignal): void {
        const live = this.live.get(run.id);
        if (!live?.proc || run.result) return;
        const spec = HARNESSES[run.agent];
        if (signal.type === 'rejected') { live.proc.closeInput(); return; }
        if (signal.type === 'ask') {
            this.queue.wait(run, signal.ask);
            // The harness answers by itself with the default value after its timeout; follow along so the status does not go stale.
            if (signal.ask.timeout) {
                const ask = signal.ask;
                if (live.askTimer) clearTimeout(live.askTimer);
                live.askTimer = setTimeout(() => {
                    live.askTimer = null;
                    if (run.ask === ask) {
                        this.queue.resume(run);
                        run.trace.add('note', _('Answer time ran out'), fmt(_('{agent} used its default answer for: {question}'), { agent: spec.label, question: ask.title }));
                        this.host.changed(run, null);
                    }
                }, ask.timeout!);
            }
            this.host.changed(run, fmt(_('{agent} is waiting for an answer: {question}'), { agent: spec.label, question: signal.ask.title }));
            return;
        }
        // Turn finished: a question → wait for the user's reply; otherwise close stdin and let the harness exit.
        if (!live.stopped && endsWithQuestion(live.reader.answer)) {
            this.queue.wait(run, { kind: 'question', id: null, title: fmt(_('{label} asks'), { label: spec.label }), message: live.reader.answer, options: [], prefill: '', timeout: null });
            this.host.changed(run, fmt(_('{agent} asked about “{title}”'), { agent: spec.label, title: run.title }));
        } else live.proc.closeInput();
    }

    private finish(run: Run, status: number, stderr: string, interrupted = false): void {
        const live = this.live.get(run.id);
        if (!live || run.result) return;
        if (live.askTimer) { clearTimeout(live.askTimer); live.askTimer = null; }
        const result = live.reader.finish(status, stderr, live.stopped, interrupted);
        const next = this.queue.end(run, live.stopped ? 'stopped' : result.ok ? 'done' : 'failed', result);
        this.live.delete(run.id);
        if (this.disposed) return;
        const spec = HARNESSES[run.agent];
        if (!live.stopped) {
            const note = resultNote(spec.label, result, this.stamp());
            const error = this.editCard(run.board, run.card, (b, pos) => {
                const card = b.columns[pos.column].cards[pos.index];
                const noted = updateCard(b, pos, { notes: [...card.notes, note] });
                const review = stageColumn(noted, 'review');
                return result.ok && review >= 0 && review !== pos.column ? moveCard(noted, pos, { column: review, index: Infinity }) : noted;
            });
            if (error) run.trace.add('note', _('Board not updated'), error);
        }
        const message = live.stopped ? `${spec.label} stopped: “${run.title}”`
            : result.interrupted ? fmt(_('{agent} was interrupted on “{title}”: resume it from the card'), { agent: spec.label, title: run.title })
            : result.ok ? `${spec.label} finished: “${run.title}”` : `${spec.label} failed: ${result.error}`;
        this.host.changed(run, message);
        for (const started of next) this.launch(started);
    }

    // The card is looked up again on the current board (the user may have moved it). Not found → leave the board alone.
    private editCard(file: string, cardText: string, edit: (board: Board, at: Position) => Board): string | null {
        let missing = false;
        const error = this.host.updateBoard(file, board => {
            const at = locateCard(board, cardText);
            if (!at) { missing = true; return board; }
            return edit(board, at);
        });
        return error ?? (missing ? 'the card was not found on the board (its text may have been changed)' : null);
    }
}

const RESUME_PROMPT = 'Your work was interrupted before it was finished (the process that was running you was stopped). Check the current state of the files, then continue where you left off.';

const LABEL_CARD_CHARS =4000;   // the daemon limits the labels of a run to 8 KB; a longer card is matched by its start

function spawnMeta(run: Run): SpawnMeta {
    const wt = run.worktree;
    return {
        lane: run.project,
        slots: run.slots,
        labels: {
            agent: run.agent, project: run.project, board: run.board, card: run.card.slice(0, LABEL_CARD_CHARS), title: run.title, host: platform().processes.hostName(),
            lane: run.lane, slots: String(run.slots),
            ...(wt ? { worktree: wt.path, branch: wt.branch, base: wt.base, basecommit: wt.baseCommit, repo: wt.repo } : {}),
        },
    };
}

// The worktree a run found again on the daemon was started in, from the labels spawnMeta() put on it.
export function labelWorktree(labels: Record<string, string>, cwd: string): Worktree | null {
    const { worktree, branch, base, basecommit, repo } = labels;
    return worktree && branch && base && basecommit && repo ? { path: worktree, cwd, branch, base, baseCommit: basecommit, repo } : null;
}

// Short title for messages, pi session names, and logs.
function shortTitle(text: string): string {
    const title = cardMeta(text).title;
    return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}
