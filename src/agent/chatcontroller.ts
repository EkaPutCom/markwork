// The life cycle of an assistant conversation, without widgets: sending a turn and stopping it, guarding against
// a work folder that changes during a request, saving the conversation after every turn, reopening and deleting
// saved conversations, undoing applied changes, and composing the context. The panel (electron/renderer/Chat.tsx) draws what it
// is told through ChatView and passes user actions in; tests drive this class with a fake view and provider.

import { Cancellable } from '../cancel.js';
import { platform } from '../platform/index.js';
import { systemKeyStore, type KeyStore } from './apikey.js';
import { buildContext, DEFAULT_BUDGET, findMentions, type BuiltContext, type ContextOptions, type SourceFile } from './context.js';
import { deleteChat, listChats, loadChat, loadChatLog, nowStamp, saveChat, saveChatLog, titleFrom, type ChatSummary } from './chatstore.js';
import { AgentTrace } from './trace.js';
import { DEEPSEEK_MODELS, DeepSeek } from './deepseek.js';
import type { Provider, Usage } from './provider.js';
import { ChatSession, type ProposalResult, type ToolStep, type TurnInput } from './session.js';
import { invertChange, type Change } from './changes.js';
import type { GitAnswer, GitRequest } from './gittools.js';
import type { SavedChat } from './transcript.js';
import type { WorkState } from './work.js';
import type { Freshness } from '../workspace.js';

export const FOLDER_CHANGED = 'The work folder changed during the request';

// What the conversation needs from the window: the manuscript and a way to apply approved changes.
export interface ChatControllerHost {
    active(): { name: string; text: string; cursorLine: number } | null;   // the open document (buffer contents, not disk)
    selection(): string;
    files(freshness?: Freshness): SourceFile[];                            // other files in the project folder (default cached)
    // Apply a change the user has approved. Returns an error message, or null on success.
    applyChange?(change: Change): string | null;
    applyBatch?(changes: Change[]): string | null;
    git?(request: GitRequest): Promise<GitAnswer>;                         // read-only Git history tools in the work folder
    root(): string | null;                                                 // the manuscript folder; where conversation history is saved
}

// How a turn ended, for its footer.
export type TurnOutcome =
    | { cancelled: boolean; usage: Usage | null; toolCalls: number; applied: number; text: string }
    | { error: string };

// The parts of one answer as it streams in.
export interface TurnView {
    context(built: BuiltContext): void;
    text(delta: string): void;
    reasoning(delta: string): void;
    step(step: ToolStep): void;
    // The turn's work plan; running = the turn is still going (false once, at the end, if a plan was shown).
    work(work: WorkState, running: boolean, elapsedSeconds: number): void;
    end(outcome: TurnOutcome): void;
}

export interface ChatView {
    noKey(): void;                                  // sending needs an API key first
    saveFailed(error: string): void;                // the conversation could not be written to disk
    busyChanged(busy: boolean): void;
    startTurn(question: string): TurnView;          // the question was accepted: show it with an empty answer
    // Show a change proposal and wait for the user's decision. apply writes an approved change (an error message or
    // null); cancelled fires when the turn is stopped, which must end the review as rejected.
    review(change: Change | Change[], apply: (change: Change | Change[]) => string | null, cancelled: Cancellable): Promise<ProposalResult>;
}

export class ChatController {
    readonly session = new ChatSession();
    host: ChatControllerHost = { active: () => null, selection: () => '', files: () => [], root: () => null };
    // Replaced in tests with a fake provider and key store.
    makeProvider: (key: string) => Provider = key => new DeepSeek(key);
    keyStore: KeyStore = systemKeyStore;
    model = DEEPSEEK_MODELS[0];
    saveChats = true;   // save every turn to <folder>/.markwork/chats
    options: ContextOptions = { activeDocument: true, selection: true, project: true };
    budget = DEFAULT_BUDGET;

