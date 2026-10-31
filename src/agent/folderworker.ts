// A headless conversation engine. It can read and propose while detached; it cannot apply a proposal itself.
import { TraceFeed } from './tracefeed';
import { ChatController, type ChatView, type TurnOutcome } from './chatcontroller';
import { loadAgentFolder, isAgentReserved } from './folder';
import { folderPath } from './path';
import { changeState, type Change } from './changes';
import { WorkspaceRepository } from '../base/workspace';
import type { SourceFile } from './context';
import { readTextFile, fileExists, writeTextFile } from '../base/files';
import type { ProposalResult } from './session';
import type { SavedChat } from './transcript';
import type { Provider } from './provider';

export type WorkerOutput = { event: string; data: Record<string, unknown> };
interface Pending { changes: Change[]; resolve: (result: ProposalResult) => void }

export class FolderWorker {
    readonly chat: ChatController;
    private readonly workspace = new WorkspaceRepository();
    private readonly pending = new Map<number, Pending>();
    private ask = Date.now() * 1000;
    private turn = 0;
    private sending = false;
    private feed: TraceFeed | null = null;
    private readonly buffers = new Map<string, string>();
    private readonly seen = new Set<string>();
    private readonly receiptPath: string;
    private readonly path: string;

    constructor(readonly root: string, session: string, private readonly emit: (event: WorkerOutput) => void, provider?: (key: string) => Provider) {
        this.path = folderPath(root, 'chats/' + session);
        this.receiptPath = folderPath(root, 'chats/' + session + '.worker.json');
        this.restoreReceipts();
        const view: ChatView = {
            noKey: () => this.event('chat.noKey'),
            saveFailed: error => this.event('chat.saveFailed', { error }),
            busyChanged: busy => this.event('chat.busy', { busy }),
            startTurn: question => {
                const turn = ++this.turn;
                this.emit({ event: 'snapshot', data: { chat: this.snapshot() } });
                this.event('chat.turn', { turn, question });
                return {
                    context: built => this.event('chat.context', { turn, built }),
                    text: delta => this.event('chat.text', { turn, delta }),
                    reasoning: delta => this.event('chat.reasoning', { turn, delta }),
                    step: step => this.event('chat.tool', { turn, step }),
                    work: (work, running, elapsed) => this.event('chat.work', { turn, work, running, elapsed }),
                    end: (outcome: TurnOutcome) => this.event('chat.end', { turn, outcome }),
                };
            },
            review: changes => new Promise(resolve => {
                const ask = ++this.ask;
                const list = Array.isArray(changes) ? changes : [changes];
                this.pending.set(ask, { changes: list, resolve });
                this.emit({ event: 'proposal', data: { ask, changes: list, batch: Array.isArray(changes) } });
            }),
        };
        this.chat = new ChatController(view);
        this.chat.storage = 'agent-folder';
        this.chat.options = { project: true, activeDocument: false, selection: false };
        if (provider) this.chat.makeProvider = provider;
        this.chat.host = {
            root: () => root, active: () => null, selection: () => '',
            files: freshness => {
                const definition = loadAgentFolder(root);
                return this.workspace.files(root, { freshness }).map(f => this.buffers.has(f.name) ? { ...f, text: this.buffers.get(f.name)! } : f).filter(f => !isAgentReserved(f.name) && (definition.kind !== 'agent' || f.name !== definition.config.instructions));
            },
            applyChange: () => 'Only the connected application may apply changes',
            applyBatch: () => 'Only the connected application may apply changes',
        };
        if (!this.chat.open(this.path)) throw Error('The agent conversation could not be loaded');
        this.emit({ event: 'hello', data: { version: 1, session: this.path } });
        this.feed = new TraceFeed(this.chat.session.trace, update => this.event('chat.log', { update }));
        this.feed.start();
    }

    private event(event: string, data: Record<string, unknown> = {}): void { this.emit({ event, data }); }
    snapshot(): SavedChat {
        const session = this.chat.session;
        return { layout: 'chat', title: '', model: this.chat.model, created: '', turns: [...session.history], events: [...session.events], work: session.work };
    }
    private restoreReceipts(): void {
        if (!fileExists(this.receiptPath)) return;
        const data: unknown = JSON.parse(readTextFile(this.receiptPath));
        if (!Array.isArray(data) || data.length > 10000 || data.some(id => typeof id !== 'string')) throw Error('Worker command receipts are invalid');
        for (const id of data) this.seen.add(id);
    }
    private accept(id: unknown): boolean {
        if (typeof id !== 'string' || !id || id.length > 160) throw Error('A worker command needs an id');
        if (this.seen.has(id)) return false;
        if (this.seen.size >= 10000) throw Error('This worker has reached its command limit');
        this.seen.add(id);
        writeTextFile(this.receiptPath, JSON.stringify([...this.seen]));
        return true;
    }

    async command(raw: string): Promise<void> {
        const input = JSON.parse(raw) as Record<string, unknown>;
        if (!this.accept(input.id)) return;
        if (input.op === 'stop') { this.stop(); return; }
        if (input.op === 'release_buffers') { this.buffers.clear(); return; }
        if (input.op === 'decision') { this.decide(input); return; }
        if (input.op !== 'send' || typeof input.text !== 'string' || input.text.length > 200000) throw Error('Invalid worker command');
        if (this.sending || this.chat.busy) throw Error('This worker is already working');
        const definition = loadAgentFolder(this.root);
        if (definition.kind !== 'agent') throw Error(definition.kind === 'invalid' ? definition.error : 'agent.json is missing');
        this.chat.roleInstructions = definition.instructions;
        if (typeof input.model === 'string') this.chat.setModel(input.model);
        this.chat.session.thinking = input.thinking === true;
        this.sending = true;
        try { await this.chat.send(input.text); } finally { this.sending = false; }
        this.emit({ event: 'done', data: { chat: this.snapshot() } });
    }

    private decide(input: Record<string, unknown>): void {
        const ask = Number(input.ask), pending = this.pending.get(ask);
        if (!pending) return;
        const result = input.result as ProposalResult;
        if (!result || typeof result.applied !== 'boolean') throw Error('Invalid proposal result');
        if (Array.isArray(input.buffers)) for (const file of input.buffers as SourceFile[]) {
            if (typeof file.name !== 'string' || typeof file.text !== 'string' || isAgentReserved(file.name)) throw Error('Invalid approved buffer snapshot');
            folderPath(this.root, file.name);
            this.buffers.set(file.name, file.text);
        }
        if (result.applied && !this.matchesDisk(pending.changes, result.accepted)) throw Error('The approved proposal does not match the current files');
        this.pending.delete(ask);
        this.emit({ event: 'decided', data: { ask } });
        pending.resolve(result);
    }
    private matchesDisk(changes: Change[], accepted?: number[]): boolean {
        const chosen = accepted ? changes.filter((_, i) => accepted.includes(i)) : changes;
        return chosen.length > 0 && chosen.every(change => changeState(change, name => {
            if (this.buffers.has(name)) return this.buffers.get(name)!;
            const path = folderPath(this.root, name);
            return fileExists(path) ? readTextFile(path) : null;
        }) === 'after');
    }
    stop(): void {
        for (const pending of this.pending.values()) pending.resolve({ applied: false, error: 'Stopped by the user' });
        this.pending.clear();
        this.chat.stop();
    }
    dispose(): void { this.feed?.flush(); this.feed?.stop(); this.stop(); this.workspace.close(); }
}
