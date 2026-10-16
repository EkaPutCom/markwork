// A durable connection to one markworkd: it connects, says hello, and when the link drops (an SSH session that
// died, a daemon that restarted) it reconnects with a growing delay and resumes what was being followed, from the
// record after the last one it delivered, so the caller sees every record once and in order.

import { DaemonClient, systemTimers, type Link, type Timers } from './client.js';
import { DaemonError, type DaemonRecord, type RunSummary, type StateEvent } from './protocol.js';

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'waiting' | 'failed' | 'closed';

export interface ConnectionOptions {
    open(): Link;                  // makes a new link; throws if the machine cannot be reached
    name: string;                  // what we call ourselves in hello
    expectBridge?: boolean;
    backoffMs?: number[];          // delays between attempts; the last one repeats
    requestTimeoutMs?: number;
    timers?: Timers;
}

export interface FollowHandlers {
    record(rec: DaemonRecord): void;
    end(lastSeq: number): void;                // the run ended and all its records were delivered
    failed(error: DaemonError): void;          // the run cannot be followed any more (it is gone, or not allowed)
}

export interface Follower {
    readonly lastSeq: number;                  // the last record delivered (0 = none)
    stop(): void;
}

export interface WatchHandlers {
    snapshot(runs: RunSummary[]): void;        // every run; called after each (re)connect, before the changes after it
    state(ev: StateEvent): void;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000, 30000];
const TRANSIENT = new Set(['connection_closed', 'timeout']);

export class DaemonConnection {
    private status: ConnectionState = 'idle';
    private client: DaemonClient | null = null;
    private attempt = 0;
    private cancelRetry: (() => void) | null = null;
    private lastError = '';
    private failure: DaemonError | null = null;
    private waiters: { resolve(c: DaemonClient): void; reject(e: DaemonError): void }[] = [];
    private readonly followers = new Set<FollowerImpl>();
    private readonly watchers = new Set<WatchSub>();
    private readonly listeners = new Set<(state: ConnectionState, detail: string) => void>();
    private readonly timers: Timers;

    constructor(private readonly opts: ConnectionOptions) {
        this.timers = opts.timers ?? systemTimers;
    }

    get state(): ConnectionState { return this.status; }
    get detail(): string { return this.lastError; }   // why the last attempt failed, for the user

