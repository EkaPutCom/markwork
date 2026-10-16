// The "Fields" dialog: the fields a board or list declares in its frontmatter, as a form. Fields can be added and
// reordered, and the options of a select can be added, edited, removed, reordered, and given a color. A field that already exists keeps
// its name and type, so no value on a card is ever cut off from its field here. The caller writes the result into the
// frontmatter (markdown/fields.ts writeSchema); nothing here touches the text.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { fieldNameProblem, OPTION_COLORS, optionProblem, type FieldDef, type FieldType, type NameProblem, type OptionColor } from '../markdown/fields.js';
import { removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';
import { formDialog } from './dialogs.js';
import type { SchemaDialogOptions } from '../app/views.js';

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

const OPTION_PROBLEM: Record<NameProblem, () => string> = {
    ...PROBLEM,
    invalid: () => _('No comma, colon, or parentheses'),
};

interface DraftOption { text: string; color: OptionColor | null }
// A field being edited: its options and their colors are kept here, and put back into `def` by result().
interface DraftField { def: FieldDef; fresh: boolean; options: DraftOption[] }

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
            this.draft.push({ def: { key: '', type: 'text', multiple: false, options: [] }, fresh: true, options: [] });
            this.queueRefresh(() => this.names.get(this.draft.length - 1)?.grab_focus());
        });
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        this.widget.append(scroll);
        this.widget.append(add);
        this.refresh();
    }

    // The fields as they are now, in order.
    result(): FieldDef[] {
        return this.draft.map(({ def, options }) => {
            const texts = options.map(o => o.text.trim());
            const colors: Record<string, OptionColor> = {};
            options.forEach((o, i) => { if (o.color) colors[texts[i]] = o.color; });
            const { colors: _old, ...rest } = def;
            return { ...rest, key: def.key.trim(), options: texts, ...(Object.keys(colors).length ? { colors } : {}) };
        });
    }

    // Marks what does not fit and moves focus to it; false = something is wrong.
    validate(): boolean {
        let first: Gtk.Entry | null = null;
        const mark = (entry: Gtk.Entry | undefined, problem: NameProblem | null, messages = PROBLEM) => {
            if (!entry || !problem) return;
            entry.add_css_class('error');
            entry.set_tooltip_text(messages[problem]());
            first ??= entry;
        };
        const keys = this.draft.map(d => d.def.key.trim());
        this.draft.forEach((d, i) => {
            if (d.fresh) mark(this.names.get(i), fieldNameProblem(d.def.key, [...this.options.reserved, ...keys.filter((_k, j) => j !== i)]));
            d.options.forEach((o, j) => mark(this.optionEntries.get(`${i}.${j}`), optionProblem(o.text, d.options.filter((_o, k) => k !== j).map(x => x.text)), OPTION_PROBLEM));
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
            if (def.type !== 'select') this.draft[i].options = [];
            this.queueRefresh();
        });
        return dropdown;
    }

    private optionsEditor(i: number): Gtk.Box {
        const options = this.draft[i].options;
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_start: 36 });
        options.forEach((_o, j) => box.append(this.optionRow(i, j)));
        const entry = new Gtk.Entry({ placeholder_text: _('Add an option…'), hexpand: true });
        const add = () => {
            const text = entry.text.trim();
            if (!text) return;
            if (optionProblem(text, options.map(o => o.text))) { entry.add_css_class('error'); return; }
            options.push({ text, color: null });
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

    // The option whose color row is open, as "field.option", or null.
    private colorOpen: string | null = null;

    private optionRow(i: number, j: number): Gtk.Box {
        const { def, fresh, options } = this.draft[i];
        const option = options[j];
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        const line = new Gtk.Box({ spacing: 6 });
        line.append(this.mover(options, j));
        line.append(this.colorDot(`${i}.${j}`, option));
        const entry = new Gtk.Entry({ text: option.text, hexpand: true });
        entry.connect('changed', () => {
            option.text = entry.text;
            entry.remove_css_class('error');
            entry.set_tooltip_text(null);
        });
        this.optionEntries.set(`${i}.${j}`, entry);
        line.append(entry);
        const uses = fresh ? 0 : this.options.uses(def.key, option.text);
        if (uses > 0) {
            const count = new Gtk.Label({ label: fmt(ngettext('{n} note', '{n} notes', uses), { n: uses }), valign: Gtk.Align.CENTER });
            count.add_css_class('dim-label');
            count.add_css_class('caption');
            line.append(count);
        }
        line.append(flat('window-close-symbolic', _('Remove option'), () => { options.splice(j, 1); this.queueRefresh(); }));
        box.append(line);
        if (this.colorOpen === `${i}.${j}`) box.append(this.colorChoices(option));
        return box;
    }

    // The dot shows the color of the option (dashed = none: it is colored by its position); a click opens the choices.
    private colorDot(id: string, option: DraftOption): Gtk.Button {
        const dot = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltip_text: _('Color of this option') });
        dot.update_property([Gtk.AccessibleProperty.LABEL], [_('Color of this option')]);
        for (const cls of ['opt-dot', 'circular', option.color ? `opt-dot-${option.color}` : 'opt-dot-auto']) dot.add_css_class(cls);
        if (this.colorOpen === id) dot.add_css_class('opt-dot-chosen');
        dot.connect('clicked', () => {
            this.colorOpen = this.colorOpen === id ? null : id;
            this.queueRefresh();
        });
        return dot;
    }

    // A row of the colors, and one to go back to the automatic color. Choosing one closes the row.
    private colorChoices(option: DraftOption): Gtk.Box {
        const row = new Gtk.Box({ spacing: 8, margin_start: 56, margin_bottom: 4 });
        const choose = (color: OptionColor | null) => {
            option.color = color;
            this.colorOpen = null;
            this.queueRefresh();
        };
        for (const color of OPTION_COLORS) {
            const dot = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltip_text: color });
            dot.update_property([Gtk.AccessibleProperty.LABEL], [color]);
            for (const cls of ['opt-dot', 'circular', `opt-dot-${color}`]) dot.add_css_class(cls);
            if (option.color === color) dot.add_css_class('opt-dot-chosen');
            dot.connect('clicked', () => choose(color));
            row.append(dot);
        }
        const auto = new Gtk.Button({ label: _('Automatic'), has_frame: false });
        auto.connect('clicked', () => choose(null));
        row.append(auto);
        return row;
    }
}

// Asks for the fields of a board or list. null if cancelled.
export async function editSchemaDialog(parent: Gtk.Window | null, options: SchemaDialogOptions): Promise<FieldDef[] | null> {
    const draft: DraftField[] = options.fields.map(def => ({ def: { ...def }, fresh: false, options: def.options.map(text => ({ text, color: def.colors?.[text] ?? null })) }));
    const form = new SchemaForm(draft, options);
    const accepted = await formDialog(parent, _('Fields'), 560, form.widget, _('Save'), () => form.validate());
    return accepted ? form.result() : null;
}
