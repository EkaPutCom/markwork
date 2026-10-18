// The dialog that confirms sending a reviewed card branch as a pull request: where it goes, how it is called, and which way
// it is sent. It only collects the answers; src/forge/publish.ts does the sending, and nothing is sent before "Send".

import Gtk from 'gi://Gtk?version=4.0';
import type { SendVia } from '../forge/contribute.js';
import type { PullRequestAnswer, PullRequestOptions } from '../app/harnessreview.js';
import { _, fmt } from '../i18n.js';
import { formDialog } from './dialogs.js';
import { VIA } from './sendchanges.js';

export async function pullRequestDialog(parent: Gtk.Window | null, options: PullRequestOptions): Promise<PullRequestAnswer | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const label = (text: string) => { const l = new Gtk.Label({ label: text, xalign: 0, margin_top: 4 }); l.add_css_class('dim-label'); return l; };

    box.append(new Gtk.Label({
        label: fmt(_('{branch} is pushed to {repository} on {host}, and a pull request asks for it to be merged into {base}.'), { branch: options.branch, repository: options.repository, host: options.host, base: options.base }),
        xalign: 0, wrap: true, max_width_chars: 52,
    }));
    if (options.uncommitted) {
        const note = new Gtk.Label({ label: _('The agent left changes that are not committed; they are committed on the branch first.'), xalign: 0, wrap: true, max_width_chars: 52 });
        note.add_css_class('dim-label');
        box.append(note);
    }

    box.append(label(_('Title')));
    const title = new Gtk.Entry({ text: options.title });
    box.append(title);
    box.append(label(_('Description')));
    const body = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    body.buffer.set_text(options.body, -1);
    box.append(new Gtk.ScrolledWindow({ has_frame: true, min_content_height: 90, max_content_height: 200, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER, child: body }));

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

    const problem = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 52 });
    problem.add_css_class('error');
    box.append(problem);
    const bodyText = () => { const [s, e] = body.buffer.get_bounds(); return body.buffer.get_text(s, e, true); };

    const accepted = await formDialog(parent, _('Create Pull Request'), 460, box, _('Send'), () => {
        const error = title.text.trim() ? null : _('The pull request needs a title.');
        problem.set_text(error ?? '');
        return error === null;
    });
    return accepted ? { title: title.text.trim(), body: bodyText().trim(), via } : null;
}
