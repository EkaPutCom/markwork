// Reading window for one commit (or, with a null commit, a file's uncommitted changes): the Changes tab (diff against the previous commit) and
// the Contents tab (the whole file at that commit). Read-only; the window is not modal so the document
// can still be compared while editing. A view of app/history.ts: HistoryViewers opens the windows the controller asks
// for, draws what it sends, and reports the commit, discard, and message writer of a window by its number.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import type { WriteResult } from '../agent/commitmessage.js';
import type { DiscardOutcome, HistoryText, HistoryViewerSpec, HistoryViewersView } from '../app/history.js';
import type { Commit, DiffLine } from '../gitlog.js';
import { replaceAllText } from '../editor/view.js';
import { iterAtLine, onKeyPress, pack } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
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
    readonly file: string;
    readonly commit: Commit | null;
    readonly message: MessageBox;              // commit message (uncommitted-changes mode only)
    readonly commitButton: Gtk.Button;
    readonly status: Gtk.Label;
    readonly writer: MessageWriter;            // the assistant button next to the message
    readonly discardButton: Gtk.Button;        // throws away this file's uncommitted changes (uncommitted-changes mode only)
    private streamed: (text: string) => void = () => {};
    onCommit: (message: string) => Promise<string | null> = async () => null;
    onDiscard: () => Promise<DiscardOutcome> = async () => 'declined';
    onWrite: () => Promise<WriteResult> = async () => ({ ok: false, reason: 'failed', message: 'not connected' });
    onStopWriting: () => void = () => {};
    onClosed: () => void = () => {};

    constructor(parent: Gtk.Window | null, spec: HistoryViewerSpec, dark: boolean) {
        const { file, commit } = spec;
        this.file = file;
        this.commit = commit;
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
        // The message streams back as messageText notices; Stop and a closed window end the writing in the controller.
        this.writer.write = (_files, onText, cancellable) => {
            this.streamed = onText;
            cancellable.onCancel(() => this.onStopWriting());
            return this.onWrite();
        };
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
            this.commitButton.connect('clicked', () => void this.doCommit());
            this.discardButton.connect('clicked', () => void this.doDiscard());
            this.message.onActivate = () => void this.doCommit();
        }
        const view = new Adw.ToolbarView({ content: body });
        view.add_top_bar(header);
        this.window.set_content(view);

        // The window is destroyed (GTK 4 does not emit "destroy" while its object is held by JavaScript).
        this.window.connect('unrealize', () => {
            if (this.closed) return;
            this.closed = true;
            this.writer.stop();
            this.onClosed();
        });
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.window.destroy();
            return true;
        });

        setupDiffTags(this.diffView, dark);
        this.setPlaceholder(_('Loading…'));
    }

    // The commit went through, or the changes were discarded: there is nothing left to show.
    close(): void {
        if (!this.closed) this.window.destroy();
    }

    private async doCommit(): Promise<void> {
        if (this.writer.busy) return;
        this.commitButton.set_sensitive(false);
        this.writer.locked = true;
        const error = await this.onCommit(this.message.text);
        if (this.closed || !error) return;
        this.writer.locked = false;
        this.commitButton.set_sensitive(true);
        this.showStatus(error);
    }

    // The controller asks first, then closes the window once the changes are gone.
    private async doDiscard(): Promise<void> {
        if (this.writer.busy) return;
        const outcome = await this.onDiscard();
        if (this.closed || typeof outcome === 'string') return;
        this.showStatus(outcome.error);
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

    showDiff(diff: HistoryText): void {
        if (this.closed) return;
        if ('text' in diff) this.diffView.buffer.set_text(diff.text, -1);
        else fillDiff(this.diffView, diff.lines);
    }

    showContent(text: string): void {
        if (this.closed) return;
        replaceAllText(this.contentView, () => this.contentView.buffer.set_text(text, -1));
    }

    messageText(text: string): void {
        this.streamed(text);
    }
}

// The viewer windows of the main window, by the number the controller gave each one (HistoryViewersView).
export class HistoryViewers implements HistoryViewersView {
    private readonly windows = new Map<number, HistoryViewer>();
    onCommit: (viewer: number, message: string) => Promise<string | null> = async () => null;
    onDiscard: (viewer: number) => Promise<DiscardOutcome> = async () => 'declined';
    onWrite: (viewer: number) => Promise<WriteResult> = async () => ({ ok: false, reason: 'failed', message: 'not connected' });
    onStopWriting: (viewer: number) => void = () => {};
    onClosed: (viewer: number) => void = () => {};
    onOpenSettings: () => void = () => {};     // the "no API key" link of a commit form

    constructor(private readonly parent: () => Gtk.Window | null, private readonly dark: () => boolean) {}

    // The window of a viewer, if it is still open (the parent of its questions; tests).
    get(viewer: number): HistoryViewer | undefined {
        return this.windows.get(viewer);
    }

    // The most recently opened window that is still open.
    get last(): HistoryViewer | undefined {
        return [...this.windows.values()].at(-1);
    }

    open(viewer: number, spec: HistoryViewerSpec): void {
        const window = new HistoryViewer(this.parent(), spec, this.dark());
        window.onCommit = message => this.onCommit(viewer, message);
        window.onDiscard = () => this.onDiscard(viewer);
        window.onWrite = () => this.onWrite(viewer);
        window.onStopWriting = () => this.onStopWriting(viewer);
        window.onClosed = () => {
            this.windows.delete(viewer);
            this.onClosed(viewer);
        };
        window.writer.onOpenSettings = () => this.onOpenSettings();
        this.windows.set(viewer, window);
        window.show();
    }

    showDiff(viewer: number, diff: HistoryText): void {
        this.windows.get(viewer)?.showDiff(diff);
    }

    showContent(viewer: number, text: string): void {
        this.windows.get(viewer)?.showContent(text);
    }

    messageText(viewer: number, text: string): void {
        this.windows.get(viewer)?.messageText(text);
    }

    close(viewer: number): void {
        const window = this.windows.get(viewer);
        this.windows.delete(viewer);
        window?.close();
    }

    // The main window is going away.
    destroy(): void {
        for (const window of [...this.windows.values()]) window.close();
    }
}
