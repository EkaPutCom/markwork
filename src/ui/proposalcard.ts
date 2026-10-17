// Change proposals in the Assistant panel: a compact card per proposal, the review window it opens, and the Undo
// button of applied changes. Files are not touched before Apply, and then only by the core (app/assistant.ts) through
// `apply`; closing the window or Reject is the same as rejecting, and a stopped turn closes the review (`cancel`).

import Gtk from 'gi://Gtk?version=4.0';
import type { ActionEvent } from '../agent/journal.js';
import type { ProposalAnswer, ProposalAsk } from '../app/assistant.js';
import { diffPreview, describeChange, type Change } from '../agent/changes.js';
import { escapeMarkup } from '../markdown/pango.js';
import { ProposalViewer } from './proposalviewer.js';
import { _, fmt } from '../i18n.js';

export interface ProposalEnv {
    apply(ask: number, chosen: number[] | null): string | null;   // ask the core to write: an error message, or null
    undo(changes: Change[]): string | null;
    busy(): boolean;
    window(): Gtk.Window | null;                  // parent of the review window
    dark(): boolean;
    note(text: string, error: boolean): void;     // a message in the panel
}

export class ProposalCards {
    viewer: ProposalViewer | null = null;   // the review window waiting for a decision
    private readonly cancels = new Map<number, () => void>();   // the open asks, by id

    constructor(private readonly env: ProposalEnv) {}

    // A card for the proposal; `start` opens the review window and resolves with the user's decision.
    card(ask: ProposalAsk): { widget: Gtk.Box; start: () => Promise<ProposalAnswer> } {
        const { changes } = ask;
        const description = ask.batch ? fmt(_('Change batch · {count} files'), { count: changes.length }) : describeChange(changes[0]);
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
        return { widget: card, start: () => this.decide(ask, card, status, review) };
    }

    // The stopped turn's review closes without an answer; the card says so.
    cancel(ask: number): void {
        this.cancels.get(ask)?.();
    }

    private decide(ask: ProposalAsk, card: Gtk.Box, status: Gtk.Label, review: Gtk.Button): Promise<ProposalAnswer> {
        const { changes } = ask;
        return new Promise<ProposalAnswer>(resolve => {
            let done = false;
            const finish = (note: string, text: string, error = false) => {
                if (done) return;
                done = true;
                this.cancels.delete(ask.id);
                this.viewer = null;
                review.hide();
                status.set_text(text);
                status.remove_css_class('side-meta');
                status.remove_css_class('chat-error');
                status.add_css_class(error ? 'chat-error' : 'side-meta');
                resolve({ note });
            };
            const applied = (kept: Change[], note: string, text: string) => {
                finish(note, text);
                card.append(this.undoButton(kept, status));
            };
            const open = () => {
                if (done) return;
                if (this.viewer) { this.viewer.show(); return; }
                const viewer = new ProposalViewer(this.env.window(), ask.batch ? changes : changes[0], this.env.dark());
                viewer.onApply = chosen => this.env.apply(ask.id, chosen);
                viewer.onDecision = ok => {
                    const { note } = viewer;
                    if (ok && viewer.accepted) applied(viewer.accepted.map(i => changes[i]), note, fmt(_('Applied {applied} of {count} files.'), { applied: viewer.accepted.length, count: changes.length }));
                    else if (ok) applied(changes, note, _('Applied.'));
                    else if (viewer.error) finish(note, fmt(_('Failed to apply: {error}'), { error: viewer.error }), true);
                    else finish(note, note ? fmt(_('Rejected: {note}'), { note }) : _('Rejected.'));
                };
                this.viewer = viewer;
                viewer.show();
            };
            review.connect('clicked', open);
            this.cancels.set(ask.id, () => {
                const viewer = this.viewer;
                finish('', _('Cancelled.'));
                viewer?.close();
            });
            open();
        });
    }

    // A past action from a reopened conversation: its diff (read-only), and Undo if it is still applied.
    historyRow(event: ActionEvent): Gtk.Box {
        const row = new Gtk.Box({ spacing: 6, halign: Gtk.Align.START });
        const review = new Gtk.Button({ label: fmt(_('View diff · {count} files'), { count: event.changes.length }), tooltip_text: event.changes.map(c => c.file).join('\n') });
        review.connect('clicked', () => new ProposalViewer(this.env.window(), event.changes, this.env.dark(), true).show());
        row.append(review);
        if (event.status === 'applied') row.append(this.undoButton(event.changes, null));
        return row;
    }

    // The Undo button for agent changes that were already applied (see ChatController.undo); the core writes the reverse.
    private undoButton(changes: Change[], status: Gtk.Label | null): Gtk.Button {
        const button = new Gtk.Button({ label: _('Undo'), halign: Gtk.Align.START, tooltip_text: _('Restore the files to their contents before this change') });
        button.connect('clicked', () => {
            if (this.env.busy()) { this.env.note('Wait for the agent to finish before undoing the change.', true); return; }
            const error = this.env.undo(changes);
            if (error) { this.env.note(fmt(_('Cannot be undone: {error}'), { error }), true); return; }
            button.hide();
            status?.set_text(_('Undone.'));
        });
        return button;
    }
}
