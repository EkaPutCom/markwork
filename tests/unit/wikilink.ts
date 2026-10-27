// Tests for Obsidian-style [[note]] links: parsing, file lookup, name suggestions, inline highlighting, and HTML export.

import { section, test, eq, ok, contains } from '../core/framework';
import { newNotePath, noteSection, parseWikiLink, wikiLinksIn, resolveWikiLink, suggestNotes, wikiQuery, wikiTargetFor } from '../../src/markdown/wikilink';
import { parseInline } from '../../src/markdown/inline';
import { body } from './helpers';

const FILES = ['Idea.md', 'Journal/Daily Note.md', 'Journal/Idea.md', 'project/book-plan.md', 'project/sub/Chapter 1.markdown', 'image.png'];

export function wikiLinkTests(): void {
    section('[[note]] links');
    test('the [[...]] contents are parsed into target, section, and alias', () => {
        eq(parseWikiLink('Note'), { target: 'Note', heading: '', alias: '' });
        eq(parseWikiLink('Journal/Idea#Section Two|see idea'), { target: 'Journal/Idea', heading: 'Section Two', alias: 'see idea' });
        eq(parseWikiLink('#Intro'), { target: '', heading: 'Intro', alias: '' });
    });
    test('the target is looked up by file name without extension and case-insensitively', () => {
        eq(resolveWikiLink('daily note', FILES, null), 'Journal/Daily Note.md');
        eq(resolveWikiLink('Chapter 1', FILES, null), 'project/sub/Chapter 1.markdown');
        eq(resolveWikiLink('book-plan.md', FILES, null), 'project/book-plan.md');
        eq(resolveWikiLink('nonexistent', FILES, null), null);
        eq(resolveWikiLink('image', FILES, null), null, 'not a Markdown file');
    });
    test('duplicate names: the folder of the source document wins, then the shortest path; a target with a folder is matched against the end of the path', () => {
        eq(resolveWikiLink('Idea', FILES, 'Journal/Daily Note.md'), 'Journal/Idea.md');
        eq(resolveWikiLink('Idea', FILES, 'project/book-plan.md'), 'Idea.md');
        eq(resolveWikiLink('Idea', FILES, null), 'Idea.md');
        eq(resolveWikiLink('journal/idea', FILES, null), 'Journal/Idea.md');
        eq(resolveWikiLink('sub/Chapter 1', FILES, null), 'project/sub/Chapter 1.markdown');
    });
    test('a new note is created next to the source document; names that leave the folder or are hidden are rejected', () => {
        eq(newNotePath('New', 'Journal/Daily Note.md'), 'Journal/New.md');
        eq(newNotePath('New', null), 'New.md');
        eq(newNotePath('archive/Old', 'Journal/x.md'), 'archive/Old.md');
        eq(newNotePath('Chapter.markdown', null), 'Chapter.markdown');
        for (const bad of ['../outside', 'a/../b', '.secret', 'a//b', 'a:b', '  ']) eq(newNotePath(bad, null), null, bad);
    });
    test('a suggestion uses the short name if unique, the path if duplicate', () => {
        eq(wikiTargetFor('Journal/Daily Note.md', FILES), 'Daily Note');
        eq(wikiTargetFor('Journal/Idea.md', FILES), 'Journal/Idea');
    });
    test('text being typed after [[ is recognized; a closed [[, alias, section, and code are not', () => {
        eq(wikiQuery('see [[no'), 'no');
        eq(wikiQuery('see [['), '');
        eq(wikiQuery('see [[a]] then'), null);
        eq(wikiQuery('[[a|text'), null);
        eq(wikiQuery('[[a#bag'), null);
        eq(wikiQuery('`code [[x'), null);
        eq(wikiQuery('no link'), null);
    });
    test('suggestions: name prefix first, word prefix, then a path fragment; non-Markdown files are skipped', () => {
        eq(suggestNotes('idea', FILES), ['Idea.md', 'Journal/Idea.md']);
        eq(suggestNotes('dai', FILES), ['Journal/Daily Note.md']);
        eq(suggestNotes('journal', FILES), ['Journal/Daily Note.md', 'Journal/Idea.md']);
        eq(suggestNotes('', FILES).length, 5);
        eq(suggestNotes('', FILES, 2).length, 2, 'count limit');
        eq(suggestNotes('zzz', FILES), []);
    });
    test('highlighting: only the name or alias becomes the link, the brackets and the alias target are hidden', () => {
        const r = parseInline('a [[Note]] b');
        ok(r.tags.some(([n, s, e]) => n === 'link' && s === 4 && e === 8), JSON.stringify(r.tags));
        eq(r.marks, [[2, 4], [8, 10]]);
        const alias = parseInline('[[Journal/Idea|old idea]]');
        ok(alias.tags.some(([n, s, e]) => n === 'link' && s === 15 && e === 23), JSON.stringify(alias.tags));
        eq(alias.marks, [[0, 15], [23, 25]]);
    });
    test('highlighting: empty [[ ]], inline code, and link contents are not formatted again', () => {
        eq(parseInline('[[ ]]').tags, []);
        ok(!parseInline('`[[x]]`').tags.some(([n]) => n === 'link'), 'a link inside code');
        ok(!parseInline('[[file_name_here]]').tags.some(([n]) => n === 'italic'), 'underscore became italic');
        eq(parseInline('- [ ] task').tags, [], 'task box');
    });
    test('HTML export: [[note]] becomes a link to a .md file', () => {
        contains(body('see [[Daily Note]]'), '<a class="wikilink" href="Daily%20Note.md">Daily Note</a>');
        contains(body('[[Journal/Idea#Section Two|idea]]'), '<a class="wikilink" href="Journal/Idea.md#section-two">idea</a>');
        contains(body('[[#Intro]]'), '<a class="wikilink" href="#intro">Intro</a>');
        contains(body('[[a<b]]'), '>a&lt;b</a>');
        contains(body('`[[x]]`'), '<code>[[x]]</code>');
    });
    test('wikiLinksIn: in order of appearance, without duplicates, inline code skipped', () => {
        eq(wikiLinksIn('[[A]] `[[B]]` [[a]] [[A#x]] [[C|c]]').map(l => `${l.target}#${l.heading}`), ['A#', 'A#x', 'C#']);
    });
    test('noteSection takes the part up to the next heading of the same level, skipping code blocks', () => {
        const doc = '# Title\n\n## Color\n\nblue\n\n```\n# not a heading\n```\n\n### Sub\n\ncontent\n\n## Other\n\nx';
        eq(noteSection(doc, 'color'), '## Color\n\nblue\n\n```\n# not a heading\n```\n\n### Sub\n\ncontent');
        eq(noteSection(doc, 'Other'), '## Other\n\nx');
        eq(noteSection(doc, 'nonexistent'), null);
    });
}
