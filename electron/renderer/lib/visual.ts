// The visual editor: the text shown as it looks, for someone who does not know Markdown. The text stays Markdown; on
// top of the live view it hides the syntax on the cursor line too, draws a list item's marker as a bullet and its task
// box as a checkbox, keeps the cursor out of a line's hidden prefix, and makes Backspace and Delete remove what the eye
// sees rather than a hidden marker. A selection gets a small menu, and "/" at the start of a word offers the blocks.
// What a command does is markdown/editcommands.ts, run by name through the window's commands (app/commands.ts).

import { EditorSelection, EditorState, StateEffect, StateField, findClusterBreak, type Extension, type RangeSet } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import { startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { iconElement, type IconName } from '../components/Icons.js';
import { cellSelectionRect } from './tables.js';

export const setVisual = StateEffect.define<boolean>();
export const visualMode = StateField.define<boolean>({
    create: () => false,
    update: (on, tr) => tr.effects.reduce((v, e) => e.is(setVisual) ? e.value : v, on),
});

// What one drawing of the text hides: the hidden ranges (the cursor steps over each as one), and where the prefix of a
// heading, quote, or list item ends on its line (by the line's start), which the cursor does not enter.
export interface Concealed {
    readonly hidden: RangeSet<Decoration>;
    readonly prefixes: ReadonlyMap<number, number>;
}

// Runs a command of the window by its id (app/commands.ts).
export type RunCommand = (id: string, arg?: boolean) => void;

// ---------- List markers ----------

// The width of what stands before a list item's text: its marker (a bullet, a number, or a checkbox) and the gap after it.
// Every item has the same, so the first letter of an item lines up with the lines that wrap under it (the line takes the
// width as its hanging indent, editor.ts).
export const LIST_PREFIX_PX = 26;

type ListMark = 'bullet' | 'number' | 'task' | 'taskdone';

class ListMarkWidget extends WidgetType {
    constructor(private readonly kind: ListMark, private readonly text: string) { super(); }
    override eq(other: ListMarkWidget): boolean { return other.kind === this.kind && other.text === this.text; }
    override toDOM(view: EditorView): HTMLElement {
        const mark = document.createElement('span');
        mark.className = `cm-md-listmark ${this.kind}`;
        mark.style.width = `${LIST_PREFIX_PX}px`;
        if (this.kind === 'bullet') mark.textContent = '•';
        else if (this.kind === 'number') mark.textContent = this.text;
        else mark.append(this.box(view, mark));
        return mark;
    }

    // A task's box: a click writes the other state into the text, in the "[ ]" it stands for.
    private box(view: EditorView, mark: HTMLElement): HTMLInputElement {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'cm-md-checkbox';
        box.checked = this.kind === 'taskdone';
        box.setAttribute('aria-label', box.checked ? 'Done' : 'Not done');
        box.addEventListener('mousedown', event => {
            event.preventDefault();
            const at = view.posAtDOM(mark), line = view.state.doc.lineAt(at);
            const inside = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/.exec(line.text.slice(at - line.from));
            if (!inside) return;
            const pos = at + inside[0].length - 2;
            view.dispatch({ changes: { from: pos, to: pos + 1, insert: inside[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
        });
        return box;
    }
    override ignoreEvent(): boolean { return true; }
}

const LIST_PREFIX = /^([-*+]|\d{1,9}[.)])([ \t]+|$)(\[([ xX])\](?:[ \t]+|$))?/;

// The marker of the list item whose marker starts at `from` on a line: its marker and the spaces and task box after it
// become one widget of a fixed width. Returns where the item's text starts, and the indent before the marker (which stays).
export function listPrefix(ranges: ReturnType<Decoration['range']>[], lineText: string, lineFrom: number, from: number): { end: number; indent: string } | null {
    const at = from - lineFrom, m = LIST_PREFIX.exec(lineText.slice(at));
    if (!m) return null;
    const kind: ListMark = m[3] ? (/x/i.test(m[4]) ? 'taskdone' : 'task') : /\d/.test(m[1]) ? 'number' : 'bullet';
    const end = from + m[0].length;
    ranges.push(Decoration.replace({ widget: new ListMarkWidget(kind, m[1]) }).range(from, end));
    return { end, indent: /[ \t]*$/.exec(lineText.slice(0, at))![0] };
}

// ---------- The cursor and deleting ----------

// The hidden ranges that touch `pos` from one side, followed for as long as another one starts where the last ended:
// the first visible place before (or after) the cursor.
// Hidden ranges can lie inside one another (a picture's markup, hidden whole, over its own hidden "![" and "](…)"): the step
// goes past the one that reaches furthest, or Delete would remove a letter of the markup between the inner ones.
function pastHidden(hidden: RangeSet<Decoration>, pos: number, forward: boolean): number {
    for (let moved = true; moved;) {
        moved = false;
        let to = pos;
        hidden.between(forward ? pos : pos - 1, forward ? pos + 1 : pos, (a, b) => {
            if (forward && a === pos && b > to) to = b;
            else if (!forward && b === pos && a < to) to = a;
        });
        if (to !== pos) { pos = to; moved = true; }
    }
    return pos;
}

function backspace(view: EditorView, conceal: (state: EditorState) => Concealed): boolean {
    const { state } = view, sel = state.selection.main;
    if (!sel.empty) return false;
    const { hidden, prefixes } = conceal(state);
    const line = state.doc.lineAt(sel.head);
    const end = prefixes.get(line.from);
    // At the start of a heading, quote, or list item's text: it becomes a paragraph.
    if (end !== undefined && sel.head <= end) {
        view.dispatch({ changes: { from: line.from, to: end }, selection: { anchor: line.from }, userEvent: 'delete.backward', scrollIntoView: true });
        return true;
    }
    const pos = pastHidden(hidden, sel.head, false);
    if (pos === sel.head) return false;
    const at = state.doc.lineAt(pos);
    const from = pos > at.from ? at.from + findClusterBreak(at.text, pos - at.from, false) : pos - 1;
    if (from < 0) return true;
    view.dispatch({ changes: { from, to: pos }, userEvent: 'delete.backward', scrollIntoView: true });
    return true;
}

function deleteForward(view: EditorView, conceal: (state: EditorState) => Concealed): boolean {
    const { state } = view, sel = state.selection.main;
    if (!sel.empty) return false;
    const { hidden, prefixes } = conceal(state);
    const line = state.doc.lineAt(sel.head);
    // At the end of a line: the next line's text joins this one without its prefix.
    if (sel.head === line.to && line.number < state.doc.lines) {
        const next = state.doc.line(line.number + 1);
        const end = prefixes.get(next.from);
        if (end === undefined) return false;
        view.dispatch({ changes: { from: line.to, to: end }, userEvent: 'delete.forward' });
        return true;
    }
    const pos = pastHidden(hidden, sel.head, true);
    if (pos === sel.head) return false;
    const at = state.doc.lineAt(pos);
    const to = pos < at.to ? at.from + findClusterBreak(at.text, pos - at.from, true) : Math.min(pos + 1, state.doc.length);
    view.dispatch({ changes: { from: pos, to }, userEvent: 'delete.forward' });
    return true;
}

// A cursor that lands in a line's hidden prefix moves to where its text starts; moving left from there goes on to the
// end of the line above, so the prefix never traps the cursor.
function keepOutOfPrefixes(conceal: (state: EditorState) => Concealed, on: (state: EditorState) => boolean): Extension {
    return EditorState.transactionFilter.of(tr => {
        if (tr.docChanged || !tr.selection || !on(tr.startState)) return tr;
        const sel = tr.selection.main;
        if (!sel.empty || tr.selection.ranges.length > 1) return tr;
        const line = tr.startState.doc.lineAt(sel.head);
        const end = conceal(tr.startState).prefixes.get(line.from);
        if (end === undefined || sel.head >= end) return tr;
        const before = tr.startState.selection.main;
        const back = before.empty && before.head === end && line.from > 0;
        return [tr, { selection: EditorSelection.cursor(back ? line.from - 1 : end), sequential: true }];
    });
}

// The visual editor's handling of the cursor and the keys, given the hidden ranges of the current drawing.
export function visualEditing(conceal: (state: EditorState) => Concealed, on: (state: EditorState) => boolean): Extension {
    return [
        EditorView.atomicRanges.of(view => on(view.state) ? conceal(view.state).hidden : Decoration.none),
        keepOutOfPrefixes(conceal, on),
        keymap.of([
            { key: 'Backspace', run: view => on(view.state) && backspace(view, conceal) },
            { key: 'Delete', run: view => on(view.state) && deleteForward(view, conceal) },
        ]),
    ];
}

// ---------- The selection menu ----------

const SELECTION_BUTTONS: [id: string, label: string, icon: IconName][] = [
    ['bold', 'Bold', 'format-bold'], ['italic', 'Italic', 'format-italic'], ['strike', 'Strikethrough', 'format-strike'],
    ['highlight', 'Highlight', 'format-highlight'], ['inline-code', 'Inline Code', 'format-code'], ['link', 'Insert Link', 'format-link'],
];

function selectionMenuDom(run: RunCommand): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-selection-menu';
    dom.setAttribute('role', 'toolbar');
    dom.setAttribute('aria-label', 'Format the selection');
    const button = (label: string, icon: IconName, onClick: () => void, text?: string) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.append(iconElement(icon, 15));
        if (text) { const t = document.createElement('span'); t.textContent = text; b.append(t); b.classList.add('with-text'); }
        // The editor keeps the focus and the selection; the command acts on them.
        b.addEventListener('mousedown', event => event.preventDefault());
        b.addEventListener('click', onClick);
        return b;
    };
    for (const [id, label, icon] of SELECTION_BUTTONS) dom.append(button(label, icon, () => run(id)));
    const sep = document.createElement('span');
    sep.className = 'sep';
    dom.append(sep, button('Ask the Assistant about the selection', 'sparkle', () => run('chat', true), 'Ask'));
    return dom;
}

// A menu over a selection in the visual editor: the inline formats, and the Assistant (which sees the selection).
export function selectionMenu(run: RunCommand, on: (state: EditorState) => boolean): Extension {
    const tip = (state: EditorState): Tooltip | null => {
        const sel = state.selection.main;
        if (sel.empty || !on(state) || !state.sliceDoc(sel.from, sel.to).trim()) return null;
        // A selection in a table cell is drawn by the cell, not at the text's places: the menu goes over the cell's.
        return {
            pos: sel.from, above: true, arrow: false,
            create: view => ({ dom: selectionMenuDom(run), offset: { x: 0, y: 8 }, getCoords: pos => cellSelectionRect() ?? view.coordsAtPos(pos) ?? new DOMRect() }),
        };
    };
    return StateField.define<Tooltip | null>({
        create: tip,
        update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(e => e.is(setVisual)) ? tip(tr.state) : value,
        provide: f => showTooltip.from(f),
    });
}

// ---------- The link editor ----------

// What the box under the cursor edits: the text it replaces (a selection, or a whole [text](url) link the cursor is in),
// that link's text and address, whatever follows the address inside the brackets (a title), and whether the text is asked for.
// An image (![alt](url)) is edited by the same box, its alt text in place of the text.
interface LinkEdit { from: number; to: number; text: string; url: string; rest: string; existing: boolean; askText: boolean; image?: boolean }

const setLinkEdit = StateEffect.define<LinkEdit | null>();
const linkEdit = StateField.define<LinkEdit | null>({
    create: () => null,
    update: (value, tr) => {
        for (const e of tr.effects) if (e.is(setLinkEdit)) return e.value;
        return tr.docChanged || tr.selection ? null : value;
    },
    provide: f => showTooltip.from(f, edit => edit && { pos: edit.from, above: false, arrow: false, create: view => linkEditDom(view, edit) }),
});

function linkEditDom(view: EditorView, edit: LinkEdit): TooltipView {
    const dom = document.createElement('form');
    dom.className = 'cm-link-editor';
    const input = (label: string, value: string, placeholder: string) => {
        const row = document.createElement('label');
        const name = document.createElement('span');
        name.textContent = label;
        const field = document.createElement('input');
        field.type = 'text';
        field.value = value;
        field.placeholder = placeholder;
        field.spellcheck = false;
        row.append(name, field);
        dom.append(row);
        return field;
    };
    const text = edit.image ? input('Alt text', edit.text, 'What the image shows')
        : edit.askText ? input('Text', edit.text, 'What the link says') : null;
    const url = edit.image ? input('Image', edit.url, 'https://… or a file path') : input('Link', edit.url, 'https://… or a file path');
    const close = () => { view.dispatch({ effects: setLinkEdit.of(null) }); view.focus(); };
    const replace = (insert: string) => {
        view.dispatch({ changes: { from: edit.from, to: edit.to, insert }, selection: { anchor: edit.from + insert.length }, userEvent: 'input' });
        view.focus();
    };
    const buttons = document.createElement('div');
    buttons.className = 'actions';
    const button = (label: string, type: 'submit' | 'button', onClick?: () => void) => {
        const b = document.createElement('button');
        b.type = type;
        b.textContent = label;
        if (onClick) b.addEventListener('click', onClick);
        buttons.append(b);
        return b;
    };
    if (edit.image) button('Remove image', 'button', () => replace('')).classList.add('remove');
    else if (edit.existing) button('Remove link', 'button', () => replace(edit.text)).classList.add('remove');
    button('Apply', 'submit').classList.add('apply');
    dom.append(buttons);
    dom.addEventListener('submit', event => {
        event.preventDefault();
        const address = url.value.trim().replace(/\s/g, '%20');
        if (!address) { close(); return; }
        if (edit.image) { replace(`![${text!.value.trim()}](${address}${edit.rest})`); return; }
        const label = ((text ? text.value : edit.text).trim()) || address;
        replace(`[${label}](${address}${edit.rest})`);
    });
    dom.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    });
    return {
        dom,
        mount: () => {
            (text && !edit.text ? text : url).focus();
            if (edit.url) { url.select(); return; }
            // A web address on the clipboard fills the empty field.
            void navigator.clipboard?.readText().then(copied => {
                if (/^(?:https?:\/\/|mailto:)\S+$/.test(copied.trim()) && !url.value) { url.value = copied.trim(); url.select(); }
            }, () => undefined);
        },
    };
}

