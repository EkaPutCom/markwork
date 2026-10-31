import { createAgentFolder } from '../../src/app/agentfoldercreate';
import { platform } from '../../src/platform/index';
import { host } from '../core/host';
import { COMMANDS, type FrontendCommands } from '../../src/app/commands';
import { FolderTurnQueue } from '../../src/agent/folderqueue';
import { ensureAgentChatStorage } from '../../src/agent/chatstore';
import { FolderWorker, type WorkerOutput } from '../../src/agent/folderworker';
import { parseAgentFolder, loadAgentFolder } from '../../src/agent/folder';
import { saveChat, listChats } from '../../src/agent/chatstore';
import { WorkspaceRepository } from '../../src/base/workspace';
import { AppSession } from '../../src/app/session';
import { memorySettings, fakeFrontend, quiet } from './appsession';
import { section, test, eq, ok, tmp, disk, until } from '../core/framework';

const CONFIG = JSON.stringify({ version: 1, name: 'Research Assistant', instructions: 'instructions.md' });
function root(name: string): string {
    const folder = disk.join(tmp, 'agent-folder-' + name);
    disk.mkdirs(folder);
    return folder;
}
function fixture(name: string): string {
    const folder = root(name);
    disk.write(disk.join(folder, 'agent.json'), CONFIG);
    disk.write(disk.join(folder, 'instructions.md'), 'Cite sources before making claims.');
    disk.write(disk.join(folder, 'plan.md'), '# Plan\n\nShip 15 November\n');
    return folder;
}

