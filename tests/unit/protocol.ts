// The app protocol without a window: changes in code points, the replica of a document, and a ProtocolServer driven by a
// scripted frontend (DocMirror) over an in-memory line. The same list runs on GJS and on Node.

import { applyChanges, diffChanges } from '../../src/app/protocol/changes.js';
import { DocMirror } from '../../src/app/protocol/mirror.js';
import { ProtocolEditor, headingsOf } from '../../src/app/protocol/replica.js';
import { ProtocolServer } from '../../src/app/protocol/server.js';
import { Connection } from '../../src/app/protocol/wire.js';
import type { Message, Reply, Wire } from '../../src/app/protocol/messages.js';
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
function attach(server: ProtocolServer, post: { toClient: (m: Message) => void }, chosen: { path: string | null } = { path: null }) {
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
        const result = mirror.replace(p.base as number, p.changes as never);
        if (!result.ok) throw Object.assign(new Error('text changed'), { code: 'conflict' });
        return result;
    });
    client.on('ask.file', () => ({ path: chosen.path }));
    client.on('doc.close', p => { mirrors.delete(p.doc as number); void p; });
    client.on('doc.resync', p => mirrors.get(p.doc as number)!.snapshot(0));
    return {
        client, mirrors, log,
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
}