    onState(fn: (state: ConnectionState, detail: string) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    // Starts connecting. Idempotent; follow() and ready() call it.
    start(): void {
        if (this.status === 'idle') this.connect();
    }

    // The connected client, waiting through a reconnect if there is none right now.
    ready(): Promise<DaemonClient> {
        if (this.status === 'ready' && this.client) return Promise.resolve(this.client);
        // Final, unlike a link that dropped (connection_closed): callers retry the second but must give up on these.
        if (this.status === 'failed') return Promise.reject(this.failure ?? new DaemonError('failed', this.lastError));
        if (this.status === 'closed') return Promise.reject(new DaemonError('closed', 'the connection was shut down'));
        this.start();
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    // The connected client right now, or null. For callers that must not wait, to keep the order of their requests.
    current(): DaemonClient | null { return this.status === 'ready' ? this.client : null; }

    // Delivers the run's records from fromSeq (0 = the start) on, across reconnects, until it ends.
    follow(run: string, fromSeq: number, handlers: FollowHandlers): Follower {
        const f = new FollowerImpl(this, run, Math.max(1, fromSeq), handlers);
        this.followers.add(f);
        this.start();
        if (this.client && this.status === 'ready') f.attach(this.client);
        return f;
    }

    // Reports every run and the changes after it, across reconnects. Returns a function that stops it.
    watch(handlers: WatchHandlers): () => void {
        const w = new WatchSub(handlers);
        this.watchers.add(w);
        this.start();
        if (this.client && this.status === 'ready') w.attach(this.client);
        return () => this.watchers.delete(w);
    }

    dispose(): void {
        if (this.status === 'closed') return;
        this.cancelRetry?.();
        this.cancelRetry = null;
        const client = this.client;
        this.client = null;
        this.set('closed', 'closed');
        this.rejectWaiters(new DaemonError('closed', 'the connection was shut down'));
        this.followers.clear();
        this.watchers.clear();
        client?.close();
    }

    /** @internal */
    removeFollower(f: FollowerImpl): void { this.followers.delete(f); }

    // ---------- connecting ----------

    private set(state: ConnectionState, detail = ''): void {
        this.status = state;
        for (const fn of [...this.listeners]) fn(state, detail);
    }

    private connect(): void {
        this.set('connecting');
        let client: DaemonClient;
        try {
            client = new DaemonClient(this.opts.open(), { expectBridge: this.opts.expectBridge, requestTimeoutMs: this.opts.requestTimeoutMs, timers: this.timers });
        } catch (e) {
            this.retryLater(e instanceof Error ? e.message : String(e));
            return;
        }
        client.onClosed = reason => { if (this.client === client) this.lost(reason); };
        client.hello(this.opts.name).then(
            () => this.connected(client),
            (e: DaemonError) => {
                client.close();
                if (e.code === 'unsupported_proto') this.fail(e);
                else if (this.status === 'connecting') this.retryLater(e.message);
            });
    }

    private connected(client: DaemonClient): void {
        if (this.status !== 'connecting') { client.close(); return; }
        this.client = client;
        this.attempt = 0;
        this.lastError = '';
        this.set('ready');
        for (const w of this.waiters.splice(0)) w.resolve(client);
        for (const f of [...this.followers]) f.attach(client);
        for (const w of [...this.watchers]) w.attach(client);
    }

    private lost(reason: string | null): void {
        this.client = null;
        for (const f of this.followers) f.detach();
        this.retryLater(reason ?? 'the connection ended');
    }

    private retryLater(why: string): void {
        if (this.status === 'closed') return;
        this.lastError = why;
        const delays = this.opts.backoffMs ?? DEFAULT_BACKOFF;
        const delay = delays[Math.min(this.attempt++, delays.length - 1)];
        this.set('waiting', why);
        this.cancelRetry = this.timers.after(delay, () => { this.cancelRetry = null; if (this.status === 'waiting') this.connect(); });
    }

    private fail(e: DaemonError): void {
        this.failure = e;
        this.lastError = e.message;
        this.set('failed', e.message);
        this.rejectWaiters(e);
        for (const f of [...this.followers]) f.fail(e);
        this.followers.clear();
    }

    private rejectWaiters(e: DaemonError): void {
        for (const w of this.waiters.splice(0)) w.reject(e);
    }
}

class FollowerImpl implements Follower {
    private next: number;
    private done = false;
    private attached: DaemonClient | null = null;

    constructor(private readonly conn: DaemonConnection, private readonly run: string, from: number, private readonly h: FollowHandlers) {
        this.next = from;
    }

    get lastSeq(): number { return this.next - 1; }

    attach(client: DaemonClient): void {
        if (this.done) return;
        this.attached = client;
        client.subscribe(this.run, this.next, {
            record: rec => this.deliver(rec),
            end: last => { this.finish(); this.h.end(last); },
        }).catch((e: DaemonError) => {
            if (!TRANSIENT.has(e.code)) this.fail(e);   // a transient error is followed by a reconnect and a new attach
        });
    }

    detach(): void { this.attached = null; }

    fail(e: DaemonError): void {
        if (this.done) return;
        this.finish();
        this.h.failed(e);
    }

    stop(): void {
        if (this.done) return;
        const client = this.attached;
        this.finish();
        client?.unsubscribe(this.run).catch(() => { /* the connection may be gone already */ });
    }

    private deliver(rec: DaemonRecord): void {
        if (this.done || rec.seq < this.next) return;   // already delivered before a reconnect
        this.next = rec.seq + 1;
        this.h.record(rec);
    }

    private finish(): void {
        this.done = true;
        this.attached = null;
        this.conn.removeFollower(this);
    }
}

class WatchSub {
    private generation = 0;

    constructor(private readonly h: WatchHandlers) {}

    attach(client: DaemonClient): void {
        const mine = ++this.generation;
        // The daemon sends changes right behind the snapshot's reply, before our promise continues: hold them back
        // until the snapshot has been delivered, so the caller sees the snapshot first.
        let buffer: StateEvent[] | null = [];
        const state = (ev: StateEvent) => {
            if (mine !== this.generation) return;
            if (buffer) buffer.push(ev);
            else this.h.state(ev);
        };
        client.watch({ state, overflow: () => { if (mine === this.generation) this.attach(client); } }).then(runs => {
            if (mine !== this.generation) return;
            this.h.snapshot(runs);
            const held = buffer ?? [];
            buffer = null;
            for (const ev of held) this.h.state(ev);
        }, () => { /* the connection ended; the next connect attaches again */ });
    }
}
