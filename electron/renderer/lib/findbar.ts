// The find bar of the editor (Ctrl+F, Ctrl+H), drawn as the GTK window's was: ▸ unfolds the Replace row; the Find field
// has its icon and the Aa / ab / .* toggles inside it, the Replace field its Replace and All buttons; then ↑ ↓ joined,
// the count of results, and Close. CodeMirror's search state keeps the query; this panel only shows and changes it.

import { EditorSelection } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from '@codemirror/search';
import { iconElement } from '../components/Icons';
import { domButton, domInput, domInputGroup, domInputGroupAddon, domToggle, isPressed, setPressed } from '../ui/dom';

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

// An action inside the Replace field (Replace, All), as the CSV find bar's InputGroupButton.
const fieldButton = (label: string, text: string, run: () => void) => domButton({ label, content: text, size: 'xs', className: 'shadow-none', onClick: run });

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

        this.find = domInput({ name: 'search', placeholder: 'Find', label: 'Find in the document' }, true);
        this.find.setAttribute('main-field', 'true');
        this.find.addEventListener('input', () => this.commit(true));
        this.find.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrevious(view); else findNext(view); }
        });

        this.replace = domInput({ name: 'replace', placeholder: 'Replace', label: 'Replace in the document' }, true);
        this.replace.addEventListener('input', () => this.commit(false));
        this.replace.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); replaceNext(view); } });

        for (const field of [this.find, this.replace]) {
            field.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } });
        }

        const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regexp', label: string, title: string) =>
            domToggle({ label: title, content: label, size: 'xs', className: 'h-5 min-w-5 font-mono text-2xs', onChange: () => this.commit(false) });
        this.toggles = {
            caseSensitive: toggle('caseSensitive', 'Aa', 'Match Case'),
            wholeWord: toggle('wholeWord', 'ab', 'Whole Words'),
            regexp: toggle('regexp', '.*', 'Regular Expression'),
        };

        const findIcon = domInputGroupAddon(), findToggles = domInputGroupAddon('inline-end', 'gap-0.5');
        findIcon.append(iconElement('edit-find'));
        findToggles.append(this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp);
        this.findEntry = domInputGroup('h-8');
        this.findEntry.append(findIcon, this.find, findToggles);
        const replaceButtons = domInputGroupAddon('inline-end');
        replaceButtons.append(fieldButton('Replace the selected result and go to the next', 'Replace', () => replaceNext(view)),
            fieldButton('Replace All', 'All', () => replaceAll(view)));
        this.replaceRow = domInputGroup('h-8');
        this.replaceRow.hidden = true;
        this.replaceRow.append(this.replace, replaceButtons);
        const fields = el('div', 'fields');
        fields.append(this.findEntry, this.replaceRow);

        this.expand = domButton({ label: 'Replace', content: iconElement('pan-end'), size: 'icon-sm', onClick: () => this.setExpanded(this.replaceRow.hidden === true) });
        this.expand.setAttribute('aria-pressed', 'false');
        this.expand.hidden = view.state.readOnly;

        const arrows = el('div', 'arrows');
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
        on = on && !this.view.state.readOnly;
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
        for (const key of ['caseSensitive', 'wholeWord', 'regexp'] as const) setPressed(this.toggles[key], query[key]);
        this.query = query;
    }

    // The query the fields say, set in the editor; a changed search text selects the first result from the selection's
    // start, so a result already selected stays selected while it still matches.
    private commit(typed: boolean): void {
        const query = new SearchQuery({
            search: this.find.value, replace: this.replace.value,
            caseSensitive: isPressed(this.toggles.caseSensitive),
            wholeWord: isPressed(this.toggles.wholeWord),
            regexp: isPressed(this.toggles.regexp),
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
        if (invalid) this.find.setAttribute('aria-invalid', 'true');
        else this.find.removeAttribute('aria-invalid');
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
