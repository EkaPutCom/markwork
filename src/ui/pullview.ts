// One pull request in the content area: the files it changes on the left, and the change of the chosen file on the right,
// either as a note (fields and text) or as the raw diff. This component only draws what the window supplies and reports
// through callbacks; it never talks to the forge.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { relativeTime } from '../gitlog.js';
import type { DiffLine } from '../gitlog.js';
import { pack, removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import type { MergeMethod, PullComment, PullFile, PullRequest } from '../forge/types.js';
import { createDiffView, fillDiff, setupDiffTags } from './historyviewer.js';

const MARK = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

// What the right side shows for one file: the note view (null = not a note) and the raw diff, or a sentence instead.
export interface FileView {
    rendered: DiffLine[] | null;
    raw: DiffLine[];
    note?: string;
}

export class PullView {
    readonly widget: Gtk.Box;
    readonly banner: Adw.Banner;
    readonly title: Gtk.Label;
    readonly meta: Gtk.Label;
    readonly merge: Adw.SplitButton;
    readonly abort: Gtk.Button;               // undoes the local merge while the conflicts are being resolved
    readonly files: Gtk.ListBox;
    readonly diffView: Gtk.TextView;
    readonly message: Gtk.Label;              // a sentence instead of the diff: loading, an error, a binary file
    readonly renderedButton: Gtk.ToggleButton;
    readonly rawButton: Gtk.ToggleButton;
    readonly discussionButton: Gtk.ToggleButton;
    readonly discussion: Gtk.Box;             // the description and comments, then the box to write one
    readonly commentBox: Gtk.TextView;
    readonly commentButton: Gtk.Button;
    private readonly thread: Gtk.Box;
    private readonly pages: Gtk.Stack;
    private paths: string[] = [];
    private view: FileView | null = null;
    private wantsRaw = false;                // the user's choice; a file that is not a note shows raw without changing it
    private discussing = false;
    private resolving: number | null = null;   // files that still have conflict markers; null = not resolving here
    private bannerText: string | null = null;
    private canResolve = false;
    private syncing = false;
    onClose: () => void = () => {};
    onSelect: (path: string) => void = () => {};
    onMerge: (method: MergeMethod) => void = () => {};
    onBrowser: () => void = () => {};
    onComment: (text: string) => void = () => {};
    onResolve: () => void = () => {};
    onFinish: () => void = () => {};
    onAbort: () => void = () => {};

    constructor() {
        this.banner = new Adw.Banner({ revealed: false });
        // One button on the banner, whose job depends on the state: start resolving, or finish.
        this.banner.connect('button-clicked', () => { if (this.resolving === null) this.onResolve(); else this.onFinish(); });

        const close = Gtk.Button.new_from_icon_name('go-previous-symbolic');
        close.set_has_frame(false);
        close.set_tooltip_text(_('Back to the document'));
        close.connect('clicked', () => this.onClose());
        this.title = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
        this.title.add_css_class('heading');
        this.meta = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        this.meta.add_css_class('dim-label');
        const browser = Gtk.Button.new_from_icon_name('web-browser-symbolic');
        browser.set_has_frame(false);
        browser.set_tooltip_text(_('Open the pull request in the browser'));
        browser.connect('clicked', () => this.onBrowser());
        this.merge = this.createMergeButton();
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        titles.append(this.title);
        titles.append(this.meta);
        const header = new Gtk.Box({ spacing: 8, margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 12 });
        header.append(close);
        pack(header, titles, true);
        this.abort = new Gtk.Button({ label: _('Abort merge'), visible: false, tooltip_text: _('Undo the merge in this folder and start over') });
        this.abort.connect('clicked', () => this.onAbort());
        header.append(this.abort);
        header.append(browser);
        header.append(this.merge);

        this.files = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
        this.files.add_css_class('navigation-sidebar');
        this.files.connect('row-selected', (_list, row) => {
            const path = row ? this.paths[row.get_index()] : undefined;
            if (!path) return;
            this.leaveDiscussion();
            this.onSelect(path);
        });
        const fileScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, width_request: 240, child: this.files });

        this.renderedButton = new Gtk.ToggleButton({ label: _('Note'), active: true });
        this.rawButton = new Gtk.ToggleButton({ label: _('Diff'), group: this.renderedButton });
        this.discussionButton = new Gtk.ToggleButton({ label: _('Discussion'), group: this.renderedButton });
        // Only the button that becomes active acts: when the group switches, the one that goes off also signals, first.
        for (const button of [this.renderedButton, this.rawButton, this.discussionButton]) {
            button.connect('toggled', () => { if (button.get_active() && !this.syncing) this.chosen(button); });
        }
        const toggle = new Gtk.Box({ halign: Gtk.Align.START, margin_top: 8, margin_bottom: 8, margin_start: 12 });
        toggle.add_css_class('linked');
        toggle.append(this.renderedButton);
        toggle.append(this.rawButton);
        toggle.append(this.discussionButton);

        this.diffView = createDiffView();
        this.message = new Gtk.Label({ wrap: true, xalign: 0, yalign: 0, margin_top: 16, margin_start: 16, margin_end: 16, max_width_chars: 60 });
        this.message.add_css_class('dim-label');
        this.pages = new Gtk.Stack({ vexpand: true, hexpand: true });
        this.pages.add_named(new Gtk.ScrolledWindow({ child: this.diffView }), 'diff');
        this.pages.add_named(this.message, 'message');
        this.thread = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 8, margin_bottom: 16, margin_start: 16, margin_end: 16 });
        this.commentBox = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false, left_margin: 10, right_margin: 10, top_margin: 8, bottom_margin: 8 });
        this.commentBox.update_property([Gtk.AccessibleProperty.LABEL], [_('Write a comment…')]);
        const commentScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, has_frame: true, min_content_height: 80, max_content_height: 180, propagate_natural_height: true, child: this.commentBox });
        // A text view has no placeholder of its own: a label over it says what the box is for until something is typed.
        const hint = new Gtk.Label({ label: _('Write a comment…'), xalign: 0, yalign: 0, can_target: false, margin_start: 11, margin_top: 9, halign: Gtk.Align.START, valign: Gtk.Align.START });
        hint.add_css_class('dim-label');
        this.commentBox.buffer.connect('changed', () => hint.set_visible(this.commentText === ''));
        const commentField = new Gtk.Overlay({ child: commentScroll });
        commentField.add_overlay(hint);
        this.commentButton = new Gtk.Button({ label: _('Comment'), halign: Gtk.Align.END });
        this.commentButton.add_css_class('suggested-action');
        this.commentButton.connect('clicked', () => { if (this.commentText) this.onComment(this.commentText); });
        const compose = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 12, margin_bottom: 14 });
        compose.append(commentField);
        compose.append(this.commentButton);
        const composeClamp = new Adw.Clamp({ maximum_size: 760, tightening_threshold: 600, margin_start: 16, margin_end: 16, child: compose });
        const threadClamp = new Adw.Clamp({ maximum_size: 760, tightening_threshold: 600, child: this.thread });
        this.discussion = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        pack(this.discussion, new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, child: threadClamp }), true);
        this.discussion.append(new Gtk.Separator());
        this.discussion.append(composeClamp);
        this.pages.add_named(this.discussion, 'discussion');
        this.pages.visible_child_name = 'message';
        const right = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        right.append(toggle);
        pack(right, this.pages, true);

        const body = new Gtk.Box({ vexpand: true });
        body.append(fileScroll);
        body.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
        pack(body, right, true);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
        this.widget.append(this.banner);
        this.widget.append(header);
        this.widget.append(new Gtk.Separator());
        pack(this.widget, body, true);
    }

    // "Merge" merges as a merge commit; the arrow offers the other two, which rewrite the history of the pull request.
    private createMergeButton(): Adw.SplitButton {
        const options: [MergeMethod, string, string][] = [
            ['merge', _('Merge commit'), _('Keep every commit of the pull request')],
            ['squash', _('Squash and merge'), _('Combine them into one commit')],
            ['rebase', _('Rebase and merge'), _('Put them on top of the base branch, without a merge commit')],
        ];
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 4, margin_bottom: 4, margin_start: 4, margin_end: 4 });
        const popover = new Gtk.Popover({ child: box });
        for (const [method, label, detail] of options) {
            const item = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 4, margin_bottom: 4, margin_start: 8, margin_end: 8 });
            item.append(new Gtk.Label({ label, xalign: 0 }));
            const sub = new Gtk.Label({ label: detail, xalign: 0 });
            sub.add_css_class('dim-label');
            item.append(sub);
            const button = new Gtk.Button({ child: item });
            button.set_has_frame(false);
            button.connect('clicked', () => { popover.popdown(); this.onMerge(method); });
            box.append(button);
        }
        const split = new Adw.SplitButton({ label: _('Merge'), popover });
        split.add_css_class('suggested-action');
        split.connect('clicked', () => this.onMerge('merge'));
        return split;
    }

    setPull(pull: PullRequest, now = Math.floor(Date.now() / 1000)): void {
        this.title.set_label(`#${pull.number}  ${pull.title}`);
        this.meta.set_label(fmt(_('{author} wants to merge {head} into {base} · {time}'), {
            author: pull.author, head: pull.headRef, base: pull.baseRef, time: relativeTime(Date.parse(pull.updatedAt) / 1000, now),
        }));
        const open = pull.state === 'open';
        this.merge.set_visible(open);
        this.merge.set_sensitive(open && pull.mergeable !== false && this.resolving === null);
        this.canResolve = open && pull.mergeable === false;
        this.bannerText = !open ? (pull.state === 'merged' ? _('This pull request has been merged.') : _('This pull request is closed.'))
            : pull.mergeable === false ? fmt(_('This pull request conflicts with {base}. Resolve the conflicts on this computer, or ask the author to.'), { base: pull.baseRef })
            : pull.mergeable === null ? _('Checking whether it can be merged…') : null;
        this.refreshBanner();
    }

    // null = the pull request is not being resolved here; a number = files that still have conflict markers.
    setResolving(files: number | null): void {
        this.resolving = files;
        this.abort.set_visible(files !== null);
        if (files !== null) this.merge.set_sensitive(false);
        this.refreshBanner();
    }

    private refreshBanner(): void {
        let title = this.bannerText, button: string | null = this.canResolve ? _('Resolve locally…') : null;
        if (this.resolving !== null) {
            title = this.resolving
                ? fmt(ngettext('{n} file still has conflict markers. Edit it in its tab, then finish.', '{n} files still have conflict markers. Edit them in their tabs, then finish.', this.resolving), { n: this.resolving })
                : _('The conflicts are resolved. Finish to push the merge to the server.');
            button = _('Finish and push');
        }
        this.banner.set_title(title ?? '');
        this.banner.set_button_label(button);
        this.banner.set_revealed(title !== null);
    }

    // The merge is running: the button cannot be pressed twice.
    setBusy(busy: boolean): void {
        this.merge.set_sensitive(!busy);
        this.merge.set_label(busy ? _('Merging…') : _('Merge'));
    }

    setFiles(files: readonly PullFile[]): void {
        this.paths = files.map(f => f.path);
        removeChildren(this.files);
        for (const file of files) this.files.append(this.fileRow(file));
        if (files.length) this.files.select_row(this.files.get_row_at_index(0));
        else this.setMessage(_('This pull request changes no files.'));
    }

    private fileRow(file: PullFile): Gtk.Widget {
        const mark = new Gtk.Label({ label: MARK[file.status], width_chars: 1 });
        mark.add_css_class(file.status === 'added' ? 'success' : file.status === 'deleted' ? 'error' : 'warning');
        const name = new Gtk.Label({ label: file.path, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.START });
        const counts = new Gtk.Label({ label: `+${file.additions} −${file.deletions}` });
        counts.add_css_class('side-meta');
        const row = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6, margin_start: 8, margin_end: 8 });
        row.append(mark);
        row.append(name);
        row.append(counts);
        row.set_tooltip_text(file.previousPath ? `${file.previousPath} → ${file.path}` : file.path);
        return row;
    }

    // A sentence instead of a diff.
    setMessage(text: string): void {
        this.view = null;
        this.message.set_text(text);
        this.pages.visible_child_name = 'message';
    }

    // The change of the chosen file. A file that is not a note has only the raw diff, and that is what shows.
    setFileView(view: FileView): void {
        this.view = view;
        this.renderedButton.set_sensitive(view.rendered !== null);
        this.syncing = true;
        (view.rendered === null || this.wantsRaw ? this.rawButton : this.renderedButton).set_active(true);
        this.syncing = false;
        this.discussing = false;
        this.showView();
    }

    get showingRaw(): boolean { return this.rawButton.get_active(); }
    get showingDiscussion(): boolean { return this.discussing; }

    private chosen(button: Gtk.ToggleButton): void {
        this.discussing = button === this.discussionButton;
        if (!this.discussing) this.wantsRaw = button === this.rawButton;
        this.showView();
    }

    // Picking a file in the list leaves the discussion and shows that file the way the user last looked at files.
    private leaveDiscussion(): void {
        if (!this.discussing) return;
        this.syncing = true;
        (this.wantsRaw ? this.rawButton : this.renderedButton).set_active(true);
        this.syncing = false;
        this.discussing = false;
    }

    private showView(): void {
        if (this.discussing) {
            this.pages.visible_child_name = 'discussion';
            return;
        }
        const view = this.view;
        if (!view) return;
        const lines = this.showingRaw || view.rendered === null ? view.raw : view.rendered;
        if (view.note && !lines.length) return this.setMessageKeepingView(view.note);
        setupDiffTags(this.diffView, Adw.StyleManager.get_default().get_dark());
        fillDiff(this.diffView, lines);
        this.pages.visible_child_name = 'diff';
    }

    get commentText(): string {
        const [start, end] = this.commentBox.buffer.get_bounds();
        return this.commentBox.buffer.get_text(start, end, true).trim();
    }

    // The description first, then the comments in the order they were written.
    setDiscussion(pull: PullRequest, comments: readonly PullComment[], now = Math.floor(Date.now() / 1000)): void {
        removeChildren(this.thread);
        this.discussionButton.set_label(comments.length ? fmt(_('Discussion ({count})'), { count: comments.length }) : _('Discussion'));
        const entries = [{ author: pull.author, body: pull.body.trim() || _('No description.'), time: pull.createdAt, description: true }, ...comments.map(c => ({ author: c.author, body: c.body, time: c.createdAt, description: false }))];
        for (const entry of entries) this.thread.append(this.commentCard(entry.author, entry.body, entry.time, now, entry.description));
    }

    // One message: the author's initial in a colored circle, the name and the time on one line, then the text. The description
    // sits on a tinted background; the messages after it are told apart by a line.
    private commentCard(author: string, body: string, time: string, now: number, description: boolean): Gtk.Widget {
        const ago = relativeTime(Date.parse(time) / 1000, now);
        const initial = (Array.from(author.trim())[0] ?? '?').toUpperCase();
        const avatar = new Gtk.Label({ label: initial, valign: Gtk.Align.START, halign: Gtk.Align.START, width_request: 32, height_request: 32 });
        avatar.add_css_class('pull-avatar');
        avatar.add_css_class(`pull-avatar-${Array.from(author).reduce((sum, ch) => sum + ch.codePointAt(0)!, 0) % 6}`);
        const name = new Gtk.Label({ label: author, xalign: 0 });
        name.add_css_class('heading');
        const when = new Gtk.Label({ label: description ? fmt(_('opened this pull request · {time}'), { time: ago }) : ago, xalign: 0 });
        when.add_css_class('dim-label');
        const head = new Gtk.Box({ spacing: 8 });
        head.append(name);
        head.append(when);
        const text = new Gtk.Label({ label: body, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true, focusable: false, hexpand: true });
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });
        column.append(head);
        column.append(text);
        const row = new Gtk.Box({ spacing: 12, margin_top: 14, margin_bottom: 14, margin_start: 12, margin_end: 12 });
        row.append(avatar);
        row.append(column);
        const entry = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        if (description) entry.add_css_class('pull-description');
        entry.append(row);
        // A line under every message but the description, which has its own background.
        const wrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        wrapper.append(entry);
        if (!description) wrapper.append(new Gtk.Separator());
        return wrapper;
    }

    // A comment is being sent; it stays in the box until the forge has taken it.
    setCommenting(busy: boolean): void {
        this.commentButton.set_sensitive(!busy);
        this.commentBox.set_sensitive(!busy);
    }

    clearComment(): void {
        this.commentBox.buffer.set_text('', -1);
    }

    private setMessageKeepingView(text: string): void {
        this.message.set_text(text);
        this.pages.visible_child_name = 'message';
    }
}
