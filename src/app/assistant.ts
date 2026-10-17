// The Assistant in the application layer: owns the conversation (agent/chatcontroller.ts), gives it the manuscript from
// the session's documents and workspace, and writes approved changes through app/agentwrites.ts. The panel of a
// frontend only draws: it implements ChatPanelView, whose members are plain data, and reports what the user did through
// its on* actions (docs/design/protocol.md 6.5). A change proposal is an ask (7): the panel gets the changes, may ask the
// core to apply some of them while the ask is open, and answers with its note; the result the agent sees is what the
// core wrote, never what the panel claims.

import type { Awaitable } from '../awaitable.js';
import { agentGit } from '../git.js';
import { ChatController, type ChatView, type TurnOutcome, type TurnView } from '../agent/chatcontroller.js';
import type { KeySource } from '../agent/apikey.js';
import type { BuiltContext, ContextOptions } from '../agent/context.js';
import type { ChatSummary } from '../agent/chatstore.js';
import type { ProposalResult, ToolStep } from '../agent/session.js';
import type { Change } from '../agent/changes.js';
import { TraceFeed, type TraceUpdate } from '../agent/tracefeed.js';
import type { SavedChat } from '../agent/transcript.js';
import type { WorkState } from '../agent/work.js';
import type { Cancellable } from '../cancel.js';
import type { AppSettings } from '../settings.js';
import type { WorkspaceRepository } from '../workspace.js';
import { applyChange, applyChangeBatch, type AgentWriteHost } from './agentwrites.js';
import { errorMessage, type Doc, type TextEditor } from './document.js';

// One proposal waiting for the user: the changes as the agent made them, and whether it is a batch (a checkbox per file).
export interface ProposalAsk {
    id: number;
    changes: Change[];
    batch: boolean;
}

// The user's answer when the review closes. What was applied is known to the core from onApply, so it is not part of it.
export interface ProposalAnswer {
    note: string;
}

// What the panel shows of the settings that live in the core.
export interface ChatPanelSettings {
    model: string;
    thinking: boolean;
    saveChats: boolean;
    options: ContextOptions;
    budget: number;
}

// What Undo names: a proposal of this conversation that was applied (by its ask), or an action of a conversation that was
// opened again (by its event id). The core undoes the changes it wrote, not changes the panel sends.
export type UndoTarget = { ask: number } | { event: string };

export interface ChatPanelView {
    // What the user did; the controller sets these. An answer may come later (Awaitable): over the app protocol each is a
    // request whose reply arrives a turn or more after it was sent, so the panel goes on only once it has it.
    onSend: (text: string) => Promise<void>;
    onStop: () => void;
    onReset: () => void;
    onPreview: (draft: string) => Awaitable<BuiltContext>;                       // the context a draft would send, nothing sent
    onOptions: (options: ContextOptions) => void;                     // which parts of the context are sent
    onChats: () => Awaitable<ChatSummary[] | null>;                        // saved conversations; null = no work folder
    onOpenChat: (path: string) => Awaitable<SavedChat | null>;                // null = the file could not be read
    onDeleteChat: (path: string) => Awaitable<string | null>;                // an error message, or null
    // Apply part of an open proposal (chosen = indices of a batch, null = all): an error message, or null once written.
    onApply: (ask: number, chosen: number[] | null) => Awaitable<string | null>;
    onUndo: (target: UndoTarget) => Awaitable<string | null>;                // undo applied changes: an error message, or null
    onClearLog: () => void;                                           // empty the agent log
    onInsert: (text: string) => Awaitable<boolean>;                        // put an answer into the open note
    onModel: (model: string) => void;
    onThinking: (thinking: boolean) => void;
    onSaveChats: (save: boolean) => void;
    onKeyStatus: () => Promise<KeySource | null>;
    onSaveKey: (key: string) => Promise<KeySource>;
    onForgetKey: () => Promise<void>;

    // What the controller shows.
    setSettings(settings: ChatPanelSettings): void;
    noKey(): void;                                                    // sending needs an API key first
    saveFailed(error: string): void;                                  // the conversation could not be written to disk
    busyChanged(busy: boolean): void;
    startTurn(turn: number, question: string): void;                  // the question was accepted: show it with an empty answer
    turnContext(turn: number, built: BuiltContext): void;
    turnText(turn: number, delta: string): void;
    turnReasoning(turn: number, delta: string): void;
    turnStep(turn: number, step: ToolStep): void;
    // The turn's work plan; running = the turn is still going (false once, at the end, if a plan was shown).
    turnWork(turn: number, work: WorkState, running: boolean, elapsedSeconds: number): void;
    turnEnd(turn: number, outcome: TurnOutcome): void;
    // Show a proposal and wait for the user to close it. Closing without an apply that succeeded is rejecting.
    review(ask: ProposalAsk): Promise<ProposalAnswer>;
    cancelReview(ask: number): void;                                  // the turn was stopped: close the review, do not answer
    logUpdate(update: TraceUpdate): void;                             // the agent log: the whole log, or the events that changed
}

