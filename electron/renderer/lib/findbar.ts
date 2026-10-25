// The find bar of the editor (Ctrl+F, Ctrl+H), drawn as the GTK window's was: ▸ unfolds the Replace row; the Find field
// has its icon and the Aa / ab / .* toggles inside it, the Replace field its Replace and All buttons; then ↑ ↓ joined,
// the count of results, and Close. CodeMirror's search state keeps the query; this panel only shows and changes it.

import { EditorSelection } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from '@codemirror/search';
import { iconElement } from '../components/Icons.js';
import { domButton } from '../ui/dom.js';

// The results are counted up to this many; past it the count says "1000+".
const COUNT_LIMIT = 1000;

const panels = new WeakMap<EditorView, FindBar>();

// The find bar of `view` while it is open (openFind unfolds its Replace row through it).
export function findBarOf(view: EditorView): FindBar | undefined { return panels.get(view); }

export function createFindBar(view: EditorView): Panel {
    const bar = new FindBar(view);
    panels.set(view, bar);
    return bar;
}

// A toggle or an action of the fields (Aa, ab, .*, Replace, All): a small text button of their own.
function chip(title: string, text: string, run: () => void): HTMLButtonElement {
    return domButton({ label: title, content: text, variant: null, size: null, className: 'chip-button', onClick: run });
}

class FindBar implements Panel {
    readonly dom: HTMLElement;
    readonly top = true;
    private readonly find: HTMLInputElement;
    private readonly replace: HTMLInputElement;
    private readonly replaceRow: HTMLElement;
    private readonly expand: HTMLButtonElement;
    private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regexp', HTMLButtonElement>;
    private readonly findEntry: HTMLElement;
    private readonly count: HTMLElement;
    private query: SearchQuery;

