// Reading window for one commit (or, with a null commit, a file's uncommitted changes): the Changes tab (diff against the previous commit) and
// the Contents tab (the whole file at that commit). Read-only; the window is not modal so the document
// can still be compared while editing.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import { commitContent, commitDiff, commitFile, discardChanges, workingDiff, workingState, type TextResult } from '../git.js';
import { parseDiff, type ChangeKind, type Commit, type DiffLine } from '../gitlog.js';
import { replaceAllText } from '../editor/view.js';
import { iterAtLine, onKeyPress, pack } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import { askDiscard } from './discard.js';
import { MessageBox } from './messagebox.js';
import { MessageWriter, setStatus } from './messagewriter.js';

const DIFF_COLORS = {
    light: { add: '#dafbe1', del: '#ffebe9', hunk: '#0969da' },
    dark: { add: '#17331f', del: '#3d1a1c', hunk: '#78aeed' },
};

// Shared diff view (Git history and agent change proposals): color tags in the buffer, then the typed line contents.
export function setupDiffTags(view: Gtk.TextView, dark: boolean): void {
    const colors = DIFF_COLORS[dark ? 'dark' : 'light'];
    const table = view.buffer.get_tag_table();
    const add = (name: string, props: Record<string, string>) => {
        const existing = table.lookup(name);
        const tag = existing ?? new Gtk.TextTag({ name });
        for (const [key, value] of Object.entries(props)) tag.set_property(key, value);
        if (!existing) table.add(tag);
    };
    add('add', { paragraph_background: colors.add });
    add('del', { paragraph_background: colors.del });
    add('hunk', { foreground: colors.hunk });
}

export function fillDiff(view: Gtk.TextView, lines: DiffLine[]): void {
    const buffer = view.buffer;
    // Diffs and file contents can be as long as a book.
    replaceAllText(view, () => buffer.set_text(lines.map(l => l.text).join('\n'), -1));
    lines.forEach((line, i) => {
        if (line.kind === 'context') return;
        const start = iterAtLine(buffer, i);
        const end = start.copy();
        end.forward_to_line_end();
        buffer.apply_tag_by_name(line.kind, start, end);
    });
}

export function createDiffView(): Gtk.TextView {
    const view = new Gtk.TextView({
        editable: false, cursor_visible: false, monospace: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        left_margin: 14, right_margin: 14, top_margin: 10, bottom_margin: 10,
    });
    view.add_css_class('history-text');
    return view;
}

export class HistoryViewer {
    readonly window: Adw.Window;
    readonly diffView: Gtk.TextView;
    readonly contentView: Gtk.TextView;
    readonly stack: Gtk.Stack;
    closed = false;
    readonly message: MessageBox;              // commit message (uncommitted-changes mode only)
    readonly commitButton: Gtk.Button;
    readonly status: Gtk.Label;
    readonly writer: MessageWriter;            // the assistant button next to the message
    beforeCommit: () => boolean = () => true;  // save the document first; false = cancel the commit
    onCommitted: () => void = () => {};
    readonly discardButton: Gtk.Button;        // throws away this file's uncommitted changes (uncommitted-changes mode only)
    beforeDiscard: () => boolean = () => true;
    onDiscarded: (paths: string[]) => void = () => {};
    confirmDiscard: (kind: ChangeKind, path: string) => Promise<boolean> = (kind, path) => askDiscard(this.window, kind, path);

