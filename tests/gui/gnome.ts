// GUI tests: compliance with the GNOME guidelines (adaptive layout, shortcuts dialog, app icon, Adwaita colors).

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gtk from 'gi://Gtk?version=4.0';
import { section, test, eq, ok, optVal, ROOT } from '../framework.js';
import { widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';
import { APP_ID } from '../../src/config.js';
import { hasAdwShortcutsDialog, shortcutEntries, showShortcuts } from '../../src/ui/shortcuts.js';
import { applyTheme } from '../../src/ui/theme.js';
import { _ } from '../../src/i18n.js';
import { childrenOf } from '../../src/gtkutil.js';
import { ImageViewer } from '../../src/ui/imageviewer.js';

const descendants = (widget: Gtk.Widget): Gtk.Widget[] => childrenOf(widget).flatMap(child => [child, ...descendants(child)]);

export function gnomeTests(c: GuiContext): void {
    const { app, w, pump } = c;
    const settle = (n = 40) => { for (let i = 0; i < n; i++) { pump(); GLib.usleep(15000); } };
    const shot = optVal('shot-gnome');

    section('GNOME guidelines');

    test('Ctrl+F shows the search entry in the window', () => {
        w.win.present(); settle();
        w.findBar.open(); settle();
        ok(w.findBar.search_mode_enabled, 'the search bar is not enabled');
        ok(w.findBar._entry.get_mapped() && w.findBar._entry.get_width() > 0, 'the search entry is not visible');
        w.findBar._closeButton.activate(); settle();
        ok(!w.findBar.search_mode_enabled, 'the close button does not close the search bar');
        w.findBar.open(); settle();
        w.findBar.close(); settle();
    });
    test('Find and Replace: counter, replace one, replace all', () => {
        const fb = w.findBar;
        const buf = fb.buffer;
        buf.set_text('foo bar foo Foo', -1); buf.place_cursor(buf.get_start_iter());
        fb.open(true); settle();
        ok(fb._replaceRow.reveal_child, 'the replace row is not shown');
        fb._entry.text = 'foo'; settle();
        ok(fb._count.label.endsWith('3'), `counter: ${fb._count.label}`);
        fb._replaceEntry.text = 'x';
        fb._replaceOne.activate(); settle();
        fb.replaceCurrent(); settle();
        fb._caseButton.active = true; settle();
        fb.replaceEverything(); settle();
        const text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), false);
        eq(text, 'x bar x Foo', 'two replaced one by one, then Replace All with Match Case leaves Foo');
        fb._caseButton.active = false; settle();
        fb.replaceEverything(); settle();
        eq(buf.get_text(buf.get_start_iter(), buf.get_end_iter(), false), 'x bar x x', 'Replace All');
        buf.set_text('', -1); buf.set_modified(false);
        fb._caseButton.active = false; fb._expand.active = false; fb.close(); settle();
    });
    test('the window icon and the About dialog use the App ID', () => {
        eq(APP_ID, 'com.ekaput.Markwork');
        eq(w.win.get_icon_name(), APP_ID);
        const theme = Gtk.IconTheme.get_for_display(w.win.get_display());
        ok(theme.has_icon(APP_ID), 'the app icon was not found in the icon theme (dist/icons)');
    });

    test('untranslated text is shown in the source language', () => {
        eq(_('Save'), 'Save');
    });

    test('a narrow window collapses the Assistant panel, then the sidebar becomes floating', () => {
        const wasSidebar = w.settings.sidebar, wasChat = w.settings.chat;
        w.settings.sidebar = true; w.settings.chat = true;
        w.win.set_default_size(1100, 700); settle();
        ok(!w.chatSplit.collapsed && !w.sidebar.widget.collapsed, 'wide window: the panels must not collapse');
        w.win.set_default_size(760, 700); settle();
        ok(w.chatSplit.collapsed, 'below 900sp the Assistant panel must collapse');
        ok(!w.sidebar.widget.collapsed, 'at 760 px the sidebar is still docked');
        w.win.set_default_size(480, 700); settle();
        ok(w.chatSplit.collapsed && w.sidebar.widget.collapsed, 'below 600sp both panels collapse');
        if (shot) widgetPixbuf(w.win)?.savev(`${shot}-narrow.png`, 'png', [], []);
        ok(!w.chatSplit.show_sidebar && !w.sidebar.widget.show_sidebar, 'the panels are closed when collapsing');
        w.settings.sidebar = true; settle();
        ok(w.sidebar.widget.show_sidebar, 'while collapsed the sidebar can still be opened (floating)');
        w.win.set_default_size(1100, 700); settle();
        ok(!w.chatSplit.collapsed && !w.sidebar.widget.collapsed, 'the window widened again: the panels are docked again');
        eq([w.settings.sidebar, w.settings.chat], [true, true], 'the panel settings from before collapsing were restored');
        // A closed panel does not reopen after the window narrows and then widens.
        w.settings.chat = false;
        w.win.set_default_size(760, 700); settle();
        w.win.set_default_size(1100, 700); settle();
        eq(w.chatSplit.show_sidebar, false, 'the closed Assistant panel stays closed');
        w.settings.sidebar = wasSidebar; w.settings.chat = wasChat; settle();
    });

    test('the shortcuts dialog is built from the accels of the installed actions', () => {
        const entries = shortcutEntries(app);
        const all = new Map(entries.flatMap(([, items]) => items));
        eq(all.get('Save'), '<Control>s');
        eq(all.get('Keyboard Shortcuts'), '<Control>question');
        ok(entries.every(([, items]) => items.length > 0), 'an empty section was shown too');
        const shown = showShortcuts(app, w.win);
        settle(20);
        ok(w.win.get_visible_dialog() === shown, 'the shortcuts dialog is not shown');
        if (!hasAdwShortcutsDialog()) {
            const rows = descendants(shown).filter(x => x instanceof Adw.ActionRow).map(x => (x as Adw.ActionRow).title);
            ok(rows.includes('Save') && rows.includes('Command Palette'), `shortcuts dialog contents: ${rows.slice(0, 5).join(', ')}…`);
        }
        if (shot) widgetPixbuf(w.win)?.savev(`${shot}-shortcuts.png`, 'png', [], []);
        shown.force_close();
        for (let i = 0; i < 50 && w.win.get_visible_dialog(); i++) settle(1);
        settle(10);
    });

    test('the editor palette uses the default Adwaita accent when the system provides no accent', () => {
        const light = applyTheme(false), dark = applyTheme(true);
        const style = Adw.StyleManager.get_default() as Adw.StyleManager & { get_system_supports_accent_colors?(): boolean };
        if (!style.get_system_supports_accent_colors?.()) eq([light.accent, dark.accent], ['#1c71d8', '#78aeed']);
        else ok(/^#[0-9a-f]{6}$/.test(light.accent), `invalid system accent: ${light.accent}`);
        w.setDark(false);
    });

    if (shot) {
        test('screenshot of the image viewer (Adw.Window)', () => {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(GLib.build_filenamev([ROOT, 'tests', 'samples', 'images', 'example.png']));
            const viewer = new ImageViewer(w.win, pixbuf, 'example.png');
            viewer.show(); settle();
            widgetPixbuf(viewer.window)?.savev(`${shot}-image.png`, 'png', [], []);
            viewer.window.destroy(); settle(5);
        });
        test('screenshot of the light and dark themes', () => {
            w.setDark(false); settle();
            widgetPixbuf(w.win)?.savev(`${shot}-light.png`, 'png', [], []);
            w.setDark(true); settle();
            widgetPixbuf(w.win)?.savev(`${shot}-dark.png`, 'png', [], []);
            w.setDark(false); settle();
        });
    }
}
