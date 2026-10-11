// The view of `layout: timeline` documents (markdown/timeline.ts): a bar per note from its start to its end date.
//
//   Roadmap 0.9                                   (Week | Month | Quarter)  [Today]  [+ New Note]
//   Notes            5 Oct     12 Oct     19 Oct     26 Oct
//   Design home      ████████
//   Fix sync bug         ▓▓▓▓▓▓░░░░░░           │ today
//
// Drag a bar to move both dates, drag its left or right edge to change one. A click on a bar edits the note. Every change
// goes through commit(), which calls onChange.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { daysBetween } from '../markdown/dates.js';
import { PIXELS_PER_DAY, ZOOMS, barSpan, resizeRow, shiftRow, timelineRange, timelineRows, timelineTicks, timelineZoom, type TimelineRow, type TimelineRange, type Zoom } from '../markdown/timeline.js';
import type { Position } from '../markdown/kanban.js';
import { onChipClick, removeChildren } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import { formatDate, LayoutView } from './structured.js';

const ROW_HEIGHT = 34;
const HEAD_HEIGHT = 30;
const LABEL_WIDTH = 200;
const HANDLE = 7;
const CLICK_SLOP = 4;   // pixels a drag may move and still count as a click
const ZOOM_LABEL: Record<Zoom, string> = { week: 'Week', month: 'Month', quarter: 'Quarter' };

export class TimelineView extends LayoutView {
    readonly widget: Gtk.Box;
    private zoomOverride: Zoom | null = null;
    private readonly labels: Gtk.Box;
    private readonly fixed: Gtk.Fixed;
    private readonly scroller: Gtk.ScrolledWindow;
    private readonly empty: Gtk.Label;
    private readonly zoomButtons = new Map<Zoom, Gtk.ToggleButton>();
    private syncing = false;
    private scrollQueued = false;

