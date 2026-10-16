// Keyboard shortcut list dialog (Ctrl+?), built from the actions registered in actions.ts:
// labels from COMMAND_LABELS, keys from the accels actually installed, so this list
// cannot differ from the shortcuts in effect.
//
// libadwaita ≥ 1.8 (GNOME 49+) has Adw.ShortcutsDialog, the replacement for Gtk.ShortcutsWindow, which has been
// deprecated since GTK 4.18. In older libadwaita (e.g. 1.5 on Ubuntu 24.04) the contents are shown
// as an Adw.Dialog containing a list of rows with Gtk.ShortcutLabel. Gtk.ShortcutsWindow is not used:
// besides being deprecated, in GTK 4.14 its internal labels trigger the Gtk-WARNING "reported min width -4".

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { COMMAND_LABELS } from '../app/commands.js';
import { _ } from '../i18n.js';

// Dialog sections and the actions in them, in the order displayed.
export const SHORTCUT_SECTIONS = (): [title: string, actions: string[]][] => [
    [_('Files'), ['new', 'open', 'open-folder', 'save', 'save-as', 'export-html']],
    [_('Tab'), ['home', 'next-tab', 'prev-tab', 'close-tab']],
    [_('Journal'), ['journal', 'journal-capture']],
    [_('Editing'), ['undo', 'redo', 'find', 'replace', 'search-files', 'replace-files']],
    [_('Format'), ['bold', 'italic', 'strike', 'inline-code', 'highlight', 'link', 'image', 'codeblock', 'table', 'quote', 'ulist', 'olist']],
    [_('Table'), ['table-row-below', 'table-row-above', 'table-delete-row', 'table-col-right', 'table-col-left', 'table-delete-col', 'table-format']],
    [_('View'), ['sidebar', 'chat', 'kanban-view', 'source', 'focus', 'typewriter', 'dark']],
    [_('General'), ['command-palette', 'preferences', 'shortcuts', 'quit']],
];

// Actions that have an accel, per section; sections without shortcuts are skipped.
export function shortcutEntries(app: Gtk.Application): [title: string, items: [label: string, accel: string][]][] {
    return SHORTCUT_SECTIONS()
        .map(([title, actions]) => [title, actions.flatMap(name => {
            const accel = app.get_accels_for_action(`app.${name}`)[0];
            return accel ? [[COMMAND_LABELS[name] ?? name, accel] as [string, string]] : [];
        })] as [string, [string, string][]])
        .filter(([, items]) => items.length > 0);
}

// Adw.ShortcutsDialog exists since libadwaita 1.8.
export const hasAdwShortcutsDialog = (): boolean => 'ShortcutsDialog' in Adw;

export const SHORTCUTS_TITLE = (): string => _('Keyboard Shortcuts');

export function showShortcuts(app: Gtk.Application, parent: Gtk.Window): Adw.Dialog {
    const entries = shortcutEntries(app);
    if (hasAdwShortcutsDialog()) {
        const dialog = new Adw.ShortcutsDialog({ title: SHORTCUTS_TITLE() });
        for (const [title, items] of entries) {
            const section = new Adw.ShortcutsSection({ title });
            for (const [label, accelerator] of items) section.add(new Adw.ShortcutsItem({ title: label, accelerator }));
            dialog.add(section);
        }
        dialog.present(parent);
        return dialog;
    }
    const page = new Adw.PreferencesPage();
    for (const [title, items] of entries) {
        const group = new Adw.PreferencesGroup({ title });
        for (const [label, accelerator] of items) {
            const row = new Adw.ActionRow({ title: label });
            row.add_suffix(new Gtk.ShortcutLabel({ accelerator, valign: Gtk.Align.CENTER }));
            group.add(row);
        }
        page.add(group);
    }
    const view = new Adw.ToolbarView({ content: page });
    view.add_top_bar(new Adw.HeaderBar());
    const dialog = new Adw.Dialog({ title: SHORTCUTS_TITLE(), content_width: 520, content_height: 640 });
    dialog.set_child(view);
    dialog.present(parent);
    return dialog;
}
