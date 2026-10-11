// The view of `layout: calendar` documents (markdown/calendar.ts): notes on the day of their date field.
//
//   October 2026                                  [ ‹ ] [ › ] [Today]   (Month | Week | Agenda)   [+ New Note]
//   Mon  Tue  Wed  Thu  Fri  Sat  Sun                            ┌ NOT SCHEDULED ┐
//    5    6    7    8    9   10   11                             │ Research PDF  │
//         ▌Release 0.9          ▌Changelog                       │ Read the HIG  │
//
// Month, week, and agenda are three ways to look at the same notes. A note is dragged to another day to change its
// date (a time it has is kept) and to the side panel to take its date away; a click on a note edits it, a click on an
// empty part of a day adds a note on that day. Every change goes through commit(), which calls onChange.

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { addDays, addMonths, monthOf, monthWeeks, startOfWeek, weekDays } from '../markdown/dates.js';
import { calendarData, moveToDate, textForDate, type CalendarData, type CalendarItem } from '../markdown/calendar.js';
import type { Position } from '../markdown/kanban.js';
import { onChipClick, removeChildren } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import { formatDate, LayoutView } from './structured.js';

type Mode = 'month' | 'week' | 'agenda';
const MODES: [Mode, string][] = [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']];
const MONTH_LIMIT = 3;   // notes shown in a day of the month grid before "+N more"

export class CalendarView extends LayoutView {
    readonly widget: Gtk.ScrolledWindow;
    private mode: Mode = 'month';
    private anchor = '';   // a day inside the shown period; '' = today
    private readonly period: Gtk.Label;
    private readonly body: Gtk.Box;
    private readonly modeButtons = new Map<Mode, Gtk.ToggleButton>();
    private syncingMode = false;

    constructor() {
        super(_('Calendar'));
        const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        page.append(this.headerBox(this.newNoteButton(() => this.showAddNote())));

        this.period = new Gtk.Label({ xalign: 0, hexpand: true });
        this.period.add_css_class('title-3');
        const previous = this.navButton('go-previous-symbolic', _('Previous'), -1);
        const next = this.navButton('go-next-symbolic', _('Next'), 1);
        const today = new Gtk.Button({ label: _('Today'), tooltip_text: _('Go to today') });
        today.connect('clicked', () => { this.anchor = ''; this.render(); });
        const steps = new Gtk.Box({ spacing: 0 });
        steps.add_css_class('linked');
        steps.append(previous);
        steps.append(next);
        const modes = new Gtk.Box({ spacing: 0 });
        modes.add_css_class('linked');
        let first: Gtk.ToggleButton | null = null;
        for (const [mode, label] of MODES) {
            const button = new Gtk.ToggleButton({ label: _(label), active: mode === this.mode });
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active && !this.syncingMode) { this.mode = mode; this.render(); } });
            this.modeButtons.set(mode, button);
            modes.append(button);
        }
        const bar = new Gtk.Box({ spacing: 8 });
        bar.append(this.period);
        bar.append(steps);
        bar.append(today);
        bar.append(modes);
        page.append(bar);

        this.body = new Gtk.Box({ spacing: 12 });
        page.append(this.body);
        this.widget = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: page });
        this.widget.add_css_class('calendar-view');
    }

    private navButton(icon: string, tooltip: string, direction: number): Gtk.Button {
        const button = new Gtk.Button({ icon_name: icon, tooltip_text: tooltip });
        button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
        button.connect('clicked', () => this.step(direction));
        return button;
    }

    protected override headChanged(): void {
        this.anchor = '';
    }

    // ---------- Navigation ----------

    private day(): string {
        return this.anchor || this.today();
    }

    private step(direction: number): void {
        const day = this.day();
        this.anchor = this.mode === 'week' ? addDays(day, 7 * direction) : `${addMonths(monthOf(day), direction)}-01`;
        this.render();
    }

    private showWeekOf(date: string): void {
        this.anchor = date;
        this.mode = 'week';
        this.render();
    }

    // ---------- Drawing ----------

    render(): void {
        this.updateHeading();
        this.syncingMode = true;
        this.modeButtons.get(this.mode)?.set_active(true);
        this.syncingMode = false;
        removeChildren(this.body);
        const data = calendarData(this.board, this.schema());
        const today = this.today();
        const day = this.day();
        const main = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        if (this.mode === 'week') {
            const days = weekDays(day);
            this.period.set_label(fmt(_('{from} – {to}'), { from: formatDate(days[0], '%e %b'), to: formatDate(days[6], '%e %b %Y') }));
            main.append(this.grid([days], data, today, monthOf(day), Infinity));
        } else if (this.mode === 'agenda') {
            this.period.set_label(formatDate(`${monthOf(day)}-01`, '%B %Y'));
            main.append(this.agenda(data, monthOf(day), today));
        } else {
            this.period.set_label(formatDate(`${monthOf(day)}-01`, '%B %Y'));
            main.append(this.grid(monthWeeks(monthOf(day)), data, today, monthOf(day), MONTH_LIMIT));
        }
        this.body.append(main);
        this.body.append(this.sidePanel(data));
    }

    // The weeks as a grid of days with a row of weekday names above.
    private grid(weeks: string[][], data: CalendarData, today: string, month: string, limit: number): Gtk.Grid {
        const grid = new Gtk.Grid({ column_homogeneous: true, hexpand: true });
        grid.add_css_class('calendar-grid');
        const monday = startOfWeek(today);
        for (let i = 0; i < 7; i++) {
            const name = new Gtk.Label({ label: formatDate(addDays(monday, i), '%a') });
            name.add_css_class('calendar-weekday');
            grid.attach(name, i, 0, 1, 1);
        }
        weeks.forEach((week, r) => week.forEach((date, i) => grid.attach(this.dayCell(date, data, today, month, limit), i, r + 1, 1, 1)));
        return grid;
    }

    private dayCell(date: string, data: CalendarData, today: string, month: string, limit: number): Gtk.Widget {
        const cell = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        cell.add_css_class('calendar-day');
        if (monthOf(date) !== month) cell.add_css_class('calendar-day-other');
        cell.set_size_request(-1, limit === Infinity ? 220 : 96);
        const number = new Gtk.Label({ label: String(Number(date.slice(8))), xalign: 0, halign: Gtk.Align.START });
        number.add_css_class('calendar-daynum');
        if (date === today) number.add_css_class('calendar-today');
        cell.append(number);
        const items = data.byDate.get(date) ?? [];
        for (const item of items.slice(0, limit)) cell.append(this.event(item, today));
        if (items.length > limit) {
            const more = new Gtk.Label({ label: fmt(_('+{count} more'), { count: items.length - limit }), xalign: 0 });
            more.add_css_class('dim-label');
            more.add_css_class('caption');
            more.set_tooltip_text(_('Show this week'));
            onChipClick(more, () => this.showWeekOf(date));
            cell.append(more);
        }
        if (data.key) {
            onChipClickBackground(cell, () => this.showAddNote(text => textForDate(text, date, this.board, this.schema())));
            this.acceptDrop(cell, at => this.schedule(at, date), over => this.mark(cell, over));
            cell.set_tooltip_text(_('Double-click to add a note on this day'));
        }
        return cell;
    }

    // The dragged note is put on `date`, or taken off the calendar for an empty date.
    private schedule(at: Position, date: string): boolean {
        this.commit(moveToDate(this.board, at, date, this.schema()));
        return true;
    }

    private mark(widget: Gtk.Widget, over: boolean): void {
        if (over) widget.add_css_class('calendar-drop'); else widget.remove_css_class('calendar-drop');
    }

    // One note on a day: its time and title, colored by its state. A click edits it; it can be dragged to another day.
    private event(item: CalendarItem, today: string): Gtk.Widget {
        const label = new Gtk.Label({ label: (item.time ? `${item.time} ` : '') + item.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, hexpand: true });
        label.add_css_class('calendar-event');
        const done = item.card.done === true;
        if (done) label.add_css_class('calendar-event-done');
        else if (item.date < today) label.add_css_class('calendar-event-late');
        label.set_tooltip_text(done ? fmt(_('{title} (done)'), { title: item.title }) : item.date < today ? fmt(_('{title} (past its date)'), { title: item.title }) : item.title);
        label.update_property([Gtk.AccessibleProperty.LABEL], [label.label]);
        onChipClick(label, () => this.editItem(item.at));
        this.attachDrag(label, item.at);
        return label;
    }

    // The days of the month that have notes, one under the other.
    private agenda(data: CalendarData, month: string, today: string): Gtk.Widget {
        const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true });
        const days = [...data.byDate.keys()].filter(d => monthOf(d) === month).sort();
        if (!days.length) {
            const empty = new Gtk.Label({ label: _('No notes this month.'), xalign: 0 });
            empty.add_css_class('dim-label');
            list.append(empty);
        }
        for (const date of days) {
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
            const heading = new Gtk.Label({ label: formatDate(date, '%A, %e %B'), xalign: 0 });
            heading.add_css_class('heading');
            if (date === today) heading.add_css_class('calendar-today-text');
            box.append(heading);
            for (const item of data.byDate.get(date) ?? []) box.append(this.event(item, today));
            list.append(box);
        }
        return list;
    }

    // The notes without a date: a drop on the panel takes a note's date away, a drag from it to a day schedules it.
    private sidePanel(data: CalendarData): Gtk.Widget {
        const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, width_request: 220, valign: Gtk.Align.START });
        panel.add_css_class('calendar-undated');
        const heading = new Gtk.Label({ label: fmt(_('Not scheduled ({count})'), { count: data.undated.length }), xalign: 0 });
        heading.add_css_class('heading');
        panel.append(heading);
        if (!data.key) {
            const note = new Gtk.Label({ label: _('Declare a date field in the frontmatter (fields: due: date) to place notes on days.'), xalign: 0, wrap: true });
            note.add_css_class('dim-label');
            panel.append(note);
        }
        for (const item of data.undated) panel.append(this.undated(item.at, item.title));
        if (data.key) {
            const hint = new Gtk.Label({ label: _('Drag a note to a day to schedule it.'), xalign: 0, wrap: true });
            hint.add_css_class('dim-label');
            hint.add_css_class('caption');
            panel.append(hint);
            this.acceptDrop(panel, at => this.schedule(at, ''), over => this.mark(panel, over));
        }
        return panel;
    }

    private undated(at: Position, title: string): Gtk.Widget {
        const row = new Gtk.Label({ label: title, xalign: 0, wrap: true });
        row.add_css_class('calendar-note');
        onChipClick(row, () => this.editItem(at));
        this.attachDrag(row, at);
        return row;
    }
}

// A click on the empty part of a day. The notes inside claim their own presses, so only the background gets here.
function onChipClickBackground(widget: Gtk.Widget, run: () => void): void {
    const click = new Gtk.GestureClick({ button: 1 });
    click.connect('released', (_g, count) => { if (count === 2) run(); });
    widget.add_controller(click);
}
