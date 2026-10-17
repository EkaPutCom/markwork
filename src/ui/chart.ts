// The view of `layout: chart` documents (markdown/chart.ts): numbers and charts over the notes. It only shows; nothing
// here changes the notes (a click opens nothing). It is redrawn from the model every time the document changes.
//
//   October summary
//   [Notes 24] [Done 15] [Overdue 2] [Per week 6]
//   Created per week  ▂▅█▃         By status  ▕██ todo ▕█ doing ▕███ done
//   By tag            #docs ████████ 8
//
// The panels are the ones `charts:` names, in that order (markdown/chart.ts), and the button at the top right edits that
// list: it moves, removes, and adds panels and picks their fields, and writes the result back to the frontmatter.
//
// The distribution over a select field is a donut drawn with cairo in a Gtk.DrawingArea, with the total in the middle
// and a legend (name, count, and a swatch of the same color) beside it, so the colors are never the only information.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import {
    barData, chartData, chartItems, dateFields, donutData, selectFields, NO_VALUE,
    type ChartData, type ChartItem, type Period, type Slice,
} from '../markdown/chart.js';
import { removeChildren } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import { formatDate, LayoutView } from './structured.js';

// The part of a cairo context that is used (GJS binds the whole thing; the type packages only know a little of it).
interface Cairo {
    setLineWidth(width: number): void;
    setSourceRGB(r: number, g: number, b: number): void;
    arc(x: number, y: number, radius: number, from: number, to: number): void;
    rectangle(x: number, y: number, width: number, height: number): void;
    stroke(): void;
    fill(): void;
    $dispose(): void;
}
const NO_VALUE_COLOR = '#c9ccd2';   // lighter than the gray option, so "no value" is not mistaken for it
const DONUT = 140;      // size of the donut in pixels
const DONUT_RING = 26;  // thickness of its ring
// Colors that read on a light and on a dark background; an option color is drawn with the one of its name.
const SLICE_COLORS: Record<string, string> = {
    red: '#e5484d', amber: '#e9a23b', green: '#3fa66b', blue: '#3b7dd8', purple: '#8e5bd6', teal: '#2f8f99', pink: '#c2417a', gray: '#8a8f98',
};
const FALLBACK_COLORS = ['#4c9a6a', '#3b7dd8', '#8e5bd6', '#d6602e', '#c2417a', '#2f8f99', '#8a7a1c', '#5e6c84'];
const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const BAR_AREA = 120;   // height in pixels of the tallest vertical bar
const TAG_BAR = 220;    // width in pixels of the longest horizontal bar

const PANEL_NAMES: Record<ChartItem['kind'], () => string> = {
    kpi: () => _('Numbers'), bar: () => _('Bars'), donut: () => _('Donut'), tags: () => _('Tags'),
};
const ADDABLE: ChartItem[] = [{ kind: 'kpi' }, { kind: 'bar', field: null, period: null }, { kind: 'donut', field: null }, { kind: 'tags' }];

function countChildren(box: Gtk.Box): number {
    let n = 0;
    for (let child = box.get_first_child(); child; child = child.get_next_sibling()) n++;
    return n;
}

export class ChartView extends LayoutView {
    readonly widget: Gtk.ScrolledWindow;
    private readonly body: Gtk.Box;
    private readonly settings: Gtk.Popover;

