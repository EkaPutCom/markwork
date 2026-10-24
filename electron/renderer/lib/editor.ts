// The Markdown editor of the Electron window: CodeMirror 6 with the app's own Markdown parser (markdown/highlight.ts) for
// styling and for hiding syntax away from the cursor, and the app's editor commands (markdown/editcommands.ts) for
// bold, links, lists, and tables. Only the drawing is here; what the syntax is and what a command does is shared with the
// core. CodeMirror counts UTF-16 units, as the commands do; the protocol's code points are converted at this edge.

import { Annotation, EditorSelection, EditorState, Facet, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap, showTooltip, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, redo, undo } from '@codemirror/commands';
import { closeSearchPanel, findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search } from '@codemirror/search';
import { HighlightCache, textLines, type CodeBlock, type HangingIndent, type HighlightResult, type Styles } from '../../../src/markdown/highlight.js';
import { block, continueBlock, enterInTable, heading, indentListItem, inlineFormatsAt, isInCodeBlock, lineKindOf, link, runTableCommand, setLineKind, tabInTable, togglePrefix, wrap,
    type TableCommand, type TextEdit, type TextState } from '../../../src/markdown/editcommands.js';
import { acceptCompletion, autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { linkAt, taskToggleAt, wikiLinkAt } from '../../../src/markdown/clicks.js';
import { suggestNotes, wikiQuery, wikiTargetFor } from '../../../src/markdown/wikilink.js';
import { conflictDecorations } from './conflicts.js';
import { createFindBar, findBarOf } from './findbar.js';
import { DiagramWidget } from './diagrams.js';
import { diagramKind } from '../../../src/markdown/diagram.js';
import { TableWidget, focusCell, gridAt, tableOf } from './tables.js';
import { CodeBoxWidget, codeColors, focusCode, spansOf } from './codecolor.js';
import { PicturesWidget, pictureRange, pictures, type PictureItem, type ZoomedImage } from './images.js';
import { cpToU16, makeU16Map } from '../../../src/markdown/offsets.js';
import type { EditCommands, TableOperation } from '../../../src/app/commands.js';
import type { Change } from '../../../src/app/protocol/messages.js';
import { blockHandle, moveCursorBlock } from './blockhandle.js';
import { blockSelection, pick, removeBlock, type BlockSource, type PickedBlock } from './blockselect.js';
import { nameEffect, recorder } from './inspect/recorder.js';
import { LIST_PREFIX_PX, linkEditor, listPrefix, openImageEditor, openLinkEditor, selectionMenu, setVisual, slashGlyph, slashSource, visualEditing, visualMode, type Concealed } from './visual.js';

// A change that comes from the core (or opens a text), not from the user: it is not reported back as an edit.
const External = Annotation.define<boolean>();
const setSource = StateEffect.define<boolean>();
const setFocus = StateEffect.define<boolean>();
const focusMode = StateField.define<boolean>({
    create: () => false,
    update: (on, tr) => tr.effects.reduce((v, e) => e.is(setFocus) ? e.value : v, on),
});
const dim = Decoration.mark({ class: 'cm-md-dim' });
const refresh = StateEffect.define<null>();   // the document got a file: its pictures can be found now

const sourceMode = StateField.define<boolean>({
    create: () => false,
    update: (on, tr) => tr.effects.reduce((v, e) => e.is(setSource) ? e.value : v, on),
});
nameEffect(setSource, 'setSource');
nameEffect(setFocus, 'setFocus');
nameEffect(setVisual, 'setVisual');
nameEffect(refresh, 'refresh');

// One style per name: the class is the name. The parser reads a style by name and carries it as it is.
const styles = new Proxy({}, { get: (_t, name) => `cm-md-${String(name)}` }) as Styles<string>;
// Names that also color the whole line, not only the text on it.
const LINE_STYLES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'codeblock', 'fence', 'quote', 'quote2', 'quote3', 'hr', 'tablehead', 'tablesep', 'table']);

const marks = new Map<string, Decoration>();
const mark = (name: string) => {
    let d = marks.get(name);
    if (!d) marks.set(name, d = Decoration.mark({ class: name }));
    return d;
};
const lineDecos = new Map<string, Decoration>();
const lineDeco = (name: string) => {
    let d = lineDecos.get(name);
    if (!d) lineDecos.set(name, d = Decoration.line({ class: name }));
    return d;
};
const hidden = Decoration.replace({});

// Hanging indent: a wrapped list item lines up with its text, not under the marker. The style the parser hands back
// carries the width of the prefix in pixels; the line gets a left padding of that width and an equal negative indent.
const INDENT_PREFIX = 'cm-li:';
const indentDecos = new Map<number, Decoration>();
const indentDeco = (width: number) => {
    let d = indentDecos.get(width);
    if (!d) indentDecos.set(width, d = Decoration.line({ attributes: { style: `padding-left:${width}px;text-indent:-${width}px` } }));
    return d;
};
const TAB_WIDTH = 4;
let canvas: CanvasRenderingContext2D | null = null;
const prefixWidths = new Map<string, number>();

