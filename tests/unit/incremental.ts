// The parser based on edited ranges compared with an independent full parse.
import Gtk from 'gi://Gtk?version=4.0';
import { highlight } from '../../src/editor/highlighter.js';
import { HighlightCache, type HighlightResult } from '../../src/markdown/highlight.js';
import { createTags, SYNTAX_TAGS } from '../../src/editor/tags.js';
import { LineTagger, tagRanges } from '../../src/editor/tagsync.js';
import { cpLength } from '../../src/markdown/offsets.js';
import { section, test, eq, ok } from '../framework.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function incrementalTests(): void {
    section('Edit range parsing');
    const buffer = new Gtk.TextBuffer();
    const tags = createTags(buffer);
    const tagger = new LineTagger(buffer, SYNTAX_TAGS.map(n => tags[n]));
    const cache = new HighlightCache(tags);
    const start = buffer.create_mark(null, buffer.get_start_iter(), true);
    const end = buffer.create_mark(null, buffer.get_start_iter(), false);
    let dirty = false;
    const mark = (a: Gtk.TextIter, b: Gtk.TextIter) => {
        if (!dirty || a.compare(buffer.get_iter_at_mark(start)) < 0) buffer.move_mark(start, a);
        if (!dirty || b.compare(buffer.get_iter_at_mark(end)) > 0) buffer.move_mark(end, b);
        dirty = true;
    };
    buffer.connect_after('insert-text', (_buf, b, text) => {
        const a = b.copy(); a.backward_chars(cpLength(text)); mark(a, b);
    });
    buffer.connect_after('delete-range', (_buf, a) => mark(a, a));
    const text = () => { const [a, b] = buffer.get_bounds(); return buffer.get_text(a, b, true); };
    const reset = (source: string): HighlightResult<Gtk.TextTag> => {
        buffer.set_text(source, -1);
        tagger.edited(0, buffer.get_line_count() - 1, buffer.get_line_count());
        dirty = false;
        return highlight(buffer, cache, tagger);
    };
    const flush = (): HighlightResult<Gtk.TextTag> => {
        const first = buffer.get_iter_at_mark(start).get_line(), last = buffer.get_iter_at_mark(end).get_line();
        if (dirty) tagger.edited(first, last, buffer.get_line_count());
        const result = highlight(buffer, cache, tagger, dirty ? [first, last] : null);
        dirty = false;
        return result;
    };
    const reference = new Gtk.TextBuffer();
    const refTags = createTags(reference);
    const check = (result: HighlightResult<Gtk.TextTag>) => {
        reference.set_text(text(), -1);
        const fresh = highlight(reference, new HighlightCache(refTags), new LineTagger(reference, SYNTAX_TAGS.map(n => refTags[n])));
        for (const field of ['text', 'lines', 'starts', 'markers', 'headings', 'tables', 'codeBlocks', 'words', 'characters'] as const)
            eq(result[field], fresh[field], `result ${field}`);
        const imageFields = (r: HighlightResult<Gtk.TextTag>) => r.images.map(img => [img.line, img.url, img.alt]);
        eq(imageFields(result), imageFields(fresh), 'result of images');
        for (const name of SYNTAX_TAGS)
            eq(tagRanges(buffer, tags[name]), tagRanges(reference, refTags[name]), `tag ${name}`);
    };
    test('changes to fences, tables, emoji, and several edits before a flush stay equivalent', () => {
        reset('# Start\n\nparagraph **bold** 😀\n\nA | B\n-- | --\nx | y\n\n```js\nconst x = 1;\n```\n\nend');
        const insert = (line: number, value: string) => { buffer.insert(iterAtLine(buffer, line), value, -1); check(flush()); };
        insert(2, '```\n');
        insert(7, '```\n');
        insert(0, '🎉\n');
        buffer.delete(iterAtLine(buffer, 1), iterAtLine(buffer, 4)); check(flush());
        buffer.insert(buffer.get_start_iter(), 'new\n', -1);
        buffer.insert(buffer.get_end_iter(), '\n![image](a.png)', -1); check(flush());
        reset('A | B\nx | y\nakhir');
        insert(1, '-- | --\n');  // a new separator turns the previous line into a table header
        reset('text\n```\na\n\nb\n\nc\n```\nend');
        buffer.delete(iterAtLine(buffer, 1), iterAtLine(buffer, 2)); check(flush());
    });
    test('200 sequences of random edits equal a full parse', () => {
        reset('# Title\n\n**bold** and `code` 🎉\n\nA | B\n-- | --\nx | y\n\n```ts\nconst x = 1;\n```\n\nend\n');
        let seed = 17;
        const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
        const pieces = ['x', '\n', '**', '```\n', '~~~\n', '| a |', '# ', '> ', '😀', '\n\n', '![g](a.png)'];
        for (let round = 0; round < 200; round++) {
            for (let i = 0; i < 1 + rand(4); i++) {
                const at = buffer.get_iter_at_offset(rand(buffer.get_char_count() + 1));
                if (rand(3) === 0) {
                    const to = at.copy(); to.forward_chars(1 + rand(20)); buffer.delete(at, to);
                } else buffer.insert(at, pieces[rand(pieces.length)], -1);
            }
            check(flush());
        }
    });
    test('a single edit in 50,000 lines only parses its neighbors without reading the full buffer', () => {
        reset(Array.from({ length: 50000 }, (_, i) => `Paragraph ${i} with a different note.`).join('\n'));
        const read = buffer.get_text.bind(buffer);
        const reads: number[] = [];
        buffer.get_text = (a, b, hidden) => { reads.push(b.get_offset() - a.get_offset()); return read(a, b, hidden); };
        try {
            buffer.insert(iterAtLine(buffer, 25000), '😀 extra ', -1);
            const result = flush();
            ok(cache.parsedLines <= 4, `parsed ${cache.parsedLines} lines`);
            ok(reads.length === 1 && reads[0] < 100, `read range ${JSON.stringify(reads)}`);
            eq(result.characters, buffer.get_char_count(), 'character count');
            eq(result.words, (result.text.match(/[^\s#>*_`~=|-]+/g) ?? []).length, 'word count');
            flush(); eq(cache.parsedLines, 0, 'without edits it does not re-parse');
        } finally { buffer.get_text = read; }
    });
}
