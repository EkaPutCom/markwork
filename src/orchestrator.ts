// Markwork as a harness orchestrator: kanban cards that are assigned (e.g. "@pi") are worked on by an external agent program
// in its own project folder. Here the process is run (async), its output is read line by
// line, permission/input requests are passed to the user and their answers sent back through stdin, and the card
// is moved according to its status. The pure parts (prompt, RPC commands, JSON reader, queue) are in agent/harness.ts. Markwork writes nothing to the project folder; only its own board is written.

import GLib from 'gi://GLib';
import { assignCard, cardMeta, moveCard, updateCard, type Board, type Position } from './markdown/kanban.js';
import {
    buildPrompt, cardWikiLinks, checkProjectFolder, describeReply, endsWithQuestion, HARNESSES, locateCard, PiReader, resultNote, rpcGetState,
    rpcPrompt, rpcSteer, rpcUiResponse, RunQueue, stageColumn, type HarnessReply, type HarnessSpec, type LinkedNote, type PiSignal, type Run,
} from './agent/harness.js';
import type { WikiLink } from './markdown/wikilink.js';
import { _, fmt } from './i18n.js';

export interface HarnessProcess {
    write(line: string): boolean;   // one JSONL command to stdin; false if stdin is already closed or failed
    closeInput(): void;             // close stdin: the RPC harness finishes in an orderly way
    stop(): void;
}

export interface SpawnHandlers {
    line(text: string): void;
    exit(status: number, stderr: string): void;
}

// Throws if the program cannot be run.
export type Spawner = (argv: string[], cwd: string, handlers: SpawnHandlers) => HarnessProcess;

const STDERR_TAIL = 8000;
const DRAIN_MS = 1500;   // grace period for reading remaining output after the process exits
const KILL_MS = 5000;    // SIGTERM ignored for this long → SIGKILL

// Pipes are read through GLib.IOChannel, not Gio.Subprocess.get_stdout_pipe(): after Gtk is loaded, GJS wraps
// that pipe as a Gio.UnixInputStream and prints a Gjs-WARNING "moved to a separate platform-specific library".
export const spawnHarness: Spawner = (argv, cwd, handlers) => {
    // Throws GLib.Error if the program cannot be run.
    const [, pid, stdinFd, stdout, stderrFd] = GLib.spawn_async_with_pipes(cwd, argv, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
    // stdin is the command channel (prompt, answers, steering); it is closed to end the harness.
    let input: GLib.IOChannel | null = GLib.IOChannel.unix_new(stdinFd);
    input.set_close_on_unref(true);
    // Bytes as is with an explicit length: a JS string with length -1 is not guaranteed to be NUL-terminated.
    input.set_encoding(null);
    const encoder = new TextEncoder();
    const closeInput = () => {
        if (!input) return;
        try { input.shutdown(true); } catch { /* the harness already exited */ }
        input = null;
    };
    let stderr = '';
    let status = 0;
    let exited = false;
    let pending = 3;   // stdout exhausted, stderr exhausted, process exited
    let drainTimer = 0, killTimer = 0;
    const streams: ((fromWatch?: boolean) => void)[] = [];   // closers of readers that are still running
    const done = () => {
        if (--pending > 0) return;
        if (drainTimer) GLib.source_remove(drainTimer);
        if (killTimer) GLib.source_remove(killTimer);
        drainTimer = killTimer = 0;
        closeInput();
        GLib.spawn_close_pid(pid!);
        handlers.exit(status, stderr);
    };

    // Lines are split only at LF, matching pi's JSONL framing.
    const readLines = (fd: number, onLine: (text: string) => void) => {
        const channel = GLib.IOChannel.unix_new(fd);
        channel.set_close_on_unref(true);
        channel.set_flags(GLib.IOFlags.NONBLOCK);
        let open = true;
        const close = (fromWatch = false) => {
            if (!open) return;
            open = false;
            if (!fromWatch) GLib.source_remove(watch);
            try { channel.shutdown(false); } catch { /* already closed */ }
            done();
        };
        const watch = GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, () => {
            for (;;) {
                let status: GLib.IOStatus, line: string;
                try { [status, line] = channel.read_line(); } catch { status = GLib.IOStatus.ERROR; line = ''; }
                if (status === GLib.IOStatus.NORMAL) { onLine(line.replace(/\n$/, '')); continue; }
                if (status === GLib.IOStatus.AGAIN) return GLib.SOURCE_CONTINUE;
                close(true);   // EOF or error; the watch source is removed through the return value
                return GLib.SOURCE_REMOVE;
            }
        });
        streams.push(close);
    };
    readLines(stdout, handlers.line);
    readLines(stderrFd, text => { stderr = `${stderr}${text}\n`.slice(-STDERR_TAIL); });

    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid!, (_pid, wait) => {
        exited = true;
        // POSIX wait status: the low 7 bits = signal (0 = normal exit), bits 8–15 = exit code.
        status = (wait & 0x7f) === 0 ? (wait >> 8) & 0xff : 128 + (wait & 0x7f);
        // Grandchild processes (e.g. commands from the harness's bash tool) may inherit the pipe and keep it open;
        // do not wait for them indefinitely.
        if (pending > 1) drainTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAIN_MS, () => { drainTimer = 0; for (const close of streams) close(); return GLib.SOURCE_REMOVE; });
        done();
    });
    // GLib has no kill(); signals are sent through the system's built-in kill command.
    const signal = (name: string) => { try { GLib.spawn_async(null, ['kill', `-${name}`, String(pid)], null, GLib.SpawnFlags.SEARCH_PATH, null); } catch { /* the process is gone */ } };
    return {
        write: line => {
            if (!input || exited) return false;
            try {
                // One small command per write; a write blocks briefly if the pipe is full, and that is enough here.
                const bytes = encoder.encode(`${line}\n`);
                input.write_chars(bytes, bytes.length);
                input.flush();
                return true;
            } catch {
                closeInput();
                return false;
            }
        },
        closeInput,
        stop: () => {
            if (exited) return;
            signal('TERM');
            if (!killTimer) killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KILL_MS, () => { killTimer = 0; if (!exited) signal('KILL'); return GLib.SOURCE_REMOVE; });
        },
    };
};