    private generation = 0;              // bumped by reset(): late results of an older conversation are dropped
    private cancellable: Cancellable | null = null;
    // The conversation currently shown on disk: its file (null = not written yet), the folder it came from, and its title.
    private chatPath: string | null = null;
    private chatRoot: string | null = null;
    private chatTitle = '';
    private chatCreated = '';

    constructor(private readonly view: ChatView) {}

    get busy(): boolean {
        return this.cancellable !== null;
    }

    // An old or unknown model name (e.g. from a settings version) is replaced with the default model.
    setModel(model: string): void {
        this.model = DEEPSEEK_MODELS.includes(model) ? model : DEEPSEEK_MODELS[0];
    }

    // Start a new conversation; a running turn is stopped and its late results are dropped.
    reset(): void {
        this.generation++;
        this.stop();
        this.session.clear();
        this.chatPath = null;
    }

    stop(): void {
        this.cancellable?.cancel();
    }

    async send(rawQuestion: string): Promise<void> {
        const question = rawQuestion.trim();
        if (!question || this.busy) return;
        const generation = this.generation;
        const found = await this.keyStore.get();
        if (generation !== this.generation || this.busy) return;
        if (!found) { this.view.noKey(); return; }

        const turn = this.view.startTurn(question);
        const cancellable = this.cancellable = new Cancellable();
        this.view.busyChanged(true);
        // Everything that touches files is refused once the folder changes; the answer itself may still finish.
        const requestRoot = this.host.root();
        const sameRoot = () => requestRoot === this.host.root();
        const started = platform().monotonicMs();
        const elapsed = () => (platform().monotonicMs() - started) / 1000;
        let planShown = false;
        const showWork = (running: boolean) => {
            if (!this.session.work || !running && !planShown) return;
            planShown = true;
            turn.work(this.session.work, running, elapsed());
        };
        try {
            const result = await this.session.ask(this.turnInput(question, 'current'), this.makeProvider(found.key), this.model, {
                onContext: built => turn.context(built),
                onText: delta => turn.text(delta),
                onReasoning: delta => turn.reasoning(delta),
                currentFiles: () => {
                    if (!sameRoot()) throw Error(FOLDER_CHANGED);
                    const active = this.options.activeDocument ? this.host.active() : null;
                    return [...this.host.files('fresh').filter(f => f.name !== active?.name), ...(active ? [{ name: active.name, text: active.text }] : [])];
                },
                onState: () => {
                    if (generation !== this.generation) return;
                    this.persist();
                    showWork(true);
                },
                // A valid plan is already shown as a checklist; its step row does not need repeating.
                onTool: step => { if (!(step.label === 'Work plan' && this.session.work && step.summary !== 'invalid plan')) turn.step(step); },
                onBatchProposal: this.host.applyBatch ? changes => sameRoot() ? this.propose(changes, cancellable) : Promise.resolve({ applied: false, error: FOLDER_CHANGED }) : undefined,
                onProposal: change => sameRoot() ? this.propose(change, cancellable) : Promise.resolve({ applied: false, error: FOLDER_CHANGED }),
                git: this.host.git ? request => sameRoot() ? this.host.git!(request) : Promise.resolve({ ok: false, message: FOLDER_CHANGED }) : undefined,
            }, cancellable);
            if (generation !== this.generation) return;
            showWork(false);
            turn.end(result);
            this.persist();
        } catch (e) {
            if (generation !== this.generation) return;
            if (this.session.work) this.session.work.status = 'failed';
            this.persist();
            showWork(false);
            turn.end({ error: e instanceof Error ? e.message : String(e) });
        } finally {
            if (this.cancellable === cancellable) this.cancellable = null;
            this.view.busyChanged(this.busy);
        }
    }

    // A proposal is applied only while the work folder is still the one it was made in.
    private propose(change: Change | Change[], cancellable: Cancellable): Promise<ProposalResult> {
        const proposalRoot = this.host.root();
        return this.view.review(change, c => {
            if (proposalRoot !== this.host.root()) return 'The work folder changed since the proposal was made';
            if (Array.isArray(c)) return this.host.applyBatch ? this.host.applyBatch(c) : 'applying batches is not available';
            return this.host.applyChange ? this.host.applyChange(c) : 'applying is not available';
        }, cancellable);
    }

