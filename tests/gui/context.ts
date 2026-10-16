// The window and helpers shared by all GUI tests.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

import { ROOT, tmp } from '../framework.js';
import type { ViewOption as Option } from '../../src/app/commands.js';
import { MainWindow } from '../../src/window.js';
import type { TagName } from '../../src/editor/tags.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { inMemorySettings } from '../../src/platform/gjs/settings.js';

export interface GuiContext {
    app: Adw.Application;
    w: MainWindow;
    ed: MainWindow['editor'];
    buf: MainWindow['editor']['buffer'];
    pump: () => void;
    text: () => string;
    setText: (t: string) => void;
    cursorTo: (line: number, col?: number) => void;
    offsetIn: (s: string, needle: string) => number;
    hidden: (off: number) => boolean;
    tagAt: (off: number, name: TagName) => boolean;
    key: (keyval: number, state?: Gdk.ModifierType) => void;
    action: (name: string | Option) => void;
    clickAt: (off: number) => boolean;
    imgDir: string;
    samplePath: string;
    images: () => MainWindow['editor']['images']['blocks'];
    waitImages: () => void;
    diagrams: () => MainWindow['editor']['mermaid']['blocks'];
    waitMermaid: () => void;
}

export function createContext(app: Adw.Application): GuiContext {
    // Autosave off: many tests open real files (the sample document, README) and then edit them.
    const settings = inMemorySettings({ welcomed: true, home: false, dark: false, autosave: false });
    const w = new MainWindow(app, settings, null);
    const ed = w.editor;
    const buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 200 && ctx.pending(); i++) ctx.iteration(false); };
    const text = () => { const [s, e] = buf.get_bounds(); return buf.get_text(s, e, true); };
    const setText = (t: string) => { ed.setText(t); pump(); };
    const cursorTo = (line: number, col = 0) => {
        const it = iterAtLine(buf, line);
        if (col < 0) it.forward_to_line_end(); else it.forward_chars(col);
        buf.place_cursor(it);
        pump();
    };
    // Position (code points) of the needle text inside s.
    const offsetIn = (s: string, needle: string) => {
        const i = s.indexOf(needle);
        if (i < 0) throw new Error(`text ${JSON.stringify(needle)} not found`);
        return Array.from(s.slice(0, i)).length;
    };
    const hidden = (off: number) => buf.get_iter_at_offset(off).has_tag(ed.tags.hidden);
    const tagAt = (off: number, name: TagName) => buf.get_iter_at_offset(off).has_tag(ed.tags[name]);
    const key = (keyval: number, state = 0 as Gdk.ModifierType) => {
        const handled = ed.onKey(keyval, state);
        if (!handled) buf.insert_at_cursor(keyval === Gdk.KEY_Return ? '\n' : '', -1);
        pump();
    };
    const action = (name: string | Option) => { app.lookup_action(name)!.activate(null); pump(); };
    const clickAt = (off: number) => {
        const rect = ed.view.get_iter_location(buf.get_iter_at_offset(off));
        const [x, y] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x + 2, rect.y + rect.height / 2);
        const handled = ed.onClick(1, x, y, 0);
        pump();
        return handled;
    };

    pump();
    // The test image folder (created by the Image tests) and the sample document.
    const imgDir = GLib.build_filenamev([tmp, 'images']);
    const samplePath = GLib.build_filenamev([ROOT, 'tests', 'samples', 'all-formats.md']);
    const images = () => ed.images.blocks;
    // Wait until all images have finished loading.
    const waitImages = () => {
        for (let i = 0; i < 200 && images().some(b => b.items.some(it => !it.entry || it.entry.status === 'loading')); i++) {
            pump();
            GLib.usleep(10000);
        }
        pump();
    };

    const diagrams = () => ed.mermaid.blocks;
    // Wait until all diagrams have finished rendering (the first time can take a few seconds: WebKit is started).
    const waitMermaid = () => {
        for (let i = 0; i < 3000 && diagrams().some(b => b.busy || b.timer); i++) {
            pump();
            GLib.usleep(10000);
        }
        pump();
    };

    return { app, w, ed, buf, pump, text, setText, cursorTo, offsetIn, hidden, tagAt, key, action, clickAt, imgDir, samplePath, images, waitImages, diagrams, waitMermaid };
}
