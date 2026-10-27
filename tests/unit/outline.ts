// The Outline tab and the [[ suggestions: OutlineController (app/outline.ts) and NoteLinks.namesFor
// (app/notes.ts) in an AppSession, with views that record what they are sent.

import { AppSession } from '../../src/app/session';
import type { OutlineHeading, OutlineView } from '../../src/app/outline';
import { section, test, eq, ok, tmp, disk } from '../core/framework';
import { fakeFrontend, FakeEditor, memorySettings, quiet } from './appsession';

const H = (level: number, text: string, line: number): OutlineHeading => ({ level, text, line });

export async function outlineTests(): Promise<void> {
    section('Outline and note suggestions in the application session');
    const setup = () => {
        const shown: (readonly OutlineHeading[])[] = [];
        const view = quiet<OutlineView>({ showHeadings: headings => { shown.push(headings); } });
        const session = new AppSession(fakeFrontend(memorySettings(), [], undefined, { outlineView: view }));
        session.start();
        return { session, view, shown, editor: () => session.documents.active.editor as FakeEditor };
    };

    await test('the active document\'s headings are sent as plain data, and a change of a background document is not', () => {
        const { session, shown, editor } = setup();
        const first = session.documents.active;
        editor().headings = [H(1, 'Title', 0), H(2, 'Part', 4)];
        session.outline.show(first);
        eq(shown.at(-1), [H(1, 'Title', 0), H(2, 'Part', 4)]);
        eq(JSON.parse(JSON.stringify(shown.at(-1))), shown.at(-1), 'not plain data');
        const count = shown.length;
        session.outline.changed({ ...first, id: first.id + 100 });
        eq(shown.length, count, 'a document that is not active');
        editor().headings = [H(1, 'Title', 0), H(2, 'Part', 4), H(2, 'More', 9)];
        session.outline.changed(first);
        eq(shown.at(-1)!.length, 3, 'the active document changed');
        session.dispose();
    });

    await test('a jump goes to the line the list had when it was drawn, even if the headings moved since', () => {
        const { session, view, editor } = setup();
        editor().headings = [H(1, 'Title', 0), H(2, 'Part', 4)];
        session.outline.show(session.documents.active);
        editor().headings = [H(1, 'Title', 0), H(2, 'Part', 7)];   // not sent yet
        view.onJump(1);
        eq(editor().jumped, 4);
        editor().jumped = null;
        view.onJump(5);
        view.onJump(-1);
        eq(editor().jumped, null, 'a place the list did not have');
        session.dispose();
    });

    await test('suggestions for [[ come by the id of the document; an id that is not open has none', () => {
        const { session } = setup();
        const dir = disk.join(tmp, 'outline-notes');
        disk.mkdirs(disk.join(dir, 'sub'));
        disk.write(disk.join(dir, 'a.md'), '# A\n');
        disk.write(disk.join(dir, 'sub', 'b.md'), '# B\n');
        session.files.setRoot(dir);
        const names = session.notes.namesFor(session.documents.active.id);
        ok(names.includes('a.md') && names.includes('sub/b.md'), `names: ${names}`);
        eq(session.notes.namesFor(9999), [], 'unknown id');
        session.dispose();
    });
}