export async function agentFolderTests(): Promise<void> {
    section('Agent folders');
    await test('New Agent creates a complete definition with private chats and never overwrites an existing folder', () => {
        const workspace = root('create-definition');
        const path = createAgentFolder(workspace, workspace, ' Research Agent ');
        const definition = loadAgentFolder(path);
        eq(definition.kind, 'agent');
        if (definition.kind === 'agent') eq(definition.config.name, 'Research Agent');
        ok(disk.read(disk.join(path, 'instructions.md')).includes('press Apply'), 'starter instructions omit approval');
        eq(disk.read(disk.join(path, 'chats', '.gitignore')), '*\n');
        eq(disk.exists(disk.join(path, '.markwork')), false);
        disk.write(disk.join(path, 'keep.md'), 'User content');
        let rejected = false;
        try { createAgentFolder(workspace, workspace, 'Research Agent'); } catch { rejected = true; }
        ok(rejected, 'existing folder was reused');
        eq(disk.read(disk.join(path, 'keep.md')), 'User content');
        eq(platform().fs.list(workspace), ['Research Agent']);
    });
    await test('New Agent rejects unsafe names, outside parents and symlinked parents before writing', () => {
        const workspace = root('create-paths'), outside = root('create-outside');
        for (const name of ['', '..', '../escape', '..\\escape', '.hidden', 'A:B', 'CON', 'name.', 'a'.repeat(121)]) {
            let rejected = false;
            try { createAgentFolder(workspace, workspace, name); } catch { rejected = true; }
            ok(rejected, name);
        }
        let rejected = false;
        try { createAgentFolder(workspace, outside, 'Escaped'); } catch { rejected = true; }
        ok(rejected, 'outside parent accepted');
        const link = disk.join(workspace, 'linked'); host().symlink(outside, link);
        rejected = false;
        try { createAgentFolder(workspace, link, 'Escaped'); } catch { rejected = true; }
        ok(rejected, 'symbolic link parent accepted');
        eq(disk.exists(disk.join(outside, 'Escaped')), false);
        eq(platform().fs.list(workspace), ['linked']);
    });
    await test('a failed scaffold write does not publish a partial agent folder', () => {
        const workspace = root('create-failure'), fs = platform().fs, original = fs.writeText;
        fs.writeText = (path, text) => {
            if (path.endsWith('instructions.md')) throw Error('Simulated write failure');
            original.call(fs, path, text);
        };
        let rejected = false;
        try { createAgentFolder(workspace, workspace, 'Failed Agent'); } catch { rejected = true; }
        finally { fs.writeText = original; }
        ok(rejected, 'write failure was hidden');
        eq(platform().fs.list(workspace), []);
    });
    await test('the tree New Agent action opens its first chat and preserves the existing document draft', async () => {
        const workspace = root('create-flow'), settings = memorySettings(); settings.welcomed = true; settings.autosave = false;
        const note = disk.join(workspace, 'note.md'); disk.write(note, '# Note');
        const frontend = fakeFrontend(settings, []), errors: string[] = [];
        frontend.dialogs.files.name = async (title, label) => { eq([title, label], ['New Agent', 'Folder name']); return 'Writer'; };
        frontend.dialogs.files.error = error => { errors.push(error); };
        const session = new AppSession(frontend);
        let calls = 0; session.assistant.chat.makeProvider = () => { calls++; throw Error('Opening an agent must not call a model'); };
        try {
            session.start(); session.open(workspace); session.documents.openInTab(note);
            const draft = session.documents.active; draft.editor.replaceText('# Unsaved note');
            const created = await session.host.fileTree.onCreate('agent', workspace);
            eq(created, disk.join(workspace, 'Writer'));
            eq(session.documents.page?.kind, 'agent');
            const id = session.documents.page!.file!;
            ok(disk.read(id).includes('layout: chat'), 'first chat is not canonical');
            eq(session.agentFolders.state().name, 'Writer');
            eq(session.agentFolders.find(id).assistant.chat.session.history.length, 0);
            eq([draft.editor.getText(), draft.editor.isModified(), calls], ['# Unsaved note', true, 0]);
            eq(errors, []);
        } finally { session.dispose(); }
    });
    await test('cancelling New Agent or changing the workspace while naming writes nothing', async () => {
        const workspace = root('create-cancel'), other = root('create-switched');
        const frontend = fakeFrontend(memorySettings(), []), errors: string[] = [];
        frontend.dialogs.files.error = error => { errors.push(error); };
        const session = new AppSession(frontend);
        try {
            session.start(); session.open(workspace);
            eq(await session.files.create('agent', workspace), null);
            let answer!: (name: string) => void;
            frontend.dialogs.files.name = () => new Promise(resolve => { answer = resolve; });
            const pending = session.files.create('agent', workspace);
            session.files.setRoot(other); answer('Wrong Workspace');
            eq(await pending, null);
            ok(errors.some(error => error.includes('workspace changed')), 'stale creation was not reported');
            eq(platform().fs.list(workspace), []); eq(platform().fs.list(other), []);
        } finally { session.dispose(); }
    });
    await test('the New Agent command chooses a parent folder when there is no workspace', async () => {
        const workspace = root('create-command'), frontend = fakeFrontend(memorySettings(), []);
        let choices = 0;
        frontend.documents.dialogs.chooseFile = async options => { ok(options.selectFolder, 'not a folder chooser'); choices++; return workspace; };
        frontend.dialogs.files.name = async () => 'Menu Agent';
        const session = new AppSession(frontend);
        try {
            session.start();
            COMMANDS.find(command => command.id === 'agent-new')!.run(session.commands(quiet<FrontendCommands>({})));
            await until(() => session.documents.page?.kind === 'agent');
            eq(choices, 1);
            eq(session.files.root, workspace);
            eq(loadAgentFolder(disk.join(workspace, 'Menu Agent')).kind, 'agent');
        } finally { session.dispose(); }
    });
    await test('turns queue per folder, independent folders progress, and Stop removes queued work', async () => {
        const queue = new FolderTurnQueue(), order: string[] = [];
        let release!: () => void;
        const first = queue.run('one', 'a', async () => { order.push('a'); await new Promise<void>(resolve => { release = resolve; }); });
        const second = queue.run('one', 'b', async () => { order.push('b'); });
        const cancelled = queue.run('one', 'c', async () => { order.push('c'); });
        await queue.run('two', 'd', async () => { order.push('d'); });
        eq(order, ['a', 'd']);
        ok(queue.cancel('c'), 'queued request not cancelled');
        release(); await Promise.all([first, second, cancelled]);
        eq(order, ['a', 'd', 'b']);
    });
    await test('an unrelated chats directory cannot be adopted as conversation storage', () => {
        const folder = fixture('collision');
        disk.mkdirs(disk.join(folder, 'chats'));
        disk.write(disk.join(folder, 'chats', 'notes.md'), '# Personal notes');
        let rejected = false;
        try { ensureAgentChatStorage(folder); } catch { rejected = true; }
        ok(rejected, 'unrelated notes were adopted');
        eq(disk.read(disk.join(folder, 'chats', 'notes.md')), '# Personal notes');
    });
    await test('a child agent keeps ordinary sibling files outside its source and rejects unknown sessions', () => {
        const workspace = root('parent'), folder = disk.join(workspace, 'agent');
        disk.mkdirs(folder);
        disk.write(disk.join(folder, 'agent.json'), CONFIG);
        disk.write(disk.join(folder, 'instructions.md'), 'Cite sources.');
        disk.write(disk.join(folder, 'inside.md'), 'Inside agent');
        disk.write(disk.join(workspace, 'outside.md'), 'Outside agent');
        const settings = memorySettings(); settings.welcomed = true;
        const session = new AppSession(fakeFrontend(settings, []));
        try {
            session.start(); session.open(workspace);
            ok(session.agentFolders.activate(folder), 'child agent not activated');
            const id = session.agentFolders.newChat()!;
            eq(session.agentFolders.find(id).assistant.chat.host.files!('fresh').map(f => f.name), ['inside.md']);
            let rejected = false;
            try { session.agentFolders.find(disk.join(workspace, 'outside.md')); } catch { rejected = true; }
            ok(rejected, 'unoffered session accepted');
        } finally { session.dispose(); }
    });
    await test('only an explicit versioned marker opts in; invalid instructions cannot choose external paths', () => {
        eq(loadAgentFolder(root('ordinary')), { kind: 'ordinary' });
        eq(parseAgentFolder(CONFIG).name, 'Research Assistant');
        for (const instructions of ['/etc/passwd', '../secret.md', 'chats/session.md', 'agent.json']) {
            let rejected = false;
            try { parseAgentFolder(JSON.stringify({ version: 1, name: 'Agent', instructions })); } catch { rejected = true; }
            ok(rejected, instructions);
        }
        const folder = fixture('invalid');
        disk.write(disk.join(folder, 'agent.json'), '{');
        eq(loadAgentFolder(folder).kind, 'invalid');
    });
    await test('agent chats use visible storage, ordinary Assistant history keeps its previous location', () => {
        const folder = fixture('storage');
        const data = { title: 'A conversation', model: 'test', created: '2026-10-31T10:00:00', turns: [{ role: 'user' as const, content: 'Hello' }] };
        const path = saveChat(folder, data, null, 'agent-folder');
        eq(disk.dirname(path), disk.join(folder, 'chats'));
        const empty = saveChat(folder, { ...data, layout: 'chat', turns: [] }, null, 'agent-folder');
        ok(disk.read(empty).includes('layout: chat'), 'missing chat layout marker');
        eq(listChats(folder, 'agent-folder').length, 2);
        eq(disk.exists(disk.join(folder, '.markwork')), false);
        saveChat(folder, data, null);
        eq(listChats(folder).length, 1);
        eq(disk.exists(disk.join(folder, 'chats', '.gitignore')), true);
    });
    await test('transcripts never enter workspace retrieval while a normal chats directory remains a normal folder', () => {
        const folder = fixture('sources');
        disk.mkdirs(disk.join(folder, 'chats'));
        disk.write(disk.join(folder, 'chats', 'private.md'), 'Private conversation');
        const ordinary = disk.join(folder, 'ordinary');
        disk.mkdirs(disk.join(ordinary, 'chats'));
        disk.write(disk.join(ordinary, 'chats', 'note.md'), 'Ordinary reference');
        const repository = new WorkspaceRepository();
        try { eq(repository.files(folder).map(f => f.name), ['instructions.md', 'ordinary/chats/note.md', 'plan.md']); }
        finally { repository.close(); }
    });
    await test('chat pages coexist with editable documents and restoring tabs keeps their identity', async () => {
        const folder = fixture('tabs'), settings = memorySettings();
        settings.welcomed = true;
        const session = new AppSession(fakeFrontend(settings, []));
        session.start();
        session.open(folder);
        const state = session.agentFolders.state();
        eq(state.name, 'Research Assistant');
        eq(session.documents.page?.kind, 'agent');
        const id = state.sessions[0].id;
        ok(disk.read(id).includes('layout: chat'), 'new chat did not use the chat layout');
        session.documents.openInTab(disk.join(folder, 'plan.md'));
        session.documents.active.editor.setText('# Unsaved document');
        session.agentFolders.open(id);
        eq(session.documents.active.editor.getText(), '# Unsaved document');
        eq(session.documents.allPages.filter(p => p.kind === 'agent').length, 1);
        session.documents.rememberTabs();
        session.dispose();
        const restored = new AppSession(fakeFrontend(settings, []));
        restored.start();
        restored.open(null);
        eq(restored.documents.page?.kind, 'agent');
        eq(restored.agentFolders.state().sessions[0].id, id);
        restored.dispose();
    });
    await test('opening chat-layout files uses session tabs and restores plain file paths as chat', () => {
        const workspace = root('open-transcript-parent'), folder = disk.join(workspace, 'research');
        disk.mkdirs(folder);
        disk.write(disk.join(folder, 'agent.json'), CONFIG);
        disk.write(disk.join(folder, 'instructions.md'), 'Cite sources.');
        const path = saveChat(folder, { layout: 'chat', title: 'From Explorer', model: 'test', created: '2026-10-31', turns: [] }, null, 'agent-folder');
        const settings = memorySettings(); settings.welcomed = true;
        const session = new AppSession(fakeFrontend(settings, []));
        session.start(); session.open(workspace);
        session.documents.openInTab(path);
        eq(session.documents.page?.file, path);
        eq(session.documents.page?.kind, 'agent');
        session.documents.openInTab(path);
        eq(session.documents.allPages.filter(page => page.file === path).length, 1);
        eq(session.documents.all.filter(doc => doc.file === path).length, 0);
        const ordinary = disk.join(workspace, 'ordinary.md');
        disk.write(ordinary, '---\nlayout: chat\n---\n\n## You\nOrdinary file');
        session.documents.openInTab(ordinary);
        eq(session.documents.page, null);
        eq(session.documents.active.file, ordinary);
        session.dispose();
        settings.tabs = [{ file: path, cursor: 0 }]; settings.activeTab = 0;
        const restored = new AppSession(fakeFrontend(settings, []));
        try {
            restored.start(); restored.open(null);
            eq(restored.documents.page?.kind, 'agent');
            eq(restored.documents.page?.file, path);
            eq(restored.documents.all.filter(doc => doc.file === path).length, 0);
        } finally { restored.dispose(); }
    });
    await test('an edited transcript stays in its document until saved and explicitly reopened', async () => {
        const folder = fixture('edited-transcript'), settings = memorySettings(); settings.welcomed = true;
        const session = new AppSession(fakeFrontend(settings, []));
        try {
            session.start(); session.open(folder);
            const file = disk.join(folder, 'chats', 'manual.md');
            disk.write(file, '## You\nA draft\n');
            session.documents.openInTab(file);
            const editor = session.documents.active.editor;
            editor.replaceText('---\nlayout: chat\n---\n\n## You\nAn edited draft\n');
            session.documents.openInTab(file);
            eq(session.documents.page, null);
            ok(editor.isModified(), 'the unsaved transcript was discarded');
            await session.documents.save();
            session.documents.openInTab(file);
            eq(session.documents.page?.kind, 'agent');
            eq(session.documents.page?.file, file);
            eq(session.documents.all.filter(doc => doc.file === file).length, 0);
            eq(session.agentFolders.find(file).assistant.chat.session.history[0].content, 'An edited draft');
        } finally { session.dispose(); }
    });
    await test('headless work persists and deduplicates commands without exposing credentials', async () => {
        const folder = fixture('worker'), events: WorkerOutput[] = [];
        const path = saveChat(folder, { layout: 'chat', title: 'Worker', model: 'test', created: '2026-10-31', turns: [] }, null, 'agent-folder');
        let calls = 0;
        const worker = new FolderWorker(folder, disk.join(path).split(/[\\/]/).pop()!, event => events.push(event), () => ({ async chat(request) {
            calls++;
            ok(request.messages[0].content.includes('Cite sources before making claims.'), 'role instructions missing');
            request.onText('A headless answer');
            return { usage: null, cancelled: false, reasoning: '', toolCalls: [] };
        } }));
        worker.chat.keyStore = { get: async () => ({ key: 'private-test-key', source: 'env' }), set: async () => 'env', clear: async () => {} };
        try {
            const command = JSON.stringify({ id: 'once', op: 'send', text: 'Hello' });
            await worker.command(command); await worker.command(command);
            eq(calls, 1);
            ok(events.some(event => event.event === 'done'), 'no completion');
            ok(!JSON.stringify(events).includes('private-test-key'), 'credential leaked');
            ok(disk.read(path).includes('A headless answer'), 'history not persisted');
            ok(disk.read(path).includes('layout: chat'), 'worker omitted the chat layout');
            ok(!disk.read(path).includes('agent: true'), 'worker wrote the legacy marker');
        } finally { worker.dispose(); }
    });
    await test('a headless proposal waits for actual approved contents and never applies itself', async () => {
        const folder = fixture('worker-review'), events: WorkerOutput[] = [];
        const path = saveChat(folder, { layout: 'chat', title: 'Worker review', model: 'test', created: '2026-10-31', turns: [] }, null, 'agent-folder');
        const worker = new FolderWorker(folder, path.split(/[\\/]/).pop()!, event => events.push(event), () => ({ async chat(request) {
            if (!request.messages.some(message => message.role === 'tool')) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 'edit', name: 'edit_file', arguments: JSON.stringify({ name: 'plan', old_text: '15 November', new_text: '22 November', reason: 'Approved schedule' }) }] };
            request.onText('The proposal was reviewed.');
            return { usage: null, cancelled: false, reasoning: '', toolCalls: [] };
        } }));
        worker.chat.keyStore = { get: async () => ({ key: 'test', source: 'env' }), set: async () => 'env', clear: async () => {} };
        try {
            const running = worker.command(JSON.stringify({ id: 'send', op: 'send', text: 'Change the date' }));
            await until(() => events.some(event => event.event === 'proposal'));
            const ask = Number(events.find(event => event.event === 'proposal')!.data.ask);
            eq(disk.read(disk.join(folder, 'plan.md')), '# Plan\n\nShip 15 November\n');
            let rejected = false;
            try { await worker.command(JSON.stringify({ id: 'forged', op: 'decision', ask, result: { applied: true } })); } catch { rejected = true; }
            ok(rejected, 'a claimed approval was trusted without actual contents');
            disk.write(disk.join(folder, 'plan.md'), '# Plan\n\nShip 22 November\n');
            await worker.command(JSON.stringify({ id: 'approved', op: 'decision', ask, result: { applied: true } }));
            await running;
            ok(events.some(event => event.event === 'done'), 'worker did not continue');
        } finally { worker.dispose(); }
    });

}
