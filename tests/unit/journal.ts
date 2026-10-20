// Daily journal model tests: the template, quick capture, activity merging, and board events.

import {
    activityLines, addNote, agentActivity, boardEvents, clock, commitActivity, harnessActivity, journalDate, journalName,
    journalStats, mergeActivity, newJournal, parseActivity, serializeActivity, type Activity,
} from '../../src/markdown/journal.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { section, test, eq, ok } from '../core/framework.js';

const EMPTY = newJournal('Thursday, October 8, 2026');
const at = (h: number, m: number) => Math.floor(new Date(2026, 9, 8, h, m).getTime() / 1000);

const BOARD = `---
layout: board
---

## Plan

- [ ] Release material #project/web
- [ ] Price research
- [ ] Price research

## In Progress

- [ ] Fix checkout

## Done
`;

export function journalModelTests(): void {
    section('Journal (model)');

    test('journal file name and date', () => {
        eq(journalName('2026-10-08'), 'journal/2026-10-08.md');
        eq(journalDate('journal/2026-10-08.md'), '2026-10-08');
        eq(journalDate('journal/notes.md'), null);
        eq(journalDate('other/journal/2026-10-08.md'), null);
    });

    test('the template contains the date title and four sections', () => {
        eq(EMPTY, '# Thursday, October 8, 2026\n\n## Today\'s focus\n\n## Notes\n\n## Activity\n\n## Summary\n');
        eq(clock(new Date(2026, 9, 8, 9, 5)), '09:05');
    });

    test('addNote: time-stamped bullets at the end of the Notes section, in order', () => {
        let text = addNote(EMPTY, '09:12', 'Opening files got faster');
        text = addNote(text, '11:40', '! Flatpak cannot be tested yet\n  on this machine');
        eq(text, '# Thursday, October 8, 2026\n\n## Today\'s focus\n\n## Notes\n\n- 09:12 Opening files got faster\n- 11:40 ! Flatpak cannot be tested yet on this machine\n\n## Activity\n\n## Summary\n');
        eq(addNote(EMPTY, '09:00', '   '), EMPTY, 'empty note ignored');
    });

    test('addNote: the Notes section is created if missing; other contents are untouched', () => {
        eq(addNote('# Today\n\nFree writing.\n', '08:00', 'start'), '# Today\n\nFree writing.\n\n## Notes\n\n- 08:00 start\n');
        eq(addNote('', '08:00', 'start'), '## Notes\n\n- 08:00 start\n');
        // Notes at the end of a document without a closing newline, and a heading inside a code block is not a section.
        eq(addNote('## Notes\n\n- a\n```\n## Activity\n```', '10:00', 'b'), '## Notes\n\n- a\n```\n## Activity\n```\n- 10:00 b');
    });

    test('mergeActivity: only adds lines that are not there yet; user edits stay', () => {
        const first = mergeActivity(EMPTY, ['- 10:42 Card “A” → In Progress', '- 16:05 Commit `dd831a6` Speed up']);
        ok(first.includes('## Activity\n\n- 10:42 Card “A” → In Progress\n- 16:05 Commit `dd831a6` Speed up\n\n## Summary'), first);
        const edited = first.replace('- 10:42 Card “A” → In Progress', '- 10:42 Card “A” → In Progress (helped by Rina)');
        const again = mergeActivity(edited, ['- 16:05 Commit `dd831a6` Speed up', '- 17:00 Agent changed [[plan]]']);
        ok(again.includes('(helped by Rina)\n- 16:05 Commit `dd831a6` Speed up\n- 17:00 Agent changed [[plan]]\n\n## Summary'), again);
        eq(mergeActivity(again, ['- 17:00 Agent changed [[plan]]']), again, 'without new lines, exactly the same text');
        eq(mergeActivity(EMPTY, []), EMPTY);
    });

    test('mergeActivity: a deleted Activity section is created again before Summary', () => {
        const text = '# J\n\n## Notes\n\n- a\n\n## Summary\n\nDone.\n';
        eq(mergeActivity(text, ['- 09:00 x']), '# J\n\n## Notes\n\n- a\n\n## Activity\n\n- 09:00 x\n\n## Summary\n\nDone.\n');
    });

    test('journalStats counts Notes and Activity bullets', () => {
        const text = mergeActivity(addNote(addNote(EMPTY, '09:00', 'a'), '10:00', 'b'), ['- 11:00 c']);
        eq(journalStats(text), { notes: 2, activity: 1 });
        eq(journalStats('# free\n'), { notes: 0, activity: 0 });
    });

    test('activity log: round-trip serialization, broken lines skipped, in time order', () => {
        const events: Activity[] = [
            { time: at(16, 5), kind: 'commit', text: commitActivity('dd831a6', 'Speed up\nopening') },
            { time: at(10, 42), kind: 'card', text: 'Card “A” → In Progress' },
        ];
        const log = events.map(serializeActivity).join('\n') + '\n{"time": 1, "kind": "card"\n{"time":2,"kind":"other","text":"x"}\n';
        const parsed = parseActivity(log);
        eq(parsed.length, 2, 'broken lines/foreign kinds included');
        eq(activityLines(parsed), ['- 10:42 Card “A” → In Progress', '- 16:05 Commit `dd831a6` Speed up opening']);
    });

    test('boardEvents: column move, checked as done, and new card', () => {
        const before = parseBoard(BOARD);
        const moved = parseBoard(BOARD.replace('- [ ] Release material #project/web\n', '').replace('- [ ] Fix checkout', '- [ ] Fix checkout\n- [ ] Release material #project/web'));
        eq(boardEvents(before, moved, 'tasks.md'), ['Card “Release material” → In Progress · [[tasks]]']);
        const done = parseBoard(BOARD.replace('- [ ] Fix checkout', '- [x] Fix checkout'));
        eq(boardEvents(before, done, 'project/board.md'), ['Card “Fix checkout” done · [[project/board]]']);
        const added = parseBoard(BOARD.replace('## Done\n', '## Done\n\n- Release 1.0\n'));
        eq(boardEvents(before, added, 'tasks.md'), ['New card “Release 1.0” in Done · [[tasks]]']);
    });

    test('boardEvents: an edited, deleted, or duplicate card does not produce a false event', () => {
        const before = parseBoard(BOARD);
        eq(boardEvents(before, parseBoard(BOARD.replace('Fix checkout', 'Fix checkout v2')), 'tasks.md'), [], 'text edit');
        eq(boardEvents(before, parseBoard(BOARD.replace('- [ ] Fix checkout\n', '')), 'tasks.md'), [], 'delete card');
        // One of two duplicate cards moves: only one event.
        const twin = parseBoard(BOARD.replace('- [ ] Price research\n- [ ] Price research', '- [ ] Price research').replace('- [ ] Fix checkout', '- [ ] Fix checkout\n- [ ] Price research'));
        eq(boardEvents(before, twin, 'tasks.md'), ['Card “Price research” → In Progress · [[tasks]]']);
        eq(boardEvents(before, before, 'tasks.md'), []);
    });

    test('summary of agent changes and harness results', () => {
        eq(agentActivity([
            { kind: 'edit', file: 'plans/launch.md' }, { kind: 'edit', file: 'tasks.md' }, { kind: 'edit', file: 'tasks.md' },
            { kind: 'create', file: 'notes/new.md' }, { kind: 'delete', file: 'old.md' }, { kind: 'move', file: 'a.md', to: 'archive/a.md' },
        ]), 'Agent changed [[plans/launch]], [[tasks]]; created [[notes/new]]; removed `old.md`; moved [[a]] to [[archive/a]]');
        eq(agentActivity([]), null);
        eq(harnessActivity('pi', 'Fix checkout', 'shop', true), 'pi finished “Fix checkout” in project shop');
        eq(harnessActivity('pi', 'Fix checkout', 'shop', false), 'pi failed “Fix checkout” in project shop');
    });
}
