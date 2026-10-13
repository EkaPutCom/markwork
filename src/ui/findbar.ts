// Search bar (Ctrl+F) using GtkSource.SearchContext, which also highlights
// all results in the editor.

import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import GObject from 'gi://GObject';

import Gdk from 'gi://Gdk?version=4.0';
import { onKeyPress, uiTemplate } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import template from './findbar.ui?raw';

export class FindBar extends Gtk.SearchBar {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkFindBar',
            Template: uiTemplate(template),
            InternalChildren: [
                'entry', 'previous', 'next', 'box', 'expand', 'caseButton', 'wordButton', 'regexButton',
                'count', 'replaceRow', 'replaceEntry', 'replaceOne', 'replaceAll',
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

    buffer: GtkSource.Buffer;
    view: Gtk.TextView;
    readonly settings: GtkSource.SearchSettings;
    context: GtkSource.SearchContext;

    constructor(buffer: GtkSource.Buffer, view: Gtk.TextView) {
        super();
        this.buffer = buffer;
        this.view = view;
        this.settings = new GtkSource.SearchSettings({ wrap_around: true, case_sensitive: false });
        this.context = new GtkSource.SearchContext({ buffer, settings: this.settings });

        // The template's child property is not applied to GtkSearchBar, so the box is attached here.
        this.set_child(this._box);

        const entry = this._entry;
        entry.connect('changed', () => {
            this.settings.search_text = entry.text || null;
            this.findNext(true);
        });
        entry.connect('activate', () => this.findNext());
        // Shift+Enter goes back; the plain GtkEntry has no previous-match signal like GtkSearchEntry.
        onKeyPress(entry, (keyval, state) => {
            if (keyval !== Gdk.KEY_Return || !(state & Gdk.ModifierType.SHIFT_MASK)) return false;
            this.findPrevious();
            return true;
        }, Gtk.PropagationPhase.CAPTURE);
        this._previous.connect('clicked', () => this.findPrevious());
        this._next.connect('clicked', () => this.findNext());

        this._caseButton.connect('toggled', () => { this.settings.case_sensitive = this._caseButton.active; });
        this._wordButton.connect('toggled', () => { this.settings.at_word_boundaries = this._wordButton.active; });
        this._regexButton.connect('toggled', () => { this.settings.regex_enabled = this._regexButton.active; });
        this._expand.connect('toggled', () => {
            this._replaceRow.reveal_child = this._expand.active;
            this._expand.icon_name = this._expand.active ? 'pan-down-symbolic' : 'pan-end-symbolic';
        });
        this._replaceEntry.connect('activate', () => this.replaceCurrent());
        this._replaceOne.connect('clicked', () => this.replaceCurrent());
        this._replaceAll.connect('clicked', () => this.replaceEverything());
        this.watchContext();

        this.connect_entry(entry);
        // Result highlights disappear when the bar is closed.
        this.connect('notify::search-mode-enabled', () => {
            this.settings.search_text = this.search_mode_enabled ? (entry.text || null) : null;
        });
    }

    // Switch to another editor (changing tabs). The search text stays; the result highlights in the old buffer are released.
    setTarget(buffer: GtkSource.Buffer, view: Gtk.TextView): void {
        if (buffer === this.buffer) return;
        this.buffer = buffer;
        this.view = view;
        this.context = new GtkSource.SearchContext({ buffer, settings: this.settings });
        this.watchContext();
    }

    // The match counter and the invalid-regex mark follow the current search context.
    private watchContext(): void {
        const context = this.context;
        const update = () => {
            if (context !== this.context) return;
            const text = this.settings.search_text;
            const invalid = !!text && !!context.get_regex_error();
            if (invalid) this._entry.add_css_class('error'); else this._entry.remove_css_class('error');
            const total = context.get_occurrences_count();
            if (!text || invalid || total < 0) { this._count.label = ''; return; }
            if (total === 0) { this._count.label = _('No results'); return; }
            const [has, s, e] = this.buffer.get_selection_bounds();
            const position = has ? context.get_occurrence_position(s, e) : 0;
            this._count.label = position > 0 ? fmt(_('{current} of {total}'), { current: position, total }) : String(total);
        };
        context.connect('notify::occurrences-count', update);
        context.connect('notify::regex-error', update);
        this.buffer.connect('mark-set', update);
        update();
    }

    open(withReplace = false): void {
        this.search_mode_enabled = true;
        if (withReplace) this._expand.active = true;
        const [has, s, e] = this.buffer.get_selection_bounds();
        // A one-line selection becomes the search text.
        if (has && !this.buffer.get_text(s, e, false).includes('\n')) this._entry.text = this.buffer.get_text(s, e, false);
        this._entry.grab_focus();
    }

    replaceCurrent(): void {
        const [has, s, e] = this.buffer.get_selection_bounds();
        if (has && this.settings.search_text && this.context.get_regex_error() === null) {
            try {
                if (this.context.replace(s, e, this._replaceEntry.text, -1)) this.findNext();
                return;
            } catch (error) { return; }
        }
        this.findNext();
    }

    replaceEverything(): void {
        if (!this.settings.search_text || this.context.get_regex_error()) return;
        try { this.context.replace_all(this._replaceEntry.text, -1); } catch (error) { /* invalid replacement in regex mode */ }
    }

    close(): void {
        this.search_mode_enabled = false;
        this.view.grab_focus();
    }

    // fromSelectionStart: when the search text changes, search starting from the start of the selection
    // so the currently selected result is kept if it still matches.
    findNext(fromSelectionStart = false): void {
        if (!this.settings.search_text) return;
        const [has, s, e] = this.buffer.get_selection_bounds();
        const from = has ? (fromSelectionStart ? s : e) : this.buffer.get_iter_at_mark(this.buffer.get_insert());
        this.select(this.context.forward(from));
    }

    findPrevious(): void {
        if (!this.settings.search_text) return;
        const [has, s] = this.buffer.get_selection_bounds();
        this.select(this.context.backward(has ? s : this.buffer.get_iter_at_mark(this.buffer.get_insert())));
    }

    private select([found, start, end]: [boolean, Gtk.TextIter | null, Gtk.TextIter | null, boolean]): void {
        if (!found || !start || !end) return;
        this.buffer.select_range(start, end);
        this.view.scroll_to_iter(start, 0.1, false, 0, 0);
    }
}
