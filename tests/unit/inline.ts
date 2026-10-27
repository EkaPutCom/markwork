// parseInline tests.

import { makeCpMap, cpLength, countWords } from '../../src/markdown/offsets';
import { parseInline } from '../../src/markdown/inline';
import { section, test, eq, ok } from '../core/framework';

export function inlineTests(): void {
    section('parseInline');
    test('bold produces a tag and markers', () => {
        const r = parseInline('a **b** c');
        ok(r.tags.some(([n, s, e]) => n === 'bold' && s === 4 && e === 5), JSON.stringify(r.tags));
        eq(r.marks, [[2, 4], [5, 7]], 'marker');
    });
    test('an escaped backtick does not become code', () => {
        const r = parseInline('\\`a\\`');
        ok(!r.tags.some(([n]) => n === 'code'), JSON.stringify(r.tags));
        eq(r.marks, [[0, 1], [3, 4]], 'marker backslash');
    });
    test('inline code contents are not formatted', () => {
        const r = parseInline('`**x**`');
        ok(!r.tags.some(([n]) => n === 'bold'), 'bold inside code');
        ok(r.tags.some(([n]) => n === 'code'), 'no code tag');
    });
    test('images are collected with their url without the title', () => {
        const r = parseInline('a ![x y](img/a.png "Title") b ![](c.jpg)');
        eq(r.images.map(i => [i.alt, i.url, i.start, i.end]), [['x y', 'img/a.png', 2, 27], ['', 'c.jpg', 30, 40]]);
    });
    test('an underscore in a link URL does not become italic', () => {
        const r = parseInline('[x](http://a.com/a_b_c)');
        ok(!r.tags.some(([n]) => n === 'italic'), JSON.stringify(r.tags));
    });
    test('snake_case does not become italic', () => {
        ok(!parseInline('variable_name_here').tags.some(([n]) => n === 'italic'), 'became italic');
    });
    test('staged masking keeps mixed code, links, and emphasis intact', () => {
        const r = parseInline('`**code**` [**title**](https://a_b.test) <https://c_d.test> https://e_f.test **bold** *italic* ~~delete~~ ==highlight==');
        const count = (name: string) => r.tags.filter(([n]) => n === name).length;
        eq([count('code'), count('link'), count('bold'), count('italic'), count('strike'), count('mark')], [1, 3, 2, 1, 1, 1]);
        ok(!r.tags.some(([n, a, b]) => n === 'bold' && a < 10 && b < 10), 'code contents became bold');
    });
    test('a long line without syntax and Unicode counts stay correct', () => {
        eq(parseInline('plain notes '.repeat(10000)), { tags: [], marks: [], images: [] });
        eq(cpLength('abc🎉é'), 6, 'code point count');
        eq(cpLength('x'.repeat(10000)), 10000, 'text without surrogates');
    });
    test('makeCpMap counts an emoji as one character', () => {
        const map = makeCpMap('🎉ab');
        eq([map(0), map(2), map(3), map(4)], [0, 1, 2, 3]);
    });
    test('countWords equals the word separator regex', () => {
        const words = (s: string) => (s.match(/[^\s#>*_`~=|-]+/g) ?? []).length;
        const pieces = ['word', ' ', '\t', '\n', '\u00a0', '\u2003', '\u3000', '\ufeff', '\u2028', '#', '>', '*', '_', '`', '~', '=', '|', '-', 'é', '🎉', '“', '1.', '[x]'];
        let seed = 7;
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let n = 0; n < 500; n++) {
            const s = Array.from({ length: Math.floor(random() * 30) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
            eq(countWords(s), words(s), JSON.stringify(s));
        }
        eq(countWords(''), 0, 'empty string');
    });
}