// Open the box for a link at the cursor: the link it is in is changed, a selection becomes a link, and with nothing
// selected the box asks for the text as well.
export function openLinkEditor(view: EditorView): void {
    const { state } = view, sel = state.selection.main, line = state.doc.lineAt(sel.head);
    const open = (edit: LinkEdit) => view.dispatch({ effects: setLinkEdit.of(edit) });
    for (const m of line.text.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]*)([^)]*)\)/g)) {
        const from = line.from + m.index, to = from + m[0].length;
        if (sel.from >= from && sel.to <= to) { open({ from, to, text: m[1], url: m[2], rest: m[3], existing: true, askText: true }); return; }
    }
    const picked = state.sliceDoc(sel.from, sel.to);
    const isUrl = /^(?:https?:|mailto:)\S+$/.test(picked);
    open({ from: sel.from, to: sel.to, text: isUrl ? '' : picked, url: isUrl ? picked : '', rest: '', existing: false, askText: sel.empty || isUrl });
}

// Open the box for the image at `url` (as written) on the line at `pos`; nth tells copies of one address apart.
export function openImageEditor(view: EditorView, pos: number, url: string, nth = 0): void {
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(/!\[([^\]]*)\]\(([^)\s]*)([^)]*)\)/g)) {
        if (m[2] !== url || nth-- > 0) continue;
        const from = line.from + m.index;
        view.dispatch({ effects: setLinkEdit.of({ from, to: from + m[0].length, text: m[1], url: m[2], rest: m[3], existing: true, askText: true, image: true }) });
        return;
    }
}

