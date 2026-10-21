// The app protocol without a window: changes in code points, the replica of a document, and a ProtocolServer driven by a
// scripted frontend (DocMirror) over an in-memory line.

import { applyChanges, diffChanges } from '../../src/app/protocol/changes.js';
import { DocMirror } from '../../src/app/protocol/mirror.js';
import { ProtocolEditor, headingsOf } from '../../src/app/protocol/replica.js';
import { ProtocolServer } from '../../src/app/protocol/server.js';
import { Connection } from '../../src/app/protocol/wire.js';
import { unwiredTouched } from '../../src/app/protocol/unwired.js';
import { Asks } from '../../src/app/protocol/asks.js';
import { ProtocolHarnessDialogs, ProtocolReviewDialogs } from '../../src/app/protocol/harness.js';
import type { SpawnHandlers } from '../../src/orchestrator/index.js';
import { Cancellable } from '../../src/base/cancel.js';
import { RequestError, type Message, type Reply, type Wire } from '../../src/app/protocol/messages.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { localDate } from '../../src/markdown/home.js';
import { journalName } from '../../src/markdown/journal.js';
import type { ChatResult, Provider } from '../../src/agent/provider.js';
import { memorySettings } from './appsession.js';
import { runGit } from '../../src/base/git.js';
import { host } from '../core/host.js';
import { section, test, eq, ok, tmp, disk, until, pause, within } from '../core/framework.js';

const ALPHABET = ['a', 'b', ' ', '\n', '🎉', 'é', '#', 'x'];

function randomText(next: () => number): string {
    let text = '';
    for (let n = Math.floor(next() * 12); n > 0; n--) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
    return text;
}

