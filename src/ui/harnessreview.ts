// The review of a card's worktree in the content area: the files the harness changed on the left (each can be left
// out of the merge), and on the right the change of the chosen file, a summary of what the harness said and ran, or
// its log. Clicking a line of the diff adds a comment for the harness. This component only draws what the window
// supplies and reports through callbacks; it never runs git.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { DiffLine } from '../gitlog.js';
import { pack, removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import type { ChangedFile, Commit } from '../agent/worktreereview.js';
import type { FinishAction, PullOffer, ReviewTab, ReviewView, SummaryView } from '../app/harnessreview.js';
import { createDiffView, fillDiff, setupDiffTags } from './historyviewer.js';

const MARK = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;
const STATUS_NAME = { added: _('added'), modified: _('modified'), deleted: _('deleted'), renamed: _('renamed') } as const;

function rectangle(x: number, y: number, width: number, height: number): Gdk.Rectangle {
    const r = new Gdk.Rectangle();
    r.x = x;
    r.y = y;
    r.width = width;
    r.height = height;
    return r;
}

export class HarnessReviewView implements ReviewView {
    readonly widget: Gtk.Box;
    readonly banner: Adw.Banner;
    readonly title: Gtk.Label;
    readonly meta: Gtk.Label;
    readonly files: Gtk.ListBox;
    readonly commits: Gtk.Box;
    readonly diffView: Gtk.TextView;
    readonly message: Gtk.Label;
    readonly merge: Adw.SplitButton;
    readonly reply: Gtk.Button;
    readonly folderButton: Gtk.Button;
    readonly terminalButton: Gtk.Button;
    readonly tabs: Record<ReviewTab, Gtk.ToggleButton>;
    readonly summary: Gtk.Box;
    readonly logButton: Gtk.Button;
    readonly status: Gtk.Label;
    private readonly pages: Gtk.Stack;
    private readonly checks: Gtk.CheckButton[] = [];
    private lines: DiffLine[] = [];
    private syncing = false;
    onClose: () => void = () => {};
    onSelect: (index: number) => void = () => {};
    onInclude: (index: number, included: boolean) => void = () => {};
    onFinish: (action: FinishAction) => void = () => {};
    onPullRequest: () => void = () => {};
    onReply: () => void = () => {};
    onFolder: () => void = () => {};
    onTerminal: () => void = () => {};
    onTab: (tab: ReviewTab) => void = () => {};
    onLog: () => void = () => {};
    onBanner: () => void = () => {};
    // A comment on line `line` of the diff shown (an index into its lines).
    onComment: (line: number, text: string) => void = () => {};

    constructor() {
        this.banner = new Adw.Banner({ revealed: false });
        this.banner.connect('button-clicked', () => this.onBanner());

        const close = Gtk.Button.new_from_icon_name('go-previous-symbolic');
        close.set_has_frame(false);
        close.set_tooltip_text(_('Back to the board'));
        close.connect('clicked', () => this.onClose());
        this.title = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
        this.title.add_css_class('heading');
        this.meta = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        this.meta.add_css_class('dim-label');
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        titles.append(this.title);
        titles.append(this.meta);
        this.folderButton = this.iconButton('folder-open-symbolic', _('Open the worktree folder'), () => this.onFolder());
        this.terminalButton = this.iconButton('utilities-terminal-symbolic', _('Open a terminal in the worktree'), () => this.onTerminal());
        this.reply = new Gtk.Button({ label: _('Reply…'), tooltip_text: _('Send the agent a reply, with your comments on the diff; it goes on in this worktree') });
        this.reply.connect('clicked', () => this.onReply());
        this.merge = this.createMergeButton();
        const header = new Gtk.Box({ spacing: 6, margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 12 });
        header.append(close);
        pack(header, titles, true);
        for (const w of [this.folderButton, this.terminalButton, this.reply, this.merge]) header.append(w);

        this.files = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
        this.files.add_css_class('navigation-sidebar');
        this.files.update_property([Gtk.AccessibleProperty.LABEL], [_('Changed files')]);
        this.files.connect('row-selected', (_list, row) => { if (row && !this.syncing) this.onSelect(row.get_index()); });
        this.commits = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 12, margin_end: 12, margin_bottom: 12 });
        const side = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        side.append(this.heading(_('Changed files')));
        side.append(this.files);
        side.append(this.heading(_('Commits')));
        side.append(this.commits);
        const sideScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, width_request: 160, child: side });

        const changes = new Gtk.ToggleButton({ label: _('Changes'), active: true });
        const summary = new Gtk.ToggleButton({ label: _('Summary'), group: changes });
        const log = new Gtk.ToggleButton({ label: _('Log'), group: changes });
        this.tabs = { changes, summary, log };
        for (const [tab, button] of Object.entries(this.tabs) as [ReviewTab, Gtk.ToggleButton][]) {
            button.connect('toggled', () => { if (button.get_active() && !this.syncing) this.onTab(tab); });
        }
        const toggle = new Gtk.Box({ halign: Gtk.Align.START });
        toggle.add_css_class('linked');
        for (const button of [changes, summary, log]) toggle.append(button);
        this.status = new Gtk.Label({ xalign: 1, hexpand: true, ellipsize: Pango.EllipsizeMode.START });
        this.status.add_css_class('dim-label');
        const bar = new Gtk.Box({ spacing: 12, margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12 });
        bar.append(toggle);
        bar.append(this.status);

        this.diffView = createDiffView();
        // The diff colors follow the light or dark style, also while the page is open.
        const style = Adw.StyleManager.get_default();
        const restyle = () => setupDiffTags(this.diffView, style.get_dark());
        const styleId = style.connect('notify::dark', restyle);
        this.diffView.connect('destroy', () => style.disconnect(styleId));
        this.diffView.update_property([Gtk.AccessibleProperty.LABEL], [_('The change of the chosen file; activate a line to comment on it')]);
        const click = new Gtk.GestureClick({ button: 1 });
        click.connect('released', (_g, n, x, y) => { if (n === 1) this.commentAt(x, y); });
        this.diffView.add_controller(click);
        this.message = new Gtk.Label({ wrap: true, xalign: 0, yalign: 0, margin_top: 16, margin_start: 16, margin_end: 16, max_width_chars: 60 });
        this.message.add_css_class('dim-label');
        this.summary = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 12, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        this.logButton = new Gtk.Button({ label: _('Open the Log…'), halign: Gtk.Align.START });
        this.logButton.connect('clicked', () => this.onLog());
        const logPage = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 16, margin_start: 16, margin_end: 16 });
        const logText = new Gtk.Label({ label: _('Every step the agent took — what it read, the commands it ran, and their output — is in its log.'), wrap: true, xalign: 0, max_width_chars: 60 });
        logText.add_css_class('dim-label');
        logPage.append(logText);
        logPage.append(this.logButton);

        this.pages = new Gtk.Stack({ vexpand: true, hexpand: true });
        this.pages.add_named(new Gtk.ScrolledWindow({ child: this.diffView }), 'diff');
        this.pages.add_named(this.message, 'message');
        this.pages.add_named(new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, child: new Adw.Clamp({ maximum_size: 760, child: this.summary }) }), 'summary');
        this.pages.add_named(logPage, 'log');
        this.pages.visible_child_name = 'message';
        const right = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        right.append(bar);
        right.append(new Gtk.Separator());
        pack(right, this.pages, true);

        const body = new Gtk.Box({ vexpand: true });
        body.append(sideScroll);
        body.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
        pack(body, right, true);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
        this.widget.append(this.banner);
        this.widget.append(header);
        this.widget.append(new Gtk.Separator());
        pack(this.widget, body, true);
    }

    private iconButton(icon: string, tooltip: string, run: () => void): Gtk.Button {
        const button = Gtk.Button.new_from_icon_name(icon);
        button.set_has_frame(false);
        button.set_tooltip_text(tooltip);
        button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
        button.connect('clicked', run);
        return button;
    }

    private heading(text: string): Gtk.Label {
        const label = new Gtk.Label({ label: text, xalign: 0, margin_top: 12, margin_bottom: 4, margin_start: 12 });
        label.add_css_class('caption-heading');
        label.add_css_class('dim-label');
        return label;
    }

    // "Merge" merges with a merge commit; the arrow offers squashing, sending the branch as a pull request, keeping only the branch, and discarding.
    private createMergeButton(): Adw.SplitButton {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 4, margin_bottom: 4, margin_start: 4, margin_end: 4 });
        const popover = new Gtk.Popover({ child: box });
        const item = (run: () => void, label: string, detail: string, destructive = false) => {
            const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 4, margin_bottom: 4, margin_start: 8, margin_end: 8 });
            const title = new Gtk.Label({ label, xalign: 0 });
            if (destructive) title.add_css_class('error');
            column.append(title);
            const sub = new Gtk.Label({ label: detail, xalign: 0, wrap: true, max_width_chars: 36 });
            sub.add_css_class('dim-label');
            column.append(sub);
            const button = new Gtk.Button({ child: column });
            button.set_has_frame(false);
            button.connect('clicked', () => { popover.popdown(); run(); });
            box.append(button);
            return { title, sub, button };
        };
        const finish = (action: FinishAction) => () => this.onFinish(action);
        this.mergeTitle = item(finish('merge'), '', _('A merge commit; the agent’s commits are kept')).title;
        this.squashTitle = item(finish('squash'), '', _('One commit with everything')).title;
        box.append(new Gtk.Separator({ margin_top: 4, margin_bottom: 4 }));
        this.pullItem = item(() => this.onPullRequest(), _('Create Pull Request…'), _('Push the branch and ask for it to be merged'));
        item(finish('keep'), _('Keep the Branch, Remove the Worktree'), _('Merge it yourself later'));
        item(finish('discard'), _('Discard…'), _('Delete the worktree and its branch'), true);
        const split = new Adw.SplitButton({ label: _('Merge'), popover });
        split.add_css_class('suggested-action');
        split.connect('clicked', () => this.onFinish('merge'));
        return split;
    }

    // The menu item of the pull request: its label and what it does, or why it is off.
    setPullRequest(offer: PullOffer): void {
        this.pullItem.title.set_label(offer.label);
        this.pullItem.sub.set_label(offer.detail);
        this.pullItem.button.set_sensitive(offer.enabled);
        this.pullItem.button.set_tooltip_text(offer.detail);
    }

    pullItem!: { title: Gtk.Label; sub: Gtk.Label; button: Gtk.Button };
    private mergeTitle!: Gtk.Label;
    private squashTitle!: Gtk.Label;

    setHeader(title: string, meta: string, base: string, local: boolean): void {
        this.title.set_label(title);
        this.meta.set_label(meta);
        this.folderButton.set_visible(local);
        this.terminalButton.set_tooltip_text(local ? _('Open a terminal in the worktree') : _('Open a terminal in the worktree on its machine (ssh)'));
        this.mergeTitle.set_label(fmt(_('Merge into {base}'), { base }));
        this.squashTitle.set_label(fmt(_('Squash into {base}'), { base }));
    }

    // included: which files go into the merge; comments: how many comments each file has.
    setFiles(files: readonly ChangedFile[], included: readonly boolean[], comments: readonly number[], selected: number): void {
        this.syncing = true;
        removeChildren(this.files);
        this.checks.length = 0;
        files.forEach((file, i) => this.files.append(this.fileRow(file, i, included[i] ?? true, comments[i] ?? 0)));
        const row = this.files.get_row_at_index(selected);
        if (row) this.files.select_row(row);
        this.syncing = false;
        if (!files.length) this.setMessage(_('The agent changed nothing in this worktree.'));
        this.setIncluded(included);
    }

    private fileRow(file: ChangedFile, index: number, included: boolean, comments: number): Gtk.Widget {
        const check = new Gtk.CheckButton({ active: included, valign: Gtk.Align.CENTER, tooltip_text: _('Include in the merge') });
        check.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Include {file} in the merge'), { file: file.path })]);
        check.connect('toggled', () => { if (!this.syncing) this.onInclude(index, check.get_active()); });
        this.checks.push(check);
        const mark = new Gtk.Label({ label: MARK[file.status], width_chars: 1 });
        mark.add_css_class(file.status === 'added' ? 'success' : file.status === 'deleted' ? 'error' : 'warning');
        mark.update_property([Gtk.AccessibleProperty.LABEL], [STATUS_NAME[file.status]]);
        const slash = file.path.lastIndexOf('/');
        const name = new Gtk.Label({ label: file.path.slice(slash + 1), xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE });
        const dir = new Gtk.Label({ label: slash > 0 ? file.path.slice(0, slash) : '', xalign: 0, ellipsize: Pango.EllipsizeMode.START, visible: slash > 0 });
        dir.add_css_class('side-meta');
        const names = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER });
        names.append(name);
        names.append(dir);
        const counts = new Gtk.Label({ label: file.binary ? _('binary') : `+${file.additions} −${file.deletions}` });
        counts.add_css_class('side-meta');
        const row = new Gtk.Box({ spacing: 8, margin_top: 4, margin_bottom: 4, margin_start: 4, margin_end: 6 });
        row.append(check);
        row.append(mark);
        row.append(names);
        if (comments) {
            const said = fmt(ngettext('{n} comment', '{n} comments', comments), { n: comments });
            const note = new Gtk.Box({ spacing: 2, tooltip_text: said });
            note.append(new Gtk.Image({ icon_name: 'document-edit-symbolic', pixel_size: 12 }));
            note.append(new Gtk.Label({ label: String(comments) }));
            note.add_css_class('side-meta');
            note.update_property([Gtk.AccessibleProperty.LABEL], [said]);
            row.append(note);
        }
        row.append(counts);
        row.set_tooltip_text(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
        return row;
    }

    // The merge button says how much it merges, and is off when nothing would be merged or the merge cannot work.
    setIncluded(included: readonly boolean[], blocked = false): void {
        const count = included.filter(Boolean).length, all = included.length;
        this.merge.set_label(count === all ? _('Merge') : fmt(_('Merge {count} of {all}'), { count, all }));
        this.merge.set_sensitive(count > 0 && !blocked);
    }

    setCommits(commits: readonly Commit[], uncommitted: boolean): void {
        removeChildren(this.commits);
        const line = (text: string, detail: string) => {
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 4 });
            box.append(new Gtk.Label({ label: text, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR }));
            const sub = new Gtk.Label({ label: detail, xalign: 0, wrap: true });
            sub.add_css_class('side-meta');
            box.append(sub);
            this.commits.append(box);
        };
        for (const c of commits) line(c.subject, c.hash);
        if (uncommitted) line(_('Uncommitted changes'), _('Merging or sending it commits them first'));
        if (!commits.length && !uncommitted) line(_('None'), '');
    }

    setStatus(text: string): void {
        this.status.set_label(text);
    }

    setMessage(text: string): void {
        this.message.set_text(text);
        this.pages.visible_child_name = 'message';
    }

    // The change of one file; `commented` are the lines that have a comment.
    setDiff(lines: DiffLine[], commented: readonly number[]): void {
        this.lines = lines;
        setupDiffTags(this.diffView, Adw.StyleManager.get_default().get_dark());
        fillDiff(this.diffView, lines);
        const buffer = this.diffView.buffer;
        const table = buffer.get_tag_table();
        if (!table.lookup('commented')) table.add(new Gtk.TextTag({ name: 'commented', underline: Pango.Underline.SINGLE, weight: Pango.Weight.BOLD }));
        for (const i of commented) {
            const [, start] = buffer.get_iter_at_line(i);
            const end = start.copy();
            end.forward_to_line_end();
            buffer.apply_tag_by_name('commented', start, end);
        }
        this.pages.visible_child_name = 'diff';
    }

    showTab(tab: ReviewTab): void {
        this.syncing = true;
        this.tabs[tab].set_active(true);
        this.syncing = false;
        if (tab === 'summary') this.pages.visible_child_name = 'summary';
        if (tab === 'log') this.pages.visible_child_name = 'log';
    }

    setSummary(view: SummaryView): void {
        removeChildren(this.summary);
        const heading = (text: string) => { const l = new Gtk.Label({ label: text, xalign: 0 }); l.add_css_class('heading'); this.summary.append(l); };
        heading(_('What the agent said'));
        const answer = new Gtk.Label({ label: view.answer || _('Its answer is not known here (it finished while Markwork was closed, or before it was opened). The card’s note has its first line.'), xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true, focusable: false });
        if (!view.answer) answer.add_css_class('dim-label');
        this.summary.append(answer);
        heading(_('Commands it ran'));
        if (!view.commands.length) {
            const none = new Gtk.Label({ label: view.hasLog ? _('None.') : _('Not known without its log.'), xalign: 0 });
            none.add_css_class('dim-label');
            this.summary.append(none);
        } else {
            const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
            list.add_css_class('boxed-list');
            for (const c of view.commands) {
                const row = new Adw.ActionRow({ use_markup: false });
                row.set_title(c.command);
                row.add_css_class('monospace');
                const icon = new Gtk.Image({ icon_name: c.ok === false ? 'process-stop-symbolic' : c.ok ? 'object-select-symbolic' : 'content-loading-symbolic' });
                icon.add_css_class(c.ok === false ? 'error' : 'success');
                icon.update_property([Gtk.AccessibleProperty.LABEL], [c.ok === false ? _('failed') : c.ok ? _('succeeded') : _('unknown')]);
                row.add_prefix(icon);
                list.append(row);
            }
            this.summary.append(list);
        }
        const note = new Gtk.Label({ label: _('This is what the agent reported running; Markwork did not run anything.'), xalign: 0, wrap: true });
        note.add_css_class('dim-label');
        note.add_css_class('caption');
        this.summary.append(note);
        this.logButton.set_sensitive(view.hasLog);
    }

    setReplyCount(comments: number): void {
        this.reply.set_label(comments ? fmt(ngettext('Reply with {n} Comment…', 'Reply with {n} Comments…', comments), { n: comments }) : _('Reply…'));
        if (comments) this.reply.add_css_class('suggested-action');
        else this.reply.remove_css_class('suggested-action');
    }

    // A sentence above the page, with a button when there is something to do about it.
    setBanner(title: string | null, button: string | null = null): void {
        this.banner.set_title(title ?? '');
        this.banner.set_button_label(button);
        this.banner.set_revealed(title !== null);
    }

    // While a merge runs nothing else can be started; the status line says what is happening, then what it said before.
    setBusy(busy: boolean, label = ''): void {
        if (busy) { this.idleStatus = this.status.label; this.status.set_label(label); } else this.status.set_label(this.idleStatus);
        this.merge.set_sensitive(!busy);
        this.reply.set_sensitive(!busy);
    }

    private idleStatus = '';

    // A click on a line of the diff: a popover asks for the comment. Header and hunk lines take none.
    private commentAt(x: number, y: number): void {
        const [bx, by] = this.diffView.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, Math.round(x), Math.round(y));
        const [, iter] = this.diffView.get_iter_at_location(bx, by);
        const line = iter.get_line();
        const kind = this.lines[line]?.kind;
        if (kind === undefined || kind === 'hunk') return;
        if (this.diffView.buffer.get_has_selection()) return;   // the user is selecting text to copy
        const rect = this.diffView.get_iter_location(iter);
        const [wx, wy] = this.diffView.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x, rect.y);
        const entry = new Gtk.Entry({ placeholder_text: _('A comment for the agent about this line'), width_chars: 40, activates_default: true });
        const add = new Gtk.Button({ label: _('Add Comment') });
        add.add_css_class('suggested-action');
        const box = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        box.append(entry);
        box.append(add);
        const popover = new Gtk.Popover({ child: box, position: Gtk.PositionType.BOTTOM });
        popover.set_parent(this.diffView);
        popover.set_pointing_to(rectangle(wx, wy, Math.max(1, rect.width), rect.height));
        popover.set_default_widget(add);
        const done = () => { const text = entry.get_text().trim(); popover.popdown(); if (text) this.onComment(line, text); };
        add.connect('clicked', done);
        entry.connect('activate', done);
        popover.connect('closed', () => popover.unparent());
        popover.popup();
        entry.grab_focus();
    }
}