// The drawn width of a list prefix (indent, bold marker, gap, bold monospace task box, tail) in the editor's font.
function measurePrefix(indent: string, marker: string, gap: string, task: string, tail: string): number {
    const key = `${indent}\n${marker}\n${gap}\n${task}\n${tail}`;
    let width = prefixWidths.get(key);
    if (width !== undefined) return width;
    const style = getComputedStyle(document.documentElement);
    const text = style.getPropertyValue('--font-text') || 'sans-serif', mono = style.getPropertyValue('--font-mono') || 'monospace';
    const ctx = canvas ??= document.createElement('canvas').getContext('2d')!;
    const size = 16;
    const measure = (s: string, font: string) => { ctx.font = font; return ctx.measureText(s.replace(/\t/g, ' '.repeat(TAB_WIDTH))).width; };
    width = measure(indent + gap, `${size}px ${text}`) + measure(marker, `700 ${size}px ${text}`);
    if (task) width += measure(task, `700 ${size}px ${mono}`) + measure(tail, `${size}px ${text}`);
    width = Math.round(width);
    prefixWidths.set(key, width);
    return width;
}

const hanging: HangingIndent<string> = {
    tag: (indent, marker, gap, task, tail) => INDENT_PREFIX + measurePrefix(indent, marker, gap, task, tail),
};

function linesOf(doc: Text) {
    return textLines(doc.toString());
}

// The styled and concealed text. The parse is kept per document (the cache reuses lines that did not change); the
// decorations are rebuilt when the text, the cursor line, or source mode changes.
// The pictures of each parsed text by line (from 0), for the Zoom Image command.
const pictureLines = new WeakMap<Text, Map<number, PictureItem[]>>();
// The parse of each text, for what the toolbar shows at the cursor.
const parses = new WeakMap<Text, HighlightResult<string>>();

// The visual editor is on, and the editor does not show the source.
export const visualOn = (state: EditorState): boolean => state.field(visualMode) && !state.field(sourceMode);
// The editor shows the file as it is written.
export const sourceOn = (state: EditorState): boolean => state.field(sourceMode);
// Focus mode dims all but the cursor's paragraph.
export const focusOn = (state: EditorState): boolean => state.field(focusMode);

// What the decorations of a state draw, what they hide (visual.ts), how long drawing them took, and what of the selection
// they were drawn for (selectionKey).
export interface Drawn { decorations: DecorationSet; concealed: Concealed; ms: number; key: string }

// The field of a state that holds its drawing (each state gets its own, syntaxField), and how it draws one, for the
// inspector (inspect/).
interface Drawing { field: StateField<Drawn>; build: (state: EditorState) => Drawn }
const drawnField = Facet.define<Drawing, Drawing | null>({ combine: fields => fields[0] ?? null });
export function drawnOf(state: EditorState): Drawn | null {
    const drawing = state.facet(drawnField);
    return drawing ? state.field(drawing.field, false) ?? null : null;
}
// The state's drawing made again from nothing: what the one it keeps should equal (the inspector's kept-drawing check).
export const freshDrawing = (state: EditorState): Drawn | null => state.facet(drawnField)?.build(state) ?? null;

// The lines (from 0) of the paragraph of the selection's lines (up to blank lines): what focus mode does not dim.
function focusParagraph(doc: Text, first: number, last: number): [number, number] {
    const blank = (n: number) => !doc.line(n + 1).text.trim();
    let b0 = Math.min(first, doc.lines - 1), b1 = Math.min(last, doc.lines - 1);
    while (b0 > 0 && !blank(b0 - 1)) b0--;
    while (b1 < doc.lines - 1 && !blank(b1 + 1)) b1++;
    return [b0, b1];
}

// The markers of a parse that span lines (front matter, a fence that is not drawn as a box): the visual editor hides
// them unless the selection touches them. The fences of a code block it draws as a box, and anything in a table, are
// never shown, so the selection entering them changes nothing. Kept per parse; a long text has tens of thousands of
// markers and few of these.
const multiLineMarkers = new WeakMap<HighlightResult<string>, [number, number][]>();
function spanningMarkers(result: HighlightResult<string>, lines: number): [number, number][] {
    let found = multiLineMarkers.get(result);
    if (found) return found;
    const boxes: [number, number][] = [
        ...result.codeBlocks.filter(b => b.closed && !diagramKind(b) && b.endLine < lines).map(b => [b.startLine, b.endLine] as [number, number]),
        ...result.tables.filter(t => t.end < lines).map(t => [t.start, t.end] as [number, number]),
    ];
    found = result.markers.filter(m => m[2] !== m[3] && !boxes.some(([a, b]) => m[2] >= a && m[2] <= b)).map(m => [m[2], m[3]]);
    multiLineMarkers.set(result, found);
    return found;
}

// All that the drawing of a text takes from the selection (the build below reads it in these places only). A selection
// change that keeps the key keeps the drawing, so moving the cursor does not draw the whole text again:
// - focus mode: the paragraph it does not dim;
// - the live view: the lines of the selection, where markers show, and tables and code blocks are their text;
// - the visual editor: the diagrams the selection touches (shown as their source) and the markers spanning lines it
//   touches (shown); a one-line marker is hidden on the cursor line too, and tables and code stay grids and boxes.
function selectionKey(state: EditorState, result: HighlightResult<string>): string {
    const { doc } = state, main = state.selection.main;
    const first = doc.lineAt(Math.min(main.anchor, main.head)).number - 1, last = doc.lineAt(Math.max(main.anchor, main.head)).number - 1;
    const focus = state.field(focusMode) ? focusParagraph(doc, first, last).join('-') : '';
    const touches = (a: number, b: number) => last >= a && first <= b;
    // Diagrams are drawn in the live view too, but there the lines already decide.
    if (state.field(sourceMode)) return `source|${focus}`;
    if (!visualOn(state)) return `live|${first}-${last}|${focus}`;
    const diagrams = result.codeBlocks.filter(b => diagramKind(b) && touches(b.startLine, b.endLine)).map(b => b.startLine);
    const spanning = spanningMarkers(result, doc.lines).filter(([a, b]) => touches(a, b)).map(([a]) => a);
    return `visual|${diagrams.join(',')}|${spanning.join(',')}|${focus}`;
}
// The parse of a text the editor has drawn.
export const parseOf = (doc: Text): HighlightResult<string> | null => parses.get(doc) ?? null;