export const linkEditor: Extension = linkEdit;

// ---------- The / menu ----------

interface SlashItem { id: string; label: string; detail: string; glyph: string; section: 'Text' | 'Lists' | 'Insert' }

// The sections in the order of the menu (CodeMirror would sort them by name).
const SECTIONS = { Text: { name: 'Text', rank: 0 }, Lists: { name: 'Lists', rank: 1 }, Insert: { name: 'Insert', rank: 2 } };

// The blocks "/" offers, each a command of the window.
export const SLASH_ITEMS: readonly SlashItem[] = [
    { id: 'paragraph', label: 'Text', detail: 'Plain paragraph', glyph: 'T', section: 'Text' },
    { id: 'heading1', label: 'Heading 1', detail: 'Big section title', glyph: 'H1', section: 'Text' },
    { id: 'heading2', label: 'Heading 2', detail: 'Medium section title', glyph: 'H2', section: 'Text' },
    { id: 'heading3', label: 'Heading 3', detail: 'Small section title', glyph: 'H3', section: 'Text' },
    { id: 'ulist', label: 'Bulleted list', detail: 'A simple list', glyph: '•', section: 'Lists' },
    { id: 'olist', label: 'Numbered list', detail: 'A list with numbers', glyph: '1.', section: 'Lists' },
    { id: 'tasklist', label: 'To-do list', detail: 'Tasks with checkboxes', glyph: '☑', section: 'Lists' },
    { id: 'quote', label: 'Quote', detail: 'Highlight a passage', glyph: '❝', section: 'Insert' },
    { id: 'table', label: 'Table', detail: 'Rows and columns', glyph: '▦', section: 'Insert' },
    { id: 'image', label: 'Image', detail: 'A picture from a file', glyph: '▣', section: 'Insert' },
    { id: 'codeblock', label: 'Code block', detail: 'Text in a fixed-width font', glyph: '{}', section: 'Insert' },
    { id: 'divider', label: 'Divider', detail: 'A line between sections', glyph: '—', section: 'Insert' },
    { id: 'link', label: 'Web link', detail: 'A web address', glyph: '↗', section: 'Insert' },
    { id: 'doclink', label: 'Document link', detail: 'Link to another document', glyph: '[[', section: 'Insert' },
];

