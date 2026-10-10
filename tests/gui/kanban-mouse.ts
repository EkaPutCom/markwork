// Testing input from the X11 server: it does not call the drag handlers directly.
import GLib from 'gi://GLib';
import System from 'system';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { parseBoard } from '../../src/markdown/kanban.js';
import { readTextFile } from '../../src/files.js';
import { tmp, section, test, eq, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
import { countPointerEvents, descendants, screenPoint } from '../widgets.js';
import type { GuiContext } from './context.js';

const BOARD = '---\nlayout: board\n---\n\n## Source\n\n- [ ] Card A 🎉\n  Note A\n- [ ] Card B\n\n## Target\n\n- [ ] Card C\n\n## Empty\n';

export function kanbanMouseTests(c: GuiContext): void {
    const { w, buf, pump, text, action } = c;
    const kb = w.board;
    section('Drag cards with the X11 mouse (XTest)');
    ok(Gdk.Display.get_default()?.get_name().includes(':'), 'The tests require the X11 backend (GDK_BACKEND=x11).');
    const input = new MouseInput();
    const settle = () => {
        // pump() runs a nested main loop. Finish the GJS GC before entering
        // that loop so the finalization of widgets discarded when the board is redrawn is not delayed.
        System.gc();
        for (let i = 0; i < 12; i++) { pump(); GLib.usleep(10000); }
    };
    const move = (x: number, y: number) => { input.move(x, y); settle(); };
    const point = (widget: Gtk.Widget, y: number): readonly [number, number] => {
        ok(widget.get_mapped(), 'The target widget is not shown yet.');
        return screenPoint(widget, widget.get_allocated_width() / 2, y, (xid, x, wy) => input.toRoot(xid, x, wy));
    };
    const path = GLib.build_filenamev([tmp, 'mouse-kanban.md']);
    let original: readonly [number, number];
    try { original = input.position(); }
    catch (error) { input.close(); throw error; }
    let edits = 0;
    const dialogs = kb.dialogs;
    kb.dialogs = { ...dialogs, editCard: () => { edits++; return null; } };
    const reset = (content = BOARD) => {
        GLib.file_set_contents(path, content);
        w.load(path);
        w.win.set_default_size(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        settle();
        kb.scroller.get_hadjustment().set_value(0);
        settle();
        edits = 0;
    };
    let held = false;
    const drag = (source: Gtk.Box, destination: () => readonly [number, number]) => {
        const start = point(source, 12);
        const target = destination();
        // The counter in the CAPTURE phase sees the event before the card gesture handles it.
        const events = countPointerEvents(source);
        try {
            move(...start);
            input.down(); held = true; settle();
            ok(events.presses > 0, 'The XTest button press was not received by the card in GTK.');
            // Pass the drag threshold before heading to the target, so the click is not treated as an edit.
            move(start[0] + 12, start[1]);
            ok(kb.dragging, 'GTK received the press, but the drag did not start.');
            const ghost = kb['drag']!.ghost;
            const placeholder = kb['drag']!.placeholder;
            ok(ghost.get_parent(), 'The ghost card is not shown.');
            for (let i = 1; i <= 10; i++) {
                move(start[0] + 12 + (target[0] - start[0] - 12) * i / 10,
                    start[1] + (target[1] - start[1]) * i / 10);
            }
            // The drop marker changes the layout during the motion. Follow the target card that is
            // visible now, like a user dragging by hand.
            for (let i = 0; i < 3; i++) move(...destination());
            input.up(); held = false; settle();
            ok(events.motions > 0 && events.releases > 0, 'Motion/release events were not received by GTK.');
            ok(!kb.dragging, 'The drag is still active after the button was released.');
            ok(!ghost.get_parent(), 'The ghost card has not been cleaned up.');
            ok(!placeholder.get_parent(), 'The drop marker has not been cleaned up.');
            eq(edits, 0, 'dragging did not open the edit dialog');
            eq(parseBoard(text()), kb.getBoard(), 'Markdown matches the board');
        } finally {
            if (held) { input.up(); held = false; settle(); }
            events.stop();
        }
    };
    try {
        test('the mouse moves a card between lists, keeps the notes, undo/redo and file', () => {
            reset();
            const target = kb.columns[1].cards[0];
            drag(kb.columns[0].cards[0], () => point(target, 4));
            eq(kb.cardTexts(0), ['Card B']);
            eq(kb.cardTexts(1), ['Card A 🎉', 'Card C']);
            eq(kb.getBoard().columns[1].cards[0].notes, ['Note A']);
            ok(buf.get_modified(), 'The document was not marked as modified.');
            const moved = text();
            action('undo'); settle(); eq(text(), BOARD, 'one undo restored the document');
            action('redo'); settle(); eq(text(), moved, 'redo restored the move');
            ok(w.save(), 'Save failed.');
            eq(readTextFile(path), moved, 'saved result');
        });
        test('the mouse reorders cards within the same list', () => {
            reset();
            const second = kb.columns[0].cards[1];
            drag(kb.columns[0].cards[0], () => point(second, second.get_allocated_height() - 4));
            eq(kb.cardTexts(0), ['Card B', 'Card A 🎉']);
        });
        test('the mouse drops a card into an empty list', () => {
            reset();
            drag(kb.columns[0].cards[0], () => point(kb.columns[2].cardsBox, 24));
            eq(kb.cardTexts(2), ['Card A 🎉']);
            eq(kb.cardTexts(0), ['Card B']);
        });
        test('the mouse drops at the original position without changing the Markdown', () => {
            reset();
            const source = kb.columns[0].cards[0];
            drag(source, () => point(source, 4));
            eq(text(), BOARD);
            ok(!buf.get_modified(), 'Dragging back to the origin marked the document as modified.');
        });
        test('a mouse click without dragging opens the edit dialog once', () => {
            reset();
            move(...point(kb.columns[0].cards[0], 12));
            input.down(); held = true; settle();
            input.up(); held = false; settle();
            eq(edits, 1, 'edit dialog');
            eq(text(), BOARD);
        });
        test('a mouse click on a field chip opens its popover, not the edit dialog, and does not start a drag', () => {
            reset('---\nlayout: board\nfields:\n  prioritas: select(tinggi, sedang, rendah)\n---\n\n## Plan\n\n- [ ] Card [prioritas:: sedang]\n');
            const chip = descendants(kb.columns[0].cards[0]).find((x): x is Gtk.Label => x instanceof Gtk.Label && x.label === 'sedang')!;
            ok(chip, 'the chip is not shown');
            move(...point(chip, chip.get_allocated_height() / 2));
            input.down(); held = true; settle();
            input.up(); held = false; settle();
            eq(edits, 0, 'the card dialog did not open');
            ok(!kb.dragging, 'no drag started');
            ok(descendants(kb.widget).some(x => x instanceof Gtk.Popover && x.get_mapped()), 'the popover is shown');
        });
        test('a mouse click on a field chip in an inbox row opens its popover, not the note dialog', () => {
            reset('---\nlayout: list\nfields:\n  tipe: select(ide, bacaan)\n---\n\n# Inbox\n\n- Satu [tipe:: ide]\n');
            let noteEdits = 0;
            const inboxDialogs = w.inbox.dialogs;
            w.inbox.dialogs = { ...inboxDialogs, editNote: () => { noteEdits++; return null; } };
            try {
                const chip = descendants(w.inbox.widget).find((x): x is Gtk.Label => x instanceof Gtk.Label && x.label === 'ide')!;
                ok(chip, 'the chip is not shown');
                move(...point(chip, chip.get_allocated_height() / 2));
                input.down(); held = true; settle();
                input.up(); held = false; settle();
                eq(noteEdits, 0, 'the note dialog did not open');
                ok(descendants(w.inbox.widget).some(x => x instanceof Gtk.Popover && x.get_mapped()), 'the popover is shown');
            } finally {
                w.inbox.dialogs = inboxDialogs;
            }
        });
    } finally {
        try {
            if (held) input.up();
        } finally {
            kb.dialogs = dialogs;
            buf.set_modified(false);
            w.file = null;
            try { move(...original); }
            finally { input.close(); }
        }
    }
}
