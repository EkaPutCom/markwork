// The commands of app/commands.ts as Gio.Actions and GTK accelerators.
//
// Actions (Gio.SimpleAction) are triggered by header bar buttons, menu items, or shortcuts. What each command is, its
// default keys, and what it does belong to the registry and are shared by every frontend; this file only maps them onto
// GTK. "Toggle" actions have an on/off state that automatically shows as a checkmark in menus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type Adw from 'gi://Adw?version=1';
import type { AppSettings } from './settings.js';
import { COMMANDS, type Command, type CommandHost } from './app/commands.js';
import { gsettingsOf } from './platform/gjs/settings.js';

// What the actions need from the main window: the commands, the settings their toggles follow, and the colors.
export interface ActionHost extends CommandHost {
    readonly settings: AppSettings;
    readonly dark: boolean;
    syncActionsEnabled(): void;
}

// Keys that are not a single letter or digit, in the names GTK knows them by.
const GTK_KEYS: Record<string, string> = {
    '\\': 'backslash', ',': 'comma', '?': 'question', '`': 'grave', ']': 'bracketright', '[': 'bracketleft', '/': 'slash',
    'PageDown': 'Page_Down', 'PageUp': 'Page_Up',
};

// "Ctrl+Shift+Tab" → ['<Control><Shift>Tab', '<Control><Shift>ISO_Left_Tab'] (GTK delivers Shift+Tab as its own key).
export function gtkAccelerators(keys: readonly string[]): string[] {
    return keys.flatMap(chord => {
        const parts = chord.split(/\+(?=.)/);
        const key = parts.pop()!;
        const mods = ['Ctrl', 'Alt', 'Shift'].filter(m => parts.includes(m)).map(m => `<${m === 'Ctrl' ? 'Control' : m}>`).join('');
        const accel = `${mods}${GTK_KEYS[key] ?? key}`;
        return key === 'Tab' && parts.includes('Shift') ? [accel, `${mods}ISO_Left_Tab`] : [accel];
    });
}

export function registerActions(app: Adw.Application, w: ActionHost): void {
    const accels = (c: Command) => {
        if (c.keys.length) app.set_accels_for_action(`app.${c.id}`, gtkAccelerators(c.keys));
    };
    for (const c of COMMANDS) {
        if (c.kind === 'setting') {
            // Toggle bound to a GSettings key: the action's state follows that key.
            app.add_action(gsettingsOf(w.settings).create_action(c.id));
        } else if (c.kind === 'choice') {
            // The parameter is a string: the layout of the header bar menu, the path of a recent file.
            const choice = c.id === 'layout'
                ? Gio.SimpleAction.new_stateful(c.id, GLib.VariantType.new('s'), GLib.Variant.new_string(''))
                : new Gio.SimpleAction({ name: c.id, parameter_type: GLib.VariantType.new('s') });
            choice.connect(c.id === 'layout' ? 'change-state' : 'activate', (_a, value) => { if (value) c.run(w, value.get_string()[0]); });
            app.add_action(choice);
        } else if (c.kind === 'toggle') {
            const toggle = Gio.SimpleAction.new_stateful(c.id, null, GLib.Variant.new_boolean(c.id === 'dark' ? w.dark : false));
            toggle.connect('change-state', (act, value) => {
                if (!value) return;
                if (!c.ownsState) act.set_state(value);
                c.run(w, value.get_boolean());
            });
            app.add_action(toggle);
        } else {
            const action = new Gio.SimpleAction({ name: c.id });
            action.connect('activate', () => c.run(w));
            app.add_action(action);
        }
        accels(c);
    }
    w.syncActionsEnabled();
}
