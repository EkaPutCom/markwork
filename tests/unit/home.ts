// Tests for the Home data.

import { dayPart, dueTasks, localDate, moveRecent, openInboxes, rememberRecent, splitRecent, type RecentFile } from '../../src/markdown/home';
import { section, test, eq } from '../core/framework';

const BOARD = `---
layout: board
---

## Plan

- [ ] Overdue [due:: 2026-10-05]
- [ ] Today #project/estuary [due:: 2026-10-07]
- [ ] Next week [due:: 2026-10-14]
- [ ] No due date
- [x] Already checked [due:: 2026-10-07]
- Plain bullet day after tomorrow [due:: 2026-10-09 10:00]

## Done

- Finished without a checkbox [due:: 2026-10-07]
`;

const INBOX = `---
layout: list
---

- one
- [x] already processed
- [ ] two
`;

export function homeModelTests(): void {
    section('Home (model)');

    test('dueTasks: unfinished overdue, today, and next two days, ordered by due date', () => {
        const tasks = dueTasks([{ name: 'board.md', text: BOARD }, { name: 'notes.md', text: '# Plain\n\n- [ ] a [due:: 2026-10-07]' }], '2026-10-07');
        eq(tasks.map(t => [t.title, t.status, t.days]), [['Overdue', 'overdue', -2], ['Today', 'today', 0], ['Plain bullet day after tomorrow', 'soon', 2]]);
        eq(tasks[1].at, { column: 0, index: 1 }, 'card position');
        eq(tasks[1].card, 'Today #project/estuary [due:: 2026-10-07]', 'original card text');
        eq(tasks[0].file, 'board.md', 'board file');
    });
    test('dueTasks: project name from projectOf', () => {
        const tasks = dueTasks([{ name: 'board.md', text: BOARD }], '2026-10-07', (_b, card) => /#project\/(\S+)/.exec(card.text)?.[1] ?? null);
        eq(tasks.map(t => t.project), [null, 'estuary', null]);
    });
    test('openInboxes: only unchecked items, an empty inbox is skipped', () => {
        eq(openInboxes([{ name: 'inbox.md', text: INBOX }, { name: 'empty.md', text: '---\nlayout: list\n---\n\n- [x] a\n' }, { name: 'board.md', text: BOARD }]),
            [{ file: 'inbox.md', open: 2 }]);
    });
    test('a list counts too: its due notes show up in dueTasks, and notes under headings count as open', () => {
        const list = '---\nlayout: list\n---\n\n- loose [due:: 2026-10-07]\n\n## Later\n\n- [ ] one\n- [x] done\n';
        eq(dueTasks([{ name: 'list.md', text: list }], '2026-10-07').map(t => [t.title, t.at]), [['loose', { column: 0, index: 0 }]]);
        eq(openInboxes([{ name: 'list.md', text: list }]), [{ file: 'list.md', open: 2 }]);
    });
    test('rememberRecent: at the front, without duplicates, limited', () => {
        let list: RecentFile[] = [];
        list = rememberRecent(list, '/a.md', 1);
        list = rememberRecent(list, '/b.md', 2);
        list = rememberRecent(list, '/a.md', 3);
        eq(list, [{ path: '/a.md', time: 3 }, { path: '/b.md', time: 2 }]);
        eq(rememberRecent(list, '/c.md', 4, 2).map(r => r.path), ['/c.md', '/a.md'], 'limit');
    });
    test('moveRecent: a moved file and folder contents', () => {
        const list = [{ path: '/k/a.md', time: 1 }, { path: '/k/sub/b.md', time: 2 }, { path: '/k/subx.md', time: 3 }];
        eq(moveRecent(list, '/k/sub', '/k/new').map(r => r.path), ['/k/a.md', '/k/new/b.md', '/k/subx.md']);
        eq(moveRecent(list, '/k/a.md', '/k/c.md')[0].path, '/k/c.md');
    });
    test('splitRecent: one card per folder, the rest go to the list', () => {
        const at = (path: string, time: number) => ({ path, time });
        const list = [at('/k/delta/a.md', 9), at('/k/delta/b.md', 8), at('/k/markwork/c.md', 7), at('/k/d.md', 6), at('/k/markwork/e.md', 5)];
        const { resume, others } = splitRecent(list, 2, 2);
        eq(resume.map(r => r.path), ['/k/delta/a.md', '/k/markwork/c.md']);
        eq(others.map(r => r.path), ['/k/delta/b.md', '/k/d.md']);
    });
    test('dayPart and localDate', () => {
        eq([3, 4, 10, 11, 14, 15, 17, 18, 23].map(dayPart), ['evening', 'morning', 'morning', 'midday', 'midday', 'afternoon', 'afternoon', 'evening', 'evening']);
        eq(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    });
}