export interface AssistantHost<E extends TextEditor = TextEditor> extends AgentWriteHost<E> {
    readonly settings: AppSettings;
    readonly workspace: WorkspaceRepository;
    readonly chatPanel: ChatPanelView;
    projectName(path: string | null): string | null;
}

// What the session answers from its other controllers.
export interface AssistantSession<E extends TextEditor = TextEditor> {
    nameOf(doc: Doc<E>): string;          // the tab's name, for a document without a file
    canInsert(): boolean;                 // the open document shows its text (not Home, not a board)
}

interface OpenAsk {
    changes: Change | Change[];
    apply: (change: Change | Change[]) => string | null;
    result: ProposalResult | null;        // set once an apply request has been answered
    resolve: (result: ProposalResult) => void;
}

export class AssistantController<E extends TextEditor = TextEditor> {
    readonly chat: ChatController;
    private turns = 0;
    private asks = 0;
    private readonly open = new Map<number, OpenAsk>();
    private readonly applied = new Map<number, Change[]>();   // the changes written for an ask, for Undo
    private feed: TraceFeed | null = null;
    private readonly unlisten: () => void;

    constructor(private readonly host: AssistantHost<E>, private readonly session: AssistantSession<E>) {
        this.chat = new ChatController(this.conversationView());
        this.chat.host = {
            active: () => {
                const doc = host.active();
                return { name: host.projectName(doc.file) ?? session.nameOf(doc), text: doc.editor.getText(), cursorLine: doc.editor.cursorLine };
            },
            selection: () => host.active().editor.selection,
            root: () => host.root(),
            applyChange: change => applyChange(host, change),
            applyBatch: changes => applyChangeBatch(host, changes),
            git: request => {
                const root = host.root();
                return root ? agentGit(root, request) : Promise.resolve({ ok: false, message: 'no work folder' });
            },
            // Other unsaved tabs are read from their editor, not the version on disk (see workspace).
            files: freshness => {
                const root = host.root();
                return root ? host.workspace.files(root, { except: host.active().file, freshness }) : [];
            },
        };
        const { settings } = host;
        this.chat.setModel(settings.chatModel);
        this.chat.session.thinking = settings.chatThinking;
        this.chat.saveChats = settings.chatSave;
        this.unlisten = settings.onChanged(['chat-model', 'chat-thinking', 'chat-save'], () => {
            this.chat.setModel(settings.chatModel);
            this.chat.session.thinking = settings.chatThinking;
            this.chat.saveChats = settings.chatSave;
            this.showSettings();
        });
        this.connect(host.chatPanel);
        this.showSettings();
    }

    get busy(): boolean {
        return this.chat.busy;
    }

    // A question from elsewhere in the application (closing the day in the journal); shown in the panel like a typed one.
    ask(question: string): Promise<void> {
        return this.chat.send(question);
    }

    stop(): void {
        this.chat.stop();
    }

    // act.undo: the changes are the ones the core wrote for that ask, or the applied action of that event.
    private undo(target: UndoTarget): string | null {
        const changes = 'ask' in target
            ? this.applied.get(target.ask)
            : this.chat.session.events.find(e => e.id === target.event && e.status === 'applied')?.changes;
        if (!changes) return 'there is nothing to undo';
        const error = this.chat.undo(changes);
        if (!error && 'ask' in target) this.applied.delete(target.ask);
        return error;
    }

    dispose(): void {
        this.feed?.stop();
        this.chat.stop();
        this.unlisten();
    }

    private showSettings(): void {
        const { chat } = this;
        this.host.chatPanel.setSettings({ model: chat.model, thinking: chat.session.thinking, saveChats: chat.saveChats, options: { ...chat.options }, budget: chat.budget });
    }

