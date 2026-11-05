// Folder identity, routing, explicit activation, and queues belong to the application, not a ChatController.
import { DaemonHub, LOCAL_MACHINE, type Openers } from '../orchestrator/hub';
import { FolderDaemonPi } from './folderdaemon';
import { createAgentFolder } from './agentfoldercreate';
import type { FilesDialogs } from './files';
import type { AssistantHost } from './assistant';
import { FolderPanel, type FolderAgentView, type FolderAgentState } from './folderpanel';
import { FolderPiSession, localFolderPi, type FolderPiRuntime } from './folderpi';
import { FolderStore } from '../agent/folderstore';
import { FolderTurnQueue } from '../agent/folderqueue';
import { loadAgentFolder, type AgentFolderConfig } from '../agent/folder';
import { folderPath } from '../agent/path';
import { insideName, flushWrites } from '../base/files';
import { platform } from '../platform/index';
import type { SavedChat } from '../agent/transcript';
import type { TextEditor } from './document';

export const FOLDER_ACTIVATION_NOTICE = 'This trusted-local agent runs pi with your account permissions. It can change files, run commands, and access the network without individual approval. The workspace is not a sandbox: tools may access other files, secrets, localhost, and private networks. Content may be sent to model providers or network destinations. Use backups; disk writes have no guaranteed editor Undo. Avoid editing the same files while the agent works. Closing Markwork stops local execution; Stop cannot undo completed commands or guarantee termination of detached programs.';

interface Conversation { id: string; root: string; title: string; panel: FolderPanel; pi: FolderPiSession; sending: boolean }
export interface AgentFolderTabs {
    open(root: string, id: string, title: string): void;
    rename(id: string, title: string): void;
    diskChanged(root: string): void;
    conflicts(root: string): { path: string; name: string }[];
    resolve(path: string, choice: 'reload' | 'keep'): void;
    reset(): void;
}

export class AgentFoldersController<E extends TextEditor> {
    runtime: FolderPiRuntime = localFolderPi;
    private readonly queue = new FolderTurnQueue();
    private readonly known = new Map<string, { root: string; chatId: string; title: string }>();
    private readonly conversations = new Map<string, Conversation>();
    private readonly stores = new Map<string, FolderStore>();
    private readonly enabled = new Set<string>();
    private readonly enabling = new Set<string>();
    private root: string | null = null;
    private workspace: string | null = null;
    private epoch = 0;
    private watchStop: (() => void) | null = null;
    private refreshStop: (() => void) | null = null;
    private watched = '';
    private name = '';
    private error = '';
    private readonly hub: DaemonHub;
    private readonly background = new Map<string, FolderDaemonPi>();
    private readonly attaching = new Set<string>();

    constructor(private readonly host: AssistantHost<E>, private readonly view: FolderAgentView, private readonly tabs: AgentFolderTabs, private readonly dialogs: FilesDialogs, openers?: Openers) {
        this.hub = new DaemonHub({ machines: () => ({}), daemonCommand: () => '' }, openers);
        this.hub.onState(() => this.show());
    }

    private runtimeFor(store: FolderStore, chat: string): FolderPiRuntime {
        if (store.execution === 'local') return this.runtime;
        const key = store.path(chat);
        let runtime = this.background.get(key);
        if (!runtime) { runtime = new FolderDaemonPi(this.hub.connection(LOCAL_MACHINE), store, chat); this.background.set(key, runtime); }
        return runtime;
    }

    async execution(root: string, mode: 'local' | 'background'): Promise<void> {
        if (root !== this.root || !this.enabled.has(root) || this.busy) throw Error('Activate this agent and wait for idle before changing execution');
        const store = this.stores.get(root)!, epoch = this.epoch;
        if (!await this.dialogs.confirm('Change pi execution?', mode === 'background' ? 'Use local markworkd. Authenticate pi in the daemon account and allow pi, workspace and runtime storage in daemon configuration. Background work can continue after closing Markwork. Tools still run unsandboxed without Apply. No local fallback is used.' : 'Local work stops when Markwork closes.', 'Change execution', false)) return;
        if (epoch !== this.epoch || root !== this.root || this.busy) throw Error('The selected agent changed. Choose execution again.');
        store.setExecution(mode);
        const registry = this.host.settings.folderBackground;
        if (mode === 'background') registry[store.config.id] = root; else delete registry[store.config.id];
        this.host.settings.folderBackground = registry;
        this.show();
    }

