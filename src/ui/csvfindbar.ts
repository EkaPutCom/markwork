// The search bar of the CSV tab. It looks and works like the one of the text editor (ui/findbar.ts): the same template, so the
// same field, the Aa / ab / .* switches, the Replace row, the counter, and the arrows. What it does with the text is the
// table's business (ui/csvpage.ts), so this only holds the widgets and reports what the user did.

import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk?version=4.0';
import { onKeyPress, uiTemplate } from '../gtkutil.js';
import type { SearchOptions } from '../markdown/search.js';
import template from './findbar.ui?raw';

export class CsvFindBar extends Gtk.SearchBar {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkCsvFindBar',
            // The text editor's template under this class's own name.
            Template: uiTemplate(template.replace('class="MarkworkFindBar"', 'class="MarkworkCsvFindBar"')),
            InternalChildren: [
                'entry', 'previous', 'next', 'box', 'expand', 'caseButton', 'wordButton', 'regexButton',
                'count', 'replaceRow', 'replaceEntry', 'replaceOne', 'replaceAll', 'closeButton',
            ],
        }, this);
    }
    declare _entry: Gtk.Entry;
    declare _previous: Gtk.Button;
    declare _next: Gtk.Button;
    declare _box: Gtk.Box;
    declare _expand: Gtk.ToggleButton;
    declare _caseButton: Gtk.ToggleButton;
    declare _wordButton: Gtk.ToggleButton;
    declare _regexButton: Gtk.ToggleButton;
    declare _count: Gtk.Label;
    declare _replaceRow: Gtk.Revealer;
    declare _replaceEntry: Gtk.Entry;
    declare _replaceOne: Gtk.Button;
    declare _replaceAll: Gtk.Button;
    declare _closeButton: Gtk.Button;

    // What the user did.
    onChanged: () => void = () => {};      // the text or an option changed
    onNext: () => void = () => {};
    onPrevious: () => void = () => {};
    onReplace: () => void = () => {};      // Replace: the current match, and on to the next
    onReplaceAll: () => void = () => {};
    onEscape: () => void = () => {};       // Escape or the close button: the owner puts the focus back, then closes the bar
    onClosed: () => void = () => {};       // the bar is no longer shown

    constructor() {
        super();
        // The template's child property is not applied to GtkSearchBar, so the box is attached here.
        this.set_child(this._box);
        // The counter only takes room while it has something to say, so the close button stays next to the buttons.
        this._count.connect('notify::label', () => { this._count.visible = this._count.label !== ''; });

        const entry = this._entry;
        entry.connect('changed', () => this.onChanged());
        entry.connect('activate', () => this.onNext());
        // Shift+Enter goes back; the plain GtkEntry has no previous-match signal like GtkSearchEntry.
        onKeyPress(entry, (keyval, state) => {
            if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || !(state & Gdk.ModifierType.SHIFT_MASK)) return false;
            this.onPrevious();
            return true;
        }, Gtk.PropagationPhase.CAPTURE);
        this._previous.connect('clicked', () => this.onPrevious());
        this._next.connect('clicked', () => this.onNext());
        for (const toggle of [this._caseButton, this._wordButton, this._regexButton]) toggle.connect('toggled', () => this.onChanged());
        this._expand.connect('toggled', () => {
            this._replaceRow.reveal_child = this._expand.active;
            this._expand.icon_name = this._expand.active ? 'pan-down-symbolic' : 'pan-end-symbolic';
        });
        this._replaceEntry.connect('activate', () => this.onReplace());
        this._replaceOne.connect('clicked', () => this.onReplace());
        this._replaceAll.connect('clicked', () => this.onReplaceAll());
        this._closeButton.connect('clicked', () => this.onEscape());
        // A plain GtkEntry has no stop-search signal like GtkSearchEntry: Escape closes the bar from either field.
        for (const field of [entry, this._replaceEntry]) {
            onKeyPress(field, keyval => {
                if (keyval !== Gdk.KEY_Escape) return false;
                this.onEscape();
                return true;
            });
        }
        this.connect_entry(entry);
        this.connect('notify::search-mode-enabled', () => { if (!this.search_mode_enabled) this.onClosed(); });
    }

    get query(): string { return this._entry.text; }
    get replacement(): string { return this._replaceEntry.text; }
    get options(): SearchOptions {
        return { caseSensitive: this._caseButton.active, wholeWord: this._wordButton.active, regex: this._regexButton.active };
    }

    // Show the bar, with the Replace row when asked for (Ctrl+H) and `text` in the field when there is some to look for.
    open(withReplace: boolean, text = ''): void {
        this.search_mode_enabled = true;
        if (withReplace) this._expand.active = true;
        if (text) this._entry.text = text;
        this._entry.grab_focus();
    }

    close(): void {
        this.search_mode_enabled = false;
    }

    // What the counter says ('' = nothing), and whether the text is an expression that does not compile.
    setCount(count: string, invalid: boolean): void {
        this._count.label = count;
        if (invalid) this._entry.add_css_class('error'); else this._entry.remove_css_class('error');
    }

    // For the tests.
    setQuery(text: string): void { this._entry.text = text; }
    setReplacement(text: string): void { this._replaceEntry.text = text; }
    get counter(): string { return this._count.label ?? ''; }
    get replaceShown(): boolean { return this._replaceRow.reveal_child; }
    get buttons(): { matchCase: Gtk.ToggleButton; wholeWord: Gtk.ToggleButton; regex: Gtk.ToggleButton } {
        return { matchCase: this._caseButton, wholeWord: this._wordButton, regex: this._regexButton };
    }
}