    constructor() {
        super(_('Timeline'));
        const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        page.append(this.headerBox(this.newNoteButton(() => this.showAddNote())));

        const zooms = new Gtk.Box({ spacing: 0, halign: Gtk.Align.START });
        zooms.add_css_class('linked');
        let first: Gtk.ToggleButton | null = null;
        for (const zoom of ZOOMS) {
            const button = new Gtk.ToggleButton({ label: _(ZOOM_LABEL[zoom]) });
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active && !this.syncing) { this.zoomOverride = zoom; this.render(); } });
            this.zoomButtons.set(zoom, button);
            zooms.append(button);
        }
        const today = new Gtk.Button({ label: _('Today'), tooltip_text: _('Scroll to today') });
        today.connect('clicked', () => this.scrollToToday());
        const bar = new Gtk.Box({ spacing: 8 });
        bar.append(zooms);
        bar.append(today);
        page.append(bar);

        this.labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: LABEL_WIDTH, valign: Gtk.Align.START });
        this.labels.add_css_class('timeline-labels');
        this.fixed = new Gtk.Fixed({ valign: Gtk.Align.START });
        this.fixed.add_css_class('timeline-canvas');
        this.scroller = new Gtk.ScrolledWindow({ hexpand: true, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER, child: this.fixed });
        const chart = new Gtk.Box({ valign: Gtk.Align.START });
        chart.add_css_class('timeline-chart');
        chart.append(this.labels);
        chart.append(this.scroller);
        page.append(chart);
        this.empty = new Gtk.Label({ label: _('There are no notes to put on the timeline yet.'), xalign: 0 });
        this.empty.add_css_class('dim-label');
        page.append(this.empty);
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.append(new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: page }));
    }

    protected override headChanged(): void {
        this.zoomOverride = null;
        this.scrollQueued = true;
    }

    private zoom(): Zoom {
        return this.zoomOverride ?? timelineZoom(this.board);
    }

    // ---------- Drawing ----------

    render(): void {
        this.updateHeading();
        const zoom = this.zoom();
        this.syncing = true;
        this.zoomButtons.get(zoom)?.set_active(true);
        this.syncing = false;
        removeChildren(this.labels);
        removeChildren(this.fixed);
        const rows = timelineRows(this.board, this.schema());
        this.empty.set_visible(rows.length === 0);
        const today = this.today();
        const range = timelineRange(rows, today);
        const pxPerDay = PIXELS_PER_DAY[zoom];
        this.fixed.set_size_request(range.days * pxPerDay, HEAD_HEIGHT + rows.length * ROW_HEIGHT);

        const spacer = new Gtk.Label({ label: _('Notes'), xalign: 0, height_request: HEAD_HEIGHT });
        spacer.add_css_class('timeline-head');
        this.labels.append(spacer);
        this.drawGrid(range, pxPerDay, zoom, rows.length, today);
        rows.forEach((row, i) => {
            this.labels.append(this.label(row));
            this.drawBar(row, i, range, pxPerDay, today);
        });
        if (this.scrollQueued) {
            this.scrollQueued = false;
            this.scrollToToday();
        }
    }

    // The header labels, the vertical lines, and the line of today.
    private drawGrid(range: TimelineRange, pxPerDay: number, zoom: Zoom, rows: number, today: string): void {
        const height = HEAD_HEIGHT + rows * ROW_HEIGHT;
        for (const tick of timelineTicks(range, zoom)) {
            const x = tick.offset * pxPerDay;
            const line = new Gtk.Box({ width_request: 1, height_request: height });
            line.add_css_class('timeline-line');
            this.fixed.put(line, x, 0);
            const text = new Gtk.Label({ label: formatDate(tick.date, zoom === 'week' ? '%a %e' : '%e %b'), xalign: 0, height_request: HEAD_HEIGHT });
            text.add_css_class('timeline-head');
            this.fixed.put(text, x + 4, 0);
        }
        const offset = daysBetween(range.start, today);
        if (offset >= 0 && offset <= range.days) {
            const now = new Gtk.Box({ width_request: 2, height_request: height });
            now.add_css_class('timeline-today');
            now.set_tooltip_text(_('Today'));
            this.fixed.put(now, offset * pxPerDay, 0);
        }
    }

    private label(row: TimelineRow): Gtk.Widget {
        const label = new Gtk.Label({ label: row.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, height_request: ROW_HEIGHT });
        label.add_css_class('timeline-label');
        if (row.card.done === true) label.add_css_class('dim-label');
        if (!row.start) label.set_tooltip_text(_('This note has no date, so it has no bar.'));
        onChipClick(label, () => this.editItem(row.at));
        return label;
    }

    // The bar of a note: a handle at each edge and the title between them. The whole bar is moved by the title.
    private drawBar(row: TimelineRow, index: number, range: TimelineRange, pxPerDay: number, today: string): void {
        const span = barSpan(row, range);
        if (!span) return;
        const width = span.length * pxPerDay;
        const bar = new Gtk.Box({ width_request: width, height_request: ROW_HEIGHT - 12 });
        bar.add_css_class('timeline-bar');
        const state = this.stateOf(row, today);
        if (state) bar.add_css_class(state.css);
        const dates = row.start === row.end ? row.start : `${row.start} → ${row.end}`;
        bar.set_tooltip_text(fmt(_('{title}: {dates}'), { title: row.title, dates: state ? `${dates} (${state.text})` : (dates ?? '') }));

        const left = this.handle('start', row.at, pxPerDay);
        const right = this.handle('end', row.at, pxPerDay);
        const title = new Gtk.Label({ label: row.progress !== null && row.progress < 1 ? `${row.title} · ${Math.round(row.progress * 100)}%` : row.title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
        title.add_css_class('timeline-bar-title');
        title.update_property([Gtk.AccessibleProperty.LABEL], [bar.get_tooltip_text() ?? row.title]);
        bar.append(left);
        bar.append(title);
        bar.append(right);
        this.dragToShift(title, bar, row.at, pxPerDay, span.offset * pxPerDay, HEAD_HEIGHT + index * ROW_HEIGHT + 6);

        const y = HEAD_HEIGHT + index * ROW_HEIGHT + 6;
        if (row.progress !== null && row.progress > 0) {
            const overlay = new Gtk.Overlay({ child: bar });
            const fill = new Gtk.Box({ width_request: Math.max(2, Math.round(width * Math.min(1, row.progress))), height_request: ROW_HEIGHT - 12, halign: Gtk.Align.START, can_target: false });
            fill.add_css_class('timeline-fill');
            overlay.add_overlay(fill);
            this.fixed.put(overlay, span.offset * pxPerDay, y);
        } else this.fixed.put(bar, span.offset * pxPerDay, y);
    }

    // A done note is green, one past its end date red; the state is also written in the tooltip.
    private stateOf(row: TimelineRow, today: string): { css: string; text: string } | null {
        if (row.card.done === true) return { css: 'timeline-bar-done', text: _('done') };
        return row.end && row.end < today ? { css: 'timeline-bar-late', text: _('past its end date') } : null;
    }

    private handle(edge: 'start' | 'end', at: Position, pxPerDay: number): Gtk.Widget {
        const handle = new Gtk.Box({ width_request: HANDLE });
        handle.add_css_class('timeline-handle');
        handle.set_cursor_from_name('ew-resize');
        handle.set_tooltip_text(edge === 'start' ? _('Drag to change the start date') : _('Drag to change the end date'));
        const drag = new Gtk.GestureDrag({ button: 1 });
        drag.connect('drag-begin', () => drag.set_state(Gtk.EventSequenceState.CLAIMED));
        drag.connect('drag-end', (_g, dx) => {
            const days = Math.round(dx / pxPerDay);
            if (days) this.commit(resizeRow(this.board, at, edge, days, this.schema()));
        });
        handle.add_controller(drag);
        return handle;
    }

    // The bar follows the pointer while it is dragged; on release both dates move by the whole days it moved.
    private dragToShift(title: Gtk.Widget, bar: Gtk.Widget, at: Position, pxPerDay: number, x: number, y: number): void {
        const drag = new Gtk.GestureDrag({ button: 1 });
        drag.connect('drag-begin', () => drag.set_state(Gtk.EventSequenceState.CLAIMED));
        drag.connect('drag-update', (_g, dx) => {
            if (Math.abs(dx) >= CLICK_SLOP) this.fixed.move(bar.get_parent() instanceof Gtk.Overlay ? bar.get_parent()! : bar, x + Math.round(dx / pxPerDay) * pxPerDay, y);
        });
        drag.connect('drag-end', (_g, dx) => {
            const days = Math.round(dx / pxPerDay);
            if (Math.abs(dx) < CLICK_SLOP) this.editItem(at);
            else if (days) this.commit(shiftRow(this.board, at, days, this.schema()));
            else this.queueRender();
        });
        title.set_cursor_from_name('grab');
        title.add_controller(drag);
    }

    private scrollToToday(): void {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const range = timelineRange(timelineRows(this.board, this.schema()), this.today());
            const x = daysBetween(range.start, this.today()) * PIXELS_PER_DAY[this.zoom()];
            const adjustment = this.scroller.get_hadjustment();
            adjustment.set_value(Math.max(0, x - 120));
            return GLib.SOURCE_REMOVE;
        });
    }
}

