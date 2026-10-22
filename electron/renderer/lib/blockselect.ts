// A picture, a code block, or a diagram picked as one object, the way a document editor picks an image. The text stays
// Markdown and its cursor sits after the object's markup (pick, below); this field says the object is picked, the object is drawn
// with a ring and a hint of the keys, and the keys act on it as a whole:
//   Enter (or typing)       a new line after it, as a paragraph of its own
//   Backspace, Delete       it goes, with its line when nothing else is left there
//   Arrows, Esc             it is let go, and the cursor goes before or after it
//   Copy, Cut               its Markdown
// An object is picked by a click on it, by Esc in a code block, and by Backspace (Delete) next to it, which would otherwise
// break the markup around it (a line joined to a closing fence) or remove a hidden piece of it.

import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Line } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, showTooltip, type ViewUpdate } from '@codemirror/view';
import { pictureRange } from './images.js';

export type BlockKind = 'picture' | 'code' | 'diagram';

// from–to: a picture's ![alt](url), or a fenced block's lines from its opening fence to the end of its closing one.
export interface PickedBlock { kind: BlockKind; from: number; to: number }

// What the text holds, from the editor's parse: its fenced blocks drawn as boxes, and the markup of the pictures a line shows.
export interface BlockSource {
    blocks(state: EditorState): readonly PickedBlock[];
    pictures(state: EditorState, line: Line): readonly PickedBlock[];
}

export const pickBlock = StateEffect.define<PickedBlock | null>();

export const pickedBlock = StateField.define<PickedBlock | null>({
    create: () => null,
    update: (value, tr) => {
        for (const e of tr.effects) if (e.is(pickBlock)) return e.value;
        return tr.docChanged || tr.selection ? null : value;
    },
});

// Pick an object. The cursor goes right after a picture's markup, and to the start of the line after a block: inside the
// block it would open it (its source shows, or its code takes the focus).
export function pick(view: EditorView, block: PickedBlock): void {
    view.focus();   // first: taking the focus may sync the selection from the page, which would let go of the object
    const anchor = block.kind === 'picture' ? block.to : Math.min(block.to + 1, view.state.doc.length);
    view.dispatch({ selection: { anchor }, effects: pickBlock.of(block) });
}

