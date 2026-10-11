// The view of `layout: chart` documents (markdown/chart.ts): numbers and charts over the notes. It only shows; nothing
// here changes the notes (a click opens nothing). It is redrawn from the model every time the document changes.
//
//   October summary
//   [Notes 24] [Done 15] [Overdue 2] [Per week 6]
//   Created per week  ▂▅█▃         By status  ▕██ todo ▕█ doing ▕███ done
//   By tag            #docs ████████ 8
//
// The distribution over a select field is a donut drawn with cairo in a Gtk.DrawingArea, with the total in the middle
// and a legend (name, count, and a swatch of the same color) beside it, so the colors are never the only information.

import Gtk from 'gi://Gtk?version=4.0';
import { chartData, NO_VALUE, type ChartData, type Slice } from '../markdown/chart.js';
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

export class ChartView extends LayoutView {
    readonly widget: Gtk.ScrolledWindow;
    private readonly body: Gtk.Box;

    constructor() {
        super(_('Chart'));
        const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        page.append(this.headerBox());
        this.body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        page.append(this.body);
        this.widget = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: page });
        this.widget.add_css_class('chart-view');
    }

    render(): void {
        this.updateHeading();
        removeChildren(this.body);
        const data = chartData(this.board, this.today(), this.schema());
        this.body.append(this.kpis(data));
        if (data.total === 0) {
            const empty = new Gtk.Label({ label: _('There are no notes to count yet.'), xalign: 0 });
            empty.add_css_class('dim-label');
            this.body.append(empty);
            return;
        }
        const row = new Gtk.Box({ spacing: 12, homogeneous: false });
        row.append(this.panel(data.period === 'week' ? _('Created per week') : _('Created per month'), this.periods(data)));
        if (data.groupKey) row.append(this.panel(fmt(_('By {field}'), { field: data.groupKey }), this.distribution(data.byGroup)));
        this.body.append(row);
        if (data.byTag.length) this.body.append(this.panel(_('By tag'), this.tags(data.byTag)));
    }

    private panel(title: string, content: Gtk.Widget): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, hexpand: true, valign: Gtk.Align.START });
        box.add_css_class('card');
        box.add_css_class('chart-panel');
        const heading = new Gtk.Label({ label: title, xalign: 0 });
        heading.add_css_class('heading');
        box.append(heading);
        box.append(content);
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
    private periods(data: ChartData): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 10, homogeneous: true, valign: Gtk.Align.END });
        const max = Math.max(1, ...data.perPeriod.map(p => p.count));
        if (!data.perPeriod.length) {
            const none = new Gtk.Label({ label: _('No notes have a date in the “by” field.'), xalign: 0, wrap: true });
            none.add_css_class('dim-label');
            return none;
        }
        for (const period of data.perPeriod) {
            const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.END });
            const count = new Gtk.Label({ label: String(period.count) });
            count.add_css_class('caption');
            const bar = new Gtk.Box({ height_request: Math.max(4, Math.round((period.count / max) * BAR_AREA)), valign: Gtk.Align.END });
            bar.add_css_class('chart-bar');
            const name = new Gtk.Label({ label: formatDate(period.start, data.period === 'week' ? '%e %b' : '%b %Y') });
            name.add_css_class('dim-label');
            name.add_css_class('caption');
            column.set_tooltip_text(fmt(_('{start}: {count}'), { start: period.start, count: period.count }));
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