    private connect(panel: ChatPanelView): void {
        const { chat, host } = this;
        const { settings } = host;
        panel.onSend = text => chat.send(text);
        panel.onStop = () => chat.stop();
        panel.onReset = () => chat.reset();
        panel.onPreview = draft => chat.preview(draft);
        panel.onOptions = options => { chat.options = { ...options }; };
        panel.onChats = () => chat.chats();
        panel.onOpenChat = path => chat.open(path);
        panel.onDeleteChat = path => {
            try { chat.deleteChat(path); return null; } catch (e) { return errorMessage(e); }
        };
        panel.onApply = (ask, chosen) => this.apply(ask, chosen);
        panel.onUndo = target => this.undo(target);
        panel.onClearLog = () => chat.session.trace.clear();
        panel.onInsert = text => {
            if (!this.session.canInsert()) return false;
            host.active().editor.insertAtCursor(`${text.trim()}\n`);
            return true;
        };
        // Settings are written to the store; its listener (above) applies them, so another window or the preferences agree.
        panel.onModel = model => { settings.chatModel = model; };
        panel.onThinking = thinking => { settings.chatThinking = thinking; };
        panel.onSaveChats = save => { settings.chatSave = save; };
        panel.onKeyStatus = async () => (await chat.keyStore.get())?.source ?? null;
        panel.onSaveKey = key => chat.keyStore.set(key);
        panel.onForgetKey = () => chat.keyStore.clear();
        // The agent log follows the conversation's trace.
        this.feed = new TraceFeed(chat.session.trace, update => panel.logUpdate(update));
        this.feed.start();
    }

    // The conversation draws through the panel: each turn gets a number, so a late notice of an older turn names it.
    private conversationView(): ChatView {
        const panel = () => this.host.chatPanel;
        return {
            noKey: () => panel().noKey(),
            saveFailed: error => panel().saveFailed(error),
            busyChanged: busy => panel().busyChanged(busy),
            startTurn: (question): TurnView => {
                const turn = ++this.turns;
                panel().startTurn(turn, question);
                return {
                    context: built => panel().turnContext(turn, built),
                    text: delta => panel().turnText(turn, delta),
                    reasoning: delta => panel().turnReasoning(turn, delta),
                    step: step => panel().turnStep(turn, step),
                    work: (work, running, elapsed) => panel().turnWork(turn, work, running, elapsed),
                    end: outcome => panel().turnEnd(turn, outcome),
                };
            },
            review: (change, apply, cancelled) => this.review(change, apply, cancelled),
        };
    }

    // The ask of one proposal. `apply` is the conversation's: it checks that the work folder is still the one the proposal
    // was made in, and applyChange() checks again that every file still has the contents the agent saw.
    private review(change: Change | Change[], apply: (change: Change | Change[]) => string | null, cancelled: Cancellable): Promise<ProposalResult> {
        const id = ++this.asks;
        return new Promise<ProposalResult>(resolve => {
            this.open.set(id, { changes: change, apply, result: null, resolve });
            const changes = Array.isArray(change) ? change : [change];
            this.host.chatPanel.review({ id, changes, batch: Array.isArray(change) }).then(answer => {
                const ask = this.open.get(id);
                if (!ask) return;   // cancelled meanwhile: the answer is dropped
                this.open.delete(id);
                const note = answer.note.trim() ? { note: answer.note.trim() } : {};
                resolve({ ...ask.result ?? { applied: false }, ...note });
            }, () => this.finish(id, { applied: false }));
            // A stopped turn ends the ask as rejected; an apply request that arrives after it is refused.
            cancelled.onCancel(() => {
                if (!this.open.has(id)) return;
                this.finish(id, { applied: false });
                this.host.chatPanel.cancelReview(id);
            });
        });
    }

    private finish(id: number, result: ProposalResult): void {
        const ask = this.open.get(id);
        if (!ask) return;
        this.open.delete(id);
        ask.resolve(result);
    }

    // act.proposal.apply: the core writes, once per ask; a partial batch keeps the order of the proposal.
    private apply(id: number, chosen: number[] | null): string | null {
        const ask = this.open.get(id);
        if (!ask) return 'the proposal is no longer open';
        if (ask.result) return 'the proposal was already answered';
        const all = Array.isArray(ask.changes) ? ask.changes : [ask.changes];
        const picked = chosen ? [...new Set(chosen)].filter(i => Number.isInteger(i) && i >= 0 && i < all.length).sort((a, b) => a - b) : null;
        if (picked && !picked.length) return 'no file was chosen';
        const partial = picked && picked.length < all.length ? picked : null;
        const written = partial ? partial.map(i => all[i]) : all;
        const error = ask.apply(Array.isArray(ask.changes) ? written : ask.changes);
        ask.result = error ? { applied: false, error } : { applied: true, ...partial ? { accepted: partial } : {} };
        if (!error) this.applied.set(id, written);
        return error;
    }
}