// The fenced block (``` or ~~~) whose opening fence is on the line of `element`, a widget drawn in its place.
export function fencedBlockAt(view: EditorView, element: HTMLElement, kind: BlockKind): PickedBlock | null {
    const { doc } = view.state, fence = doc.lineAt(view.posAtDOM(element));
    const mark = /^\s*(`{3,}|~{3,})/.exec(fence.text)?.[1];
    if (!mark) return null;
    let closing = fence.number + 1;
    while (closing < doc.lines && !doc.line(closing).text.trimStart().startsWith(mark)) closing++;
    return { kind, from: fence.from, to: doc.line(closing).to };
}

// ---------- What the keys do to a picked object ----------

// The stretch of text an object takes with it when it goes: a picture with a space next to it, or its whole line when
// nothing else is on it; a block with its line break.
function removalOf(state: EditorState, block: PickedBlock): { from: number; to: number } {
    const { doc } = state, line = doc.lineAt(block.from);
    const whole = (from: number, to: number) => to < doc.length ? { from, to: to + 1 } : { from: Math.max(0, from - 1), to };
    if (block.kind !== 'picture') return whole(block.from, block.to);
    const before = line.text.slice(0, block.from - line.from), after = line.text.slice(block.to - line.from);
    if (!(before + after).trim()) return whole(line.from, line.to);
    const space = /^[ \t]+/.exec(after)?.[0].length ?? 0;
    return space ? { from: block.from, to: block.to + space } : { from: block.from - (/[ \t]+$/.exec(before)?.[0].length ?? 0), to: block.to };
}

export function removeBlock(view: EditorView, block: PickedBlock): void {
    const { from, to } = removalOf(view.state, block);
    view.dispatch({ changes: { from, to }, selection: { anchor: from }, scrollIntoView: true, userEvent: 'delete' });
    view.focus();
}

// A new line after the object, with `text` on it. After a picture with more on its line, the line breaks right there.
function lineAfter(view: EditorView, block: PickedBlock, text = ''): void {
    const { doc } = view.state, line = doc.lineAt(block.to);
    const rest = line.text.slice(block.to - line.from);
    const at = block.kind === 'picture' && rest.trim() ? block.to : line.to;
    const space = at === block.to ? /^[ \t]*/.exec(rest)![0].length : 0;
    view.dispatch({ changes: { from: at, to: at + space, insert: '\n' + text }, selection: { anchor: at + 1 + text.length }, scrollIntoView: true, userEvent: 'input' });
}

// Let the object go, the cursor before it (on the line above, for a block) or after it (the start of the next line).
function leave(view: EditorView, block: PickedBlock, forward: boolean): void {
    const { doc } = view.state;
    const anchor = forward
        ? Math.min(doc.lineAt(block.to).to + 1, doc.length)
        : block.kind === 'picture' ? block.from : Math.max(0, block.from - 1);
    view.dispatch({ selection: EditorSelection.cursor(anchor), scrollIntoView: true });
}

function copy(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
    const block = view.state.field(pickedBlock);
    if (!block || !event.clipboardData) return false;
    event.preventDefault();
    event.clipboardData.setData('text/plain', view.state.sliceDoc(block.from, block.to));
    if (cut) removeBlock(view, block);
    return true;
}

const withPicked = (run: (view: EditorView, block: PickedBlock) => void) => (view: EditorView): boolean => {
    const block = view.state.field(pickedBlock);
    if (!block) return false;
    run(view, block);
    return true;
};

const pickedKeys = keymap.of([
    { key: 'Enter', run: withPicked((view, block) => lineAfter(view, block)) },
    { key: 'Backspace', run: withPicked(removeBlock) },
    { key: 'Delete', run: withPicked(removeBlock) },
    { key: 'Escape', run: withPicked((view, block) => leave(view, block, true)) },
    { key: 'ArrowLeft', run: withPicked((view, block) => leave(view, block, false)) },
    { key: 'ArrowUp', run: withPicked((view, block) => leave(view, block, false)) },
    { key: 'ArrowRight', run: withPicked((view, block) => leave(view, block, true)) },
    { key: 'ArrowDown', run: withPicked((view, block) => leave(view, block, true)) },
]);

// ---------- Picking with the keys ----------

// The object that ends right before `pos` across a line break: a block whose closing fence is the line above, or the
// last picture of the line above when that line shows nothing but pictures.
function objectAbove(state: EditorState, source: BlockSource, line: Line): PickedBlock | null {
    if (line.number === 1) return null;
    const above = state.doc.line(line.number - 1);
    const block = source.blocks(state).find(b => b.to === above.to);
    if (block) return block;
    const pictures = source.pictures(state, above);
    return pictures.length && onlyPictures(above, pictures) ? pictures[pictures.length - 1] : null;
}

// The object that starts right after `pos`: a picture after the cursor's text (its markup is hidden, so Delete would
// remove a piece of it), or a block (or a line of pictures only) on the line below when the cursor is at its line's end.
function objectBelow(state: EditorState, source: BlockSource, pos: number): PickedBlock | null {
    const { doc } = state, line = doc.lineAt(pos);
    const next = source.pictures(state, line).find(p => p.from >= pos && !line.text.slice(pos - line.from, p.from - line.from).trim());
    if (next) return next;
    if (pos !== line.to || line.number === doc.lines) return null;
    const below = doc.line(line.number + 1);
    const block = source.blocks(state).find(b => b.from === below.from);
    if (block) return block;
    const pictures = source.pictures(state, below);
    return pictures.length && onlyPictures(below, pictures) ? pictures[0] : null;
}

const onlyPictures = (line: Line, pictures: readonly PickedBlock[]): boolean =>
    !pictures.reduceRight((text, p) => text.slice(0, p.from - line.from) + text.slice(p.to - line.from), line.text).trim();

function pickingKeys(source: BlockSource, on: (state: EditorState) => boolean): Extension {
    const near = (forward: boolean) => (view: EditorView): boolean => {
        const { state } = view, sel = state.selection.main;
        if (!on(state) || !sel.empty) return false;
        const line = state.doc.lineAt(sel.head);
        const block = forward ? objectBelow(state, source, sel.head) : sel.head === line.from ? objectAbove(state, source, line) : null;
        if (!block) return false;
        pick(view, block);
        return true;
    };
    return keymap.of([{ key: 'Backspace', run: near(false) }, { key: 'Delete', run: near(true) }]);
}

// ---------- Where the cursor may stand among pictures ----------

// The pictures at the end of a line are hidden markup with spaces between them, all drawn under the line: a cursor among
// them looks as if it were at the end of the line's text. It stands before them instead, where it is seen, and moving on
// from there goes to the next line.
function keepOutOfPictureRuns(source: BlockSource, on: (state: EditorState) => boolean): Extension {
    return EditorState.transactionFilter.of(tr => {
        if (tr.docChanged || !tr.selection || tr.effects.some(e => e.is(pickBlock)) || !on(tr.startState)) return tr;
        const sel = tr.selection.main;
        if (!sel.empty || tr.selection.ranges.length > 1) return tr;
        const { doc } = tr.startState, line = doc.lineAt(sel.head);
        const start = pictureRunStart(tr.startState, source, line);
        if (start === null || sel.head <= start) return tr;
        const before = tr.startState.selection.main;
        // Moving right with the keys from there goes on; a click there stays.
        const onward = !tr.isUserEvent('select.pointer') && before.empty && before.head === start && line.number < doc.lines;
        return [tr, { selection: EditorSelection.cursor(onward ? line.to + 1 : start), sequential: true }];
    });
}

// Where the pictures that end a line start (the space before them stays the text's), or null.
function pictureRunStart(state: EditorState, source: BlockSource, line: Line): number | null {
    const pictures = source.pictures(state, line);
    let start = line.to;
    for (let i = pictures.length - 1; i >= 0 && !line.text.slice(pictures[i].to - line.from, start - line.from).trim(); i--) start = pictures[i].from;
    return start < line.to ? start : null;
}

// ---------- How a picked object looks ----------

// The ring goes on the drawn object: a box or a diagram that starts where the block does, or the picture whose markup it is.
function drawnElement(view: EditorView, block: PickedBlock): HTMLElement | null {
    if (block.kind !== 'picture') {
        return [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-codebox, .cm-md-diagram')].find(el => view.posAtDOM(el) === block.from) ?? null;
    }
    return [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-picture')].find(el => {
        const line = view.state.doc.lineAt(view.posAtDOM(el));
        const range = pictureRange(line.text, { url: el.dataset.url ?? '', nth: Number(el.dataset.nth) });
        return range !== null && line.from + range[0] === block.from;
    }) ?? null;
}

const pickedLook = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { this.draw(); }
    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.startState.field(pickedBlock) !== update.state.field(pickedBlock)) this.draw();
    }
    draw() {
        this.view.requestMeasure({
            read: view => { const block = view.state.field(pickedBlock); return block && drawnElement(view, block); },
            write: (element, view) => {
                view.contentDOM.querySelectorAll('.picked').forEach(el => { if (el !== element) el.classList.remove('picked'); });
                element?.classList.add('picked');
            },
        });
    }
});

// The keys a picked object answers to, in a small tip under it (not over it, where it would hide a line of code).
const keysHint = showTooltip.compute([pickedBlock], state => {
    const block = state.field(pickedBlock);
    return block && {
        pos: block.from, above: false, arrow: false,
        create: view => {
            const dom = document.createElement('div');
            dom.className = 'cm-block-hint';
            for (const [key, does] of [['Enter', 'new line'], ['Backspace', 'delete'], ['Esc', 'done']]) {
                const item = document.createElement('span'), kbd = document.createElement('kbd');
                kbd.textContent = key;
                item.append(kbd, ` ${does}`);
                dom.append(item);
            }
            const element = () => { const el = drawnElement(view, block); return el?.matches('.cm-md-picture') ? el.querySelector('img') : el; };
            return { dom, offset: { x: 0, y: 6 }, getCoords: pos => element()?.getBoundingClientRect() ?? view.coordsAtPos(pos) ?? new DOMRect() };
        },
    };
});

export function blockSelection(source: BlockSource, on: (state: EditorState) => boolean): Extension {
    return [
        pickedBlock,
        Prec.high(pickedKeys),
        pickingKeys(source, on),
        keepOutOfPictureRuns(source, on),
        pickedLook,
        keysHint,
        // The editor's own cursor would show at the end of the hidden markup: the picked object shows where it is instead.
        EditorView.editorAttributes.compute([pickedBlock], state => ({ class: state.field(pickedBlock) ? 'cm-block-picked' : '' })),
        EditorView.domEventHandlers({ copy: (event, view) => copy(view, event, false), cut: (event, view) => copy(view, event, true) }),
        // Typing goes onto a new line after the object rather than into its hidden markup.
        EditorView.inputHandler.of((view, _from, _to, text) => {
            const block = view.state.field(pickedBlock);
            if (!block || text.includes('\n')) return false;
            lineAfter(view, block, text);
            return true;
        }),
    ];
}