const glyphs = new WeakMap<Completion, string>();

// "/" at the start of a line or after a space, while `on` holds: the blocks, filtered by what follows the slash.
// Choosing one removes the "/…" and runs the block's command at the cursor.
export function slashSource(run: RunCommand, on: (state: EditorState) => boolean) {
    const options = SLASH_ITEMS.map((item, i): Completion => {
        const option: Completion = {
            label: item.label, detail: item.detail, boost: -i, section: SECTIONS[item.section],
            apply: (view, _c, from, to) => {
                if (item.id === 'doclink') {   // [[ opens the note suggestions (editor.ts)
                    view.dispatch({ changes: { from: from - 1, to, insert: '[[' }, selection: { anchor: from + 1 }, userEvent: 'input.complete' });
                    startCompletion(view);
                    return;
                }
                view.dispatch({ changes: { from: from - 1, to }, selection: { anchor: from - 1 }, userEvent: 'input.complete' });
                run(item.id);
            },
        };
        glyphs.set(option, item.glyph);
        return option;
    });
    return (context: CompletionContext): CompletionResult | null => {
        if (!on(context.state)) return null;
        const typed = context.matchBefore(/(?:^|\s)\/\w{0,20}$/);
        if (!typed) return null;
        const slash = typed.from + typed.text.indexOf('/');
        return { from: slash + 1, options, validFor: /^\w*$/ };
    };
}

// The small square before a / menu row (nothing on a [[note]] suggestion).
export const slashGlyph = {
    render: (completion: Completion): Node | null => {
        const glyph = glyphs.get(completion);
        if (!glyph) return null;
        const box = document.createElement('span');
        box.className = 'cm-slash-glyph';
        box.textContent = glyph;
        return box;
    },
    position: 20,
};
