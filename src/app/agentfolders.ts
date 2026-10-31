import { createAgentFolder } from './agentfoldercreate';
import type { FilesDialogs } from './files';
import { optionOf } from '../markdown/layout';
import { FolderTurnQueue } from '../agent/folderqueue';
import type { DaemonConnection } from '../agent/daemon/connection';
import { localSocketPath } from '../orchestrator/hub';
import { BackgroundConversation, backgroundAvailable, bounded } from './agentfolderruntime';
// Agent folders own conversations independently of the selected document/tab. Ordinary Assistant state stays separate.
import { AssistantController, type AssistantHost } from './assistant';
import { FolderPanel, type FolderAgentView, type FolderAgentState } from './folderpanel';
import { folderPath } from '../agent/path';
import { loadAgentFolder, isAgentReserved } from '../agent/folder';
import { listChats, loadChat, nowStamp, saveChat, ensureAgentChatStorage } from '../agent/chatstore';
import type { ChatController } from '../agent/chatcontroller';
import { parseChat, type SavedChat } from '../agent/transcript';
import { changeFiles } from '../agent/changes';
import { insideName } from '../base/files';
import { platform } from '../platform/index';
import type { TextEditor } from './document';

interface Conversation {
    id: string;
    root: string;
    title: string;
    assistant: AssistantController;
    panel: FolderPanel;
    background?: BackgroundConversation;
    sending?: boolean;
}
export interface AgentFolderTabs {
    open(root: string, id: string, title: string): void;
    rename(id: string, title: string): void;
}

export class AgentFoldersController<E extends TextEditor> {
    backgroundEnabled = true;
    private readonly queue = new FolderTurnQueue();
    private readonly known = new Map<string, { root: string; title: string }>();
    private readonly conversations = new Map<string, Conversation>();
    private root: string | null = null;
    private epoch = 0;
    private watched = '';
    private watchStop: (() => void) | null = null;
    private refreshStop: (() => void) | null = null;
    private name = '';
    private error = '';
    private workspace: string | null = null;
    private readonly runtimeDetails = new Map<string, string>();
    private readonly available = new Set<string>();
    private connectionStop: (() => void) | null = null;
    private readonly checking = new Map<string, Promise<boolean>>();

    constructor(private readonly host: AssistantHost<E>, private readonly view: FolderAgentView, private readonly tabs: AgentFolderTabs, private readonly source: ChatController, private readonly connection?: () => DaemonConnection) {}

    state(): FolderAgentState {
        return { root: this.root, name: this.name, error: this.error, runtime: this.checking.has(this.root ?? '') ? 'checking' : this.available.has(this.root ?? '') ? this.connection?.().state === 'ready' ? 'background' : 'reconnecting' : 'local', runtimeDetail: this.runtimeDetails.get(this.root ?? '') ?? 'Configure markworkd and its markwork-agent program for background work.', sessions: [...this.known].filter(([, c]) => c.root === this.root).map(([id, c]) => {
            const entry = this.conversations.get(id);
            return { id, root: c.root, title: entry?.title ?? c.title, busy: !!entry && (entry.assistant.busy || entry.panel.busy), waiting: entry?.panel.waiting ?? false, queued: entry?.panel.queued ?? false };
        }) };

    }
    private show(): void { this.view.show(this.state()); }

    folderChanged(root: string): boolean {
        if (root !== this.workspace) {
            this.dispose();
            this.workspace = root;
            this.root = null;
            this.name = '';
            this.error = '';
        }
        return this.activate(root);
    }

