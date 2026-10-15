// Runs the orchestrator's harnesses through markworkd instead of as children of this window: the same Spawner and
// HarnessProcess the orchestrator already uses, so a run keeps going when Markwork is closed, and can live on
// another machine. The daemon moves lines and never understands them; the orchestrator's pi reader still does.

import type { DaemonConnection, FollowHandlers, Follower } from './agent/daemon/connection.js';
import { DaemonError, exitStatus, parseExit, type ExitInfo, type SpawnSpec } from './agent/daemon/protocol.js';
import type { GitRun, GitRunner } from './forge/contribute.js';
import type { HarnessProcess, SpawnHandlers, SpawnMeta, Spawner } from './orchestrator.js';

const STDERR_TAIL = 8000;
const TRANSIENT = new Set(['connection_closed', 'timeout']);

export interface DaemonSpawnerOptions {
    newRunId?: () => string;
    forgetWhenDone?: boolean;                // delete the run from the daemon once its result was delivered (default true)
    problem?: (run: string, message: string) => void;   // a request that could not be delivered (see DaemonProcess.write)
}

// A run id is unique across app starts and machines.
export function newRunId(): string {
    const random = Math.floor(Math.random() * 0x7fffffff).toString(36);
    return `mw-${Date.now().toString(36)}-${random}`;
}

type Op = { t: 'write'; line: string } | { t: 'close' } | { t: 'stop' };

// One run on the daemon, seen as a local process.
class DaemonProcess implements HarnessProcess {
    private readonly outbox: Op[] = [];
    private busy = false;
    private ready = false;            // the run exists on the daemon
    private inputClosed = false;
    private ended = false;
    private follower: Follower | null = null;
    private exit: ExitInfo | null = null;
    private upTo: number | null = null;   // set while the history of an adopted run is being replayed

    constructor(
        private readonly conn: DaemonConnection,
        readonly run: string,
        private readonly handlers: SpawnHandlers,
        private readonly opts: DaemonSpawnerOptions,
    ) {}

    // Creates the run on the daemon. Repeating the request after a dropped connection is safe: it is idempotent.
    create(spec: SpawnSpec): void {
        const attempt = (): void => {
            this.conn.ready().then(client => client.spawn(spec)).then(
                () => this.attached(1),
                (e: DaemonError) => {
                    if (TRANSIENT.has(e.code)) attempt();
                    else this.finish(e.code === 'program_not_allowed' ? 127 : 1, e.message);
                });
        };
        attempt();
    }

    // Follows a run that already exists (found again after Markwork was restarted). upTo = the last record that was
    // there at that moment: once it is delivered, the replay is over and the handlers' caughtUp is called.
    adopt(fromSeq: number, upTo: number): void {
        this.upTo = upTo;
        this.attached(fromSeq);
        if (upTo < fromSeq) this.caughtUp();
    }

    private caughtUp(): void {
        if (this.upTo === null) return;
        this.upTo = null;
        this.handlers.caughtUp?.();
    }

    write(line: string): boolean {
        if (this.ended || this.inputClosed) return false;
        this.outbox.push({ t: 'write', line });
        this.drain();
        return true;
    }

    closeInput(): void {
        if (this.ended || this.inputClosed) return;
        this.inputClosed = true;
        this.outbox.push({ t: 'close' });
        this.drain();
    }

    stop(): void {
        if (this.ended) return;
        this.outbox.unshift({ t: 'stop' });   // does not wait behind lines that were never sent
        this.drain();
    }

    // The window is closing: stop listening, and leave the run to the daemon.
    detach(): void {
        this.ended = true;
        this.outbox.length = 0;
        this.follower?.stop();
        this.follower = null;
    }

    private attached(fromSeq: number): void {
        this.ready = true;
        this.follower = this.conn.follow(this.run, fromSeq, this.followHandlers());
        this.drain();
    }

    private followHandlers(): FollowHandlers {
        return {
            record: rec => {
                if (rec.kind === 'out') this.handlers.line(rec.line, rec.ts);
                else if (rec.kind === 'in') this.handlers.input?.(rec.line);
                else if (rec.kind === 'exit') this.exit = parseExit(rec.line);
                if (this.upTo !== null && rec.seq >= this.upTo) this.caughtUp();
            },
            end: () => this.completed(),
            failed: e => this.finish(1, e.message),
        };
    }

