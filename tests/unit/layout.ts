// Layout marker tests (markdown/layout.ts).

import { isBoard, isList, isStructured, isTable, layoutOf, optionOf, withLayout, withOption } from '../../src/markdown/layout';
import { section, test, eq } from '../core/framework';
import { BOARD, INBOX } from '../core/fixtures';

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
        eq(['layout: mindmap', 'layout:', 'layout: board list', 'layouts: board', 'kanban: true', 'inbox: true'].map(l => layoutOf(doc(l))), [null, null, null, null, null, null]);
        eq(layoutOf('---\ntitle: x\nlayout: list\ntag: y\n---'), 'list', 'among other frontmatter keys');
        eq([isBoard(BOARD), isBoard(INBOX), isList(INBOX), isList(BOARD), isTable('---\nlayout: table\n---'), isTable(BOARD), isStructured(BOARD), isStructured('---\nlayout: table\n---'), isStructured('# Plain')], [true, false, true, false, true, false, true, true, false]);
    });
    test('optionOf: a one-line option in the frontmatter, without quotes; not from a block, the body, or a missing value', () => {
        const doc = '---\nlayout: list\nadd: "bottom"\nAdd-To: Now \nfields:\n  add: text\nempty:\n---\n\nadd: top\n';
        eq([optionOf(doc, 'add'), optionOf(doc, 'add-to'), optionOf(doc, 'empty'), optionOf(doc, 'nope'), optionOf('add: top', 'add')], ['bottom', 'Now', null, null, null]);
    });
    test('withOption: replaces or adds a one-line option after layout:, null removes it; no frontmatter, no change', () => {
        eq(withOption('---\nlayout: chart\nby: due\n---\nx', 'by', 'created'), '---\nlayout: chart\nby: created\n---\nx');
        eq(withOption('---\ntitle: t\nlayout: chart\nfields:\n  a: date\n---\nx', 'charts', '[tags]'), '---\ntitle: t\nlayout: chart\ncharts: [tags]\nfields:\n  a: date\n---\nx');
        eq(withOption('---\nlayout: chart\ncharts: [tags]\n---\nx', 'charts', null), '---\nlayout: chart\n---\nx');
        eq(withOption('charts: [a]\nbody', 'charts', null), 'charts: [a]\nbody');
        eq(withOption('---\nlayout: chart\n---\ncharts: [a]', 'charts', null), '---\nlayout: chart\n---\ncharts: [a]');
    });

    test('withLayout: replaces the line, adds it to a frontmatter, or adds a frontmatter; nothing else changes', () => {
        eq(withLayout('---\ntitle: x\nlayout: "list"\nadd: top\n---\n\n## A\n- b', 'calendar'), '---\ntitle: x\nlayout: calendar\nadd: top\n---\n\n## A\n- b');
        eq(withLayout('---\ntitle: x\n---\n\ntext', 'board'), '---\nlayout: board\ntitle: x\n---\n\ntext');
        eq(withLayout('# Plain\n\n- a', 'table'), '---\nlayout: table\n---\n\n# Plain\n\n- a');
        eq(withLayout('text\n\nlayout: list', 'chart'), '---\nlayout: chart\n---\n\ntext\n\nlayout: list', 'a body line is not the frontmatter');
        eq(layoutOf(withLayout('# Plain', 'gallery')), 'gallery');
    });
}