    activate(root: string, probe = true): boolean {
        const workspace = this.host.root();
        if (!workspace || root !== workspace && insideName(workspace, root) === null) return false;
        if (root !== workspace) { try { folderPath(workspace, insideName(workspace, root)!); } catch { return false; } }
        const definition = loadAgentFolder(root);
        if (definition.kind === 'ordinary') { if (this.root === root) this.error = 'agent.json is missing'; this.show(); return false; }
        this.root = root;
        this.watch(root);
        this.host.settings.chat = true;
        this.error = definition.kind === 'invalid' ? definition.error : '';
        this.name = definition.kind === 'agent' ? definition.config.name : platform().paths.basename(root);
        try {
            for (const chat of listChats(root, 'agent-folder')) if (!this.known.has(chat.path)) this.known.set(chat.path, { root, title: chat.title });
        } catch { /* An invalid storage path is already reported by the definition loader. */ }
        if (probe) void this.checkBackground(root);
        this.show();
        return true;
    }

    private watch(root: string): void {
        if (this.watched === root) return;
        this.watchStop?.();
        this.watched = root;
        try {
            this.watchStop = platform().fs.watchDir(root, () => {
                this.refreshStop?.();
                this.refreshStop = platform().scheduler.idleAfter(150, () => { if (this.root === root) this.activate(root, false); });
            });
        } catch { this.watchStop = null; }
    }

    private checkBackground(root: string): Promise<boolean> {
        const pending = this.checking.get(root);
        if (pending) return pending;
        if (this.available.has(root)) return Promise.resolve(true);
        if (!this.backgroundEnabled || !this.connection || platform().os !== 'linux') return Promise.resolve(false);
        if (!platform().processes.findProgram('markworkd') && !platform().fs.exists(localSocketPath())) return Promise.resolve(false);
        const work = this.probeBackground(root);
        this.checking.set(root, work);
        return work;
    }

    private async probeBackground(root: string): Promise<boolean> {
        const epoch = this.epoch;
        try {
            const conn = this.connection!();
            if (!this.connectionStop) this.connectionStop = conn.onState(() => this.show());
            const client = await bounded(conn.ready());
            const runs = await bounded(client.list({ labels: { kind: 'folder-agent', root } }));
            if (epoch !== this.epoch) return false;
            for (const run of runs.filter(r => r.state !== 'exited')) {
                const id = run.labels?.session ?? '';
                if (!this.known.has(id)) continue;
                const entry = this.find(id);
                if (entry.background?.active) continue;
                const remote = this.remote(entry);
                remote.adopt(run);
            }
            const available = await backgroundAvailable(conn, root);
            if (epoch !== this.epoch) return false;
            this.runtimeDetails.set(root, available.detail);
            if (available.available) this.available.add(root);
            return available.available;
        } catch { return false; }
        finally { if (epoch === this.epoch) { this.checking.delete(root); this.show(); } }
    }

    private remote(entry: Conversation): BackgroundConversation {
        const host = Object.create(this.host, { root: { value: () => entry.root } }) as AssistantHost<E>;
        const remote = new BackgroundConversation(this.connection!(), entry.root, entry.id, entry.panel, this.view, host,
            saved => {
                entry.assistant.chat.session.restore(saved.turns);
                entry.assistant.chat.session.work = saved.work ?? null;
                entry.assistant.chat.session.events.splice(0, entry.assistant.chat.session.events.length, ...saved.events ?? []);
            }, (ask, changes) => entry.assistant.rememberApplied(ask, changes), () => { entry.assistant.chat.open(entry.id); this.renamed(entry.id); this.show(); });
        entry.background = remote;
        return remote;
    }

    async create(parent: string, dialogs: FilesDialogs): Promise<string | null> {
        const workspace = this.host.root();
        if (!workspace) { dialogs.error('Open a work folder before creating an agent.'); return null; }
        const name = await dialogs.name('New Agent', 'Folder name');
        if (name === null) return null;
        try {
            const current = this.host.root();
            if (!current || !platform().paths.same(workspace, current)) throw Error('The workspace changed. Start New Agent again in the current folder.');
            const root = createAgentFolder(workspace, parent, name);
            this.activate(root);
            if (!this.newChat()) dialogs.error(this.error || 'The agent folder was created, but its chat could not be opened.');
            return root;
        } catch (error) {
            dialogs.error(error instanceof Error ? error.message : String(error));
            return null;
        }
    }

