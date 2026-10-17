// Agent activity log (pure, no GTK): the sequence of events of one conversation, from model rounds, reasoning,
// tool calls with their arguments and results, to change proposals. Only for the user to view;
// never sent to the model and not part of the conversation file.

export type TraceKind = 'turn' | 'round' | 'reasoning' | 'text' | 'tool' | 'usage' | 'note' | 'error';

export interface TraceEvent {
    seq: number;
    time: string;          // local ISO, e.g. 2026-10-05T14:20:00
    kind: TraceKind;
    round?: number;        // model round (from 1) in which this event happened
    title: string;
    detail: string;        // full contents (reasoning, answer, token line, error), already truncated to MAX_DETAIL
    status?: 'running' | 'ok' | 'failed';
    ms?: number;           // duration of the event, if any
    args?: string;         // tool call: the arguments, as neat JSON
    result?: string;       // tool call: what came back
    usage?: TraceUsage;    // model round: tokens
    items?: string[];      // turn: the context sources that were sent
}

export interface TraceUsage { prompt: number; cached: number; completion: number }
type StartFields = Partial<Pick<TraceEvent, 'round' | 'status' | 'ms' | 'args' | 'items'>>;
type EndFields = Partial<Pick<TraceEvent, 'result' | 'usage'>>;

const MAX_DETAIL = 20000;
export const MAX_EVENTS = 2000;

const clip = (text: string): string => text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n… (${text.length - MAX_DETAIL} more characters truncated)` : text;

// Tool arguments are raw JSON from the model; shown neatly if valid, as is if not.
export function prettyArguments(raw: string): string {
    if (!raw.trim()) return '(no arguments)';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

const KINDS: ReadonlySet<string> = new Set(['turn', 'round', 'reasoning', 'text', 'tool', 'usage', 'note', 'error']);
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

function sanitizeUsage(raw: unknown): TraceUsage | undefined {
    const u = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const prompt = num(u.prompt), cached = num(u.cached), completion = num(u.completion);
    return prompt !== undefined && cached !== undefined && completion !== undefined ? { prompt, cached, completion } : undefined;
}

const clipped = (v: unknown): string | undefined => str(v) === undefined ? undefined : clip(str(v)!);

// The optional fields of a saved event; each one only when it is well-formed.
function sanitizeOptional(r: Record<string, unknown>): Partial<TraceEvent> {
    return {
        round: num(r.round), ms: num(r.ms), args: clipped(r.args), result: clipped(r.result), usage: sanitizeUsage(r.usage),
        items: Array.isArray(r.items) ? r.items.filter((i): i is string => typeof i === 'string').slice(0, 100) : undefined,
        // An event that was still running when the file was written never finished.
        status: r.status === 'ok' ? 'ok' : r.status === 'failed' || r.status === 'running' ? 'failed' : undefined,
    };
}

// One line of a saved log, from a file that anybody may have edited: only well-formed fields are kept.
function sanitize(raw: unknown): TraceEvent | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const seq = num(r.seq), time = str(r.time), title = str(r.title);
    if (seq === undefined || time === undefined || title === undefined || typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
    const event: TraceEvent = { seq, time, kind: r.kind as TraceKind, title: clip(title), detail: clip(str(r.detail) ?? '') };
    for (const [key, value] of Object.entries(sanitizeOptional(r))) if (value !== undefined) Object.assign(event, { [key]: value });
    return event;
}

export class AgentTrace {
    readonly events: TraceEvent[] = [];
    private seq = 0;
    private open = new Map<string, number>();   // key → index of the event still in progress, to be completed later
    private starts = new Map<string, number>();
    // Told of each event that was added or changed; null = the whole log was replaced or cleared. (TraceFeed turns these into updates.)
    onChange: (event: TraceEvent | null) => void = () => {};

    constructor(private readonly now: () => number = Date.now, private readonly stamp: () => string = () => new Date().toISOString().slice(0, 19)) {}

    clear(): void {
        this.events.length = 0;
        this.open.clear();
        this.starts.clear();
        this.onChange(null);
    }

    add(kind: TraceKind, title: string, detail = '', extra: StartFields = {}): TraceEvent {
        const event: TraceEvent = { seq: ++this.seq, time: this.stamp(), kind, title, detail: clip(detail), ...extra };
        if (event.args !== undefined) event.args = clip(event.args);
        this.events.push(event);
        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
            this.open.clear();   // indices shift; events still in progress are too old to be completed
        }
        this.onChange(event);
        return event;
    }

    // Start an event whose completion follows (tool call, model round); completed through finish() with the same key.
    begin(kind: TraceKind, key: string, title: string, detail = '', round?: number, extra: StartFields = {}): void {
        const event = this.add(kind, title, detail, { round, status: 'running', ...extra });
        this.open.set(`${kind}:${key}`, this.events.indexOf(event));
        this.starts.set(`${kind}:${key}`, this.now());
    }

    finish(kind: TraceKind, key: string, status: 'ok' | 'failed', detail?: string, title?: string, extra: EndFields = {}): void {
        const k = `${kind}:${key}`;
        const index = this.open.get(k);
        const started = this.starts.get(k);
        this.open.delete(k);
        this.starts.delete(k);
        if (index === undefined) return;
        const event = this.events[index];
        if (!event) return;
        event.status = status;
        if (detail !== undefined) event.detail = clip(event.detail ? `${event.detail}\n\n${detail}` : detail);
        if (title) event.title = title;
        if (extra.result !== undefined) event.result = clip(extra.result);
        if (extra.usage) event.usage = extra.usage;
        if (started !== undefined) event.ms = this.now() - started;
        this.onChange(event);
    }

    // Reasoning and answers stream in little by little: append to the last event of the same kind in the same round.
    append(kind: 'reasoning' | 'text', round: number, delta: string): void {
        const last = this.events[this.events.length - 1];
        if (last && last.kind === kind && last.round === round) {
            last.detail = clip(last.detail + delta);
            this.onChange(last);
        } else {
            this.add(kind, kind === 'reasoning' ? 'Model reasoning' : 'Model answer', delta, { round });
        }
    }

    // The events of a saved log (one JSON object per line, see jsonl()); lines that are not valid events are skipped.
    static parse(text: string): TraceEvent[] {
        const events: TraceEvent[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const event = sanitize(JSON.parse(line));
                if (event) events.push(event);
            } catch { /* a damaged line */ }
        }
        return events.slice(-MAX_EVENTS);
    }

    // Replace the log with a saved one (in place: the log window keeps watching the same object).
    restore(events: readonly TraceEvent[]): void {
        this.events.length = 0;
        this.events.push(...events);
        this.seq = events.reduce((max, e) => Math.max(max, e.seq), 0);
        this.open.clear();
        this.starts.clear();
        this.onChange(null);
    }

    // One event as plain text, to copy or export.
    static format(e: TraceEvent): string {
        const head = `[${e.time.slice(11)}]${e.round ? ` round ${e.round} ·` : ''} ${e.title}${e.ms !== undefined ? ` (${e.ms} ms)` : ''}${e.status === 'failed' ? ' — FAILED' : ''}`;
        const parts = [head, e.args !== undefined ? `Arguments:\n${e.args}` : '', e.detail, e.result !== undefined ? `Result:\n${e.result}` : ''];
        return parts.filter(Boolean).join('\n');
    }

    text(): string {
        return this.events.map(AgentTrace.format).join('\n\n');
    }

    // One JSON object per line, for analysis outside the app.
    jsonl(): string {
        return this.events.map(e => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : '');
    }
}
