// Session-scoped chat notices. The view is data; the Assistant controller still owns every approval decision.
import type { ChatPanelSettings, ChatPanelView, ProposalAnswer, ProposalAsk } from './assistant';
import type { BuiltContext } from '../agent/context';
import type { TurnOutcome } from '../agent/chatcontroller';
import type { ToolStep } from '../agent/session';
import type { WorkState } from '../agent/work';
import { TraceReplica } from '../agent/tracefeed';
import type { TraceUpdate } from '../agent/tracefeed';
import type { SavedChat } from '../agent/transcript';
import { DEEPSEEK_MODELS } from '../agent/models';

export interface FolderChatPayload {
    settings?: ChatPanelSettings;
    models?: readonly string[];
    busy?: boolean;
    error?: string;
    turn?: number;
    question?: string;
    built?: BuiltContext;
    delta?: string;
    step?: ToolStep;
    work?: WorkState;
    running?: boolean;
    elapsed?: number;
    outcome?: TurnOutcome;
    update?: TraceUpdate;
}
export interface FolderChatEvent { ev: string; payload: FolderChatPayload }
export interface FolderSessionSummary { id: string; title: string; root: string; busy: boolean; waiting: boolean; queued: boolean }
export interface FolderAgentState {
    root: string | null;
    name: string;
    error: string;
    sessions: FolderSessionSummary[];
    runtime: 'local' | 'checking' | 'background' | 'reconnecting';
    runtimeDetail: string;
}
export interface FolderAgentView {
    show(state: FolderAgentState): void;
    event(id: string, event: FolderChatEvent): void;
    review(id: string, ask: ProposalAsk): Promise<ProposalAnswer>;
    cancelReview(id: string, ask: number): void;
    history?(id: string, chat: SavedChat): void;
}

export class FolderPanel implements ChatPanelView {
    onSend!: ChatPanelView['onSend'];
    onStop!: ChatPanelView['onStop'];
    onReset!: ChatPanelView['onReset'];
    onPreview!: ChatPanelView['onPreview'];
    onOptions!: ChatPanelView['onOptions'];
    onChats!: ChatPanelView['onChats'];
    onOpenChat!: ChatPanelView['onOpenChat'];
    onDeleteChat!: ChatPanelView['onDeleteChat'];
    onApply!: ChatPanelView['onApply'];
    onUndo!: ChatPanelView['onUndo'];
    onClearLog!: ChatPanelView['onClearLog'];
    onInsert!: ChatPanelView['onInsert'];
    onModel!: ChatPanelView['onModel'];
    onThinking!: ChatPanelView['onThinking'];
    onSaveChats!: ChatPanelView['onSaveChats'];
    onKeyStatus!: ChatPanelView['onKeyStatus'];
    onSaveKey!: ChatPanelView['onSaveKey'];
    onForgetKey!: ChatPanelView['onForgetKey'];
    shown: ChatPanelSettings | null = null;
    readonly models = DEEPSEEK_MODELS;
    readonly events: FolderChatEvent[] = [];
    readonly trace = new TraceReplica();
    base: SavedChat | null = null;
    snapshot: () => SavedChat = () => ({ title: '', model: '', created: '', turns: [] });
    busy = false;
    queued = false;
    waiting = false;

    constructor(readonly id: string, private readonly view: FolderAgentView, private readonly changed: () => void) {}

    private emit(ev: string, payload: FolderChatPayload = {}): void {
        const event = { ev, payload };
        if (this.busy && ev !== 'chat.log') this.events.push(event);
        this.view.event(this.id, event);
    }
    setWaiting(waiting: boolean): void { this.waiting = waiting; this.changed(); }
    receive(ev: string, payload: FolderChatPayload): void {
        if (ev === 'chat.log' && payload.update) this.trace.apply(payload.update);
        if (ev === 'chat.turn') { this.events.length = 0; this.busy = true; }
        if (ev === 'chat.busy') { this.busyChanged(payload.busy === true); return; }
        this.emit(ev, payload);
    }
    setSettings(settings: ChatPanelSettings): void { this.shown = settings; this.emit('chat.settings', { settings, models: this.models }); }
    noKey(): void { this.emit('chat.noKey'); }
    saveFailed(error: string): void { this.emit('chat.saveFailed', { error }); }
    busyChanged(busy: boolean): void { this.busy = busy; this.emit('chat.busy', { busy }); if (!busy) this.events.length = 0; this.changed(); }
    startTurn(turn: number, question: string): void {
        this.base = this.snapshot();
        this.events.length = 0;
        this.busy = true;
        this.emit('chat.turn', { turn, question });
    }
    turnContext(turn: number, built: BuiltContext): void { this.emit('chat.context', { turn, built }); }
    turnText(turn: number, delta: string): void { this.emit('chat.text', { turn, delta }); }
    turnReasoning(turn: number, delta: string): void { this.emit('chat.reasoning', { turn, delta }); }
    turnStep(turn: number, step: ToolStep): void { this.emit('chat.tool', { turn, step }); }
    turnWork(turn: number, work: WorkState, running: boolean, elapsed: number): void { this.emit('chat.work', { turn, work, running, elapsed }); }
    turnEnd(turn: number, outcome: TurnOutcome): void { this.emit('chat.end', { turn, outcome }); }
    logUpdate(update: TraceUpdate): void { this.emit('chat.log', { update }); }
    async review(ask: ProposalAsk): Promise<ProposalAnswer> {
        this.waiting = true;
        this.changed();
        try { return await this.view.review(this.id, ask); }
        finally { this.waiting = false; this.changed(); }
    }
    cancelReview(ask: number): void { this.view.cancelReview(this.id, ask); }
}