    newChat(): string | null {
        if (!this.root || this.error) return null;
        try {
            ensureAgentChatStorage(this.root);
            const path = saveChat(this.root, { layout: 'chat', title: 'New chat', model: this.host.settings.chatModel, created: nowStamp(), turns: [] }, null, 'agent-folder');
            this.restore(this.root, path, 'New chat');
            this.open(path);
            return path;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
            this.show();
            return null;
        }
    }

    openFile(path: string, text: string): boolean {
        if (optionOf(text, 'layout') !== 'chat') return false;
        const chat = parseChat(text);
        if (chat?.layout !== 'chat') return false;
        const { paths } = platform();
        const directory = paths.dirname(path), root = paths.dirname(directory);
        if (paths.basename(directory) !== 'chats') return false;
        try {
            if (!this.activate(root, false) || this.error) return false;
            if (!paths.same(folderPath(root, 'chats/' + paths.basename(path)), path)) return false;
            if (!this.known.has(path)) this.known.set(path, { root, title: chat.title });
            return this.open(path);
        } catch { return false; }
    }

    open(id: string): boolean {
        const conversation = this.find(id);
        this.root = conversation.root;
        const definition = loadAgentFolder(conversation.root);
        this.name = definition.kind === 'agent' ? definition.config.name : platform().paths.basename(conversation.root);
        this.error = definition.kind === 'invalid' ? definition.error : definition.kind === 'ordinary' ? 'agent.json is missing' : '';
        this.tabs.open(conversation.root, id, conversation.title);
        this.show();
        return true;
    }

    find(id: string): Conversation {
        const known = this.known.get(id);
        if (known && !this.conversations.has(id)) this.restore(known.root, id, known.title);
        const entry = this.conversations.get(id);
        const workspace = this.host.root();
        if (!entry || !workspace || entry.root !== workspace && insideName(workspace, entry.root) === null) throw Error('That agent session is not available in this workspace');
        return entry;
    }

    private restore(root: string, id: string, title: string): void {
        const panel = new FolderPanel(id, this.view, () => { this.renamed(id); this.show(); });
        const scoped = Object.create(this.host, {
            root: { value: () => root },
            chatPanel: { value: panel },
            projectName: { value: (file: string | null) => file ? insideName(root, file) : null },
        }) as AssistantHost<E>;
        const assistant = new AssistantController(scoped, { nameOf: () => '', canInsert: () => false });
        const chat = assistant.chat;
        chat.makeProvider = key => this.source.makeProvider(key);
        chat.keyStore = this.source.keyStore;
        chat.storage = 'agent-folder';
        chat.saveChats = true;
        chat.options = { activeDocument: false, selection: false, project: true };
        chat.host.files = freshness => {
            const definition = loadAgentFolder(root);
            return this.host.workspace.files(root, { freshness }).filter(f => !isAgentReserved(f.name) && (definition.kind !== 'agent' || f.name !== definition.config.instructions));
        };
        chat.host.canSave = path => this.host.docs().some(d => d.file === path && d.editor.isModified()) ? 'The conversation has unsaved edits in an open document. Save or close that document before continuing.' : null;
        chat.host.git = undefined;
        chat.host.active = () => null;
        chat.host.selection = () => '';
        const apply = chat.host.applyBatch!;
        chat.host.applyBatch = changes => changes.some(c => changeFiles(c).some(isAgentReserved)) ? 'Agent configuration and session storage require an explicit user edit' : apply(changes);
        const applyOne = chat.host.applyChange!;
        chat.host.applyChange = change => changeFiles(change).some(isAgentReserved) ? 'Agent configuration and session storage require an explicit user edit' : applyOne(change);
        chat.open(id);
        this.known.set(id, { root, title });
        this.conversations.set(id, { id, root, title, assistant, panel });
        panel.snapshot = () => this.snapshot(id);
        const send = panel.onSend;
        panel.onSend = text => this.send(id, text, send);
        const applyProposal = panel.onApply;
        panel.onApply = async (ask, chosen) => this.find(id).background?.active ? this.find(id).background!.apply(ask, chosen) : applyProposal(ask, chosen);
        const undo = panel.onUndo;
        panel.onUndo = target => entryBackgroundBusy() ? Promise.resolve('Wait for background work to finish before Undo') : undo(target);
        const entryBackgroundBusy = () => this.find(id).background?.active;
        const stop = panel.onStop;
        panel.onStop = () => { if (this.queue.cancel(id)) { panel.queued = false; panel.busyChanged(false); return; } const background = this.find(id).background; if (background?.active) background.stop(); else stop(); };
        panel.onSaveChats = () => { chat.saveChats = true; if (panel.shown) panel.setSettings({ ...panel.shown, saveChats: true }); };
        panel.onOptions = () => {};
        panel.onReset = () => { this.root = root; this.newChat(); };
        panel.onOpenChat = async path => { this.open(path); return null; };
        panel.onDeleteChat = async () => 'Delete an agent conversation from its file after stopping it';
        const definition = loadAgentFolder(root);
        if (definition.kind === 'agent') chat.roleInstructions = definition.instructions;
    }

