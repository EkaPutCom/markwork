// GUI tests: [[note]] links (highlighting, Ctrl+click opens/creates a note, suggestions while typing [[).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Graphene from 'gi://Graphene';
import GdkPixbuf from 'gi://GdkPixbuf';
import { widgetPixbuf } from '../widgets.js';
import { attachWikiCompleter } from '../../src/editor/wikicomplete.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';

export function wikiLinkGuiTests(c: GuiContext): void {
    const { w, ed, buf, pump, setText, offsetIn, hidden, tagAt, text } = c;

    section('[[note]] links');
    const proj = GLib.build_filenamev([tmp, 'wiki']);
    const abs = (...parts: string[]) => GLib.build_filenamev([proj, ...parts]);
    const write = (rel: string, content: string) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(abs(rel)), 0o755);
        GLib.file_set_contents(abs(rel), content);
    };
    write('Idea.md', '# Idea\n\ncontent\n\n## Section Two\n\ncontinued\n');
    write('Journal/Daily Notes.md', 'start\n');
    write('Journal/Plan.md', '# Plan\n');
    write('projects/Meeting Notes.md', '# Meeting\n');
    w.openFolder(proj);
    pump();
    ok(w.load(abs('Journal', 'Daily Notes.md')), 'load');
    pump();

    const ctrlClick = (off: number) => {
        const rect = ed.view.get_iter_location(buf.get_iter_at_offset(off));
        const [x, y] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x + 2, rect.y + rect.height / 2);
        const handled = ed.onClick(1, x, y, Gdk.ModifierType.CONTROL_MASK);
        pump();
        return handled;
    };
    const backToFirstTab = () => { while (w.editor !== ed) ok(w.closeTab(), 'closeTab() failed'); };
    const type = (s: string) => {
        for (const ch of s) { buf.insert_at_cursor(ch, -1); pump(); }
    };
    const placeAtEnd = () => { buf.place_cursor(buf.get_end_iter()); pump(); };

    test('[[note]] is shown as a link, its brackets are hidden on other lines', () => {
        const s = 'see [[Idea]] and [[Journal/Plan|plan]]\n\nother line';
        setText(s);
        placeAtEnd();
        ok(tagAt(offsetIn(s, 'Idea]]'), 'link'), 'the name is not a link');
        ok(hidden(offsetIn(s, '[[Idea')), 'the opening brackets are visible');
        ok(hidden(offsetIn(s, 'Journal/')), 'the alias target is visible');
        ok(tagAt(offsetIn(s, 'plan]]'), 'link'), 'the alias is not a link');
        ok(!hidden(offsetIn(s, 'plan]]')), 'the alias is hidden');
    });
    test('Ctrl+click on [[note]] opens its file in a new tab and jumps to the section', () => {
        const s = 'see [[idea#section two]]\n\nx';
        setText(s);
        placeAtEnd();
        ok(ctrlClick(offsetIn(s, 'idea#')), 'the click was not handled');
        eq(w.file, abs('Idea.md'), 'the opened file');
        const cursor = w.editor.buffer.get_iter_at_mark(w.editor.buffer.get_insert());
        eq(cursor.get_line(), 4, 'cursor line (heading Section Two)');
        backToFirstTab();
    });
    test('Ctrl+click on a note that does not exist opens an empty document without writing to disk', () => {
        const s = 'continue to [[New Note]]\n\nx';
        setText(s);
        placeAtEnd();
        ok(ctrlClick(offsetIn(s, 'New Note')), 'the click was not handled');
        eq(w.file, abs('Journal', 'New Note.md'), 'the path of the new note next to the source document');
        eq(w.editor.getText(), '', 'contents');
        ok(!GLib.file_test(abs('Journal', 'New Note.md'), GLib.FileTest.EXISTS), 'the file was already written');
        backToFirstTab();
    });
    test('Ctrl+click on a relative Markdown link to an .md file opens in Markwork', () => {
        const s = 'see [plan](Plan.md)\n\nx';
        setText(s);
        placeAtEnd();
        ok(ctrlClick(offsetIn(s, 'plan]')), 'the click was not handled');
        eq(w.file, abs('Journal', 'Plan.md'), 'the opened file');
        backToFirstTab();
    });
    test('typing [[ shows suggestions; the arrow and Enter insert the name and then close ]]', () => {
        setText('');
        type('read [[note');
        ok(ed.completer.visible, 'the suggestions did not appear');
        eq(ed.completer.items, ['Journal/Daily Notes.md', 'projects/Meeting Notes.md'], 'suggestion contents');
        ok(ed.onKey(Gdk.KEY_Down, 0), 'the down arrow was not handled');
        ok(ed.onKey(Gdk.KEY_Return, 0), 'Enter was not handled');
        pump();
        eq(text(), 'read [[Meeting Notes]]', 'text');
        ok(!ed.completer.visible, 'the suggestions are still open');
        eq(buf.get_iter_at_mark(buf.get_insert()).get_offset(), 22, 'cursor after ]]');
    });
    test('suggestions: Esc closes, text without a match closes, an existing ]] is not duplicated', () => {
        setText('');
        type('[[pl');
        ok(ed.completer.visible, 'the suggestions did not appear');
        ok(ed.onKey(Gdk.KEY_Escape, 0), 'Esc was not handled');
        ok(!ed.completer.visible, 'Esc did not close');
        ok(!ed.onKey(Gdk.KEY_Return, 0), 'Enter was held back after the suggestions closed');
        setText('');
        type('[[zzz');
        ok(!ed.completer.visible, 'the suggestions appeared without a match');
        setText('[[]]');
        buf.place_cursor(buf.get_iter_at_offset(2));
        type('Pla');
        ok(ed.completer.visible, 'the suggestions did not appear inside [[]]');
        ed.onKey(Gdk.KEY_Tab, 0);
        pump();
        eq(text(), '[[Plan]]', 'text');
        eq(buf.get_iter_at_mark(buf.get_insert()).get_offset(), 8, 'cursor after ]]');
    });
    test('moving the cursor to an old [[ does not show suggestions', () => {
        setText('[[Idea\n\nx');
        placeAtEnd();
        buf.place_cursor(buf.get_iter_at_offset(4));
        pump();
        ok(!ed.completer.visible, 'the suggestions appeared');
    });

    test('[[ suggestions also work in a plain TextView (the notes field of the card dialog)', () => {
        const view = new Gtk.TextView();
        const win = new Gtk.Window({ child: view, default_width: 400, default_height: 200 });
        win.present();
        pump();
        const completer = attachWikiCompleter(view, () => ['Idea.md', 'Journal/Plan.md']);
        view.grab_focus();
        view.buffer.insert_at_cursor('see [[pla', -1);
        for (let i = 0; i < 10; i++) { pump(); GLib.usleep(5000); }
        ok(completer.visible, 'the suggestions did not appear');
        eq(completer.items, ['Journal/Plan.md']);
        ok(completer.onKey(Gdk.KEY_Return), 'Enter was not handled');
        pump();
        const [s0, e0] = view.buffer.get_bounds();
        eq(view.buffer.get_text(s0, e0, true), 'see [[Plan]]');
        completer.destroy();
        win.destroy();
        pump();
    });

    // --shot-wikilink=<prefix>: save a screenshot of the [[ suggestions in the light and dark themes (<prefix>-light.png, -dark.png).
    // The popover has its own surface, so it is drawn separately and then pasted below the cursor as on screen.
    const shot = optVal('shot-wikilink');
    if (shot) {
        const oldDark = w.dark;
        for (const [dark, name] of [[false, 'light'], [true, 'dark']] as const) {
            w.setDark(dark);
            setText('# Daily Notes\n\nToday covers [[Idea]] and [[Journal/Plan|next week\'s plan]].\n\nFollow-up: ');
            placeAtEnd();
            type('[[no');
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            const page = widgetPixbuf(w.win);
            const pop = widgetPixbuf(ed.completer.popover);
            ok(page && pop, 'the capture failed');
            if (!page || !pop) continue;
            const rect = ed.view.get_iter_location(buf.get_iter_at_mark(buf.get_insert()));
            const [bx, by] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x, rect.y + rect.height);
            const point = ed.view.compute_point(w.win, new Graphene.Point({ x: bx, y: by }));
            const [px, py] = point[0] ? [Math.round(point[1].x), Math.round(point[1].y)] : [0, 0];
            const width = Math.min(pop.get_width(), page.get_width() - px), height = Math.min(pop.get_height(), page.get_height() - py);
            pop.composite(page, px, py, width, height, px, py, 1, 1, GdkPixbuf.InterpType.NEAREST, 255);
            page.savev(`${shot}-${name}.png`, 'png', [], []);
            ed.completer.hide();
        }
        w.setDark(oldDark);
    }

    ed.completer.hide();
    setText('');
    buf.set_modified(false);
    w.file = null;
    w.fileTree.setRoot(null);
    pump();
}