    async reconnect(root: string): Promise<void> {
        const store = this.stores.get(root);
        if (!store || store.execution !== 'background' || this.attaching.has(root) || this.queue.busy(root)) return;
        this.attaching.add(root);
        try {
            store.claim();
            this.loadStore(root, store.config);
            for (const binding of store.list().filter(chat => chat.run)) {
                const entry = this.find(store.path(binding.id));
                entry.panel.busyChanged(true);
                try { await this.queue.run(root, entry.id, () => entry.pi.reconnect()); }
                finally { entry.panel.busyChanged(false); }
            }
        } finally { this.attaching.delete(root); this.show(); }
    }

    private trackBackground(workspace: string): void {
        for (const [id, root] of Object.entries(this.host.settings.folderBackground)) {
            if (!platform().paths.same(root, workspace) && insideName(workspace, root) === null) continue;
            try {
                const definition = loadAgentFolder(root);
                if (definition.kind !== 'agent' || definition.config.id !== id) continue;
                this.loadStore(root, definition.config);
                void this.reconnect(root).catch(error => this.host.toast(String(error)));
            } catch (error) { this.host.toast(String(error)); }
        }
    }

    state(): FolderAgentState {
        const root = this.root;
        const background = !!root && this.stores.get(root)?.execution === 'background';
        return { root, name: this.name, error: this.error, runtime: background ? ['connecting', 'waiting', 'failed'].includes(this.hub.state(LOCAL_MACHINE)?.state ?? '') ? 'reconnecting' : 'background' : 'local', canCreate: !this.workspace || !platform().fs.exists(platform().paths.join(this.workspace, 'agent.json')), activated: !!root && this.enabled.has(root),
            runtimeDetail: background ? 'pi · Local markworkd · Direct writes · No sandbox. Authentication is checked before each new prompt. Running work can continue after closing. Queued prompts remain drafts; unknown outcomes require explicit recovery.' : 'pi · Native sessions · Direct writes without Apply · No sandbox. Local execution stops when Markwork closes.',
            conflicts: root ? this.tabs.conflicts(root) : [],
            sessions: [...this.known].filter(([, item]) => item.root === root).map(([id, item]) => {
                const entry = this.conversations.get(id), binding = this.stores.get(item.root)?.get(item.chatId);
                return { id, root: item.root, title: binding?.title || item.title, busy: entry?.panel.busy ?? false, waiting: false, queued: entry?.panel.queued ?? false, interrupted: binding?.status !== 'idle', backgroundRun: !!binding?.run };
            }) };
    }
    private show(): void { this.view.show(this.state()); }
    refresh(): void { this.show(); }

    folderChanged(root: string): boolean {
        if (root !== this.workspace) { this.dispose(); this.workspace = root; this.root = null; this.name = ''; this.error = ''; }
        const activated = this.activate(root);
        this.trackBackground(root);
        return activated;
    }

    activate(root: string, _probe = true): boolean {
        const workspace = this.host.root();
        if (!workspace || !platform().paths.same(root, workspace) && insideName(workspace, root) === null) return false;
        try { if (!platform().paths.same(root, workspace)) folderPath(workspace, insideName(workspace, root)!); }
        catch { return false; }
        const definition = loadAgentFolder(root);
        if (definition.kind === 'ordinary') { if (this.root === root) this.error = 'agent.json is missing'; this.show(); return false; }
        this.root = root;
        this.name = definition.kind === 'agent' ? definition.config.name : platform().paths.basename(root);
        this.error = definition.kind === 'invalid' ? definition.error : '';
        if (definition.kind === 'agent') {
            try {
                this.loadStore(root, definition.config);
            } catch (error) { this.error = String(error); }
        }
        this.watch(root);
        this.host.settings.chat = true;
        this.show();
        return true;
    }

