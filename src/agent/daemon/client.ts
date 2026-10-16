// A client of one markworkd connection: requests with replies, and the streams (a run's records, state changes).
// It is pure apart from timers: the bytes move through a Link, so tests can use an in-memory link and the app a
// Unix socket or an SSH bridge (fdlink.ts). Reconnecting is connection.ts.

import {
    DaemonError, PROTOCOL_VERSION, encodeRequest, parseFrame, replyError,
    type DaemonRecord, type HelloResult, type InfoResult, type ListFilter, type RunSummary, type SpawnResult, type SpawnSpec,
    type StateEvent, type StderrResult, type SubscribeResult,
} from './protocol.js';

// A line-oriented duplex channel to the daemon.
export interface Link {
    onLine: ((line: string) => void) | null;
    onClose: ((reason: string | null) => void) | null;   // once; reason is null for a clean close
    send(line: string): boolean;                         // false if the link is already closed
    close(): void;
}

export interface Timers {
    // Calls fn after ms; the returned function cancels it (harmless after it fired).
    after(ms: number, fn: () => void): () => void;
}

export const systemTimers: Timers = {
    after(ms, fn) {
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { timer = null; fn(); }, ms);
        return () => { if (timer) { clearTimeout(timer); timer = null; } };
    },
};

export interface ClientOptions {
    expectBridge?: boolean;     // ignore everything before the bridge's sentinel line (login banners over SSH)
    requestTimeoutMs?: number;  // default 60 s
    timers?: Timers;
}

export interface SubscribeHandlers {
    record(rec: DaemonRecord): void;
    end(lastSeq: number): void;   // after the exit record
}

export interface WatchHandlers {
    state(ev: StateEvent): void;
    overflow(): void;             // the daemon dropped the stream because we fell behind; watch again
}

interface Pending {
    resolve(body: Record<string, unknown>): void;
    reject(e: DaemonError): void;
    cancel(): void;
}

export class DaemonClient {
    onClosed: ((reason: string | null) => void) | null = null;
    private nextId = 0;
    private readonly pending = new Map<string, Pending>();
    private readonly subs = new Map<string, SubscribeHandlers>();
    private watcher: WatchHandlers | null = null;
    private banner: boolean;
    private closed = false;
    private readonly timers: Timers;
    private readonly timeoutMs: number;

    constructor(readonly link: Link, opts: ClientOptions = {}) {
        this.banner = opts.expectBridge === true;
        this.timers = opts.timers ?? systemTimers;
        this.timeoutMs = opts.requestTimeoutMs ?? 60000;
        link.onLine = line => this.receive(line);
        link.onClose = reason => this.handleClose(reason);
    }

    get isClosed(): boolean { return this.closed; }

    // ---------- requests ----------

    hello(name: string): Promise<HelloResult> { return this.call('hello', { proto: PROTOCOL_VERSION, client: name }); }
    ping(): Promise<void> { return this.call('ping'); }
    info(): Promise<InfoResult> { return this.call('info'); }
    spawn(spec: SpawnSpec): Promise<SpawnResult> { return this.call('spawn', spec); }
    get(run: string): Promise<RunSummary> { return this.call('get', { run }); }
    stop(run: string, graceMs = 0): Promise<void> { return this.call('stop', { run, grace_ms: graceMs }); }
    closeStdin(run: string): Promise<void> { return this.call('close_stdin', { run }); }
    forget(run: string): Promise<void> { return this.call('forget', { run }); }
    stderr(run: string, tailBytes = 0): Promise<StderrResult> { return this.call('stderr', { run, tail_bytes: tailBytes }); }
    shutdown(force = false): Promise<void> { return this.call('shutdown', { force }); }

    async write(run: string, line: string): Promise<number> {
        const r = await this.call<{ seq: number }>('write', { run, line });
        return r.seq;
    }

    async list(filter: ListFilter = {}): Promise<RunSummary[]> {
        const r = await this.call<{ runs: RunSummary[] }>('list', filter);
        return r.runs;
    }