// A repeatable pseudo-random sequence.
function lcg(seed: number): () => number {
    let s = seed;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// A wire whose requests wait for the test to answer them.
function scriptedWire(): Wire & { sent: { op: string; payload: Record<string, unknown>; answer(reply: Reply): void }[]; notices: { ev: string; payload: Record<string, unknown> }[] } {
    const sent: { op: string; payload: Record<string, unknown>; answer(reply: Reply): void }[] = [];
    const notices: { ev: string; payload: Record<string, unknown> }[] = [];
    return {
        sent, notices,
        notify: (ev, payload = {}) => { notices.push({ ev, payload }); },
        request: (op, payload = {}) => new Promise(resolve => { sent.push({ op, payload, answer: resolve }); }),
    };
}

const BOARD = '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n- [ ] Two\n\n## Done\n\n- [x] Old\n';

// A frontend that behaves as docs/design/protocol.md says, over two Connections that deliver in order but never at once.
function attach(server: ProtocolServer, post: { toClient: (m: Message) => void }, chosen: { path: string | null } = { path: null }, refuse = { replaces: 0 }) {
    const mirrors = new Map<number, DocMirror>();
    const log: { ev: string; payload: Record<string, unknown> }[] = [];
    let active = 0;
    const client = new Connection(m => { void Promise.resolve().then(() => server.receive(m)); }, 'f');
    post.toClient = m => { void Promise.resolve().then(() => client.receive(m)); };
    client.onNotice((ev, p) => {
        log.push({ ev, payload: p });
        if (ev === 'doc.open') mirrors.set(p.doc as number, new DocMirror(p.doc as number, p.text as string, p.version as number));
        else if (ev === 'doc.reset') mirrors.get(p.doc as number)?.reset(p.text as string, p.version as number);
        else if (ev === 'doc.active') active = p.doc as number;
        else if (ev === 'doc.saved') mirrors.get(p.doc as number)?.savedAt(p.version as number);
    });
    client.on('doc.replace', p => {
        const mirror = mirrors.get(p.doc as number)!;
        // A conflict the test asks for, as if the text had changed where the write goes.
        if (refuse.replaces > 0) { refuse.replaces--; throw new RequestError('conflict', 'text changed', { version: mirror.version }); }
        const result = mirror.replace(p.base as number, p.changes as never);
        if (!result.ok) throw new RequestError('conflict', 'text changed', { version: result.version });
        return result;
    });
    client.on('ask.file', () => ({ path: chosen.path }));
    // The answers a test gives to other questions of the core, by op.
    const answers: Record<string, Record<string, unknown>> = {};
    client.onOther(op => answers[op] ? () => answers[op] : null);
    client.on('doc.close', p => { mirrors.delete(p.doc as number); void p; });
    client.on('doc.resync', p => mirrors.get(p.doc as number)!.snapshot(0));
    return {
        client, mirrors, log, answers,
        get active() { return mirrors.get(active)!; },
        type(mirror: DocMirror, text: string) {
            const edit = mirror.typed(text);
            if (edit) client.notify('doc.edit', { ...edit });
        },
        last: (ev: string) => log.filter(l => l.ev === ev).at(-1)?.payload,
    };
}

export async function protocolTests(): Promise<void> {
    section('App protocol (no window)');

    await test('changes in code points apply and diff back, emoji included', () => {
        const next = lcg(7);
        for (let i = 0; i < 400; i++) {
            const before = randomText(next), after = randomText(next);
            const changes = diffChanges(before, after);
            eq(applyChanges(before, changes), after, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
            ok(changes.length <= 1, 'one change');
        }
        eq(diffChanges('a🎉b', 'a🎊b'), [{ from: 1, to: 2, insert: '🎊' }], 'a surrogate pair is never cut in two');
    });

    await test('headings are found outside code fences', () => {
        eq(headingsOf('# One\n\n```\n# not\n```\n## Two ##\ntext'), [{ level: 1, text: 'One', line: 0 }, { level: 2, text: 'Two', line: 5 }]);
    });

    await test('one doc.replace is in flight; the next is computed against the replica once it landed', async () => {
        const wire = scriptedWire();
        const editor = new ProtocolEditor(1, wire);
        editor.setText('ab');
        const version = editor.version;
        editor.update(t => t + 'c');
        editor.update(t => t + 'd');
        eq(wire.sent.length, 1, 'the second write waits');
        eq([wire.sent[0].op, wire.sent[0].payload.base], ['doc.replace', version]);
        eq(editor.getText(), 'ab', 'the replica changes only when the frontend has applied it');
        wire.sent[0].answer({ ok: true, version: version + 1, applied: wire.sent[0].payload.changes });
        await until(() => wire.sent.length === 2);
        eq(editor.getText(), 'abc');
        eq(wire.sent[1].payload.changes, [{ from: 3, to: 3, insert: 'd' }], 'computed from "abc"');
        wire.sent[1].answer({ ok: true, version: version + 2, applied: wire.sent[1].payload.changes });
        await until(() => editor.getText() === 'abcd');
        eq(editor.isModified(), true);
    });

    await test('a conflict makes an update compute again, and a whole-text write fail instead of undoing the typing', async () => {
        const wire = scriptedWire();
        const editor = new ProtocolEditor(1, wire);
        const failures: string[] = [];
        editor.onFailed = m => failures.push(m);
        editor.setText('ab');
        editor.update(t => t + '!');
        wire.sent[0].answer({ ok: false, error: { code: 'conflict', message: 'text changed' }, version: 9 });
        await until(() => wire.sent.length === 2);
        eq(wire.sent[1].payload.changes, [{ from: 2, to: 2, insert: '!' }], 'the update was tried again');
        wire.sent[1].answer({ ok: false, error: { code: 'conflict', message: 'text changed' }, version: 9 });
        await until(() => wire.sent.length === 3);
        wire.sent[2].answer({ ok: false, error: { code: 'conflict', message: 'text changed' }, version: 9 });
        await until(() => failures.length === 1);
        eq(wire.sent.length, 3, 'three tries, then it stops');
        editor.replaceText('zz');
        wire.sent[3].answer({ ok: false, error: { code: 'conflict', message: 'text changed' }, version: 9 });
        await until(() => failures.length === 2);
        eq(wire.sent.length, 4, 'a whole text is not computed again');
    });

    await test('edits from the frontend keep their order: a stale one is dropped and a gap asks for the text', async () => {
        const wire = scriptedWire();
        const editor = new ProtocolEditor(1, wire);
        editor.setText('ab');
        const v = editor.version;
        editor.receiveEdit(v + 1, true, [{ from: 2, to: 2, insert: 'c' }]);
        editor.receiveEdit(v + 1, true, [{ from: 2, to: 2, insert: 'X' }]);
        eq(editor.getText(), 'abc', 'a version already seen is ignored');
        editor.receiveEdit(v + 3, true, [{ from: 0, to: 0, insert: 'Z' }]);
        eq(wire.sent.map(s => s.op), ['doc.resync']);
        wire.sent[0].answer({ ok: true, version: v + 5, text: 'frontend text', modified: true, cursor: 3 });
        await until(() => editor.getText() === 'frontend text');
        eq([editor.version, editor.cursorOffset], [v + 5, 3]);
    });

    await test('a change from the core moves over the edits made since its base, and is refused when it touches them', () => {
        const mirror = new DocMirror(1, 'one two three', 5);
        mirror.typed('ONE one two three');                       // 4 characters inserted at the start (version 6)
        const moved = mirror.replace(5, [{ from: 4, to: 7, insert: '2' }]);   // "two" → "2", computed before the typing
        eq(moved, { ok: true, version: 7, applied: [{ from: 8, to: 11, insert: '2' }] }, 'shifted by what was typed before it');
        eq(mirror.text, 'ONE one 2 three');
        mirror.typed('ONE one 2 three!');                        // version 8, after the end
        eq(mirror.replace(7, [{ from: 0, to: 3, insert: 'x' }]), { ok: true, version: 9, applied: [{ from: 0, to: 3, insert: 'x' }] }, 'edits after it do not move it');

        const touching = new DocMirror(2, 'abc def', 0);
        touching.typed('abcX def');                              // an insertion at 3
        eq(touching.replace(0, [{ from: 3, to: 4, insert: '_' }]).ok, false, 'adjacent counts as touching');
        eq(touching.replace(0, [{ from: 0, to: 3, insert: 'z' }]).ok, false, 'so does overlapping');
        eq(touching.text, 'abcX def', 'a refused change leaves the text alone');
        eq(touching.replace(0, [{ from: 5, to: 6, insert: 'E' }, { from: 0, to: 1, insert: 'A' }]).ok, false, 'a batch is not rebased');

        const forgot = new DocMirror(3, 'abc', 4);
        forgot.reset('abc', 9);
        forgot.typed('abc!');
        eq(forgot.replace(8, [{ from: 0, to: 1, insert: 'A' }]).ok, false, 'edits before a reset are not known');
        const emoji = new DocMirror(4, 'a🎉b c', 0);
        emoji.typed('a🎉🎉b c');
        eq(emoji.replace(0, [{ from: 4, to: 5, insert: 'C' }]), { ok: true, version: 2, applied: [{ from: 5, to: 6, insert: 'C' }] }, 'in code points');
    });


    // Two Connections that deliver in order but never at once, as the MessagePort does.
    const pair = () => {
        let core: Connection | null = null, front: Connection | null = null;
        const posted: Message[] = [];
        core = new Connection(m => { posted.push(m); void Promise.resolve().then(() => front!.receive(m)); }, 'c');
        front = new Connection(m => { void Promise.resolve().then(() => core!.receive(m)); }, 'f');
        return { core, front, posted };
    };

    await test('a withdrawn ask is answered "cancelled" at once, the dialog is told to close, and its late answer is dropped', async () => {
        const { core, front, posted } = pair();
        let closed = false, answer: (v: Record<string, unknown>) => void = () => {};
        front.on('ask.question', (_p, cancel) => {
            cancel.onCancel(() => { closed = true; });
            return new Promise(resolve => { answer = resolve; });
        });
        const cancel = new Cancellable();
        const asked = new Asks(core).question('ask.question', { message: 'Merge?', detail: '', accept: 'Merge' }, cancel);
        await pause(5);
        cancel.cancel();
        eq(await asked, false, 'a withdrawn question counts as no');
        await until(() => closed);
        answer({ answer: true });
        await pause(5);
        eq(posted.filter(m => 'ev' in m && m.ev === 'ask.cancel').length, 1, 'one ask.cancel');
        ok(!posted.some(m => 're' in m), 'the frontend sent no answer after the cancel');
    });

    await test('a question the frontend does not know is a "no"; its generic dialog answers any Question or Prompt', async () => {
        const { core, front } = pair();
        const asks = new Asks(core);
        eq(await asks.question('ask.review.merge', { message: 'Merge?', detail: '', accept: 'Merge' }), false, 'unknown_op is no');
        eq(await asks.text('ask.capture', { title: 'Add', label: 'Text' }), null, 'unknown_op is dismissed');
        front.onOther(op => op.startsWith('ask.') ? p => (p.question ? { answer: true } : { text: `typed for ${op}` }) : null);
        eq(await asks.question('ask.review.merge', { message: 'Merge?', detail: '', accept: 'Merge' }), true);
        eq(await asks.text('ask.capture', { title: 'Add', label: 'Text' }), 'typed for ask.capture');
        eq(await asks.choice('ask.saveChanges', {}, ['save', 'discard', 'cancel'], 'cancel'), 'cancel', 'an answer of the wrong shape is the dismissal');
    });

    await test('hello carries the command table and the settings; a setting changes from either side', async () => {
        const post = { toClient: (_m: Message) => {} };
        const settings = memorySettings();
        settings.sidebar = true;
        const server = new ProtocolServer(settings, m => post.toClient(m), { settingKeys: ['sidebar', 'color-scheme'] });
        const ui = attach(server, post);
        const hello = await ui.client.request('hello', { proto: 1 });
        ok(hello.ok, 'hello');
        const commands = hello.commands as { id: string; runs: string; keys: string[] }[];
        eq(commands.find(c => c.id === 'save')?.runs, 'core');
        eq(commands.find(c => c.id === 'bold')?.runs, 'editor');
        eq(commands.find(c => c.id === 'save')?.keys, ['Ctrl+s']);
        eq((hello.settings as Record<string, unknown>).sidebar, true);
        ui.client.notify('setting', { key: 'sidebar', value: false });
        await until(() => settings.sidebar === false);
        settings.dark = true;
        await until(() => ui.last('setting')?.key === 'color-scheme');
        eq(ui.last('setting'), { key: 'color-scheme', value: 'dark' });
        ui.client.notify('setting', { key: 'chat', value: true });
        await until(() => ui.last('error') !== undefined);
        ok(settings.chat !== true, 'a key outside the schema is refused');
        server.dispose();
    });

    const dir = disk.join(tmp, 'protocol');
    disk.mkdirs(dir);
    disk.write(disk.join(dir, 'board.md'), BOARD);
    disk.write(disk.join(dir, 'note.md'), '# Note\n\nhello\n');

    const start = async () => {
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(memorySettings(), m => post.toClient(m));
        const ui = attach(server, post);
        const hello = await ui.client.request('hello', { proto: 1 });
        ok(hello.ok, 'hello');
        await ui.client.request('start', { path: dir });
        await until(() => ui.last('view.files') !== undefined);
        return { server, ui };
    };

    await test('the core lists the folder, opens a file, and the frontend\'s typing reaches the replica and the disk', async () => {
        const { server, ui } = await start();
        eq((ui.last('view.files')!.files as string[]).sort(), ['board.md', 'note.md']);
        ok((await ui.client.request('open.file', { name: 'note.md' })).ok, 'open.file');
        await until(() => ui.active?.text === '# Note\n\nhello\n');
        eq((ui.last('doc.title')!.title as { name: string }).name, 'note.md');
        ui.type(ui.active, '# Note\n\nhello world\n');
        ok((await ui.client.request('command', { name: 'save' })).ok, 'save');
        eq(disk.read(disk.join(dir, 'note.md')), '# Note\n\nhello world\n', 'the edit sent before the command is in the file');
        await until(() => !ui.active.modified);
        server.dispose();
    });

    await test('a folder chosen in the frontend\'s dialog opens: the core lists it and the frontend can open its files', async () => {
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(memorySettings(), m => post.toClient(m));
        const ui = attach(server, post);
        await ui.client.request('hello', { proto: 1 });
        await ui.client.request('start', { path: null });
        const reply = await ui.client.request('open.folder', { path: dir });
        ok(reply.ok, `open.folder: ${reply.ok ? '' : reply.error.message}`);
        await until(() => ui.last('view.files') !== undefined);
        eq((ui.last('view.files')!.files as string[]).sort(), ['board.md', 'note.md']);
        ok((await ui.client.request('open.file', { name: 'note.md' })).ok, 'open.file');
        server.dispose();
    });

    await test('switching to another folder lists that folder and closes tabs of the first', async () => {
        const other = disk.join(tmp, 'protocol-other');
        disk.mkdirs(other);
        disk.write(disk.join(other, 'x.md'), '# X\n');
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.active?.text.startsWith('# Note') === true);
        const reply = await ui.client.request('open.folder', { path: other });
        ok(reply.ok, `open.folder: ${reply.ok ? '' : reply.error.message}`);
        await until(() => (ui.last('view.files')!.root as string) === other);
        eq(ui.last('view.files')!.files, ['x.md']);
        server.dispose();
    });

    await test('the Open Folder command asks the frontend for a folder and the file list follows', async () => {
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(memorySettings(), m => post.toClient(m));
        const chosen = { path: dir as string | null };
        const ui = attach(server, post, chosen);
        await ui.client.request('hello', { proto: 1 });
        await ui.client.request('start', { path: null });
        ok((await ui.client.request('command', { name: 'open-folder' })).ok, 'command');
        await until(() => ui.last('view.files') !== undefined);
        eq((ui.last('view.files')!.files as string[]).sort(), ['board.md', 'note.md']);
        server.dispose();
    });

    await test('a file outside the work folder is refused', async () => {
        const { server, ui } = await start();
        const reply = await ui.client.request('open.file', { name: '../outside.md' });
        ok(!reply.ok && reply.error.code === 'bad_request', 'refused');
        server.dispose();
    });

    await test('ask.notes lists the notes a [[ may link to, and open.note follows a link into a tab', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.active?.text.startsWith('# Note') === true);
        const doc = ui.active.id;
        const names = await ui.client.request('ask.notes', { doc });
        ok(names.ok, 'answered');
        eq((names.names as string[]).sort(), ['board.md', 'note.md']);
        eq((await ui.client.request('ask.notes', { doc: 9999 })).names, [], 'an unknown document has no names');
        ok((await ui.client.request('open.note', { doc, link: 'board' })).ok, 'open.note');
        await until(() => ui.active?.text.includes('layout: board') === true);
        const gone = await ui.client.request('open.note', { doc: 9999, link: 'board' });
        ok(!gone.ok && gone.error.code === 'stale', 'a closed document is stale');
        server.dispose();
    });

    await test('an image chosen in the Files tab is shown by the frontend (view.image)', async () => {
        const { server, ui } = await start();
        const png = disk.join(dir, 'pic.png');
        disk.write(png, 'not really a png');
        ok((await ui.client.request('open.file', { name: 'pic.png' })).ok, 'open.file');
        await until(() => ui.last('view.image') !== undefined);
        eq(ui.last('view.image'), { path: png });
        server.dispose();
    });

    await test('open.link opens a relative Markdown link in a tab, and a closed document is stale', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.active?.text.startsWith('# Note') === true);
        const doc = ui.active.id;
        ok((await ui.client.request('open.link', { doc, url: 'board.md' })).ok, 'open.link');
        await until(() => ui.active?.text.includes('layout: board') === true);
        const gone = await ui.client.request('open.link', { doc: 9999, url: 'board.md' });
        ok(!gone.ok && gone.error.code === 'stale', 'stale');
        server.dispose();
    });

    await test('the outline lists the headings of the active document, and a jump reveals the line', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.last('view.outline') !== undefined);
        eq(ui.last('view.outline'), { headings: [{ level: 1, text: 'Note', line: 0 }] });
        ok((await ui.client.request('act.outline.jump', { index: 0 })).ok, 'act.outline.jump');
        await until(() => ui.last('doc.reveal') !== undefined);
        eq(ui.last('doc.reveal')!.line, 0);
        server.dispose();
    });

    await test('a search sends the results, a hit opens with its match selected, and Replace All asks first', async () => {
        const { server, ui } = await start();
        const query = { text: 'Note', include: '', exclude: '', caseSensitive: true, wholeWord: false, regex: false };
        ok((await ui.client.request('act.search.run', { query })).ok, 'act.search.run');
        await until(() => ui.last('view.search') !== undefined);
        const results = ui.last('view.search')!.results as { total: number; files: { file: string; hits: { line: number }[] }[] };
        eq(results.files.map(f => f.file), ['note.md']);
        eq(results.total, 1);
        ok((await ui.client.request('act.search.openHit', { file: 'note.md', index: 0 })).ok, 'act.search.openHit');
        await until(() => ui.active?.text.startsWith('# Note') === true);
        // Replace All is asked about; "no" leaves the files alone.
        ui.answers['ask.search.confirm'] = { answer: false };
        ok((await ui.client.request('act.search.replaceAll', { replacement: 'Page' })).ok, 'act.search.replaceAll');
        ok(ui.active.text.startsWith('# Note'), 'refused: unchanged');
        ui.answers['ask.search.confirm'] = { answer: true };
        await ui.client.request('act.search.replaceAll', { replacement: 'Page' });
        await until(() => ui.active.text.startsWith('# Page'));
        server.dispose();
    });

    await test('the Files tab: the root and a folder come as view.tree.*, and create, rename, and move change the disk', async () => {
        const { server, ui } = await start();
        await until(() => ui.last('view.tree.root') !== undefined);
        const root = ui.last('view.tree.root')!.root as string;
        eq((ui.last('view.tree.root')!.entries as { name: string }[]).map(e => e.name).sort(), ['board.md', 'note.md', 'pic.png'], 'images show in the tree too');
        // A new folder, asked for by name.
        ui.answers['ask.files.name'] = { text: 'sub' };
        const made = await ui.client.request('act.tree.create', { kind: 'folder', dir: root });
        ok(made.ok && made.path === disk.join(root, 'sub'), 'folder made');
        ok(disk.exists(disk.join(root, 'sub')), 'on disk');
        ok((await ui.client.request('act.tree.openFolder', { dir: disk.join(root, 'sub') })).ok, 'openFolder');
        await until(() => ui.last('view.tree.folder')?.dir === disk.join(root, 'sub'));
        // A new file in it, then renamed, then moved up to the root.
        ui.answers['ask.files.name'] = { text: 'idea' };
        const file = await ui.client.request('act.tree.create', { kind: 'file', dir: disk.join(root, 'sub') });
        ok(file.ok && disk.exists(disk.join(root, 'sub', 'idea.md')), 'file made');
        ui.answers['ask.files.name'] = { text: 'plan' };
        const renamed = await ui.client.request('act.tree.rename', { path: disk.join(root, 'sub', 'idea.md') });
        ok(renamed.ok && disk.exists(disk.join(root, 'sub', 'plan.md')), 'renamed');
        const moved = await ui.client.request('act.tree.move', { source: disk.join(root, 'sub', 'plan.md'), dir: root });
        ok(moved.ok && moved.moved === true && disk.exists(disk.join(root, 'plan.md')), 'moved');
        // A path outside the folder is refused.
        const outside = await ui.client.request('act.tree.rename', { path: disk.join(tmp, 'elsewhere.md') });
        ok(!outside.ok && outside.error.code === 'bad_request', 'refused');
        server.dispose();
    });

    await test('Home and an HTML file are tabs of their own: page.open, view.home, view.page, page.close', async () => {
        const { server, ui } = await start();
        ok((await ui.client.request('command', { name: 'home' })).ok, 'home');
        await until(() => ui.last('view.home') !== undefined);
        const opened = ui.last('page.open')!;
        eq(opened.kind, 'home');
        const data = ui.last('view.home')!.data as { workspace: string | null; recent: unknown[] };
        eq(data.workspace, dir);
        eq(ui.last('page.active'), { page: opened.page });
        // An HTML file of the folder opens in its own tab.
        disk.write(disk.join(dir, 'page.html'), '<h1>hi</h1>');
        ok((await ui.client.request('open.file', { name: 'page.html' })).ok, 'open.file');
        await until(() => ui.log.filter(l => l.ev === 'page.open').length === 2);
        const html = ui.last('page.open')!;
        eq([html.kind, html.file, html.root], ['html', disk.join(dir, 'page.html'), dir]);
        await until(() => ui.last('view.page')?.page === 'html');
        // Closing a page tab closes it.
        const closed = await ui.client.request('tab.close', { doc: html.page });
        ok(closed.ok && closed.closed === true, 'tab.close');
        await until(() => ui.last('page.close')?.page === html.page);
        server.dispose();
    });

    await test('the Programs page is a tab of its own: view.programs, programs.missing, and Check again', async () => {
        const { server, ui } = await start();
        ok((await ui.client.request('act.programs.open', {})).ok, 'act.programs.open');
        await until(() => ui.last('page.open')?.kind === 'programs');
        // The check runs real lookups on this computer; whatever it finds, it ends with every program named once.
        await until(() => (ui.last('view.programs')?.data as { checking: boolean } | undefined)?.checking === false, 15000);
        const data = ui.last('view.programs')!.data as { machine: string; programs: { name: string; needed: boolean }[] };
        eq(data.machine, '');
        eq(data.programs.map(p => [p.name, p.needed]), [['git', true], ['pi', true], ['markworkd', false]]);
        ok(typeof ui.last('programs.missing')?.count === 'number', 'the sidebar mark');
        const before = ui.log.filter(l => l.ev === 'view.programs').length;
        ok((await ui.client.request('act.programs.check', {})).ok, 'act.programs.check');
        await until(() => ui.log.filter(l => l.ev === 'view.programs').length > before);
        const bad = await ui.client.request('act.programs.openTerminal', { machine: 7 });
        ok(!bad.ok && bad.error.code === 'bad_request', 'a machine that is not a name');
        server.dispose();
    });

    await test('Preferences: the command opens the dialog with the values, a change is written and sent again, a wrong one is refused', async () => {
        const { server, ui } = await start();
        ok((await ui.client.request('command', { name: 'preferences' })).ok, 'preferences');
        await until(() => ui.last('view.prefs.open') !== undefined);
        const first = ui.last('view.prefs.open')!.data as { autosave: boolean; colorScheme: string };
        ok((await ui.client.request('act.prefs.set', { key: 'autosave', value: !first.autosave })).ok, 'act.prefs.set');
        await until(() => (ui.last('view.prefs.values')?.data as { autosave: boolean } | undefined)?.autosave === !first.autosave);
        ok((await ui.client.request('act.prefs.set', { key: 'colorScheme', value: 'dark' })).ok, 'colorScheme');
        await until(() => (ui.last('view.prefs.values')?.data as { colorScheme: string }).colorScheme === 'dark');
        const bad = await ui.client.request('act.prefs.set', { key: 'chatModel', value: 'no-such-model' });
        ok(!bad.ok && bad.error.code === 'bad_request', 'a value the key does not take');
        ok((await ui.client.request('act.prefs.closed', {})).ok, 'closed');
        server.dispose();
    });

    await test('the Recent list of the menus is sent when files are opened', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.last('recent') !== undefined);
        ok((ui.last('recent')!.paths as string[]).some(p => p.endsWith('note.md')), 'note.md is recent');
        server.dispose();
    });

    await test('app.close lets a window with nothing unsaved go', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.active?.text.startsWith('# Note') === true);
        const reply = await ui.client.request('app.close', {});
        ok(reply.ok && reply.allowed === true, 'allowed');
        server.dispose();
    });

    await test('a card moved in the board view is written through doc.replace and shown again', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => ui.last('view.notes') !== undefined);
        eq(ui.last('view.page'), { page: 'board', doc: ui.active.id });
        const shown = ui.last('view.notes')!.board as ReturnType<typeof parseBoard>;
        eq(shown.columns.map(c => c.cards.length), [2, 1]);
        const before = ui.log.filter(l => l.ev === 'view.notes').length;
        const reply = await ui.client.request('act.notes.edit', { edit: { kind: 'move', at: { column: 0, index: 0 }, card: 'One', to: { column: 1, index: 0 } } });
        ok(reply.ok, 'edit');
        await until(() => ui.active.text.includes('## Done\n\n- [ ] One'));
        eq(parseBoard(ui.active.text).columns.map(c => c.cards.map(k => k.text)), [['Two'], ['One', 'Old']]);
        eq(server.frontend.editors.get(ui.active.id)!.getText(), ui.active.text, 'replica and editor agree');
        ok(ui.log.filter(l => l.ev === 'view.notes').length >= before, 'the board is shown');
        server.dispose();
    });

    await test('a drag of a card that is gone is stale: nothing is written and the board is drawn again', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => ui.last('view.notes') !== undefined);
        const text = ui.active.text, shown = ui.log.filter(l => l.ev === 'view.notes').length;
        await ui.client.request('act.notes.edit', { edit: { kind: 'move', at: { column: 0, index: 0 }, card: 'Nobody', to: { column: 1, index: 0 } } });
        await until(() => ui.log.filter(l => l.ev === 'view.notes').length > shown);
        await pause(20);
        eq(ui.active.text, text, 'the text is untouched');
        server.dispose();
    });

    await test('typing that does not touch a board write is kept: the write moves over it', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => ui.last('view.notes') !== undefined);
        const mirror = ui.active;
        // The user types at the end in the same turn the board's write is on its way.
        const replied = ui.client.request('act.notes.edit', { edit: { kind: 'toggle', at: { column: 0, index: 1 }, card: 'Two' } });
        ui.type(mirror, mirror.text + 'tail\n');
        await replied;
        await until(() => ui.active.text.includes('- [x] Two'));
        ok(ui.active.text.endsWith('tail\n'), 'the typed text is still there');
        eq(ui.log.filter(l => l.ev === 'toast').length, 0, 'nothing was refused');
        await until(() => server.frontend.editors.get(mirror.id)!.getText() === mirror.text);
        server.dispose();
    });

    await test('typing where a board write changes is kept and the write is refused and reported', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => ui.last('view.notes') !== undefined);
        const mirror = ui.active;
        const replied = ui.client.request('act.notes.edit', { edit: { kind: 'toggle', at: { column: 0, index: 1 }, card: 'Two' } });
        ui.type(mirror, mirror.text.replace('- [ ] Two', '- [Y ] Two'));
        await replied;
        await until(() => ui.last('toast') !== undefined);
        ok(ui.active.text.includes('- [Y ] Two'), 'the typed text is still there');
        ok(!ui.active.text.includes('- [x] Two'), 'the card was not toggled over the typing');
        eq(server.frontend.editors.get(mirror.id)!.getText(), mirror.text, 'replica and editor agree');
        server.dispose();
    });
    await test('a board write refused by the frontend is made again on the text as it is then: the typing and the card both stay', async () => {
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(memorySettings(), m => post.toClient(m));
        const refuse = { replaces: 0 };
        const ui = attach(server, post, { path: null }, refuse);
        await ui.client.request('hello', { proto: 1 });
        await ui.client.request('start', { path: dir });
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => ui.last('view.notes') !== undefined);
        const mirror = ui.active;
        // A card typed above the one being toggled moves it; the first write is refused, so the core makes it again.
        refuse.replaces = 1;
        ui.type(mirror, mirror.text.replace('- [ ] One\n', '- [ ] One\n- [ ] Typed\n'));
        await ui.client.request('act.notes.edit', { edit: { kind: 'toggle', at: { column: 0, index: 1 }, card: 'Two' } });
        await until(() => ui.active.text.includes('- [x] Two'));
        ok(ui.active.text.includes('- [ ] Typed\n- [x] Two'), 'the typed card is kept and the right card is toggled');
        eq(ui.log.filter(l => l.ev === 'toast').length, 0, 'nothing was refused');
        await until(() => server.frontend.editors.get(mirror.id)!.getText() === mirror.text);
        server.dispose();
    });

    await test('the screen follows the page: counts, the layout button, and which commands apply, each sent when it changes', async () => {
        const { server, ui } = await start();
        await ui.client.request('open.file', { name: 'note.md' });
        await until(() => ui.last('view.layout') !== undefined);
        eq(ui.last('view.status'), { visible: true, counts: { kind: 'text' } });
        eq(ui.last('view.layout'), { layout: '', structured: false });
        await until(() => ui.last('commands.state') !== undefined);
        ok(!(ui.last('commands.state')!.disabled as string[]).includes('bold'), 'text commands apply to text');
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => (ui.last('view.layout')?.structured) === true);
        eq(ui.last('view.layout'), { layout: 'board', structured: true });
        eq(ui.last('view.status'), { visible: true, counts: { kind: 'board', lists: 2, cards: 3 } });
        await until(() => (ui.last('commands.state')!.disabled as string[]).includes('bold'));
        ok(!(ui.last('commands.state')!.disabled as string[]).includes('fields-edit'), 'board commands apply to a board');
        const sent = ui.log.filter(l => l.ev === 'view.layout').length;
        await ui.client.request('command', { name: 'save' });
        await pause(10);
        eq(ui.log.filter(l => l.ev === 'view.layout').length, sent, 'nothing is sent again when nothing changed');
        server.dispose();
    });

    await test('Save As asks the frontend for a path and writes the new document there', async () => {
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(memorySettings(), m => post.toClient(m));
        const target = disk.join(dir, 'saved-as');
        const chosen = { path: target as string | null };
        const ui = attach(server, post, chosen);
        await ui.client.request('hello', { proto: 1 });
        await ui.client.request('start', { path: dir });
        await ui.client.request('command', { name: 'new' });
        await until(() => ui.active !== undefined);
        ui.type(ui.active, '# Saved as\n');
        ok((await ui.client.request('command', { name: 'save-as' })).ok, 'save-as');
        await until(() => disk.exists(`${target}.md`));
        eq(disk.read(`${target}.md`), '# Saved as\n', 'the extension is added and the text written');
        eq((ui.last('doc.title')!.title as { name: string }).name, 'saved-as.md');
        server.dispose();
    });
    // ---------- The structured pages: list, table, the layouts, Fields…, and the CSV tab ----------

    const pages = disk.join(tmp, 'protocol-pages');
    disk.mkdirs(pages);
    disk.write(disk.join(pages, 'list.md'), '---\nlayout: list\nadd: top\nfields:\n  created: date = now\n---\n\n# Inbox\n\n- First idea #idea\n- Second\n');
    disk.write(disk.join(pages, 'table.md'), '---\nlayout: table\nfields:\n  status: select(todo:gray, done:green) = todo\n---\n\n# Table\n\n- One [status:: todo]\n- Two [status:: done]\n');
    disk.write(disk.join(pages, 'cal.md'), '---\nlayout: calendar\nfields:\n  due: date\n---\n\n- Release [due:: 2026-10-20]\n- Undated\n');
    disk.write(disk.join(pages, 'line.md'), '---\nlayout: timeline\nfields:\n  start: date\n  due: date\n---\n\n- Build [start:: 2026-10-05] [due:: 2026-10-09]\n');
    disk.write(disk.join(pages, 'chart.md'), '---\nlayout: chart\nfields:\n  status: select(todo, done)\n---\n\n- A [status:: todo]\n- B [status:: done]\n');
    disk.write(disk.join(pages, 'board.md'), BOARD);
    disk.write(disk.join(pages, 'sheet.csv'), 'name,qty\nada,3\nlin,5\n');

    const startPages = async () => {
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(memorySettings(), m => post.toClient(m));
        const ui = attach(server, post);
        await ui.client.request('hello', { proto: 1 });
        await ui.client.request('start', { path: pages });
        await until(() => ui.last('view.files') !== undefined);
        return { server, ui };
    };
    const shownPage = (ui: ReturnType<typeof attach>) => ui.last('view.page')?.page;

    await test('a list, a table, and the layouts are shown as their own pages with the notes of the document', async () => {
        const { server, ui } = await startPages();
        for (const [name, page] of [['list.md', 'inbox'], ['table.md', 'table'], ['cal.md', 'calendar'], ['line.md', 'timeline'], ['chart.md', 'chart']]) {
            await ui.client.request('open.file', { name });
            await until(() => shownPage(ui) === page);
            const notes = ui.last('view.notes')!;
            eq(notes.page, page, `${name} sends its notes for the ${page} page`);
            ok(parseBoard(ui.active.text).columns.length > 0 && (notes.board as ReturnType<typeof parseBoard>).columns.length > 0, 'the board arrives');
        }
        server.dispose();
    });

    await test('a note captured in the list, a date given in the calendar, and a bar moved in the timeline are written to the text', async () => {
        const { server, ui } = await startPages();
        await ui.client.request('open.file', { name: 'list.md' });
        await until(() => shownPage(ui) === 'inbox');
        ok((await ui.client.request('act.notes.edit', { edit: { kind: 'capture', text: 'Third #new', notes: [], now: Date.UTC(2026, 9, 19, 8, 30) } })).ok, 'capture');
        await until(() => ui.active.text.includes('Third #new'));
        ok(/- Third #new \[created:: 2026-10-19 \d\d:\d\d\]/.test(ui.active.text), 'the capture time is the default of the field');
        await ui.client.request('open.file', { name: 'cal.md' });
        await until(() => shownPage(ui) === 'calendar');
        ok((await ui.client.request('act.notes.edit', { edit: { kind: 'date', at: { column: 0, index: 1 }, card: 'Undated', date: '2026-10-22' } })).ok, 'date');
        await until(() => ui.active.text.includes('Undated [due:: 2026-10-22]'));
        await ui.client.request('open.file', { name: 'line.md' });
        await until(() => shownPage(ui) === 'timeline');
        await ui.client.request('act.notes.edit', { edit: { kind: 'shift', at: { column: 0, index: 0 }, card: 'Build [start:: 2026-10-05] [due:: 2026-10-09]', days: 2 } });
        await until(() => ui.active.text.includes('[start:: 2026-10-07] [due:: 2026-10-11]'));
        server.dispose();
    });

    await test('a list opened after a board takes its own text, and a capture lands in the list', async () => {
        const { server, ui } = await startPages();
        await ui.client.request('act.tree.activate', { path: disk.join(pages, 'board.md') });
        await until(() => shownPage(ui) === 'board');
        await ui.client.request('act.tree.activate', { path: disk.join(pages, 'list.md') });
        await until(() => shownPage(ui) === 'inbox');
        const doc = ui.active.id;
        await ui.client.request('act.notes.edit', { edit: { kind: 'capture', text: 'Fresh', notes: [], now: Date.now() } });
        await until(() => ui.active.text.includes('Fresh'));
        eq(ui.active.id, doc);
        ok(ui.active.text.includes('layout: list') && ui.active.text.includes('First idea'), 'the list text, not the table\'s');
        server.dispose();
    });

    await test('the panels of a chart are written to its frontmatter', async () => {
        const { server, ui } = await startPages();
        await ui.client.request('open.file', { name: 'chart.md' });
        await until(() => shownPage(ui) === 'chart');
        await ui.client.request('act.notes.edit', { edit: { kind: 'charts', items: [{ kind: 'donut', field: 'status' }, { kind: 'kpi' }] } });
        await until(() => ui.active.text.includes('charts: [donut:status, kpi]'));
        server.dispose();
    });

    await test('the layout command writes the layout into the frontmatter and the page follows', async () => {
        const { server, ui } = await startPages();
        await ui.client.request('open.file', { name: 'table.md' });
        await until(() => shownPage(ui) === 'table');
        await ui.client.request('command', { name: 'layout', arg: 'gallery' });
        await until(() => shownPage(ui) === 'gallery');
        ok(ui.active.text.includes('layout: gallery'), 'written');
        await ui.client.request('command', { name: 'layout', arg: '' });
        await until(() => shownPage(ui) === 'text');
        server.dispose();
    });

    await test('Fields… asks the frontend (ask.schema) with the fields and how many notes use each option, and writes the answer', async () => {
        const { server, ui } = await start();
        const asked: Record<string, unknown>[] = [];
        ui.client.on('ask.schema', p => { asked.push(p); return { fields: [{ key: 'status', type: 'select', multiple: false, options: ['todo', 'doing', 'done'], colors: { doing: 'blue' } }] }; });
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => shownPage(ui) === 'board');
        ok((await ui.client.request('command', { name: 'fields-edit' })).ok, 'command');
        await until(() => ui.active.text.includes('status: select(todo, doing:blue, done)'));
        eq(asked.length, 1);
        eq(asked[0].reserved, ['due', 'agent'], 'a board uses due and agent itself');
        eq(asked[0].fields, [], 'the board declares no fields yet');
        server.dispose();
    });

    await test('Fields… answered with nothing (Cancel) changes nothing', async () => {
        const { server, ui } = await start();
        ui.client.on('ask.schema', () => ({}));
        await ui.client.request('open.file', { name: 'board.md' });
        await until(() => shownPage(ui) === 'board');
        const text = ui.active.text;
        await ui.client.request('command', { name: 'fields-edit' });
        await pause(30);
        eq(ui.active.text, text);
        server.dispose();
    });

    await test('a CSV file is a tab: view.csv sends the text, act.csv.change writes it, and the counts follow act.csv.shape', async () => {
        const { server, ui } = await startPages();
        ok((await ui.client.request('act.tree.activate', { path: disk.join(pages, 'sheet.csv') })).ok, 'a CSV file opens from the Files tab');
        await until(() => shownPage(ui) === 'csv');
        eq(ui.last('view.csv')!.text, 'name,qty\nada,3\nlin,5\n');
        eq(ui.last('view.status'), { visible: true, counts: { kind: 'csv', rows: 2, columns: 2 } });
        ok((await ui.client.request('act.csv.change', { doc: ui.active.id, text: 'name,qty\nada,3\nlin,5\nmo,9\n' })).ok, 'change');
        await until(() => ui.active.text.endsWith('mo,9\n'));
        ok((await ui.client.request('act.csv.shape', { rows: 3, columns: 2 })).ok, 'shape');
        await until(() => (ui.last('view.status')?.counts as { rows: number }).rows === 3);
        server.dispose();
    });

    await test('new inbox and new table documents ask for the cursor in the capture line', async () => {
        const { server, ui } = await startPages();
        await ui.client.request('command', { name: 'inbox-new' });
        await until(() => ui.last('view.focusCapture') !== undefined);
        eq(ui.last('view.focusCapture')!.page, 'inbox');
        await ui.client.request('command', { name: 'table-new' });
        await until(() => ui.last('view.focusCapture')!.page === 'table');
        server.dispose();
    });

    // ---------- The Assistant and the journal (docs/design/electron-migrasi.md, phase 4) ----------

    const chatDir = disk.join(tmp, 'protocol-chat');
    disk.mkdirs(chatDir);
    disk.write(disk.join(chatDir, 'notes.md'), 'Release 15 November\n');
    disk.write(disk.join(chatDir, 'plan.md'), 'Ship 15 November\n');
    const KEY = { get: async () => ({ key: 'test', source: 'env' as const }), set: async () => 'keyring' as const, clear: async () => {} };

    // A model that calls one tool in its first round (when it is given one), then answers with `answer`.
    const scripted = (tool: { name: string; args: object } | null, answer: string, told: string[] = []): Provider => {
        let round = 0;
        return {
            async chat(req): Promise<ChatResult> {
                for (const m of req.messages) if (m.role === 'tool') told.push(m.content);
                if (tool && ++round === 1) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 't1', name: tool.name, arguments: JSON.stringify(tool.args) }] };
                req.onText(answer);
                return { usage: { prompt: 10, cached: 0, completion: 5 }, cancelled: false, reasoning: '', toolCalls: [] };
            },
        };
    };
    const edit = { name: 'notes', old_text: '15 November', new_text: '22 November', reason: 'the meeting moved it' };

    const startChat = async (settings = memorySettings()) => {
        const post = { toClient: (_m: Message) => {} };
        settings.chatSave = false;
        const server = new ProtocolServer(settings, m => post.toClient(m));
        const ui = attach(server, post);
        await ui.client.request('hello', { proto: 1 });
        await ui.client.request('start', { path: chatDir });
        await until(() => ui.last('view.files') !== undefined);
        await ui.client.request('open.file', { name: 'plan.md' });
        const { chat } = server.session.assistant;
        chat.keyStore = KEY;
        disk.write(disk.join(chatDir, 'notes.md'), 'Release 15 November\n');
        return { server, ui, chat, settings };
    };
    const noticesOf = (ui: ReturnType<typeof attach>, ev: string) => ui.log.filter(l => l.ev === ev).map(l => l.payload);

    await test('Add to Journal asks the frontend for a line (ask.capture) and writes it into today\'s journal', async () => {
        const { server, ui } = await startChat();
        let prompt: Record<string, unknown> | undefined;
        ui.client.on('ask.capture', p => { prompt = p.prompt as Record<string, unknown>; return { text: 'met the printer' }; });
        ok((await ui.client.request('command', { name: 'journal-capture' })).ok, 'command');
        await until(() => disk.exists(disk.join(chatDir, 'journal')) && ui.last('toast') !== undefined);
        eq(prompt?.title, 'Add to Journal');
        const today = localDate(new Date());
        ok(disk.read(disk.join(chatDir, ...journalName(today).split('/'))).includes('met the printer'), 'the note is in the journal file');
        server.dispose();
    });

    await test('Add to Journal answered with nothing (Cancel) writes nothing', async () => {
        const { server, ui } = await startChat();
        const before = ui.log.length;
        ui.client.on('ask.capture', () => ({}));
        await ui.client.request('command', { name: 'journal-capture' });
        await pause(60);
        eq(noticesOf(ui, 'toast').length, ui.log.slice(0, before).filter(l => l.ev === 'toast').length, 'no new toast');
        server.dispose();
    });

    await test('a turn is told as chat.* notices: the question, the streamed answer, the end, and busy around it', async () => {
        const { server, ui, chat } = await startChat();
        chat.makeProvider = () => scripted(null, 'Hello there');
        const sync = await ui.client.request('act.chat.sync', {});
        ok(sync.ok && (sync.settings as { model: string }).model.length > 0, 'sync gives the settings');
        ok((await ui.client.request('act.chat.send', { text: 'say hello' })).ok, 'send');
        eq(noticesOf(ui, 'chat.busy').map(p => p.busy), [true, false]);
        eq(noticesOf(ui, 'chat.turn').map(p => p.question), ['say hello']);
        eq(noticesOf(ui, 'chat.text').map(p => p.delta).join(''), 'Hello there');
        const end = noticesOf(ui, 'chat.end')[0].outcome as { cancelled: boolean; text: string; usage: { prompt: number } };
        eq([end.cancelled, end.text, end.usage.prompt], [false, 'Hello there', 10]);
        eq(noticesOf(ui, 'chat.context').length, 1, 'the context that was sent');
        await until(() => noticesOf(ui, 'chat.log').length > 0);
        const events = (noticesOf(ui, 'chat.log').flatMap(p => (p.update as { events: { kind: string }[] }).events));
        ok(events.some(e => e.kind === 'turn'), 'the agent log follows the turn');
        server.dispose();
    });

    await test('without an API key the turn asks for one (chat.noKey) and the key is saved by act.chat.key', async () => {
        const { server, ui, chat } = await startChat();
        let stored: string | null = null;
        chat.keyStore = { get: async () => stored ? { key: stored, source: 'keyring' as const } : null, set: async key => { stored = key; return 'keyring' as const; }, clear: async () => { stored = null; } };
        await ui.client.request('act.chat.send', { text: 'hi' });
        eq(noticesOf(ui, 'chat.noKey').length, 1);
        eq(noticesOf(ui, 'chat.turn').length, 0, 'no turn was started');
        eq((await ui.client.request('act.chat.key', { action: 'status' })).source, null);
        eq((await ui.client.request('act.chat.key', { action: 'save', key: ' sk-1 ' })).source, 'keyring');
        eq(stored, 'sk-1');
        eq((await ui.client.request('act.chat.key', { action: 'status' })).source, 'keyring');
        ok(!(await ui.client.request('act.chat.key', { action: 'save', key: '  ' })).ok, 'an empty key is refused');
        await ui.client.request('act.chat.key', { action: 'forget' });
        eq(stored, null);
        server.dispose();
    });

    await test('model, thinking and saving are settings of the core; the panel gets them back as chat.settings', async () => {
        const { server, ui, settings } = await startChat();
        await ui.client.request('act.chat.thinking', { thinking: true });
        await until(() => noticesOf(ui, 'chat.settings').some(p => (p.settings as { thinking: boolean }).thinking));
        eq(settings.chatThinking, true);
        await ui.client.request('act.chat.save', { save: true });
        await until(() => settings.chatSave === true);
        ok(!(await ui.client.request('act.chat.thinking', { thinking: 'yes' })).ok, 'a value of the wrong type is refused');
        await ui.client.request('act.chat.options', { options: { activeDocument: false, selection: true, project: true } });
        const preview = await ui.client.request('act.chat.preview', { draft: 'what is in @notes' });
        ok(preview.ok && Array.isArray((preview.built as { items: unknown[] }).items), 'preview');
        ok(!(preview.built as { items: { kind: string }[] }).items.some(i => i.kind === 'active'), 'the open document is not in the context after its option is off');
        server.dispose();
    });

    await test('a proposal is the ask ask.proposal: the frontend gets how it looks, asks the core to apply it, and answers with its note', async () => {
        const { server, ui, chat } = await startChat();
        const told: string[] = [];
        chat.makeProvider = () => scripted({ name: 'edit_file', args: edit }, 'done', told);
        let seen: Record<string, unknown> | undefined;
        ui.client.on('ask.proposal', async p => {
            seen = p;
            eq(disk.read(disk.join(chatDir, 'notes.md')), 'Release 15 November\n', 'nothing is written before the user decides');
            const applied = await ui.client.request('act.proposal.apply', { ask: p.ask, chosen: null });
            ok(applied.ok && applied.error === null, 'apply');
            return { note: 'thanks' };
        });
        await ui.client.request('act.chat.send', { text: 'move the release' });
        eq(disk.read(disk.join(chatDir, 'notes.md')), 'Release 22 November\n');
        const changes = seen!.changes as { kind: string; file: string; added: number; removed: number; diff: { kind: string; text: string }[]; before?: string }[];
        eq([seen!.batch, changes.length, changes[0].kind, changes[0].file, changes[0].added, changes[0].removed], [false, 1, 'edit', 'notes.md', 1, 1]);
        ok(changes[0].diff.some(l => l.kind === 'add' && l.text.includes('22 November')), 'the diff lines are sent');
        ok(!('before' in changes[0]), 'the file contents are not');
        ok(told.some(t => t.includes('thanks')), 'the agent got the note');
        // Undo names the proposal; the core writes the reverse.
        eq((await ui.client.request('act.chat.undo', { target: { ask: seen!.ask } })).error, null);
        eq(disk.read(disk.join(chatDir, 'notes.md')), 'Release 15 November\n');
        ok(!(await ui.client.request('act.chat.undo', { target: { ask: seen!.ask } })).ok || (await ui.client.request('act.chat.undo', { target: { ask: seen!.ask } })).error !== null, 'a second undo has nothing to undo');
        server.dispose();
    });

    await test('a rejected proposal writes nothing, and a stopped turn withdraws the ask so a late apply is refused', async () => {
        const { server, ui, chat } = await startChat();
        chat.makeProvider = () => scripted({ name: 'edit_file', args: edit }, 'ok');
        ui.client.on('ask.proposal', () => ({ note: 'no thanks' }));
        await ui.client.request('act.chat.send', { text: 'move the release' });
        eq(disk.read(disk.join(chatDir, 'notes.md')), 'Release 15 November\n');

        const open: { ask: number; cancelled: boolean }[] = [];
        ui.client.on('ask.proposal', (p, cancel) => new Promise(() => { const o = { ask: p.ask as number, cancelled: false }; open.push(o); cancel.onCancel(() => { o.cancelled = true; }); }));
        chat.makeProvider = () => scripted({ name: 'edit_file', args: edit }, 'ok');
        const turn = ui.client.request('act.chat.send', { text: 'again' });
        await until(() => open.length === 1);
        ok((await ui.client.request('act.chat.stop', {})).ok, 'stop');
        await until(() => open[0].cancelled);
        await turn;
        const late = await ui.client.request('act.proposal.apply', { ask: open[0].ask, chosen: null });
        ok(late.ok && typeof late.error === 'string', 'a late apply is refused');
        eq(disk.read(disk.join(chatDir, 'notes.md')), 'Release 15 November\n');
        server.dispose();
    });

    await test('saved conversations: the list, opening one, and deleting one only by a path the core listed', async () => {
        const settings = memorySettings();
        const { server, ui, chat } = await startChat(settings);
        settings.chatSave = true;
        chat.makeProvider = () => scripted(null, 'Saved answer');
        await ui.client.request('act.chat.send', { text: 'keep this one' });
        const listed = (await ui.client.request('act.chat.chats', {})).chats as { path: string; title: string; turns: number }[];
        eq(listed.length, 1);
        eq(listed[0].title, 'keep this one');
        ok(!(await ui.client.request('act.chat.open', { path: disk.join(chatDir, 'notes.md') })).ok, 'a path that is not a conversation of the list is refused');
        ok(!(await ui.client.request('act.chat.delete', { path: disk.join(chatDir, 'notes.md') })).ok, 'and so is deleting it');
        ok(disk.exists(disk.join(chatDir, 'notes.md')), 'the file is still there');
        await ui.client.request('act.chat.reset', {});
        const opened = (await ui.client.request('act.chat.open', { path: listed[0].path })).chat as { turns: { role: string; content: string }[] };
        eq(opened.turns.map(t => t.content), ['keep this one', 'Saved answer']);
        eq((await ui.client.request('act.chat.delete', { path: listed[0].path })).error, null);
        eq((await ui.client.request('act.chat.chats', {})).chats, []);
        server.dispose();
    });

    await test('Insert into note puts the answer into the open document, and clearing the log empties it', async () => {
        const { server, ui, chat } = await startChat();
        chat.makeProvider = () => scripted(null, 'x');
        await ui.client.request('act.chat.send', { text: 'q' });
        eq((await ui.client.request('act.chat.insert', { text: 'An answer' })).inserted, true);
        await until(() => ui.active.text.includes('An answer'));
        await ui.client.request('act.chat.clearLog', {});
        await until(() => noticesOf(ui, 'chat.log').some(p => (p.update as { reset: boolean; events: unknown[] }).reset && (p.update as { events: unknown[] }).events.length === 0));
        server.dispose();
    });

    // ---------- Git and collaboration (docs/design/electron-migrasi.md, phase 5) ----------

    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) host().setenv(name, value);
    const git = async (cwd: string, ...args: string[]): Promise<string> => {
        const run = await within(runGit(cwd, args));
        if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
        return run.out.trim();
    };

    // A fake forge behind the work folder: the pull requests it lists, and the requests it saw.
    const fakeForge = (token: string | null = 'secret') => {
        const seen: string[] = [];
        const stored = { token };
        const pullBody = { number: 7, title: 'Move the release', state: 'open', merged: false, mergeable: true, user: { login: 'sari' }, head: { ref: 'moved', sha: 'h7' }, base: { ref: 'main', sha: 'b7' },
            body: 'Moves it by a week.', comments: 1, created_at: '2026-10-12T01:00:00Z', updated_at: '2026-10-12T02:00:00Z', html_url: 'https://git.example.org/eka/notes/pulls/7' };
        const answers: Record<string, () => { status: number; body: string }> = {
            'GET /pulls?state=open&limit=50&page=1': () => ({ status: 200, body: JSON.stringify([pullBody]) }),
            'GET /pulls/7': () => ({ status: 200, body: JSON.stringify(pullBody) }),
            'GET /pulls/7/files?limit=50&page=1': () => ({ status: 200, body: JSON.stringify([{ filename: 'plan.md', status: 'modified', additions: 1, deletions: 1 }, { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }]) }),
            'GET /pulls/7.diff': () => ({ status: 200, body: 'diff --git a/plan.md b/plan.md\n--- a/plan.md\n+++ b/plan.md\n@@ -1 +1 @@\n-Ship 15 November\n+Ship 22 November\n' }),
            'GET /raw/plan.md?ref=b7': () => ({ status: 200, body: 'Ship 15 November\n' }),
            'GET /raw/plan.md?ref=h7': () => ({ status: 200, body: 'Ship 22 November\n' }),
            'GET /issues/7/comments': () => ({ status: 200, body: JSON.stringify([{ id: 1, body: 'Looks fine', user: { login: 'budi' }, created_at: '2026-10-12T03:00:00Z' }]) }),
            'POST /issues/7/comments': () => ({ status: 201, body: JSON.stringify({ id: 2, body: 'Thanks', user: { login: 'eka' }, created_at: '2026-10-12T04:00:00Z' }) }),
            'POST /pulls/7/merge': () => ({ status: 200, body: '' }),
            'GET ': () => ({ status: 200, body: JSON.stringify({ name: 'notes', owner: { login: 'eka' }, clone_url: 'https://git.example.org/eka/notes.git', default_branch: 'main', permissions: { push: true }, fork: false }) }),
        };
        const services = {
            tokens: {
                get: async () => stored.token ? { token: stored.token, source: 'keyring' as const } : null,
                set: async (_host: string, t: string) => { stored.token = t; return 'keyring' as const; },
                clear: async () => { stored.token = null; },
            },
            transport: async (request: { method: string; url: string; body?: string }) => {
                const path = request.url.replace('https://git.example.org/api/v1/repos/eka/notes', '');
                seen.push(`${request.method} ${path}`);
                return answers[`${request.method} ${path}`]?.() ?? { status: 404, body: '{"message":"no route"}' };
            },
            remoteUrl: async () => 'https://git.example.org/eka/notes.git',
        };
        return { services, seen, stored };
    };

    let repoCount = 0;
    // A repository with a.md in two commits and b.md not committed yet, a server on it with the History tab as the open page.
    const startGit = async (forge?: ReturnType<typeof fakeForge>) => {
        const root = disk.join(tmp, `protocol-git-${++repoCount}`);
        disk.mkdirs(root);
        const a = disk.join(root, 'a.md'), b = disk.join(root, 'b.md');
        await git(root, 'init', '-q');
        disk.write(a, '# A\n\none\n');
        await git(root, 'add', 'a.md');
        await git(root, 'commit', '-q', '-m', 'Create note');
        disk.write(a, '# A\n\none\ntwo\n');
        await git(root, 'commit', '-q', '-a', '-m', 'Add line two');
        disk.write(b, 'brand new\n');
        const settings = memorySettings();
        settings.chatSave = false;
        const post = { toClient: (_m: Message) => {} };
        const server = new ProtocolServer(settings, m => post.toClient(m));
        if (forge) Object.assign(server.session.collab.services, forge.services);
        const ui = attach(server, post);
        await ui.client.request('hello', { proto: 1 });
        ui.client.notify('setting', { key: 'sidebar', value: true });
        ui.client.notify('setting', { key: 'sidebar-page', value: 'history' });
        await ui.client.request('start', { path: root });
        await until(() => ui.last('view.files') !== undefined);
        await ui.client.request('open.file', { name: 'a.md' });
        return { server, ui, root, a, b, settings };
    };
    const listLength = (ui: ReturnType<typeof attach>, ev: string, key: string): number => (ui.last(ev)?.[key] as unknown[] | undefined)?.length ?? -1;

    await test('the History tab is told the commits and the uncommitted files (view.history, view.historyChanges) once its page is the open one', async () => {
        const { server, ui, a, b } = await startGit();
        await until(() => listLength(ui, 'view.history', 'commits') === 2);
        eq((ui.last('view.history')!.commits as { subject: string }[]).map(c => c.subject), ['Add line two', 'Create note']);
        await until(() => listLength(ui, 'view.historyChanges', 'changed') === 1);
        const changes = ui.last('view.historyChanges') as { file: string; state: string; changed: { path: string; kind: string; name: string }[] };
        eq([changes.file, changes.state, changes.changed[0].path, changes.changed[0].kind, changes.changed[0].name], [a, 'clean', b, 'untracked', 'b.md']);
        server.dispose();
    });

    await test('the history is not read while another page of the side panel is open', async () => {
        const { server, ui, b } = await startGit();
        await until(() => listLength(ui, 'view.history', 'commits') === 2);
        ui.client.notify('setting', { key: 'sidebar-page', value: 'files' });
        // A read already under way (git is slow on some systems) may still arrive; the count starts when the log is quiet.
        for (let quiet = 0, last = -1; quiet < 5; await pause(40)) { quiet = ui.log.length === last ? quiet + 1 : 0; last = ui.log.length; }
        const seen = ui.log.length;
        await ui.client.request('act.tree.activate', { path: b });
        await pause(80);
        eq(ui.log.slice(seen).filter(l => l.ev === 'view.history' || l.ev === 'view.historyChanges').length, 0, 'no new history while the Files tab is shown');
        ui.client.notify('setting', { key: 'sidebar-page', value: 'history' });
        await until(() => ui.log.slice(seen).some(l => l.ev === 'view.history' || l.ev === 'view.historyChanges'));
        server.dispose();
    });

    await test('a commit opens in a viewer (view.historyViewer.*) with its changes and the file as it was, and closing it is reported', async () => {
        const { server, ui } = await startGit();
        await until(() => listLength(ui, 'view.history', 'commits') === 2);
        const hash = (ui.last('view.history')!.commits as { hash: string }[])[0].hash;
        ok((await ui.client.request('act.history.open', { hash })).ok, 'open');
        await until(() => ui.last('view.historyViewer.diff') !== undefined && ui.last('view.historyViewer.content') !== undefined);
        const opened = ui.last('view.historyViewer.open') as { viewer: number; commit: { hash: string } | null };
        eq(opened.commit?.hash, hash);
        const diff = ui.last('view.historyViewer.diff') as { viewer: number; diff: { lines: { kind: string; text: string }[] } };
        eq(diff.viewer, opened.viewer);
        ok(diff.diff.lines.some(l => l.kind === 'add' && l.text.includes('two')), 'the diff has the added line');
        ok((ui.last('view.historyViewer.content') as { text: string }).text.includes('two'), 'the file at that commit');
        await ui.client.request('act.history.open', { hash: 'not-a-commit' });
        eq(ui.log.filter(l => l.ev === 'view.historyViewer.open').length, 1, 'a hash the core did not show opens nothing');
        ok((await ui.client.request('act.historyViewer.closed', { viewer: opened.viewer })).ok, 'closed');
        server.dispose();
    });

    await test('committing from the tab writes only the listed files that changed, and the log follows', async () => {
        const { server, ui, root, b } = await startGit();
        await until(() => listLength(ui, 'view.historyChanges', 'changed') === 1);
        eq((await ui.client.request('act.history.commit', { files: [], message: 'x' })).error, 'Select the files to commit');
        eq((await ui.client.request('act.history.commit', { files: [disk.join(root, 'nothing.md')], message: 'x' })).error, 'Select the files to commit', 'a file the tab did not show is ignored');
        eq((await ui.client.request('act.history.commit', { files: [b], message: '  ' })).error, 'Enter a commit message first');
        ok(!(await ui.client.request('act.history.commit', { files: 'b.md', message: 'x' })).ok, 'files is a list');
        eq((await ui.client.request('act.history.commit', { files: [b], message: 'Add b' })).error, null);
        eq(await git(root, 'log', '--format=%s', '-1'), 'Add b');
        await until(() => listLength(ui, 'view.historyChanges', 'changed') === 0);
        server.dispose();
    });

    await test('discarding asks (ask.discard) with the kind and the file, and does nothing when the answer is no', async () => {
        const { server, ui, a, b } = await startGit();
        await until(() => listLength(ui, 'view.historyChanges', 'changed') === 1);
        const asked: Record<string, unknown>[] = [];
        let yes = false;
        ui.client.on('ask.discard', p => { asked.push(p); return { answer: yes }; });
        eq((await ui.client.request('act.history.discard', { path: b })).outcome, 'declined');
        ok(disk.exists(b), 'the file stays');
        yes = true;
        eq((await ui.client.request('act.history.discard', { path: b })).outcome, 'done');
        ok(!disk.exists(b), 'the new file went to the Trash');
        eq([asked[0].kind, asked[0].path, asked[0].viewer], ['untracked', b, null]);
        const gone = (await ui.client.request('act.history.discard', { path: a })).outcome as { error: string };
        eq(gone.error, 'The file is no longer in the list of changes', 'a file the tab does not list is refused');
        server.dispose();
    });

    await test('the commit message is written by the assistant and streams as history.messageText; the reply says how it ended', async () => {
        const { server, ui, b } = await startGit();
        await until(() => listLength(ui, 'view.historyChanges', 'changed') === 1);
        const { chat } = server.session.assistant;
        chat.keyStore = KEY;
        chat.makeProvider = () => scripted(null, 'Add the b note');
        const result = (await ui.client.request('act.history.write', { files: [b] })).result as { ok: boolean; message: string };
        eq([result.ok, result.message], [true, 'Add the b note']);
        ok(noticesOf(ui, 'history.messageText').some(p => p.text === 'Add the b note'), 'the text reached the form');
        chat.keyStore = { get: async () => null, set: async () => 'keyring' as const, clear: async () => {} };
        eq(((await ui.client.request('act.history.write', { files: [b] })).result as { reason: string }).reason, 'no-key');
        server.dispose();
    });

    await test('the uncommitted changes of a file open in a viewer with a commit form, and committing closes it', async () => {
        const { server, ui, root, b } = await startGit();
        await until(() => listLength(ui, 'view.historyChanges', 'changed') === 1);
        ok((await ui.client.request('act.history.openChanges', { path: b })).ok, 'open');
        await until(() => ui.last('view.historyViewer.diff') !== undefined);
        const viewer = ui.last('view.historyViewer.open') as { viewer: number; commit: unknown; file: string };
        eq([viewer.commit, viewer.file], [null, b]);
        eq((await ui.client.request('act.historyViewer.commit', { viewer: viewer.viewer, message: 'Add b from the viewer' })).error, null);
        await until(() => ui.last('view.historyViewer.close') !== undefined);
        eq(await git(root, 'log', '--format=%s', '-1'), 'Add b from the viewer');
        ok(!(await ui.client.request('act.historyViewer.commit', { viewer: 'one', message: 'x' })).ok, 'a viewer is a number');
        server.dispose();
    });

    await test('the pull requests tab is told the server and the list (view.collab), and a missing token is told as a note', async () => {
        const forge = fakeForge();
        const { server, ui } = await startGit(forge);
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        const tab = ui.last('view.collab') as { server: string; pulls: { number: number; title: string }[] };
        eq([tab.server, tab.pulls[0].number, tab.pulls[0].title], ['git.example.org · eka/notes', 7, 'Move the release']);
        server.dispose();

        const other = await startGit(fakeForge(null));
        await until(() => typeof other.ui.last('view.collab')?.note === 'string');
        ok((other.ui.last('view.collab')!.note as string).includes('access token for git.example.org'), 'the note asks for a token');
        other.server.dispose();
    });

    await test('the token dialog (ask.token) can try a typed token (act.collab.testToken) before it is saved, and the saved token connects', async () => {
        const forge = fakeForge(null);
        const { server, ui } = await startGit(forge);
        await until(() => typeof ui.last('view.collab')?.note === 'string');
        const asks: Record<string, unknown>[] = [];
        let tested: Record<string, unknown> | undefined;
        ui.client.on('ask.token', async p => {
            asks.push(p);
            tested = await ui.client.request('act.collab.testToken', { ask: p.ask, token: ' typed ' });
            return { token: 'typed' };
        });
        ok((await ui.client.request('act.collab.server', {})).ok, 'server');
        await until(() => forge.stored.token === 'typed');
        eq([(asks[0].repo as { host: string }).host, asks[0].hasToken, asks[0].source], ['git.example.org', false, null]);
        eq(tested?.message, 'Connected — 1 open pull requests');
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        const stale = await ui.client.request('act.collab.testToken', { ask: 999, token: 'x' });
        ok(!stale.ok && stale.error.code === 'stale', 'a dialog that is closed cannot be asked to test');
        server.dispose();
    });

    await test('the token dialog answered with an empty token forgets the saved one, and Cancel changes nothing', async () => {
        const forge = fakeForge();
        const { server, ui } = await startGit(forge);
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        ui.client.on('ask.token', () => ({}));
        await ui.client.request('act.collab.server', {});
        await pause(60);
        eq(forge.stored.token, 'secret', 'cancelled');
        ui.client.on('ask.token', () => ({ token: '' }));
        await ui.client.request('act.collab.server', {});
        await until(() => forge.stored.token === null);
        server.dispose();
    });

    await test('a pull request opens as a page (view.pull.show, view.pull) with its files, the first file\'s note view, and the discussion', async () => {
        const forge = fakeForge();
        const { server, ui } = await startGit(forge);
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        const missing = await ui.client.request('act.collab.open', { number: 99 });
        ok(!missing.ok && missing.error.code === 'stale', 'a pull request the core did not list');
        ok((await ui.client.request('act.collab.open', { number: 7 })).ok, 'open');
        await until(() => ui.last('view.pull.show') !== undefined);
        await until(() => !!(ui.last('view.pull') as { fileView?: unknown } | undefined)?.fileView);
        const page = ui.last('view.pull') as { pull: { number: number }; files: { path: string }[]; selected: string; fileView: { rendered: { kind: string; text: string }[] | null; raw: unknown[] }; comments: { author: string }[] };
        eq([page.pull.number, page.files.map(f => f.path), page.selected], [7, ['plan.md', 'logo.png'], 'plan.md']);
        ok(page.fileView.rendered!.some(l => l.kind === 'add' && l.text.includes('22 November')), 'the note view marks the change');
        ok(page.fileView.raw.length > 0, 'and the raw diff is there');
        eq(page.comments.map(c => c.author), ['budi']);
        // A file that is not a note has only its raw diff (or says why not).
        ok((await ui.client.request('act.pull.select', { path: 'logo.png' })).ok, 'select');
        await until(() => (ui.last('view.pull') as { selected: string; fileView: { rendered: unknown } | null }).selected === 'logo.png'
            && (ui.last('view.pull') as { fileView: { rendered: unknown } | null }).fileView?.rendered === null);
        server.dispose();
    });

    await test('a comment is sent to the forge and the box is cleared; closing the review shows the document again', async () => {
        const forge = fakeForge();
        const { server, ui } = await startGit(forge);
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        await ui.client.request('act.collab.open', { number: 7 });
        await until(() => listLength(ui, 'view.pull', 'files') === 2);
        const cleared = (ui.last('view.pull') as { cleared: number }).cleared;
        ok((await ui.client.request('act.pull.comment', { text: 'Thanks' })).ok, 'comment');
        await until(() => forge.seen.includes('POST /issues/7/comments') && (ui.last('view.pull') as { cleared: number }).cleared > cleared);
        const pageViews = ui.log.filter(l => l.ev === 'view.page').length;
        ok((await ui.client.request('act.pull.close', {})).ok, 'close');
        await until(() => ui.log.filter(l => l.ev === 'view.page').length > pageViews);
        server.dispose();
    });

    await test('merging asks (ask.pull.merge) first: nothing is merged on a no, one POST on a yes; an unknown method is refused', async () => {
        const forge = fakeForge();
        const { server, ui } = await startGit(forge);
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        await ui.client.request('act.collab.open', { number: 7 });
        await until(() => listLength(ui, 'view.pull', 'files') === 2);
        let yes = false;
        const questions: { message: string; accept: string }[] = [];
        ui.client.on('ask.pull.merge', p => { questions.push(p.question as { message: string; accept: string }); return { answer: yes }; });
        ok(!(await ui.client.request('act.pull.merge', { method: 'fast-forward' })).ok, 'a method the forges do not have');
        await ui.client.request('act.pull.merge', { method: 'squash' });
        await until(() => questions.length === 1);
        await pause(40);
        ok(!forge.seen.includes('POST /pulls/7/merge'), 'nothing is merged on a no');
        yes = true;
        await ui.client.request('act.pull.merge', { method: 'squash' });
        await until(() => forge.seen.includes('POST /pulls/7/merge'));
        eq([questions[0].message, questions[0].accept], ['Merge pull request #7?', 'Merge']);
        await until(() => noticesOf(ui, 'toast').some(t => String(t.text).startsWith('Merged pull request #7')));
        server.dispose();
    });

    await test('sending changes asks (ask.sendChanges) with where it goes and what can be sent, and an answer outside the offer sends nothing', async () => {
        const forge = fakeForge();
        const { server, ui, b } = await startGit(forge);
        await until(() => listLength(ui, 'view.collab', 'pulls') === 1);
        const offers: { repository: string; base: string; canPush: boolean; changes: { path: string }[] }[] = [];
        let answer: unknown = null;
        ui.client.on('ask.sendChanges', p => { offers.push(p.options as never); return { answer }; });
        ok((await ui.client.request('act.collab.send', {})).ok, 'send');
        await until(() => offers.length === 1);
        eq([offers[0].repository, offers[0].base, offers[0].canPush, offers[0].changes.map(c => c.path)], ['eka/notes', 'main', true, [b]]);
        answer = { title: 'T', body: '', branch: 'update', via: 'direct', files: [disk.join(tmp, 'elsewhere.md')] };
        await ui.client.request('command', { name: 'send-changes' });
        await until(() => offers.length === 2);
        await pause(60);
        ok(!noticesOf(ui, 'toast').some(t => t.text === 'Sending…'), 'a file that was not offered is not sent');
        answer = { title: 'T', body: '', branch: 'bad branch', via: 'direct', files: [b] };
        await ui.client.request('command', { name: 'send-changes' });
        await until(() => offers.length === 3);
        await pause(60);
        ok(!noticesOf(ui, 'toast').some(t => t.text === 'Sending…'), 'and neither is a branch git would refuse');
        server.dispose();
    });

    // ---------- Agents and harness (docs/design/electron-migrasi.md, phase 6) ----------

    const agentFolder = disk.join(tmp, 'agent-project');
    disk.mkdirs(agentFolder);
    interface FakeRun { argv: string[]; cwd: string; handlers: SpawnHandlers; written: string[]; stopped: boolean }
    // A server on a board whose harness is a fake process: what it is told is in `written`, what it prints is `say`.
    const startAgents = async (boardText = BOARD) => {
        const name = `agents-${++repoCount}.md`;
        disk.write(disk.join(dir, name), boardText);
        const { server, ui } = await start();
        const spawned: FakeRun[] = [];
        const orchestrator = server.session.harness.orchestrator;
        orchestrator.program = spec => spec.program;
        orchestrator.spawn = (argv, cwd, handlers) => {
            const run: FakeRun = { argv, cwd, handlers, written: [], stopped: false };
            spawned.push(run);
            return { write: line => { run.written.push(line); return true; }, closeInput: () => handlers.exit(0, ''), stop: () => { run.stopped = true; } };
        };
        await ui.client.request('open.file', { name });
        await until(() => ui.last('view.notes') !== undefined);
        const say = (run: FakeRun, event: Record<string, unknown>) => run.handlers.line(JSON.stringify(event));
        const menu = async (text: string, column = 0, index = 0) => {
            const reply = await ui.client.request('act.card.menu', { column, index, text });
            ok(reply.ok, 'act.card.menu');
            return reply.entries as { label: string; token: number; enabled?: boolean }[];
        };
        const choose = async (entries: { label: string; token: number }[], label: string) => {
            const entry = entries.find(e => e.label === label);
            ok(entry !== undefined, `no "${label}" in ${entries.map(e => e.label).join(' | ')}`);
            ok((await ui.client.request('act.card.run', { token: entry!.token })).ok, 'act.card.run');
        };
        const cardNow = () => server.session.views.currentBoard().columns[0].cards[0].text;
        const runs = () => (ui.last('view.runs')?.runs ?? []) as { card: string; status: string }[];
        return { server, ui, spawned, say, menu, choose, cardNow, runs };
    };

    await test('a card\'s menu is asked for (act.card.menu), an entry runs by its token, and the run shows on the board (view.runs)', async () => {
        const { server, ui, spawned, menu, choose, cardNow, runs } = await startAgents();
        const first = await menu('One');
        eq(JSON.parse(JSON.stringify(first)), first, 'plain data');
        ok(first.some(e => e.label === 'Work on it with pi'), 'the assign entry');
        const gone = await ui.client.request('act.card.menu', { column: 0, index: 0, text: 'Nobody' });
        ok(!gone.ok && gone.error.code === 'stale', 'a card that is not there');
        const asked: string[] = [];
        ui.client.on('ask.folder', p => { asked.push(String(p.title)); return { path: agentFolder }; });
        await choose(first, 'Work on it with pi');
        await until(() => spawned.length === 1);
        eq([asked.length, spawned[0].cwd], [1, agentFolder]);
        await until(() => runs().some(r => r.status === 'working'));
        ok(cardNow().includes('[agent:: pi]'), cardNow());
        const second = await menu(cardNow());
        ok(second.some(e => e.label === 'Stop pi') && second.some(e => e.label === 'View pi Log'), second.map(e => e.label).join(' | '));
        const stale = await ui.client.request('act.card.run', { token: first[0].token });
        ok(stale.ok, 'a token of an earlier menu does nothing');
        await choose(second, 'Stop pi');
        await until(() => spawned[0].stopped);
        server.dispose();
    });

    await test('a card of a grouped board has no agent menu', async () => {
        const { server, ui } = await startAgents('---\nlayout: board\ngroup: s\nfields:\n  s: select(todo:gray, done:green)\n---\n\n- [ ] One [s:: todo]\n');
        await until(() => ui.last('view.notes')?.agents === false);
        const reply = await ui.client.request('act.card.menu', { column: 0, index: 0, text: 'One [s:: todo]' });
        ok(reply.ok && (reply.entries as unknown[]).length === 0, JSON.stringify(reply));
        server.dispose();
    });

    await test('a harness that asks is answered through ask.harness.answer, read against what it offered; steering goes through ask.text', async () => {
        const { server, ui, spawned, say, menu, choose, cardNow, runs } = await startAgents();
        ui.client.on('ask.folder', () => ({ path: agentFolder }));
        await choose(await menu('One'), 'Work on it with pi');
        await until(() => spawned.length === 1);
        say(spawned[0], { type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Which one?', options: ['red', 'blue'] });
        await until(() => runs().some(r => r.status === 'waiting'));
        const replies: unknown[] = [];
        let next: unknown = { reply: { value: 'green' } };
        ui.client.on('ask.harness.answer', p => { replies.push((p.ask as { title: string }).title); return next as Record<string, unknown>; });
        await choose(await menu(cardNow()), 'Answer pi…');
        await until(() => replies.length === 1);
        await pause(30);
        ok(!spawned[0].written.some(l => l.includes('extension_ui_response')), 'an option it did not offer is not sent');
        next = { reply: { value: 'blue' } };
        await choose(await menu(cardNow()), 'Answer pi…');
        await until(() => spawned[0].written.some(l => l.includes('extension_ui_response') && l.includes('"blue"')));
        await until(() => runs().some(r => r.status === 'working'));
        // Steering: a line of text, sent to the harness before its next step.
        let text = 'use the second file';
        ui.client.on('ask.text', p => ({ text: (p.options as { title: string }).title.startsWith('Steering') ? text : '' }));
        await choose(await menu(cardNow()), 'Steer pi…');
        await until(() => spawned[0].written.some(l => l.includes('use the second file')));
        server.dispose();
    });

    await test('a run\'s log is a window of its own: opened with the events, cleared and closed only while it is open', async () => {
        const { server, ui, spawned, menu, choose, cardNow } = await startAgents();
        ui.client.on('ask.folder', () => ({ path: agentFolder }));
        await choose(await menu('One'), 'Work on it with pi');
        await until(() => spawned.length === 1);
        await choose(await menu(cardNow()), 'View pi Log');
        await until(() => ui.last('view.runlog.open') !== undefined);
        const run = ui.last('view.runlog.open')!.run as number;
        ok(String(ui.last('view.runlog.open')!.title).startsWith('pi Log'), String(ui.last('view.runlog.open')!.title));
        await until(() => ui.log.some(l => l.ev === 'view.runlog.update' && (l.payload.update as { events: unknown[] }).events.length > 0));
        ok((await ui.client.request('act.runlog.clear', { run })).ok, 'clear');
        await until(() => ui.log.some(l => l.ev === 'view.runlog.update' && (l.payload.update as { reset: boolean; events: unknown[] }).reset && (l.payload.update as { events: unknown[] }).events.length === 0));
        ok((await ui.client.request('act.runlog.closed', { run })).ok, 'closed');
        const late = await ui.client.request('act.runlog.clear', { run });
        ok(!late.ok && late.error.code === 'stale', 'a log that is closed');
        const unknown = await ui.client.request('act.runlog.clear', { run: 9999 });
        ok(!unknown.ok && unknown.error.code === 'stale', 'a run that has no window');
        server.dispose();
    });

    await test('closing the window with an agent at work asks (ask.closeAgents): Cancel keeps the window, Stop ends the agent', async () => {
        const { server, ui, spawned, menu, choose } = await startAgents();
        ui.client.on('ask.folder', () => ({ path: agentFolder }));
        await choose(await menu('One'), 'Work on it with pi');
        await until(() => spawned.length === 1);
        const seen: unknown[] = [];
        let answer = 'cancel';
        ui.client.on('ask.saveChanges', () => ({ answer: 'save' }));
        ui.client.on('ask.closeAgents', p => { seen.push(p.activity); return { answer }; });
        let closed = await ui.client.request('app.close', {});
        ok(closed.ok && closed.allowed === false, 'cancelled');
        eq(seen[0], { children: 1, detachable: 0, queued: 0 });
        answer = 'stop';
        closed = await ui.client.request('app.close', {});
        ok(closed.ok && closed.allowed === true, 'allowed');
        server.dispose();
        ok(spawned[0].stopped, 'the agent was stopped with the window');
    });

    await test('a project folder on another machine is asked as text (ask.remoteFolder), and a folder the core rejects is told', async () => {
        const { server, ui, menu, choose } = await startAgents();
        ui.client.on('ask.folder', () => ({ path: disk.join(dir, 'inside-the-work-folder') }));
        const toasts = () => noticesOf(ui, 'toast').map(t => String(t.text));
        await choose(await menu('One'), 'Work on it with pi');
        await until(() => toasts().some(t => t.startsWith('Project folder rejected')));
        server.dispose();
    });

    // A project that is a Git repository: the run works in a worktree of its own, and the card can be reviewed.
    await test('the review of a card\'s worktree: view.review.show and view.review with the files, a comment, a reply, and a merge that asks first', async () => {
        const repo = disk.join(tmp, `agent-repo-${++repoCount}`);
        disk.mkdirs(repo);
        await git(repo, 'init', '-q');
        disk.write(disk.join(repo, 'readme.md'), '# Readme\n');
        await git(repo, 'add', '.');
        await git(repo, 'commit', '-q', '-m', 'First');
        const { server, ui, spawned, say, menu, choose, cardNow } = await startAgents();
        ui.client.on('ask.folder', () => ({ path: repo }));
        await choose(await menu('One'), 'Work on it with pi');
        await until(() => spawned.length === 1, 8000);
        const worktree = spawned[0].cwd;
        ok(worktree !== repo, 'the run works in a worktree');
        disk.write(disk.join(worktree, 'notes.md'), '# Notes\n\nA line\n');
        await git(worktree, 'add', '.');
        await git(worktree, 'commit', '-q', '-m', 'Add notes');
        say(spawned[0], { type: 'agent_settled' });
        await until(() => cardNow().includes('[branch::'), 8000);
        for (let tries = 0; tries < 300 && !(await menu(cardNow())).some(e => e.label === 'Review Changes'); tries++) await pause(20);
        await choose(await menu(cardNow()), 'Review Changes');
        await until(() => ui.last('view.review.show') !== undefined || ui.log.some(l => l.ev === 'view.review.show'));
        await until(() => ((ui.last('view.review')?.files ?? []) as unknown[]).length === 1, 8000);
        const page = ui.last('view.review')!;
        eq((page.files as { path: string; status: string }[]).map(f => [f.path, f.status]), [['notes.md', 'added']]);
        ok(!('part' in (page.files as object[])[0]), 'the diff text is sent for the selected file, not in the list');
        ok((page.commits as { subject: string }[]).some(c => c.subject === 'Add notes'), 'the commits');
        eq((page.pull as { enabled: boolean }).enabled, false, 'no origin remote, no pull request');
        await until(() => ((ui.last('view.review')?.diff as { lines: unknown[] } | null)?.lines.length ?? 0) > 0);
        const bad = await ui.client.request('act.review.select', { index: 4 });
        ok(!bad.ok && bad.error.code === 'stale', 'a file that is not in the list');
        const badLine = await ui.client.request('act.review.comment', { line: 999, text: 'x' });
        ok(!badLine.ok && badLine.error.code === 'stale', 'a line that is not in the diff');
        const lines = (ui.last('view.review')!.diff as { lines: { text: string }[] }).lines;
        const at = lines.findIndex(l => l.text.includes('A line'));
        ok((await ui.client.request('act.review.comment', { line: at, text: 'Make it longer' })).ok, 'comment');
        await until(() => (ui.last('view.review')!.diff as { commented: number[] }).commented.includes(at));
        eq(ui.last('view.review')!.replies, 1);
        ok((await ui.client.request('act.review.tab', { tab: 'summary' })).ok, 'tab');
        const wrongTab = await ui.client.request('act.review.tab', { tab: 'nope' });
        ok(!wrongTab.ok && wrongTab.error.code === 'bad_request', 'tab');
        const wrong = await ui.client.request('act.review.finish', { action: 'rebase' });
        ok(!wrong.ok && wrong.error.code === 'bad_request', 'an action the page does not have');
        // Merging asks first; a no merges nothing, a yes does.
        const questions: string[] = [];
        let merge = false;
        ui.client.on('ask.review.merge', p => { questions.push((p.question as { message: string }).message); return { answer: merge }; });
        ok((await ui.client.request('act.review.finish', { action: 'merge' })).ok, 'finish');
        await until(() => questions.length === 1);
        await pause(60);
        ok(!disk.exists(disk.join(repo, 'notes.md')), 'nothing merged on a no');
        merge = true;
        await ui.client.request('act.review.finish', { action: 'merge' });
        // git creates the file before it writes it: wait for the text, not only the file.
        const merged = disk.join(repo, 'notes.md');
        await until(() => disk.exists(merged) && disk.read(merged) === '# Notes\n\nA line\n', 8000);
        await until(() => ui.log.some(l => l.ev === 'doc.active') && !cardNow().includes('[branch::'), 8000);
        server.dispose();
    });

    await test('the form that sends a branch as a pull request is read against its offer, and a harness answer against its question', async () => {
        const wire = scriptedWire();
        const asks = new Asks(wire);
        const reviews = new ProtocolReviewDialogs(asks);
        const options = { repository: 'eka/notes', host: 'git.example.org', base: 'main', branch: 'markwork/x', title: 'T', body: '', canPush: false, uncommitted: false };
        const first = reviews.pullRequest(options);
        wire.sent[0].answer({ ok: true, answer: { title: 'T', body: '', via: 'direct' } });
        eq(await first, null, 'a way the token cannot use');
        const second = reviews.pullRequest(options);
        wire.sent[1].answer({ ok: true, answer: { title: 'T', body: 'b', via: 'fork' } });
        eq(await second, { title: 'T', body: 'b', via: 'fork' });
        const third = reviews.pullRequest(options);
        wire.sent[2].answer({ ok: true, answer: { title: '  ', body: '', via: 'fork' } });
        eq(await third, null, 'a title with nothing in it');
        const dialogs = new ProtocolHarnessDialogs(asks);
        const ask = { kind: 'confirm' as const, id: 'u', title: 't', message: '', options: [], prefill: '', timeout: null };
        const confirm = dialogs.answer(ask, 'pi');
        wire.sent[3].answer({ ok: true, reply: { value: 'yes' } });
        eq(await confirm, null, 'a confirmation is yes or no');
        const skip = dialogs.answer(ask, 'pi');
        wire.sent[4].answer({ ok: true, reply: { cancelled: true } });
        eq(await skip, { cancelled: true });
        const leave = dialogs.closeAgents({ children: 1, detachable: 0, queued: 0 });
        wire.sent[5].answer({ ok: true, answer: 'quit' });
        eq(await leave, 'cancel', 'anything but the three answers is Cancel');
    });

    await test('Preferences → Agents: a machine is added through ask.machine, a project is opened, changed field by field, and removed worktrees must be listed ones', async () => {
        const { server, ui } = await start();
        const { settings } = server.session;
        settings.projects = { notes: agentFolder };
        ok((await ui.client.request('command', { name: 'preferences' })).ok, 'preferences');
        await until(() => ui.last('view.prefs.open') !== undefined);
        const data = () => (ui.last('view.prefs.values') ?? ui.last('view.prefs.open'))!.data as { machines: { name: string; target: string }[]; projects: { name: string; folder: string }[]; machineChoices: { value: string }[]; harnessMachine: string };
        eq(data().projects.map(p => [p.name, p.folder]), [['notes', agentFolder]]);
        let machine: unknown = { name: 'bad name', target: 'me@box' };
        ui.client.on('ask.machine', () => ({ machine }));
        ok((await ui.client.request('act.prefs.addMachine', {})).ok, 'addMachine');
        await pause(30);
        eq(settings.machines, {}, 'a name that is not valid');
        machine = { name: 'box', target: 'me@box' };
        await ui.client.request('act.prefs.addMachine', {});
        await until(() => data().machines.some(m => m.name === 'box'));
        ok(data().machineChoices.some(c => c.value === 'box'), 'the choice of where agents run');
        ok((await ui.client.request('act.prefs.set', { key: 'harnessMachine', value: 'box' })).ok, 'harnessMachine');
        const unknownMachine = await ui.client.request('act.prefs.set', { key: 'harnessMachine', value: 'nowhere' });
        ok(!unknownMachine.ok, 'a machine that is not in the list');
        ok((await ui.client.request('act.prefs.removeMachine', { name: 'box' })).ok, 'removeMachine');
        await until(() => data().machines.length === 0);
        eq(data().harnessMachine, '', 'the choice of where agents run goes with the machine');
        // A project.
        ok((await ui.client.request('act.prefs.openProject', { name: 'notes' })).ok, 'openProject');
        await until(() => ui.last('view.prefs.project') !== undefined);
        const page = ui.last('view.prefs.project')!.page as { name: string; remote: boolean; maxSlots: number; isolation: { slots: number } };
        eq([page.name, page.remote], ['notes', false]);
        await until(() => (ui.last('view.prefs.worktrees')?.list as { loading: boolean } | undefined)?.loading === false);
        const set = await ui.client.request('act.prefs.setProject', { name: 'notes', patch: { slots: 3, worktrees: false } });
        ok(set.ok && set.error === null, JSON.stringify(set));
        eq(JSON.parse(settings.projectOptions.notes), { worktrees: false, slots: 3, base: '', dir: '', afterMerge: 'remove' });
        const tooMany = await ui.client.request('act.prefs.setProject', { name: 'notes', patch: { slots: 99 } });
        ok(tooMany.ok && typeof tooMany.error === 'string', 'slots out of range');
        const nobody = await ui.client.request('act.prefs.setProject', { name: 'nobody', patch: { slots: 2 } });
        ok(nobody.ok && nobody.error === 'there is no such project', JSON.stringify(nobody));
        const notListed = await ui.client.request('act.prefs.removeWorktree', { name: 'notes', path: '/etc' });
        ok(notListed.ok && notListed.error === 'that worktree is not one of this project', JSON.stringify(notListed));
        server.dispose();
    });

    // The members of AppFrontend these scenarios reach that are still `unwired` (src/app/protocol/unwired.ts): a call does
    // nothing, a question counts as "no". Carrying one over removes it here; a member that appears here was reached
    // without being carried over, which is a feature the Electron window silently lacks (docs/design/electron-migrasi.md).
    const STILL_UNWIRED: string[] = ['frontendCommands.edit'];
    await test(`the members still unwired only shrink (${STILL_UNWIRED.length} reached by these scenarios)`, () => {
        eq(unwiredTouched(), STILL_UNWIRED);
    });
}
