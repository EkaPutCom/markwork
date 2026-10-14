// The wire format of markworkd (see docs/design/markworkd.md): newline-delimited JSON. Pure: no GI, no I/O.

export const PROTOCOL_VERSION = 1;

export type RunState = 'queued' | 'running' | 'exited';
export type ExitReason = 'exited' | 'signaled' | 'stopped' | 'canceled' | 'start_failed' | 'idle_timeout' | 'log_limit' | 'lost';
export type RecordKind = 'start' | 'in' | 'out' | 'exit';

// One entry of a run's log. The daemon numbers them 1, 2, 3, ... without gaps.
export interface DaemonRecord {
    seq: number;
    ts: number;           // Unix milliseconds
    kind: RecordKind;
    line: string;
    truncated?: boolean;  // a single line longer than the daemon's limit: only its start is kept
}

export interface ExitInfo {
    reason: ExitReason;
    code?: number;
    signal?: number;
    error?: string;
}

export interface SpawnSpec {
    run: string;
    program: string;      // a name the daemon resolves, never a path
    args: string[];
    cwd: string;
    lane?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    initial_input?: string[];
    idle_ttl_sec?: number;
}

export interface RunSummary {
    run: string;
    state: RunState;
    program: string;
    args: string[];
    cwd: string;
    lane?: string;
    labels?: Record<string, string>;
    pid?: number;
    created_at: number;
    started_at: number | null;
    ended_at: number | null;
    exit: ExitInfo | null;
    last_seq: number;
    log_bytes: number;
    stderr_bytes: number;
    queue_position: number;
}

export interface HelloResult { proto: number; daemon: string; machine: string; pid: number; features: string[] }
export interface InfoResult { daemon: string; machine: string; pid: number; started_at: number; state_dir: string; queued: number; running: number; exited: number; max_active_runs: number }
export interface SpawnResult { run: string; state: RunState; position: number; existing?: boolean }
export interface SubscribeResult { first_seq: number; last_seq: number; state: RunState }
export interface StderrResult { text: string; head_dropped: boolean }
export interface ListFilter { state?: RunState; lane?: string; labels?: Record<string, string> }

// A state change of a run, from watch.
export interface StateEvent { run: string; state: RunState; exit?: ExitInfo; last_seq: number }

// A failed request, or a connection that ended. `code` is the daemon's error code, or one of ours
// (connection_closed, timeout).
export class DaemonError extends Error {
    constructor(readonly code: string, message: string, readonly supported?: number[]) {
        super(message);
        this.name = 'DaemonError';
    }
}

// ---------- frames ----------

export type Frame =
    | { type: 'reply'; re: string; ok: boolean; body: Record<string, unknown> }
    | { type: 'event'; ev: string; body: Record<string, unknown> };

// Parses one line from the daemon. Anything that is not one of our frames (a login banner, noise) gives null.
export function parseFrame(line: string): Frame | null {
    const text = line.trim();
    if (!text.startsWith('{')) return null;
    let body: unknown;
    try { body = JSON.parse(text); } catch { return null; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const o = body as Record<string, unknown>;
    if (typeof o.re === 'string') return { type: 'reply', re: o.re, ok: o.ok === true, body: o };
    if (typeof o.ev === 'string') return { type: 'event', ev: o.ev, body: o };
    return null;
}

export function encodeRequest(id: string, op: string, params: object = {}): string {
    return JSON.stringify({ ...params, id, op });
}

// The error of a failed reply.
export function replyError(body: Record<string, unknown>): DaemonError {
    const e = body.error;
    if (typeof e === 'object' && e !== null) {
        const o = e as Record<string, unknown>;
        return new DaemonError(String(o.code ?? 'internal'), String(o.message ?? 'request failed'), Array.isArray(o.supported) ? o.supported.map(Number) : undefined);
    }
    return new DaemonError('internal', 'request failed');
}

// The exit record's line holds the ExitInfo as JSON.
export function parseExit(line: string): ExitInfo {
    try {
        const o = JSON.parse(line) as ExitInfo;
        if (typeof o?.reason === 'string') return o;
    } catch { /* fall through */ }
    return { reason: 'exited', error: 'unreadable exit record' };
}

// The shell-style status of a finished run: the exit code, 128 + signal for a signal, 127 when it never started.
export function exitStatus(exit: ExitInfo): number {
    if (exit.reason === 'start_failed') return 127;
    if (exit.code !== undefined) return exit.code;
    if (exit.signal !== undefined) return 128 + exit.signal;
    return exit.reason === 'lost' ? 1 : 0;
}

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