function syntaxField(events: EditorEvents, languageLoaded: () => void): Drawing {
    const cache = new HighlightCache<string>(styles, hanging);
    let parsed: { doc: Text; result: ReturnType<HighlightCache<string>['update']> } | null = null;

    const build = (state: EditorState): Drawn => {
        const start = performance.now();
        const drawn = draw(state);
        return { ...drawn, ms: performance.now() - start, key: selectionKey(state, parses.get(state.doc)!) };
    };
    const draw = (state: EditorState): Omit<Drawn, 'ms' | 'key'> => {
        const { doc } = state;
        if (parsed?.doc !== doc) parsed = { doc, result: cache.update(linesOf(doc)) };
        const { result } = parsed;
        parses.set(doc, result);
        const visual = visualOn(state);
        const hiddenRanges: ReturnType<Decoration['range']>[] = [];
        const prefixes = new Map<number, number>();
        const prefixEnd = (lineFrom: number, end: number) => prefixes.set(lineFrom, Math.max(prefixes.get(lineFrom) ?? end, end));
        const text = doc.toString();
        const u16 = makeU16Map(text);
        const ranges: ReturnType<Decoration['range']>[] = [];
        // A table is a grid unless the cursor is in it (or the editor shows the source); the visual editor keeps the grid and edits its cells.
        const sel = state.selection.main;
        const selFirst = doc.lineAt(Math.min(sel.anchor, sel.head)).number - 1, selLast = doc.lineAt(Math.max(sel.anchor, sel.head)).number - 1;
        const conflicts = conflictDecorations(doc);
        ranges.push(...conflicts.ranges);
        const grids = new Set<number>(conflicts.covered);
        const boxed = new Set<CodeBlock>();
        // Focus mode: all text outside the paragraph of the cursor (lines up to blank ones) is dimmed.
        let paragraph: [number, number] | null = null;   // lines (from 0) of the cursor's paragraph, in focus mode
        if (state.field(focusMode)) {
            const [b0, b1] = paragraph = focusParagraph(doc, selFirst, selLast);
            const from = doc.line(b0 + 1).from, to = doc.line(b1 + 1).to;
            if (from > 0) ranges.push(dim.range(0, from));
            if (to < doc.length) ranges.push(dim.range(to, doc.length));
        }
        // A block widget outside the cursor's paragraph is dimmed too (the marks above cannot reach inside a widget).
        const dimmed = (first: number, last: number) => paragraph !== null && (last < paragraph[0] || first > paragraph[1]);
        if (!state.field(sourceMode)) {
            for (const t of result.tables) {
                if (t.end >= doc.lines || (!visual && selLast >= t.start && selFirst <= t.end)) continue;
                const lines = Array.from({ length: t.end - t.start + 1 }, (_, k) => doc.line(t.start + k + 1).text);
                ranges.push(Decoration.replace({ widget: new TableWidget(lines, tableOf(lines), dimmed(t.start, t.end), visual), block: true }).range(doc.line(t.start + 1).from, doc.line(t.end + 1).to));
                for (let k = t.start; k <= t.end; k++) grids.add(k);
            }
            // A code block is a box that scrolls sideways, with its colors inside. The visual editor keeps the box and edits the
            // code in it; elsewhere the cursor in the block shows its lines.
            for (const block of result.codeBlocks) {
                if (!block.closed || diagramKind(block) || block.endLine >= doc.lines) continue;
                if (!visual && (!block.text.trim() || (selLast >= block.startLine && selFirst <= block.endLine))) continue;
                ranges.push(Decoration.replace({ widget: new CodeBoxWidget(block.text, spansOf(block, languageLoaded).spans, dimmed(block.startLine, block.endLine), visual, block.endLine - block.startLine - 1), block: true }).range(doc.line(block.startLine + 1).from, doc.line(block.endLine + 1).to));
                for (let k = block.startLine; k <= block.endLine; k++) grids.add(k);
                boxed.add(block);
            }
            // The same for a Mermaid or DBML block: a picture unless the cursor is in the block (fences included).
            for (const block of result.codeBlocks) {
                const kind = diagramKind(block);
                if (!kind || block.endLine >= doc.lines || (selLast >= block.startLine && selFirst <= block.endLine)) continue;
                const open = (view: EditorView, element: HTMLElement) => { view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.posAtDOM(element)).to + 1 }, scrollIntoView: true }); view.focus(); };
                ranges.push(Decoration.replace({ widget: new DiagramWidget(kind, block.text, open, events.zoomImage, dimmed(block.startLine, block.endLine)), block: true }).range(doc.line(block.startLine + 1).from, doc.line(block.endLine + 1).to));
                for (let k = block.startLine; k <= block.endLine; k++) grids.add(k);
            }
        }
        result.spans.forEach((spans, i) => {
            if (i >= doc.lines || grids.has(i)) return;
            const line = doc.line(i + 1);
            for (const [name, a, b] of spans) {
                // The visual editor gives a list item's lines the hanging indent of its own marker (below).
                if (name.startsWith(INDENT_PREFIX)) { if (!visual) ranges.push(indentDeco(Number(name.slice(INDENT_PREFIX.length))).range(line.from)); continue; }
                const from = u16(result.starts[i] + a), to = Math.min(u16(result.starts[i] + b), line.to);
                if (LINE_STYLES.has(name.replace('cm-md-', ''))) ranges.push(lineDeco(`${name}-line`).range(line.from));
                if (to > from) ranges.push(mark(name).range(from, to));
                if (visual && name === 'cm-md-bullet' && to > from) {
                    const item = listPrefix(ranges, line.text, line.from, from);
                    if (!item) continue;
                    prefixEnd(line.from, item.end);
                    // Not in a quote, which has its own margin: the lines that wrap under the item start where its text does.
                    if (from - line.from === item.indent.length) ranges.push(indentDeco(measurePrefix(item.indent, '', '', '', '') + LIST_PREFIX_PX).range(line.from));
                }
            }
        });
        ranges.push(...codeColors(result.codeBlocks.filter(b => !boxed.has(b)), (block, i) => u16(block.start) + i, languageLoaded));
        const found = state.field(sourceMode) ? new Map<number, PictureItem[]>() : pictures(result.images, events.baseDir());
        pictureLines.set(doc, found);
        const pictureAt = (view: EditorView, element: HTMLElement, item: PictureItem): PickedBlock | null => {
            const line = view.state.doc.lineAt(view.posAtDOM(element));
            const range = pictureRange(line.text, item);
            return range && { kind: 'picture', from: line.from + range[0], to: line.from + range[1] };
        };
        const widgetEvents = {
            activate: (view: EditorView, element: HTMLElement, item: PictureItem) => { const p = pictureAt(view, element, item); if (p) pick(view, p); },
            zoom: events.zoomImage,
            edit: (view: EditorView, element: HTMLElement, item: PictureItem) => openImageEditor(view, view.posAtDOM(element), item.url, item.nth),
            remove: (view: EditorView, element: HTMLElement, item: PictureItem) => { const p = pictureAt(view, element, item); if (p) removeBlock(view, p); },
        };
        for (const [i, items] of found) {
            if (i < doc.lines) ranges.push(Decoration.widget({ widget: new PicturesWidget(items, widgetEvents, dimmed(i, i)), block: true, side: 1 }).range(doc.line(i + 1).to));
        }
        if (!state.field(sourceMode)) {
            const { main } = state.selection;
            const first = doc.lineAt(Math.min(main.anchor, main.head)).number - 1, last = doc.lineAt(Math.max(main.anchor, main.head)).number - 1;
            for (const [a, b, r0, r1] of result.markers) {
                if (grids.has(r0)) continue;
                // The visual editor hides a one-line marker on the cursor line too; a code block's fences still show
                // while the cursor is in the block.
                if (r1 < first || r0 > last || (visual && r0 === r1)) {
                    const from = u16(a), to = u16(b);
                    if (to <= from) continue;
                    ranges.push(hidden.range(from, to));
                    hiddenRanges.push(hidden.range(from, to));
                    const line = doc.lineAt(from);
                    if (visual && from === line.from) prefixEnd(line.from, to);
                }
            }
        }
        // The space between two pictures is hidden with them: it would be a place for the cursor that shows as one more space
        // after the line's text, while it stands between two pictures.
        if (visual) {
            for (const [i, items] of found) {
                if (i >= doc.lines || grids.has(i)) continue;
                const line = doc.line(i + 1), marks = items.map(item => pictureRange(line.text, item)).filter(r => r !== null).sort((a, b) => a[0] - b[0]);
                for (let k = 1; k < marks.length; k++) {
                    const from = line.from + marks[k - 1][1], to = line.from + marks[k][0];
                    if (to > from && !doc.sliceString(from, to).trim()) { ranges.push(hidden.range(from, to)); hiddenRanges.push(hidden.range(from, to)); }
                }
            }
        }
        return { decorations: Decoration.set(ranges, true), concealed: { hidden: Decoration.set(hiddenRanges, true), prefixes } };
    };

    const field = StateField.define<Drawn>({
        create: build,
        update: (value, tr) => {
            if (tr.docChanged || tr.effects.some(e => e.is(setSource) || e.is(setFocus) || e.is(setVisual) || e.is(refresh))) return build(tr.state);
            // The same text: a selection that leaves the key as it was leaves the drawing as it was.
            if (!tr.selection) return value;
            const result = parses.get(tr.state.doc);
            return result && selectionKey(tr.state, result) === value.key ? value : build(tr.state);
        },
        provide: f => EditorView.decorations.from(f, drawn => drawn.decorations),
    });
    return { field, build };
}

