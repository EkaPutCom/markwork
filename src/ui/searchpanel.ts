// The Search panel in the sidebar: search (and replace) in all the Markdown files of the work folder.
// Results are grouped per file, as a flat list of file rows and hit rows in a Gtk.ListView; a file row folds its hits.
// The panel is a view (SearchView, app/search.ts): it reports the query and what the user did, and draws the results it
// is sent. Where the files come from and how a change is applied is the controller's.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import { activeFilters, type FileHits, type SearchOptions } from '../markdown/search.js';
import type { SearchQuery, SearchResults, SearchView } from '../app/search.js';
import { pack } from '../gtkutil.js';
import { _ } from '../i18n.js';

const DEBOUNCE_MS = 250;

class Row extends GObject.Object {
    static {
        GObject.registerClass({ GTypeName: 'MarkworkSearchRow' }, this);
    }
    kind: 'file' | 'hit' = 'hit';
    markup = '';
    count = 0;
    expanded = true;
    file = '';
    index = 0;            // the hit's place in its file's list
}

const esc = (s: string): string => GLib.markup_escape_text(s, -1);

export class SearchPanel implements SearchView {
    readonly widget: Gtk.Box;
    readonly entry: Gtk.Entry;
    readonly replaceEntry: Gtk.Entry;
    readonly caseButton: Gtk.ToggleButton;
    readonly wordButton: Gtk.ToggleButton;
    readonly regexButton: Gtk.ToggleButton;
    readonly filterButton: Gtk.ToggleButton;
    readonly filterRow: Gtk.Revealer;
    readonly includeEntry: Gtk.Entry;
    readonly excludeEntry: Gtk.Entry;
    readonly summary: Gtk.Label;
    readonly expand: Gtk.ToggleButton;
    readonly replaceRow: Gtk.Revealer;
    readonly replaceAll: Gtk.Button;
    readonly store = new Gio.ListStore({ item_type: Row.$gtype });
    readonly list: Gtk.ListView;
    private results: FileHits[] = [];
    onSearch: (query: SearchQuery) => void = () => {};
    onOpenHit: (file: string, index: number) => void = () => {};
    onReplaceAll: (replacement: string) => void = () => {};
    private readonly folded = new Set<string>();
    private timer = 0;