    // The exit record arrived and the stream ended: fetch the stderr tail, then report.
    private completed(): void {
        this.caughtUp();
        const exit = this.exit ?? { reason: 'exited' as const };
        const done = (stderr: string) => this.finish(exitStatus(exit), stderr || exit.error || '');
        this.conn.ready().then(c => c.stderr(this.run, STDERR_TAIL)).then(r => done(r.text), () => done(''));
    }

    private finish(status: number, stderr: string): void {
        if (this.ended) return;
        this.ended = true;
        this.follower?.stop();
        this.follower = null;
        try {
            this.handlers.exit(status, stderr);
        } finally {
            if (this.ready && this.opts.forgetWhenDone !== false) {
                this.conn.ready().then(c => c.forget(this.run)).catch(() => { /* the daemon's retention removes it */ });
            }
        }
    }

    // Requests go out one at a time, in the order they were made.
    private drain(): void {
        if (this.busy || !this.ready || this.ended) return;
        const op = this.outbox.shift();
        if (!op) return;
        this.busy = true;
        this.send(op).catch((e: DaemonError) => this.opts.problem?.(this.run, `${op.t}: ${e.message}`)).finally(() => { this.busy = false; this.drain(); });
    }

    // A line that was sent while the link died may or may not have arrived; sending it again could repeat a prompt,
    // so a write is never retried (it is reported). Closing and stopping are idempotent and are retried.
    private async send(op: Op): Promise<void> {
        for (;;) {
            const client = await this.conn.ready();
            try {
                if (op.t === 'write') await client.write(this.run, op.line);
                else if (op.t === 'close') await client.closeStdin(this.run);
                else await client.stop(this.run);
                return;
            } catch (e) {
                const retry = op.t !== 'write' && e instanceof DaemonError && TRANSIENT.has(e.code);
                if (!retry) throw e;
            }
        }
    }
}

// A Spawner whose processes live in the daemon behind conn. argv[0] is turned into the program name the daemon
// resolves for itself (the orchestrator passes a path found on this machine, which means nothing on another one).
export function daemonSpawner(conn: DaemonConnection, opts: DaemonSpawnerOptions = {}): Spawner {
    return (argv, cwd, handlers, meta?: SpawnMeta) => {
        const run = (opts.newRunId ?? newRunId)();
        const proc = new DaemonProcess(conn, run, handlers, opts);
        proc.create({
            run, program: argv[0].split('/').pop() ?? argv[0], args: argv.slice(1), cwd,
            ...(meta ? { lane: meta.lane, lane_slots: meta.slots, labels: meta.labels } : {}),
        });
        return proc;
    };
}

// A run that is already on the daemon, followed from fromSeq on: what the orchestrator does for a run it finds again
// at startup. upTo is the run's last record when it was found; the handlers' caughtUp is called once that is delivered.
export function adoptRun(conn: DaemonConnection, run: string, fromSeq: number, handlers: SpawnHandlers, opts: DaemonSpawnerOptions = {}, upTo = 0): HarnessProcess {
    const proc = new DaemonProcess(conn, run, handlers, opts);
    proc.adopt(fromSeq, upTo);
    return proc;
}

// Git on the daemon's machine, for the worktrees of the cards there: every call is a short run of `git` in no lane (it
// never waits behind a harness), whose output is collected and which is forgotten once it ended. The daemon must allow
// `git` and the folder; a refusal reads as git failing with the daemon's message. Environment variables are not passed:
// the daemon allows none by default.
export function daemonGit(conn: DaemonConnection, opts: DaemonSpawnerOptions = {}): GitRunner {
    const spawn = daemonSpawner(conn, opts);
    return (cwd, args) => new Promise<GitRun | null>(resolve => {
        const out: string[] = [];
        try {
            const proc = spawn(['git', '-c', 'core.quotePath=false', ...args], cwd, {
                line: text => { out.push(text); },
                exit: (status, err) => resolve({ status, out: out.length ? `${out.join('\n')}\n` : '', err }),
            });
            proc.closeInput();
        } catch {
            resolve(null);
        }
    });
}
