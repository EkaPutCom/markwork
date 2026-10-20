// The agent log as a stream of updates (pure): the core keeps the AgentTrace and a viewer keeps a TraceReplica
// of it, fed by a TraceFeed. An update carries whole events (plain data), so it can cross a process boundary
// (docs/design/protocol.md 6.4, chat.log and view.runlog). Updates are batched: reasoning and answers stream in a few
// characters at a time, and one update per interval carries each event that changed in it once.

import { AgentTrace, MAX_EVENTS, type TraceEvent } from './trace.js';

// reset = the events are the whole log now; otherwise each event is added, or replaces the one with its seq.
export interface TraceUpdate {
    reset: boolean;
    events: TraceEvent[];
}

const BATCH_MS = 30;

export class TraceFeed {
    private changed = new Map<number, TraceEvent>();
    private reset = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly trace: AgentTrace, private readonly send: (update: TraceUpdate) => void) {}

    // Send the log as it is, then every change. One feed per trace: it takes the trace's listener.
    start(): void {
        this.trace.onChange = event => this.note(event);
        this.send({ reset: true, events: [...this.trace.events] });
    }

    stop(): void {
        this.trace.onChange = () => {};
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.changed.clear();
    }

    // Send what changed now instead of at the end of the interval.
    flush(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.reset) this.send({ reset: true, events: [...this.trace.events] });
        else if (this.changed.size) this.send({ reset: false, events: [...this.changed.values()] });
        this.reset = false;
        this.changed.clear();
    }

    private note(event: TraceEvent | null): void {
        if (event) this.changed.set(event.seq, event);
        else this.reset = true;
        this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
    }
}

// What a log viewer reads: the events, and a call when they change.
export interface LogSource {
    readonly events: readonly TraceEvent[];
    onChange: () => void;
    text(): string;
    clear(): void;     // ask for the log to be cleared; the events change when the core has done it
}

// A viewer's copy of a log, kept up to date by applying the updates of a TraceFeed.
export class TraceReplica implements LogSource {
    readonly events: TraceEvent[] = [];
    onChange: () => void = () => {};
    // The viewer asked for the log to be cleared; the owner passes it on to the core.
    onClear: () => void = () => {};

    apply(update: TraceUpdate): void {
        if (update.reset) {
            this.events.length = 0;
            this.events.push(...update.events);
        } else {
            for (const event of update.events) this.upsert(event);
            if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
        }
        this.onChange();
    }

    private upsert(event: TraceEvent): void {
        if (this.events.length && event.seq < this.events[0].seq) return;   // already trimmed away
        // Events arrive in order of seq, and a changed one is nearly always among the last.
        for (let i = this.events.length - 1; i >= 0 && this.events[i].seq >= event.seq; i--) {
            if (this.events[i].seq === event.seq) { this.events[i] = event; return; }
        }
        this.events.push(event);
    }

    text(): string {
        return this.events.map(AgentTrace.format).join('\n\n');
    }

    clear(): void {
        this.onClear();
    }
}
