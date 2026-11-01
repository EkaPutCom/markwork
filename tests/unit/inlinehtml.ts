// The HTML drawing of inline Markdown and of the assistant's answers, and the runs both Pango and HTML are drawn from.

import { inlineRuns } from '../../src/markdown/inlineruns';
import { cellHtml } from '../../src/markdown/inlinehtml';
import { chatBlocks } from '../../src/markdown/chatblocks';
import { chatHtml } from '../../src/markdown/chathtml';
import { NOTE_URI } from '../../src/markdown/inlineruns';
import { platform } from '../../src/platform/index';
import { section, test, eq, ok, contains, say } from '../core/framework';

export function inlineHtmlTests(): void {
    section('Inline runs and HTML');
    test('chat tables use shared GFM cells, alignment and safe inline formatting', () => {
        const html = chatHtml('| CVE | Risk | Score |\n| :--- | :---: | ---: |\n| **CVE-1** | escaped \\| pipe | `9.8` |');
        contains(html, '<table>'); contains(html, '<thead>'); contains(html, '<strong>CVE-1</strong>');
        contains(html, 'escaped | pipe'); contains(html, '<code>9.8</code>'); contains(html, 'md-align-center'); contains(html, 'md-align-right');
        ok(!html.includes(':---'), 'separator leaked');
        const unsafe = chatHtml('| Header |\n| --- |\n| <img src=x onerror=alert(1)> |');
        ok(!unsafe.includes('<img'), 'raw HTML executed'); contains(unsafe, '&lt;img');
    });
    test('streamed table prefixes stay readable until the separator completes and code pipes stay code', () => {
        ok(!chatHtml('| A | B |\n| ').includes('<table>'), 'premature table');
        contains(chatHtml('| A | B |\n| --- | --- |'), '<table>');
        const code = chatHtml('````md\n| A | B |\n| --- | --- |\n```\nstill code\n````\nafter');
        ok(!code.includes('<table>'), 'fenced table rendered'); contains(code, '```\nstill code'); contains(code, '<p class="md-line">after</p>');
    });
    test('chat preserves numbered and task markers and recognizes rules before bullets', () => {
        const html = chatHtml('3. Third\n4) Fourth\n- [x] Done\n- [ ] Pending\n- - -');
        contains(html, 'data-marker="3."'); contains(html, 'data-marker="4)"');
        contains(html, 'data-marker="☑"'); contains(html, 'data-marker="☐"'); contains(html, '<hr');
    });
    test('chat table render baseline: 200 research rows, 3 warmups and 20 samples', () => {
        const text = '| CVE | Risk | Source |\n| --- | --- | --- |\n' + Array.from({ length: 200 }, (_, i) => `| **CVE-${i}** | High risk with \\| escaped pipe | https://example.com/${i} |`).join('\n');
        const times: number[] = [];
        for (let i = 0; i < 23; i++) {
            const start = platform().monotonicMs(), html = chatHtml(text);
            if (i >= 3) times.push(platform().monotonicMs() - start);
            eq((html.match(/<tr>/g) || []).length, 201);
        }
        times.sort((a, b) => a - b);
        say('  Chat table baseline (200 rows, ms): ' + JSON.stringify({ median: times[10], p95: times[18], max: times[19] }));
    });

    test('inlineRuns: markers are dropped and styles merged (bold inside italic)', () => {
        eq(inlineRuns('a **b** *c **d***'), [
            { text: 'a ', styles: [] },
            { text: 'b', styles: ['bold'] },
            { text: ' ', styles: [] },
            { text: 'c ', styles: ['italic'] },
            { text: 'd', styles: ['bold', 'italic'] },
        ]);
    });

    test('inlineRuns: a [[note]] is a run of its own only when links are asked for', () => {
        const runs = inlineRuns('see [[Spec#Color|color]] now', true);
        eq(runs.map(r => [r.text, r.note]), [['see ', undefined], ['color', 'Spec#Color|color'], [' now', undefined]]);
        ok(inlineRuns('see [[Spec]] now').every(r => r.note === undefined), 'a note without the option');
    });

    test('cellHtml: styles become elements, text is escaped', () => {
        eq(cellHtml('**bold** & <b>'), '<strong>bold</strong> &amp; &lt;b&gt;');
        eq(cellHtml('a ~~x~~ ==y== `k<1`'), 'a <s>x</s> <mark>y</mark> <code>k&lt;1</code>');
        eq(cellHtml('[link](http://x.y)'), '<span class="md-link">link</span>');
        eq(cellHtml('***both***'), '<strong><em>both</em></strong>');
        eq(cellHtml('a \\| b'), 'a | b');
    });

    test('cellHtml: no markup in the text reaches the page as a tag or an attribute', () => {
        const html = cellHtml('<img src=x onerror=alert(1)> "q" \'s\'');
        ok(!html.includes('<img'), html);
        contains(html, '&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;s&#39;');
        const note = cellHtml('[[a"b onmouseover=x]]', true);
        ok(!/"b onmouseover/.test(note), note);
    });

    test('cellHtml: [[note]] becomes a link with the note URI, and not inside code', () => {
        eq(cellHtml('[[Spec#Color|color]]', true), `<a class="md-note" href="${NOTE_URI}Spec%23Color%7Ccolor"><span class="md-link">color</span></a>`);
        ok(!cellHtml('[[Spec]]').includes('<a '), 'without the option');
        ok(!cellHtml('`[[Spec]]`', true).includes('<a '), 'inside code');
    });

    section('Assistant answers as blocks and HTML');

    test('chatBlocks: one block per line, fences dropped', () => {
        eq(chatBlocks('## T\n- a\n  - b\n> q\n---\n```\nx\n```\nplain'), [
            { kind: 'heading', level: 2, text: 'T' },
            { kind: 'bullet', depth: 0, text: 'a' },
            { kind: 'bullet', depth: 1, text: 'b' },
            { kind: 'quote', text: 'q' },
            { kind: 'rule' },
            { kind: 'code', text: 'x' },
            { kind: 'text', text: 'plain' },
        ]);
    });

    test('chatHtml: heading, list, quote, one <pre> for consecutive code lines, all escaped', () => {
        const html = chatHtml('## Title\n- one **bold**\n> quote\n```ts\nconst a = 1 < 2;\nb();\n```\nend');
        contains(html, '<div class="md-heading md-h2">Title</div>');
        contains(html, '<div class="md-bullet" data-depth="0">one <strong>bold</strong></div>');
        contains(html, '<blockquote class="md-quote">quote</blockquote>');
        contains(html, '<pre class="md-code">const a = 1 &lt; 2;\nb();</pre>');
        contains(html, '<p class="md-line">end</p>');
        ok(!html.includes('```'), 'the fence was shown');
    });

    test('chatHtml tolerates truncated text (an unclosed code block, an unpaired bold marker)', () => {
        const html = chatHtml('Text **bold not yet\n```\ncode <b>');
        contains(html, '<pre class="md-code">code &lt;b&gt;</pre>');
        ok(!/<b>/.test(html), 'a raw tag slipped through');
    });
}
