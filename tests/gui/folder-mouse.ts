// Drag a file/folder in the file tree with real X11 input (XTest).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { tmp, section, test, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
import { screenPoint } from '../widgets.js';
import type { GuiContext } from './context.js';

export function folderMouseTests(c: GuiContext): void {
    const { w, pump } = c;
    const ft = w.fileTree;
    section('Drag files in the tree with the X11 mouse (XTest)');
    const input = new MouseInput();
    const settle = () => { for (let i = 0; i < 12; i++) { pump(); GLib.usleep(10000); } };
    const move = (x: number, y: number) => { input.move(x, y); settle(); };
    const proj = GLib.build_filenamev([tmp, 'drag']);
    const abs = (...p: string[]) => GLib.build_filenamev([proj, ...p]);
    const exists = (path: string) => GLib.file_test(path, GLib.FileTest.EXISTS);
    const mk = (rel: string) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(abs(rel)), 0o755);
        GLib.file_set_contents(abs(rel), '# x');
    };
    let held = false;
    try {
        mk('a.md'); mk('target/b.md'); mk('other/c.md');
        w.win.set_default_size(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        w.openFolder(proj);
        settle();

        // A point on the widget in screen coordinates.
        const onScreen = (widget: Gtk.Widget, x: number, y: number) => screenPoint(widget, x, y, (xid, sx, sy) => input.toRoot(xid, sx, sy));
        const rowPoint = (name: string): [number, number] => {
            ok(ft.list.get_mapped(), 'the tree is not shown yet');
            const point = ft.rowPoint(abs(name));
            ok(point, `row ${name} does not exist`);
            return onScreen(ft.list, point![0], point![1]);
        };
        const drag = (from: [number, number], to: [number, number]) => {
            move(...from);
            input.down(); held = true; settle();
            move(from[0] + 12, from[1] + 6);
            for (let i = 1; i <= 8; i++) move(from[0] + 12 + (to[0] - from[0] - 12) * i / 8, from[1] + 6 + (to[1] - from[1] - 6) * i / 8);
            input.up(); held = false; settle();
        };

        test('dragging a file onto a folder moves it into that folder', () => {
            drag(rowPoint('a.md'), rowPoint('target'));
            ok(exists(abs('target', 'a.md')) && !exists(abs('a.md')), 'the file did not move');
        });
        test('drag a folder onto another folder', () => {
            drag(rowPoint('other'), rowPoint('target'));
            ok(exists(abs('target', 'other', 'c.md')) && !exists(abs('other')), 'the folder did not move');
        });
        test('dragging a file onto the tree title moves it out to the root', () => {
            const label = ft.widget.get_first_child()!;
            ok(label.get_mapped(), 'the title is not visible');
            const titlePoint = onScreen(label, 20, label.get_allocated_height() / 2);
            ft.expand(abs('target'));
            settle();
            const found = rowPoint('target/b.md');
            drag(found, titlePoint);
            ok(exists(abs('b.md')) && !exists(abs('target', 'b.md')), 'the file did not move out to the root');
        });
    } finally {
        if (held) input.up();
        input.close();
        w.session.files.setRoot(null);
    }
}
