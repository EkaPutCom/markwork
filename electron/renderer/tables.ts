// A table as a grid, while the cursor is elsewhere (the GTK editor's editor/tablelayer.ts). The rows of the table are
// replaced by an HTML table drawn from markdown/table.ts; with the cursor in the table the raw text is back for editing
// (Tab moves between cells, see markdown/editcommands.ts). A click on a cell puts the cursor in that cell of the raw text.

import { WidgetType, type EditorView } from '@codemirror/view';
import { cellHtml } from '../../src/markdown/inlinehtml.js';
import { cellStart, parseTable, type Table } from '../../src/markdown/table.js';

export class TableWidget extends WidgetType {
    private readonly key: string;

    constructor(readonly lines: readonly string[], private readonly table: Table, private readonly dim = false) {
        super();
        this.key = lines.join('\n') + (dim ? '\0dim' : '');
    }

    override eq(other: TableWidget): boolean { return other.key === this.key; }

    override toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cm-md-table-grid' + (this.dim ? ' cm-md-dim' : '');
        const grid = document.createElement('table');
        const cell = (tag: 'th' | 'td', text: string, col: number, row: number) => {
            const el = document.createElement(tag);
            el.innerHTML = cellHtml(text);
            const align = this.table.aligns[col];
            if (align) el.style.textAlign = align;
            el.dataset.row = String(row);
            el.dataset.col = String(col);
            return el;
        };
        const head = grid.createTHead().insertRow();
        this.table.header.forEach((text, c) => head.append(cell('th', text, c, -1)));
        const body = grid.createTBody();
        this.table.rows.forEach((cells, r) => {
            const tr = body.insertRow();
            cells.forEach((text, c) => tr.append(cell('td', text, c, r)));
        });
        wrap.append(grid);
        wrap.addEventListener('mousedown', event => {
            const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
            if (!target || (event.target as HTMLElement).closest('a') && (event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            const { doc } = view.state;
            const first = doc.lineAt(view.posAtDOM(wrap)).number;
            const row = Number(target.dataset.row), col = Number(target.dataset.col);
            const line = doc.line(Math.min(doc.lines, first + (row < 0 ? 0 : row + 2)));
            view.dispatch({ selection: { anchor: line.from + cellStart(line.text, col) }, scrollIntoView: true });
            view.focus();
        });
        return wrap;
    }

    override ignoreEvent(): boolean { return true; }
}

export const tableOf = (lines: readonly string[]): Table => parseTable([...lines]);
