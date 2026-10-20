// The Assistant panel's state: the conversation as the core told it with `chat.*` notices, the
// change proposals it asked about (`ask.proposal`), and what the user did, sent as `act.chat.*`. It is a store of its own, apart
// from the window's, because an answer streams in many small notices and only the panel should draw again for them.
// It decides nothing: whether a key exists, what is sent, and what is written are the core's.

import { TraceReplica } from '../../src/agent/tracefeed.js';
import type { TraceEvent } from '../../src/agent/trace.js';
import type { Reply } from '../../src/app/protocol/messages.js';
import type {
    BuiltContext, ChatPanelSettings, ChatSummary, ContextOptions, KeySource, ProposalChange, SavedChatView, ToolStep, TraceUpdate, TurnOutcome, WorkState,
} from '../../src/app/protocol/chat.js';

export type Phase = 'thinking' | 'step' | 'writing' | 'done' | 'stopped' | 'failed';

// One answer: live while its turn runs, or read back from a saved conversation.
export interface AnswerView {
    turn: number;
    question: string | null;       // null = read back from disk: no Retry
    text: string;
    reasoning: string;
    context: string | null;        // "Context: ≈12k tokens · …"
    steps: ToolStep[];
    phase: Phase;
    work: { work: WorkState; running: boolean; elapsed: number } | null;
    outcome: TurnOutcome | null;
    cards: number[];               // the proposals of this turn, in the order they came
    startedAt: number;
    endedAt: number | null;
}

// A past action of the agent in a conversation that was opened again: its diff, and Undo while it is still applied.
export interface PastAction { id: string; status: string; summary: string; changes: ProposalChange[] }

export type Entry =
    | { kind: 'user'; text: string }
    | { kind: 'answer'; answer: AnswerView }
    | { kind: 'note'; text: string; error: boolean }
    | { kind: 'work'; work: WorkState }
    | { kind: 'past'; action: PastAction };

export type ProposalState = 'open' | 'applied' | 'rejected' | 'failed' | 'cancelled';

export interface ProposalView {
    ask: number;
    batch: boolean;
    changes: ProposalChange[];
    state: ProposalState;
    message: string;               // what the card says once it was decided
    appliedFiles: number[] | null; // a batch applied in part
    note: string;
    error: string;                 // the reason an apply failed, kept for the review that stays open
    undone: boolean;
}

export interface ChatState {
    settings: ChatPanelSettings | null;
    models: string[];              // the models the setting can take
    busy: boolean;
    entries: Entry[];
    proposals: Record<number, ProposalView>;
    built: BuiltContext | null;    // the context of the draft, or of the last turn
    draft: string;
    key: KeySource | null | undefined;   // where the API key is kept; null = none, undefined = not asked yet
    keyPrompt: number;             // how many times a send found no key: the settings open
    review: number | null;         // the proposal whose review is open
    logOpen: boolean;
    logRev: number;                // how many times the agent log changed
    chats: ChatSummary[] | null | undefined;   // the saved conversations; null = no work folder, undefined = not asked yet
    focus: number;                 // how many times the input was asked for
}

// The wire as the panel needs it.
export interface ChatLink {
    notify(ev: string, payload?: Record<string, unknown>): void;
    request(op: string, payload?: Record<string, unknown>): Promise<Reply>;
}

export const fmtTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// A one-line summary of what is sent: the document, selection, attachments, and the number of excerpts per file.
export function describeContext(built: BuiltContext): string {
    const parts = [`≈${fmtTokens(built.tokens)} tokens`];
    const excerpts = new Map<string, number>();
    for (const item of built.items) {
        if (item.kind === 'excerpt') {
            const file = item.label.split(' › ')[0];
            excerpts.set(file, (excerpts.get(file) ?? 0) + 1);
        } else if (item.kind !== 'map') parts.push(item.label);
    }
    for (const [file, n] of excerpts) parts.push(`${plural(n, 'excerpt', 'excerpts')} from ${file}`);
    if (built.unknownMentions.length) parts.push(`not found: ${built.unknownMentions.map(m => `@${m}`).join(', ')}`);
    return `Context: ${parts.join(' · ')}`;
}

