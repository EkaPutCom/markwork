// The Assistant panel over the protocol (docs/design/protocol.md 6.5 and 7): every thing the conversation shows becomes a
// `chat.*` notice, a change proposal becomes the ask `ask.proposal`, and what the user did comes back as `act.chat.*` and
// `act.proposal.apply` (handlers/chat.ts). The panel never gets a Change to send back: it sees how a change looks (its
// diff) and names a proposal by the number the core gave it, so what is written is always what the agent proposed.

import type { BuiltContext, ContextOptions } from '../../agent/context.js';
import type { TurnOutcome } from '../../agent/chatcontroller.js';
import type { ChatSummary } from '../../agent/chatstore.js';
import type { ToolStep } from '../../agent/session.js';
import type { SavedChat } from '../../agent/transcript.js';
import { journalText, type ActionEvent } from '../../agent/journal.js';
import type { WorkState } from '../../agent/work.js';
import type { TraceUpdate } from '../../agent/tracefeed.js';
import type { TraceEvent } from '../../agent/trace.js';
import type { KeySource } from '../../agent/apikey.js';
import { describeChange, diffPreview, unifiedDiff, type Change } from '../../agent/changes.js';
import { parseDiff, type DiffLine } from '../../gitlog.js';
import { DEEPSEEK_MODELS } from '../../agent/models.js';
import { Cancellable } from '../../cancel.js';
import { _, fmt } from '../../i18n.js';
import type { ChatPanelSettings, ChatPanelView, ProposalAnswer, ProposalAsk, UndoTarget } from '../assistant.js';
import type { Asks } from './asks.js';
import type { Wire } from './messages.js';

// What the renderer takes from here (types only).
export type { BuiltContext, ChatPanelSettings, ChatSummary, ContextOptions, DiffLine, KeySource, SavedChat, ToolStep, TraceEvent, TraceUpdate, TurnOutcome, UndoTarget, WorkState };

// How one change of a proposal looks: the words, the size, and the diff lines to draw. Not the file contents.
export interface ProposalChange {
    kind: Change['kind'];
    file: string;
    to: string | null;
    reason: string;
    description: string;
    added: number;
    removed: number;
    diff: DiffLine[];
}

// The ask `ask.proposal`: `ask` is the number the panel names the proposal by when it asks the core to apply it.
export interface ProposalPayload {
    ask: number;
    batch: boolean;
    changes: ProposalChange[];
}

// The lines of one change; delete and move get a caption because the contents alone do not explain them.
function changeLines(c: Change, inBatch: boolean): DiffLine[] {
    const head: DiffLine[] = inBatch ? [{ kind: 'hunk', text: fmt(_('File: {file}'), { file: c.file }) }] : [];
    if (c.kind === 'move') return [...head, { kind: 'hunk', text: fmt(_('Move: {file} → {to} (contents unchanged)'), { file: c.file, to: c.to ?? '' }) }];
    if (c.kind === 'delete') head.push({ kind: 'hunk', text: fmt(_('Moved to the Trash: {file}'), { file: c.file }) });
    return [...head, ...parseDiff(unifiedDiff(c.before, c.after))];
}

export function proposalChange(c: Change, inBatch: boolean): ProposalChange {
    const { added, removed } = diffPreview(c.before, c.after);
    return {
        kind: c.kind, file: c.file, to: c.to ?? null, reason: c.reason, description: describeChange(c),
        added: c.kind === 'move' ? 0 : added, removed: c.kind === 'move' ? 0 : removed, diff: changeLines(c, inBatch),
    };
}

// A conversation read from disk, as the panel is told of it: the turns and the plan as they were, and the actions of the
// agent as they look (an action of the file has its changes as diff lines; the contents stay with the core). `actions` is
// the summary the panel shows over them.
export interface SavedChatView {
    title: string;
    turns: SavedChat['turns'];
    work: WorkState | null;
    actions: string;
    events: { id: string; status: ActionEvent['status']; tool: string; summary: string; time: string; changes: ProposalChange[] }[];
}

export function savedChatView(chat: SavedChat): SavedChatView {
    const events = chat.events ?? [];
    return {
        title: chat.title, turns: chat.turns, work: chat.work ?? null, actions: events.length ? journalText(events) : '',
        events: events.map(e => ({ id: e.id, status: e.status, tool: e.tool, summary: e.summary, time: e.time, changes: e.changes.map(c => proposalChange(c, e.changes.length > 1)) })),
    };
}