    private loadStore(root: string, config: AgentFolderConfig): void {
        let store = this.stores.get(root);
        if (store && store.config.id !== config.id) throw Error('Agent identity changed. Close and reopen the workspace.');
        if (!store) { store = new FolderStore(root, config); this.stores.set(root, store); }
        for (const chat of store.list()) this.known.set(store.path(chat.id), { root, chatId: chat.id, title: chat.title });
    }

    private watch(root: string): void {
        if (this.watched === root) return;
        this.watchStop?.(); this.watched = root;
        try {
            this.watchStop = platform().fs.watchDir(root, () => {
                this.refreshStop?.();
                this.refreshStop = platform().scheduler.idleAfter(150, () => { if (this.root === root) this.activate(root, false); });
            });
        } catch { this.watchStop = null; }
    }

    async enable(root: string): Promise<boolean> {
        if (root !== this.root || this.error || !this.stores.has(root)) throw Error('Select a valid agent before activation');
        if (this.enabled.has(root)) return true;
        if (this.enabling.has(root)) return false;
        this.enabling.add(root);
        const epoch = this.epoch;
        try {
            const yes = await this.dialogs.confirm('Activate pi agent?', FOLDER_ACTIVATION_NOTICE, 'Activate pi agent', false);
            if (!yes || epoch !== this.epoch || root !== this.root) return false;
            const store = this.stores.get(root)!;
            store.claim();
            this.loadStore(root, store.config);
            this.enabled.add(root);
            this.tabs.diskChanged(root);
            this.show();
            return true;
        } finally { this.enabling.delete(root); }
    }

    async create(_parent: string, dialogs: FilesDialogs): Promise<string | null> {
        const workspace = this.host.root();
        if (!workspace) { dialogs.error('Open a work folder before creating an agent.'); return null; }
        if (platform().fs.exists(platform().paths.join(workspace, 'agent.json'))) { dialogs.error('Open an ordinary workspace to create another agent.'); return null; }
        const name = await dialogs.name('New Agent', 'Folder name (created in agents/)');
        if (name === null) return null;
        try {
            if (!this.host.root() || !platform().paths.same(workspace, this.host.root()!)) throw Error('The workspace changed. Start New Agent again in the current folder.');
            const root = createAgentFolder(workspace, workspace, name);
            this.activate(root);
            if (!this.newChat()) throw Error(this.error || 'Could not create the first chat');
            return root;
        } catch (error) { dialogs.error(String(error)); return null; }
    }

    newChat(): string | null {
        if (!this.root || this.error) return null;
        try {
            const store = this.stores.get(this.root)!;
            const chat = store.create(), path = store.path(chat.id);
            this.known.set(path, { root: this.root, chatId: chat.id, title: chat.title });
            this.open(path);
            return path;
        } catch (error) { this.error = String(error); this.show(); return null; }
    }

    openFile(path: string, _text: string): boolean {
        const { paths } = platform(), directory = paths.dirname(path), root = paths.dirname(directory);
        if (paths.basename(directory) !== 'chats' || !this.activate(root, false) || this.error) return false;
        // Only a runtime index binding opens a chat. Handwritten/old transcripts are ordinary documents.
        if (!this.known.has(path)) return false;
        return this.open(path);
    }

    open(id: string): boolean {
        const entry = this.find(id);
        this.activate(entry.root, false);
        this.tabs.open(entry.root, id, this.stores.get(entry.root)!.get(entry.pi.chatId).title);
        this.show();
        return true;
    }

    find(id: string): Conversation {
        const known = this.known.get(id), workspace = this.host.root();
        if (!known || !workspace || !platform().paths.same(known.root, workspace) && insideName(workspace, known.root) === null) throw Error('That agent session is not available in this workspace');
        let entry = this.conversations.get(id);
        if (!entry) { entry = this.restore(id, known); this.conversations.set(id, entry); }
        return entry;
    }

