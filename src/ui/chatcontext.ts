// The Assistant panel's context button and popover: the token estimate of what would be sent, the parts it is made
// of, and the switches for the active document, the selection, and the other files.

import Gtk from 'gi://Gtk?version=4.0';
import type { BuiltContext, ContextOptions } from '../agent/context.js';
import { childrenOf } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';

const KIND_LABEL = { map: _('Map'), active: _('Document'), selection: _('Selection'), mention: _('Attachment'), excerpt: _('Excerpt') };

export const fmtTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

// A one-line summary of what is sent: the document, selection, attachments, and the number of excerpts per file.
export function describeContext(built: BuiltContext): string {
    const parts = [fmt(_('≈{tokens} tokens'), { tokens: fmtTokens(built.tokens) })];
    const excerpts = new Map<string, number>();
    for (const item of built.items) {
        if (item.kind === 'excerpt') {
            const file = item.label.split(' › ')[0];
            excerpts.set(file, (excerpts.get(file) ?? 0) + 1);
        } else if (item.kind !== 'map') {
            parts.push(item.label);
        }
    }
    for (const [file, n] of excerpts) parts.push(fmt(ngettext('{count} excerpt from {file}', '{count} excerpts from {file}', n), { count: n, file }));
    if (built.unknownMentions.length) parts.push(fmt(_('not found: {names}'), { names: built.unknownMentions.map(m => `@${m}`).join(', ') }));
    return fmt(_('Context: {parts}'), { parts: parts.join(' · ') });
}

export interface ContextWidgets {
    button: Gtk.MenuButton;
    popover: Gtk.Popover;
    list: Gtk.Box;
    checks: [Gtk.CheckButton, keyof ContextOptions][];
}

export class ContextPreview {
    // options: what is sent now; changed: a switch was turned (the new options); preview: builds the context of the text
    // being typed; budget: in tokens.
    constructor(private readonly w: ContextWidgets, private readonly options: () => ContextOptions, changed: (options: ContextOptions) => void,
                private readonly preview: () => BuiltContext, private readonly budget: () => number) {
        for (const [check, key] of w.checks) {
            check.active = options()[key];
            check.connect('toggled', () => {
                if (this.options()[key] === check.active) return;
                changed({ ...this.options(), [key]: check.active });
                this.update();
            });
        }
        w.popover.connect('show', () => this.update());
    }

    // The switches follow the options the core has.
    show(options: ContextOptions): void {
        for (const [check, key] of this.w.checks) if (check.active !== options[key]) check.set_active(options[key]);
    }

    setSummary(built: BuiltContext): void {
        // No arrow of its own: a labeled GTK 4 MenuButton already shows its popover direction arrow.
        this.w.button.set_label(fmt(_('Context · ≈{tokens} tokens'), { tokens: fmtTokens(built.tokens) }));
    }

    // The popover's list: one row per part with its tokens, the total against the budget, and unknown @mentions.
    update(): void {
        const list = this.w.list;
        for (const child of childrenOf(list)) list.remove(child);
        const built = this.preview();
        const add = (text: string, dim = false) => {
            const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, ellipsize: 3 });
            if (dim) l.add_css_class('side-meta');
            l.show();
            list.append(l);
        };
        if (!built.items.length) add('No document context is being sent.', true);
        for (const item of built.items) add(`${KIND_LABEL[item.kind]}: ${item.label} · ${fmtTokens(item.tokens)}`);
        add(fmt(_('Total ≈{tokens} tokens of the {budget} budget'), { tokens: fmtTokens(built.tokens), budget: fmtTokens(this.budget()) }), true);
        for (const m of built.unknownMentions) add(fmt(_('File @{name} was not found in the project folder.'), { name: m }), true);
        this.setSummary(built);
    }
}
