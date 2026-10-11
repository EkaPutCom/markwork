// Search bar (Ctrl+F) using GtkSource.SearchContext, which also highlights
// all results in the editor.

import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import GObject from 'gi://GObject';

import { uiTemplate } from '../gtkutil.js';
import template from './findbar.ui?raw';

export class FindBar extends Gtk.SearchBar {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkFindBar',
            Template: uiTemplate(template),
            InternalChildren: ['entry', 'previous', 'next'],
        }, this);
    }
    declare _entry: Gtk.SearchEntry;
    declare _previous: Gtk.Button;
    declare _next: Gtk.Button;

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

        const entry = this._entry;
        entry.connect('search-changed', () => {
            this.settings.search_text = entry.text || null;
            this.findNext(true);
        });
        entry.connect('activate', () => this.findNext());
        entry.connect('next-match', () => this.findNext());
        entry.connect('previous-match', () => this.findPrevious());
        entry.connect('stop-search', () => this.close());
        this._previous.connect('clicked', () => this.findPrevious());
        this._next.connect('clicked', () => this.findNext());

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
    }

    open(): void {
        this.search_mode_enabled = true;
        this._entry.grab_focus();
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