// Apps launched from the desktop menu often do not inherit the shell PATH (e.g. ~/.local/bin from the profile).
export function findProgram(name: string): string | null {
    const found = GLib.find_program_in_path(name);
    if (found) return found;
    const home = GLib.get_home_dir();
    for (const dir of ['.local/bin', '.npm-global/bin', 'bin', '.local/share/mise/shims']) {
        const path = GLib.build_filenamev([home, dir, name]);
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) && !GLib.file_test(path, GLib.FileTest.IS_DIR)) return path;
    }
    return null;
}

export interface OrchestratorHost {
    workspace(): string | null;
    // Read the notes linked with [[...]] from the cards on that board, for the prompt context.
    linkedNotes(boardFile: string, links: WikiLink[]): LinkedNote[];
    // Change the board at that path (open in a tab or on disk). Returns an error message or null.
    updateBoard(file: string, edit: (board: Board) => Board): string | null;
    // A run's status changed: redraw the board, notify.
    changed(run: Run, message: string | null): void;
}

interface Live {
    reader: PiReader;
    proc: HarnessProcess | null;
    stopped: boolean;
    askTimer: number;
}

export class Orchestrator {
    readonly queue = new RunQueue();
    spawn: Spawner = spawnHarness;
    program: (spec: HarnessSpec) => string | null = spec => findProgram(spec.program);
    stamp: () => string = () => GLib.DateTime.new_now_local().format('%d/%m %H:%M') ?? '';
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
        if (this.queue.active(boardFile, card.text)) return 'this card is already being worked on';
        const problem = checkProjectFolder(folder, this.host.workspace());
        if (problem) return problem;
        if (!GLib.file_test(folder, GLib.FileTest.IS_DIR)) return `the project folder does not exist: ${folder}`;

