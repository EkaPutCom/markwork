// GUI tests: The sample document with all formats (tests/samples/all-formats.md).

import { type TagName } from '../../src/editor/tags.js';
import { readTextFile } from '../../src/files.js';
import { markdownToHtml } from '../../src/markdown/html.js';
import { section, test, eq, ok, contains } from '../framework.js';
import type { GuiContext } from './context.js';

export function sampleTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, cursorTo, tagAt, samplePath } = c;

    section('Sample document with all formats (tests/samples/all-formats.md)');
    const offsetOf = (needle: string) => {
        const t = text(), i = t.indexOf(needle);
        ok(i >= 0, `text ${JSON.stringify(needle)} not found`);
        return Array.from(t.slice(0, i)).length;
    };
    test('the file is opened and all headings enter the outline', () => {
        ok(w.load(samplePath), 'load() failed');
        pump();
        const names = ed.headings.map(h => h.text);
        for (const h of ['Markdown All-Formats Test', 'Heading 6', 'Heading with closing marks', '15. Tricky cases'])
            ok(names.includes(h), `heading "${h}" is missing`);
        ok(!names.some(n => n.includes('Seven hashes') || n.includes('No space')), 'text that is not a heading entered the outline');
    });
    test('inline formats get the right tag', () => {
        cursorTo(0);
        const cases: [string, TagName][] = [['bold with asterisks', 'bold'], ['italic with underscores', 'italic'], ['bold italic*', 'bolditalic'],
            ['struck through', 'strike'], ['highlighted', 'mark'], ['gjs -m markwork.js', 'code'], ['GTK](', 'link'], ['GTK logo', 'image']];
        for (const [needle, tag] of cases) ok(tagAt(offsetOf(needle) + 1, tag), `"${needle}" is not tagged ${tag}`);
    });
    test('tricky cases are not mis-formatted', () => {
        ok(!tagAt(offsetOf('case_like') + 2, 'italic'), 'snake_case became italic');
        ok(!tagAt(offsetOf('3 * 4') , 'italic'), '"2 * 3 * 4" became italic');
        ok(!tagAt(offsetOf('not code\\`') + 1, 'code'), 'an escaped backtick became code');
        ok(!tagAt(offsetOf('**not bold**`') + 3, 'bold'), 'inline code contents became bold');
        ok(!tagAt(offsetOf('this_file_name') + 6, 'italic'), 'a URL with underscores became italic');
    });
    test('tables with and without pipes at the edges are recognized', () => {
        ok(tagAt(offsetOf('| Left') + 2, 'tablehead'), 'table header with pipes');
        ok(tagAt(offsetOf('One | 1'), 'table'), 'table row without pipes at the edges');
        ok(tagAt(offsetOf('Name | Value'), 'tablehead'), 'table header without pipes at the edges');
    });
    test('a 4-backtick code block contains ``` inside it', () => {
        const inner = offsetOf('code\n```\n````') ;
        ok(tagAt(inner, 'codeblock'), 'the block contents are not tagged codeblock');
        ok(tagAt(offsetOf('Level three'), 'quote'), 'the nested quote is not tagged quote');
        ok(tagAt(offsetOf('Level three'), 'quote3'), 'the nested quote is not tagged quote3');
    });
    test('the cursor sweeps the whole sample document', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
    });
    test('HTML export of the complete sample document', () => {
        const h = markdownToHtml(readTextFile(samplePath), 't');
        for (const tag of ['<h6', '<strong><em>', '<del>', '<mark>', '<code>', '<a href=', '<img ', '<ol start="7">',
            'type="checkbox"', '<blockquote>\n<p>Level two', '<pre><code class="language-bash">', '<pre class="mermaid">', '<table>', '<hr>', '<br>'])
            contains(h, tag);
        eq((h.match(/<table>/g) || []).length, 3, 'number of tables');
        contains(h, '>a | b</td>');  // \\| inside a cell becomes |
    });
    buf.set_modified(false);
}