// The objects blockselect.ts picks, from the last drawing of the text: its closed fenced blocks (code and diagrams) and the
// pictures each line shows.
const blockSource: BlockSource = {
    blocks: state => {
        const { doc } = state, parse = parses.get(doc);
        return (parse?.codeBlocks ?? []).filter(b => b.closed && b.endLine < doc.lines).map(b => ({
            kind: diagramKind(b) ? 'diagram' : 'code', from: doc.line(b.startLine + 1).from, to: doc.line(b.endLine + 1).to,
        }));
    },
    pictures: (state, line) => (pictureLines.get(state.doc)?.get(line.number - 1) ?? []).flatMap(item => {
        const range = pictureRange(line.text, item);
        return range ? [{ kind: 'picture' as const, from: line.from + range[0], to: line.from + range[1] }] : [];
    }).sort((a, b) => a.from - b.from),
};

const stateOf = (view: EditorView): TextState => {
    const { main } = view.state.selection;
    return { text: view.state.doc.toString(), anchor: main.anchor, head: main.head };
};

// A table cell or a code block of the visual editor is being edited where it is: the text's cursor is behind it.
const editingInPlace = (view: EditorView): boolean => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.matches('.cm-md-cell, .cm-md-codeedit') && view.dom.contains(active);
};

