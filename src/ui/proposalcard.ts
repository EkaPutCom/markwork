// Change proposals in the Assistant panel: a compact card per proposal, the review window it opens, and the Undo
// button of applied changes. Files are not touched before Apply; closing the window, Reject, or stopping the turn
// is the same as rejecting.

import Gtk from 'gi://Gtk?version=4.0';
import type { ChatController } from '../agent/chatcontroller.js';
import type { ActionEvent } from '../agent/journal.js';
import type { ProposalResult } from '../agent/session.js';
import { diffPreview, describeChange, type Change } from '../agent/changes.js';
import { escapeMarkup } from '../markdown/pango.js';
import { ProposalViewer } from './proposalviewer.js';
import { _, fmt } from '../i18n.js';
import type { Cancellable } from '../cancel.js';

export interface ProposalEnv {
    controller: ChatController;
    window(): Gtk.Window | null;                  // parent of the review window
    dark(): boolean;
    note(text: string, error: boolean): void;     // a message in the panel
}

export class ProposalCards {
    viewer: ProposalViewer | null = null;   // the review window waiting for a decision

    constructor(private readonly env: ProposalEnv) {}

    // A card for the proposal; `start` opens the review window and resolves with the user's decision.
    card(change: Change | Change[], apply: (change: Change | Change[]) => string | null, cancelled: Cancellable): { widget: Gtk.Box; start: () => Promise<ProposalResult> } {
        const changes = Array.isArray(change) ? change : [change];
        const description = Array.isArray(change) ? fmt(_('Change batch · {count} files'), { count: changes.length }) : describeChange(change);
        const reasonText = changes.map(c => `${c.file}: ${c.reason}`).join('\n');
        const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        card.add_css_class('chat-proposal');
        const title = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, use_markup: true, selectable: true });
        title.set_markup(`<b>${escapeMarkup(description)}</b>`);
        card.append(title);
        if (reasonText.trim()) {
            const reason = new Gtk.Label({ label: reasonText.trim(), xalign: 0, wrap: true, max_width_chars: 44, selectable: true });
            reason.add_css_class('side-meta');
            card.append(reason);
        }
        const diff = changes.map(c => diffPreview(c.before, c.after)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
        const status = new Gtk.Label({ label: fmt(_('+{added} −{removed} · waiting for your decision'), { added: diff.added, removed: diff.removed }), xalign: 0, wrap: true, max_width_chars: 44 });
        status.add_css_class('side-meta');
        const review = new Gtk.Button({ label: _('Review changes'), halign: Gtk.Align.START });
        review.add_css_class('suggested-action');
        card.append(status);
        card.append(review);
        return { widget: card, start: () => this.decide(change, changes, apply, cancelled, card, status, review) };
    }

    private decide(change: Change | Change[], changes: Change[], apply: (change: Change | Change[]) => string | null, cancelled: Cancellable,
                   card: Gtk.Box, status: Gtk.Label, review: Gtk.Button): Promise<ProposalResult> {
        return new Promise<ProposalResult>(resolve => {
            let done = false;
            const finish = (result: ProposalResult, text: string, error = false) => {
                if (done) return;
                done = true;
                this.viewer = null;
                review.hide();
                status.set_text(text);
                status.remove_css_class('side-meta');
                status.remove_css_class('chat-error');
                status.add_css_class(error ? 'chat-error' : 'side-meta');
                resolve(result);
            };
            const applied = (kept: Change[], result: ProposalResult, text: string) => {
                finish(result, text);
                if (this.env.controller.canUndo) card.append(this.undoButton(kept, status));
            };
            const open = () => {
                if (done) return;
                if (this.viewer) { this.viewer.show(); return; }
                const viewer = new ProposalViewer(this.env.window(), change, this.env.dark(), apply);
                viewer.onDecision = ok => {
                    const note = viewer.note ? { note: viewer.note } : {};
                    if (ok && viewer.accepted) applied(viewer.accepted.map(i => changes[i]), { applied: true, accepted: viewer.accepted, ...note }, fmt(_('Applied {applied} of {count} files.'), { applied: viewer.accepted.length, count: changes.length }));
                    else if (ok) applied(changes, { applied: true, ...note }, _('Applied.'));
                    else if (viewer.error) finish({ applied: false, error: viewer.error, ...note }, fmt(_('Failed to apply: {error}'), { error: viewer.error }), true);
                    else finish({ applied: false, ...note }, viewer.note ? fmt(_('Rejected: {note}'), { note: viewer.note }) : _('Rejected.'));
                };
                this.viewer = viewer;
                viewer.show();
            };
            review.connect('clicked', open);
            cancelled.onCancel(() => {
                const viewer = this.viewer;
                finish({ applied: false }, _('Cancelled.'));
                viewer?.close();
            });
            open();
        });
    }

    // A past action from a reopened conversation: its diff (read-only), and Undo if it is still applied.
    historyRow(event: ActionEvent): Gtk.Box {
        const row = new Gtk.Box({ spacing: 6, halign: Gtk.Align.START });
        const review = new Gtk.Button({ label: fmt(_('View diff · {count} files'), { count: event.changes.length }), tooltip_text: event.changes.map(c => c.file).join('\n') });
        review.connect('clicked', () => new ProposalViewer(this.env.window(), event.changes, this.env.dark(), () => _('History is read-only'), true).show());
        row.append(review);
        if (event.status === 'applied' && this.env.controller.canUndo) row.append(this.undoButton(event.changes, null));
        return row;
    }

    // The Undo button for agent changes that were already applied (see ChatController.undo).
    private undoButton(changes: Change[], status: Gtk.Label | null): Gtk.Button {
        const button = new Gtk.Button({ label: _('Undo'), halign: Gtk.Align.START, tooltip_text: _('Restore the files to their contents before this change') });
        button.connect('clicked', () => {
            const { controller } = this.env;
            if (controller.busy) { this.env.note('Wait for the agent to finish before undoing the change.', true); return; }
            const error = controller.undo(changes);
            if (error) { this.env.note(fmt(_('Cannot be undone: {error}'), { error }), true); return; }
            button.hide();
            status?.set_text(_('Undone.'));
        });
        return button;
    }
}