    constructor(private readonly view: EditorView) {
        this.query = getSearchQuery(view.state);
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => { const e = document.createElement(tag); e.className = className; return e; };

        this.find = el('input', '');
        this.find.name = 'search';
        this.find.placeholder = 'Find';
        this.find.setAttribute('main-field', 'true');
        this.find.setAttribute('aria-label', 'Find in the document');
        this.find.addEventListener('input', () => this.commit(true));
        this.find.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrevious(view); else findNext(view); }
        });

        this.replace = el('input', '');
        this.replace.name = 'replace';
        this.replace.placeholder = 'Replace';
        this.replace.setAttribute('aria-label', 'Replace in the document');
        this.replace.addEventListener('input', () => this.commit(false));
        this.replace.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); replaceNext(view); } });

        for (const field of [this.find, this.replace]) {
            field.spellcheck = false;
            field.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } });
        }

        const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regexp', label: string, title: string) =>
            chip(title, label, () => { this.toggles[key].classList.toggle('checked'); this.toggles[key].setAttribute('aria-pressed', String(this.toggles[key].classList.contains('checked'))); this.commit(false); });
        this.toggles = {
            caseSensitive: toggle('caseSensitive', 'Aa', 'Match Case'),
            wholeWord: toggle('wholeWord', 'ab', 'Whole Words'),
            regexp: toggle('regexp', '.*', 'Regular Expression'),
        };

        this.findEntry = el('div', 'entry');
        this.findEntry.append(iconElement('edit-find'), this.find, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp);
        this.replaceRow = el('div', 'entry');
        this.replaceRow.hidden = true;
        this.replaceRow.append(this.replace,
            chip('Replace the selected result and go to the next', 'Replace', () => replaceNext(view)),
            chip('Replace All', 'All', () => replaceAll(view)));
        const fields = el('div', 'fields');
        fields.append(this.findEntry, this.replaceRow);

        this.expand = domButton({ label: 'Replace', content: iconElement('pan-end'), size: 'icon-sm', onClick: () => this.setExpanded(this.replaceRow.hidden === true) });
        this.expand.setAttribute('aria-pressed', 'false');

        const arrows = el('div', 'linked');
        arrows.append(domButton({ label: 'Previous result (Shift+Enter)', content: iconElement('chevron-up'), size: 'icon-sm', onClick: () => findPrevious(view) }),
            domButton({ label: 'Next result (Enter)', content: iconElement('chevron-down'), size: 'icon-sm', onClick: () => findNext(view) }));

        this.count = el('span', 'count');
        this.count.setAttribute('role', 'status');
        const separator = el('span', 'separator');
        const close = domButton({ label: 'Close', content: iconElement('window-close'), size: 'icon-sm', onClick: () => this.close() });

        this.dom = el('div', 'find-panel');
        this.dom.setAttribute('role', 'search');
        const box = el('div', 'find-box');
        box.append(this.expand, fields, arrows, this.count, separator, close);
        this.dom.append(box);
        this.show(this.query);
    }

    mount(): void { this.find.select(); this.updateCount(); }

    destroy(): void { panels.delete(this.view); }

    update(update: ViewUpdate): void {
        const query = getSearchQuery(update.state);
        if (!query.eq(this.query)) this.show(query);
        if (update.docChanged || update.selectionSet || !query.eq(this.query)) this.updateCount();
        this.query = query;
    }

    setExpanded(on: boolean): void {
        this.replaceRow.hidden = !on;
        this.expand.setAttribute('aria-pressed', String(on));
        this.expand.replaceChildren(iconElement(on ? 'pan-down' : 'pan-end'));
    }

    focusReplace(): void { this.replace.focus(); this.replace.select(); }

    private close(): void {
        closeSearchPanel(this.view);
        this.view.focus();
    }

    // The fields and toggles show `query` (it was set from elsewhere: the selection when the bar opens).
    private show(query: SearchQuery): void {
        if (this.find.value !== query.search) this.find.value = query.search;
        if (this.replace.value !== query.replace) this.replace.value = query.replace;
        for (const key of ['caseSensitive', 'wholeWord', 'regexp'] as const) {
            this.toggles[key].classList.toggle('checked', query[key]);
            this.toggles[key].setAttribute('aria-pressed', String(query[key]));
        }
        this.query = query;
    }

    // The query the fields say, set in the editor; a changed search text selects the first result from the selection's
    // start, so a result already selected stays selected while it still matches.
    private commit(typed: boolean): void {
        const query = new SearchQuery({
            search: this.find.value, replace: this.replace.value,
            caseSensitive: this.toggles.caseSensitive.classList.contains('checked'),
            wholeWord: this.toggles.wholeWord.classList.contains('checked'),
            regexp: this.toggles.regexp.classList.contains('checked'),
        });
        if (query.eq(this.query)) return;
        this.query = query;
        this.view.dispatch({ effects: setSearchQuery.of(query) });
        if (typed && query.valid && query.search) {
            const from = this.view.state.selection.main.from;
            const first = query.getCursor(this.view.state, from).next();
            const match = first.done ? query.getCursor(this.view.state).next() : first;
            if (!match.done) this.view.dispatch({ selection: EditorSelection.single(match.value.from, match.value.to), scrollIntoView: true });
        }
        this.updateCount();
    }

    // "3 of 12" while a result is selected, "12" otherwise, "No results"; an invalid expression marks the field.
    private updateCount(): void {
        const query = getSearchQuery(this.view.state);
        const invalid = !!query.search && !query.valid;
        this.findEntry.classList.toggle('invalid', invalid);
        let text = '';
        if (query.search && query.valid) {
            const { from, to } = this.view.state.selection.main;
            let total = 0, current = 0;
            const cursor = query.getCursor(this.view.state);
            for (let m = cursor.next(); !m.done && total < COUNT_LIMIT; m = cursor.next()) {
                total++;
                if (m.value.from === from && m.value.to === to) current = total;
            }
            const shown = total >= COUNT_LIMIT ? `${COUNT_LIMIT}+` : String(total);
            text = total === 0 ? 'No results' : current ? `${current} of ${shown}` : shown;
        }
        this.count.textContent = text;
        this.count.hidden = text === '';
    }
}