    constructor() {
        const title = new Gtk.Label({ label: _('SEARCH'), xalign: 0, margin_start: 16 });
        title.add_css_class('side-title');
        const refresh = Gtk.Button.new_from_icon_name('view-refresh-symbolic');
        refresh.set_has_frame(false);
        refresh.set_tooltip_text(_('Search again'));
        refresh.connect('clicked', () => this.run());
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 6, margin_end: 6 });
        pack(header, title, true);
        header.append(refresh);

        this.expand = new Gtk.ToggleButton({ icon_name: 'pan-end-symbolic', tooltip_text: _('Replace'), valign: Gtk.Align.START });
        this.expand.add_css_class('flat');
        this.expand.add_css_class('circular');
        // The options sit inside the search field, as small chips over its right end.
        this.entry = new Gtk.Entry({ hexpand: true, placeholder_text: _('Search'), width_chars: 6, primary_icon_name: 'edit-find-symbolic' });
        this.entry.add_css_class('search-field');
        const chip = (label: string, tooltip: string): Gtk.ToggleButton => {
            const button = new Gtk.ToggleButton({ label, tooltip_text: tooltip, valign: Gtk.Align.CENTER });
            button.add_css_class('flat');
            button.add_css_class('search-chip');
            return button;
        };
        this.caseButton = chip('Aa', _('Match Case'));
        this.wordButton = chip('ab', _('Whole Words'));
        this.regexButton = chip('.*', _('Regular Expression'));
        const chips = new Gtk.Box({ spacing: 2, halign: Gtk.Align.END, valign: Gtk.Align.CENTER, margin_end: 4 });
        for (const button of [this.caseButton, this.wordButton, this.regexButton]) chips.append(button);
        const searchField = new Gtk.Overlay({ child: this.entry });
        searchField.add_overlay(chips);

        this.replaceEntry = new Gtk.Entry({ hexpand: true, placeholder_text: _('Replace'), width_chars: 6 });
        this.replaceEntry.add_css_class('replace-field');
        // A chip over the right end of the field, like the search options; Enter does the same.
        this.replaceAll = new Gtk.Button({ label: _('All'), tooltip_text: _('Replace All'), halign: Gtk.Align.END, valign: Gtk.Align.CENTER, margin_end: 4 });
        this.replaceAll.add_css_class('flat');
        this.replaceAll.add_css_class('search-chip');
        const replaceField = new Gtk.Overlay({ child: this.replaceEntry });
        replaceField.add_overlay(this.replaceAll);
        this.replaceRow = new Gtk.Revealer({ child: replaceField, transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN });
        // Always visible: which files take part, as comma separated globs.
        const filter = (placeholder: string, tooltip: string): Gtk.Entry => new Gtk.Entry({
            hexpand: true, width_chars: 6, placeholder_text: placeholder, tooltip_text: tooltip,
        });
        const globs = _('Separate patterns with commas. * matches within a folder, ** matches across folders, a name matches that folder or file anywhere.');
        this.includeEntry = filter(_('Files to include: agenda/**, *.md'), globs);
        this.excludeEntry = filter(_('Files to exclude: drafts/**'), globs);
        const fields = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        // The ··· button folds the two fields away; it stays lit while a filter is set, so a hidden filter is not forgotten.
        this.filterButton = new Gtk.ToggleButton({ icon_name: 'view-more-horizontal-symbolic', tooltip_text: _('Files to include and exclude'), halign: Gtk.Align.END });
        this.filterButton.add_css_class('flat');
        this.filterButton.add_css_class('search-chip');
        const filterBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        filterBox.append(this.includeEntry);
        filterBox.append(this.excludeEntry);
        this.filterRow = new Gtk.Revealer({ child: filterBox, transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN });
        fields.append(searchField);
        fields.append(this.replaceRow);
        fields.append(this.filterButton);
        fields.append(this.filterRow);
        const block = new Gtk.Box({ spacing: 2, margin_start: 6, margin_end: 10 });
        block.append(this.expand);
        block.append(fields);

        this.summary = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 30, margin_start: 16, margin_end: 8, margin_top: 8, margin_bottom: 6 });
        this.summary.add_css_class('side-meta');

        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.store }), factory: this.createFactory(), single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        const scroll = new Gtk.ScrolledWindow({ vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER, child: this.list });

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        for (const child of [header, block, this.summary]) this.widget.append(child);
        this.widget.append(scroll);
        this.connect();
    }

    private connect(): void {
        this.entry.connect('changed', () => this.schedule());
        this.entry.connect('activate', () => this.run());
        this.filterButton.connect('toggled', () => { this.filterRow.reveal_child = this.filterButton.active; });
        for (const entry of [this.includeEntry, this.excludeEntry]) {
            entry.connect('changed', () => { this.markFilter(); this.schedule(); });
            entry.connect('activate', () => this.run());
        }
        for (const button of [this.caseButton, this.wordButton, this.regexButton]) button.connect('toggled', () => this.run());
        this.expand.connect('toggled', () => {
            this.replaceRow.reveal_child = this.expand.active;
            this.expand.icon_name = this.expand.active ? 'pan-down-symbolic' : 'pan-end-symbolic';
        });
        this.replaceEntry.connect('activate', () => this.onReplaceAll(this.replaceEntry.text));
        this.replaceAll.connect('clicked', () => this.onReplaceAll(this.replaceEntry.text));
        this.list.connect('activate', (_list, position) => {
            const row = this.store.get_item(position) as Row | null;
            if (!row) return;
            if (row.kind === 'hit') this.onOpenHit(row.file, row.index);
            else this.toggleFile(row.file);
        });
    }

    get options(): SearchOptions {
        return { caseSensitive: this.caseButton.active, wholeWord: this.wordButton.active, regex: this.regexButton.active };
    }

    // Focus the entry (Ctrl+Shift+F); a one-line selection becomes the query.
    focus(selected = '', withReplace = false): void {
        if (selected && !selected.includes('\n')) this.entry.text = selected;
        if (withReplace) this.expand.active = true;
        this.entry.grab_focus();
        if (this.entry.text) this.run();
    }

    private schedule(): void {
        if (this.timer) GLib.source_remove(this.timer);
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this.timer = 0;
            this.run();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Report the query as the fields hold it; the controller searches and sends the results back.
    run(): void {
        if (this.timer) { GLib.source_remove(this.timer); this.timer = 0; }
        this.onSearch({ text: this.entry.text, ...this.options, include: this.includeEntry.text, exclude: this.excludeEntry.text });
    }

    showResults(results: SearchResults): void {
        this.results = results.files;
        this.entry.remove_css_class('error');
        if (results.invalid) this.entry.add_css_class('error');
        this.setSummary(results.message);
        this.fill();
    }

    private markFilter(): void {
        if (activeFilters(this.includeEntry.text, this.excludeEntry.text)) this.filterButton.add_css_class('accent');
        else this.filterButton.remove_css_class('accent');
    }

    private setSummary(text: string): void {
        this.summary.label = text;
        this.summary.visible = text !== '';
        this.replaceAll.sensitive = this.results.length > 0;
    }

    private toggleFile(file: string): void {
        if (!this.folded.delete(file)) this.folded.add(file);
        this.fill();
    }

    // Rebuild the flat list: a row per file, then its hits unless the file is folded.
    private fill(): void {
        const rows: Row[] = [];
        for (const { file, hits } of this.results) {
            const folded = this.folded.has(file);
            const head = new Row();
            const slash = file.lastIndexOf('/');
            const dir = slash >= 0 ? ` <span alpha="55%">${esc(file.slice(0, slash))}</span>` : '';
            Object.assign(head, { kind: 'file', file, count: hits.length, expanded: !folded, markup: `<b>${esc(file.slice(slash + 1))}</b>${dir}` });
            rows.push(head);
            if (folded) continue;
            for (const [index, hit] of hits.entries()) {
                const row = new Row();
                const line = `${esc(hit.before)}<span background="#e5a50a" bgalpha="40%">${esc(hit.match)}</span>${esc(hit.after)}`;
                Object.assign(row, { kind: 'hit', file, index, markup: `<span alpha="55%">${hit.line + 1}</span>  ${line}` });
                rows.push(row);
            }
        }
        this.store.splice(0, this.store.get_n_items(), rows);
    }

    private createFactory(): Gtk.SignalListItemFactory {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, object) => {
            const item = object as Gtk.ListItem;
            const box = new Gtk.Box({ spacing: 6 });
            const chevron = new Gtk.Image({ icon_name: 'pan-down-symbolic', pixel_size: 12 });
            const label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, use_markup: true });
            const count = new Gtk.Label();
            count.add_css_class('side-meta');
            for (const child of [chevron, label, count]) box.append(child);
            item.set_child(box);
        });
        factory.connect('bind', (_f, object) => {
            const item = object as Gtk.ListItem;
            const row = item.get_item() as Row;
            const box = item.get_child() as Gtk.Box;
            const chevron = box.get_first_child() as Gtk.Image;
            const label = chevron.get_next_sibling() as Gtk.Label;
            const count = label.get_next_sibling() as Gtk.Label;
            const file = row.kind === 'file';
            chevron.visible = file;
            count.visible = file;
            box.margin_start = file ? 0 : 14;
            label.set_markup(row.markup);
            label.single_line_mode = !file;
            if (file) {
                chevron.icon_name = row.expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
                count.label = String(row.count);
            }
        });
        return factory;
    }
}
