// The CSV tab: a CSV file as a grid edited in place. Only the rows on screen are drawn, so a file of tens of thousands of rows
// opens as fast as a small one. A cell is written when it loses the focus or Enter is pressed, never while typing, so one edit
// is one undo step of the document. The model is markdown/csv.ts; the table is held here, and the whole text goes to the core
// after each change (`act.csv.change`). The core sends the text when the tab is shown or the file changed under it (`view.csv`).
//
// Enter moves down (and adds a row at the end), Tab moves right (and adds a row after the last cell), Escape puts the old value
// back, Ctrl+Enter inserts a row below, and Shift+F10 opens the row and column menu. A row is dragged by its number and a
// column by the grip in its header. Ctrl+F opens a search bar: the cells that contain the text are marked.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    cellAt, columnCount, deleteColumn, deleteRow, findCells, insertColumn, insertRow, isNumericColumn, landing, moveColumn, moveRow, nextColumnName,
    parseCsv, replaceInCell, replaceInCells, serializeCsv, setCell, type CsvTable,
} from '../../../src/markdown/csv.js';
import { buildPattern, type SearchOptions } from '../../../src/markdown/search.js';
import { Icon } from './Icons.js';
import { PopupMenu, usePopup, type MenuEntry } from './notes.js';
import { useClient } from '../lib/useClient.js';

const ROW_HEIGHT = 33, NUMBER_WIDTH = 48, BUFFER = 6;
const MATCH_ROW = 100000;   // a match is the number row * MATCH_ROW + column

interface Cell { row: number; column: number }

// The width of each column from its longest text; when they leave room, the columns share it, so the grid fills the tab.
function widthsOf(table: CsvTable, room: number): number[] {
    const columns = columnCount(table);
    const widths = Array.from({ length: columns }, (_, c) => {
        let longest = 0;
        for (const row of table.rows.slice(0, 101)) longest = Math.max(longest, (row.cells[c] ?? '').length);
        return Math.min(36, Math.max(8, longest)) * 8 + 64;   // the grip and the ⋮ of the header too
    });
    const sum = widths.reduce((n, w) => n + w, 0);
    return sum > 0 && sum < room ? widths.map(w => Math.floor(w * room / sum)) : widths;
}

// The switches inside the Find field, as in the editor's find bar.
const TOGGLES = [
    { key: 'caseSensitive', label: 'Aa', title: 'Match Case' },
    { key: 'wholeWord', label: 'ab', title: 'Whole Words' },
    { key: 'regex', label: '.*', title: 'Regular Expression' },
] as const;

