// Watches the open pull requests of one repository by polling. A desktop app has no public address for webhooks,
// so it asks on a timer and compares with what it saw last time. The first poll only records a baseline, so
// opening a folder never announces the pull requests that were already there.

import { ForgeError, type ForgeProvider, type PullRequest } from './types';

export type PullEvent =
    | { kind: 'opened'; pull: PullRequest }
    | { kind: 'updated'; pull: PullRequest }
    | { kind: 'closed'; pull: PullRequest };      // gone from the open list: merged or closed, the follow-up tells which

// What matters for "something changed": the forge bumps updated_at for pushes and comments; mergeable flips on its own.
const signature = (p: PullRequest) => `${p.updatedAt}|${p.mergeable}|${p.title}`;

// Pure: the events between two lists of open pull requests.
export function diffPulls(before: readonly PullRequest[], after: readonly PullRequest[]): PullEvent[] {
    const old = new Map(before.map(p => [p.number, p]));
    const events: PullEvent[] = [];
    for (const pull of after) {
        const previous = old.get(pull.number);
        if (!previous) events.push({ kind: 'opened', pull });
        else if (signature(previous) !== signature(pull)) events.push({ kind: 'updated', pull });
        old.delete(pull.number);
    }
    for (const pull of old.values()) events.push({ kind: 'closed', pull });
    return events;
}

export class PullMonitor {
    onChange: (pulls: readonly PullRequest[], events: PullEvent[]) => void = () => {};
    onError: (error: ForgeError) => void = () => {};
    private known: PullRequest[] | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private polling = false;

    constructor(private readonly provider: ForgeProvider) {}

    get pulls(): readonly PullRequest[] { return this.known ?? []; }

    // One round. Safe to call from the timer and from a refresh button at the same time: a round that is still running wins.
    async poll(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        try {
            const current = await this.provider.listPulls('open');
            const events = this.known ? diffPulls(this.known, current) : [];
            const first = this.known === null;
            this.known = current;
            if (first || events.length) this.onChange(current, events);
        } catch (e) {
            this.onError(e instanceof ForgeError ? e : new ForgeError('server', e instanceof Error ? e.message : String(e)));
        } finally {
            this.polling = false;
        }
    }

    start(intervalSeconds: number): void {
        this.stop();
        void this.poll();
        this.timer = setInterval(() => { void this.poll(); }, intervalSeconds * 1000);
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
}
