// GUI tests: git conflict markers as a choice (see editor/conflictlayer.ts).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { section, test, eq, ok, optVal } from '../framework.js';
import { widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function conflictLayerTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo } = c;

    section('Conflict choice (colors and buttons)');
    //  0 top | 1 <<<<<<< | 2 mine | 3 ======= | 4 theirs | 5 >>>>>>> | 6 between | 7 <<<<<<< | 8 a | 9 ======= | 10 b | 11 >>>>>>> | 12 end
    const DOC = 'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> refs/pull/7/head\nbetween\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> abc\nend\n';
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const tagged = (line: number, name: string) => iterAtLine(buf, line).has_tag(buf.get_tag_table().lookup(`conflict-${name}`)!);
    const buttons = (index: number): Gtk.Button[] => {
        const out: Gtk.Button[] = [];
        const walk = (w: Gtk.Widget | null) => { for (let k = w?.get_first_child() ?? null; k; k = k.get_next_sibling()) { if (k instanceof Gtk.Button) out.push(k); else walk(k); } };
        const slot = (ed.conflicts as unknown as { widgets: (Gtk.Box | null)[] }).widgets[index];
        walk(slot);
        return out;
    };

    test('each side gets its color, the markers a stronger one, and the text is unchanged', () => {
        setText(DOC); cursorTo(0); settle();
        eq(ed.conflicts.conflicts.length, 2);
        ok(tagged(1, 'currentHead') && tagged(2, 'current'), 'the current side is not colored');
        ok(tagged(3, 'neutral'), 'the divider is not neutral');
        ok(tagged(4, 'incoming') && tagged(5, 'incomingHead'), 'the incoming side is not colored');
        ok(!tagged(0, 'current') && !tagged(6, 'current') && !tagged(6, 'incoming') && !tagged(12, 'neutral'), 'text outside a conflict was colored');
        eq(text(), DOC);
    });
    test('there is room above the first marker and a row of three buttons in it', () => {
        const row = buttons(0);
        eq(row.map(b => b.get_label()), ['Accept Current', 'Accept Incoming', 'Accept Both']);
        const [y] = ed.view.get_line_yrange(iterAtLine(buf, 1));
        const [prevY, prevH] = ed.view.get_line_yrange(iterAtLine(buf, 0));
        ok(y >= prevY + prevH, 'the marker line starts above the text before it');
        const slot = (ed.conflicts as unknown as { widgets: Gtk.Box[] }).widgets[0];
        ok(slot.get_visible(), 'the buttons are not shown');
    });
    test('Accept Current keeps only our lines, in one undo step', () => {
        ed.conflicts.choose(0, 'current'); settle();
        eq(text(), 'top\nmine\nbetween\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> abc\nend\n');
        eq(ed.conflicts.conflicts.length, 1);
        ok(!tagged(1, 'current'), 'the resolved lines are still colored');
        buf.undo(); settle();
        eq(text(), DOC);
        eq(ed.conflicts.conflicts.length, 2);
    });
    test('Accept Incoming and Accept Both on the second conflict', () => {
        ed.conflicts.choose(1, 'incoming'); settle();
        eq(text(), 'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> refs/pull/7/head\nbetween\nb\nend\n');
        buf.undo(); settle();
        ed.conflicts.choose(1, 'both'); settle();
        eq(text(), 'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> refs/pull/7/head\nbetween\na\nb\nend\n');
    });
    test('clicking a button resolves that conflict; a conflict at the end of the file works too', () => {
        setText('x\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> y'); cursorTo(0); settle();
        buttons(0)[1].emit('clicked'); settle();
        eq(text(), 'x\ntheirs');
        eq(ed.conflicts.conflicts.length, 0);
        setText('<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> y\nafter'); settle();
        ed.conflicts.choose(0, 'current'); settle();
        eq(text(), 'after');
    });
    test('the same text again (a whole new file) is colored again, and the markers are not hidden as Markdown', () => {
        setText(DOC); cursorTo(0); settle();
        setText(DOC); cursorTo(0); settle();
        ok(tagged(2, 'current') && tagged(4, 'incoming'), 'the colors are gone after the text was replaced');
        const marker = DOC.indexOf('=======');
        ok(!c.hidden(marker) && !c.hidden(DOC.indexOf('>>>>>>>')), 'a marker was hidden');
    });
    test('without markers nothing is colored, and a heading underline is left alone', () => {
        setText('Title\n=======\ntext\n'); cursorTo(0); settle();
        eq(ed.conflicts.conflicts.length, 0);
        ok(!tagged(1, 'neutral'), 'the underline was colored');
    });

    // --shot-conflict=<prefix>: save a screenshot of a file with conflicts in the light and dark themes (<prefix>-light.png, -dark.png).
    const shot = optVal('shot-conflict');
    if (shot) {
        const oldDark = w.dark;
        for (const [dark, name] of [[false, 'light'], [true, 'dark']] as const) {
            w.setDark(dark);
            setText(`# Journal\n\nNotes for the week.\n\n<<<<<<< HEAD\nhello from main and sari\n=======\n# Journal\n\nEdited from the pull request.\n>>>>>>> refs/pull/32/head\n\nAgenda stays as it is.\n\n<<<<<<< HEAD\nBudget: 120\n=======\nBudget: 150\n>>>>>>> refs/pull/32/head\n`);
            cursorTo(0);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
            const page = widgetPixbuf(w.win);
            ok(page, 'the capture failed');
            page?.savev(`${shot}-${name}.png`, 'png', [], []);
        }
        w.setDark(oldDark);
    }
    setText('');
    buf.set_modified(false);
}
