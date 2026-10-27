// The blocks of a document and moving one (markdown/blocks.ts): what the visual editor's block handle adds after and drags.

import { blockAt, blocksOf, moveBlock } from '../../src/markdown/blocks';
import { section, test, eq } from '../core/framework';

const lines = (text: string) => text.split('\n');
const shape = (text: string) => blocksOf(lines(text)).map(b => `${b.kind} ${b.start}-${b.end}`);

export function blockTests(): void {
    section('Blocks (markdown/blocks.ts)');

    test('blocksOf: each kind of block, and the lines between them are not blocks', () => {
        eq(shape('# Title\n\nSome text\nover two lines\n\n- a\n- b\n  more\n\n> quote\n> more\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\ncode\n\nafter a blank\n```\n\nend'),
            ['heading 0-0', 'paragraph 2-3', 'list 5-7', 'quote 9-10', 'rule 12-12', 'table 14-16', 'code 18-22', 'paragraph 24-24']);
        eq(shape(''), [], 'an empty document has no blocks');
        eq(shape('---\ntitle: x\n---\n\ntext'), ['frontmatter 0-2', 'paragraph 4-4']);
    });

    test('blocksOf: a heading, a list, or a table that touches a line of text is a block of its own', () => {
        eq(shape('text\n# Head\nmore\n- item\n1. one'), ['paragraph 0-0', 'heading 1-1', 'paragraph 2-2', 'list 3-4']);
        eq(shape('intro\n| a |\n| - |\n| 1 |'), ['paragraph 0-0', 'table 1-3']);
        eq(shape('```\nnever closed\n\nstill code'), ['code 0-3'], 'an open fence runs to the end');
    });

    test('blockAt: the block a line is in, and -1 between blocks', () => {
        const blocks = blocksOf(lines('a\n\nb'));
        eq([0, 1, 2].map(n => blockAt(blocks, n)), [0, -1, 1]);
    });

    // The text after moving block `index` before block `before`.
    const moved = (text: string, index: number, before: number): string | null => {
        const ls = lines(text), blocks = blocksOf(ls), move = moveBlock(ls, blocks, index, before);
        return move && [...ls.slice(0, move.from), ...move.lines, ...ls.slice(move.to + 1)].join('\n');
    };

    test('moveBlock: down, up, to the end, and nothing when it would not change', () => {
        const text = 'one\n\ntwo\n\nthree';
        eq(moved(text, 0, 2), 'two\n\none\n\nthree', 'before the third block (down one)');
        eq(moved(text, 0, 3), 'two\n\nthree\n\none', 'to the end');
        eq(moved(text, 2, 0), 'three\n\none\n\ntwo', 'up to the start');
        eq(moved(text, 1, 1), null, 'before itself');
        eq(moved(text, 1, 2), null, 'before the next one is where it is');
        eq(moved(text, 5, 0), null, 'a block that does not exist');
    });

    test('moveBlock: the lines between blocks stay put, a single line break becomes a blank line, and the cursor follows the block', () => {
        eq(moved('a\n\n\nb', 0, 2), 'b\n\n\na', 'two blank lines stay two');
        eq(moved('# T\ntext\n\nlast', 1, 3), '# T\nlast\n\ntext', 'the lines between the blocks stay where they were');
        eq(moved('# H\npara\n\nlast', 2, 0), 'last\n\n# H\n\npara', 'blocks that touched are apart once the range around the move is rearranged');
        const ls = lines('# T\ntext\n\nlast'), move = moveBlock(ls, blocksOf(ls), 0, 3)!;
        eq(move.lines, ['text', '', 'last', '', '# T']);
        eq(move.cursor, 4, 'the cursor goes to the moved block');
        eq(moved('x\n\n- a\n- b\n\ny', 1, 3), 'x\n\ny\n\n- a\n- b', 'a whole list moves');
    });
}
