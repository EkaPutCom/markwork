// GUI tests: the calendar, timeline, gallery, chart, and grouped board layouts (ui/calendar.ts, timeline.ts, gallery.ts,
// chart.ts, window/views.ts). --shot-layouts=<prefix> saves <prefix>-<layout>-light.png and -dark.png for each.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import { readTextFile } from '../../src/files.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { layoutOf } from '../../src/markdown/layout.js';
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

    test('chart: charts: picks and orders the panels, and the settings popover edits that list', () => {
        open('chart');
        const chart = w.layouts.chart as unknown as { widget: Gtk.Widget; settings: Gtk.Popover; render(): void };
        const headings = () => withClass(chart.widget, 'heading').map(h => (h as Gtk.Label).label);
        eq(headings(), ['Created per week', 'By status', 'By tag']);
        const button = (tip: string, nth = 0) => descendants(chart.settings.get_child()!).filter((x): x is Gtk.Button => x instanceof Gtk.Button && x.get_tooltip_text() === tip)[nth];
        // move the donut up: the donut comes before the bars, in the text and on the page
        button('Move up', 2).emit('clicked');
        settle();
        ok(text().includes('charts: [kpi, donut, bar, tags]'), text());
        eq(headings(), ['By status', 'Created per week', 'By tag']);
        // remove the tags, then add a second donut and see it on the page
        button('Remove', 3).emit('clicked');
        settle();
        eq(headings(), ['By status', 'Created per week']);
        const add = descendants(chart.settings.get_child()!).filter((x): x is Gtk.Button => x instanceof Gtk.Button && x.get_tooltip_text() === 'Add Donut')[0];
        add.emit('clicked');
        settle();
        eq(headings(), ['By status', 'Created per week', 'By status']);
        // reset removes the line, so the file is as it was
        descendants(chart.settings.get_child()!).filter((x): x is Gtk.Button => x instanceof Gtk.Button && x.get_label() === 'Reset to default')[0].emit('clicked');
        settle();
        eq(text(), readTextFile(sample('chart')));
        eq(headings(), ['Created per week', 'By status', 'By tag']);
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
        open('chart');
        const settings = (w.layouts.chart as unknown as { settings: Gtk.Popover }).settings;
        settings.popup();
        settle();
        widgetPixbuf(settings)?.savev(`${shot}-chart-settings.png`, 'png', [], []);
        settings.popdown();
    });

    section('Layout button (header bar)');
    const button = () => descendants(w.header).find((x): x is Gtk.MenuButton => x instanceof Gtk.MenuButton && x.get_tooltip_text() === 'View')!;
    const buttonLabel = () => (w.header as unknown as { _layoutLabel: Gtk.Label })._layoutLabel.label;
    const choose = (layout: string) => { (w.app.lookup_action('layout') as Gio.SimpleAction).change_state(GLib.Variant.new_string(layout)); settle(); };
    const checked = () => (w.app.lookup_action('layout') as Gio.SimpleAction).get_state()!.get_string()[0];

    test('the button names the layout of the document, says Text in the text view, and is hidden on Home', () => {
        open('sprint-table');
        ok(button().get_visible(), 'visible');
        eq([buttonLabel(), checked()], ['Table', 'table']);
        eq((w.header as unknown as { _layoutIcon: Gtk.Image })._layoutIcon.icon_name, 'x-office-spreadsheet-symbolic');
        open('calendar');
        eq([buttonLabel(), checked()], ['Calendar', 'calendar']);
        choose('');
        eq([page() === 'calendar', buttonLabel(), checked()], [false, 'Text', '']);
        w.openHome();
        settle();
        ok(!button().get_visible(), 'hidden on Home');
        w.closeTab();   // Home is a tab of its own
        settle();
        ok(!w.homeMode, 'back from Home');
    });

    test('the popover lists every layout and Text with an icon, and checks the one the document is in', () => {
        const rows = () => descendants(button().get_popover()!).filter((x): x is Gtk.ToggleButton => x instanceof Gtk.ToggleButton);
        open('calendar');
        const items = rows();
        eq(items.map(r => (r.get_action_target_value() as GLib.Variant).get_string()[0]), ['table', 'board', 'list', 'calendar', 'timeline', 'gallery', 'chart', '']);
        ok(items.every(r => descendants(r).some(x => x instanceof Gtk.Image && (x.icon_name ?? '').endsWith('-symbolic'))), 'an icon on every row');
        eq(items.filter(r => r.active).map(r => labels(r)[0].label), ['Calendar']);
        choose('chart');
        eq(rows().filter(r => r.active).map(r => labels(r)[0].label), ['Chart']);
    });

    test('choosing a layout rewrites only the layout line, shows that page, and one undo brings the old layout back', () => {
        open('sprint-table');
        const before = text();
        choose('board');
        eq([page(), buttonLabel(), text()], ['board', 'Board', before.replace('layout: table', 'layout: board')]);
        for (const name of ['list', 'calendar', 'timeline', 'gallery', 'chart', 'table']) {
            choose(name);
            eq([layoutOf(text()), buttonLabel().toLowerCase()], [name, name], name);
        }
        eq(text(), before, 'back to the first layout: the same text');
        c.w.editor.buffer.undo();
        settle();
        ok(layoutOf(text()) !== 'table', 'undo went back one layout');
    });

    test('a document with no layout gets a frontmatter, and the layout menu works from the text view', () => {
        w.load(sample('all-formats'));
        settle();
        eq([page() === 'calendar', buttonLabel()], [false, 'Text']);
        const body = text();
        choose('list');
        eq([page(), text()], ['inbox', `---\nlayout: list\n---\n\n${body}`]);
    });

    test('a layout changed in the text (by an undo, or the assistant) is followed, not thrown out to the text view', () => {
        open('sprint-table');
        w.editor.replaceText(text().replace('layout: table', 'layout: gallery'));
        settle();
        eq([page(), buttonLabel()], ['gallery', 'Gallery']);
        w.editor.replaceText(text().replace(/^---\n(?:.*\n)*?---\n/, '---\ntitle: x\n---\n'));
        settle();
        eq([page() === 'gallery', buttonLabel()], [false, 'Text']);
    });

    test('a layout that needs a field offers to add it, and the button adds it to the document', () => {
        w.load(sample('all-formats'));
        settle();
        choose('calendar');
        ok(w.lastToast.includes('date field'), w.lastToast);
        ok(w.lastToastAction?.label.includes('due'), 'a button names the field');
        w.session.toastActivated(w.lastToastAction!.token);
        settle();
        ok(/fields:\n {2}due: date/.test(text()), text().slice(0, 120));
        w.lastToast = '';
        choose('chart');
        ok(w.lastToast.includes('select field'), w.lastToast);
        w.session.toastActivated(w.lastToastAction!.token);
        settle();
        ok(/status: select\(todo, doing, done\)/.test(text()) || /status: select/.test(text()), text().slice(0, 160));
        w.lastToast = '';
        choose('table');
        eq(w.lastToast, '', 'a table needs no field');
    });
}
