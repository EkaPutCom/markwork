// The Search panel in the sidebar: search (and replace) in all the Markdown files of the work folder.
// Results are grouped per file, as a flat list of file rows and hit rows in a Gtk.ListView; a file row folds its hits.
// The panel does not know where the files come from or how a change is applied; the window supplies both.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import { buildPattern, replaceMatches, searchFiles, MAX_HITS, type FileHits, type SearchHit, type SearchOptions } from '../markdown/search.js';
import type { Change } from '../agent/changes.js';
import { pack } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';

export interface SearchHost {
    root(): string | null;
    files(): { name: string; text: string }[];            // the Markdown files with their current contents
    open(file: string, hit: SearchHit): void;             // show a hit in the editor
    replace(changes: Change[]): string | null;            // apply the changes; an error message or null
    confirm(message: string, detail: string, accept: string): Promise<boolean>;
}

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
    hit: SearchHit | null = null;
}

const esc = (s: string): string => GLib.markup_escape_text(s, -1);

export class SearchPanel {
    readonly widget: Gtk.Box;
    readonly entry: Gtk.Entry;
    readonly replaceEntry: Gtk.Entry;
    readonly caseButton: Gtk.ToggleButton;
    readonly wordButton: Gtk.ToggleButton;
    readonly regexButton: Gtk.ToggleButton;
    readonly summary: Gtk.Label;
    readonly expand: Gtk.ToggleButton;
    readonly replaceRow: Gtk.Revealer;
    readonly replaceAll: Gtk.Button;
    readonly store = new Gio.ListStore({ item_type: Row.$gtype });
    readonly list: Gtk.ListView;
    private results: FileHits[] = [];
    private readonly folded = new Set<string>();
    private timer = 0;
    private pattern: RegExp | null = null;

    constructor(private readonly host: SearchHost) {
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
        const fields = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        fields.append(searchField);
        fields.append(this.replaceRow);
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
        for (const button of [this.caseButton, this.wordButton, this.regexButton]) button.connect('toggled', () => this.run());
        this.expand.connect('toggled', () => {
            this.replaceRow.reveal_child = this.expand.active;
            this.expand.icon_name = this.expand.active ? 'pan-down-symbolic' : 'pan-end-symbolic';
        });
        this.replaceEntry.connect('activate', () => void this.replaceEverything());
        this.replaceAll.connect('clicked', () => void this.replaceEverything());
        this.list.connect('activate', (_list, position) => {
            const row = this.store.get_item(position) as Row | null;
            if (!row) return;
            if (row.kind === 'hit') this.host.open(row.file, row.hit!);
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

    run(): void {
        if (this.timer) { GLib.source_remove(this.timer); this.timer = 0; }
        const pattern = buildPattern(this.entry.text, this.options);
        this.pattern = null;
        this.results = [];
        this.entry.remove_css_class('error');
        if (!pattern) this.setSummary('');
        else if (!(pattern instanceof RegExp)) {
            this.entry.add_css_class('error');
            this.setSummary(pattern.error);
        } else if (!this.host.root()) this.setSummary(_('Open a folder to search in its notes.'));
        else {
            this.pattern = pattern;
            const found = searchFiles(this.host.files(), pattern);
            this.results = found.files;
            this.setSummary(this.describe(found.total, found.files.length, found.truncated));
        }
        this.fill();
    }

    private describe(total: number, files: number, truncated: boolean): string {
        if (total === 0) return _('No results');
        const text = fmt(ngettext('{count} result in {files} file', '{count} results in {files} files', total), { count: total, files });
        return truncated ? fmt(_('{text} (only the first {max} are shown)'), { text, max: MAX_HITS }) : text;
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
            for (const hit of hits) {
                const row = new Row();
                const line = `${esc(hit.before)}<span background="#e5a50a" bgalpha="40%">${esc(hit.match)}</span>${esc(hit.after)}`;
                Object.assign(row, { kind: 'hit', file, hit, markup: `<span alpha="55%">${hit.line + 1}</span>  ${line}` });
                rows.push(row);
            }
        }
        this.store.splice(0, this.store.get_n_items(), rows);
    }

    // The changes that replace every hit; files are re-read through the host so unsaved text is what changes.
    plan(): Change[] {
        if (!this.pattern) return [];
        const { regex } = this.options;
        const wanted = new Set(this.results.map(f => f.file));
        const changes: Change[] = [];
        for (const file of this.host.files()) {
            if (!wanted.has(file.name)) continue;
            const { text, count } = replaceMatches(file.text, this.pattern, this.replaceEntry.text, regex);
            if (count > 0 && text !== file.text) changes.push({ kind: 'edit', file: file.name, before: file.text, after: text, reason: _('Replace in all notes') });
        }
        return changes;
    }

    async replaceEverything(): Promise<void> {
        const changes = this.plan();
        if (!changes.length) return;
        const total = this.results.reduce((n, f) => n + f.hits.length, 0);
        const detail = fmt(ngettext('{count} occurrence in {files} file will be replaced. Open files can be undone with Ctrl+Z; other files are written right away.',
            '{count} occurrences in {files} files will be replaced. Open files can be undone with Ctrl+Z; other files are written right away.', total), { count: total, files: changes.length });
        if (!await this.host.confirm(_('Replace in all notes?'), detail, _('Replace All'))) return;
        const error = this.host.replace(changes);
        if (error) this.setSummary(error);
        else this.run();
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
