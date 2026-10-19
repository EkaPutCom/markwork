// The Markdown editor of the Electron window: CodeMirror 6 with the app's own Markdown parser (markdown/highlight.ts) for
// styling and for hiding syntax away from the cursor, and the app's editor commands (markdown/editcommands.ts) for
// bold, links, lists, and tables. Only the drawing is here; what the syntax is and what a command does is shared with the
// GTK editor. CodeMirror counts UTF-16 units, as the commands do; the protocol's code points are converted at this edge.

import { Annotation, EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, redo, undo } from '@codemirror/commands';
import { closeSearchPanel, findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search } from '@codemirror/search';
import { HighlightCache, textLines, type Styles } from '../../src/markdown/highlight.js';
import { block, continueBlock, enterInTable, heading, indentListItem, link, runTableCommand, tabInTable, togglePrefix, wrap,
    type TableCommand, type TextEdit, type TextState } from '../../src/markdown/editcommands.js';
import { makeU16Map } from '../../src/markdown/offsets.js';
import type { EditCommands, TableOperation } from '../../src/app/commands.js';
import type { Change } from '../../src/app/protocol/messages.js';

// A change that comes from the core (or opens a text), not from the user: it is not reported back as an edit.
const External = Annotation.define<boolean>();
const setSource = StateEffect.define<boolean>();

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

function linesOf(doc: Text) {
    return textLines(doc.toString());
}

// The styled and concealed text. The parse is kept per document (the cache reuses lines that did not change); the
// decorations are rebuilt when the text, the cursor line, or source mode changes.
function syntaxField(): Extension {
    const cache = new HighlightCache<string>(styles);
    let parsed: { doc: Text; result: ReturnType<HighlightCache<string>['update']> } | null = null;

    const build = (state: EditorState): DecorationSet => {
        const { doc } = state;
        if (parsed?.doc !== doc) parsed = { doc, result: cache.update(linesOf(doc)) };
        const { result } = parsed;
        const text = doc.toString();
        const u16 = makeU16Map(text);
        const ranges: ReturnType<Decoration['range']>[] = [];
        result.spans.forEach((spans, i) => {
            if (i >= doc.lines) return;
            const line = doc.line(i + 1);
            for (const [name, a, b] of spans) {
                const from = u16(result.starts[i] + a), to = Math.min(u16(result.starts[i] + b), line.to);
                if (LINE_STYLES.has(name.replace('cm-md-', ''))) ranges.push(lineDeco(`${name}-line`).range(line.from));
                if (to > from) ranges.push(mark(name).range(from, to));
            }
        });
        if (!state.field(sourceMode)) {
            const { main } = state.selection;
            const first = doc.lineAt(Math.min(main.anchor, main.head)).number - 1, last = doc.lineAt(Math.max(main.anchor, main.head)).number - 1;
            for (const [a, b, r0, r1] of result.markers) {
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
        update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(e => e.is(setSource)) ? build(tr.state) : value,
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

export interface EditorEvents {
    changed(text: string): void;     // the user changed the text
    moved(line: number, column: number): void;   // the cursor or selection moved (from 1)
    message(text: string): void;
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
                history(), drawSelection(), EditorView.lineWrapping, sourceMode, syntaxField(), search({ top: true }), highlightSelectionMatches(),
                EditorView.contentAttributes.of({ 'aria-label': 'Editor', spellcheck: 'false' }),
                keymap.of([
                    { key: 'Enter', run: v => run(v, s => enterInTable(s) ?? continueBlock(s)) },
                    { key: 'Tab', run: v => run(v, s => tabInTable(s, false) ?? indentListItem(s, false)) },
                    { key: 'F3', run: findNext, preventDefault: true },
                    { key: 'Shift-F3', run: findPrevious, preventDefault: true },
                    { key: 'Escape', run: closeSearchPanel },
                    { key: 'Shift-Tab', run: v => run(v, s => tabInTable(s, true) ?? indentListItem(s, true)) },
                    ...defaultKeymap.filter(k => k.key !== 'Mod-Enter'),
                ]),
                EditorView.updateListener.of(update => {
                    if (update.docChanged && !update.transactions.some(t => t.annotation(External))) this.events.changed(update.state.doc.toString());
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
    }
    private current = 0;

    forget(id: number): void { this.states.delete(id); }

    // The core replaced the whole text (opening or reloading a file): a new state, outside the undo history.
    reset(text: string): void {
        this.view.setState(this.fresh(text));
        this.states.delete(this.current);
    }

    // The core changed the text (a board edit, an agent): changes in code points, applied one after the other.
    applyFromCore(changes: readonly Change[]): void {
        for (const { from, to, insert } of changes) {
            const u16 = makeU16Map(this.text);
            this.view.dispatch({ changes: { from: u16(from), to: u16(to), insert }, annotations: External.of(true) });
        }
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
        zoomImage: () => {},
    };
}
