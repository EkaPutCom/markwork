import { createAgentFolder } from '../../src/app/agentfoldercreate';
import { FOLDER_ACTIVATION_NOTICE } from '../../src/app/agentfolders';
import { FolderStore } from '../../src/agent/folderstore';
import { FolderTurnQueue } from '../../src/agent/folderqueue';
import { parseAgentFolder, loadAgentFolder } from '../../src/agent/folder';
import { platform } from '../../src/platform/index';
import { host } from '../core/host';
import { AppSession } from '../../src/app/session';
import { memorySettings, fakeFrontend } from './appsession';
import { fakeFolderPi } from './fakefolderpi';
import { section, test, eq, ok, tmp, disk, until, say } from '../core/framework';

function root(name: string): string { const folder = disk.join(tmp, 'pi-folder-' + name); disk.mkdirs(folder); return folder; }
function config(): string { return JSON.stringify({ version: 2, id: platform().newId(), runtime: 'pi', name: 'Research Assistant', instructions: 'instructions.md' }); }
function fixture(name: string): string {
    const folder = root(name);
    disk.write(disk.join(folder, 'agent.json'), config());
    disk.write(disk.join(folder, 'instructions.md'), 'Cite sources before making claims.');
    disk.mkdirs(disk.join(folder, 'workspace'));
    disk.write(disk.join(folder, 'workspace', 'plan.md'), '# Plan\n\nShip 15 November\n');
    return folder;
}
function sessionFor(folder: string) {
    const settings = memorySettings(); settings.welcomed = true; settings.autosave = false;
    const frontend = fakeFrontend(settings, []);
    frontend.dialogs.files.confirm = async () => true;
    const session = new AppSession(frontend), fake = fakeFolderPi();
    session.agentFolders.runtime = fake.runtime;
    session.start(); session.open(folder);
    return { session, fake, frontend, settings };
}