// Apply a command's edit as one undo step: the changes against the old text, the selection in the new one. The cursor
// is brought into view, unless a cell or code block is being edited in place: then the page stays where it is (scrolling
// to the text behind a grid would bring the grid's top to the edge, and CodeMirror's own correction for a grid drawn
// again with a new row would move it too), and the cell that takes the focus shows itself.
function applyEdit(view: EditorView, edit: TextEdit): void {
    const inPlace = editingInPlace(view);
    view.dispatch({
        changes: edit.changes.map(c => ({ from: c.from, to: c.to, insert: c.insert })),
        selection: EditorSelection.single(edit.selection.anchor, edit.selection.head),
        scrollIntoView: !inPlace, effects: inPlace ? view.scrollSnapshot() : [],
        userEvent: 'input',
    });
}

const run = (view: EditorView, command: (state: TextState) => TextEdit | null): boolean => {
    const edit = command(stateOf(view));
    if (!edit) return false;
    applyEdit(view, edit);
    return true;
};

// The cursor's line is inside a fenced code block: Enter there is a plain line break, not a list or quote continuing.
// In the visual editor a picture's ![alt](url) is hidden and the picture is drawn under its line, so a cursor before pictures that end
// the line (where blockselect.ts keeps it) looks as if it were at the end of the text. Enter there breaks the line before them: the
// new line comes right under the text, with the pictures, instead of under the pictures.
const PICTURES_TO_END = /^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/;
function enterBeforePictures(view: EditorView): boolean {
    const sel = view.state.selection.main;
    if (!sel.empty || !visualOn(view.state) || inCode(view)) return false;
    const line = view.state.doc.lineAt(sel.head);
    // A cursor among the pictures that end the line (blockselect.ts keeps a moved cursor out of them) stands before them.
    const run = /(?:!\[[^\]]*\]\([^)]*\)\s*)+$/.exec(line.text);
    const col = run ? Math.min(sel.head - line.from, run.index) : sel.head - line.from;
    const before = line.text.slice(0, col), after = line.text.slice(col);
    if (!before.trim() || !PICTURES_TO_END.test(after)) return false;
    const from = line.from + before.trimEnd().length, to = line.from + col + after.length - after.trimStart().length;
    view.dispatch({ changes: { from, to, insert: '\n' }, selection: { anchor: from + 1 }, scrollIntoView: true, userEvent: 'input' });
    return true;
}

const inCode = (view: EditorView): boolean => {
    const { doc, selection } = view.state;
    const line = doc.lineAt(selection.main.head).number - 1;
    return isInCodeBlock(Array.from({ length: Math.min(line, doc.lines) }, (_, i) => doc.line(i + 1).text), line);
};

const TABLE_OPERATIONS: Record<TableOperation, TableCommand> = {
    'row-below': 'row-below', 'row-above': 'row-above', 'col-right': 'col-right', 'col-left': 'col-left',
    'delete-row': 'delete-row', 'delete-col': 'delete-col', 'align-left': 'align-left', 'align-center': 'align-center',
    'align-right': 'align-right', 'format': 'format',
};

const TABLE_MESSAGES = {
    'not-in-table': 'The cursor is not in a table',
    'row-above-header': 'A row cannot go above the header',
    'delete-header': 'The header row cannot be deleted',
    'delete-last-column': 'The last column cannot be deleted',
};

// Where a click landed: the line's text and the column in code points (what markdown/clicks.ts counts in).
function clickPlace(view: EditorView, event: MouseEvent) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return null;
    const line = view.state.doc.lineAt(pos);
    return { line, text: line.text, column: Array.from(line.text.slice(0, pos - line.from)).length };
}

// Note names after [[ (markdown/wikilink.ts decides what matches). Choosing one closes the link with ]] unless it is there.
// In the visual editor "/" offers the blocks too (visual.ts).
function suggestions(events: EditorEvents): Extension {
    const source = async (context: CompletionContext) => {
        const line = context.state.doc.lineAt(context.pos);
        const query = wikiQuery(line.text.slice(0, context.pos - line.from));
        if (query === null || (!context.explicit && context.state.selection.main.from !== context.state.selection.main.to)) return null;
        const names = await events.noteNames();
        if (context.aborted) return null;
        const options = suggestNotes(query, names).map((file, i) => {
            const slash = file.lastIndexOf('/');
            const target = wikiTargetFor(file, names);
            return {
                label: target, detail: slash > 0 ? file.slice(0, slash) : undefined, boost: -i,
                apply: (view: EditorView, _c: unknown, from: number, to: number) => {
                    const closed = view.state.doc.sliceString(to, to + 2) === ']]';
                    view.dispatch({
                        changes: { from, to, insert: closed ? target : `${target}]]` },
                        selection: { anchor: from + target.length + 2 },
                        userEvent: 'input.complete',
                    });
                },
            };
        });
        return options.length ? { from: context.pos - query.length, options, filter: false } : null;
    };
    return autocompletion({ override: [source, slashSource(events.run, visualOn)], icons: false, defaultKeymap: true, interactionDelay: 0, addToOptions: [slashGlyph] });
}