    // ---------- streams ----------

    // Replays the run's log from fromSeq (0 = the start) and follows it. The handlers are registered before the
    // request goes out: the daemon sends the first records right behind the reply, in the same read.
    async subscribe(run: string, fromSeq: number, handlers: SubscribeHandlers): Promise<SubscribeResult> {
        this.subs.set(run, handlers);
        try {
            return await this.call<SubscribeResult>('subscribe', { run, from_seq: fromSeq });
        } catch (e) {
            if (this.subs.get(run) === handlers) this.subs.delete(run);
            throw e;
        }
    }

    async unsubscribe(run: string): Promise<void> {
        this.subs.delete(run);
        await this.call('unsubscribe', { run });
    }

    // Every run now, and from then on every state change.
    async watch(handlers: WatchHandlers): Promise<RunSummary[]> {
        this.watcher = handlers;
        try {
            const r = await this.call<{ runs: RunSummary[] }>('watch');
            return r.runs;
        } catch (e) {
            if (this.watcher === handlers) this.watcher = null;
            throw e;
        }
    }

    // Ends the connection. Runs are not affected.
    close(): void {
        this.link.close();
        this.handleClose(null);
    }

    // ---------- internals ----------

    private call<T = void>(op: string, params: object = {}): Promise<T> {
        if (this.closed) return Promise.reject(new DaemonError('connection_closed', 'the connection to the daemon is closed'));
        const id = String(++this.nextId);
        return new Promise<T>((resolve, reject) => {
            const cancel = this.timers.after(this.timeoutMs, () => {
                this.pending.delete(id);
                reject(new DaemonError('timeout', `the daemon did not answer ${op} in time`));
            });
            this.pending.set(id, { resolve: body => resolve(body as T), reject, cancel });
            if (!this.link.send(encodeRequest(id, op, params))) {
                cancel();
                this.pending.delete(id);
                reject(new DaemonError('connection_closed', 'the connection to the daemon is closed'));
            }
        });
    }

    private receive(line: string): void {
        const frame = parseFrame(line);
        if (!frame) return;
        if (this.banner) {
            if (frame.type === 'event' && frame.body.ev === 'bridge') this.banner = false;
            return;
        }
        if (frame.type === 'reply') this.reply(frame.re, frame.ok, frame.body);
        else this.event(frame.ev, frame.body);
    }

    private reply(re: string, ok: boolean, body: Record<string, unknown>): void {
        const p = this.pending.get(re);
        if (!p) return;
        this.pending.delete(re);
        p.cancel();
        if (ok) p.resolve(body);
        else p.reject(replyError(body));
    }

    private event(ev: string, body: Record<string, unknown>): void {
        const run = typeof body.run === 'string' ? body.run : '';
        if (ev === 'record') {
            this.subs.get(run)?.record({ seq: Number(body.seq), ts: Number(body.ts), kind: body.kind as DaemonRecord['kind'], line: String(body.line ?? ''), ...(body.truncated === true ? { truncated: true } : {}) });
        } else if (ev === 'end') {
            const h = this.subs.get(run);
            this.subs.delete(run);
            h?.end(Number(body.last_seq));
        } else if (ev === 'state') {
            this.watcher?.state({ run, state: body.state as StateEvent['state'], exit: body.exit as StateEvent['exit'], last_seq: Number(body.last_seq) });
        } else if (ev === 'watch_overflow') {
            const w = this.watcher;
            this.watcher = null;
            w?.overflow();
        }
    }

    private handleClose(reason: string | null): void {
        if (this.closed) return;
        this.closed = true;
        const err = new DaemonError('connection_closed', reason ? `the connection to the daemon ended: ${reason}` : 'the connection to the daemon ended');
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const p of pending) { p.cancel(); p.reject(err); }
        this.subs.clear();
        this.watcher = null;
        this.onClosed?.(reason);
    }
}
