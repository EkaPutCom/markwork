// The block handle of the visual editor: beside the block the pointer is over, a "+" that adds a block after it (and opens
// the "/" menu there), a "−" that removes it, and a grip that drags it to another place. What a block is and how it moves is markdown/blocks.ts;
// here it is only drawn and wired to the pointer. The same move runs from the keyboard (Move Block Up / Down).

import { EditorSelection, EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { startCompletion } from '@codemirror/autocomplete';
import { blockAt, blocksOf, moveBlock, type Block } from '../../../src/markdown/blocks';
import { iconElement } from '../components/Icons';
import { domButton } from '../ui/dom';

// The blocks of each text, found once.
const found = new WeakMap<Text, { lines: string[]; blocks: Block[] }>();

function blocksIn(doc: Text): { lines: string[]; blocks: Block[] } {
    let result = found.get(doc);
    if (!result) {
        const lines = doc.toString().split('\n');
        found.set(doc, result = { lines, blocks: blocksOf(lines) });
    }
    return result;
}

// Move block `index` before block `before` (blocks.length: to the end), as one undo step. The cursor stays at the same place
// in the block it was in, or goes to its start when `keepCursor` is false. False when the move changes nothing.
export function moveBlockTo(view: EditorView, index: number, before: number, keepCursor: boolean): boolean {
    const { doc } = view.state;
    const { lines, blocks } = blocksIn(doc);
    const move = moveBlock(lines, blocks, index, before);
    if (!move) return false;
    const from = doc.line(move.from + 1).from, to = doc.line(move.to + 1).to;
    const startOf = (line: number) => from + move.lines.slice(0, line - move.from).reduce((n, l) => n + l.length + 1, 0);
    const old = blocks[index], head = view.state.selection.main.head, inBlock = head >= doc.line(old.start + 1).from && head <= doc.line(old.end + 1).to;
    const start = startOf(move.cursor);
    const anchor = keepCursor && inBlock ? start + (head - doc.line(old.start + 1).from) : start;
    view.dispatch({
        changes: { from, to, insert: move.lines.join('\n') },
        selection: EditorSelection.cursor(anchor),
        scrollIntoView: true, userEvent: 'move',
    });
    return true;
}

// Move the block the cursor is in one place up or down.
export function moveCursorBlock(view: EditorView, delta: -1 | 1): boolean {
    const { doc, selection } = view.state;
    const { blocks } = blocksIn(doc);
    const index = blockAt(blocks, doc.lineAt(selection.main.head).number - 1);
    if (index < 0) return false;
    return moveBlockTo(view, index, delta > 0 ? index + 2 : index - 1, true);
}

class BlockHandle {
    private readonly handle = document.createElement('div');
    private readonly grip = domButton({ label: 'Drag to move the block', content: iconElement('list-drag-handle'), size: 'icon-xs', className: 'size-5 cursor-grab text-muted-foreground' });
    private readonly marker = document.createElement('div');   // where a dragged block would land
    private index = -1;
    private dragging: { index: number; before: number } | null = null;
    private readonly stops: (() => void)[] = [];

    constructor(private readonly view: EditorView, private readonly on: (state: EditorState) => boolean) {
        // The editor keeps the focus and the selection while the handle is used.
        const add = domButton({ label: 'Add a block below', content: iconElement('list-add'), size: 'icon-xs', className: 'size-5 text-muted-foreground', onClick: () => this.addBlock() });
        const remove = domButton({ label: 'Remove block', content: iconElement('list-remove'), size: 'icon-xs', className: 'size-5 text-muted-foreground hover:text-destructive', onClick: () => this.removeBlock() });
        this.handle.className = 'cm-block-handle';
        this.handle.append(add, remove, this.grip);
        this.marker.className = 'cm-block-drop';
        view.dom.append(this.handle, this.marker);
        this.grip.addEventListener('pointerdown', event => this.startDrag(event));
        const listen = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
            target.addEventListener(type, handler);
            this.stops.push(() => target.removeEventListener(type, handler));
        };
        listen(view.dom, 'mousemove', event => this.hover(event));
        listen(view.dom, 'mouseleave', () => { if (!this.dragging) this.hide(); });
        listen(view.scrollDOM, 'scroll', () => this.hide());
    }

    update(update: ViewUpdate): void {
        if (update.docChanged || !this.on(update.state)) this.hide();
    }

    destroy(): void {
        for (const stop of this.stops) stop();
        this.handle.remove();
        this.marker.remove();
    }

    private hide(): void { this.handle.style.display = 'none'; this.index = -1; }

    // The vertical extent of a block on the page, in the editor's own coordinates.
    private extent(block: Block): { top: number; bottom: number } {
        const { doc } = this.view.state, base = this.view.documentTop - this.view.dom.getBoundingClientRect().top;
        return { top: base + this.view.lineBlockAt(doc.line(block.start + 1).from).top, bottom: base + this.view.lineBlockAt(doc.line(block.end + 1).from).bottom };
    }

    // The block under a pointer height, from the text's margin or the text itself.
    private blockAtY(clientY: number): number {
        const rect = this.view.contentDOM.getBoundingClientRect();
        const pos = this.view.posAtCoords({ x: rect.left + Math.min(80, rect.width / 2), y: clientY }, false);
        const { doc } = this.view.state;
        return blockAt(blocksIn(doc).blocks, doc.lineAt(pos).number - 1);
    }

    private hover(event: MouseEvent): void {
        if (this.dragging || !this.on(this.view.state) || this.handle.contains(event.target as Node)) return;
        const index = this.blockAtY(event.clientY);
        if (index < 0) { this.hide(); return; }
        if (index === this.index && this.handle.style.display === 'flex') return;
        this.index = index;
        const block = blocksIn(this.view.state.doc).blocks[index], { top, bottom } = this.extent(block);
        const pad = parseFloat(getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
        const text = this.view.contentDOM.getBoundingClientRect().left - this.view.dom.getBoundingClientRect().left + pad;
        this.handle.style.display = 'flex';
        this.handle.style.left = `${Math.max(4, text - 64)}px`;
        // Level with the first line of the block (a table or a tall block is only as tall as its first rows).
        this.handle.style.top = `${top + (Math.min(bottom - top, 36) - 20) / 2}px`;
    }

    // A new empty block after this one, with the "/" menu open in it.
    private addBlock(): void {
        const { doc } = this.view.state, block = blocksIn(doc).blocks[this.index];
        if (!block) return;
        const end = doc.line(block.end + 1).to;
        this.view.dispatch({ changes: { from: end, insert: '\n\n/' }, selection: EditorSelection.cursor(end + 3), scrollIntoView: true, userEvent: 'input' });
        this.view.focus();
        startCompletion(this.view);
        this.hide();
    }

    private removeBlock(): void {
        const { doc } = this.view.state, block = blocksIn(doc).blocks[this.index];
        if (!block) return;
        const from = doc.line(block.start + 1).from, to = doc.line(block.end + 1).to;
        this.view.dispatch({ changes: { from, to }, selection: EditorSelection.cursor(from), scrollIntoView: true, userEvent: 'remove.block' });
        this.view.focus();
        this.hide();
    }

    // Dragging: a line shows where the block would land, and letting go puts it there.
    private startDrag(event: PointerEvent): void {
        if (this.index < 0 || event.button !== 0) return;
        event.preventDefault();
        const drag = this.dragging = { index: this.index, before: this.index };
        this.view.dom.classList.add('cm-block-dragging');
        const move = (e: PointerEvent) => this.dragOver(e, drag);
        const finish = (apply: boolean) => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('keydown', key, true);
            this.view.dom.classList.remove('cm-block-dragging');
            this.marker.style.display = 'none';
            this.dragging = null;
            this.hide();
            if (apply) moveBlockTo(this.view, drag.index, drag.before, false);
        };
        const up = () => finish(true);
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('keydown', key, true);
    }

    private dragOver(event: PointerEvent, drag: { index: number; before: number }): void {
        const { view } = this, { blocks } = blocksIn(view.state.doc);
        // Near the top or bottom edge the page scrolls, so a block can be taken further than the window shows.
        const box = view.scrollDOM.getBoundingClientRect();
        if (event.clientY < box.top + 40) view.scrollDOM.scrollTop -= 14;
        else if (event.clientY > box.bottom - 40) view.scrollDOM.scrollTop += 14;
        const y = event.clientY - view.dom.getBoundingClientRect().top;
        let before = blocks.length;
        for (let k = 0; k < blocks.length; k++) {
            const { top, bottom } = this.extent(blocks[k]);
            if (y < (top + bottom) / 2) { before = k; break; }
        }
        drag.before = before;
        const stays = before === drag.index || before === drag.index + 1;
        const at = before < blocks.length ? this.extent(blocks[before]).top - 4 : this.extent(blocks[blocks.length - 1]).bottom + 4;
        const rect = view.contentDOM.getBoundingClientRect(), domRect = view.dom.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
        Object.assign(this.marker.style, {
            display: stays ? 'none' : 'block', top: `${at}px`,
            left: `${rect.left - domRect.left + pad}px`, width: `${rect.width - 2 * pad}px`,
        });
    }
}

// The block handle, for the text where `on` holds.
export function blockHandle(on: (state: EditorState) => boolean): Extension {
    return ViewPlugin.define(view => new BlockHandle(view, on));
}