// A click on a task box flips it; Ctrl (or Cmd) + click on a link opens it. A plain click only puts the cursor there, so the link can be
// edited; the tooltip over a link (linkTooltip) has the button that opens it.
function clicks(events: EditorEvents): Extension {
    return EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.button !== 0 || event.shiftKey || event.altKey) return false;
            const place = clickPlace(view, event);
            if (!place) return false;
            const target = event.target as HTMLElement | null;
            if (event.ctrlKey || event.metaKey) {
                const note = wikiLinkAt(place.text, place.column);
                if (note) {
                    events.openNote(note.target + (note.heading ? `#${note.heading}` : '') + (note.alias ? `|${note.alias}` : ''));
                    return true;
                }
                const uri = linkAt(place.text, place.column);
                if (!uri) return false;
                events.openLink(uri);
                return true;
            }
            if (!target?.closest('.cm-md-task, .cm-md-taskdone')) return false;
            const toggle = taskToggleAt(place.text, place.column);
            if (!toggle) return false;
            const at = place.line.from + cpToU16(place.text, toggle.column);
            view.dispatch({ changes: { from: at, to: at + 1, insert: toggle.text }, userEvent: 'input' });
            return true;
        },
    });
}

const OPEN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const SOURCE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';
const GO_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';

// The tooltip of the link the cursor is in: a button to open it, a web address in the browser or a note in its own tab. A click on a
// link puts the cursor there, so the tooltip shows at once.
interface LinkTarget { pos: number; note: string | null; uri: string | null; editable: boolean }   // editable: a [text](url) link, which the link box edits

function linkTargetAt(state: EditorState): LinkTarget | null {
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const line = state.doc.lineAt(sel.head);
    const column = Array.from(line.text.slice(0, sel.head - line.from)).length;
    const wiki = wikiLinkAt(line.text, column);
    const note = wiki && wiki.target + (wiki.heading ? `#${wiki.heading}` : '') + (wiki.alias ? `|${wiki.alias}` : '');
    const uri = note ? null : linkAt(line.text, column);
    if (!note && !uri) return null;
    const inImage = [...line.text.matchAll(/!\[[^\]]*\]\([^)]*\)/g)].some(m => sel.head - line.from >= m.index && sel.head - line.from <= m.index + m[0].length);
    if (inImage) return null;
    const editable = !note && [...line.text.matchAll(/(?<!!)\[[^\]]*\]\([^)]*\)/g)].some(m => sel.head - line.from >= m.index && sel.head - line.from <= m.index + m[0].length);
    return { pos: sel.head, note, uri, editable };
}

function linkTooltip(events: EditorEvents): Extension {
    const button = (label: string, icon: string, run: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = icon;
        b.title = label;
        b.setAttribute('aria-label', label);
        b.addEventListener('mousedown', event => event.preventDefault());
        b.addEventListener('click', run);
        return b;
    };
    const create = (view: EditorView, target: LinkTarget) => {
        const dom = document.createElement('div');
        dom.className = 'cm-link-open';
        dom.append(target.note
            ? button(`Go to ${target.note}`, GO_ICON, () => events.openNote(target.note!))
            : button(`Open ${target.uri}`, OPEN_ICON, () => events.openLink(target.uri!)));
        if (target.editable) dom.append(button('Edit link', SOURCE_ICON, () => openLinkEditor(view)));
        return { dom };
    };
    return StateField.define<LinkTarget | null>({
        create: linkTargetAt,
        update(value, tr) {
            if (!tr.docChanged && !tr.selection) return value;
            const next = linkTargetAt(tr.state);
            return next && value && next.note === value.note && next.uri === value.uri ? { ...value, pos: tr.changes.mapPos(value.pos) } : next;
        },
        provide: f => showTooltip.from(f, target => target && { pos: target.pos, above: true, create: view => create(view, target) }),
    });
}

export interface EditorEvents {
    changed(text: string): void;     // the user changed the text
    moved(line: number, column: number): void;   // the cursor or selection moved (from 1)
    message(text: string): void;
    openLink(uri: string): void;     // a link was Ctrl+clicked
    openNote(link: string): void;    // a [[wikilink]] was Ctrl+clicked: what is between the brackets
    zoomImage(image: ZoomedImage): void;     // a picture was double-clicked, or the Zoom Image command ran
    baseDir(): string | null;        // the folder of the document: where its relative picture paths start
    noteNames(): Promise<string[]>;  // the notes a [[ may link to, relative to the folder
    run(id: string, arg?: boolean): void;    // run a command of the window (the visual editor's menus)
    format(format: FormatAt): void;  // what the text at the cursor is changed: the toolbar shows it
}

// What the text at the cursor is: the kind of its line (markdown/editcommands.ts LineKind, or 'table' or 'code') and
// the inline formats around it (bold, italic, strike, code, link, mark).
export interface FormatAt { block: string; marks: string[] }

const INLINE_FORMATS = new Set(['bold', 'italic', 'strike', 'code', 'link', 'mark']);

