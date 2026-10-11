// GUI tests: the calendar, timeline, gallery, chart, and grouped board layouts (ui/calendar.ts, timeline.ts, gallery.ts,
// chart.ts, window/views.ts). --shot-layouts=<prefix> saves <prefix>-<layout>-light.png and -dark.png for each.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { readTextFile } from '../../src/files.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { ROOT, optVal, section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

const PAGES = ['calendar', 'timeline', 'gallery', 'chart', 'board-by-field'] as const;

export function layoutsGuiTests(c: GuiContext): void {
    const { w, pump, text } = c;
    section('Calendar, timeline, gallery, chart, and board by field (views)');
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const sample = (name: string) => GLib.build_filenamev([ROOT, 'tests', 'samples', `${name}.md`]);
    const open = (name: string) => { w.load(sample(name)); settle(); };
    const page = () => (w['content'] as Gtk.Stack).visible_child_name;
    const labels = (root: Gtk.Widget) => descendants(root).filter((x): x is Gtk.Label => x instanceof Gtk.Label);
    const withClass = (root: Gtk.Widget, cls: string) => descendants(root).filter(x => x.has_css_class(cls));
    for (const view of Object.values(w.layouts) as unknown as { today: () => string }[]) view.today = () => '2026-10-11';
    const calendar = w.layouts.calendar as unknown as { schedule(at: { column: number; index: number }, date: string): boolean; widget: Gtk.Widget };
    const timeline = w.layouts.timeline as unknown as { widget: Gtk.Widget };

    test('each layout opens on its own page, not as text, and opening does not change its text', () => {
        for (const [name, shown] of [['calendar', 'calendar'], ['timeline', 'timeline'], ['gallery', 'gallery'], ['chart', 'chart'], ['board-by-field', 'board']]) {
            open(name);
            eq(page(), shown, name);
            eq(text(), readTextFile(sample(name)), `${name}: text`);
        }
        ok(w.boardMode || page() !== null, 'a page is shown');
    });

    test('calendar: notes sit on their day, the ones without a date are in the side panel, a drop sets or clears the date', () => {
        open('calendar');
        const events = withClass(calendar.widget, 'calendar-event').map(e => (e as Gtk.Label).label);
        ok(events.includes('14:00 Team meeting') && events.includes('Fix the sync bug'), `events: ${events.join(' | ')}`);
        ok(labels(calendar.widget).some(l => l.label === 'Not scheduled (3)'), 'the side panel counts the unscheduled notes');
        ok(withClass(calendar.widget, 'calendar-today').length === 1, 'today is marked once');
        calendar.schedule({ column: 0, index: 3 }, '2026-10-20');
        settle();
        ok(text().includes('Fix the sync bug #bug [status:: doing] [due:: 2026-10-20]'), text());
        calendar.schedule({ column: 0, index: 3 }, '');
        settle();
        ok(!text().includes('Fix the sync bug #bug [status:: doing] [due::'), 'the date is gone');
    });

    test('timeline: a bar for each note with dates, none for the note without', () => {
        open('timeline');
        eq(withClass(timeline.widget, 'timeline-bar').length, 5);
        eq(withClass(timeline.widget, 'timeline-label').length, 6);
        ok(withClass(timeline.widget, 'timeline-bar-done').length === 1, 'the done note is green');
    });

    test('gallery: a card for each note; chart: the numbers; board by field: a column per option and a drag sets the status', () => {
        open('gallery');
        eq(withClass(w.layouts.gallery.widget, 'gallery-card').length, 8);
        open('chart');
        const numbers = withClass(w.layouts.chart.widget, 'chart-number').map(n => (n as Gtk.Label).label);
        eq(numbers.slice(0, 3), ['11', '4', '1']);
        open('board-by-field');
        eq(w.board.getBoard().columns.map(col => col.title), ['', 'planned', 'doing', 'review', 'done']);
        w.board.commit({ ...w.board.getBoard(), columns: w.board.getBoard().columns.map((col, i) => i === 1 ? { ...col, cards: col.cards.slice(1) } : i === 3 ? { ...col, cards: [...col.cards, w.board.getBoard().columns[1].cards[0]] } : col) });
        settle();
        ok(text().includes('Release notes [status:: review]'), text());
    });

    test('screenshots of the layouts', () => {
        const shot = optVal('shot-layouts');
        if (!shot) return;
        for (const name of PAGES) {
            open(name);
            w.win.set_focus(null);
            for (const dark of [false, true]) {
                w.setOption('dark', dark);
                settle();
                widgetPixbuf(w.win)?.savev(`${shot}-${name}-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
        }
        w.setOption('dark', false);
    });
}
