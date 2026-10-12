// The Collaboration tab in the sidebar: the open pull requests of the folder's repository, newest activity first.
// This component only draws what the window supplies and reports clicks through callbacks; it never talks to the forge.

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { relativeTime } from '../gitlog.js';
import { pack, removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import type { PullRequest } from '../forge/types.js';

export class CollabPanel {
    readonly widget: Gtk.Box;
    readonly list: Gtk.ListBox;
    readonly note: Gtk.Label;                 // replaces the list: no remote, no token, an error, no pull requests
    readonly server: Gtk.Button;              // the footer: which server this folder talks to; opens the token dialog
    readonly refreshButton: Gtk.Button;
    private readonly title: Gtk.Label;
    private readonly pages: Gtk.Stack;
    private pulls: readonly PullRequest[] = [];
    onOpen: (pull: PullRequest) => void = () => {};
    onRefresh: () => void = () => {};
    onServer: () => void = () => {};

    constructor() {
        this.title = new Gtk.Label({ label: _('PULL REQUESTS'), xalign: 0, margin_start: 16 });
        this.title.add_css_class('side-title');
        this.refreshButton = Gtk.Button.new_from_icon_name('view-refresh-symbolic');
        this.refreshButton.set_has_frame(false);
        this.refreshButton.set_tooltip_text(_('Look for new pull requests'));
        this.refreshButton.connect('clicked', () => this.onRefresh());
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 8, margin_end: 6 });
        pack(header, this.title, true);
        header.append(this.refreshButton);

        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, activate_on_single_click: true });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('row-activated', (_list, row) => {
            const pull = this.pulls[row.get_index()];
            if (pull) this.onOpen(pull);
        });
        this.note = new Gtk.Label({ margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16, wrap: true, xalign: 0, max_width_chars: 24, valign: Gtk.Align.START });
        this.note.add_css_class('dim-label');

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });
        const pages = new Gtk.Stack({ vexpand: true });
        pages.add_named(scroll, 'list');
        pages.add_named(this.note, 'note');
        pages.visible_child_name = 'note';
        this.pages = pages;

        this.server = new Gtk.Button({ margin_start: 8, margin_end: 8, margin_top: 4, margin_bottom: 8 });
        this.server.set_has_frame(false);
        this.server.add_css_class('side-meta');
        this.server.connect('clicked', () => this.onServer());
        this.server.set_tooltip_text(_('Server and access token'));

        // hexpand false: the title in the header expands, and GTK 4 passes that up to the sidebar.
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: false });
        this.widget.append(header);
        pack(this.widget, pages, true);
        this.widget.append(this.server);
        this.setServer(null);
    }

    // A message instead of the list; null = show the list again.
    setNote(text: string | null): void {
        if (text !== null) this.note.set_text(text);
        this.pages.visible_child_name = text !== null ? 'note' : 'list';
    }

    // The footer: "git.example.org · eka/notes", or a prompt to connect when the folder has no usable remote.
    setServer(label: string | null): void {
        this.server.set_label(label ?? _('Connect to a server…'));
        this.server.set_sensitive(label !== null);
    }

    setPulls(pulls: readonly PullRequest[], now = Math.floor(Date.now() / 1000)): void {
        this.pulls = [...pulls].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        removeChildren(this.list);
        for (const pull of this.pulls) this.list.append(this.row(pull, now));
        this.title.set_label(this.pulls.length ? fmt(_('PULL REQUESTS ({count})'), { count: this.pulls.length }) : _('PULL REQUESTS'));
        this.setNote(this.pulls.length ? null : _('No open pull requests'));
    }

    // Words for the screen reader and the tooltip; the row itself shows the state with a colored dot.
    private static status(pull: PullRequest): { text: string; css: string } {
        if (pull.mergeable === false) return { text: _('Conflicts with the base branch'), css: 'warning' };
        if (pull.mergeable === null) return { text: _('Checking whether it can be merged'), css: 'dim-label' };
        return { text: _('Can be merged'), css: 'success' };
    }

    private row(pull: PullRequest, now: number): Gtk.Widget {
        const status = CollabPanel.status(pull);
        const dot = new Gtk.Label({ label: '●', valign: Gtk.Align.START, margin_top: 1 });
        dot.add_css_class(status.css);
        const title = new Gtk.Label({ label: pull.title, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 22 });
        const meta = fmt(_('#{number} · {author} · {time}'), { number: pull.number, author: pull.author, time: relativeTime(Date.parse(pull.updatedAt) / 1000, now) });
        const detail = new Gtk.Label({ label: pull.comments ? `${meta} · ${fmt(ngettext('{n} comment', '{n} comments', pull.comments), { n: pull.comments })}` : meta, xalign: 0, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 24 });
        detail.add_css_class('side-meta');
        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
        text.append(title);
        text.append(detail);
        const box = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6, margin_start: 8, margin_end: 8 });
        box.append(dot);
        box.append(text);
        box.set_tooltip_text(`${pull.title}\n${status.text}`);
        return box;
    }
}
