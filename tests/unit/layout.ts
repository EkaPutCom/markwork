// Layout marker tests (markdown/layout.ts).

import { isBoard, isList, layoutOf } from '../../src/markdown/layout.js';
import { section, test, eq } from '../framework.js';
import { BOARD, INBOX } from '../fixtures.js';

export function layoutTests(): void {
    section('Layout (frontmatter)');

    test('layoutOf: board and list, in the frontmatter only', () => {
        eq([layoutOf(BOARD), layoutOf(INBOX), layoutOf('# Plain\n\ntext'), layoutOf('---\ntitle: a\n---\n\ntext'),
            layoutOf('text\n\nlayout: board'), layoutOf('---\n\ntext\n\n---\nlayout: board')],
            ['board', 'list', null, null, null, null]);
    });
    test('layoutOf: case, quotes, other keys around it, and values that are not a layout', () => {
        const doc = (line: string) => `---\n${line}\n---\n\n## A`;
        eq(['layout: board', 'layout: "list"', 'LAYOUT: Board', "layout: 'List'"].map(l => layoutOf(doc(l))), ['board', 'list', 'board', 'list']);
        eq(['layout: table', 'layout:', 'layout: board list', 'layouts: board', 'kanban: true', 'inbox: true'].map(l => layoutOf(doc(l))), [null, null, null, null, null, null]);
        eq(layoutOf('---\ntitle: x\nlayout: list\ntag: y\n---'), 'list', 'among other frontmatter keys');
        eq([isBoard(BOARD), isBoard(INBOX), isList(INBOX), isList(BOARD)], [true, false, true, false]);
    });
}
