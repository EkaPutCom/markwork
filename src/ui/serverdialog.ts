// The dialog that asks for the access token of the forge behind the folder's git remote, with a button to try it
// before saving. The token is returned to the caller, which stores it; nothing is written here.

import Gtk from 'gi://Gtk?version=4.0';
import { _, fmt } from '../i18n.js';
import { formDialog } from './dialogs.js';

export interface TokenDialogOptions {
    host: string;
    repository: string;                         // owner/repo, shown so the user knows what the token must reach
    hasToken: boolean;                          // a token is saved already: an empty field then removes it
    test: (token: string) => Promise<string>;   // resolves to a sentence for the user; rejects with the reason
}

// The token to save, '' = remove the saved one, null = cancelled.
export async function tokenDialog(parent: Gtk.Window | null, { host, repository, hasToken, test }: TokenDialogOptions): Promise<string | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const intro = fmt(_('Markwork reads the pull requests of {repository} on {host}. Create an access token in your account settings there (Applications), allowed to read and write repositories, and paste it here.'), { repository, host });
    box.append(new Gtk.Label({ label: intro, xalign: 0, wrap: true, max_width_chars: 48 }));
    const entry = new Gtk.PasswordEntry({ show_peek_icon: true, activates_default: true, placeholder_text: hasToken ? _('Saved — type to replace') : _('Access token') });
    box.append(entry);

    const status = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, hexpand: true });
    const check = new Gtk.Button({ label: _('Test connection') });
    let token = 0;
    check.connect('clicked', async () => {
        const mine = ++token;
        status.remove_css_class('error');
        status.remove_css_class('success');
        status.set_label(_('Connecting…'));
        const text = entry.text.trim();
        try {
            const message = await test(text);
            if (mine !== token) return;
            status.add_css_class('success');
            status.set_label(message);
        } catch (e) {
            if (mine !== token) return;
            status.add_css_class('error');
            status.set_label(e instanceof Error ? e.message : String(e));
        }
    });
    const row = new Gtk.Box({ spacing: 8 });
    row.append(check);
    row.append(status);
    box.append(row);
    if (hasToken) {
        const hint = new Gtk.Label({ label: _('Save with the field empty to remove the saved token.'), xalign: 0, wrap: true, max_width_chars: 48 });
        hint.add_css_class('dim-label');
        box.append(hint);
    }
    // Without a saved token an empty field is not an answer: Save stays inert until something is typed.
    const accepted = await formDialog(parent, _('Server access'), 420, box, _('Save'), () => hasToken || entry.text.trim() !== '');
    token++;
    return accepted ? entry.text.trim() : null;
}
