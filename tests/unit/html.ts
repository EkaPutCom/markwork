// Markdown → HTML conversion tests.

import { section, test, eq, contains } from '../core/framework.js';
import { markdownToHtml } from '../../src/markdown/html.js';
import { body } from './helpers.js';

export function htmlTests(): void {
    section('Markdown → HTML');
    test('heading with an id', () => contains(body('## Hello World'), '<h2 id="hello-world">Hello World</h2>'));
    test('format inline', () => eq(body('**a** *b* `c` ~~d~~ ==e=='),
        '<p><strong>a</strong> <em>b</em> <code>c</code> <del>d</del> <mark>e</mark></p>'));
    test('links and images', () => {
        const h = body('[GTK](https://gtk.org/a_b) ![logo](img/x.png)');
        contains(h, '<a href="https://gtk.org/a_b">GTK</a>');
        contains(h, '<img src="img/x.png" alt="logo">');
    });
    test('HTML in a code block is escaped', () => eq(body('```html\n<b>&</b>\n```'),
        '<pre><code class="language-html">&lt;b&gt;&amp;&lt;/b&gt;</code></pre>'));
    test('a mermaid block becomes <pre class="mermaid"> and loads the Mermaid script', () => {
        const h = markdownToHtml('```mermaid\ngraph TD\n  A-->B\n```', 't');
        contains(h, '<pre class="mermaid">graph TD\n  A--&gt;B</pre>');
        contains(h, 'mermaid.esm.min.mjs');
    });
    test('a dbml block becomes a Mermaid ER diagram; invalid dbml stays a code block', () => {
        const h = markdownToHtml('```dbml\nTable a { id int [pk] }\n```', 't');
        contains(h, '<pre class="mermaid">erDiagram');
        contains(h, 'mermaid.esm.min.mjs');
        contains(body('```dbml\nTable a {\n```'), '<pre><code class="language-dbml">');
    });
    test('a document without mermaid does not load the Mermaid script', () => {
        eq(markdownToHtml('```js\nx\n```', 't').includes('mermaid.esm'), false, 'script loaded');
    });
    test('table', () => {
        const h = body('| A | B |\n|:--|--:|\n| 1 | 2 |');
        contains(h, '<th style="text-align:left">A</th>');
        contains(h, '<td style="text-align:right">2</td>');
    });
    test('task list', () => {
        const h = body('- [x] done\n- [ ] not yet');
        contains(h, '<input type="checkbox" disabled checked> done');
        contains(h, '<input type="checkbox" disabled> not yet');
    });
    test('nested list', () => contains(body('1. a\n   - b\n2. c'), '<li>a\n<ul>\n<li>b</li>\n</ul></li>'));
    test('numbered list starting from 3', () => contains(body('3. a\n4. b'), '<ol start="3">'));
    test('quote', () => eq(body('> hello\n> *world*'), '<blockquote>\n<p>hello\n<em>world</em></p>\n</blockquote>'));
    test('horizontal rule', () => eq(body('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>'));
    test('HTML characters in text are escaped', () => eq(body('a < b & "c"'), '<p>a &lt; b &amp; &quot;c&quot;</p>'));
    test('backslash escape', () => eq(body('\\*not italic\\*'), '<p>*not italic*</p>'));
    test('an escaped backtick is not code', () => eq(body('\\`not code\\`'), '<p>`not code`</p>'));
    test('a backslash inside code stays as is', () => eq(body('`C:\\*`'), '<p><code>C:\\*</code></p>'));
    test('a table without edge pipes', () => {
        const h = body('Name | Value\n--- | ---\nOne | 1');
        contains(h, '<th>Name</th><th>Value</th>');
        contains(h, '<td>One</td><td>1</td>');
    });
    test('"---" under pipe text is still a horizontal rule, not a table', () =>
        eq(body('a | b\n\n---'), '<p>a | b</p>\n<hr>'));
}
