// Tests for finding git conflict markers in a text and for what each choice turns a conflict into (markdown/conflicts.ts).

import { section, test, eq, ok } from '../framework.js';
import { findConflicts, resolution, roles } from '../../src/markdown/conflicts.js';

const lines = (text: string): string[] => text.split('\n');

export function conflictTests(): void {
    section('Conflict markers (find and choose)');
    const TWO = ['# Journal', '<<<<<<< HEAD', 'mine', '=======', 'theirs', 'more theirs', '>>>>>>> refs/pull/7/head', 'between', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> abc123', 'end'];

    test('finds each conflict with its line numbers and the names on its markers', () => {
        const found = findConflicts(TWO);
        eq(found.length, 2);
        eq([found[0].start, found[0].mid, found[0].end, found[0].base], [1, 3, 6, null]);
        eq([found[0].current, found[0].incoming], ['HEAD', 'refs/pull/7/head']);
        eq([found[1].start, found[1].mid, found[1].end], [8, 10, 12]);
    });
    test('a Markdown heading underline or an unclosed marker is not a conflict', () => {
        eq(findConflicts(['Title', '=======', 'text']).length, 0);
        eq(findConflicts(['<<<<<<< HEAD', 'mine', '=======', 'theirs']).length, 0);
        eq(findConflicts(['<<<<<<< HEAD', 'mine', '>>>>>>> x']).length, 0);
        eq(findConflicts(['> quote', '>>>>>>> not a marker without a start']).length, 0);
    });
    test('a marker without a name, and Windows line endings, still count', () => {
        eq(findConflicts(['<<<<<<<', 'a', '=======', 'b', '>>>>>>>']).length, 1);
        eq(findConflicts(['<<<<<<< HEAD\r', 'a\r', '=======\r', 'b\r', '>>>>>>> x\r']).length, 1);
    });
    test('a new start before the end drops the unfinished conflict', () => {
        const found = findConflicts(['<<<<<<< one', 'x', '<<<<<<< two', 'a', '=======', 'b', '>>>>>>> two']);
        eq(found.length, 1);
        eq([found[0].start, found[0].current], [2, 'two']);
    });
    test('accept current, incoming, and both', () => {
        const [first] = findConflicts(TWO);
        eq(resolution(TWO, first, 'current'), ['mine']);
        eq(resolution(TWO, first, 'incoming'), ['theirs', 'more theirs']);
        eq(resolution(TWO, first, 'both'), ['mine', 'theirs', 'more theirs']);
    });
    test('an empty side leaves nothing behind', () => {
        const text = ['<<<<<<< HEAD', '=======', 'theirs', '>>>>>>> x'];
        const [c] = findConflicts(text);
        eq(resolution(text, c, 'current'), []);
        eq(resolution(text, c, 'incoming'), ['theirs']);
    });
    test('with a base section (diff3) the base is not part of either side', () => {
        const text = lines('<<<<<<< HEAD\nmine\n||||||| base\noriginal\n=======\ntheirs\n>>>>>>> x');
        const [c] = findConflicts(text);
        eq([c.start, c.base, c.mid, c.end], [0, 2, 4, 6]);
        eq(resolution(text, c, 'current'), ['mine']);
        eq(resolution(text, c, 'both'), ['mine', 'theirs']);
        eq(roles([c]).map(r => r[1]), ['currentHead', 'current', 'neutral', 'neutral', 'neutral', 'incoming', 'incomingHead']);
    });
    test('every line of a conflict has a role, from the first marker to the last', () => {
        const [c] = findConflicts(TWO);
        const got = roles([c]);
        eq(got.map(r => r[0]), [1, 2, 3, 4, 5, 6]);
        eq(got.map(r => r[1]), ['currentHead', 'current', 'neutral', 'incoming', 'incoming', 'incomingHead']);
        ok(roles([]).length === 0, 'roles of no conflicts');
    });
}