    // Undo agent changes that were already applied: the inverse goes through the same preflight, so it fails (without
    // overwriting anything) if a file has been edited again since. The journal records it so the agent knows that
    // change no longer applies. Returns an error message, or null when undone.
    undo(changes: Change[]): string | null {
        if (this.busy) return 'wait for the agent to finish';
        const root = this.host.root();
        const error = this.host.applyBatch ? this.host.applyBatch([...changes].reverse().map(invertChange)) : 'applying is not available';
        if (error) return error;
        for (const event of this.session.events) {
            if (event.status !== 'applied' || !event.changes.some(c => changes.includes(c))) continue;
            event.status = 'reverted';
            event.summary = 'Undone by the user from the panel; the files are back to their previous contents.';
        }
        const work = this.session.work;
        if (work) { delete work.verification; if (work.status === 'complete') work.status = 'paused'; }
        if (root === this.host.root()) this.persist();
        return null;
    }

    get canUndo(): boolean {
        return !!this.host.applyBatch;
    }

    // ---------- History on disk ----------

    // Write the conversation to <folder>/.markwork/chats after every turn. Without a folder, or when turned off, nothing is written.
    private persist(): void {
        const root = this.host.root();
        const history = this.session.history;
        if (!this.saveChats || !root || !history.length && !this.session.work && !this.session.events.length) return;
        if (root !== this.chatRoot) {
            // Switching folders in the middle of a conversation: the continuation is written as a new file in the new folder.
            this.chatRoot = root;
            this.chatPath = null;
        }
        if (!this.chatPath) {
            this.chatCreated = nowStamp();
            this.chatTitle = titleFrom(history.find(t => t.role === 'user')?.content ?? this.session.work?.goal ?? this.session.events[0]?.question ?? '');
        }
        try {
            this.chatPath = saveChat(root, { title: this.chatTitle, model: this.model, created: this.chatCreated, turns: [...history], work: this.session.work, events: this.session.events }, this.chatPath);
            saveChatLog(this.chatPath, this.session.trace.jsonl());
        } catch (e) {
            this.view.saveFailed(e instanceof Error ? e.message : String(e));
        }
    }

    // Continue a saved conversation: the next turns are appended to the same file. null = the file could not be read
    // (the current conversation is kept).
    open(path: string): SavedChat | null {
        const chat = loadChat(path);
        if (!chat) return null;
        this.reset();
        this.session.restore(chat.turns);
        this.session.work = chat.work ?? null;
        this.session.events.push(...chat.events ?? []);
        this.session.trace.restore(AgentTrace.parse(loadChatLog(path)));
        this.chatPath = path;
        this.chatRoot = this.host.root();
        this.chatTitle = chat.title;
        this.chatCreated = chat.created;
        return chat;
    }

    // Saved conversations of the work folder, newest first; null = no work folder.
    chats(): ChatSummary[] | null {
        const root = this.host.root();
        return root ? listChats(root) : null;
    }

    // Move a saved conversation to the Trash. Throws on failure. Deleting the one shown starts a new file on the next turn.
    deleteChat(path: string): void {
        deleteChat(path);
        if (path === this.chatPath) this.chatPath = null;
    }

    // ---------- Context ----------

    // A turn walks the folder again so it sees outside changes at once; the preview while typing uses the snapshot.
    private turnInput(question: string, freshness: Freshness): TurnInput {
        return {
            question,
            active: this.host.active(),
            selection: this.host.selection(),
            files: this.host.files(freshness),
            mentions: findMentions(question),
            options: { ...this.options },
            budget: this.budget,
        };
    }

    // The context that would be sent for `draft`, without sending anything.
    preview(draft: string): BuiltContext {
        return buildContext({ ...this.turnInput(draft, 'cached'), recent: this.session.questions });
    }
}
