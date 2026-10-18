// Dragging rows and columns of the CSV tab with the X11 mouse (XTest): the real press, motion, and release reach GTK, and the
// drag source and drop target handle them. The logic of a drop is also tested without a pointer (gui/csv.ts).

import GLib from 'gi://GLib';
import System from 'system';
import Gdk from 'gi://Gdk?version=4.0';
import type Gtk from 'gi://Gtk?version=4.0';
import { tmp, section, test, eq, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
import { screenPoint } from '../widgets.js';
import type { GuiContext } from './context.js';

const CSV = 'a,b,c\n1,x,10\n2,y,20\n3,z,30\n';

export function csvMouseTests(c: GuiContext): void {
    const { w, pump, text, action } = c;
    section('Drag CSV rows and columns with the X11 mouse (XTest)');
    ok(Gdk.Display.get_default()?.get_name().includes(':'), 'The tests require the X11 backend (GDK_BACKEND=x11).');
    const input = new MouseInput();
    const settle = () => {
        System.gc();
        for (let i = 0; i < 12; i++) { pump(); GLib.usleep(10000); }
    };
    const move = (x: number, y: number) => { input.move(x, y); settle(); };
    const point = (widget: Gtk.Widget, x: number, y: number): readonly [number, number] => {
        ok(widget.get_mapped(), 'The target widget is not shown yet.');
        return screenPoint(widget, x, y, (xid, px, py) => input.toRoot(xid, px, py));
    };
    const path = GLib.build_filenamev([tmp, 'mouse-csv.csv']);
    let original: readonly [number, number];
    try { original = input.position(); }
    catch (error) { input.close(); throw error; }
    let held = false;
    const reset = () => {
        GLib.file_set_contents(path, CSV);
        w.load(path);
        w.win.set_default_size(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        settle();
    };
    const drag = (handle: Gtk.Widget, destination: () => readonly [number, number]) => {
        const start = point(handle, handle.get_width() / 2, handle.get_height() / 2);
        try {
            move(...start);
            input.down(); held = true; settle();
            // Pass the drag threshold, then head for the target.
            move(start[0] + 14, start[1] + 14);
            ok(w.csv['drag'] !== null, 'GTK received the press, but the drag did not start.');
            const target = destination();
            for (let i = 1; i <= 10; i++) move(start[0] + 14 + (target[0] - start[0] - 14) * i / 10, start[1] + 14 + (target[1] - start[1] - 14) * i / 10);
            for (let i = 0; i < 2; i++) move(...destination());
            input.up(); held = false; settle();
            ok(w.csv['drag'] === null, 'The drag is still active after the button was released.');
            ok(w.csv['mark'] === null, 'A drop line is left on screen.');
        } finally {
            if (held) { input.up(); held = false; settle(); }
        }
    };
    try {
        test('the mouse drags a row by its number to the end of the table, and undo puts it back', () => {
            reset();
            const number = w.csv['bound'].get(0)!.number;
            const last = w.csv['bound'].get(2)!.box;
            drag(number, () => point(last, last.get_width() / 2, last.get_height() - 4));
            eq(text(), 'a,b,c\n2,y,20\n3,z,30\n1,x,10\n');
            action('undo'); settle();
            eq(text(), CSV);
        });
        test('the mouse drags a row up, and dropping it next to itself changes nothing', () => {
            reset();
            const third = w.csv['bound'].get(2)!;
            const first = w.csv['bound'].get(0)!.box;
            drag(third.number, () => point(first, first.get_width() / 2, 4));
            eq(text(), 'a,b,c\n3,z,30\n1,x,10\n2,y,20\n');
            reset();
            const second = w.csv['bound'].get(1)!;
            drag(second.number, () => point(second.box, second.box.get_width() / 2, second.box.get_height() / 2 - 2));
            eq(text(), CSV);
        });
        test('the mouse drags a column by its grip to the right of the last one, and over the rows', () => {
            reset();
            const grip = w.csv['headBoxes'][0].get_first_child()!;
            const lastHead = w.csv['headBoxes'][2];
            drag(grip, () => point(lastHead, lastHead.get_width() - 4, lastHead.get_height() / 2));
            eq(text(), 'b,c,a\nx,10,1\ny,20,2\nz,30,3\n');
            action('undo'); settle();
            eq(text(), CSV);
            const rowCell = w.csv.entryAt(2, 0)!;
            drag(w.csv['headBoxes'][2].get_first_child()!, () => point(rowCell, 6, rowCell.get_height() / 2));
            eq(text(), 'c,a,b\n10,1,x\n20,2,y\n30,3,z\n', 'dropped on the left half of a cell of the first column');
        });
    } finally {
        try {
            if (held) input.up();
        } finally {
            c.buf.set_modified(false);
            w.file = null;
            try { move(...original); }
            finally { input.close(); }
        }
    }
}
