// Blurring a text for a report of a problem with the editor (markdown/blur.ts).

import { ROOT, section, test, eq, ok, disk } from '../core/framework.js';
import { blurText } from '../../src/markdown/blur.js';

export function blurTests(): void {
    section('Blurring a report');
    test('letters become x or X and digits 0; spaces and punctuation stay', () => {
        eq(blurText('Kita rilis Jumat, 25 Oktober.'), 'Xxxx xxxxx Xxxxx, 00 Xxxxxxx.');
    });
    test('the Markdown stays: headings, emphasis, lists, tasks, quotes, code fences, and tables', () => {
        eq(blurText('# Plan 2026\n'), '# Xxxx 0000\n');
        eq(blurText('Some **bold** and *it* ~~old~~ ==new== `code`'), 'Xxxx **xxxx** xxx *xx* ~~xxx~~ ==xxx== `xxxx`');
        eq(blurText('- [x] Done\n- [ ] Todo\n12. Twelve\n> Quote\n  > Inner'), '- [x] Xxxx\n- [ ] Xxxx\n12. Xxxxxx\n> Xxxxx\n  > Xxxxx');
        eq(blurText('| Name | Qty |\n| --- | ---: |\n| Tea | 12 |'), '| Xxxx | Xxx |\n| --- | ---: |\n| Xxx | 00 |');
    });
    test('a code block keeps its fences and language; its lines are text, even one that looks like a list', () => {
        eq(blurText('```mermaid\ngraph TD\n- not a list\n```\n'), '```mermaid\nxxxxx XX\n- xxx x xxxx\n```\n');
    });
    test('a link keeps its brackets and scheme; its words and address are blurred; a picture keeps its markup', () => {
        eq(blurText('[Docs](https://example.com/a?b=1)'), '[Xxxx](https://xxxxxxx.xxx/x?x=0)');
        eq(blurText('![Cat](cat.png)'), '![Xxx](xxx.xxx)');
        eq(blurText('See [[Daily Note]] and [[README#Features|the features]]'), 'Xxx [[Xxxxx Xxxx]] xxx [[XXXXXX#Xxxxxxxx|xxx xxxxxxxx]]');
    });
    test('a field keeps its key, so it is still drawn as a field', () => {
        eq(blurText('Task [due:: 2026-10-01] [owner:: Ana]'), 'Xxxx [due:: 0000-00-00] [owner:: Xxx]');
    });
    test('emoji and other scripts stay as they are; accented Latin letters are blurred', () => {
        eq(blurText('Привет 日本語 🎉 naïve Ünï'), 'Привет 日本語 🎉 xxxxx Xxx');
    });
    test('the length in UTF-16 units stays, so every offset of a repro still holds', () => {
        const text = disk.read(disk.join(ROOT, 'tests', 'samples', 'all-formats.md'));
        const blurred = blurText(text);
        eq(blurred.length, text.length);
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n' || text[i] === ' ') ok(blurred[i] === text[i], `${i} keeps its ${JSON.stringify(text[i])}`);
        }
        // What may keep its letters and digits: list numbers, fences with their language, schemes, and field keys.
        const syntax = /^[ \t>]*\d+[.)]|^[ \t>]*(`{3,}|~{3,})\w*|\b[a-z]+:\/\/|\[[\w-]+::/gm;
        eq(blurred.replace(syntax, '').match(/[a-wyzA-WYZ1-9]/g), null, 'no letter or digit is left outside the syntax');
    });
}
