// Tests of the calendar, timeline, gallery, chart, and grouped board layouts (markdown/calendar.ts, timeline.ts,
// gallery.ts, chart.ts, boardgroup.ts, dates.ts).

import GLib from 'gi://GLib';
import { readTextFile } from '../../src/files.js';
import { addDays, addMonths, dayNumber, daysBetween, monthWeeks, startOfWeek, weekday } from '../../src/markdown/dates.js';
import { calendarData, dateField, moveToDate } from '../../src/markdown/calendar.js';
import { barSpan, resizeRow, shiftRow, timelineRange, timelineRows, timelineTicks, timelineZoom } from '../../src/markdown/timeline.js';
import { coverOf, galleryCards, gallerySize, tagColorIndex } from '../../src/markdown/gallery.js';
import { chartData } from '../../src/markdown/chart.js';
import { groupBoard, groupFieldOf, ungroupBoard } from '../../src/markdown/boardgroup.js';
import { addCard, boardSchema, deleteCard, moveCard, parseBoard, serializeBoard, updateCard } from '../../src/markdown/kanban.js';
import { isCalendar, isChart, isGallery, isTimeline, layoutOf } from '../../src/markdown/layout.js';
import { missingField, withField } from '../../src/markdown/layouthint.js';
import { ROOT, section, test, eq, ok } from '../framework.js';

