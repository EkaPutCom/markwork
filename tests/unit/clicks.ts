// Tests for what a click on a line means (markdown/clicks.ts), which diagram a code block is (markdown/diagram.ts), and
// where an image comes from (markdown/imagesource.ts). Columns are in code points.

import { section, test, eq } from '../core/framework';
import { linkAt, taskToggleAt, wikiLinkAt } from '../../src/markdown/clicks';
import { diagramKind } from '../../src/markdown/diagram';
import { imageSource, type PathOps } from '../../src/markdown/imagesource';
import type { CodeBlock } from '../../src/markdown/highlight';

const POSIX: PathOps = { isAbsolute: p => p.startsWith('/'), join: (...parts) => parts.join('/') };
const block = (lang: string, text: string, closed = true): CodeBlock => ({ lang, text, closed, start: 0, startLine: 0, endLine: 2 });

export function clickTests(): void {
    section('Clicks on text, diagrams, and image sources (pure)');
    test('taskToggleAt: flips the box under the click, else null', () => {
        eq(taskToggleAt('- [ ] buy milk', 3), { column: 3, text: 'x' }, 'inside an open box');
        eq(taskToggleAt('- [x] done', 2), { column: 3, text: ' ' }, 'on the opening bracket');
        eq(taskToggleAt('- [X] done', 4), { column: 3, text: ' ' }, 'capital X counts as checked');
        eq(taskToggleAt('- no box here', 3), null, 'no box');
        eq(taskToggleAt('- [link](x)', 3), null, 'a link bracket is not a box');
    });
    test('taskToggleAt: the column is in code points after an emoji', () => {
        eq(taskToggleAt('🎉 [ ] party', 3), { column: 3, text: 'x' });
    });
    test('linkAt: Markdown link, image, autolink, bare URL', () => {
        eq(linkAt('see [docs](https://a.example/x "title") now', 6), 'https://a.example/x', 'link text');
        eq(linkAt('![alt](pic.png)', 1), 'pic.png', 'image');
        eq(linkAt('mail <mailto:me@example.com>', 8), 'mailto:me@example.com', 'autolink');
        eq(linkAt('go to https://example.com/a. Then', 10), 'https://example.com/a', 'bare URL without the trailing dot');
        eq(linkAt('plain text', 3), null, 'nothing');
        eq(linkAt('🎉 https://e.example', 3), 'https://e.example', 'code-point column after an emoji');
    });
    test('wikiLinkAt: target and label at the click, else null', () => {
        eq(wikiLinkAt('read [[Plans|the plan]] today', 8)?.target, 'Plans');
        eq(wikiLinkAt('read [[Plans]] today', 1), null, 'outside the link');
    });
    test('diagramKind: mermaid and dbml, any case; empty or unclosed is not a diagram', () => {
        eq(diagramKind(block('mermaid', 'graph TD; A-->B')), 'mermaid');
        eq(diagramKind(block('DBML', 'Table users {}')), 'dbml');
        eq(diagramKind(block('js', 'x')), null, 'other language');
        eq(diagramKind(block('mermaid', '  \n')), null, 'empty');
        eq(diagramKind(block('mermaid', 'graph TD', false)), null, 'unclosed');
    });
    test('imageSource: URL kept, absolute path kept, relative path decoded and joined', () => {
        eq(imageSource('https://e.example/a%20b.png', '/doc', POSIX), { kind: 'url', url: 'https://e.example/a%20b.png' });
        eq(imageSource('data:image/png;base64,AA', '/doc', POSIX), { kind: 'url', url: 'data:image/png;base64,AA' });
        eq(imageSource('/img/a%20b.png', '/doc', POSIX), { kind: 'path', path: '/img/a%20b.png' }, 'absolute is not decoded');
        eq(imageSource('img/a%20b.png', '/doc', POSIX), { kind: 'path', path: '/doc/img/a b.png' });
    });
}
