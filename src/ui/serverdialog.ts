// The dialog that asks for the access token of the forge behind the folder's git remote, with a button to try it
// before saving. The token is returned to the caller, which stores it; nothing is written here.

import Gtk from 'gi://Gtk?version=4.0';
import type { TokenSource } from '../forge/token.js';
import { _, fmt } from '../i18n.js';
import { formDialog } from './dialogs.js';

export interface TokenDialogOptions {
    host: string;
    repository: string;                         // owner/repo, shown so the user knows what the token must reach
    hasToken: boolean;                          // a token is in use already: for a saved one, an empty field removes it
    source?: TokenSource;                       // where that token comes from; one from the environment cannot be changed here
    test: (token: string) => Promise<string>;   // resolves to a sentence for the user; rejects with the reason
}

// The token to save, '' = remove the saved one, null = cancelled.
const dim = (text: string): Gtk.Label => {
    const label = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 48 });
    label.add_css_class('dim-label');
    return label;
};

export async function tokenDialog(parent: Gtk.Window | null, { host, repository, hasToken, source, test }: TokenDialogOptions): Promise<string | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const intro = fmt(_('Markwork reads the pull requests of {repository} on {host}. Create an access token in your account settings there (Applications), allowed to read and write repositories, and paste it here.'), { repository, host });
    box.append(new Gtk.Label({ label: intro, xalign: 0, wrap: true, max_width_chars: 48 }));
    const entry = new Gtk.PasswordEntry({ show_peek_icon: true, activates_default: true, placeholder_text: hasToken && source !== 'env' ? _('Saved — type to replace') : _('Access token') });
    box.append(entry);

    const status = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, hexpand: true });
    // The button keeps its own height however long the answer is.
    const check = new Gtk.Button({ label: _('Test connection'), valign: Gtk.Align.START });
    status.set_valign(Gtk.Align.CENTER);
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
    if (source === 'env') {
        box.append(dim(_('The token in use comes from the MARKWORK_FORGE_TOKEN environment variable, which takes precedence over one saved here.')));
    } else if (hasToken) {
        box.append(dim(_('Save with the field empty to remove the saved token.')));
    }
    // Without a saved token an empty field is not an answer: Save stays inert until something is typed.
    const accepted = await formDialog(parent, _('Server access'), 420, box, _('Save'), () => (hasToken && source !== 'env') || entry.text.trim() !== '');
    token++;
    return accepted ? entry.text.trim() : null;
}
