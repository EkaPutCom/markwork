// The Markdown editor of the Electron window: CodeMirror 6 with the app's own Markdown parser (markdown/highlight.ts) for
// styling and for hiding syntax away from the cursor, and the app's editor commands (markdown/editcommands.ts) for
// bold, links, lists, and tables. Only the drawing is here; what the syntax is and what a command does is shared with the
// GTK editor. CodeMirror counts UTF-16 units, as the commands do; the protocol's code points are converted at this edge.

import { Annotation, EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, redo, undo } from '@codemirror/commands';
import { closeSearchPanel, findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search } from '@codemirror/search';
import { HighlightCache, textLines, type CodeBlock, type HangingIndent, type Styles } from '../../src/markdown/highlight.js';
import { block, continueBlock, enterInTable, heading, indentListItem, isInCodeBlock, link, runTableCommand, tabInTable, togglePrefix, wrap,
    type TableCommand, type TextEdit, type TextState } from '../../src/markdown/editcommands.js';
import { acceptCompletion, autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { linkAt, taskToggleAt, wikiLinkAt } from '../../src/markdown/clicks.js';
import { suggestNotes, wikiQuery, wikiTargetFor } from '../../src/markdown/wikilink.js';
import { conflictDecorations } from './conflicts.js';
import { DiagramWidget } from './diagrams.js';
import { diagramKind } from '../../src/markdown/diagram.js';
import { TableWidget, tableOf } from './tables.js';
import { CodeBoxWidget, codeColors, spansOf } from './codecolor.js';
import { PicturesWidget, pictures, type PictureItem, type ZoomedImage } from './images.js';
import { cpToU16, makeU16Map } from '../../src/markdown/offsets.js';
import type { EditCommands, TableOperation } from '../../src/app/commands.js';
import type { Change } from '../../src/app/protocol/messages.js';

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

function syntaxField(events: EditorEvents, languageLoaded: () => void): Extension {
    const cache = new HighlightCache<string>(styles, hanging);
    let parsed: { doc: Text; result: ReturnType<HighlightCache<string>['update']> } | null = null;

    const build = (state: EditorState): DecorationSet => {
        const { doc } = state;
        if (parsed?.doc !== doc) parsed = { doc, result: cache.update(linesOf(doc)) };
        const { result } = parsed;
        const text = doc.toString();
        const u16 = makeU16Map(text);
        const ranges: ReturnType<Decoration['range']>[] = [];
        // A table is a grid unless the cursor is in it (or the editor shows the source).
        const sel = state.selection.main;
        const selFirst = doc.lineAt(Math.min(sel.anchor, sel.head)).number - 1, selLast = doc.lineAt(Math.max(sel.anchor, sel.head)).number - 1;
        const conflicts = conflictDecorations(doc);
        ranges.push(...conflicts.ranges);
        const grids = new Set<number>(conflicts.covered);
        const boxed = new Set<CodeBlock>();
        // Focus mode: all text outside the paragraph of the cursor (lines up to blank ones) is dimmed.
        let paragraph: [number, number] | null = null;   // lines (from 0) of the cursor's paragraph, in focus mode
        if (state.field(focusMode)) {
            const blank = (n: number) => !doc.line(n + 1).text.trim();
            let b0 = Math.min(selFirst, doc.lines - 1), b1 = Math.min(selLast, doc.lines - 1);
            while (b0 > 0 && !blank(b0 - 1)) b0--;
            while (b1 < doc.lines - 1 && !blank(b1 + 1)) b1++;
            paragraph = [b0, b1];
            const from = doc.line(b0 + 1).from, to = doc.line(b1 + 1).to;
            if (from > 0) ranges.push(dim.range(0, from));
            if (to < doc.length) ranges.push(dim.range(to, doc.length));
        }
        // A block widget outside the cursor's paragraph is dimmed too (the marks above cannot reach inside a widget).
        const dimmed = (first: number, last: number) => paragraph !== null && (last < paragraph[0] || first > paragraph[1]);
        if (!state.field(sourceMode)) {
            for (const t of result.tables) {
                if (t.end >= doc.lines || (selLast >= t.start && selFirst <= t.end)) continue;
                const lines = Array.from({ length: t.end - t.start + 1 }, (_, k) => doc.line(t.start + k + 1).text);
                ranges.push(Decoration.replace({ widget: new TableWidget(lines, tableOf(lines), dimmed(t.start, t.end)), block: true }).range(doc.line(t.start + 1).from, doc.line(t.end + 1).to));
                for (let k = t.start; k <= t.end; k++) grids.add(k);
            }
            // A code block is a box that scrolls sideways, with its colors inside.
            for (const block of result.codeBlocks) {
                if (!block.closed || !block.text.trim() || diagramKind(block) || block.endLine >= doc.lines || (selLast >= block.startLine && selFirst <= block.endLine)) continue;
                ranges.push(Decoration.replace({ widget: new CodeBoxWidget(block.text, spansOf(block, languageLoaded).spans, dimmed(block.startLine, block.endLine)), block: true }).range(doc.line(block.startLine + 1).from, doc.line(block.endLine + 1).to));
                for (let k = block.startLine; k <= block.endLine; k++) grids.add(k);
                boxed.add(block);
            }
            // The same for a Mermaid or DBML block: a picture unless the cursor is in the block (fences included).
            for (const block of result.codeBlocks) {
                const kind = diagramKind(block);
                if (!kind || block.endLine >= doc.lines || (selLast >= block.startLine && selFirst <= block.endLine)) continue;
                const open = (view: EditorView, element: HTMLElement) => view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.posAtDOM(element)).to + 1 }, scrollIntoView: true });
                ranges.push(Decoration.replace({ widget: new DiagramWidget(kind, block.text, open, dimmed(block.startLine, block.endLine)), block: true }).range(doc.line(block.startLine + 1).from, doc.line(block.endLine + 1).to));
                for (let k = block.startLine; k <= block.endLine; k++) grids.add(k);
            }
        }
        result.spans.forEach((spans, i) => {
            if (i >= doc.lines || grids.has(i)) return;
            const line = doc.line(i + 1);
            for (const [name, a, b] of spans) {
                if (name.startsWith(INDENT_PREFIX)) { ranges.push(indentDeco(Number(name.slice(INDENT_PREFIX.length))).range(line.from)); continue; }
                const from = u16(result.starts[i] + a), to = Math.min(u16(result.starts[i] + b), line.to);
                if (LINE_STYLES.has(name.replace('cm-md-', ''))) ranges.push(lineDeco(`${name}-line`).range(line.from));
                if (to > from) ranges.push(mark(name).range(from, to));
            }
        });
        ranges.push(...codeColors(result.codeBlocks.filter(b => !boxed.has(b)), (block, i) => u16(block.start) + i, languageLoaded));
        const found = state.field(sourceMode) ? new Map<number, PictureItem[]>() : pictures(result.images, events.baseDir());
        pictureLines.set(doc, found);
        const widgetEvents = {
            activate: (view: EditorView, element: HTMLElement) => view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.posAtDOM(element)).to }, scrollIntoView: true }),
            zoom: events.zoomImage,
        };
        for (const [i, items] of found) {
            if (i < doc.lines) ranges.push(Decoration.widget({ widget: new PicturesWidget(items, widgetEvents, dimmed(i, i)), block: true, side: 1 }).range(doc.line(i + 1).to));
        }
        if (!state.field(sourceMode)) {
            const { main } = state.selection;
            const first = doc.lineAt(Math.min(main.anchor, main.head)).number - 1, last = doc.lineAt(Math.max(main.anchor, main.head)).number - 1;
            for (const [a, b, r0, r1] of result.markers) {
                if (grids.has(r0)) continue;
                if (r1 < first || r0 > last) {
                    const from = u16(a), to = u16(b);
                    if (to > from) ranges.push(hidden.range(from, to));
                }
            }
        }
        return Decoration.set(ranges, true);
    };

    return StateField.define<DecorationSet>({
        create: build,
        update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(e => e.is(setSource) || e.is(setFocus) || e.is(refresh)) ? build(tr.state) : value,
        provide: f => EditorView.decorations.from(f),
    });
}

