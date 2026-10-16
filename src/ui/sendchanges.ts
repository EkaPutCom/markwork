// The dialog that turns the changes of the folder into a pull request: what to send, how to call it, and which way it goes
// (the user's fork, the repository itself, or AGit). It only collects the answers; src/forge/contribute.ts does the sending.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import { branchError, slug, type SendVia } from '../forge/contribute.js';
import type { SendChangesAnswer, SendChangesOptions } from '../app/contribute.js';
import { _, fmt } from '../i18n.js';
import { formDialog } from './dialogs.js';

const VIA: [SendVia, string, string][] = [
    ['fork', _('Through my fork'), _('Your own copy of the repository is created if you do not have one')],
    ['direct', _('A branch in the repository'), _('You are allowed to push here; no fork needed')],
    ['agit', _('AGit (no fork, no branch)'), _('The server opens the pull request from the push. It has to be enabled on the server')],
];

export async function sendChangesDialog(parent: Gtk.Window | null, options: SendChangesOptions): Promise<SendChangesAnswer | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const label = (text: string) => { const l = new Gtk.Label({ label: text, xalign: 0, margin_top: 4 }); l.add_css_class('dim-label'); return l; };

    box.append(new Gtk.Label({ label: fmt(_('Sent to {repository}, to be merged into {base}.'), { repository: options.repository, base: options.base }), xalign: 0, wrap: true, max_width_chars: 52 }));

    box.append(label(_('Title')));
    const title = new Gtk.Entry({ activates_default: false });
    box.append(title);
    box.append(label(_('Description')));
    const body = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    box.append(new Gtk.ScrolledWindow({ has_frame: true, min_content_height: 70, max_content_height: 140, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER, child: body }));
    box.append(label(_('Branch')));
    const branch = new Gtk.Entry({ text: `update-${GLib.DateTime.new_now_local().format('%Y-%m-%d')}` });
    // The branch follows the title until the user types in it.
    let edited = false, branchProgrammatic = false;
    branch.connect('changed', () => { if (!branchProgrammatic) edited = true; });
    title.connect('changed', () => {
        if (edited) return;
        branchProgrammatic = true;
        branch.set_text(slug(title.text) || `update-${GLib.DateTime.new_now_local().format('%Y-%m-%d')}`);
        branchProgrammatic = false;
    });
    box.append(branch);

    box.append(label(_('How it is sent')));
    let via: SendVia = options.canPush ? 'direct' : 'fork';
    let first: Gtk.CheckButton | null = null;
    for (const [kind, name, detail] of VIA) {
        if (kind === 'direct' && !options.canPush) continue;
        // `group: undefined` is an error in GJS, so the first button is made without the property.
        const radio = new Gtk.CheckButton({ label: name, active: kind === via, tooltip_text: detail, ...(first ? { group: first } : {}) });
        first ??= radio;
        radio.connect('toggled', () => { if (radio.get_active()) via = kind; });
        box.append(radio);
    }

    box.append(label(_('Changes to send')));
    const checks = new Map<string, Gtk.CheckButton>();
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    const prefix = options.folder.endsWith('/') ? options.folder : `${options.folder}/`;
    for (const change of options.changes) {
        const check = new Gtk.CheckButton({ label: change.path.startsWith(prefix) ? change.path.slice(prefix.length) : change.path, active: true });
        checks.set(change.path, check);
        list.append(check);
    }
    box.append(new Gtk.ScrolledWindow({ has_frame: true, min_content_height: 40, max_content_height: 130, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER, child: list }));

    const problem = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 52 });
    problem.add_css_class('error');
    box.append(problem);
    const bodyText = () => { const [s, e] = body.buffer.get_bounds(); return body.buffer.get_text(s, e, true); };
    const files = () => [...checks].filter(([, c]) => c.get_active()).map(([path]) => path);
    const check = (): string | null => !title.text.trim() ? _('The pull request needs a title.') : !files().length ? _('Choose at least one change to send.') : branchError(branch.text.trim()) ? _('That is not a usable branch name.') : null;

    const accepted = await formDialog(parent, _('Send Changes as Pull Request'), 460, box, _('Send'), () => {
        const error = check();
        problem.set_text(error ?? '');
        return error === null;
    });
    return accepted ? { title: title.text.trim(), body: bodyText().trim(), branch: branch.text.trim(), via, files: files() } : null;
}
