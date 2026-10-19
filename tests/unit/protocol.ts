// The app protocol without a window: changes in code points, the replica of a document, and a ProtocolServer driven by a
// scripted frontend (DocMirror) over an in-memory line. The same list runs on GJS and on Node.

import { applyChanges, diffChanges } from '../../src/app/protocol/changes.js';
import { DocMirror } from '../../src/app/protocol/mirror.js';
import { ProtocolEditor, headingsOf } from '../../src/app/protocol/replica.js';
import { ProtocolServer } from '../../src/app/protocol/server.js';
import { Connection } from '../../src/app/protocol/wire.js';
import { unwiredTouched } from '../../src/app/protocol/unwired.js';
import { Asks } from '../../src/app/protocol/asks.js';
import { Cancellable } from '../../src/cancel.js';
import { RequestError, type Message, type Reply, type Wire } from '../../src/app/protocol/messages.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { memorySettings } from './appsession.js';
import { section, test, eq, ok, tmp, disk, until, pause } from '../framework.js';

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
    // The members of AppFrontend these scenarios reach that are still `unwired` (src/app/protocol/unwired.ts): a call does
    // nothing, a question counts as "no". Carrying one over removes it here; a member that appears here was reached
    // without being carried over, which is a feature the Electron window silently lacks (docs/design/electron-migrasi.md).
    const STILL_UNWIRED: string[] = [
        'dialogs.collab', 'dialogs.contribute', 'dialogs.harness', 'dialogs.history', 'dialogs.journal',
        'dialogs.preferences', 'dialogs.pulls', 'dialogs.review', 'dialogs.views',
        'frontendCommands.edit', 'host.board.setRuns', 'host.chatPanel', 'host.collabPanel', 'host.csv',
        'host.historyTab', 'host.historyViewers', 'host.inbox', 'host.layouts', 'host.logs',
        'host.preferencesView', 'host.pullView', 'host.reviewView', 'host.setRecent', 'host.table',
    ];
    await test(`the members still unwired only shrink (${STILL_UNWIRED.length} reached by these scenarios)`, () => {
        eq(unwiredTouched(), STILL_UNWIRED);
    });
}
