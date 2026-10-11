// The History tab in the sidebar: git commits that touch the active file, newest first.
// Click a commit to see its changes and contents (ui/historyviewer.ts, opened by the window).

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import { commitFiles, fileLog, repoChanges, workingState, type GitFailure } from '../git.js';
import { relativeTime, type ChangeKind, type Commit, type FileChange } from '../gitlog.js';
import { pack, removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import { MessageBox } from './messagebox.js';
import { MessageWriter, setStatus } from './messagewriter.js';

// Commits loaded per request; a long history is loaded incrementally.
const PAGE_SIZE = 100;

const FAILURE_TEXT: Record<GitFailure, string> = {
    'no-git': _('git is not installed'),
    'no-repo': _('This file is not in a git repository'),
    'failed': _('The history could not be read'),
};

const KIND_MARK: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

// One commit list row. The data is plain fields; the display is read by the ListView when the row is bound.
class CommitItem extends GObject.Object {
    static { GObject.registerClass({ GTypeName: 'MarkworkCommitItem' }, this); }
    commit!: Commit;
    now = 0;
}

export class History {
    readonly store = new Gio.ListStore({ item_type: CommitItem.$gtype });
    readonly list: Gtk.ListView;
    readonly widget: Gtk.Box;
    readonly more: Gtk.Button;
    readonly changes: Gtk.Button;              // the "uncommitted" row, shown only if the file changed
    onOpen: (commit: Commit) => void = () => {};   // a commit was clicked
    onOpenChanges: (file: string) => void = () => {};   // uncommitted changes were clicked (the active file or a file from the list)
    readonly changedList: Gtk.ListBox;         // all uncommitted files in the repository
    readonly changedBox: Gtk.Expander;
    private changed: FileChange[] = [];
    private readonly unchecked = new Set<string>();   // list files that are not committed; the rest are checked
    private readonly checks = new Map<string, Gtk.CheckButton>();
    readonly commitBar: Gtk.Box;
    readonly message: MessageBox;              // wraps, so the whole message fits the narrow sidebar
    readonly commitButton: Gtk.Button;
    readonly commitStatus: Gtk.Label;
    readonly writer: MessageWriter;            // the assistant button next to the message
    beforeCommit: () => boolean = () => true;      // save the document first; false = cancel the commit
    onCommitted: () => void = () => {};

    private folder: string | null = null;     // the open folder; source of the changes list when there is no file yet
    private file: string | null | undefined;   // undefined = never loaded
    private commits: Commit[] = [];
    private token = 0;                         // stale git results (the file has changed) are ignored
    readonly note: Gtk.Label;                  // message when the list is empty

    constructor() {
        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.store }), factory: this.createFactory(), single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('activate', (_list, position) => {
            const commit = this.commits[position];
            if (commit) this.onOpen(commit);
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
        refresh.connect('clicked', () => this.refresh());
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
        this.more.connect('clicked', () => this.load(this.commits.length, false));

        // hexpand false: the title in the header expands, and GTK 4 passes that up to the sidebar.
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: false });
        this.widget.append(header);
        this.widget.append(this.changes);
        this.widget.append(this.changedBox);
        pack(this.widget, pages, true);
        this.widget.append(this.more);
    }

    // Show this file's history. Calling again with the same file does nothing
    // unless force, so it is safe to call often.
    setFile(file: string | null, force = false, folder: string | null = this.folder): void {
        if (!force && file === this.file && folder === this.folder) return;
        const same = file === this.file;
        this.file = file;
        this.folder = folder;
        this.token++;
        // Reloading the same file does not empty the list first; the list is only replaced if its contents changed.
        if (!same) this.clear();
        this.changes.set_visible(false);
        if (!same) this.setChanged([]);
        if (!file) {
            this.note.set_text(_('Save the document to a file, and its git history will show up here'));
            this.loadChanges();
            return;
        }
        if (!same) this.note.set_text(_('Loading…'));
        this.load(0, same);
        this.loadChanges();
    }

    refresh(): void {
        if (this.file !== undefined) this.setFile(this.file, true);
    }

    // Window closed: git results still being awaited are ignored.
    destroy(): void {
        this.token++;
        this.writer.stop();
    }

    // The changes button only shows if the file contents differ from the last commit.
    private async loadChanges(): Promise<void> {
        const token = this.token, file = this.file;
        const dir = file ? GLib.path_get_dirname(file) : this.folder;
        if (!dir) return this.setChanged([]);
        const [state, repo] = await Promise.all([file ? workingState(file) : null, repoChanges(dir)]);
        if (token !== this.token) return;
        this.setChanged(repo.ok ? repo.changes : []);
        if (!state || !state.ok || state.state === 'clean') return this.changes.set_visible(false);
        this.changes.set_label(state.state === 'untracked' ? _('● New file, not committed yet') : _('● Uncommitted changes'));
        this.changes.set_visible(true);
    }

    // The file list changed; it is not rebuilt if the same, so the scroll position does not jump on reload.
    private setChanged(changes: FileChange[]): void {
        const same = changes.length === this.changed.length
            && changes.every((c, i) => c.path === this.changed[i].path && c.kind === this.changed[i].kind);
        if (same) return;
        this.changed = changes;
        this.checks.clear();
        removeChildren(this.changedList);
        for (const path of [...this.unchecked]) if (!changes.some(c => c.path === path)) this.unchecked.delete(path);
        const dir = this.file ? GLib.path_get_dirname(this.file) : this.folder ?? '';
        for (const change of changes) {
            const rel = dir && change.path.startsWith(dir + '/') ? change.path.slice(dir.length + 1) : change.path;
            const check = new Gtk.CheckButton({ active: !this.unchecked.has(change.path), sensitive: !this.writer.busy });
            check.set_tooltip_text(_('Include in the commit'));
            check.connect('toggled', () => {
                if (check.active) this.unchecked.delete(change.path); else this.unchecked.add(change.path);
                this.updateCommitButton();
            });
            this.checks.set(change.path, check);
            const mark = new Gtk.Label({ label: KIND_MARK[change.kind], xalign: 0, width_chars: 1 });
            mark.add_css_class('side-meta');
            const name = new Gtk.Label({ label: rel, xalign: 0, ellipsize: Pango.EllipsizeMode.START });
            const box = new Gtk.Box({ spacing: 8, margin_start: 4, margin_end: 4, margin_top: 0, margin_bottom: 0 });
            box.append(check);
            box.append(mark);
            pack(box, name, true);
            const row = new Gtk.ListBoxRow({ child: box, tooltip_text: change.path });
            this.changedList.insert(row, -1);
        }
        this.changedBox.set_label(fmt(_('Uncommitted ({count})'), { count: changes.length }));
        this.updateCommitButton();
        this.changedBox.set_visible(changes.length > 0);
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
        this.writer.update();
    }

    private showCommitStatus(text: string, error = true): void {
        setStatus(this.commitStatus, text, error);
    }

    private async commitSelected(): Promise<void> {
        if (this.writer.busy) return;
        const files = this.selected();
        const message = this.message.text.trim();
        if (!files.length) return this.showCommitStatus('Select the files to commit');
        if (!message) return this.showCommitStatus('Enter a commit message first');
        if (!this.beforeCommit()) return this.showCommitStatus('The document failed to save; the commit was cancelled');
        this.commitButton.set_sensitive(false);
        this.writer.locked = true;
        const result = await commitFiles(files, message);
        this.writer.locked = false;
        this.updateCommitButton();
        if (!result.ok) return this.showCommitStatus(fmt(_('Commit failed: {message}'), { message: result.message }));
        this.message.text = '';
        this.commitStatus.set_visible(false);
        this.onCommitted();
    }

    private clear(): void {
        this.commits = [];
        this.more.set_visible(false);
        this.store.remove_all();
    }

    private async load(skip: number, keep: boolean): Promise<void> {
        const token = this.token, file = this.file;
        if (!file) return;
        const result = await fileLog(file, skip, PAGE_SIZE);
        if (token !== this.token) return;
        if (!result.ok) {
            this.clear();
            this.note.set_text(FAILURE_TEXT[result.reason]);
            return;
        }
        if (skip === 0) {
            // Reloading a result identical to what is displayed: leave the list (and its scroll position) alone.
            const shown = this.commits.slice(0, result.commits.length);
            if (keep && shown.length === result.commits.length && shown.every((c, i) => c.hash === result.commits[i].hash)) return;
            this.clear();
            this.note.set_text(_('There are no commits for this file yet'));
        }
        const now = Math.floor(Date.now() / 1000);
        this.commits.push(...result.commits);
        this.store.splice(this.store.n_items, 0, result.commits.map(commit => Object.assign(new CommitItem(), { commit, now })));
        this.more.set_visible(result.commits.length === PAGE_SIZE);
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