// The line of the status card: what the agent is doing, or how the turn ended.
export function statusLine(a: AnswerView): string {
    const n = a.steps.length;
    switch (a.phase) {
        case 'thinking': return 'Thinking…';
        case 'writing': return 'Writing the answer…';
        case 'step': {
            const running = a.steps.findLast(s => !s.summary);
            return running ? `${running.label} · step ${n}` : 'Thinking…';
        }
        case 'done': return n ? plural(n, 'lookup', 'lookups') : 'Answered';
        case 'stopped': return n ? `Stopped after step ${n}` : a.text.trim() ? 'Stopped' : 'Stopped before any answer';
        case 'failed': return 'Something went wrong';
    }
}

// "10 in (4 from cache) · 5 out · 2 lookups · 1 change applied"
export function usageLine(outcome: Extract<TurnOutcome, { usage: unknown }>): string {
    const u = outcome.usage;
    if (!u) return '';
    return [
        u.cached ? `${fmtTokens(u.prompt)} in (${fmtTokens(u.cached)} from cache)` : `${fmtTokens(u.prompt)} in`,
        `${fmtTokens(u.completion)} out`,
        ...outcome.toolCalls ? [plural(outcome.toolCalls, 'lookup', 'lookups')] : [],
        ...outcome.applied ? [plural(outcome.applied, 'change applied', 'changes applied')] : [],
    ].join(' · ');
}

const RESUME = 'Resume the saved work. Read the actual contents, check the journal, and do not repeat changes that were already applied.';

export class ChatModel {
    private snapshot: ChatState = {
        settings: null, models: [], busy: false, entries: [], proposals: {}, built: null, draft: '', key: undefined, keyPrompt: 0, review: null,
        logOpen: false, logRev: 0, chats: undefined, focus: 0,
    };
    private readonly listeners = new Set<() => void>();
    // The agent log: a copy of the core's, kept up to date by `chat.log`.
    readonly log = new TraceReplica();
    private turn = 0;                  // the turn whose answer is shown live
    private buffered = '';             // streamed text not yet in the state
    private bufferedReasoning = '';
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly answers = new Map<number, (note: string) => void>();   // the asks waiting for the user, by proposal

    constructor(private readonly link: () => ChatLink | null) {
        this.log.onClear = () => { void this.link()?.request('act.chat.clearLog'); };
        this.log.onChange = () => this.set({ logRev: this.snapshot.logRev + 1 });
    }

    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getState = (): ChatState => this.snapshot;

    private set(patch: Partial<ChatState>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        for (const l of this.listeners) l();
    }

    private async request(op: string, payload: Record<string, unknown> = {}): Promise<Reply | null> {
        return (await this.link()?.request(op, payload)) ?? null;
    }

    // The core's current settings and log, asked for once the connection is up (the notices before it are not kept).
    async sync(): Promise<void> {
        const reply = await this.request('act.chat.sync');
        if (!reply?.ok) return;
        if (reply.settings) this.set({ settings: reply.settings as ChatPanelSettings, models: reply.models as string[] });
        this.log.apply({ reset: true, events: reply.events as TraceEvent[] });
        void this.updateContext();
    }

    // ---------- What the core tells ----------

    private changeAnswer(turn: number, patch: Partial<AnswerView> | ((a: AnswerView) => Partial<AnswerView>)): void {
        const at = this.snapshot.entries.findLastIndex(e => e.kind === 'answer' && e.answer.turn === turn);
        if (at < 0 || turn !== this.turn) return;
        const entry = this.snapshot.entries[at] as Extract<Entry, { kind: 'answer' }>;
        const answer = { ...entry.answer, ...typeof patch === 'function' ? patch(entry.answer) : patch };
        const entries = this.snapshot.entries.slice();
        entries[at] = { kind: 'answer', answer };
        this.set({ entries });
    }

    private addEntry(entry: Entry): void { this.set({ entries: [...this.snapshot.entries, entry] }); }
    note(text: string, error = false): void { this.addEntry({ kind: 'note', text, error }); }