// A table cell's formats are read as a line's are: Bold is pressed in a bold word of a cell too.
function formatAt(state: EditorState): FormatAt {
    const sel = state.selection.main, head = sel.head, line = state.doc.lineAt(head), i = line.number - 1;
    const result = parses.get(state.doc);
    const kind = result?.tables.some(t => i >= t.start && i <= t.end) ? 'table' : lineKindOf(line.text).kind;
    if (!result) return { block: kind, marks: [] };
    if (result.codeBlocks.some(b => i >= b.startLine && i <= b.endLine)) return { block: 'code', marks: [] };
    // A selection has a format when all it shows has it (the hidden markers at its ends or not).
    if (!sel.empty) return { block: kind, marks: sel.from >= line.from && sel.to <= line.to ? inlineFormatsAt(line.text, sel.from - line.from, sel.to - line.from) : [] };
    const column = result.starts[i] + Array.from(line.text.slice(0, head - line.from)).length;
    const marks = new Set<string>();
    for (const [name, a, b] of result.spans[i] ?? []) {
        const format = name.replace('cm-md-', '');
        // A span covers the formatted text without its markers: a cursor at either end types into it.
        if (column < result.starts[i] + a || column > result.starts[i] + b) continue;
        if (format === 'bolditalic') { marks.add('bold'); marks.add('italic'); } else if (INLINE_FORMATS.has(format)) marks.add(format);
    }
    return { block: kind, marks: [...marks].sort() };
}

export class MarkdownEditor {
    readonly view: EditorView;
    // The text the user is typing into, kept for each tab so its undo history and cursor survive switching tabs.
    private readonly states = new Map<number, EditorState>();

    constructor(parent: HTMLElement, private readonly events: EditorEvents) {
        this.view = new EditorView({ state: this.fresh(''), parent });
    }

    private fresh(text: string): EditorState {
        const drawing = syntaxField(this.events, () => this.rebuild()), drawn = drawing.field;
        return EditorState.create({
            doc: text,
            extensions: [
                history(), drawSelection(), EditorView.lineWrapping, sourceMode, focusMode, visualMode, drawn, drawnField.of(drawing), recorder(), search({ top: true, createPanel: createFindBar }), highlightSelectionMatches(),
                clicks(this.events), suggestions(this.events),
                visualEditing(state => state.field(drawn).concealed, visualOn), selectionMenu(this.events.run, visualOn), linkEditor, blockHandle(visualOn), linkTooltip(this.events), blockSelection(blockSource, visualOn),
                EditorView.contentAttributes.of({ 'aria-label': 'Editor', spellcheck: 'false' }),
                // Source mode is the file as it is written: plain text in a fixed-width font, every marker showing.
                EditorView.editorAttributes.compute([sourceMode], state => ({ class: state.field(sourceMode) ? 'cm-source' : '' })),
                keymap.of([
                    { key: 'Tab', run: acceptCompletion },
                    { key: 'Enter', run: enterBeforePictures },
                    { key: 'Enter', run: v => !v.state.selection.main.empty ? false : run(v, s => enterInTable(s) ?? (inCode(v) ? null : continueBlock(s))) },
                    { key: 'Tab', run: v => !v.state.selection.main.empty ? false : run(v, s => tabInTable(s, false) ?? indentListItem(s, false)) },
                    { key: 'F3', run: findNext, preventDefault: true },
                    { key: 'Shift-F3', run: findPrevious, preventDefault: true },
                    { key: 'Escape', run: closeSearchPanel },
                    { key: 'Shift-Tab', run: v => !v.state.selection.main.empty ? false : run(v, s => tabInTable(s, true) ?? indentListItem(s, true)) },
                    ...defaultKeymap.filter(k => k.key !== 'Mod-Enter'),
                ]),
                EditorView.updateListener.of(update => {
                    if (update.docChanged && !update.transactions.some(t => t.annotation(External))) this.events.changed(update.state.doc.toString());
                    if (this.typewriter && (update.selectionSet || update.docChanged)) this.centerCursor();
                    if (update.selectionSet || update.docChanged) {
                        const head = update.state.selection.main.head, line = update.state.doc.lineAt(head);
                        this.events.moved(line.number, head - line.from + 1);
                        this.reportFormat(update.state);
                        this.focusTableCell(update.state);
                    }
                }),
            ],
        });
    }

    get text(): string { return this.view.state.doc.toString(); }
    // A table cell or a code block that is being edited keeps the focus: a toolbar button gives it back to the editor after its command.
    focus(): void {
        if (editingInPlace(this.view)) return;
        this.view.focus();
        this.focusTableCell(this.view.state);   // a command that put the cursor in a table or a code block (the menu had the focus)
    }

    // Show the text of a tab: its own state if the text is still what it was, else a new one.
    show(id: number, text: string): void {
        const saved = this.states.get(id);
        this.states.set(this.current, this.view.state);
        this.current = id;
        this.view.setState(saved && saved.doc.toString() === text ? saved : this.fresh(text));
        this.setFocusMode(this.focusOn);
        this.setVisualMode(this.visualIsOn);
    }
    private current = 0;
    // The document it shows now (0: none yet).
    get shown(): number { return this.current; }

    forget(id: number): void { this.states.delete(id); }

    // The core replaced the whole text (opening or reloading a file): a new state, outside the undo history.
    reset(text: string): void {
        this.view.setState(this.fresh(text));
        this.setFocusMode(this.focusOn);
        this.setVisualMode(this.visualIsOn);
        this.states.delete(this.current);
    }

    // The core changed the text (a board edit, an agent): changes in code points, applied one after the other.
    applyFromCore(changes: readonly Change[]): void {
        for (const { from, to, insert } of changes) {
            const u16 = makeU16Map(this.text);
            this.view.dispatch({ changes: { from: u16(from), to: u16(to), insert }, annotations: External.of(true) });
        }
    }