    constructor() {
        super(_('Chart'));
        const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        this.settings = new Gtk.Popover();
        const button = new Gtk.MenuButton({ icon_name: 'emblem-system-symbolic', popover: this.settings, valign: Gtk.Align.START });
        button.set_tooltip_text(_('Choose the panels'));
        button.update_property([Gtk.AccessibleProperty.LABEL], [_('Choose the panels')]);
        page.append(this.headerBox(button));
        this.body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        page.append(this.body);
        this.widget = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: page });
        this.widget.add_css_class('chart-view');
    }

    render(): void {
        this.updateHeading();
        removeChildren(this.body);
        this.fillSettings();
        const schema = this.schema();
        const data = chartData(this.board, this.today(), schema);
        const items = chartItems(this.board, schema);
        if (data.total === 0) {
            if (items.some(item => item.kind === 'kpi')) this.body.append(this.kpis(data));
            const empty = new Gtk.Label({ label: _('There are no notes to count yet.'), xalign: 0 });
            empty.add_css_class('dim-label');
            this.body.append(empty);
            return;
        }
        let row: Gtk.Box | null = null;   // the bars and donuts sit two to a row; the numbers and the tags take a row each
        for (const item of items) {
            if (item.kind === 'kpi') { this.body.append(this.kpis(data)); row = null; continue; }
            const panel = this.panelFor(item, data);
            if (!panel) continue;
            if (item.kind === 'tags') { this.body.append(panel); row = null; continue; }
            if (!row || countChildren(row) >= 2) {
                row = new Gtk.Box({ spacing: 12, homogeneous: false });
                this.body.append(row);
            }
            row.append(panel);
            // Two panels share the row in halves, so that the gap is under the gap between the second and third number above.
            row.set_homogeneous(countChildren(row) === 2);
        }
    }

    private panelFor(item: ChartItem, data: ChartData): Gtk.Widget | null {
        const schema = this.schema();
        if (item.kind === 'tags') return data.byTag.length ? this.panel(_('By tag'), this.tags(data.byTag)) : null;
        if (item.kind === 'bar') {
            const bars = barData(this.board, item.field, item.period, schema);
            const title = bars.field === 'created' || bars.field === null
                ? (bars.period === 'week' ? _('Created per week') : _('Created per month'))
                : fmt(bars.period === 'week' ? _('{field} per week') : _('{field} per month'), { field: bars.field });
            return this.panel(title, this.periods(bars.counts, bars.period));
        }
        if (item.kind === 'donut') {
            const donut = donutData(this.board, item.field, schema);
            return donut.field ? this.panel(fmt(_('By {field}'), { field: donut.field }), this.distribution(donut.slices)) : null;
        }
        return null;
    }

    // ---------- Settings: the list of panels ----------

    private commitItems(items: ChartItem[] | null): void {
        this.edit({ kind: 'charts', items });
    }

    // A row for each panel with its fields to pick and buttons to move and remove it, then the ones that can be added.
    private fillSettings(): void {
        const schema = this.schema();
        const items = chartItems(this.board, schema);
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10 });
        const heading = new Gtk.Label({ label: _('Panels'), xalign: 0 });
        heading.add_css_class('title-4');
        box.append(heading);
        const edit = (at: number, next: ChartItem | null): void => {
            const list = [...items];
            if (next) list[at] = next; else list.splice(at, 1);
            this.commitItems(list);
        };
        const move = (at: number, by: number): void => {
            const list = [...items];
            [list[at], list[at + by]] = [list[at + by], list[at]];
            this.commitItems(list);
        };
        items.forEach((item, at) => {
            const row = new Gtk.Box({ spacing: 6 });
            row.append(new Gtk.Label({ label: PANEL_NAMES[item.kind](), xalign: 0, hexpand: true, width_chars: 12 }));
            if (item.kind === 'bar') {
                const bars = barData(this.board, item.field, item.period, schema);
                const keys = dateFields(schema).map(f => f.key);
                if (keys.length) row.append(this.dropdown(keys, bars.field, key => edit(at, { ...item, field: key })));
                row.append(this.dropdown([_('Week'), _('Month')], bars.period === 'week' ? _('Week') : _('Month'),
                    name => edit(at, { ...item, field: bars.field, period: (name === _('Week') ? 'week' : 'month') as Period })));
            } else if (item.kind === 'donut') {
                const keys = selectFields(schema).map(f => f.key);
                if (keys.length) row.append(this.dropdown(keys, donutData(this.board, item.field, schema).field, key => edit(at, { ...item, field: key })));
            }
            row.append(this.iconButton('go-up-symbolic', _('Move up'), at > 0, () => move(at, -1)));
            row.append(this.iconButton('go-down-symbolic', _('Move down'), at < items.length - 1, () => move(at, 1)));
            row.append(this.iconButton('list-remove-symbolic', _('Remove'), items.length > 1, () => edit(at, null)));
            box.append(row);
        });
        box.append(new Gtk.Separator());
        const add = new Gtk.Box({ spacing: 6 });
        for (const next of ADDABLE) {
            const button = new Gtk.Button({ child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label: PANEL_NAMES[next.kind]() }) });
            button.set_tooltip_text(fmt(_('Add {panel}'), { panel: PANEL_NAMES[next.kind]() }));
            button.connect('clicked', () => this.commitItems([...items, next]));
            add.append(button);
        }
        box.append(add);
        const reset = new Gtk.Button({ label: _('Reset to default'), halign: Gtk.Align.START });
        reset.add_css_class('flat');
        reset.connect('clicked', () => this.commitItems(null));
        box.append(reset);
        this.settings.set_child(box);
    }

    private iconButton(icon: string, tooltip: string, enabled: boolean, run: () => void): Gtk.Button {
        const button = new Gtk.Button({ icon_name: icon, sensitive: enabled });
        button.add_css_class('flat');
        button.set_tooltip_text(tooltip);
        button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
        button.connect('clicked', run);
        return button;
    }

    private dropdown(names: string[], current: string | null, picked: (name: string) => void): Gtk.DropDown {
        const dropdown = Gtk.DropDown.new_from_strings(names);
        dropdown.set_selected(Math.max(0, current ? names.indexOf(current) : 0));
        dropdown.connect('notify::selected', () => {
            const name = names[dropdown.get_selected()];
            if (name !== undefined && name !== current) picked(name);
        });
        return dropdown;
    }

    // A panel is as tall as the one beside it (the row gives it the height); its content sits in the middle of the space left under the title.
    // No widget here is set to expand: an expanding child would make the whole row, and so the page, stretch.
    private panel(title: string, content: Gtk.Widget): Gtk.Widget {
        const box = new Gtk.CenterBox({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.FILL });
        box.add_css_class('card');
        box.add_css_class('chart-panel');
        const heading = new Gtk.Label({ label: title, xalign: 0, margin_bottom: 10 });
        heading.add_css_class('heading');
        box.set_start_widget(heading);
        box.set_center_widget(content);
        return box;
    }

    // The four numbers on top. "Overdue" is also written in words, not only colored.
    private kpis(data: ChartData): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 12, homogeneous: true });
        const items: [string, number | string, string][] = [
            [_('Notes'), data.total, ''], [_('Done'), data.done, 'chart-ok'],
            [_('Overdue'), data.overdue, data.overdue ? 'chart-late' : ''], [_('Per week'), data.averagePerWeek, ''],
        ];
        for (const [name, value, cls] of items) {
            const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
            card.add_css_class('card');
            card.add_css_class('chart-kpi');
            const label = new Gtk.Label({ label: name, xalign: 0 });
            label.add_css_class('dim-label');
            const number = new Gtk.Label({ label: String(value), xalign: 0 });
            number.add_css_class('chart-number');
            if (cls) number.add_css_class(cls);
            card.append(label);
            card.append(number);
            row.append(card);
        }
        return row;
    }

    // Vertical bars, one per period, with the count above and the first day of the period below.
    private periods(counts: { start: string; count: number }[], period: Period): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 10, homogeneous: true, valign: Gtk.Align.END });
        const max = Math.max(1, ...counts.map(p => p.count));
        if (!counts.length) {
            const none = new Gtk.Label({ label: _('No notes have a date in the “by” field.'), xalign: 0, wrap: true });
            none.add_css_class('dim-label');
            return none;
        }
        for (const entry of counts) {
            const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.END });
            const count = new Gtk.Label({ label: String(entry.count) });
            count.add_css_class('caption');
            const bar = new Gtk.Box({ height_request: Math.max(4, Math.round((entry.count / max) * BAR_AREA)), valign: Gtk.Align.END });
            bar.add_css_class('chart-bar');
            const name = new Gtk.Label({ label: formatDate(entry.start, period === 'week' ? '%e %b' : '%b %Y') });
            name.add_css_class('dim-label');
            name.add_css_class('caption');
            column.set_tooltip_text(fmt(_('{start}: {count}'), { start: entry.start, count: entry.count }));
            column.append(count);
            column.append(bar);
            column.append(name);
            row.append(column);
        }
        return row;
    }

    // A donut with the total in its middle, and a legend with the name and count of every value.
    private distribution(slices: Slice[]): Gtk.Widget {
        const box = new Gtk.Box({ spacing: 20, halign: Gtk.Align.CENTER });
        const total = slices.reduce((n, slice) => n + slice.count, 0);
        const area = new Gtk.DrawingArea({ content_width: DONUT, content_height: DONUT, valign: Gtk.Align.CENTER });
        area.set_draw_func((_area, cr, width, height) => this.drawDonut(cr as unknown as Cairo, width, height, slices, total));
        area.set_tooltip_text(slices.map(slice => `${slice.name}: ${slice.count}`).join(', '));
        area.update_property([Gtk.AccessibleProperty.LABEL], [slices.map(slice => `${slice.name}: ${slice.count}`).join(', ')]);
        const middle = new Gtk.Label({ label: String(total), halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, can_target: false });
        middle.add_css_class('chart-number');
        const overlay = new Gtk.Overlay({ child: area });
        overlay.add_overlay(middle);
        box.append(overlay);

        const legend = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, valign: Gtk.Align.CENTER });
        slices.forEach((slice, i) => {
            const swatch = new Gtk.DrawingArea({ content_width: 12, content_height: 12, valign: Gtk.Align.CENTER });
            swatch.set_draw_func((_a, context, w, h) => {
                const cr = context as unknown as Cairo;
                this.paint(cr, slice, i);
                cr.rectangle(0, 0, w, h);
                cr.fill();
                cr.$dispose();
            });
            const line = new Gtk.Box({ spacing: 8 });
            line.append(swatch);
            line.append(new Gtk.Label({ label: slice.name, xalign: 0 }));
            const count = new Gtk.Label({ label: String(slice.count), xalign: 0 });
            count.add_css_class('dim-label');
            line.append(count);
            legend.append(line);
        });
        box.append(legend);
        return box;
    }

    private drawDonut(cr: Cairo, width: number, height: number, slices: Slice[], total: number): void {
        const radius = Math.min(width, height) / 2 - DONUT_RING / 2;
        const x = width / 2, y = height / 2;
        let angle = -Math.PI / 2;
        cr.setLineWidth(DONUT_RING);
        for (const [i, slice] of slices.entries()) {
            const sweep = total ? (slice.count / total) * 2 * Math.PI : 0;
            this.paint(cr, slice, i);
            cr.arc(x, y, radius, angle, angle + sweep);
            cr.stroke();
            angle += sweep;
        }
        cr.$dispose();
    }

    // The source color of a slice: the color of its option, gray for "no value", else the position in the palette.
    private paint(cr: Cairo, slice: Slice, index: number): void {
        const [r, g, b] = hexToRgb(slice.name === NO_VALUE ? NO_VALUE_COLOR : slice.color ? SLICE_COLORS[slice.color] : FALLBACK_COLORS[index % FALLBACK_COLORS.length]);
        cr.setSourceRGB(r, g, b);
    }

    // Horizontal bars, one per tag, longest first.
    private tags(tags: Slice[]): Gtk.Widget {
        const grid = new Gtk.Grid({ column_spacing: 10, row_spacing: 6 });
        const max = Math.max(1, ...tags.map(t => t.count));
        tags.forEach((tag, r) => {
            const name = new Gtk.Label({ label: tag.name, xalign: 0 });
            const bar = new Gtk.Box({ width_request: Math.max(4, Math.round((tag.count / max) * TAG_BAR)), height_request: 12, halign: Gtk.Align.START, valign: Gtk.Align.CENTER });
            bar.add_css_class('chart-bar');
            const count = new Gtk.Label({ label: String(tag.count), xalign: 0 });
            count.add_css_class('dim-label');
            grid.attach(name, 0, r, 1, 1);
            grid.attach(bar, 1, r, 1, 1);
            grid.attach(count, 2, r, 1, 1);
        });
        return grid;
    }
}
