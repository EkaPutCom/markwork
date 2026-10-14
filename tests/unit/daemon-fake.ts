// A stand-in for markworkd for tests of the TypeScript client: it speaks the same protocol, in memory, in the same
// order as the real daemon (a reply, then the records right behind it). The real daemon is exercised in daemon-live.ts.

import GLib from 'gi://GLib';
import type { Link, Timers } from '../../src/agent/daemon/client.js';
import type { DaemonRecord, ExitInfo, RecordKind, RunState, SpawnSpec } from '../../src/agent/daemon/protocol.js';
import { settle } from '../framework.js';

// Both ends of a connection. Delivery is synchronous, like a read loop that handles several lines in one go.
class MemoryLink implements Link {
    onLine: ((line: string) => void) | null = null;
    onClose: ((reason: string | null) => void) | null = null;
    peer!: MemoryLink;
    closed = false;
    sent: string[] = [];

    send(line: string): boolean {
        if (this.closed) return false;
        this.sent.push(line);
        this.peer.onLine?.(line);
        return true;
    }

    close(): void { this.shut(null); }

    shut(reason: string | null): void {
        if (this.closed) return;
        this.closed = true;
        const peer = this.peer;
        this.onClose?.(reason);
        peer.shut(reason);
    }
}

function pair(): [MemoryLink, MemoryLink] {
    const a = new MemoryLink(), b = new MemoryLink();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

export class ManualTimers implements Timers {
    now = 0;
    private seq = 0;
    private readonly due = new Map<number, { at: number; fn: () => void }>();

    after(ms: number, fn: () => void): () => void {
        const id = ++this.seq;
        this.due.set(id, { at: this.now + ms, fn });
        return () => { this.due.delete(id); };
    }

    get pendingDelays(): number[] { return [...this.due.values()].map(d => d.at - this.now).sort((a, b) => a - b); }

    advance(ms: number): void {
        const target = this.now + ms;
        for (;;) {
            const next = [...this.due.entries()].filter(([, d]) => d.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            this.due.delete(next[0]);
            this.now = next[1].at;
            next[1].fn();
            flush();   // promise continuations may schedule more timers
        }
        this.now = target;
    }
}

// Runs the main loop a few times so promise continuations that are ready have run.
export function flush(rounds = 6): void {
    for (let i = 0; i < rounds; i++) {
        settle(new Promise<void>(resolve => GLib.idle_add(GLib.PRIORITY_LOW, () => { resolve(); return GLib.SOURCE_REMOVE; })));
    }
}

interface FakeRun {
    spec: SpawnSpec;
    state: RunState;
    records: DaemonRecord[];
    exit: ExitInfo | null;
    stderr: string;
    inputs: string[];
    stdinClosed: boolean;
    stopped: boolean;
    forgotten: boolean;
}

class FakeConn {
    subscribed = new Set<string>();
    watching = false;
    constructor(readonly daemon: FakeDaemon, readonly link: MemoryLink) {
        link.onLine = line => this.handle(line);
    }

    send(obj: object): void { this.link.send(JSON.stringify(obj)); }
    reply(id: string, fields: object = {}): void { this.send({ re: id, ok: true, ...fields }); }
    fail(id: string, code: string, message = code): void { this.send({ re: id, ok: false, error: { code, message } }); }

    private handle(line: string): void {
        const req = JSON.parse(line) as Record<string, any>;
        const d = this.daemon;
        d.requests.push(req);
        const run = d.runs.get(req.run);
        switch (req.op) {
            case 'hello':
                if (req.proto !== d.protoVersion) this.fail(req.id, 'unsupported_proto');
                else {
                    if (d.bannerNoise) this.link.send('Welcome to the VPS! Last login: yesterday');
                    if (d.expectBridgeSentinel) this.link.send(JSON.stringify({ ev: 'bridge', proto: 1 }));
                    this.reply(req.id, { proto: 1, daemon: 'fake', machine: 'fakebox', pid: 1, features: [] });
                }
                break;
            case 'ping': if (!d.silent) this.reply(req.id); break;
            case 'spawn': d.spawn(this, req as SpawnSpec & { id: string }); break;
            case 'write': this.write(req, run); break;
            case 'close_stdin': if (run) { run.stdinClosed = true; this.reply(req.id); } else this.fail(req.id, 'not_found'); break;
            case 'stop': if (run) { run.stopped = true; this.reply(req.id); } else this.fail(req.id, 'not_found'); break;
            case 'forget': if (run) { run.forgotten = true; d.runs.delete(req.run); this.reply(req.id); } else this.fail(req.id, 'not_found'); break;
            case 'stderr': if (run) this.reply(req.id, { text: run.stderr, head_dropped: false }); else this.fail(req.id, 'not_found'); break;
            case 'get': if (run) this.reply(req.id, d.summary(req.run)); else this.fail(req.id, 'not_found'); break;
            case 'list': this.reply(req.id, { runs: [...d.runs.keys()].map(r => d.summary(r)) }); break;
            case 'subscribe': this.subscribe(req, run); break;
            case 'unsubscribe': this.subscribed.delete(req.run); this.reply(req.id); break;
            case 'watch': this.watching = true; this.reply(req.id, { runs: [...d.runs.keys()].map(r => d.summary(r)) }); d.afterWatch?.(this); break;
            default: this.fail(req.id, 'unknown_op');
        }
    }

    private write(req: Record<string, any>, run: FakeRun | undefined): void {
        if (!run) { this.fail(req.id, 'not_found'); return; }
        if (run.state === 'exited') { this.fail(req.id, 'not_running'); return; }
        if (this.daemon.dropOnWrite) { this.daemon.dropOnWrite = false; this.daemon.drop(); return; }
        run.inputs.push(req.line);
        const rec = this.daemon.append(req.run, 'in', req.line);
        this.reply(req.id, { seq: rec.seq });
    }

    private subscribe(req: Record<string, any>, run: FakeRun | undefined): void {
        if (!run) { this.fail(req.id, 'not_found'); return; }
        const from = Math.max(1, Number(req.from_seq) || 1);
        this.subscribed.add(req.run);
        this.reply(req.id, { first_seq: 1, last_seq: run.records.length, state: run.state });
        const replayFrom = this.daemon.replayFromStart ? 1 : from;   // a daemon that misbehaves: older records again
        for (const rec of run.records.filter(r => r.seq >= replayFrom)) this.send({ ev: 'record', run: req.run, ...rec });
        if (run.exit) this.endStream(req.run);
    }

    endStream(run: string): void {
        if (!this.subscribed.delete(run)) return;
        const r = this.daemon.runs.get(run);
        this.send({ ev: 'end', run, last_seq: r?.records.length ?? 0 });
    }
}

export class FakeDaemon {
    readonly runs = new Map<string, FakeRun>();
    readonly requests: Record<string, any>[] = [];
    readonly conns: FakeConn[] = [];
    protoVersion = 1;
    refuse = false;                   // open() throws, like a machine that cannot be reached
    silent = false;                   // does not answer ping
    bannerNoise = false;
    expectBridgeSentinel = false;
    replayFromStart = false;
    dropOnWrite = false;
    failSpawnWith: string | null = null;
    dropAfterSpawn = false;           // the connection dies right after the daemon created the run, before the reply
    afterWatch: ((c: FakeConn) => void) | null = null;
    private opens = 0;

    get openCount(): number { return this.opens; }

    open = (): Link => {
        this.opens++;
        if (this.refuse) throw new Error('connection refused');
        const [client, server] = pair();
        this.conns.push(new FakeConn(this, server));
        return client;
    };

    spawn(c: FakeConn, req: SpawnSpec & { id: string }): void {
        if (this.failSpawnWith) { c.fail(req.id, this.failSpawnWith, `cannot start: ${this.failSpawnWith}`); return; }
        if (!this.runs.has(req.run)) {
            this.runs.set(req.run, { spec: req, state: 'running', records: [], exit: null, stderr: '', inputs: [], stdinClosed: false, stopped: false, forgotten: false });
            this.append(req.run, 'start', 'pid 1');
        }
        if (this.dropAfterSpawn) { this.dropAfterSpawn = false; this.drop(); return; }
        c.reply(req.id, { run: req.run, state: 'running', position: 0 });
    }

    // A run that exists on the daemon before the test starts, with the records it has so far.
    seed(spec: Partial<SpawnSpec> & { run: string }, records: [RecordKind, string][], exit: ExitInfo | null = null, stderr = ''): void {
        const full: SpawnSpec = { program: 'pi', args: ['--mode', 'rpc'], cwd: '/srv/shop', ...spec };
        this.runs.set(spec.run, { spec: full, state: exit ? 'exited' : 'running', records: [], exit, stderr, inputs: [], stdinClosed: false, stopped: false, forgotten: false });
        this.append(spec.run, 'start', 'pid 1');
        for (const [kind, line] of records) this.append(spec.run, kind, line);
        if (exit) this.append(spec.run, 'exit', JSON.stringify(exit));
    }

    summary(run: string): object {
        const r = this.runs.get(run)!;
        return { run, state: r.state, program: r.spec.program, args: r.spec.args, cwd: r.spec.cwd, lane: r.spec.lane ?? '', labels: r.spec.labels, created_at: 1, started_at: 1, ended_at: r.exit ? 2 : null, exit: r.exit, last_seq: r.records.length, log_bytes: 0, stderr_bytes: r.stderr.length, queue_position: 0 };
    }

    append(run: string, kind: RecordKind, line: string): DaemonRecord {
        const r = this.runs.get(run)!;
        const rec: DaemonRecord = { seq: r.records.length + 1, ts: 1000 + r.records.length, kind, line };
        r.records.push(rec);
        for (const c of this.conns) if (c.subscribed.has(run)) c.send({ ev: 'record', run, ...rec });
        return rec;
    }

    // What the agent printed.
    out(run: string, line: string): void { this.append(run, 'out', line); }

    // The agent ended.
    finish(run: string, exit: ExitInfo, stderr = ''): void {
        const r = this.runs.get(run)!;
        r.stderr = stderr;
        r.exit = exit;
        r.state = 'exited';
        this.append(run, 'exit', JSON.stringify(exit));
        for (const c of this.conns) {
            c.endStream(run);
            if (c.watching) c.send({ ev: 'state', run, state: 'exited', exit, last_seq: r.records.length });
        }
    }

    // The link dies (an SSH session that dropped): the runs go on.
    drop(): void {
        for (const c of this.conns.splice(0)) c.link.shut('link dropped');
    }

    requestsOf(op: string): Record<string, any>[] { return this.requests.filter(r => r.op === op); }
}