    // Put the cursor at the start of a line (from 0) and bring it into view.
    reveal(line: number): void {
        const { doc } = this.view.state;
        const at = doc.line(Math.min(Math.max(line, 0) + 1, doc.lines));
        this.view.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: 'start', yMargin: 40 }) });
    }

    // Select `length` code points from `column` on `line` (from 0) and bring them into view (a search hit).
    select(line: number, column: number, length: number): void {
        const { doc } = this.view.state;
        const at = doc.line(Math.min(Math.max(line, 0) + 1, doc.lines));
        const u16 = (n: number) => at.from + Array.from(at.text).slice(0, n).join('').length;
        const from = u16(column), to = u16(column + length);
        this.view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
        this.view.focus();
    }

    // The text the selection covers.
    get selectedText(): string {
        const { main } = this.view.state.selection;
        return this.view.state.sliceDoc(main.from, main.to);
    }

    // The cursor and the selection, in code points.
    cursor(): { offset: number; selection: [number, number] | null } {
        const { main } = this.view.state.selection;
        const text = this.text;
        const cp = (n: number) => Array.from(text.slice(0, n)).length;
        return { offset: cp(main.head), selection: main.empty ? null : [cp(main.from), cp(main.to)] };
    }

    // Find (and replace) in this document: the find bar (findbar.ts), with the selection as the query; Replace unfolds its row.
    openFind(replace: boolean): void {
        openSearchPanel(this.view);
        const bar = findBarOf(this.view);
        if (replace && bar) { bar.setExpanded(true); bar.focusReplace(); }
    }

    closeFind(): void { closeSearchPanel(this.view); }

    // Draw the decorations again: the document was saved or named (its relative picture paths mean something now), or a grammar arrived.
    rebuild(): void { this.view.dispatch({ effects: refresh.of(null) }); }

    // Focus mode dims all but the cursor's paragraph; typewriter mode keeps the cursor line in the middle of the view.
    private typewriter = false;
    private focusOn = false;
    setFocusMode(on: boolean): void {
        this.focusOn = on;
        if (this.view.state.field(focusMode) !== on) this.view.dispatch({ effects: setFocus.of(on) });
    }
    setTypewriterMode(on: boolean): void { this.typewriter = on; if (on) this.centerCursor(); }
    private centerCursor(): void {
        requestAnimationFrame(() => this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'center' }) }));
    }

    setSourceMode(on: boolean): void { this.view.dispatch({ effects: setSource.of(on) }); this.reportFormat(this.view.state); }

    // The visual editor: the syntax hidden on the cursor line too, bullets and checkboxes, the selection and / menus.
    private visualIsOn = false;
    setVisualMode(on: boolean): void {
        this.visualIsOn = on;
        if (this.view.state.field(visualMode) !== on) this.view.dispatch({ effects: setVisual.of(on) });
        this.reportFormat(this.view.state);
    }

    // The cursor is in a table of the visual editor (a click on text above it, the Table button, an arrow key): the cell it
    // is in takes the focus, since the text there is hidden behind the grid and typing would go nowhere.
    private focusTableCell(state: EditorState): void {
        const sel = state.selection.main;
        if (!sel.empty || !visualOn(state) || !this.view.hasFocus) return;
        const result = parses.get(state.doc);
        const line = state.doc.lineAt(sel.head), i = line.number - 1;
        const table = result?.tables.find(t => i >= t.start && i <= t.end);
        const code = result?.codeBlocks.find(b => b.closed && !diagramKind(b) && i >= b.startLine && i <= b.endLine);
        if (code) {
            requestAnimationFrame(() => { if (this.view.state.doc === state.doc && this.view.hasFocus) focusCode(this.view, sel.head); });
            return;
        }
        if (!table) return;
        requestAnimationFrame(() => {
            if (this.view.state.doc !== state.doc || !this.view.hasFocus) return;
            const grid = gridAt(this.view, table.start, i, line.text, sel.head - line.from);
            if (grid) focusCell(grid.wrap, grid.place);
        });
    }

    // Tell the toolbar what the text at the cursor is, when that changed.
    private lastFormat = '';
    private reportFormat(state: EditorState): void {
        const format = formatAt(state), key = JSON.stringify(format);
        if (key === this.lastFormat) return;
        this.lastFormat = key;
        this.events.format(format);
    }

    // The commands the toolbar, the menu, and the keys run (markdown/editcommands.ts), on this editor.
    readonly edit: EditCommands = {
        undo: () => { undo(this.view); },
        redo: () => { redo(this.view); },
        wrap: marker => { run(this.view, s => wrap(s, marker)); },
        link: () => { if (visualOn(this.view.state)) openLinkEditor(this.view); else run(this.view, link); },
        block: (before, after) => { run(this.view, s => block(s, before, after)); },
        prefix: (pattern, text) => { run(this.view, s => togglePrefix(s, pattern, text)); },
        heading: level => { run(this.view, s => heading(s, level)); },
        lineKind: kind => { run(this.view, s => setLineKind(s, kind)); },
        moveBlock: delta => { moveCursorBlock(this.view, delta); },
        table: operation => {
            const result = runTableCommand(stateOf(this.view), TABLE_OPERATIONS[operation]);
            if (result.ok) applyEdit(this.view, result.edit);
            else this.events.message(TABLE_MESSAGES[result.reason]);
        },
        zoomImage: () => {
            const head = this.view.state.selection.main.head;
            const first = pictureLines.get(this.view.state.doc)?.get(this.view.state.doc.lineAt(head).number - 1)?.[0];
            if (first) this.events.zoomImage({ src: first.src, title: first.alt || decodeURIComponent(first.src.split('/').pop() ?? '') });
            else this.events.message('There is no image on this line');
        },
    };
}
