// The "Fields" dialog: the fields a board or list declares in its frontmatter, as a form. Fields can be added and
// reordered, and the options of a select can be added, edited, removed, and reordered. A field that already exists keeps
// its name and type, so no value on a card is ever cut off from its field here. The caller writes the result into the
// frontmatter (markdown/fields.ts writeSchema); nothing here touches the text.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { fieldNameProblem, optionProblem, type FieldDef, type FieldType, type NameProblem } from '../markdown/fields.js';
import { removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import { formDialog } from './dialogs.js';

export interface SchemaDialogOptions {
    fields: FieldDef[];                              // the fields the document declares, in order
    reserved: readonly string[];                     // names the document uses itself (due, agent)
    uses(key: string, option?: string): number;      // how many notes have a value for the field (or that option)
}

const TYPES: readonly FieldType[] = ['text', 'number', 'select', 'date', 'progress', 'person', 'agent', 'link'];
const TYPE_LABEL: Record<FieldType, () => string> = {
    text: () => _('Text'), number: () => _('Number'), select: () => _('Choice'), date: () => _('Date'),
    progress: () => _('Progress'), person: () => _('Person'), agent: () => _('Agent'), link: () => _('Link'),
};
const PROBLEM: Record<NameProblem, () => string> = {
    empty: () => _('A name is needed'),
    invalid: () => _('Start with a letter; letters, digits, - and _ only'),
    taken: () => _('That name is already used'),
};

interface DraftField { def: FieldDef; fresh: boolean }

const flat = (icon: string, tooltip: string, run: () => void, sensitive = true): Gtk.Button => {
    const button = new Gtk.Button({ icon_name: icon, has_frame: false, tooltip_text: tooltip, sensitive, valign: Gtk.Align.CENTER });
    button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
    button.connect('clicked', run);
    return button;
};

class SchemaForm {
    readonly widget: Gtk.Box;
    private readonly list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
    private readonly names = new Map<number, Gtk.Entry>();
    private readonly optionEntries = new Map<string, Gtk.Entry>();

    constructor(private readonly draft: DraftField[], private readonly options: SchemaDialogOptions) {
        const scroll = new Gtk.ScrolledWindow({ min_content_height: 240, max_content_height: 520, propagate_natural_height: true, hexpand: true, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER, has_frame: true });
        this.list.set_margin_top(8);
        this.list.set_margin_bottom(8);
        this.list.set_margin_start(10);
        this.list.set_margin_end(10);
        scroll.set_child(this.list);
        const add = new Gtk.Button({ label: _('+ Add field'), has_frame: false, halign: Gtk.Align.START });
        add.connect('clicked', () => {
            this.draft.push({ def: { key: '', type: 'text', multiple: false, options: [] }, fresh: true });
            this.queueRefresh(() => this.names.get(this.draft.length - 1)?.grab_focus());
        });
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        this.widget.append(scroll);
        this.widget.append(add);
        this.refresh();
    }

    // The fields as they are now, in order.
    result(): FieldDef[] {
        return this.draft.map(({ def }) => ({ ...def, key: def.key.trim(), options: def.options.map(o => o.trim()) }));
    }

    // Marks what does not fit and moves focus to it; false = something is wrong.
    validate(): boolean {
        let first: Gtk.Entry | null = null;
        const mark = (entry: Gtk.Entry | undefined, problem: NameProblem | null) => {
            if (!entry || !problem) return;
            entry.add_css_class('error');
            entry.set_tooltip_text(PROBLEM[problem]());
            first ??= entry;
        };
        const keys = this.draft.map(d => d.def.key.trim());
        this.draft.forEach((d, i) => {
            if (d.fresh) mark(this.names.get(i), fieldNameProblem(d.def.key, [...this.options.reserved, ...keys.filter((_k, j) => j !== i)]));
            d.def.options.forEach((o, j) => mark(this.optionEntries.get(`${i}.${j}`), optionProblem(o, d.def.options.filter((_o, k) => k !== j))));
        });
        (first as Gtk.Entry | null)?.grab_focus();
        return first === null;
    }

    // Changes to the structure are drawn from idle: they come from a click on a widget that is about to be replaced.
    private refreshQueued = false;
    private queueRefresh(after?: () => void): void {
        if (this.refreshQueued) return;
        this.refreshQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.refreshQueued = false;
            if (this.list.get_root()) {
                this.refresh();
                after?.();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    private refresh(): void {
        removeChildren(this.list);
        this.names.clear();
        this.optionEntries.clear();
        if (!this.draft.length) {
            const none = new Gtk.Label({ label: _('No fields yet. Add one below.'), xalign: 0 });
            none.add_css_class('dim-label');
            this.list.append(none);
        }
        this.draft.forEach((_d, i) => this.list.append(this.fieldRow(i)));
    }

    private mover<T>(items: T[], i: number): Gtk.Box {
        const box = new Gtk.Box({ spacing: 0 });
        const swap = (to: number) => {
            [items[i], items[to]] = [items[to], items[i]];
            this.queueRefresh();
        };
        box.append(flat('go-up-symbolic', _('Move up'), () => swap(i - 1), i > 0));
        box.append(flat('go-down-symbolic', _('Move down'), () => swap(i + 1), i < items.length - 1));
        return box;
    }

    private fieldRow(i: number): Gtk.Widget {
        const { def, fresh } = this.draft[i];
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        const head = new Gtk.Box({ spacing: 8 });
        head.append(this.mover(this.draft, i));
        head.append(fresh ? this.nameEntry(i) : this.nameLabel(def));
        head.append(fresh ? this.typeChoice(i) : new Gtk.Label({ label: TYPE_LABEL[def.type]() + (def.multiple ? ' ×' : ''), xalign: 0 }));
        if (fresh) head.append(flat('window-close-symbolic', _('Remove this field'), () => { this.draft.splice(i, 1); this.queueRefresh(); }));
        row.append(head);
        if (def.type === 'select') row.append(this.optionsEditor(i));
        return row;
    }

    private nameLabel(def: FieldDef): Gtk.Label {
        const label = new Gtk.Label({ label: def.key, xalign: 0, hexpand: true });
        label.add_css_class('heading');
        return label;
    }

    private nameEntry(i: number): Gtk.Entry {
        const entry = new Gtk.Entry({ text: this.draft[i].def.key, placeholder_text: _('Field name'), hexpand: true });
        entry.connect('changed', () => {
            this.draft[i].def.key = entry.text;
            entry.remove_css_class('error');
            entry.set_tooltip_text(null);
        });
        this.names.set(i, entry);
        return entry;
    }

    private typeChoice(i: number): Gtk.DropDown {
        const def = this.draft[i].def;
        const dropdown = new Gtk.DropDown({ model: Gtk.StringList.new(TYPES.map(t => TYPE_LABEL[t]())), selected: TYPES.indexOf(def.type) });
        dropdown.connect('notify::selected', () => {
            def.type = TYPES[dropdown.selected] ?? 'text';
            if (def.type !== 'select') def.options = [];
            this.queueRefresh();
        });
        return dropdown;
    }

    private optionsEditor(i: number): Gtk.Box {
        const def = this.draft[i].def;
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_start: 36 });
        def.options.forEach((option, j) => box.append(this.optionRow(i, j, option)));
        const entry = new Gtk.Entry({ placeholder_text: _('Add an option…'), hexpand: true });
        const add = () => {
            const text = entry.text.trim();
            if (!text) return;
            if (optionProblem(text, def.options)) { entry.add_css_class('error'); return; }
            def.options.push(text);
            this.queueRefresh();
        };
        entry.connect('changed', () => entry.remove_css_class('error'));
        entry.connect('activate', add);
        const line = new Gtk.Box({ spacing: 6 });
        line.append(entry);
        line.append(flat('list-add-symbolic', _('Add option'), add));
        box.append(line);
        return box;
    }

    private optionRow(i: number, j: number, option: string): Gtk.Box {
        const def = this.draft[i].def;
        const line = new Gtk.Box({ spacing: 6 });
        line.append(this.mover(def.options, j));
        const entry = new Gtk.Entry({ text: option, hexpand: true });
        entry.connect('changed', () => {
            def.options[j] = entry.text;
            entry.remove_css_class('error');
            entry.set_tooltip_text(null);
        });
        this.optionEntries.set(`${i}.${j}`, entry);
        line.append(entry);
        const uses = this.draft[i].fresh ? 0 : this.options.uses(def.key, option);
        if (uses > 0) {
            const count = new Gtk.Label({ label: fmt(ngettext('{n} note', '{n} notes', uses), { n: uses }), valign: Gtk.Align.CENTER });
            count.add_css_class('dim-label');
            count.add_css_class('caption');
            line.append(count);
        }
        line.append(flat('window-close-symbolic', _('Remove option'), () => { def.options.splice(j, 1); this.queueRefresh(); }));
        return line;
    }
}

// Asks for the fields of a board or list. null if cancelled.
export async function editSchemaDialog(parent: Gtk.Window | null, options: SchemaDialogOptions): Promise<FieldDef[] | null> {
    const draft = options.fields.map(def => ({ def: { ...def, options: [...def.options] }, fresh: false }));
    const form = new SchemaForm(draft, options);
    const accepted = await formDialog(parent, _('Fields'), 560, form.widget, _('Save'), () => form.validate());
    return accepted ? form.result() : null;
}