    private restore(id: string, known: { root: string; chatId: string; title: string }): Conversation {
        const store = this.stores.get(known.root)!, epoch = this.epoch;
        const panel = new FolderPanel(id, this.view, () => this.show());
        const pi = new FolderPiSession(store, known.chatId, panel, this.view, () => {
            if (epoch === this.epoch) { this.tabs.rename(id, store.get(known.chatId).title); this.show(); }
        }, () => { if (epoch === this.epoch) this.tabs.diskChanged(known.root); }, () => this.runtimeFor(store, known.chatId));
        const entry = { id, root: known.root, title: known.title, panel, pi, sending: false };
        this.connectPanel(entry);
        return entry;
    }

    private connectPanel(entry: Conversation): void {
        const { panel, pi, id, root } = entry;
        panel.models = ['pi default'];
        panel.setSettings({ model: 'pi default', thinking: true, saveChats: true, options: { activeDocument: false, selection: false, project: false }, budget: 0 });
        panel.snapshot = () => this.snapshot(id);
        panel.onSend = text => this.send(id, text);
        panel.onStop = () => { if (this.queue.cancel(id)) { panel.queued = false; panel.busyChanged(false); } else pi.stop(); };
        panel.onReset = () => { this.root = root; this.newChat(); };
        panel.onPreview = async () => ({ system: '', note: 'pi manages native context, compaction, instructions, and tools. Tools may send workspace content to providers.', items: [], tokens: 0, unknownMentions: [] });
        panel.onOptions = () => {};
        panel.onChats = async () => pi.store.list().map(chat => ({ path: pi.store.path(chat.id), title: chat.title, created: chat.created, turns: 0 }));
        panel.onOpenChat = async path => { this.open(path); return null; };
        panel.onDeleteChat = async () => 'Session deletion is not available. Native history is kept in application data.';
        panel.onApply = async () => 'pi writes directly; no Apply proposal is available';
        panel.onUndo = async () => 'Editor Undo cannot reverse arbitrary pi disk writes or shell commands. Restore from backups or version control.';
        panel.onInsert = async () => false;
        panel.onClearLog = () => pi.trace.clear();
        panel.onModel = model => pi.selectModel(model);
        panel.onThinking = thinking => pi.selectThinking(thinking);
        panel.onSaveChats = () => {};
        panel.onKeyStatus = async () => null;
        panel.onSaveKey = async () => { throw Error('Authenticate using pi on this machine; folder agents do not use the Assistant key store'); };
        panel.onForgetKey = async () => {};
    }

    private async send(id: string, text: string): Promise<void> {
        if (!text.trim()) return;
        if (text.length > 128000) throw Error('The prompt exceeds 128,000 characters');
        const entry = this.find(id), { root, panel } = entry;
        if (!this.enabled.has(root)) throw Error('Activate pi agent before sending. Tools run without individual approval.');
        if (entry.sending || panel.busy) throw Error('This session is already working or queued');
        if (!this.queue.busy(root) && entry.pi.store.list().some(chat => chat.run)) throw Error('Reconnect or explicitly recover the original background run before sending');
        entry.pi.store.saveDraft(entry.pi.chatId, text);
        const epoch = this.epoch;
        entry.sending = true;
        panel.queued = this.queue.busy(root);
        panel.busyChanged(true);
        try {
            await this.queue.run(root, id, async () => {
                if (epoch !== this.epoch) return;
                panel.queued = false;
                flushWrites(root);
                this.tabs.diskChanged(root);
                await entry.pi.send(text);
            });
        } finally { entry.sending = false; panel.queued = false; panel.busyChanged(false); }
    }

