// GUI tests: real libadwaita dialogs (Adw.Dialog and Adw.AlertDialog), not fakes.
// Dialogs answer through a Promise; the interaction is scheduled from a timer while settle() waits for the answer.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import { descendants, whenDialogReady } from '../widgets.js';
import { section, test, eq, ok, settle } from '../framework.js';
import { PreferencesDialog } from '../../src/ui/preferences.js';
import { CommandPalette } from '../../src/ui/palette.js';
import { confirmDialog, editCardDialog, editNoteDialog, findDialog, promptDialog } from '../../src/ui/dialogs.js';
import { parseSchema } from '../../src/markdown/fields.js';
import { editSchemaDialog } from '../../src/ui/schemadialog.js';
import type { GuiContext } from './context.js';

export function dialogTests(c: GuiContext): void {
    const { w } = c;
    section('libadwaita dialogs');

    // An answered dialog must really leave: one left open covers the window for the tests after this one,
    // so it is closed by force here and the test that left it fails.
    const closed = (): boolean => {
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
        const left = w.win.get_visible_dialog();
        left?.force_close();
        return !left;
    };
    // Run `act` once the dialog `title` is ready for an answer, then return the result of `open`.
    const drive = <T>(title: string, open: () => Promise<T>, act: (dialog: Adw.Dialog) => void): T => {
        whenDialogReady(() => findDialog(title), act);
        const value = settle(open());
        ok(closed(), `the "${title}" dialog closed`);
        return value;
    };
    const close = (dialog: Adw.Dialog): void => { dialog.close(); };
    const button = (root: Gtk.Widget, label: string) => descendants(root).find(x => x instanceof Gtk.Button && x.label === label) as Gtk.Button;

    test('prompt: the OK button returns the input, Enter in the entry also accepts', () => {
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'New name', value: 'a' }), d => {
            const entry = descendants(d).find(x => x instanceof Gtk.Entry) as Gtk.Entry;
            entry.set_text('new');
            button(d, 'OK').emit('clicked');
        }), 'new');
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'New name', value: 'via enter' }), d => {
            (descendants(d).find(x => x instanceof Gtk.Entry) as Gtk.Entry).emit('activate');
        }), 'via enter', 'Enter runs the default button');
    });

    test('edit card with a schema: select = drop-down, other fields = entries; a value that does not fit blocks saving; other fields are kept', () => {
        const schema = parseSchema('---\nfields:\n  prioritas: select(tinggi, sedang, rendah)\n  progres: progress\n---\n').fields;
        const seen: { selected?: number; blocked?: boolean } = {};
        const result = drive('Edit Card', () => editCardDialog(w.win, { text: 'Task #x [prioritas:: sedang] [owner:: Eka]', notes: [] }, 'Edit Card', undefined, schema), d => {
            const dropdown = descendants(d).find(x => x instanceof Gtk.DropDown) as Gtk.DropDown;
            seen.selected = dropdown.selected;
            dropdown.selected = 1;
            const progress = descendants(d).find(x => x instanceof Gtk.Entry && x.placeholder_text === '3/5 or 60%') as Gtk.Entry;
            progress.set_text('nope');
            button(d, 'Save').emit('clicked');
            seen.blocked = progress.has_css_class('error') && !!findDialog('Edit Card');
            progress.set_text('3/5');
            button(d, 'Save').emit('clicked');
        });
        eq(seen, { selected: 2, blocked: true }, 'the current option is selected, and the dialog stayed open on a bad value');
        eq(result?.text, 'Task #x [prioritas:: tinggi] [owner:: Eka] [progres:: 3/5]', 'the other field is kept, the new values are written');
    });

    test('edit note with a schema: fields get controls, the capture time stays as it was', () => {
        const schema = parseSchema('---\nfields:\n  tipe: select(ide, bacaan)\n---\n').fields;
        const result = drive('Edit Note', () => editNoteDialog(w.win, { text: 'Idea [created:: 2026-10-07 14:22]', notes: [] }, 'Edit Note', undefined, [{ key: 'created', type: 'date', multiple: false, options: [] }, ...schema]), d => {
            const dropdown = descendants(d).find(x => x instanceof Gtk.DropDown) as Gtk.DropDown;
            dropdown.selected = 2;
            button(d, 'Save').emit('clicked');
        });
        eq(result?.text, 'Idea [created:: 2026-10-07 14:22] [tipe:: bacaan]');
    });

    test('fields dialog: a new field gets a name, a type, and options; a taken name blocks saving; existing fields are kept in order', () => {
        const existing = parseSchema('---\nfields:\n  prio: select(a, b)\n---\n').fields;
        const seen: Record<string, unknown> = {};
        const result = drive('Fields', () => editSchemaDialog(w.win, { fields: existing, reserved: ['due'], uses: (key, option) => (key === 'prio' && option === 'a' ? 3 : 0) }), d => {
            const labels = () => descendants(d).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.label);
            // the last one: the new field is at the end, and every select field has its own entry for adding an option
            const entryBy = (placeholder: string) => descendants(d).filter((x): x is Gtk.Entry => x instanceof Gtk.Entry && x.placeholder_text === placeholder).at(-1)!;
            seen.uses = labels().includes('3 notes');
            button(d, '+ Add field').emit('clicked'); c.pump();
            entryBy('Field name').set_text('due');
            button(d, 'Save').emit('clicked');
            seen.blocked = entryBy('Field name').has_css_class('error') && !!findDialog('Fields');
            entryBy('Field name').set_text('estimasi');
            (descendants(d).find(x => x instanceof Gtk.DropDown) as Gtk.DropDown).selected = 2; c.pump();   // Choice
            const option = entryBy('Add an option…');
            option.set_text('kecil'); option.emit('activate'); c.pump();
            entryBy('Add an option…').set_text('besar'); entryBy('Add an option…').emit('activate'); c.pump();
            seen.options = descendants(d).filter((x): x is Gtk.Entry => x instanceof Gtk.Entry && ['kecil', 'besar'].includes(x.text)).map(e => e.text);
            button(d, 'Save').emit('clicked');
        });
        eq(seen, { uses: true, blocked: true, options: ['kecil', 'besar'] }, 'usage is shown, the dialog stayed open on a bad name, the options were added');
        eq(result?.map(f => [f.key, f.type, f.options]), [['prio', 'select', ['a', 'b']], ['estimasi', 'select', ['kecil', 'besar']]]);
    });

    test('fields dialog: options and fields can be moved and removed; Cancel returns null', () => {
        const existing = parseSchema('---\nfields:\n  one: select(a, b, c)\n  two: text\n---\n').fields;
        const result = drive('Fields', () => editSchemaDialog(w.win, { fields: existing, reserved: [], uses: () => 0 }), d => {
            const moveDown = descendants(d).filter((x): x is Gtk.Button => x instanceof Gtk.Button && x.tooltip_text === 'Move down');
            moveDown[0].emit('clicked'); c.pump();   // the first field goes below the second
            const remove = descendants(d).filter((x): x is Gtk.Button => x instanceof Gtk.Button && x.tooltip_text === 'Remove option');
            remove[0].emit('clicked'); c.pump();     // option "a" of the field that is now second
            button(d, 'Save').emit('clicked');
        });
        eq(result?.map(f => [f.key, f.options]), [['two', []], ['one', ['b', 'c']]]);
        eq(drive('Fields', () => editSchemaDialog(w.win, { fields: existing, reserved: [], uses: () => 0 }), d => button(d, 'Cancel').emit('clicked')), null);
    });

    test('prompt: Cancel and Escape (close) return null', () => {
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'x', value: 'a' }), d => button(d, 'Cancel').emit('clicked')), null);
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'x', value: 'a' }), close), null);
    });

    // Do not answer the same dialog twice.
    let answered: Adw.Dialog | null = null;
    test('confirm: the Delete button is marked destructive; Cancel and closing = false', () => {
        const pick = (response: string): boolean => {
            whenDialogReady(() => {
                const dialog = w.win.get_visible_dialog();
                return dialog instanceof Adw.AlertDialog && dialog !== answered ? dialog : null;
            }, dialog => {
                answered = dialog;
                if (response === 'close') dialog.close();
                else button(dialog, response).emit('clicked');
            });
            const value = settle(confirmDialog(w.win, 'Delete this card?', 'This cannot be undone.'));
            ok(closed(), `the confirm dialog closed after ${response}`);
            return value;
        };
        eq(pick('Delete'), true, 'Delete');
        eq(pick('Cancel'), false, 'Cancel');
        eq(pick('close'), false, 'closed');
    });

    test('preferences: the switch is bound to GSettings and the window applies it, and vice versa', () => {
        const settleP = () => { for (let i = 0; i < 20; i++) { c.pump(); GLib.usleep(10000); } };
        const wasFocus = w.settings.focus, wasDark = w.dark;
        c.action('preferences'); settleP();
        const dialog = w.win.get_visible_dialog();
        ok(dialog instanceof PreferencesDialog, 'the preferences dialog is not shown');
        const rows = descendants(dialog as Adw.Dialog);
        const switchRow = (title: string) => rows.find(x => x instanceof Adw.SwitchRow && x.title === title) as Adw.SwitchRow;
        const comboRow = (title: string) => rows.find(x => x instanceof Adw.ComboRow && x.title === title) as Adw.ComboRow;

        switchRow('Focus mode').active = true; settleP();
        eq(w.settings.focus, true, 'GSettings follows the switch');
        eq(w.editor.modes.focus, true, 'the editor follows GSettings');
        w.settings.focus = false; settleP();
        eq(switchRow('Focus mode').active, false, 'the switch follows GSettings');
        eq(w.editor.modes.focus, false, 'the editor follows GSettings (reverse direction)');

        comboRow('Color scheme').selected = 2; settleP();
        eq(w.settings.dark, true, 'the dark theme is saved');
        eq(w.dark, true, 'the window uses the dark theme');
        comboRow('Color scheme').selected = 1; settleP();
        eq(w.dark, false, 'the window went back to light');

        comboRow('Model').selected = 1; settleP();
        eq(w.settings.chatModel, 'deepseek-v4-pro', 'the assistant model is saved');
        eq(w.chat.model, 'deepseek-v4-pro', 'the assistant panel follows');
        w.settings.chatModel = 'deepseek-flash'; settleP();

        (dialog as Adw.Dialog).force_close();
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
        w.settings.focus = wasFocus;
        w.setDark(wasDark);
    });

    test('command palette: the action list can be filtered, and Enter runs the same Gio.Action', () => {
        const settleP = () => { for (let i = 0; i < 20; i++) { c.pump(); GLib.usleep(10000); } };
        const wasBoard = w.boardMode;
        if (wasBoard) w.toggleBoardView(false);   // on the kanban board the text editor actions are disabled and not shown
        c.action('command-palette'); settleP();
        const palette = w.win.get_visible_dialog() as CommandPalette;
        ok(palette instanceof CommandPalette, 'the palette is not shown');
        const search = descendants(palette).find(x => x instanceof Gtk.SearchEntry) as Gtk.SearchEntry;
        const all = palette.visibleCount;
        ok(all > 30, `too few commands: ${all}`);
        search.set_text('focus'); settleP();
        eq(palette.visibleCount, 1, 'filter "focus"');
        search.set_text('table align'); settleP();
        eq(palette.visibleCount, 3, 'all words must match, in any order');
        search.set_text('no-such-command'); settleP();
        eq(palette.visibleCount, 0, 'no results');
        search.set_text('focus mode'); settleP();
        const before = w.settings.focus;
        search.emit('activate'); settleP();
        eq(w.settings.focus, !before, 'the action ran');
        ok(closed(), 'the palette closed after choosing');
        w.settings.focus = before; settleP();

        // A disabled action is not shown in the palette.
        const countInPalette = (): number => {
            c.action('command-palette'); settleP();
            const p = w.win.get_visible_dialog() as CommandPalette;
            const count = p.visibleCount;
            p.force_close(); settleP();
            return count;
        };
        const bold = w.app.lookup_action('bold') as Gio.SimpleAction;
        const enabledCount = countInPalette();
        bold.set_enabled(false);
        eq(countInPalette(), enabledCount - 1, 'the disabled action is not shown');
        bold.set_enabled(true);
        if (wasBoard) w.toggleBoardView(true);
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
    });

    // The tests after this (mouse) must not start while a dialog is still animating closed and holding the input.
    for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
}
