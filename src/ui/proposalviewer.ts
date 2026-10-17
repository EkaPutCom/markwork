// Review window for agent change proposals: the diff is shown like a Git history diff, with
// Reject and Apply buttons at the bottom. Closing the window without choosing is the same as rejecting. The decision is returned
// through `onDecision` exactly once. Apply asks the core to write the chosen files (`onApply`, see app/assistant.ts); the
// window never writes a file itself.
//
// A batch has a checkbox per file: the user may apply only some. The note box is passed to the agent
// together with the decision (e.g. the reason for rejecting), so the agent can improve its proposal.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import { describeChange, diffPreview, unifiedDiff, type Change } from '../agent/changes.js';
import { parseDiff, type DiffLine } from '../gitlog.js';
import { createDiffView, fillDiff, setupDiffTags } from './historyviewer.js';
import { onKeyPress, pack } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

// Diff lines for one change; delete and move get a caption because the content diff alone does not explain them.
export function changeDiff(c: Change, inBatch: boolean): DiffLine[] {
    const head: DiffLine[] = inBatch ? [{ kind: 'hunk', text: fmt(_('File: {file}'), { file: c.file }) }] : [];
    if (c.kind === 'move') return [...head, { kind: 'hunk', text: fmt(_('Move: {file} → {to} (contents unchanged)'), { file: c.file, to: c.to ?? '' }) }];
    if (c.kind === 'delete') head.push({ kind: 'hunk', text: fmt(_('Moved to the Trash: {file}'), { file: c.file }) });
    return [...head, ...parseDiff(unifiedDiff(c.before, c.after))];
}

export class ProposalViewer {
    readonly window: Adw.Window;
    readonly diffView: Gtk.TextView;
    readonly applyButton: Gtk.Button;
    readonly rejectButton: Gtk.Button;
    readonly noteEntry: Gtk.Entry;
    readonly checks: Gtk.CheckButton[] = [];   // one per file in a batch; empty for a single proposal
    private readonly status: Gtk.Label;
    private decided = false;
    // Called once. applied=false without an error = rejected (including the window being closed).
    onDecision: (applied: boolean) => void = () => {};
    // Ask the core to apply the chosen files of a batch (null = the whole proposal): an error message, or null once written.
    onApply: (chosen: number[] | null) => string | null = () => _('History is read-only');
    error = '';
    accepted: number[] | null = null;   // indices applied if only part of the batch
    note = '';

    constructor(parent: Gtk.Window | null, readonly change: Change | Change[], dark: boolean, readOnly = false) {
        this.window = new Adw.Window({ transient_for: parent, default_width: 860, default_height: 620 });
        const changes = Array.isArray(change) ? change : [change];
        const title = changes.length > 1 ? fmt(_('Batch: {count} files'), { count: changes.length }) : describeChange(changes[0]);
        const header = new Adw.HeaderBar();
        this.window.set_title(fmt(_('Agent proposal: {title}'), { title }));

        const subject = new Gtk.Label({ xalign: 0, wrap: true });
        subject.set_markup(`<b>${GLib.markup_escape_text(title, -1)}</b>`);
        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 12, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        info.append(subject);
        const reason = changes.map(c => `${changes.length > 1 ? c.file + ': ' : ''}${c.reason.trim()}`).join('\n');
        const meta = new Gtk.Label({ label: reason || _('The agent gave no reason.'), xalign: 0, wrap: true });
        meta.add_css_class('dim-label');
        info.append(meta);

        this.diffView = createDiffView();
        setupDiffTags(this.diffView, dark);
        fillDiff(this.diffView, changes.flatMap(c => changeDiff(c, Array.isArray(change))));
        const scroll = new Gtk.ScrolledWindow();
        scroll.set_child(this.diffView);

        this.status = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true, visible: false });
        this.status.add_css_class('chat-error');
        this.rejectButton = new Gtk.Button({ label: _('Reject') });
        this.applyButton = new Gtk.Button({ label: _('Apply') });
        this.applyButton.add_css_class('suggested-action');
        this.noteEntry = new Gtk.Entry({ placeholder_text: _('Note for the agent (optional), e.g. the reason for rejecting'), hexpand: true });
        if (readOnly) { this.applyButton.hide(); this.rejectButton.set_label(_('Close')); this.noteEntry.hide(); }
        const bar = new Gtk.Box({ spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10 });
        pack(bar, this.noteEntry, true);
        bar.append(this.rejectButton);
        bar.append(this.applyButton);

        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.append(info);
        if (changes.length > 1 && !readOnly) {
            const picks = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 12, margin_end: 12, margin_bottom: 8 });
            const hint = new Gtk.Label({ label: _('Files to apply (uncheck to reject some):'), xalign: 0 });
            hint.add_css_class('dim-label');
            picks.append(hint);
            for (const c of changes) {
                const d = diffPreview(c.before, c.after);
                const check = new Gtk.CheckButton({ label: `${describeChange(c)}${c.kind === 'move' ? '' : ` · +${d.added} −${d.removed}`}`, active: true });
                check.connect('toggled', () => this.updateApplyLabel());
                this.checks.push(check);
                picks.append(check);
            }
            const pickScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: 160 });
            pickScroll.set_child(picks);
            body.append(pickScroll);
        }
        body.append(new Gtk.Separator());
        pack(body, scroll, true);
        body.append(new Gtk.Separator());
        body.append(this.status);
        body.append(bar);
        const view = new Adw.ToolbarView({ content: body });
        view.add_top_bar(header);
        this.window.set_content(view);
        this.status.set_margin_start(10);
        this.status.set_margin_end(10);
        this.status.set_margin_top(8);

        this.applyButton.connect('clicked', () => {
            if (readOnly) return;
            const chosen = this.checks.length ? changes.map((_, i) => i).filter(i => this.checks[i].active) : null;
            if (chosen && !chosen.length) return;
            const partial = chosen && chosen.length < changes.length ? chosen : null;
            const error = this.onApply(partial);
            if (error) {
                // Stays open so the user can read the reason; Reject/close finishes the turn.
                this.status.set_text(fmt(_('Failed to apply: {error}'), { error }));
                this.status.show();
                this.applyButton.set_sensitive(false);
                this.finish(false, error);
            } else {
                this.accepted = partial;
                this.finish(true);
                this.window.destroy();
            }
        });
        this.rejectButton.connect('clicked', () => { this.finish(false); this.window.destroy(); });
        // GTK 4 does not emit "destroy" while its object is held by JavaScript; "unrealize" marks the window as closed.
        this.window.connect('unrealize', () => this.finish(false));
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.finish(false);
            this.window.destroy();
            return true;
        });
    }

    private updateApplyLabel(): void {
        const n = this.checks.filter(c => c.active).length;
        this.applyButton.set_label(n === this.checks.length ? _('Apply') : fmt(_('Apply {n} of {length}'), { n, length: this.checks.length }));
        this.applyButton.set_sensitive(n > 0);
    }

    private finish(applied: boolean, error = ''): void {
        if (this.decided) return;
        this.decided = true;
        this.error = error;
        this.note = this.noteEntry.get_text().trim();
        this.onDecision(applied);
    }

    setDark(dark: boolean): void {
        setupDiffTags(this.diffView, dark);
    }

    show(): void {
        this.window.present();
    }

    close(): void {
        this.finish(false);
        this.window.destroy();
    }
}