    // The streamed text is put into the state a few times a second, not on every notice.
    private queueFlush(): void {
        this.timer ??= setTimeout(() => this.flush(), 65);
    }

    private flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const text = this.buffered, reasoning = this.bufferedReasoning;
        this.buffered = this.bufferedReasoning = '';
        if (!text && !reasoning) return;
        this.changeAnswer(this.turn, a => ({
            text: a.text + text, reasoning: a.reasoning + reasoning,
            phase: text && (a.phase === 'thinking' || a.phase === 'step') ? 'writing' : reasoning && a.phase === 'step' ? 'thinking' : a.phase,
        }));
    }

    notice(ev: string, p: Record<string, unknown>): boolean {
        switch (ev) {
            case 'chat.settings': this.set({ settings: p.settings as ChatPanelSettings, models: p.models as string[] }); void this.updateContext(); return true;
            case 'chat.noKey':
                this.note('There is no DeepSeek API key yet. Open the settings (gear icon), paste the key, then send again.', true);
                this.set({ keyPrompt: this.snapshot.keyPrompt + 1 });
                return true;
            case 'chat.saveFailed': this.note(`Conversation history was not saved: ${String(p.error)}`, true); return true;
            case 'chat.busy': this.set({ busy: p.busy === true }); if (p.busy !== true) void this.updateContext(); return true;
            case 'chat.turn': this.startTurn(p.turn as number, p.question as string); return true;
            case 'chat.context': {
                const built = p.built as BuiltContext;
                this.changeAnswer(p.turn as number, { context: describeContext(built) });
                if (p.turn === this.turn) this.set({ built });
                return true;
            }
            case 'chat.text': if (p.turn === this.turn) { this.buffered += p.delta as string; this.queueFlush(); } return true;
            case 'chat.reasoning': if (p.turn === this.turn) { this.bufferedReasoning += p.delta as string; this.queueFlush(); } return true;
            case 'chat.tool': this.step(p.turn as number, p.step as ToolStep); return true;
            case 'chat.work': this.changeAnswer(p.turn as number, { work: { work: p.work as WorkState, running: p.running === true, elapsed: p.elapsed as number } }); return true;
            case 'chat.end': this.flush(); this.end(p.turn as number, p.outcome as TurnOutcome); return true;
            case 'chat.log': this.log.apply(p.update as TraceUpdate); return true;
            default: return false;
        }
    }

    private startTurn(turn: number, question: string): void {
        this.flush();
        this.turn = turn;
        const answer: AnswerView = { turn, question, text: '', reasoning: '', context: null, steps: [], phase: 'thinking', work: null, outcome: null, cards: [], startedAt: Date.now(), endedAt: null };
        this.set({ entries: [...this.snapshot.entries, { kind: 'user', text: question }, { kind: 'answer', answer }], draft: '' });
    }

    // Called twice per lookup (start and finish) with the same id.
    private step(turn: number, step: ToolStep): void {
        this.changeAnswer(turn, a => {
            const at = a.steps.findIndex(s => s.id === step.id);
            const steps = at < 0 ? [...a.steps, step] : a.steps.map((s, i) => i === at ? step : s);
            return { steps, phase: a.phase === 'thinking' || a.phase === 'step' || a.phase === 'writing' ? (step.summary ? 'thinking' : 'step') : a.phase };
        });
    }

    private end(turn: number, outcome: TurnOutcome): void {
        const failed = 'error' in outcome;
        this.changeAnswer(turn, a => ({
            outcome, endedAt: Date.now(), phase: failed ? 'failed' : outcome.cancelled ? 'stopped' : 'done',
            work: a.work ? { ...a.work, running: false } : null,
        }));
    }

    // ---------- Change proposals ----------

    // `ask.proposal`: a card in the answer and the review, open at once. The answer is the user's note; the core wrote what it
    // wrote (act.proposal.apply) before this is answered.
    ask(payload: Record<string, unknown>, onCancel: (listener: () => void) => void): Promise<{ note: string }> {
        const ask = payload.ask as number;
        const view: ProposalView = { ask, batch: payload.batch === true, changes: payload.changes as ProposalChange[], state: 'open', message: '', appliedFiles: null, note: '', error: '', undone: false };
        return new Promise(resolve => {
            this.answers.set(ask, note => resolve({ note }));
            const at = this.snapshot.entries.findLastIndex(e => e.kind === 'answer');
            const entries = this.snapshot.entries.slice();
            const last = entries[at];
            if (last?.kind === 'answer') entries[at] = { kind: 'answer', answer: { ...last.answer, cards: [...last.answer.cards, ask] } };
            this.set({ proposals: { ...this.snapshot.proposals, [ask]: view }, entries, review: ask });
            onCancel(() => this.decide(ask, 'cancelled', 'Cancelled.'));
        });
    }

    private changeProposal(ask: number, patch: Partial<ProposalView>): void {
        const view = this.snapshot.proposals[ask];
        if (view) this.set({ proposals: { ...this.snapshot.proposals, [ask]: { ...view, ...patch } } });
    }

    // The review ends: the card says how, and the ask is answered (once).
    private decide(ask: number, state: ProposalState, message: string, patch: Partial<ProposalView> = {}): void {
        const answer = this.answers.get(ask);
        if (!answer) return;
        this.answers.delete(ask);
        const view = this.snapshot.proposals[ask];
        this.changeProposal(ask, { state, message, ...patch });
        if (this.snapshot.review === ask && state !== 'failed') this.set({ review: null });
        answer(view?.note ?? '');
    }

    setNote(ask: number, note: string): void { this.changeProposal(ask, { note }); }

    // Apply (all of it, or the chosen files of a batch). A refusal keeps the review open to be read; the ask is answered either way.
    async apply(ask: number, chosen: number[] | null, note: string): Promise<void> {
        const view = this.snapshot.proposals[ask];
        if (!view || view.state !== 'open') return;
        this.changeProposal(ask, { note: note.trim() });
        const reply = await this.request('act.proposal.apply', { ask, chosen });
        const error = reply ? reply.ok ? (reply.error as string | null) : reply.error.message : 'The core is not reachable.';
        if (error) { this.decide(ask, 'failed', `Failed to apply: ${error}`, { error, note: note.trim() }); return; }
        const total = view.changes.length;
        const partial = chosen && chosen.length < total ? chosen : null;
        this.decide(ask, 'applied', partial ? `Applied ${partial.length} of ${total} files.` : 'Applied.', { appliedFiles: partial, note: note.trim() });
    }

    // Reject, or close the review without applying.
    reject(ask: number, note: string): void {
        const view = this.snapshot.proposals[ask];
        if (!view) return;
        if (view.state === 'open') {
            const text = note.trim();
            this.changeProposal(ask, { note: text });
            this.decide(ask, 'rejected', text ? `Rejected: ${text}` : 'Rejected.', { note: text });
        } else if (this.snapshot.review === ask) this.set({ review: null });
    }

    openReview(ask: number | null): void { this.set({ review: ask }); }

    // Undo what was applied; the core writes the reverse.
    async undo(target: { ask: number } | { event: string }): Promise<boolean> {
        if (this.snapshot.busy) { this.note('Wait for the agent to finish before undoing the change.', true); return false; }
        const reply = await this.request('act.chat.undo', { target });
        const error = reply?.ok ? (reply.error as string | null) : reply?.error.message ?? 'The core is not reachable.';
        if (error) { this.note(`Cannot be undone: ${error}`, true); return false; }
        if ('ask' in target) this.changeProposal(target.ask, { undone: true });
        else this.set({ entries: this.snapshot.entries.map(e => e.kind === 'past' && e.action.id === target.event ? { kind: 'past', action: { ...e.action, status: 'reverted' } } : e) });
        return true;
    }

    // ---------- What the user does ----------

    setDraft(draft: string): void { this.set({ draft }); }
    focusInput(): void { this.set({ focus: this.snapshot.focus + 1 }); }

    async send(text: string): Promise<void> {
        const reply = await this.request('act.chat.send', { text });
        if (reply && !reply.ok) this.note(reply.error.message, true);
    }
    stop(): void { void this.request('act.chat.stop'); }

    reset(): void {
        void this.request('act.chat.reset');
        this.flush();
        this.turn = 0;
        this.set({ entries: [], proposals: {}, review: null });
        void this.updateContext();
    }

    insert(text: string): Promise<boolean> {
        return this.request('act.chat.insert', { text }).then(r => r?.ok === true && r.inserted === true);
    }

    // The context of the draft (nothing is sent): its size for the button, its parts for the popover.
    async updateContext(): Promise<void> {
        if (this.snapshot.busy) return;
        const reply = await this.request('act.chat.preview', { draft: this.snapshot.draft });
        if (reply?.ok && !this.snapshot.busy) this.set({ built: reply.built as BuiltContext });
    }

    setOptions(options: ContextOptions): void {
        const settings = this.snapshot.settings;
        if (settings) this.set({ settings: { ...settings, options } });
        void this.request('act.chat.options', { options }).then(() => this.updateContext());
    }

    // Model, thinking, and saving are settings of the core; it sends them back as `chat.settings`.
    setModel(model: string): void { this.patchSettings({ model }); void this.request('act.chat.model', { model }); }
    setThinking(thinking: boolean): void { this.patchSettings({ thinking }); void this.request('act.chat.thinking', { thinking }); }
    setSaveChats(save: boolean): void { this.patchSettings({ saveChats: save }); void this.request('act.chat.save', { save }); }
    private patchSettings(patch: Partial<ChatPanelSettings>): void {
        if (this.snapshot.settings) this.set({ settings: { ...this.snapshot.settings, ...patch } });
    }

    async keyStatus(): Promise<void> {
        const reply = await this.request('act.chat.key', { action: 'status' });
        if (reply?.ok) this.set({ key: reply.source as KeySource | null });
    }
    // The key is sent to the core and kept there; the panel only learns where it is kept.
    async saveKey(key: string): Promise<string | null> {
        const reply = await this.request('act.chat.key', { action: 'save', key });
        if (!reply?.ok) return reply ? reply.error.message : 'The core is not reachable.';
        this.set({ key: reply.source as KeySource });
        return null;
    }
    async forgetKey(): Promise<void> {
        const reply = await this.request('act.chat.key', { action: 'forget' });
        if (reply?.ok) this.set({ key: null });
    }

    async loadChats(): Promise<void> {
        const reply = await this.request('act.chat.chats');
        if (reply?.ok) this.set({ chats: reply.chats as ChatSummary[] | null });
    }

    async deleteChat(path: string): Promise<void> {
        const reply = await this.request('act.chat.delete', { path });
        const error = reply?.ok ? (reply.error as string | null) : reply?.error.message ?? null;
        if (error) this.note(error, true);
        await this.loadChats();
    }

    // Show a saved conversation and continue from there: the next turns are appended to the same file.
    async openChat(path: string): Promise<boolean> {
        const reply = await this.request('act.chat.open', { path });
        const chat = reply?.ok ? reply.chat as SavedChatView | null : null;
        if (!chat) { this.note('The conversation file could not be read.', true); return false; }
        this.flush();
        this.turn = 0;
        const entries: Entry[] = [];
        for (const t of chat.turns) {
            if (t.role === 'user') entries.push({ kind: 'user', text: t.content });
            else entries.push({ kind: 'answer', answer: { turn: -1, question: null, text: t.content, reasoning: '', context: null, steps: [], phase: 'done', work: null, outcome: null, cards: [], startedAt: 0, endedAt: 0 } });
        }
        if (chat.actions) entries.push({ kind: 'note', text: chat.actions, error: false });
        for (const e of chat.events.filter(e => e.changes.length).slice(-20)) entries.push({ kind: 'past', action: { id: e.id, status: e.status, summary: e.summary, changes: e.changes } });
        if (chat.work) entries.push({ kind: 'work', work: chat.work });
        this.set({ entries, proposals: {}, review: null });
        void this.updateContext();
        return true;
    }

    resume(): void { void this.send(RESUME); }

    openLog(open: boolean): void { this.set({ logOpen: open }); }
}