const stateOf = (view: EditorView): TextState => {
    const { main } = view.state.selection;
    return { text: view.state.doc.toString(), anchor: main.anchor, head: main.head };
};

// Apply a command's edit as one undo step: the changes against the old text, the selection in the new one.
function applyEdit(view: EditorView, edit: TextEdit): void {
    view.dispatch({
        changes: edit.changes.map(c => ({ from: c.from, to: c.to, insert: c.insert })),
        selection: EditorSelection.single(edit.selection.anchor, edit.selection.head),
        scrollIntoView: true,
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
function wikiSuggestions(events: EditorEvents): Extension {
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
    return autocompletion({ override: [source], icons: false, defaultKeymap: true, interactionDelay: 0 });
}

// A click on a task box flips it; Ctrl (or Cmd) + click on a link opens it.
function clicks(events: EditorEvents): Extension {
    return EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.button !== 0 || event.shiftKey || event.altKey) return false;
            const place = clickPlace(view, event);
            if (!place) return false;
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
            const target = event.target as HTMLElement | null;
            if (!target?.closest('.cm-md-task, .cm-md-taskdone')) return false;
            const toggle = taskToggleAt(place.text, place.column);
            if (!toggle) return false;
            const at = place.line.from + cpToU16(place.text, toggle.column);
            view.dispatch({ changes: { from: at, to: at + 1, insert: toggle.text }, userEvent: 'input' });
            return true;
        },
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
}

export class MarkdownEditor {
    readonly view: EditorView;
    // The text the user is typing into, kept for each tab so its undo history and cursor survive switching tabs.
    private readonly states = new Map<number, EditorState>();

    constructor(parent: HTMLElement, private readonly events: EditorEvents) {
        this.view = new EditorView({ state: this.fresh(''), parent });
    }

    private fresh(text: string): EditorState {
        return EditorState.create({
            doc: text,
            extensions: [
                history(), drawSelection(), EditorView.lineWrapping, sourceMode, focusMode, syntaxField(this.events, () => this.rebuild()), search({ top: true }), highlightSelectionMatches(),
                clicks(this.events), wikiSuggestions(this.events),
                EditorView.contentAttributes.of({ 'aria-label': 'Editor', spellcheck: 'false' }),
                keymap.of([
                    { key: 'Tab', run: acceptCompletion },
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
                    }
                }),
            ],
        });
    }

    get text(): string { return this.view.state.doc.toString(); }
    focus(): void { this.view.focus(); }

    // Show the text of a tab: its own state if the text is still what it was, else a new one.
    show(id: number, text: string): void {
        const saved = this.states.get(id);
        this.states.set(this.current, this.view.state);
        this.current = id;
        this.view.setState(saved && saved.doc.toString() === text ? saved : this.fresh(text));
        this.setFocusMode(this.focusOn);
    }
    private current = 0;

    forget(id: number): void { this.states.delete(id); }

    // The core replaced the whole text (opening or reloading a file): a new state, outside the undo history.
    reset(text: string): void {
        this.view.setState(this.fresh(text));
        this.setFocusMode(this.focusOn);
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

    // The cursor and the selection, in code points.
    cursor(): { offset: number; selection: [number, number] | null } {
        const { main } = this.view.state.selection;
        const text = this.text;
        const cp = (n: number) => Array.from(text.slice(0, n)).length;
        return { offset: cp(main.head), selection: main.empty ? null : [cp(main.from), cp(main.to)] };
    }

    // Find (and replace) in this document: the search panel of CodeMirror, with the selection as the query.
    openFind(replace: boolean): void {
        openSearchPanel(this.view);
        const field = this.view.dom.querySelector<HTMLInputElement>(replace ? 'input[name=replace]' : 'input[name=search]');
        field?.focus();
        field?.select();
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

    setSourceMode(on: boolean): void { this.view.dispatch({ effects: setSource.of(on) }); }

    // The commands the toolbar, the menu, and the keys run (markdown/editcommands.ts), on this editor.
    readonly edit: EditCommands = {
        undo: () => { undo(this.view); },
        redo: () => { redo(this.view); },
        wrap: marker => { run(this.view, s => wrap(s, marker)); },
        link: () => { run(this.view, link); },
        block: (before, after) => { run(this.view, s => block(s, before, after)); },
        prefix: (pattern, text) => { run(this.view, s => togglePrefix(s, pattern, text)); },
        heading: level => { run(this.view, s => heading(s, level)); },
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
