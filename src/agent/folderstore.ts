// Native pi is authoritative. This index routes chats; Markdown files are checked readable projections only.
import { platform } from '../platform/index';
import { insideName, readTextFile, writeTextFile } from '../base/files';
import { folderPath } from './path';
import { parseChat, serializeChat, type SavedChat } from './transcript';
import type { AgentFolderConfig } from './folder';

export interface FolderRunBinding { id: string; seq: number; prompted: boolean }
export interface FolderChatBinding {
    id: string;
    title: string;
    created: string;
    native: string | null;
    instructionRevision?: string;
    run?: FolderRunBinding;
    projectionHash: string;
    status: 'idle' | 'running' | 'interrupted';
}
interface FolderIndex { version: 1; root: string; chats: FolderChatBinding[]; execution?: 'local' | 'background' }

export class FolderStore {
    readonly directory: string;
    private data: FolderIndex;
    private owner = '';

    constructor(readonly root: string, readonly config: AgentFolderConfig) {
        const { fs, paths } = platform();
        this.directory = paths.join(paths.dataDir(), 'markwork', 'folder-agents', config.id);
        const index = paths.join(this.directory, 'index.json');
        this.data = { version: 1, root, chats: [] };
        if (fs.kind(index) !== 'missing') this.data = this.readIndex(index);
    }

    private readIndex(path: string): FolderIndex {
        if (platform().fs.info(path).size > 1024 * 1024) throw Error('Agent session index is too large');
        const index = JSON.parse(readTextFile(path)) as FolderIndex;
        if (index.version !== 1 || !Array.isArray(index.chats) || index.chats.length > 1000) throw Error('Invalid agent session index');
        if (index.execution !== undefined && !['local', 'background'].includes(index.execution)) throw Error('Invalid agent execution mode');
        if (index.root !== this.root && platform().fs.exists(index.root)) throw Error('This agent identity belongs to another folder. Do not copy agent ids between folders.');
        for (const chat of index.chats) this.validateBinding(chat);
        if (new Set(index.chats.map(chat => chat.id)).size !== index.chats.length) throw Error('Duplicate agent session binding');
        return { ...index, root: this.root };
    }

    private validateBinding(chat: FolderChatBinding): void {
        if (!chat || !/^[a-f0-9-]{36}$/.test(chat.id) || typeof chat.title !== 'string' || typeof chat.created !== 'string'
            || typeof chat.projectionHash !== 'string' || !['idle', 'running', 'interrupted'].includes(chat.status)) throw Error('Invalid agent session binding');
        if (chat.run && (!/^[a-f0-9-]{36}$/.test(chat.run.id) || !Number.isSafeInteger(chat.run.seq) || chat.run.seq < 0 || typeof chat.run.prompted !== 'boolean')) throw Error('Invalid background run binding');
        if (chat.native && (typeof chat.native !== 'string' || !insideName(platform().paths.join(this.directory, 'sessions'), chat.native))) throw Error('Native session is outside runtime storage');
    }

    get execution(): 'local' | 'background' { return this.data.execution ?? 'local'; }
    setExecution(mode: 'local' | 'background'): void {
        this.claim();
        if (this.data.chats.some(chat => chat.run)) throw Error('Resolve the original background run before changing execution mode');
        this.data.execution = mode;
        this.save();
    }
    list(): FolderChatBinding[] { return this.data.chats.map(chat => ({ ...chat, ...(chat.run ? { run: { ...chat.run } } : {}) })); }

    beginRun(id: string): string {
        this.claim();
        if (this.data.chats.some(chat => chat.run)) throw Error('Reconnect or explicitly recover the original background run first');
        const run = platform().newId();
        this.get(id).run = { id: run, seq: 0, prompted: false };
        this.save();
        return run;
    }
    checkpoint(id: string, seq: number): void {
        this.claim();
        const run = this.get(id).run;
        if (!run || seq <= run.seq) return;
        run.seq = seq;
        this.save();
    }
    markPrompted(id: string): void {
        this.claim();
        const run = this.get(id).run;
        if (!run) throw Error('Missing background run binding');
        run.prompted = true;
        this.save();
    }
    clearRun(id: string): void { this.claim(); delete this.get(id).run; this.save(); }

    // Submitted drafts are presentation/recovery data, never input for automatic execution.
    draft(id: string): string {
        const path = platform().paths.join(this.directory, 'draft-' + this.get(id).id + '.txt');
        if (!platform().fs.exists(path)) return '';
        if (platform().fs.info(path).size > 512000) throw Error('Agent draft exceeded its size limit');
        return readTextFile(path);
    }
    saveDraft(id: string, text: string): void {
        if (text.length > 128000) throw Error('Agent draft exceeded its size limit');
        this.claim();
        writeTextFile(platform().paths.join(this.directory, 'draft-' + this.get(id).id + '.txt'), text);
    }
    clearDraft(id: string): void { this.saveDraft(id, ''); }
    path(id: string): string { return folderPath(this.root, 'chats/' + this.get(id).id + '.md'); }
    get(id: string): FolderChatBinding {
        const chat = this.data.chats.find(item => item.id === id);
        if (!chat) throw Error('That pi conversation is not available');
        return chat;
    }