export function Csv({ text, rev, find }: { text: string; rev: number; find: { n: number; replace: boolean } }) {
    const client = useClient();
    const [table, setTable] = useState(() => parseCsv(text));
    const tableRef = useRef(table);
    const sent = useRef(text);
    const body = useRef<HTMLDivElement>(null);
    const [scroll, setScroll] = useState({ top: 0, height: 600, width: 0 });
    const [menu, setMenu, closeMenu] = usePopup<{ at: { x: number; y: number }; entries: MenuEntry[] }>();
    const [want, setWant] = useState<Cell | null>(null);
    const [drag, setDrag] = useState<{ kind: 'row' | 'column'; index: number; gap: number | null } | null>(null);

    // The text the core sends that this table did not write: read again.
    useEffect(() => {
        if (text === sent.current) return;
        sent.current = text;
        const next = parseCsv(text);
        tableRef.current = next;
        setTable(next);
    }, [text, rev]);

    const apply = useCallback((next: CsvTable, focus: Cell | null = null) => {
        if (next === tableRef.current) { if (focus) setWant(focus); return; }
        tableRef.current = next;
        setTable(next);
        sent.current = serializeCsv(next);
        client.csvChange(sent.current);
        client.csvShape(next.rows.length - 1, columnCount(next));
        if (focus) setWant(focus);
    }, [client]);

    const columns = columnCount(table);
    const widths = useMemo(() => widthsOf(table, scroll.width - NUMBER_WIDTH), [table, scroll.width]);
    const numeric = useMemo(() => Array.from({ length: columns }, (_, c) => isNumericColumn(table, c)), [table, columns]);
    const rowCount = table.rows.length;
    const total = NUMBER_WIDTH + widths.reduce((n, w) => n + w, 0);

    // The size of the view, for the rows to draw.
    useEffect(() => {
        const el = body.current;
        if (!el) return;
        const measure = () => setScroll({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const first = Math.max(1, Math.floor(scroll.top / ROW_HEIGHT) - BUFFER + 1);
    const last = Math.min(rowCount - 1, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + BUFFER);

    // A cell asked to be focused: scrolled to, then focused once it is drawn.
    const reveal = useCallback((cell: Cell) => {
        const el = body.current;
        if (!el) return;
        if (cell.row > 0) {
            const top = (cell.row - 1) * ROW_HEIGHT + ROW_HEIGHT;   // under the header
            if (top - ROW_HEIGHT < el.scrollTop) el.scrollTop = top - ROW_HEIGHT;
            else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
        }
        const x = NUMBER_WIDTH + widths.slice(0, cell.column).reduce((n, w) => n + w, 0);
        if (x < el.scrollLeft) el.scrollLeft = x - NUMBER_WIDTH;
        else if (x + widths[cell.column] > el.scrollLeft + el.clientWidth) el.scrollLeft = x + widths[cell.column] - el.clientWidth;
    }, [widths]);
    useEffect(() => {
        if (!want) return;
        reveal(want);
        const input = body.current?.querySelector<HTMLInputElement>(`[data-cell="${want.row}:${want.column}"]`);
        if (input) { input.focus(); input.select(); setWant(null); }
        else setScroll(s => ({ ...s, top: body.current?.scrollTop ?? s.top }));
    }, [want, table, scroll.top, reveal]);

    const insertRowAt = (at: number, column: number) => {
        const index = Math.min(Math.max(at, 1), tableRef.current.rows.length);
        apply(insertRow(tableRef.current, index), { row: index, column });
    };
    const insertColumnAt = (at: number) => {
        const t = tableRef.current;
        const index = Math.min(Math.max(at, 0), columnCount(t));
        apply(insertColumn(t, index, nextColumnName(t)), { row: 0, column: index });
    };
    const rowMenu = (row: number): MenuEntry[] => [
        { label: 'Insert Row Above', enabled: row !== 0, run: () => insertRowAt(row, 0) },
        { label: 'Insert Row Below', run: () => insertRowAt(row + 1, 0) },
        { label: 'Delete Row', enabled: row !== 0, run: () => apply(deleteRow(tableRef.current, row), { row: Math.min(row, tableRef.current.rows.length - 2), column: 0 }) },
    ];
    const columnMenu = (column: number): MenuEntry[] => [
        { label: 'Insert Column Left', run: () => insertColumnAt(column) },
        { label: 'Insert Column Right', run: () => insertColumnAt(column + 1) },
        { label: 'Delete Column', enabled: columnCount(tableRef.current) > 1, run: () => apply(deleteColumn(tableRef.current, column), { row: 0, column: Math.max(0, column - 1) }) },
    ];

    const commit = (row: number, column: number, value: string) => apply(setCell(tableRef.current, row, column, value));
    const keyDown = (e: React.KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
        const input = e.currentTarget;
        const go = (r: number, c: number) => { if (r >= 0 && r < tableRef.current.rows.length) setWant({ row: r, column: c }); };
        const lastRow = tableRef.current.rows.length - 1, cols = columnCount(tableRef.current);
        switch (e.key) {
            case 'Enter':
                e.preventDefault();
                commit(row, column, input.value);
                if (e.ctrlKey || e.metaKey) insertRowAt(row + 1, column);
                else if (e.shiftKey) go(row - 1, column);
                else if (row === lastRow) insertRowAt(lastRow + 1, column);
                else go(row + 1, column);
                break;
            case 'ArrowDown': case 'ArrowUp':
                e.preventDefault();
                commit(row, column, input.value);
                go(row + (e.key === 'ArrowDown' ? 1 : -1), column);
                break;
            case 'Tab':
                if (e.shiftKey ? column > 0 || row === 0 : column < cols - 1) break;   // the focus chain moves along the row
                e.preventDefault();
                commit(row, column, input.value);
                if (e.shiftKey) go(row - 1, cols - 1);
                else if (row === lastRow) insertRowAt(lastRow + 1, 0);
                else go(row + 1, 0);
                break;
            case 'Escape':
                if (input.value !== cellAt(tableRef.current, row, column)) { e.stopPropagation(); input.value = cellAt(tableRef.current, row, column); }
                break;
            case 'ContextMenu': case 'F10': {
                if (e.key === 'F10' && !e.shiftKey) break;
                e.preventDefault();
                commit(row, column, input.value);
                const r = input.getBoundingClientRect();
                setMenu({ at: { x: r.left, y: r.bottom }, entries: [...rowMenu(row), { separator: true }, ...columnMenu(column)] });
                break;
            }
        }
    };

    // ---------- Search ----------

    const [open, setOpen] = useState(false);
    const [withReplace, setWithReplace] = useState(false);
    const [query, setQuery] = useState('');
    const [replacement, setReplacement] = useState('');
    const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false });
    const [current, setCurrent] = useState(-1);
    const queryInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (find.n === 0) return;
        setOpen(true);
        setWithReplace(w => find.replace || w);
        setTimeout(() => { queryInput.current?.focus(); queryInput.current?.select(); });
    }, [find.n]);   // eslint-disable-line react-hooks/exhaustive-deps
    const built = query ? buildPattern(query, options) : null;
    const pattern = built instanceof RegExp ? built : null;
    const matches = useMemo(() => open && pattern ? findCells(table, pattern) : [], [open, table, query, options]);   // eslint-disable-line react-hooks/exhaustive-deps
    const marks = useMemo(() => new Set(matches.map(m => m.row * MATCH_ROW + m.column)), [matches]);
    const at = matches[current];
    useEffect(() => { setCurrent(matches.length ? 0 : -1); }, [query, options]);   // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (at) reveal(at); }, [at, reveal]);   // eslint-disable-line react-hooks/exhaustive-deps
    const step = (by: number) => { if (matches.length) setCurrent(c => (c + by + matches.length) % matches.length); };
    const replaceOne = () => {
        if (!pattern || !at) return;
        const next = replaceInCell(tableRef.current, at.row, at.column, pattern, replacement, options.regex);
        if (next === tableRef.current) step(1); else apply(next);
    };
    const replaceAll = () => { if (pattern) apply(replaceInCells(tableRef.current, pattern, replacement, options.regex).table); };
    const closeSearch = () => { setOpen(false); setQuery(''); if (at) setWant(at); };
    const invalid = !!built && !(built instanceof RegExp);
    const label = !query || invalid ? '' : matches.length ? `${current + 1} of ${matches.length}` : 'No results';

    // ---------- Dragging a row or a column ----------

    const dragOver = (e: React.DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        let gap: number;
        if (drag.kind === 'row') {
            gap = Math.min(rowCount, Math.max(1, 1 + Math.round((e.clientY - rect.top - ROW_HEIGHT + (body.current?.scrollTop ?? 0)) / ROW_HEIGHT)));
        } else {
            const x = e.clientX - rect.left + (body.current?.scrollLeft ?? 0) - NUMBER_WIDTH;
            let edge = 0;
            gap = 0;
            widths.forEach((w, c) => { if (x > edge + w / 2) gap = c + 1; edge += w; });
        }
        if (gap !== drag.gap) setDrag({ ...drag, gap });
    };
    const drop = (e: React.DragEvent) => {
        e.preventDefault();
        const d = drag;
        setDrag(null);
        if (!d || d.gap === null) return;
        const to = landing(d.index, d.gap);
        apply(d.kind === 'row' ? moveRow(tableRef.current, d.index, to) : moveColumn(tableRef.current, d.index, to));
    };
    const mark = (cell: Cell) => marks.has(cell.row * MATCH_ROW + cell.column) ? (at && at.row === cell.row && at.column === cell.column ? ' current-match' : ' match') : '';

    const input = (row: number, column: number, header: boolean) => {
        const value = cellAt(table, row, column);
        return (
            <input key={`${row}:${column}:${value}`} data-cell={`${row}:${column}`} defaultValue={value} spellCheck={false} aria-label={header ? `Column ${column + 1} name` : `Row ${row}, ${cellAt(table, 0, column) || `column ${column + 1}`}`}
                className={`csv-cell${header ? ' head' : ''}${numeric[column] ? ' num' : ''}${mark({ row, column })}`} style={{ width: widths[column] }}
                onBlur={e => commit(row, column, e.target.value)} onKeyDown={e => keyDown(e, row, column)}
                onContextMenu={e => { e.preventDefault(); commit(row, column, e.currentTarget.value); setMenu({ at: { x: e.clientX, y: e.clientY }, entries: [...rowMenu(row), { separator: true }, ...columnMenu(column)] }); }} />
        );
    };
    const gapX = drag?.kind === 'column' && drag.gap !== null ? NUMBER_WIDTH + widths.slice(0, drag.gap).reduce((n, w) => n + w, 0) : 0;

    return (
        <div className="csv-page" data-page="csv">
            {open && (
                // The same find bar as the editor's (findbar.ts): ▸ unfolds Replace, the toggles sit in the Find field.
                <div className="find-panel csv-find" role="search">
                    <div className="find-box">
                        <button className={`button expand${withReplace ? ' checked' : ''}`} aria-pressed={withReplace} aria-label="Replace" title="Replace" onClick={() => setWithReplace(v => !v)}>
                            <Icon name={withReplace ? 'pan-down' : 'pan-end'} />
                        </button>
                        <div className="fields">
                            <div className={`entry${invalid ? ' invalid' : ''}`} title={invalid ? (built as { error: string }).error : undefined}>
                                <Icon name="edit-find" />
                                <input ref={queryInput} value={query} placeholder="Find" aria-label="Find in the table" spellCheck={false} onChange={e => setQuery(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }} />
                                {TOGGLES.map(t => (
                                    <button key={t.key} className={`chip-button${options[t.key] ? ' checked' : ''}`} aria-pressed={options[t.key]} title={t.title} aria-label={t.title}
                                        onMouseDown={e => e.preventDefault()} onClick={() => setOptions(o => ({ ...o, [t.key]: !o[t.key] }))}>{t.label}</button>
                                ))}
                            </div>
                            {withReplace && (
                                <div className="entry">
                                    <input value={replacement} placeholder="Replace" aria-label="Replace in the table" spellCheck={false} onChange={e => setReplacement(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } else if (e.key === 'Escape') closeSearch(); }} />
                                    <button className="chip-button" title="Replace the selected result and go to the next" aria-label="Replace the selected result and go to the next" onMouseDown={e => e.preventDefault()} onClick={replaceOne}>Replace</button>
                                    <button className="chip-button" title="Replace All" aria-label="Replace All" onMouseDown={e => e.preventDefault()} onClick={replaceAll}>All</button>
                                </div>
                            )}
                        </div>
                        <div className="linked">
                            <button className="button" title="Previous result (Shift+Enter)" aria-label="Previous match" onClick={() => step(-1)}><Icon name="chevron-up" /></button>
                            <button className="button" title="Next result (Enter)" aria-label="Next match" onClick={() => step(1)}><Icon name="chevron-down" /></button>
                        </div>
                        {label && <span className="count" role="status">{label}</span>}
                        <span className="separator" />
                        <button className="button flat close" title="Close" aria-label="Close search" onClick={closeSearch}><Icon name="window-close" /></button>
                    </div>
                </div>
            )}
            <div className="csv-toolbar">
                <button className="button" onClick={() => insertRowAt(rowCount, 0)}><Icon name="list-add" />Add Row</button>
                <button className="button" onClick={() => insertColumnAt(columns)}><Icon name="list-add" />Add Column</button>
            </div>
            <div className="csv-body" ref={body} onScroll={e => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight, width: e.currentTarget.clientWidth })}
                onDragOver={dragOver} onDrop={drop}>
                <div className="csv-inner" style={{ width: total }}>
                    <div className="csv-head-row" style={{ height: ROW_HEIGHT }}>
                        <span className="csv-number" style={{ width: NUMBER_WIDTH }} />
                        {Array.from({ length: columns }, (_, c) => (
                            <span key={c} className="csv-head-cell">
                                <span className="grip" draggable title="Drag to move the column" aria-label={`Move column ${c + 1}`} onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(c)); setDrag({ kind: 'column', index: c, gap: null }); }} onDragEnd={() => setDrag(null)}><Icon name="list-drag-handle" /></span>
                                {input(0, c, true)}
                                <button className="button flat circular more" title="Column menu" aria-label={`Column menu: ${cellAt(table, 0, c) || `column ${c + 1}`}`} aria-haspopup="menu"
                                    onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ at: { x: r.left, y: r.bottom }, entries: columnMenu(c) }); }}><Icon name="view-more" /></button>
                            </span>
                        ))}
                        {drag?.kind === 'column' && drag.gap !== null && <span className="csv-drop-v" style={{ left: gapX, height: scroll.height + ROW_HEIGHT }} />}
                    </div>
                    <div className="csv-rows" style={{ height: Math.max(0, rowCount - 1) * ROW_HEIGHT }}>
                        {Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i).map(row => (
                            <div key={row} className="csv-row" style={{ top: (row - 1) * ROW_HEIGHT, height: ROW_HEIGHT }}>
                                <span className="csv-number" style={{ width: NUMBER_WIDTH }} draggable title="Drag to move the row"
                                    onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(row)); setDrag({ kind: 'row', index: row, gap: null }); }} onDragEnd={() => setDrag(null)}
                                    onContextMenu={e => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, entries: rowMenu(row) }); }}>{row}</span>
                                {Array.from({ length: columns }, (_, c) => input(row, c, false))}
                            </div>
                        ))}
                        {drag?.kind === 'row' && drag.gap !== null && <span className="csv-drop-h" style={{ top: (drag.gap - 1) * ROW_HEIGHT }} />}
                    </div>
                </div>
            </div>
            {menu && <PopupMenu at={menu.at} entries={menu.entries} onClose={closeMenu} />}
        </div>
    );
}
