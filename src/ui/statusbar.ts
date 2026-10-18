// Status bar below the editor.
//   left:  active mode
//   right: word/character counts and cursor position

import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';

import { cpLength, countWords } from '../markdown/offsets.js';
import { uiTemplate } from '../gtkutil.js';
import template from './statusbar.ui?raw';
import { _, fmt, ngettext } from '../i18n.js';

export class StatusBar extends Gtk.Box {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkStatusBar',
            Template: uiTemplate(template),
            InternalChildren: ['left', 'right'],
        }, this);
    }
    declare _left: Gtk.Label;
    declare _right: Gtk.Label;

    private counts = '';
    private cursorText = '';
    private modes = '';

    get left(): Gtk.Label { return this._left; }
    get right(): Gtk.Label { return this._right; }

    setCounts(text: string): void {
        // Markdown symbols are not counted as words.
        const words = countWords(text);
        this.setDocumentCounts(words, cpLength(text));
    }

    setDocumentCounts(words: number, characters: number): void {
        this.counts = `${words} words   ${characters} characters`;
        this.render();
    }

    // Kanban board summary; replaces the word count and cursor position while the board is shown.
    setBoardCounts(lists: number, cards: number): void {
        this.counts = `${lists} lists · ${cards} cards`;
        this.cursorText = '';
        this.render();
    }

    // Inbox summary while the inbox is shown.
    setInboxCounts(items: number): void {
        this.counts = fmt(ngettext('{n} note', '{n} notes', items), { n: items });
        this.cursorText = '';
        this.render();
    }

    // CSV table summary while the CSV tab is shown (the header is not counted as a row).
    setCsvCounts(rows: number, columns: number): void {
        this.counts = fmt(ngettext('{n} row', '{n} rows', rows), { n: rows }) + ' · ' + fmt(ngettext('{n} column', '{n} columns', columns), { n: columns });
        this.cursorText = '';
        this.render();
    }

    setCursor(line: number, column: number): void {
        this.cursorText = fmt(_('Line {line}, Column {column}'), { line: line + 1, column: column + 1 });
        this.render();
    }

    setModes(names: string[]): void {
        this.modes = names.length ? fmt(_('Mode: {modes}'), { modes: names.join(' · ') }) : '';
        this.left.label = this.modes;
    }

    private render(): void {
        this.right.label = `${this.counts}   ${this.cursorText}`;
    }
}
