// Tests for search and replace across documents.

import { section, test, eq, ok } from '../framework.js';
import { activeFilters, buildPattern, pathFilter, replaceMatches, searchFiles, type SearchOptions } from '../../src/markdown/search.js';

const plain: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };
const pattern = (query: string, options: Partial<SearchOptions> = {}): RegExp => {
    const p = buildPattern(query, { ...plain, ...options });
    if (!(p instanceof RegExp)) throw new Error('no pattern');
    return p;
};

export function searchTests(): void {
    section('Search across documents');
    test('an empty query has no pattern, an invalid regular expression an error', () => {
        eq(buildPattern('', plain), null);
        const bad = buildPattern('(', { ...plain, regex: true });
        ok(bad !== null && 'error' in bad, 'an unclosed group is an error');
        ok(buildPattern('(', plain) instanceof RegExp, 'without regex the parenthesis is literal text');
    });
    test('hits carry the line, the offsets, and the text around the match', () => {
        const r = searchFiles([{ name: 'a.md', text: '# Title\n  hello Markwork and sari\nnothing' }], pattern('markwork'));
        eq(r.total, 1);
        eq(r.files[0].hits[0], { line: 1, start: 8, end: 16, before: 'hello ', match: 'Markwork', after: ' and sari' });
    });
    test('case, whole words, and regex options', () => {
        const files = [{ name: 'a.md', text: 'cat concat Cat\ncat.' }];
        eq(searchFiles(files, pattern('cat')).total, 4);
        eq(searchFiles(files, pattern('cat', { caseSensitive: true })).total, 3);
        eq(searchFiles(files, pattern('cat', { wholeWord: true })).total, 3);
        eq(searchFiles(files, pattern('c.t', { regex: true })).total, 4);
        eq(searchFiles(files, pattern('c.t')).total, 0, 'the dot is literal without regex');
    });
    test('files without a match are left out, and the list stops at the limit', () => {
        const files = [{ name: 'a.md', text: 'x x x' }, { name: 'b.md', text: 'none' }, { name: 'c.md', text: 'x' }];
        const all = searchFiles(files, pattern('x'));
        eq(all.files.map(f => f.file), ['a.md', 'c.md']);
        const cut = searchFiles(files, pattern('x'), 2);
        eq([cut.total, cut.truncated, cut.files.length], [2, true, 1]);
    });
    test('a long line is cut around the match and an empty match is skipped', () => {
        const line = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`;
        const hit = searchFiles([{ name: 'a.md', text: line }], pattern('needle')).files[0].hits[0];
        ok(hit.before.startsWith('…') && hit.after.endsWith('…'), 'both sides are cut');
        eq(searchFiles([{ name: 'a.md', text: 'abc' }], pattern('x*', { regex: true })).total, 0);
    });
    test('replacing: literal text, regex groups, and the line endings stay', () => {
        eq(replaceMatches('foo Foo\r\nfoo', pattern('foo'), '$1x', false), { text: '$1x $1x\r\n$1x', count: 3 });
        eq(replaceMatches('2026-10-14', pattern('(\\d+)-(\\d+)-(\\d+)', { regex: true }), '$3/$2/$1', true), { text: '14/10/2026', count: 1 });
        eq(replaceMatches('ab', pattern('(?<x>a)', { regex: true }), '[$<x>$&$$]', true).text, '[aa$]b');
    });
}

export function searchFilterTests(): void {
    section('Files to include and exclude');
    test('no patterns means no filter; a name matches a file or folder at any depth', () => {
        eq(pathFilter('', ' , '), null);
        const only = pathFilter('README.md, drafts', '')!;
        eq(['README.md', 'docs/README.md', 'drafts/a.md', 'x/drafts/b.md', 'readme.md', 'notes.md'].map(only), [true, true, true, true, true, false]);
    });
    test('a pattern with a slash is anchored; * stays in a folder and ** crosses folders', () => {
        const f = pathFilter('agenda/**, notes/*.md', '')!;
        eq(['agenda/a.md', 'agenda/sub/b.md', 'notes/c.md', 'notes/sub/d.md', 'x/agenda/e.md'].map(f), [true, true, true, false, false]);
        eq(['a.md', 'sub/b.md', 'c.txt'].map(pathFilter('*.md', '')!), [true, true, false]);
    });
    test('excluding wins over including, and a folder pattern covers its contents', () => {
        const f = pathFilter('**', 'drafts/**, *.tmp.md')!;
        eq(['a.md', 'drafts/b.md', 'drafts/x/c.md', 'd.tmp.md', 'sub/e.tmp.md'].map(f), [true, false, false, false, false]);
        eq(['drafts/b.md', 'a.md'].map(pathFilter('', 'drafts/')!), [false, true]);
    });
    test('the fields that hold a pattern are counted', () => {
        eq([activeFilters('', ''), activeFilters('a', ''), activeFilters(' , ', 'b')], [0, 1, 1]);
        eq(activeFilters('a', 'b'), 2);
    });
}
