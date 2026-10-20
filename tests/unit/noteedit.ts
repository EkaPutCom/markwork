// The edits a view of a document's notes reports (markdown/noteedit.ts), and the view controller applying them to the
// board it holds.

import { applyNoteEdit, cardText, findCard, type NoteEdit } from '../../src/markdown/noteedit.js';
import { parseBoard, serializeBoard } from '../../src/markdown/kanban.js';
import { AppSession } from '../../src/app/session.js';
import type { NotesView } from '../../src/app/views.js';
import { fakeFrontend, FakeEditor, LaggingEditor, memorySettings, quiet } from './appsession.js';
import { section, test, eq, ok, tmp, disk, pause, until } from '../framework.js';

const BOARD = '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n- [ ] Two #a\n\n## Done\n\n- [x] Old\n';
const titles = (text: string, column = 0) => parseBoard(text).columns[column].cards.map(c => c.text);

export async function noteEditTests(): Promise<void> {
    section('Edits of a document\'s notes');

    await test('every edit is plain data, and applies with the board functions it names', () => {
        const board = parseBoard(BOARD);
        const edits: NoteEdit[] = [
            { kind: 'add', column: 1, text: 'New', notes: ['a note'], now: 0 },
            { kind: 'move', at: { column: 0, index: 0 }, card: 'One', to: { column: 1, index: 0 } },
            { kind: 'toggle', at: { column: 0, index: 1 }, card: 'Two #a' },
            { kind: 'renameColumn', column: 1, title: 'Done', to: 'Finished' },
            { kind: 'moveColumn', column: 1, title: 'Done', to: 0 },
            { kind: 'delete', at: { column: 1, index: 0 }, card: 'Old' },
        ];
        for (const edit of edits) eq(JSON.parse(JSON.stringify(edit)), edit, `${edit.kind}: not plain data`);
        const [add, move, toggle, rename, moveColumn, remove] = edits.map(e => applyNoteEdit(board, e)!);
        eq(add.columns[1].cards.at(-1), { done: false, text: 'New', notes: ['a note'] });
        eq([move.columns[0].cards.length, move.columns[1].cards[0].text], [1, 'One']);
        eq(toggle.columns[0].cards[1].done, true);
        eq(rename.columns[1].title, 'Finished');
        eq(moveColumn.columns.map(c => c.title), ['Done', 'Plan']);
        eq(remove.columns[1].cards, []);
    });

    await test('a card is found again by its text when it moved; one that is gone or ambiguous makes the edit stale', () => {
        const board = parseBoard(BOARD);
        // Another write put a card above "Two" while the user was dragging it.
        const moved = parseBoard(BOARD.replace('- [ ] One\n', '- [ ] Zero\n- [ ] One\n'));
        const edit: NoteEdit = { kind: 'toggle', at: { column: 0, index: 1 }, card: 'Two #a' };
        eq(findCard(moved, edit), { column: 0, index: 2 });
        eq(applyNoteEdit(moved, edit)!.columns[0].cards[2].done, true, 'applied where the card is now');
        eq(applyNoteEdit(parseBoard(BOARD.replace('- [ ] Two #a\n', '')), edit), null, 'gone');
        eq(applyNoteEdit(parseBoard(BOARD.replace('- [ ] One', '- [ ] Two #a')), { ...edit, at: { column: 0, index: 5 } }), null, 'two cards with that text in its list');
        eq(applyNoteEdit(parseBoard(BOARD.replace('- [x] Old', '- [ ] Two #a')), { ...edit, at: { column: 1, index: 5 } })!.columns[1].cards[0].done, true, 'one in its own list wins');
        eq(applyNoteEdit(board, { kind: 'renameColumn', column: 0, title: 'Gone', to: 'X' }), null, 'a list that is gone');
    });

    await test('a dialog answers the parts of a card; the text is composed from the card as it is, keeping what the dialog did not show', () => {
        const form = { kind: 'card' as const, title: 'Ship', tags: ['release'], due: '2026-10-20', agent: '', fields: [] };
        eq(cardText(form), 'Ship #release [due:: 2026-10-20]');
        eq(cardText(form, 'Old [owner:: Sari]'), 'Ship #release [owner:: Sari] [due:: 2026-10-20]', 'a field the dialog does not show stays');
        const field = { key: 'status', type: 'select' as const, multiple: false, options: ['todo', 'doing'] };
        eq(cardText({ kind: 'note', title: 'Read', tags: [], due: '', agent: '', fields: [{ field, text: 'doing' }] }), 'Read [status:: doing]');
        const board = parseBoard(BOARD);
        eq(applyNoteEdit(board, { kind: 'update', at: { column: 0, index: 0 }, card: 'One', text: { ...form, title: '' , tags: [], due: '' } }), board, 'a dialog that left nothing changes nothing');
        eq(applyNoteEdit(board, { kind: 'update', at: { column: 0, index: 0 }, card: 'One', text: form, notes: ['why'] })!.columns[0].cards[0],
            { done: false, text: 'Ship #release [due:: 2026-10-20]', notes: ['why'] });
    });

    await test('the view controller applies an edit to the board it holds, after a write that had not landed when the view sent it', async () => {
        const session = new AppSession(fakeFrontend(memorySettings(), [], () => new LaggingEditor()));
        session.start();
        const dir = disk.join(tmp, 'noteedit-lag');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'board.md');
        disk.write(file, BOARD);
        ok(session.host.openInTab(file), 'openInTab');
        session.views.show('board');
        // A harness run moves its card while the user's drag is on its way.
        eq(session.host.updateBoardFile(file, b => ({ ...b, columns: b.columns.map((c, i) => i === 0 ? { ...c, cards: [{ done: false, text: 'Zero', notes: [] }, ...c.cards] } : c) })), null);
        await pause(5);
        session.host.board.onEdit({ kind: 'move', at: { column: 0, index: 0 }, card: 'One', to: { column: 1, index: 0 } });
        const now = () => { try { return session.documents.active.editor.getText(); } catch { return ''; } };
        await until(() => { const text = now(); return text !== '' && titles(text, 1).includes('One'); });
        const text = session.documents.active.editor.getText();
        eq([titles(text), titles(text, 1)], [['Zero', 'Two #a'], ['One', 'Old']], 'both changes are kept');
        session.dispose();
    });

    await test('a list that reports an edit is written through the board the core holds, not one the view sends', () => {
        const sent: unknown[] = [];
        const inbox = quiet<NotesView & { focusCapture(): void }>({ setBoard: board => { sent.push(board); } });
        const session = new AppSession(fakeFrontend(memorySettings(), [], () => new FakeEditor(), { inbox }));
        session.start();
        const dir = disk.join(tmp, 'noteedit-list');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'list.md');
        disk.write(file, '---\nlayout: list\n---\n\n- First\n');
        ok(session.host.openInTab(file), 'openInTab');
        ok(session.views.inboxMode, 'shown as a list');
        inbox.onEdit({ kind: 'capture', text: 'Second', notes: [], now: Date.UTC(2026, 9, 17, 12) });
        const text = session.documents.active.editor.getText();
        ok(text.includes('First') && text.includes('Second'), text);
        const drawn = sent.length;
        inbox.onEdit({ kind: 'delete', at: { column: 0, index: 0 }, card: 'Not there' });
        eq(session.documents.active.editor.getText(), text, 'a stale edit writes nothing');
        eq(sent.length, drawn + 1, 'and the list is drawn again from the board the core holds');
        eq(serializeBoard(sent.at(-1) as ReturnType<typeof parseBoard>), text);
        session.dispose();
    });
}