    claim(): void {
        if (this.owner) return;
        const { fs, paths } = platform();
        fs.makeDirs(this.directory, 0o700);
        const lock = paths.join(this.directory, 'owner');
        if (!fs.createDir(lock, 0o700)) throw Error('This agent is owned by another window or an interrupted application. Close its owning window. After a crash, inspect native sessions and remove the runtime owner directory before explicit recovery.');
        this.owner = platform().newId();
        try {
            writeTextFile(paths.join(lock, 'identity'), this.owner);
            const index = paths.join(this.directory, 'index.json');
            // A previously read index may predate another window's run. Refresh only after exclusive ownership.
            if (fs.exists(index)) this.data = this.readIndex(index);
        } catch (error) { this.release(); throw error; }
    }

    release(): void {
        if (!this.owner) return;
        const { fs, paths } = platform(), lock = paths.join(this.directory, 'owner');
        try {
            if (fs.kind(lock) === 'missing') return;
            if (readTextFile(paths.join(lock, 'identity')) === this.owner) {
                fs.remove(paths.join(lock, 'identity'));
                fs.remove(lock);
            }
        } finally { this.owner = ''; }
    }

    private save(): void {
        this.claim();
        const text = JSON.stringify(this.data);
        if (text.length > 1024 * 1024) throw Error('Agent session index is too large');
        writeTextFile(platform().paths.join(this.directory, 'index.json'), text);
    }

    create(): FolderChatBinding {
        this.claim();
        if (this.data.chats.length >= 1000) throw Error('This agent has reached the 1,000-session limit');
        const chat: FolderChatBinding = { id: platform().newId(), title: 'New chat', created: new Date().toISOString(), native: null, projectionHash: '', status: 'idle' };
        const path = folderPath(this.root, 'chats/' + chat.id + '.md');
        if (platform().fs.exists(path)) throw Error('Conversation projection already exists');
        this.data.chats.push(chat);
        try { this.project(chat.id, { layout: 'chat', title: chat.title, created: chat.created, model: 'pi', turns: [] }); }
        catch (error) { this.data.chats.pop(); throw error; }
        return chat;
    }

    update(id: string, fields: Partial<Pick<FolderChatBinding, 'native' | 'status' | 'title' | 'instructionRevision'>>): void {
        this.claim();
        const chat = this.get(id);
        if (fields.native && !insideName(platform().paths.join(this.directory, 'sessions'), fields.native)) throw Error('pi returned an unsafe native session path');
        Object.assign(chat, fields);
        this.save();
    }

    recordTurn(id: string): void {
        this.claim();
        const chat = this.get(id);
        if (!chat.native || !chat.instructionRevision) throw Error('Native session and instructions must be bound before recording a turn');
        // Append-only provenance, never prompts, credentials or executable replay input.
        platform().fs.append(platform().paths.join(this.directory, 'turns.jsonl'), JSON.stringify({ version: 1, id: platform().newId(), chat: id,
            native: chat.native, instructionRevision: chat.instructionRevision, started: new Date().toISOString() }) + '\n');
    }

    assertProjection(id: string): void {
        const chat = this.get(id), path = this.path(id);
        if (!platform().fs.exists(path) || platform().hash(readTextFile(path)) !== chat.projectionHash) throw Error('The chat projection changed on disk. It is not executable history. Restore the native projection before continuing.');
    }

    view(id: string): SavedChat {
        const binding = this.get(id);
        try {
            this.assertProjection(id);
            const parsed = parseChat(readTextFile(this.path(id)));
            if (parsed) return { layout: 'chat', title: binding.title, created: binding.created, model: parsed.model, turns: parsed.turns };
        } catch { /* Show identity, never adopt hand-edited history or approval metadata. */ }
        return { title: binding.title, created: binding.created, model: 'pi', turns: [] };
    }

    project(id: string, view: SavedChat, restore = false): void {
        this.claim();
        const chat = this.get(id), { fs, paths } = platform();
        if (chat.projectionHash && !restore) this.assertProjection(id);
        const dir = folderPath(this.root, 'chats');
        fs.makeDirs(dir, 0o755);
        const ignore = paths.join(dir, '.gitignore');
        if (!fs.exists(ignore)) writeTextFile(ignore, '*\n');
        const text = serializeChat({ ...view, layout: 'chat', events: [], work: null });
        if (text.length > 2 * 1024 * 1024) throw Error('Readable chat projection exceeded 2 MiB. Native history is retained in runtime storage.');
        writeTextFile(this.path(id), text);
        chat.projectionHash = platform().hash(text);
        this.save();
    }

    instructionSnapshot(text: string): string {
        this.claim();
        const path = platform().paths.join(this.directory, 'instructions-' + platform().hash(text) + '.md');
        if (!platform().fs.exists(path)) writeTextFile(path, text);
        else if (readTextFile(path) !== text) throw Error('An immutable instruction snapshot was modified');
        return path;
    }
}