    async stopOriginal(id: string): Promise<void> {
        const entry = this.find(id), epoch = this.epoch;
        if (!entry.pi.detachable) throw Error('This conversation has no reserved background run');
        if (!await this.dialogs.confirm('Stop original background run?', 'Stop the exact recorded daemon run. Completed tools cannot be undone. Restore native history explicitly before sending another prompt.', 'Stop original run', true)) return;
        if (epoch !== this.epoch) return;
        entry.pi.stop();
        await entry.pi.waitIdle();
        this.show();
    }

    async recover(id: string): Promise<void> {
        const entry = this.find(id);
        if (!this.enabled.has(entry.root) || this.queue.busy(entry.root)) throw Error('Activate the agent and wait for its workspace to become idle before restoring native history');
        const epoch = this.epoch;
        if (!await this.dialogs.confirm('Restore native session?', 'Replace the readable chat projection with native pi history. This does not resend prompts or repeat tools.', 'Restore native session', true)) return;
        if (epoch !== this.epoch || this.queue.busy(entry.root)) return;
        entry.panel.busyChanged(true);
        try { await this.queue.run(entry.root, id, () => entry.pi.restore()); }
        finally { entry.panel.busyChanged(false); }
    }
    async resolve(path: string, choice: 'reload' | 'keep'): Promise<void> {
        const root = this.root, epoch = this.epoch;
        if (!root || !this.tabs.conflicts(root).some(conflict => platform().paths.same(conflict.path, path))) throw Error('That disk conflict is not available');
        const yes = await this.dialogs.confirm(choice === 'reload' ? 'Use disk version?' : 'Keep draft for saving?', choice === 'reload'
            ? 'This discards the current unsaved draft and loads the disk contents. Save a copy first if you need both versions.'
            : 'This preserves your draft and allows Save or autosave to replace the current disk contents. Save a copy first if you need both versions.', choice === 'reload' ? 'Use disk version' : 'Keep draft for saving', true);
        if (!yes || this.root !== root || this.epoch !== epoch) return;
        this.tabs.resolve(path, choice); this.show();
    }
    snapshot(id: string): SavedChat { return this.find(id).pi.view; }
    activity(): { children: number; detachable: number; queued: number } {
        const entries = [...this.conversations.values()];
        return { children: entries.filter(entry => entry.panel.busy && !entry.panel.queued && !entry.pi.detachable).length,
            detachable: entries.filter(entry => entry.pi.detachable).length, queued: entries.filter(entry => entry.panel.queued).length };
    }
    get busy(): boolean { const a = this.activity(); return a.children + a.detachable + a.queued > 0; }
    get detachable(): boolean { return this.activity().detachable > 0; }
    stop(): void { this.queue.clear(); for (const entry of this.conversations.values()) entry.pi.stop(); }
    async stopAndWait(): Promise<void> {
        this.stop();
        await Promise.all([...this.conversations.values()].map(entry => entry.pi.waitIdle()));
    }
    async shutdown(keep = false): Promise<void> {
        if (keep) {
            this.queue.clear();
            for (const entry of this.conversations.values()) if (entry.pi.detachable) entry.pi.detach(); else entry.pi.stop();
            await Promise.all([...this.conversations.values()].map(entry => entry.pi.waitIdle()));
        } else await this.stopAndWait();
        for (const store of this.stores.values()) store.release();
    }
    dispose(): void {
        this.tabs.reset();
        this.epoch++; this.watchStop?.(); this.watchStop = null; this.refreshStop?.(); this.watched = ''; this.queue.clear(); this.enabled.clear();
        const stores = [...this.stores.values()], sessions = [...this.conversations.values()];
        // Keep ownership until every local child has shut down. Another window must not become a competing writer.
        for (const entry of sessions) if (entry.pi.detachable) entry.pi.detach();
        void Promise.all(sessions.map(entry => entry.pi.dispose())).then(() => { for (const store of stores) store.release(); })
            .catch(error => this.host.toast('Agent shutdown or ownership release failed: ' + String(error)));
        this.hub.dispose(); this.background.clear(); this.attaching.clear();
        this.conversations.clear(); this.known.clear(); this.stores.clear();
    }
}