export async function agentFolderTests(): Promise<void> {
    section('Pi Agent folders');
    await test('new shell outputs expand their parents without opening a document or changing tree selection', async () => {
        const folder = fixture('output-tree'), { session, frontend } = sessionFor(folder);
        const shown = new Map<string, string[]>(), expanded: string[] = [];
        let revealed = false;
        const watch = platform().fs.watchDir;
        platform().fs.watchDir = () => { throw Error('Unwatchable fixture'); };
        frontend.host.fileTree.showFolder = (dir, entries) => shown.set(dir, entries.map(entry => entry.name));
        frontend.host.fileTree.expand = dir => expanded.push(dir);
        frontend.host.fileTree.reveal = () => { revealed = true; };
        try {
            await session.agentFolders.enable(folder); eq(expanded, []);
            const id = session.agentFolders.state().sessions[0].id;
            await session.agentFolders.find(id).panel.onSend('write report');
            const workspace = disk.join(folder, 'workspace');
            ok(shown.get(workspace)?.includes('report.md'), 'new output missing'); ok(expanded.includes(workspace), 'workspace stayed collapsed');
            const output = disk.join(workspace, 'output', 'research'); disk.mkdirs(output); disk.write(disk.join(output, 'cve.md'), '# Sources');
            session.files.refreshAgent(folder);
            ok(expanded.includes(output) && shown.get(output)?.includes('cve.md'), 'nested shell output hidden');
            eq(revealed, false, 'file creation changed selection');
            expanded.length = 0; session.files.refreshAgent(folder); eq(expanded, [], 'unchanged inventory re-expanded folders');
            disk.write(disk.join(output, 'cve.md'), '# Updated evidence for the source'); session.files.refreshAgent(folder);
            ok(expanded.includes(output), 'updated existing report stayed hidden'); expanded.length = 0;
            const outside = root('outside-output'); disk.write(disk.join(outside, 'private.md'), '# Private');
            host().symlink(outside, disk.join(workspace, 'linked'));
            for (const name of ['.private', 'node_modules']) { const dir = disk.join(workspace, name); disk.mkdirs(dir); disk.write(disk.join(dir, 'hidden.md'), '# Hidden'); }
            session.files.refreshAgent(folder); eq(expanded, [], 'discovery followed links or hidden/dependency folders');
        } finally { platform().fs.watchDir = watch; session.dispose(); }
    });
    await test('incomplete output inventories do not expand guessed paths but loaded folders still refresh', async () => {
        const folder = fixture('output-limit'), { session, frontend } = sessionFor(folder), workspace = disk.join(folder, 'workspace');
        const expanded: string[] = [], shown = new Map<string, string[]>();
        frontend.host.fileTree.expand = dir => expanded.push(dir);
        frontend.host.fileTree.showFolder = (dir, entries) => shown.set(dir, entries.map(entry => entry.name));
        try {
            await session.agentFolders.enable(folder); frontend.host.fileTree.onOpenFolder(workspace);
            const bulk = disk.join(workspace, 'bulk'); disk.mkdirs(bulk);
            for (let i = 0; i < 1001; i++) disk.write(disk.join(bulk, `entry-${i}.md`), 'Large inventory');
            disk.write(disk.join(workspace, 'new.md'), '# New'); session.files.refreshAgent(folder);
            eq(expanded, [], 'partial inventory inferred outputs'); ok(shown.get(workspace)?.includes('new.md'), 'normal loaded-folder refresh stopped');
        } finally { session.dispose(); }
    });
    await test('agent output discovery baseline: 200 existing files and new nested reports', async () => {
        const folder = fixture('output-perf'), workspace = disk.join(folder, 'workspace');
        for (let i = 0; i < 200; i++) disk.write(disk.join(workspace, `note-${i}.md`), '# Existing');
        const { session } = sessionFor(folder), times: number[] = [];
        try {
            await session.agentFolders.enable(folder);
            for (let i = 0; i < 23; i++) {
                const dir = disk.join(workspace, 'output-' + i); disk.mkdirs(dir); disk.write(disk.join(dir, 'report.md'), '# New');
                const start = platform().monotonicMs(); session.files.refreshAgent(folder);
                if (i >= 3) times.push(platform().monotonicMs() - start);
            }
            times.sort((a, b) => a - b);
            say('  Agent tree discovery baseline (200 files, ms): ' + JSON.stringify({ median: times[10], p95: times[18], max: times[19] }));
        } finally { session.dispose(); }
    });
    await test('new agents are version 2 stable identities directly under the root agents directory', () => {
        const workspace = root('create');
        const path = createAgentFolder(workspace, workspace, ' Research Agent ');
        eq(path, disk.join(workspace, 'agents', 'Research Agent'));
        const definition = loadAgentFolder(path);
        eq(definition.kind, 'agent');
        if (definition.kind === 'agent') { eq(definition.config.runtime, 'pi'); ok(definition.config.id.length === 36, 'missing UUID'); }
        ok(disk.read(disk.join(path, 'instructions.md')).includes('without Apply'), 'wrong approval boundary');
        eq(disk.read(disk.join(path, 'chats', '.gitignore')), '*\n');
        eq(platform().fs.kind(disk.join(path, 'workspace')), 'directory');
        let rejected = false;
        try { createAgentFolder(workspace, workspace, 'Research Agent'); } catch { rejected = true; }
        ok(rejected, 'collision overwritten');
        eq(platform().fs.list(workspace), ['agents']);
    });
    await test('creation rejects unsafe names, forged parents, nesting, files and symlink escapes', () => {
        const workspace = root('paths'), outside = root('outside');
        for (const name of ['', '..', '../escape', '..\\escape', '.hidden', 'A:B', 'CON', 'name.', 'a'.repeat(121)]) {
            let rejected = false; try { createAgentFolder(workspace, workspace, name); } catch { rejected = true; } ok(rejected, name);
        }
        for (const parent of [outside, disk.join(workspace, 'projects', 'agents')]) {
            let rejected = false; try { createAgentFolder(workspace, parent, 'Bad'); } catch { rejected = true; } ok(rejected, parent);
        }
        host().symlink(outside, disk.join(workspace, 'agents'));
        let rejected = false; try { createAgentFolder(workspace, workspace, 'Bad'); } catch { rejected = true; } ok(rejected, 'symlink accepted');
        eq(disk.exists(disk.join(outside, 'Bad')), false);
        const fileRoot = root('agents-file'); disk.write(disk.join(fileRoot, 'agents'), 'Keep');
        rejected = false; try { createAgentFolder(fileRoot, fileRoot, 'Bad'); } catch { rejected = true; } ok(rejected, 'file replaced');
        eq(disk.read(disk.join(fileRoot, 'agents')), 'Keep');
        const agent = fixture('nested'); rejected = false;
        try { createAgentFolder(agent, agent, 'Bad'); } catch { rejected = true; } ok(rejected, 'agent inside agent');
    });
    await test('failed scaffold writes do not publish partial agents or remove unknown user contents', () => {
        const workspace = root('failure'), fs = platform().fs, original = fs.writeText;
        fs.writeText = (path, text) => { if (path.endsWith('instructions.md')) throw Error('Simulated failure'); original.call(fs, path, text); };
        let rejected = false;
        try { createAgentFolder(workspace, workspace, 'Failed'); } catch { rejected = true; }
        finally { fs.writeText = original; }
        ok(rejected, 'failure hidden'); eq(platform().fs.list(disk.join(workspace, 'agents')), []);
    });
    await test('old markers, executable configuration, traversal and malformed definitions start no runtime', () => {
        const valid = JSON.parse(config());
        for (const value of [{ ...valid, version: 1 }, { ...valid, id: '../escape' }, { ...valid, program: '/bin/sh' }, { ...valid, instructions: '../secret.md' }, { ...valid, instructions: 'chats/a.md' }]) {
            let rejected = false; try { parseAgentFolder(JSON.stringify(value)); } catch { rejected = true; } ok(rejected, JSON.stringify(value));
        }
        const folder = fixture('invalid'); disk.write(disk.join(folder, 'agent.json'), '{');
        const { session, fake } = sessionFor(folder);
        try { ok(!!session.agentFolders.state().error, 'invalid configuration hidden'); eq(fake.launches.length, 0); }
        finally { session.dispose(); }
    });
    await test('opening, editing instructions, and creating chats never activate or launch pi', async () => {
        const folder = fixture('activation'), { session, fake, frontend } = sessionFor(folder);
        try {
            const id = session.agentFolders.state().sessions[0].id;
            eq(session.agentFolders.state().activated, false); eq(fake.launches.length, 0);
            disk.write(disk.join(folder, 'instructions.md'), 'New role'); session.agentFolders.activate(folder);
            let rejected = false; try { await session.agentFolders.find(id).panel.onSend('Hello'); } catch { rejected = true; } ok(rejected, 'implicit activation');
            frontend.dialogs.files.confirm = async (_message, detail) => { eq(detail, FOLDER_ACTIVATION_NOTICE); return false; };
            eq(await session.agentFolders.enable(folder), false); eq(fake.launches.length, 0);
            frontend.dialogs.files.confirm = async () => true;
            ok(await session.agentFolders.enable(folder), 'not activated'); eq(fake.launches.length, 0);
            await session.agentFolders.find(id).panel.onSend('Hello');
            eq(fake.prompts, ['Hello']); eq(fake.launches[0].cwd, disk.join(folder, 'workspace'));
            ok(session.agentFolders.snapshot(id).turns.some(t => t.content === 'Echo: Hello'), 'missing native answer');
        } finally { session.dispose(); }
    });
    await test('native sessions isolate history, preserve identity and use updated instruction snapshots', async () => {
        const folder = fixture('native'), { session, fake } = sessionFor(folder);
        try {
            await session.agentFolders.enable(folder);
            const a = session.agentFolders.state().sessions[0].id;
            await session.agentFolders.find(a).panel.onSend('First token');
            const b = session.agentFolders.newChat()!;
            await session.agentFolders.find(b).panel.onSend('Second token');
            disk.write(disk.join(folder, 'instructions.md'), 'Revision two.');
            const store = session.agentFolders.find(a).pi.store;
            store.update(session.agentFolders.find(a).pi.chatId, { title: 'Named conversation' });
            await session.agentFolders.find(a).panel.onSend('history');
            eq(session.agentFolders.snapshot(a).title, 'Named conversation');
            const turns = disk.read(disk.join(store.directory, 'turns.jsonl')).trim().split('\n').map(line => JSON.parse(line));
            eq(turns.length, 3); eq(turns[0].instructionRevision, turns[1].instructionRevision);
            ok(turns[0].instructionRevision !== turns[2].instructionRevision, 'turn revisions were not recorded');
            eq(turns[0].native, turns[2].native); ok(turns[0].chat !== turns[1].chat, 'turn provenance lost chat identity');
            ok(!JSON.stringify(turns).includes('First token'), 'runtime metadata copied user prompts');
            const history = session.agentFolders.snapshot(a).turns.map(t => t.content).join('\n');
            ok(history.includes('First token') && !history.includes('Second token'), 'sessions leaked');
            ok(fake.instructions[2].includes('Revision two.') && !fake.instructions[2].includes('Cite sources before'), 'stale instructions');
            eq(fake.launches[2].argv.includes('--session'), true);
            ok(fake.launches.every(launch => launch.argv.includes('--no-extensions')), 'unreviewed resources loaded');
            eq(disk.read(a).includes('layout: chat'), true);
        } finally { session.dispose(); }
    });
    await test('tool writes bypass Apply and known credential fields are redacted from bounded logs', async () => {
        const folder = fixture('writes'), { session } = sessionFor(folder);
        try {
            await session.agentFolders.enable(folder);
            const id = session.agentFolders.state().sessions[0].id;
            await session.agentFolders.find(id).panel.onSend('write report');
            ok(disk.read(disk.join(folder, 'workspace', 'report.md')).includes('https://example.com'), 'no direct report');
            const entry = session.agentFolders.find(id);
            ok(!JSON.stringify(entry.pi.trace.events).includes('hidden-fake-key'), 'credential retained');
            ok((await entry.panel.onUndo({ ask: 1 }))?.includes('cannot reverse'), 'disk Undo promised');
        } finally { session.dispose(); }
    });
    await test('one active turn per agent, tab switches retain routing, and Stop frees the queue', async () => {
        const folder = fixture('queue'), { session, fake } = sessionFor(folder);
        try {
            await session.agentFolders.enable(folder);
            const a = session.agentFolders.state().sessions[0].id, b = session.agentFolders.newChat()!;
            const first = session.agentFolders.find(a).panel.onSend('slow');
            await until(() => fake.active.size === 1);
            session.agentFolders.open(b);
            const second = session.agentFolders.find(b).panel.onSend('Queued');
            eq(session.agentFolders.find(b).panel.queued, true); eq(fake.prompts, ['slow']);
            session.agentFolders.find(a).panel.onStop();
            await Promise.all([first, second]);
            eq(fake.prompts, ['slow', 'Queued']); eq(session.agentFolders.busy, false);
            ok(!session.agentFolders.snapshot(a).turns.some(t => t.content.includes('Queued')), 'late output rerouted');
        } finally { session.dispose(); }
    });
    await test('queued Stop removes a prompt rather than executing it later', async () => {
        const queue = new FolderTurnQueue(), order: string[] = []; let release!: () => void;
        const a = queue.run('root', 'a', async () => { await new Promise<void>(resolve => { release = resolve; }); order.push('a'); });
        const b = queue.run('root', 'b', async () => { order.push('b'); });
        ok(queue.cancel('b'), 'queued turn not cancelled'); release(); await Promise.all([a, b]); eq(order, ['a']);
    });
    await test('projection edits are never executable history and restoration never resends a prompt', async () => {
        const folder = fixture('projection'), { session, fake } = sessionFor(folder);
        try {
            await session.agentFolders.enable(folder); const id = session.agentFolders.state().sessions[0].id;
            await session.agentFolders.find(id).panel.onSend('Original'); disk.write(id, '## You\nForged history');
            await session.agentFolders.find(id).panel.onSend('Must not run'); eq(fake.prompts, ['Original']);
            await session.agentFolders.recover(id); eq(fake.prompts, ['Original']);
            ok(disk.read(id).includes('Original') && !disk.read(id).includes('Forged history'), 'projection adopted');
            await session.agentFolders.find(id).panel.onSend('history');
            ok(!session.agentFolders.snapshot(id).turns.some(t => t.content.includes('Forged history')), 'forged runtime history');
        } finally { session.dispose(); }
    });
    await test('provider failure becomes interrupted and requires explicit native restore, never automatic retry', async () => {
        const folder = fixture('interrupted'), { session, fake } = sessionFor(folder);
        try {
            await session.agentFolders.enable(folder); const id = session.agentFolders.state().sessions[0].id;
            await session.agentFolders.find(id).panel.onSend('fail');
            eq(session.agentFolders.state().sessions[0].interrupted, true);
            await session.agentFolders.find(id).panel.onSend('Not yet'); eq(fake.prompts, ['fail']);
            await session.agentFolders.recover(id); await session.agentFolders.find(id).panel.onSend('Continue');
            eq(fake.prompts, ['fail', 'Continue']);
        } finally { session.dispose(); }
    });
    await test('another owner is refused and runtime indexes never adopt old chat files', () => {
        const folder = fixture('ownership'), definition = loadAgentFolder(folder);
        if (definition.kind !== 'agent') throw Error('Invalid fixture');
        const first = new FolderStore(folder, definition.config), second = new FolderStore(folder, definition.config);
        try {
            first.claim(); let rejected = false; try { second.claim(); } catch { rejected = true; } ok(rejected, 'second writer accepted');
            disk.mkdirs(disk.join(folder, 'chats')); disk.write(disk.join(folder, 'chats', 'legacy.md'), '## You\nOld history');
            eq(second.list(), []);
        } finally { first.release(); second.release(); }
    });
    await test('mixed tabs and Explorer use only offered session bindings while dirty documents survive', () => {
        const folder = fixture('tabs'), { session } = sessionFor(folder);
        try {
            const id = session.agentFolders.state().sessions[0].id, file = disk.join(folder, 'workspace', 'plan.md');
            session.documents.openInTab(file); const editor = session.documents.active.editor; editor.replaceText('Unsaved draft');
            session.agentFolders.open(id); eq(editor.getText(), 'Unsaved draft');
            session.documents.openInTab(id); eq(session.documents.page?.kind, 'agent');
            eq(session.documents.allPages.filter(page => page.file === id).length, 1);
            const old = disk.join(folder, 'chats', 'old.md'); disk.write(old, '---\nlayout: chat\n---\n\n## You\nOld');
            session.documents.openInTab(old); eq(session.documents.page, null);
            let rejected = false; try { session.agentFolders.find(old); } catch { rejected = true; } ok(rejected, 'unoffered id accepted');
        } finally { session.dispose(); }
    });
    await test('external disk changes refresh clean documents, preserve drafts, and gate explicit save and autosave', async () => {
        const folder = fixture('disk'), { session, settings } = sessionFor(folder);
        try {
            const file = disk.join(folder, 'workspace', 'plan.md');
            session.documents.openInTab(file); const doc = session.documents.active;
            await session.agentFolders.enable(folder);
            disk.write(file, 'External clean change'); session.folderDisk.refresh(folder); session.folderDisk.observe(doc);
            eq(doc.editor.getText(), 'External clean change');
            doc.editor.replaceText('My unsaved draft');
            disk.write(file, 'External conflict'); session.folderDisk.refresh(folder);
            eq(doc.editor.getText(), 'My unsaved draft'); eq(session.folderDisk.canSave(doc), false);
            eq(await session.documents.save(), false);
            settings.autosave = true; eq(session.autosaver.now(doc), false); eq(session.autosaver.inBackground(doc), false);
            eq(disk.read(file), 'External conflict');
            await session.agentFolders.resolve(file, 'keep'); eq(session.folderDisk.canSave(doc), true);
            eq(await session.documents.save(), true); eq(disk.read(file), 'My unsaved draft');
        } finally { session.dispose(); }
    });
}
