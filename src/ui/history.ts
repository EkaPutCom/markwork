// The History tab in the sidebar: git commits that touch the active file, newest first, the uncommitted files of its
// repository, and the commit form. A view of app/history.ts: it draws what the controller sends and reports clicks
// through its on* actions; git and the commit message writer run in the controller. A click on a commit opens the
// history viewer (ui/historyviewer.ts) through the controller.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import type { WriteResult } from '../agent/commitmessage.js';
import type { ChangedFile, DiscardOutcome, HistoryChanges, HistoryLog, HistoryTabView } from '../app/history.js';
import { relativeTime, type ChangeKind, type Commit } from '../gitlog.js';
import { pack, removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import { MessageBox } from './messagebox.js';
import { MessageWriter, setStatus } from './messagewriter.js';

const KIND_MARK: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

// One commit list row. The data is plain fields; the display is read by the ListView when the row is bound.
class CommitItem extends GObject.Object {
    static { GObject.registerClass({ GTypeName: 'MarkworkCommitItem' }, this); }
    commit!: Commit;
    now = 0;
}

export class History implements HistoryTabView {
    readonly store = new Gio.ListStore({ item_type: CommitItem.$gtype });
    readonly list: Gtk.ListView;
    readonly widget: Gtk.Box;
    readonly more: Gtk.Button;
    readonly changes: Gtk.Button;              // the "uncommitted" row, shown only if the file changed
    readonly changedList: Gtk.ListBox;         // all uncommitted files in the repository
    readonly changedBox: Gtk.Expander;
    private changed: ChangedFile[] = [];
    private readonly unchecked = new Set<string>();   // list files that are not committed; the rest are checked
    private readonly checks = new Map<string, Gtk.CheckButton>();
    readonly commitBar: Gtk.Box;
    readonly message: MessageBox;              // wraps, so the whole message fits the narrow sidebar
    readonly commitButton: Gtk.Button;
    readonly commitStatus: Gtk.Label;
    readonly writer: MessageWriter;            // the assistant button next to the message
    private readonly discards: Gtk.Button[] = [];
    private commits: Commit[] = [];
    private file: string | null = null;        // the active file, for the changes button
    private streamed: (text: string) => void = () => {};
    readonly note: Gtk.Label;                  // message when the list is empty

    // What the user did; set by the controller (app/history.ts).
    onRefresh: () => void = () => {};
    onMore: () => void = () => {};
    onOpen: (hash: string) => void = () => {};
    onOpenChanges: (path: string) => void = () => {};
    onCommit: (files: string[], message: string) => Promise<string | null> = async () => null;
    onDiscard: (path: string) => Promise<DiscardOutcome> = async () => 'declined';
    onWrite: (files: string[]) => Promise<WriteResult> = async () => ({ ok: false, reason: 'failed', message: 'not connected' });
    onStopWriting: () => void = () => {};

    constructor() {
        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.store }), factory: this.createFactory(), single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('activate', (_list, position) => {
            const commit = this.commits[position];
            if (commit) this.onOpen(commit.hash);
        });
        // Empty list: a message (loading, not a repository, no commits yet) replaces the list.
        this.note = new Gtk.Label({ margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16, wrap: true, xalign: 0, max_width_chars: 24, valign: Gtk.Align.START });
        this.note.add_css_class('dim-label');

        // The title expands inside the header only; the sidebar does not expand along because its width
        // is set by width_request and the main Box gives the remaining space to the hexpand editor column.
        const title = new Gtk.Label({ label: _('HISTORY'), xalign: 0, margin_start: 16 });
        title.add_css_class('side-title');
        const refresh = Gtk.Button.new_from_icon_name('view-refresh-symbolic');
        refresh.set_has_frame(false);
        refresh.set_tooltip_text(_('Reload history'));
        refresh.connect('clicked', () => this.onRefresh());
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 8, margin_end: 6 });
        pack(header, title, true);
        header.append(refresh);

        this.changes = new Gtk.Button({ visible: false, margin_start: 8, margin_end: 8, margin_bottom: 8 });
        this.changes.set_has_frame(false);
        this.changes.set_tooltip_text(_('View changes against the last commit'));
        this.changes.connect('clicked', () => { if (this.file) this.onOpenChanges(this.file); });
        this.changedList = new Gtk.ListBox({ activate_on_single_click: true });
        this.changedList.set_selection_mode(Gtk.SelectionMode.NONE);
        this.changedList.connect('row-activated', (_list, row) => {
            const change = this.changed[row.get_index()];
            if (change) this.onOpenChanges(change.path);
        });
        const changedScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: 240,
        });
        changedScroll.set_child(this.changedList);
        this.message = new MessageBox(_('Commit message'));
        this.commitButton = new Gtk.Button({ label: _('Commit') });
        this.commitButton.add_css_class('suggested-action');
        this.commitStatus = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 24, visible: false });
        this.commitStatus.add_css_class('dim-label');
        this.commitButton.connect('clicked', () => this.commitSelected());
        this.message.onActivate = () => void this.commitSelected();
        this.writer = new MessageWriter(this.message, this.commitStatus, () => this.selected(),
            _('Write the message with the assistant (reads the checked changes)'));
        // The message streams back as messageText notices; Stop and a closed window end the writing in the controller.
        this.writer.write = (files, onText, cancellable) => {
            this.streamed = onText;
            cancellable.onCancel(() => this.onStopWriting());
            return this.onWrite(files);
        };
        this.writer.onBusy = () => this.updateCommitButton();
        // The message takes the full width; the assistant button sits beside Commit.
        const commitRow = new Gtk.Box({ spacing: 6 });
        pack(commitRow, this.commitButton, true);
        commitRow.append(this.writer.button);
        commitRow.set_hexpand(false);   // Commit fills the row; the row does not pass that up to the sidebar
        this.message.widget.set_hexpand(false);
        this.commitBar = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        this.commitBar.append(this.message.widget);
        this.commitBar.append(commitRow);
        this.commitBar.append(this.commitStatus);
        const changedContent = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        changedContent.append(changedScroll);
        changedContent.append(this.commitBar);
        this.changedBox = new Gtk.Expander({ expanded: true, visible: false, margin_start: 8, margin_end: 8, margin_bottom: 8 });
        this.changedBox.set_child(changedContent);

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });
        const pages = new Gtk.Stack({ vexpand: true });
        pages.add_named(scroll, 'list');
        pages.add_named(this.note, 'note');
        pages.visible_child_name = 'note';
        this.store.connect('items-changed', () => { pages.visible_child_name = this.store.n_items ? 'list' : 'note'; });
        this.more = new Gtk.Button({ label: _('Load more'), margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8, visible: false });
        this.more.connect('clicked', () => this.onMore());

        // hexpand false: the title in the header expands, and GTK 4 passes that up to the sidebar.
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: false });
        this.widget.append(header);
        this.widget.append(this.changes);
        this.widget.append(this.changedBox);
        pack(this.widget, pages, true);
        this.widget.append(this.more);
    }

    // Window closed: a message being written stops.
    destroy(): void {
        this.writer.stop();
    }

    // ---------- What the controller shows ----------

    // The list is only rebuilt where it changed, so the scroll position does not jump on a reload or "Load more".
    showLog(log: HistoryLog): void {
        const shown = this.commits;
        const grows = shown.length <= log.commits.length && shown.every((c, i) => c.hash === log.commits[i].hash);
        if (!grows) this.store.remove_all();
        const added = log.commits.slice(grows ? shown.length : 0);
        const now = Math.floor(Date.now() / 1000);
        this.commits = log.commits;
        this.note.set_text(log.note);
        this.store.splice(this.store.n_items, 0, added.map(commit => Object.assign(new CommitItem(), { commit, now })));
        this.more.set_visible(log.more);
    }

    showChanges(changes: HistoryChanges): void {
        this.file = changes.file;
        const changed = changes.state !== null && changes.state !== 'clean';
        this.changes.set_visible(changed);
        if (changed) this.changes.set_label(changes.state === 'untracked' ? _('● New file, not committed yet') : _('● Uncommitted changes'));
        this.setChanged(changes.changed);
    }

    messageText(text: string): void {
        this.streamed(text);
    }

    // The file list changed; it is not rebuilt if the same, so the scroll position does not jump on reload.
    private setChanged(changes: ChangedFile[]): void {
        const same = changes.length === this.changed.length
            && changes.every((c, i) => c.path === this.changed[i].path && c.kind === this.changed[i].kind && c.name === this.changed[i].name);
        if (same) return;
        this.changed = changes;
        this.checks.clear();
        this.discards.length = 0;
        removeChildren(this.changedList);
        for (const path of [...this.unchecked]) if (!changes.some(c => c.path === path)) this.unchecked.delete(path);
        for (const change of changes) {
            const check = new Gtk.CheckButton({ active: !this.unchecked.has(change.path), sensitive: !this.writer.busy });
            check.set_tooltip_text(_('Include in the commit'));
            check.connect('toggled', () => {
                if (check.active) this.unchecked.delete(change.path); else this.unchecked.add(change.path);
                this.updateCommitButton();
            });
            this.checks.set(change.path, check);
            const mark = new Gtk.Label({ label: KIND_MARK[change.kind], xalign: 0, width_chars: 1 });
            mark.add_css_class('side-meta');
            const name = new Gtk.Label({ label: change.name, xalign: 0, ellipsize: Pango.EllipsizeMode.START });
            const box = new Gtk.Box({ spacing: 8, margin_start: 4, margin_end: 4, margin_top: 0, margin_bottom: 0 });
            box.append(check);
            box.append(mark);
            pack(box, name, true);
            if (change.kind !== 'renamed') box.append(this.discardButton(change));
            const row = new Gtk.ListBoxRow({ child: box, tooltip_text: change.path });
            this.changedList.insert(row, -1);
        }
        this.changedBox.set_label(fmt(_('Uncommitted ({count})'), { count: changes.length }));
        this.updateCommitButton();
        this.changedBox.set_visible(changes.length > 0);
    }

    // The button at the end of a row: undo the changes of that file (after asking). Not for a rename, which git cannot undo per file.
    private discardButton(change: ChangedFile): Gtk.Button {
        const button = Gtk.Button.new_from_icon_name('edit-undo-symbolic');
        button.add_css_class('flat');
        button.set_valign(Gtk.Align.CENTER);
        const label = change.kind === 'untracked' || change.kind === 'added' ? _('Delete this new file') : _('Discard the changes to this file');
        button.set_tooltip_text(label);
        button.update_property([Gtk.AccessibleProperty.LABEL], [label]);
        button.set_sensitive(!this.writer.busy);
        button.connect('clicked', () => void this.discard(change));
        this.discards.push(button);
        return button;
    }

    private async discard(change: ChangedFile): Promise<void> {
        if (this.writer.busy) return;
        const outcome = await this.onDiscard(change.path);
        if (outcome === 'declined') return;
        if (outcome === 'done') this.commitStatus.set_visible(false);
        else this.showCommitStatus(outcome.error);
    }

    // The checked files; the order follows the list.
    private selected(): string[] {
        return this.changed.filter(c => !this.unchecked.has(c.path)).map(c => c.path);
    }

    // Also the lock while the assistant writes: the files and the message must stay what it is describing.
    private updateCommitButton(): void {
        const n = this.selected().length;
        const busy = this.writer.busy;
        this.commitButton.set_label(n ? fmt(ngettext('Commit {n} file', 'Commit {n} files', n), { n }) : _('Commit'));
        this.commitButton.set_sensitive(n > 0 && !busy);
        for (const check of this.checks.values()) check.set_sensitive(!busy);
        for (const button of this.discards) button.set_sensitive(!busy);
        this.writer.update();
    }

    private showCommitStatus(text: string, error = true): void {
        setStatus(this.commitStatus, text, error);
    }

    private async commitSelected(): Promise<void> {
        if (this.writer.busy) return;
        this.commitButton.set_sensitive(false);
        this.writer.locked = true;
        const error = await this.onCommit(this.selected(), this.message.text);
        this.writer.locked = false;
        this.updateCommitButton();
        if (error) return this.showCommitStatus(error);
        this.message.text = '';
        this.commitStatus.set_visible(false);
    }

    private createFactory(): Gtk.SignalListItemFactory {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            const subject = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            const meta = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            meta.add_css_class('side-meta');
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 16, margin_end: 12 });
            box.append(subject);
            box.append(meta);
            (item as Gtk.ListItem).child = box;
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const { commit, now } = listItem.item as CommitItem;
            const box = listItem.child as Gtk.Box;
            (box.get_first_child() as Gtk.Label).label = commit.subject || _('(no message)');
            (box.get_last_child() as Gtk.Label).label = `${commit.short} · ${commit.author} · ${relativeTime(commit.time, now)}`;
            box.set_tooltip_text(`${commit.subject}\n${commit.author}\n${GLib.DateTime.new_from_unix_local(commit.time).format('%d %b %Y %H:%M')}`);
        });
        return factory;
    }
}
