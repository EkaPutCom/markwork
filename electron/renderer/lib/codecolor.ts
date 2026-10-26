// The colors inside a fenced code block, by its language (```js, ```python, ...). The
// grammars are CodeMirror's (@codemirror/language-data), loaded the first
// time a block names the language, so the window starts without them. A block of a language that is not known, or not loaded
// yet, keeps the plain code style.

import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { CodeBlock } from '../../../src/markdown/highlight.js';
import { diagramKind } from '../../../src/markdown/diagram.js';
import { iconElement } from '../components/Icons.js';
import { domButton } from '../ui/dom.js';
import { DELETE_ICON, blockTools, copyTool } from './blocktools.js';
import { fencedBlockAt, pick, removeBlock } from './blockselect.js';

const loaded = new Map<string, LanguageSupport | null>();   // null = no such language, or it failed to load
const loading = new Set<string>();

const marks = new Map<string, Decoration>();
const mark = (cls: string) => {
    let d = marks.get(cls);
    if (!d) marks.set(cls, d = Decoration.mark({ class: cls }));
    return d;
};

// The language named after a fence: "js", "python", "c++", also with options ("js title=x").
function describe(lang: string): LanguageDescription | null {
    const name = lang.trim().split(/[\s{]/)[0];
    return name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
}

// The name a block's language is shown by: the grammar's ("JavaScript" for js), the word itself if no grammar has it, or
// "Plain text" for none.
export function languageLabel(lang: string): string {
    return describe(lang)?.name ?? (lang.trim().split(/[\s{]/)[0] || 'Plain text');
}

// What a language is written as after the fence: its name in small letters, or its first short name when the name has a
// space ("Common Lisp" is lisp), so that the word names it again.
export function fenceName(language: LanguageDescription): string {
    return /\s/.test(language.name) && language.alias.length ? language.alias[0] : language.name.toLowerCase().replace(/\s+/g, '-');
}

// The window's list of languages for a code block (LanguagePicker.tsx), opened by the button over the box: where the
// button is, the language the block has, and what writes the one chosen.
export interface LanguagePick {
    at: { left: number; top: number; width: number; height: number };
    current: string;
    choose(lang: string): void;
}

// Write a language after a code block's opening fence; '' takes it away. What follows it (```js title=x) stays.
function setLanguage(view: EditorView, box: HTMLElement, lang: string): void {
    const fence = view.state.doc.lineAt(view.posAtDOM(box)), m = /^(\s*(?:`{3,}|~{3,})[ \t]*)(\S*)/.exec(fence.text);
    if (!m || m[2] === lang) return;
    const from = fence.from + m[1].length;
    view.dispatch({ changes: { from, to: from + m[2].length, insert: lang }, userEvent: 'input' });
}

type Span = [from: number, to: number, cls: string];

// The colored spans of a block's text (UTF-16 offsets in `block.text`): [] for a language that is not known, and also while its
// grammar is on its way, when `loadedLanguage` is called once it has arrived so the caller builds again.
export function spansOf(block: CodeBlock, loadedLanguage: () => void): { spans: Span[]; ready: boolean } {
    const description = describe(block.lang);
    if (!description) return { spans: [], ready: true };
    const key = description.name;
    const support = loaded.get(key);
    if (support === undefined) {
        if (!loading.has(key)) {
            loading.add(key);
            description.load().then(s => loaded.set(key, s), () => loaded.set(key, null)).then(() => { loading.delete(key); loadedLanguage(); });
        }
        return { spans: [], ready: false };
    }
    if (!support) return { spans: [], ready: true };
    const spans: Span[] = [];
    highlightTree(support.language.parser.parse(block.text), classHighlighter, (from, to, cls) => { if (to > from) spans.push([from, to, cls]); });
    return { spans, ready: true };
}

// The decorations for the colored text of the blocks shown as source. `offset(block, i)` is the document position of the
// UTF-16 index i in the block's text.
export function codeColors(blocks: readonly CodeBlock[], offset: (block: CodeBlock, index: number) => number, loadedLanguage: () => void) {
    const ranges: ReturnType<Decoration['range']>[] = [];
    for (const block of blocks) {
        if (!block.closed || !block.text || diagramKind(block)) continue;
        for (const [from, to, cls] of spansOf(block, loadedLanguage).spans) ranges.push(mark(cls).range(offset(block, from), offset(block, to)));
    }
    return ranges;
}

// The code of a box drawn with its colors.
function paint(pre: HTMLElement, text: string, spans: readonly Span[]): void {
    pre.replaceChildren();
    let at = 0;
    for (const [from, to, cls] of spans) {
        if (from < at || from >= text.length) continue;
        if (from > at) pre.append(text.slice(at, from));
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text.slice(from, Math.min(to, text.length));
        pre.append(span);
        at = Math.min(to, text.length);
    }
    pre.append(text.slice(at));
    // A last empty line has no height of its own: it gets one, so the caret can stand on it.
    if (text.endsWith('\n')) pre.append(document.createElement('br'));
}

// The caret's offsets in a box's code, [anchor, head]; null when the selection is not in it.
function selectionIn(pre: HTMLElement): [number, number] | null {
    const sel = window.getSelection();
    if (!sel?.anchorNode || !sel.focusNode || !pre.contains(sel.anchorNode) || !pre.contains(sel.focusNode)) return null;
    const offset = (node: Node, at: number) => { const r = document.createRange(); r.selectNodeContents(pre); r.setEnd(node, at); return r.toString().length; };
    return [offset(sel.anchorNode, sel.anchorOffset), offset(sel.focusNode, sel.focusOffset)];
}

function select(pre: HTMLElement, anchor: number, head: number): void {
    const point = (at: number): [Node, number] => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        let last: Text | null = null;
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            if (at <= node.length) return [node, at];
            at -= node.length;
            last = node;
        }
        return last ? [last, last.length] : [pre, 0];
    };
    const [an, ao] = point(anchor), [hn, ho] = point(head);
    window.getSelection()?.setBaseAndExtent(an, ao, hn, ho);
}

// Where a box's code is in the text: its opening fence line, the code's lines after it (`lines` of them, none in an empty
// block), and the closing fence line.
function codeRange(view: EditorView, box: HTMLElement, lines: number): { fence: number; from: number; to: number; closing: number } {
    const { doc } = view.state, fence = doc.lineAt(view.posAtDOM(box));
    const from = Math.min(fence.to + 1, doc.length);
    const to = lines ? doc.line(Math.min(doc.lines, fence.number + lines)).to : from;
    return { fence: fence.number, from, to, closing: Math.min(doc.lines, fence.number + lines + 1) };
}

// A code block as a box with the colored code, which scrolls sideways instead of wrapping. In the visual editor the code is
// edited in the box, as one piece that scrolls as a whole; elsewhere a click puts the cursor on the first line of the
// code, which opens the block for editing.
export class CodeBoxWidget extends WidgetType {
    private readonly key: string;

    constructor(readonly text: string, readonly spans: readonly Span[], private readonly dim = false, private readonly editable = false, readonly lines = 0,
        readonly lang = '', private readonly pickLanguage: (pick: LanguagePick) => void = () => {}) {
        super();
        this.key = `${text}\0${spans.map(s => s.join(':')).join(',')}${dim ? '\0dim' : ''}${editable ? `\0edit${lines}\0${lang}` : ''}`;
    }

    override eq(other: CodeBoxWidget): boolean { return other.key === this.key; }

    override toDOM(view: EditorView): HTMLElement {
        const box = document.createElement('div');
        box.className = 'cm-md-codebox' + (this.dim ? ' cm-md-dim' : '');
        const pre = document.createElement('pre');
        paint(pre, this.text, this.spans);
        box.append(pre, blockTools([copyTool(() => boxes.get(box)?.text ?? this.text), { label: 'Delete', icon: DELETE_ICON, run: () => { const b = fencedBlockAt(view, box, 'code'); if (b) removeBlock(view, b); } }]));
        boxes.set(box, this);
        if (this.editable) {
            box.prepend(this.languageBar(view, box));
            this.edit(view, box, pre);
        }
        else box.addEventListener('mousedown', event => {
            event.preventDefault();
            const { doc } = view.state;
            const fence = doc.lineAt(view.posAtDOM(box));
            const first = doc.line(Math.min(doc.lines, fence.number + 1));
            view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
            view.focus();
        });
        return box;
    }

    // The block's language over its code, as a button that opens the list of languages.
    private languageBar(view: EditorView, box: HTMLElement): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'cm-md-codehead';
        const button = domButton({ label: languageLabel(this.lang), size: 'xs', className: 'cm-md-codelang text-muted-foreground', onClick: () => {
            const r = button.getBoundingClientRect(), here = boxes.get(box)!;
            here.pickLanguage({
                at: { left: r.left, top: r.top, width: r.width, height: r.height }, current: here.lang,
                choose: lang => { setLanguage(view, box, lang); box.querySelector('pre')?.focus(); },
            });
        } });
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-description', 'The language of the code block');
        button.append(iconElement('chevron-down', 14));
        bar.append(button);
        return bar;
    }

    private edit(view: EditorView, box: HTMLElement, pre: HTMLElement): void {
        box.contentEditable = 'false';   // the code is an editing place of its own
        pre.className = 'cm-md-codeedit';
        pre.contentEditable = 'plaintext-only';
        pre.spellcheck = false;
        pre.setAttribute('aria-label', 'Code');
        const here = () => boxes.get(box)!;
        // The text's selection follows the box's, so the toolbar shows a code block and its commands act on it.
        const place = () => {
            const sel = selectionIn(pre);
            if (!sel || document.activeElement !== pre) return;
            const { from } = codeRange(view, box, here().lines), [anchor, head] = sel.map(at => from + at);
            const { main } = view.state.selection;
            if (main.anchor !== anchor || main.head !== head) view.dispatch({ selection: { anchor, head } });
        };
        // What was typed is written into the text: the stretch of code that changed.
        const commit = () => {
            const { text: old, lines } = here(), now = (pre.textContent ?? '').replace(/\r\n?/g, '\n');
            if (old === now) return;
            const { from } = codeRange(view, box, lines), caret = selectionIn(pre)?.[1] ?? now.length;
            // An empty block has no line for the code yet: it comes with one.
            if (!lines) { view.dispatch({ changes: { from, insert: `${now}\n` }, selection: { anchor: from + caret }, userEvent: 'input.type' }); return; }
            let p = 0;
            while (p < old.length && p < now.length && old[p] === now[p]) p++;
            let q = 0;
            while (q < old.length - p && q < now.length - p && old[old.length - 1 - q] === now[now.length - 1 - q]) q++;
            view.dispatch({ changes: { from: from + p, to: from + old.length - q, insert: now.slice(p, now.length - q) }, selection: { anchor: from + caret }, userEvent: 'input.type' });
        };
        // Leave the box for the line above or below it.
        const leave = (below: boolean) => {
            const { doc } = view.state, { fence, closing } = codeRange(view, box, here().lines);
            const target = below ? closing + 1 : fence - 1;
            if (target < 1 || target > doc.lines) return;
            const line = doc.line(target);
            view.dispatch({ selection: { anchor: below ? line.from : line.to }, scrollIntoView: true });
            view.focus();
        };
        // Out of the box onto a new line under it. `dropEmptyLine`: the code's last line is the empty one Enter just made; it goes.
        const exitBelow = (dropEmptyLine: boolean) => {
            const { doc } = view.state, { closing } = codeRange(view, box, here().lines), end = doc.line(closing);
            const list: { from: number; to?: number; insert: string }[] = [{ from: end.to, insert: '\n' }];
            if (dropEmptyLine && closing - 1 > 0) { const last = doc.line(closing - 1); list.unshift({ from: last.from - 1, to: last.to, insert: '' }); }
            const changes = view.state.changes(list);
            view.dispatch({ changes, selection: { anchor: changes.mapPos(end.to, -1) + 1 }, scrollIntoView: true, userEvent: 'input' });
            view.focus();
        };
        // Esc, or a click on the box around the code, picks the block as one object (blockselect.ts).
        const pickBox = () => { const b = fencedBlockAt(view, box, 'code'); if (b) pick(view, b); };
        box.addEventListener('mousedown', event => { if (event.target === box) { event.preventDefault(); pickBox(); } });
        // On an empty last line Enter leaves the block; the box says so while the caret is there.
        const atEmptyEnd = () => {
            const sel = selectionIn(pre), code = pre.textContent ?? '';
            return !!sel && sel[0] === sel[1] && sel[1] === code.length && /\n[ \t]*$/.test(code);
        };
        const hint = () => box.classList.toggle('exit-hint', document.activeElement === pre && atEmptyEnd());
        pre.addEventListener('keyup', hint);
        pre.addEventListener('mouseup', () => requestAnimationFrame(hint));
        pre.addEventListener('focusout', () => box.classList.remove('exit-hint'));
        pre.addEventListener('beforeinput', event => { if (/^(historyUndo|historyRedo|format)/.test(event.inputType)) event.preventDefault(); });
        pre.addEventListener('input', event => { if (!(event as InputEvent).isComposing) commit(); });
        pre.addEventListener('compositionend', commit);
        pre.addEventListener('focusin', place);
        pre.addEventListener('keyup', place);
        pre.addEventListener('mouseup', () => requestAnimationFrame(place));
        pre.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); exitBelow(false); return; }
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === 'Enter' && !event.shiftKey && atEmptyEnd()) { event.preventDefault(); exitBelow(true); return; }
            const sel = selectionIn(pre), code = pre.textContent ?? '';
            // Tab indents; Enter starts a line of code with the indent of the one it is on. (The browser's own line break
            // in an editable element is not always a plain one.)
            const insert = (text: string) => {
                if (!sel) return;
                event.preventDefault();
                const from = Math.min(sel[0], sel[1]), to = Math.max(sel[0], sel[1]);
                paint(pre, code.slice(0, from) + text + code.slice(to), []);
                select(pre, from + text.length, from + text.length);
                commit();
            };
            if (event.key === 'Tab' && !event.shiftKey) insert('  ');
            else if (event.key === 'Enter') insert('\n' + /^[ \t]*/.exec(code.slice(code.lastIndexOf('\n', Math.min(...(sel ?? [0])) - 1) + 1))![0]);
            else if (event.key === 'Escape') { event.preventDefault(); pickBox(); }
            else if (event.key === 'ArrowUp' && sel && sel[0] === sel[1] && !code.slice(0, sel[1]).includes('\n')) { event.preventDefault(); leave(false); }
            else if (event.key === 'ArrowDown' && sel && sel[0] === sel[1] && !code.slice(sel[1]).includes('\n')) { event.preventDefault(); leave(true); }
        });
    }

    // A change that keeps the box editable is written into the box it is in, so the code being typed keeps its focus
    // and its caret; the colors are drawn again.
    override updateDOM(dom: HTMLElement, view: EditorView, from: CodeBoxWidget): boolean {
        if (!this.editable || !from.editable) return false;
        const pre = dom.querySelector('pre');
        if (!pre) return false;
        boxes.set(dom, this);
        dom.classList.toggle('cm-md-dim', this.dim);
        const language = dom.querySelector('.cm-md-codelang');
        if (language && this.lang !== from.lang) language.firstChild!.textContent = languageLabel(this.lang);
        const focused = document.activeElement === pre, sel = focused ? selectionIn(pre) : null;
        const typed = (pre.textContent ?? '') === this.text;
        paint(pre, this.text, this.spans);
        if (!focused) return true;
        if (typed && sel) select(pre, sel[0], sel[1]);
        else {
            // Changed from outside the box (undo, a command): the caret goes where the text's selection is.
            const { from: start } = codeRange(view, dom, this.lines), { main } = view.state.selection;
            const length = this.text.length, at = (pos: number) => Math.min(Math.max(pos - start, 0), length);
            select(pre, at(main.anchor), at(main.head));
        }
        return true;
    }

    override ignoreEvent(): boolean { return true; }
}

const boxes = new WeakMap<HTMLElement, CodeBoxWidget>();

// Give the focus to the code box that holds document position `pos`, with the caret there.
export function focusCode(view: EditorView, pos: number): void {
    for (const box of view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-codebox')) {
        const widget = boxes.get(box), pre = box.querySelector<HTMLElement>('pre.cm-md-codeedit');
        if (!widget || !pre) continue;
        const { doc } = view.state, { fence, from, closing } = codeRange(view, box, widget.lines);
        if (pos < doc.line(fence).from || pos > doc.line(closing).to) continue;
        const length = widget.text.length;
        pre.focus({ preventScroll: true });
        const at = Math.min(Math.max(pos - from, 0), length);
        select(pre, at, at);
        return;
    }
}