        const text = assignCard(card.text, agent);
        if (text !== card.text) {
            const error = this.editCard(boardFile, card.text, (b, pos) => updateCard(b, pos, { text }));
            if (error) return error;
        }
        const assigned = { ...card, text };
        const links = cardWikiLinks(assigned);
        const notes = links.length ? this.host.linkedNotes(boardFile, links) : [];
        const run = this.queue.add({
            board: boardFile, card: text, title: shortTitle(text), agent, project, folder,
            prompt: buildPrompt(assigned, project, boardName, notes), session: null,
        });
        run.trace.add('turn', fmt(_('{agent} for “{title}”'), { agent: spec.label, title: run.title }), `${fmt(_('Project folder: {folder}'), { folder })}\n\n${run.prompt}`);
        this.enqueue(run);
        return null;
    }

    // Continue the session of a finished run with the user's reply (e.g. a question not ending in "?").
    resume(previous: Run, message: string): string | null {
        const text = message.trim();
        if (!text) return 'empty reply';
        if (!previous.result?.sessionId) return 'the pi session for this card is unknown';
        if (this.queue.active(previous.board, previous.card)) return 'this card is already being worked on';
        if (!GLib.file_test(previous.folder, GLib.FileTest.IS_DIR)) return `the project folder does not exist: ${previous.folder}`;
        // The same log is reused so the conversation with the harness reads as a whole.
        const run = this.queue.add({ ...previous, prompt: text, session: previous.result.sessionId }, previous.trace);
        run.trace.add('turn', _('Your reply'), text);
        this.enqueue(run);
        return null;
    }

    // Answer what the harness is waiting for. Returns an error message or null.
    answer(run: Run, reply: HarnessReply): string | null {
        const live = this.live.get(run.id);
        const ask = run.ask;
        if (!live?.proc || run.status !== 'waiting' || !ask) return 'pi is not waiting for an answer';
        if (live.askTimer) { GLib.source_remove(live.askTimer); live.askTimer = 0; }
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

    // The window is closed: stop all harnesses so they are not left without a monitor.
    dispose(): void {
        this.disposed = true;
        for (const run of this.queue.runs) {
            const live = this.live.get(run.id);
            if (live?.askTimer) { GLib.source_remove(live.askTimer); live.askTimer = 0; }
            if ((run.status === 'working' || run.status === 'waiting') && live?.proc) { live.stopped = true; live.proc.stop(); }
        }
    }

    private enqueue(run: Run): void {
        const spec = HARNESSES[run.agent];
        this.live.set(run.id, { reader: new PiReader(run.trace), proc: null, stopped: false, askTimer: 0 });
        if (run.status === 'working') this.launch(run);
        else this.host.changed(run, fmt(_('{agent} is working on another card in {project}; this card is waiting its turn'), { agent: spec.label, project: run.project }));
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
            live.proc = this.spawn([program, ...spec.args(run.title, run.session)], run.folder, {
                line: text => {
                    if (this.disposed) return;
                    const signal = live.reader.line(text);
                    if (signal) this.onSignal(run, signal);
                },
                exit: (status, stderr) => this.finish(run, status, stderr),
            });
        } catch (e) {
            this.finish(run, 127, e instanceof Error ? e.message : String(e));
            return;
        }
        live.proc.write(rpcGetState());
        live.proc.write(rpcPrompt(run.prompt, `markwork-${++this.prompts}`));
        this.host.changed(run, fmt(_('{agent} started working on “{title}”'), { agent: spec.label, title: run.title }));
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
                if (live.askTimer) GLib.source_remove(live.askTimer);
                live.askTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ask.timeout!, () => {
                    live.askTimer = 0;
                    if (run.ask === ask) {
                        this.queue.resume(run);
                        run.trace.add('note', _('Answer time ran out'), fmt(_('{agent} used its default answer for: {question}'), { agent: spec.label, question: ask.title }));
                        this.host.changed(run, null);
                    }
                    return GLib.SOURCE_REMOVE;
                });
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

    private finish(run: Run, status: number, stderr: string): void {
        const live = this.live.get(run.id);
        if (!live || run.result) return;
        if (live.askTimer) { GLib.source_remove(live.askTimer); live.askTimer = 0; }
        const result = live.reader.finish(status, stderr, live.stopped);
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
            : result.ok ? `${spec.label} finished: “${run.title}”` : `${spec.label} failed: ${result.error}`;
        this.host.changed(run, message);
        if (next) this.launch(next);
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

// Short title for messages, pi session names, and logs.
function shortTitle(text: string): string {
    const title = cardMeta(text).title;
    return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}