export class ProtocolChatPanel implements ChatPanelView {
    onSend: ChatPanelView['onSend'] = () => Promise.resolve();
    onStop: ChatPanelView['onStop'] = () => {};
    onReset: ChatPanelView['onReset'] = () => {};
    onPreview: ChatPanelView['onPreview'] = async () => ({ system: '', note: '', items: [], tokens: 0, unknownMentions: [] });
    onOptions: ChatPanelView['onOptions'] = () => {};
    onChats: ChatPanelView['onChats'] = async () => null;
    onOpenChat: ChatPanelView['onOpenChat'] = async () => null;
    onDeleteChat: ChatPanelView['onDeleteChat'] = async () => null;
    onApply: ChatPanelView['onApply'] = async () => 'applying is not available';
    onUndo: ChatPanelView['onUndo'] = async () => 'applying is not available';
    onClearLog: ChatPanelView['onClearLog'] = () => {};
    onInsert: ChatPanelView['onInsert'] = async () => false;
    onModel: ChatPanelView['onModel'] = () => {};
    onThinking: ChatPanelView['onThinking'] = () => {};
    onSaveChats: ChatPanelView['onSaveChats'] = () => {};
    onKeyStatus: ChatPanelView['onKeyStatus'] = () => Promise.resolve(null);
    onSaveKey: ChatPanelView['onSaveKey'] = () => Promise.reject(new Error('no key store'));
    onForgetKey: ChatPanelView['onForgetKey'] = () => Promise.resolve();

    // The settings as the controller last showed them, for a frontend that connects after they were first sent.
    shown: ChatPanelSettings | null = null;
    // The proposals waiting for the user, by number: a stopped turn withdraws its ask.
    private readonly open = new Map<number, Cancellable>();

    constructor(private readonly wire: Wire, private readonly asks: Asks) {}

    // The models the setting can take go with the settings: the panel's choice is among them.
    readonly models: readonly string[] = DEEPSEEK_MODELS;
    setSettings(settings: ChatPanelSettings): void { this.shown = settings; this.wire.notify('chat.settings', { settings, models: this.models }); }
    noKey(): void { this.wire.notify('chat.noKey'); }
    saveFailed(error: string): void { this.wire.notify('chat.saveFailed', { error }); }
    busyChanged(busy: boolean): void { this.wire.notify('chat.busy', { busy }); }
    startTurn(turn: number, question: string): void { this.wire.notify('chat.turn', { turn, question }); }
    turnContext(turn: number, built: BuiltContext): void { this.wire.notify('chat.context', { turn, built }); }
    turnText(turn: number, delta: string): void { this.wire.notify('chat.text', { turn, delta }); }
    turnReasoning(turn: number, delta: string): void { this.wire.notify('chat.reasoning', { turn, delta }); }
    turnStep(turn: number, step: ToolStep): void { this.wire.notify('chat.tool', { turn, step }); }
    turnWork(turn: number, work: WorkState, running: boolean, elapsedSeconds: number): void { this.wire.notify('chat.work', { turn, work, running, elapsed: elapsedSeconds }); }
    turnEnd(turn: number, outcome: TurnOutcome): void { this.wire.notify('chat.end', { turn, outcome }); }
    logUpdate(update: TraceUpdate): void { this.wire.notify('chat.log', { update }); }

    // The proposal is an ask. The answer is the user's note; whether anything was written is the core's own record.
    review(ask: ProposalAsk): Promise<ProposalAnswer> {
        const cancel = new Cancellable();
        this.open.set(ask.id, cancel);
        const payload: ProposalPayload = { ask: ask.id, batch: ask.batch, changes: ask.changes.map(c => proposalChange(c, ask.batch)) };
        return this.asks.ask<ProposalAnswer>('ask.proposal', { ...payload }, r => ({ note: typeof r.note === 'string' ? r.note : '' }), { note: '' }, cancel)
            .finally(() => { this.open.delete(ask.id); });
    }

    // The turn was stopped: the ask is withdrawn (`ask.cancel`), and the frontend closes the review without an answer.
    cancelReview(ask: number): void { this.open.get(ask)?.cancel(); }
}