const sample = (name: string): string => readTextFile(GLib.build_filenamev([ROOT, 'tests', 'samples', name]));
const titles = (cards: { card: { text: string } }[]): string[] => cards.map(c => c.card.text.replace(/ ?\[.*$/, '').replace(/ #\w+/g, ''));

export function layoutsModelTests(): void {
    section('Dates');

    test('dayNumber/addDays/daysBetween: real dates only, across months and leap years', () => {
        eq([dayNumber('2026-02-30'), dayNumber('nope'), dayNumber('2026-10-11')! - dayNumber('2026-10-01')!], [null, null, 10]);
        eq([addDays('2026-10-30', 3), addDays('2028-02-28', 1), addDays('2026-01-01', -1), daysBetween('2026-10-11', '2026-10-09')], ['2026-11-02', '2028-02-29', '2025-12-31', -2]);
    });
    test('weekday starts on Monday, and a month is shown as whole weeks', () => {
        eq([weekday('2026-10-12'), weekday('2026-10-11'), startOfWeek('2026-10-11'), addMonths('2026-12', 1), addMonths('2026-01', -1)], [0, 6, '2026-10-05', '2027-01', '2025-12']);
        const weeks = monthWeeks('2026-10');
        eq([weeks.length, weeks[0][0], weeks[0][3], weeks[4][6]], [5, '2026-09-28', '2026-10-01', '2026-11-01']);
        eq(monthWeeks('2027-02').length, 4, 'February 2027 starts on a Monday and fits four weeks');
    });

    section('Layouts (frontmatter)');

    test('the new layouts are recognized', () => {
        eq(['calendar.md', 'timeline.md', 'gallery.md', 'chart.md'].map(n => layoutOf(sample(n))), ['calendar', 'timeline', 'gallery', 'chart']);
        const doc = (l: string) => `---\nlayout: ${l}\n---\n`;
        eq([isCalendar(doc('calendar')), isTimeline(doc('Timeline')), isGallery(doc('"gallery"')), isChart(doc('chart')), isChart(doc('table'))], [true, true, true, true, false]);
        eq(boardSchema(parseBoard(sample('calendar.md'))).map(f => f.key), ['due', 'status'], 'only the declared fields');
    });

    section('Calendar (model)');

    test('calendarData: notes by the day of their date field, in time order, and the ones without a date', () => {
        const data = calendarData(parseBoard(sample('calendar.md')));
        eq(data.key, 'due');
        eq(titles(data.byDate.get('2026-10-11')!), ['Fix the sync bug', 'Team meeting'], 'a note without a time comes first, then the ones in time order');
        eq(data.byDate.get('2026-10-11')!.map(i => i.time), [null, '14:00']);
        eq([...data.byDate.keys()].length, 6);
        eq(data.undated.map(u => u.title), ['Research PDF export', 'Read the HIG article', 'Tidy up the icons']);
    });
    test('dateField: date: picks the field, otherwise due, otherwise the first date field, otherwise none', () => {
        const doc = (head: string) => parseBoard(`---\nlayout: calendar\n${head}fields:\n  start: date\n  due: date\n  note: text\n---\n`);
        eq([dateField(doc(''))?.key, dateField(doc('date: start\n'))?.key, dateField(doc('date: note\n'))?.key], ['due', 'start', 'due']);
        eq(dateField(parseBoard('---\nlayout: calendar\nfields:\n  note: text\n---\n')), null);
        eq(calendarData(parseBoard('---\nlayout: calendar\n---\n\n- [ ] a\n')).undated.length, 1, 'no date field: every note is undated');
    });
    test('moveToDate: sets the date and keeps the time; an empty date unschedules; a wrong date changes nothing', () => {
        const board = parseBoard(sample('calendar.md'));
        const data = calendarData(board);
        const meeting = data.byDate.get('2026-10-11')![1];
        const moved = moveToDate(board, meeting.at, '2026-10-15');
        eq(moved.columns[meeting.at.column].cards[meeting.at.index].text, '- [ ] Team meeting [status:: todo] [due:: 2026-10-15 14:00]'.replace('- [ ] ', ''));
        const plain = data.byDate.get('2026-10-09')![0];
        ok(moveToDate(board, plain.at, '2026-10-10').columns[0].cards[plain.at.index].text.includes('[due:: 2026-10-10]'), 'moved');
        ok(!moveToDate(board, plain.at, '').columns[0].cards[plain.at.index].text.includes('due'), 'removed');
        eq(moveToDate(board, plain.at, '2026-13-40'), board, 'not a date');
        const undated = data.undated[0];
        ok(moveToDate(board, undated.at, '2026-10-30').columns[undated.at.column].cards[undated.at.index].text.includes('[due:: 2026-10-30]'), 'scheduled');
    });

    section('Timeline (model)');

    test('timelineRows: start to end, a marker for one date, none for no date, progress from the field or the checkbox', () => {
        const rows = timelineRows(parseBoard(sample('timeline.md')));
        eq(rows.map(r => [r.title, r.start, r.end, r.progress]), [
            ['Design the home page', '2026-10-05', '2026-10-12', 1], ['Fix the sync bug', '2026-10-08', '2026-10-17', 0.6],
            ['Write the changelog', '2026-10-15', '2026-10-20', null], ['Release 0.9', '2026-10-21', '2026-10-31', 0.1],
            ['Research PDF export', '2026-11-06', '2026-11-06', null], ['Plan the next release', null, null, null]]);
        eq(timelineZoom(parseBoard(sample('timeline.md'))), 'month');
    });
    test('timelineRange and barSpan: a whole number of weeks from a Monday, with room for today and every date', () => {
        const rows = timelineRows(parseBoard(sample('timeline.md')));
        const range = timelineRange(rows, '2026-10-11');
        eq([range.start, range.days % 7, range.days >= daysBetween(range.start, '2026-11-06') + 1], ['2026-10-02'.replace('10-02', '09-28'), 0, true]);
        eq(barSpan(rows[1], range), { offset: 10, length: 10 });
        eq(barSpan(rows[5], range), null);
        eq(timelineTicks(range, 'month').slice(0, 2), [{ date: '2026-09-28', offset: 0 }, { date: '2026-10-05', offset: 7 }]);
    });
    test('shiftRow moves both dates and keeps a time; resizeRow moves one edge and never inverts the bar', () => {
        const board = parseBoard(sample('timeline.md'));
        const at = { column: 0, index: 1 };
        const shifted = shiftRow(board, at, 3).columns[0].cards[1].text;
        ok(shifted.includes('[start:: 2026-10-11]') && shifted.includes('[due:: 2026-10-20]'), shifted);
        const longer = resizeRow(board, at, 'end', 2).columns[0].cards[1].text;
        ok(longer.includes('[start:: 2026-10-08]') && longer.includes('[due:: 2026-10-19]'), longer);
        eq(resizeRow(board, at, 'end', -20), board, 'cannot end before it starts');
        eq(resizeRow(board, at, 'start', 20), board, 'cannot start after it ends');
        ok(shiftRow(board, { column: 0, index: 4 }, 1).columns[0].cards[4].text.includes('[due:: 2026-11-07]'), 'a marker shifts');
        eq(shiftRow(board, { column: 0, index: 5 }, 1), board, 'no dates: nothing to shift');
    });

    section('Gallery (model)');

    test('galleryCards: cover from the field, then the first image, then the first tag color, else none', () => {
        const cards = galleryCards(parseBoard(sample('gallery.md')));
        eq(cards.map(c => c.cover.kind), ['color', 'image', 'color', 'color', 'image', 'color', 'color', 'none']);
        eq(cards[1].cover, { kind: 'image', path: 'images/example.png' });
        eq(cards[4].cover, { kind: 'image', path: 'images/example.png' }, 'an image in the note');
        eq([cards[0].snippet, cards[4].snippet, cards[7].snippet], ['Title in the middle, actions on the sides.', '200 ms with ease-out.', '']);
        eq(cards[0].cover, { kind: 'color', index: tagColorIndex('gtk') });
        eq([tagColorIndex('gtk') === tagColorIndex('gtk'), tagColorIndex('x') < 8], [true, true]);
        eq(gallerySize(parseBoard(sample('gallery.md'))), 'medium');
        eq(gallerySize(parseBoard('---\nlayout: gallery\nsize: large\n---\n')), 'large');
        eq(coverOf({ done: false, text: 'a [cover:: color-3]', notes: [] }, [{ key: 'cover', type: 'text', multiple: false, options: [] }], 'cover'), { kind: 'color', index: 3 });
    });

    section('Chart (model)');

    test('chartData: totals, overdue, notes per week, per status in the order of the options, per tag', () => {
        const data = chartData(parseBoard(sample('chart.md')), '2026-10-12');
        eq([data.total, data.done, data.overdue, data.period, data.groupKey], [11, 4, 1, 'week', 'status']);
        eq(data.perPeriod, [{ start: '2026-09-28', count: 2 }, { start: '2026-10-05', count: 3 }, { start: '2026-10-12', count: 3 }, { start: '2026-10-19', count: 3 }]);
        eq(data.byGroup.map(s => [s.name, s.count, s.color]), [['todo', 4, 'gray'], ['doing', 2, 'blue'], ['done', 4, 'green'], ['—', 1, null]]);
        eq(data.byTag.slice(0, 2).map(t => [t.name, t.count]), [['#docs', 4], ['#bug', 2]]);
        eq(data.averagePerWeek, 2.8);
    });
    test('chartData: a document without dates, fields, or notes gives empty charts, not errors', () => {
        const empty = chartData(parseBoard('---\nlayout: chart\n---\n'), '2026-10-12');
        eq([empty.total, empty.perPeriod, empty.byGroup, empty.groupKey, empty.averagePerWeek], [0, [], [], null, 0]);
        const plain = chartData(parseBoard('---\nlayout: chart\n---\n\n- [ ] a #x\n- [x] b #x\n'), '2026-10-12');
        eq([plain.total, plain.done, plain.byTag, plain.perPeriod.length], [2, 1, [{ name: '#x', count: 2, color: null }], 0]);
        eq(chartData(parseBoard('---\nlayout: chart\nperiod: month\nby: d\nfields:\n  d: date\n---\n\n- [ ] a [d:: 2026-10-30]\n- [ ] b [d:: 2026-11-02]\n'), '2026-11-05').perPeriod, [{ start: '2026-10-01', count: 1 }, { start: '2026-11-01', count: 1 }]);
    });

    section('Board grouped by a field (model)');

    const grouped = () => {
        const source = parseBoard(sample('board-by-field.md'));
        const def = groupFieldOf(source)!;
        return { source, def, view: groupBoard(source, def) };
    };
    const statusOf = (text: string): string => /\[status:: ([^\]]*)\]/.exec(text)?.[1] ?? '';

    test('groupFieldOf: group: must name a single select field; groupBoard makes a column per option and one for no value', () => {
        const { def, view } = grouped();
        eq(def.key, 'status');
        eq(groupFieldOf(parseBoard('---\nlayout: board\ngroup: nope\n---\n')), null);
        eq(groupFieldOf(parseBoard('---\nlayout: board\ngroup: owner\nfields:\n  owner: person\n---\n')), null);
        eq(view.board.columns.map(c => [c.title, c.cards.length]), [['', 1], ['planned', 2], ['doing', 1], ['review', 1], ['done', 2]]);
        eq(groupBoard(parseBoard('---\nlayout: board\ngroup: s\n---\n\n- [ ] x [s:: z]\n- [ ] y [s:: a]\n'), { key: 's', type: 'select', multiple: false, options: [] }).board.columns.map(c => c.title), ['z', 'a'], 'a select without options takes the values the notes have');
    });
    test('ungroupBoard: moving a card to another column sets its status; the empty column removes it', () => {
        const { source, def, view } = grouped();
        const moved = moveCard(view.board, { column: 1, index: 0 }, { column: 3, index: 0 });
        const next = ungroupBoard(source, view, moved, def);
        eq(statusOf(next.columns[0].cards[1].text), 'review');
        eq(next.columns[0].cards.length, source.columns[0].cards.length, 'no card lost or added');
        const unset = ungroupBoard(source, view, moveCard(view.board, { column: 2, index: 0 }, { column: 0, index: 0 }), def);
        ok(!unset.columns[0].cards.some(c => c.text.startsWith('Fix the sync bug') && c.text.includes('[status::')), 'moved to the first column: no status');
        eq(ungroupBoard(source, view, view.board, def), source, 'nothing changed');
    });
    test('ungroupBoard: an edit is kept, a new card gets the value of its column, a deleted card goes, a new column is a new option', () => {
        const { source, def, view } = grouped();
        const edited = ungroupBoard(source, view, updateCard(view.board, { column: 3, index: 0 }, { text: 'Review the parser twice [status:: review] [priority:: high]' }), def);
        ok(edited.columns[0].cards.some(c => c.text.startsWith('Review the parser twice')), 'edited');
        const added = ungroupBoard(source, view, addCard(view.board, 2, 'New thing'), def);
        eq(added.columns[0].cards.map(c => c.text).filter(t => t.startsWith('New thing')), ['New thing [status:: doing]']);
        const removed = ungroupBoard(source, view, deleteCard(view.board, { column: 4, index: 0 }), def);
        eq(removed.columns[0].cards.length, source.columns[0].cards.length - 1);
        const withColumn = { ...view.board, columns: [...view.board.columns, { title: 'blocked', intro: [], outro: [], cards: [{ done: false, text: 'Stuck', notes: [] }] }] };
        const widened = ungroupBoard(source, view, withColumn, def);
        ok(widened.head.join('\n').includes('blocked'), 'option added');
        ok(widened.columns[0].cards.some(c => c.text === 'Stuck [status:: blocked]'), 'card written with it');
        eq(serializeBoard(parseBoard(serializeBoard(widened))), serializeBoard(widened), 'stable text');
    });

    test('missingField: a calendar, timeline, or chart without its field offers one, and adding it makes the layout work', () => {
        const plain = parseBoard('---\nlayout: list\n---\n\n- [ ] a\n- [ ] b');
        eq([missingField(plain, 'calendar')?.key, missingField(plain, 'timeline')?.key, missingField(plain, 'chart')?.key, missingField(plain, 'board'), missingField(plain, 'gallery')], ['due', 'due', 'status', null, null]);
        const withDue = withField(plain, missingField(plain, 'calendar')!);
        eq([missingField(withDue, 'calendar'), missingField(withDue, 'timeline'), boardSchema(withDue).map(f => f.key)], [null, null, ['due']]);
        const withStatus = withField(plain, missingField(plain, 'chart')!);
        eq([missingField(withStatus, 'chart'), withField(withStatus, missingField(plain, 'chart')!) === withStatus], [null, true]);
        eq(missingField(parseBoard(sample('calendar.md')), 'calendar'), null);
    });
}