    private async send(id: string, text: string, local: (text: string) => Promise<void>): Promise<void> {
        if (!text.trim()) return;
        const entry = this.find(id), { root, panel, assistant } = entry;
        if (entry.sending || entry.background?.active || panel.busy) throw Error('This session is already working or queued');
        const epoch = this.epoch;
        const conflict = assistant.chat.host.canSave?.(id);
        if (conflict) throw Error(conflict);
        entry.sending = true;
        try {
            const background = await this.checkBackground(root);
            if (epoch !== this.epoch) return;
            if (background && !this.queue.busy(root)) {
                await this.remote(entry).start(text, assistant.chat.model, assistant.chat.session.thinking);
                return;
            }
            if ([...this.conversations.values()].some(c => c.root === root && c.background?.active)) throw Error('This folder has background work. Reconnect before starting another local turn.');
            panel.queued = this.queue.busy(root);
            panel.busyChanged(true);
            await this.queue.run(root, id, async () => {
                if (epoch !== this.epoch) return;
                panel.queued = false;
                const current = loadAgentFolder(root);
                if (current.kind !== 'agent') throw Error(current.kind === 'invalid' ? current.error : 'agent.json is missing');
                assistant.chat.roleInstructions = current.instructions;
                assistant.chat.saveChats = true;
                await local(text);
            });
        } finally {
            entry.sending = false;
            panel.queued = false;
            if (!entry.background?.active) panel.busyChanged(false);
        }
    }

    snapshot(id: string): SavedChat {
        const entry = this.find(id), session = entry.assistant.chat.session;
        return { title: entry.title, model: entry.assistant.chat.model, created: loadChat(id)?.created ?? '', turns: [...session.history], work: session.work, events: [...session.events] };
    }

    private renamed(id: string): void {
        const entry = this.conversations.get(id);
        if (!entry) return;
        const question = entry.assistant.chat.session.history.find(t => t.role === 'user')?.content;
        if (!question) return;
        entry.title = question.replace(/\s+/g, ' ').slice(0, 64);
        this.tabs.rename(id, entry.title);
    }

    get busy(): boolean { return [...this.conversations.values()].some(c => c.assistant.busy || c.panel.queued); }
    get detachable(): boolean { return [...this.conversations.values()].some(c => c.background?.active); }
    stop(): void { for (const c of this.conversations.values()) { c.assistant.stop(); c.background?.stop(); } }
    dispose(): void { this.epoch++; this.watchStop?.(); this.watchStop = null; this.refreshStop?.(); this.watched = ''; this.available.clear(); this.runtimeDetails.clear(); this.checking.clear(); this.queue.clear(); for (const c of this.conversations.values()) { c.background?.detach(); c.assistant.dispose(); } this.conversations.clear(); this.known.clear(); this.connectionStop?.(); this.connectionStop = null; }
}