    constructor(parent: Gtk.Window | null, file: string, readonly commit: Commit | null, dark: boolean) {
        this.window = new Adw.Window({
            transient_for: parent, default_width: 860, default_height: 620,
        });
        const title = commit ? commit.subject || _('(no message)') : _('Uncommitted changes');
        const detail = commit
            ? `${commit.short} · ${commit.author} · ${GLib.DateTime.new_from_unix_local(commit.time).format('%d %b %Y %H:%M')}`
            : fmt(_('{name} · compared with the last commit'), { name: GLib.path_get_basename(file) });
        // The header title is used by the StackSwitcher, so the commit info is placed above the contents.
        const header = new Adw.HeaderBar();
        this.window.set_title(title);
        const subject = new Gtk.Label({ label: title, xalign: 0, wrap: true });
        subject.set_markup(`<b>${GLib.markup_escape_text(title, -1)}</b>`);
        const meta = new Gtk.Label({ label: detail, xalign: 0 });
        meta.add_css_class('dim-label');
        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 12, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        info.append(subject);
        info.append(meta);

        this.diffView = this.createView();
        this.contentView = this.createView();
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100 });
        this.stack.add_titled(this.scrolled(this.diffView), 'diff', _('Changes'));
        // Uncommitted changes have no "version"; their latest contents are already in the editor.
        if (commit) {
            this.stack.add_titled(this.scrolled(this.contentView), 'content', _('Contents of this version'));
            header.set_title_widget(new Gtk.StackSwitcher({ stack: this.stack }));
        }
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.append(info);
        body.append(new Gtk.Separator());
        pack(body, this.stack, true);

        this.message = new MessageBox(_('Commit message'));
        this.commitButton = new Gtk.Button({ label: _('Commit this file'), valign: Gtk.Align.CENTER });
        this.commitButton.add_css_class('suggested-action');
        this.discardButton = new Gtk.Button({ label: _('Discard Changes'), valign: Gtk.Align.CENTER });
        this.discardButton.add_css_class('destructive-action');
        this.discardButton.set_tooltip_text(_('Go back to the last commit; this cannot be undone'));
        this.status = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        this.writer = new MessageWriter(this.message, this.status, () => commit ? [] : [file],
            _("Write the message with the assistant (reads this file's changes)"));
        this.writer.onBusy = busy => { this.commitButton.set_sensitive(!busy); this.discardButton.set_sensitive(!busy); };
        if (!commit) {
            const bar = new Gtk.Box({ spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10 });
            const message = new Gtk.Box({ spacing: 6 });
            pack(message, this.message.widget, true);
            message.append(this.writer.button);
            pack(bar, message, true);
            bar.append(this.discardButton);
            bar.append(this.commitButton);
            body.append(new Gtk.Separator());
            body.append(bar);
            body.append(this.status);
            this.commitButton.connect('clicked', () => this.doCommit(file));
            this.discardButton.connect('clicked', () => void this.doDiscard(file));
            this.message.onActivate = () => void this.doCommit(file);
        }
        const view = new Adw.ToolbarView({ content: body });
        view.add_top_bar(header);
        this.window.set_content(view);

        // The window is destroyed (GTK 4 does not emit "destroy" while its object is held by JavaScript).
        this.window.connect('unrealize', () => { this.closed = true; this.writer.stop(); });
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.window.destroy();
            return true;
        });

        setupDiffTags(this.diffView, dark);
        this.setPlaceholder('Loading…');
        if (commit) {
            commitDiff(file, commit).then(result => this.showDiff(result));
            commitContent(file, commit).then(result => this.showContent(result));
        } else {
            workingDiff(file).then(result => this.showDiff(result));
        }
    }

    private async doCommit(file: string): Promise<void> {
        if (this.writer.busy) return;
        const message = this.message.text.trim();
        if (!message) return this.showStatus('Enter a commit message first');
        if (!this.beforeCommit()) return this.showStatus('The document failed to save; the commit was cancelled');
        this.commitButton.set_sensitive(false);
        this.writer.locked = true;
        const result = await commitFile(file, message);
        if (this.closed) return;
        if (!result.ok) {
            this.writer.locked = false;
            this.commitButton.set_sensitive(true);
            return this.showStatus(fmt(_('Commit failed: {message}'), { message: result.message }));
        }
        this.onCommitted();
        this.window.destroy();
    }

    // Asks, then throws the file's uncommitted changes away and closes the window (there is nothing left to show).
    private async doDiscard(file: string): Promise<void> {
        if (this.writer.busy) return;
        const state = await workingState(file);
        if (this.closed || !state.ok || state.state === 'clean') return;
        if (!await this.confirmDiscard(state.state === 'untracked' ? 'untracked' : 'modified', file) || this.closed) return;
        if (!this.beforeDiscard()) return this.showStatus('The document failed to save; the changes were not discarded');
        const result = await discardChanges([file]);
        if (this.closed) return;
        if (!result.ok) return this.showStatus(fmt(_('Could not discard the changes: {message}'), { message: result.message }));
        this.onDiscarded([file]);
        this.window.destroy();
    }

    private showStatus(text: string): void {
        setStatus(this.status, text, true);
    }

    show(): void {
        this.window.present();
    }

    private setPlaceholder(message: string): void {
        this.diffView.buffer.set_text(message, -1);
        this.contentView.buffer.set_text(message, -1);
    }

    private createView(): Gtk.TextView {
        return createDiffView();
    }

    private scrolled(view: Gtk.TextView): Gtk.ScrolledWindow {
        const scroll = new Gtk.ScrolledWindow();
        scroll.set_child(view);
        return scroll;
    }

    private showDiff(result: TextResult): void {
        if (this.closed) return;
        const buffer = this.diffView.buffer;
        if (!result.ok) return buffer.set_text(fmt(_('Failed to read the changes:\n{message}'), { message: result.message }), -1);
        const lines = parseDiff(result.text);
        if (!lines.length) return buffer.set_text(this.commit
            ? _('There are no content changes in this commit (for example only a rename)')
            : _('There are no uncommitted changes'), -1);
        fillDiff(this.diffView, lines);
    }

    private showContent(result: TextResult): void {
        if (this.closed) return;
        replaceAllText(this.contentView, () =>
            this.contentView.buffer.set_text(result.ok ? result.text : fmt(_('Failed to read the file contents:\n{message}'), { message: result.message }), -1));
    }
}
