// The syntax of a document as data (markdown/highlight.ts), with names for styles: what every editor applies, and the
// parse of an edited range compared with a full parse of the same text.

import { HighlightCache, highlightText, textLines, type HighlightResult, type Styles, type TextLines } from '../../src/markdown/highlight';
import { section, test, eq, ok } from '../core/framework';

// Each style is its own name.
const NAMES = new Proxy({}, { get: (_target, name) => name }) as Styles<string>;

const spansOf = (r: HighlightResult<string>, line: number) => r.spans[line].map(([name, a, b]) => `${name} ${a}-${b}`);
const markerRanges = (r: HighlightResult<string>) => r.markers.map(([a, b]) => [a, b]);

// A text that changes one edit at a time, with the lines each edit touched (current line numbers).
class EditedText {
    edited: [number, number] | null = null;
    constructor(public text: string) {}

    edit(at: number, remove: number, insert: string): void {
        this.text = this.text.slice(0, at) + insert + this.text.slice(at + remove);
        const lineAt = (offset: number) => this.text.slice(0, offset).split('\n').length - 1;
        const first = lineAt(at), last = lineAt(at + insert.length);
        this.edited = this.edited ? [Math.min(this.edited[0], first), Math.max(this.edited[1], last)] : [first, last];
    }

    // Lines before the edited ones keep their numbers; after an edit only the lines it touched are marked. That holds
    // for a single edit, so the tests flush after each one.
    take(): [number, number] | null {
        const edited = this.edited;
        this.edited = null;
        return edited;
    }
}

function sameAsFullParse(result: HighlightResult<string>, text: string): void {
    const fresh = highlightText(text, NAMES);
    for (const field of ['text', 'lines', 'starts', 'markers', 'headings', 'tables', 'codeBlocks', 'spans', 'words', 'characters'] as const)
        eq(result[field], fresh[field], `result ${field}`);
    // An image reused from an earlier parse has its fields in another order.
    const imageFields = (r: HighlightResult<string>) => r.images.map(img => [img.line, img.url, img.alt]);
    eq(imageFields(result), imageFields(fresh), 'result images');
}

export function highlightTests(): void {
    section('Syntax highlighting as data');
    test('a heading line gives the heading and bold styles and three markers that may be hidden', () => {
        const r = highlightText('## Judul **tebal**', NAMES);
        eq(spansOf(r, 0), ['h2 0-18', 'marker 0-3', 'bold 11-16', 'marker 9-11', 'marker 16-18']);
        eq(markerRanges(r), [[0, 3], [9, 11], [16, 18]]);
        eq(r.headings, [{ level: 2, text: 'Judul **tebal**', line: 0 }]);
    });
    test('the fences of a code block are active on every line of the block', () => {
        const r = highlightText('text\n```js\nconst x = 1;\n```\nend', NAMES);
        eq(r.codeBlocks, [{ lang: 'js', start: 11, text: 'const x = 1;', startLine: 1, endLine: 3, closed: true }]);
        eq(r.markers.map(([, , first, last]) => [first, last]), [[1, 3], [1, 3]]);
        ok(spansOf(r, 2).includes('codeblock 0-13'), JSON.stringify(spansOf(r, 2)));
        eq(spansOf(r, 4), []);
    });
    test('offsets are code points, so an emoji counts once', () => {
        const r = highlightText('😀 **b**', NAMES);
        ok(spansOf(r, 0).includes('bold 4-5'), JSON.stringify(spansOf(r, 0)));
        eq(r.characters, 7);
    });
    test('the editor\'s hanging indent covers a list item line, outside a quote', () => {
        const indent = { tag: (indent: string, marker: string, _gap: string, task: string) => `hang:${indent}${marker}${task}` };
        const r = highlightText('- item\n  1. [x] done\n> - quoted', NAMES, indent);
        ok(spansOf(r, 0).includes('hang:- 0-6'), JSON.stringify(spansOf(r, 0)));
        ok(spansOf(r, 1).includes('hang:  1.[x] 0-13'), JSON.stringify(spansOf(r, 1)));
        ok(!spansOf(r, 2).some(s => s.startsWith('hang:')), JSON.stringify(spansOf(r, 2)));
    });
    test('fences, tables, and emoji edited one at a time stay equal to a full parse', () => {
        const doc = new EditedText('# Start\n\nparagraph **bold** 😀\n\nA | B\n-- | --\nx | y\n\n```js\nconst x = 1;\n```\n\nend');
        const cache = new HighlightCache(NAMES);
        cache.update(textLines(doc.text));
        const lineStart = (line: number) => doc.text.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0);
        for (const [line, insert] of [[2, '```\n'], [7, '```\n'], [0, '🎉\n'], [5, '-- | --\n']] as const) {
            doc.edit(lineStart(line), 0, insert);
            sameAsFullParse(cache.update(textLines(doc.text), doc.take()), doc.text);
        }
        doc.edit(lineStart(1), lineStart(4) - lineStart(1), '');
        sameAsFullParse(cache.update(textLines(doc.text), doc.take()), doc.text);
    });
    test('300 random edits equal a full parse', () => {
        const doc = new EditedText('# Title\n\n**bold** and `code` 🎉\n\nA | B\n-- | --\nx | y\n\n```ts\nconst x = 1;\n```\n\nend\n');
        const cache = new HighlightCache(NAMES);
        cache.update(textLines(doc.text));
        let seed = 23;
        const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
        const pieces = ['x', '\n', '**', '```\n', '~~~\n', '| a |', '# ', '> ', '- [ ] ', '😀', '\n\n', '![g](a.png)'];
        for (let round = 0; round < 300; round++) {
            let at = rand(doc.text.length + 1);
            if (at > 0 && /[\uDC00-\uDFFF]/.test(doc.text[at])) at--;   // not inside an emoji
            if (rand(3) === 0) {
                let end = Math.min(doc.text.length, at + 1 + rand(20));
                if (/[\uDC00-\uDFFF]/.test(doc.text[end] ?? '')) end++;
                doc.edit(at, end - at, '');
            } else doc.edit(at, 0, pieces[rand(pieces.length)]);
            sameAsFullParse(cache.update(textLines(doc.text), doc.take()), doc.text);
        }
    });
    test('a single edit in 50,000 lines reads and parses only its neighbors', () => {
        const lines = Array.from({ length: 50000 }, (_, i) => `Paragraph ${i} with a different note.`);
        const cache = new HighlightCache(NAMES);
        cache.update(textLines(lines.join('\n')));
        lines[25000] = `😀 extra ${lines[25000]}`;
        const reads: number[] = [];
        const source: TextLines = {
            lineCount: lines.length,
            all: () => { throw new Error('read the whole text'); },
            lines: (first, last) => { reads.push(last - first + 1); return lines.slice(first, last + 1); },
        };
        const result = cache.update(source, [25000, 25000]);
        ok(cache.parsedLines <= 4, `parsed ${cache.parsedLines} lines`);
        eq(reads, [1], 'lines read');
        eq(result.words, lines.join('\n').match(/[^\s#>*_`~=|-]+/g)!.length, 'word count');
        cache.update(source, null);
        eq(cache.parsedLines, 0, 'without edits it does not parse again');
    });
}
