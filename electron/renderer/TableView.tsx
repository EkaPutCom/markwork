// The table: a row per note and a column per field. A header sorts (ascending, descending, the document's own order; kept
// here, not written to the file), a cell changes its field from a popover, the title opens the note's dialog.

import { useEffect, useMemo, useRef, useState } from 'react';
import { boardSchema, type Board, type Position } from '../../src/markdown/kanban.js';
import { displayValue, readItem, OPTION_COLORS, type FieldDef, type Parsed } from '../../src/markdown/fields.js';
import { nextSort, SECTION_COLUMN, sortSpec, TITLE_COLUMN, tableColumns, tableRows, type SortSpec, type TableRow } from '../../src/markdown/tablelayout.js';
import { CardDialog, Chip, headingOf, Inline, refOf, todayString, usePopup, useFieldEditor, type CardAnswer } from './notes.js';
import { useClient, useStore } from './useClient.js';

// The value of a field as a small widget for its type; a missing one is a dash, and one that does not fit is marked.
function Value({ row, def, parsed, today }: { row: TableRow; def: FieldDef; parsed: Parsed | undefined; today: string }) {
    if (!parsed) return <span className="dim">—</span>;
    if (!parsed.ok) return <Chip text={parsed.raw} className="field invalid" title={`“${def.key}” does not fit its field: ${parsed.error}. The text in the file is unchanged.`} />;
    const text = displayValue(def, parsed.value);
    if (def.type === 'select' && !def.multiple) {
        const index = def.options.indexOf(text);
        const color = def.colors?.[text] ?? (index >= 0 ? OPTION_COLORS[index % OPTION_COLORS.length] : null);
        return <Chip text={text} className={`field${color ? ` opt-${color}` : ''}`} />;
    }
    if (def.type === 'progress' && typeof parsed.value === 'object' && !Array.isArray(parsed.value) && 'total' in parsed.value) {
        const fraction = parsed.value.total ? parsed.value.done / parsed.value.total : 0;
        return <span className="progress"><progress max={1} value={fraction} /><span className="dim">{text}</span></span>;
    }
    const late = def.type === 'date' && row.card.done !== true && text.slice(0, 10) < today;
    return <span className={`${def.type === 'number' ? 'num' : ''}${late ? ' late' : ''}`}>{text}</span>;
}

export function TableView({ board, focus, tab }: { board: Board; focus: number; tab: number }) {
    const client = useClient();
    const { active } = useStore();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const [sortOverride, setSortOverride] = useState<SortSpec | null | undefined>(undefined);   // undefined = the document's own `sort:`
    const [text, setText] = useState('');
    const entry = useRef<HTMLInputElement>(null);
    const [dialog, setDialog, closeDialog] = usePopup<{ at: Position | null; text: string; notes: string[] }>();
    const [openField, fieldPopover] = useFieldEditor(schema, (card, key, raw, field, option) => client.editNotes({ kind: 'field', ...card, key, raw, field, option }));
    const head = board.head.join('\n');
    // A sort chosen by a click is forgotten when the frontmatter changes.
    useEffect(() => setSortOverride(undefined), [head]);
    useEffect(() => { if (focus > 0 && active === tab) entry.current?.focus(); }, [focus, active, tab]);

    const sort = sortOverride !== undefined ? sortOverride : sortSpec(board);
    const rows = tableRows(board, sort, schema);
    const keys = tableColumns(board, schema);
    const checks = rows.some(r => r.card.done !== null);
    const { title, description } = headingOf(board, 'Table');
    const today = todayString();

    const capture = () => {
        if (!text.trim()) return;
        client.editNotes({ kind: 'capture', text: text.trim(), notes: [], now: Date.now() });
        setText('');
    };
    const answer = (at: Position | null, previous: string, result: CardAnswer | null) => {
        closeDialog();
        if (!result) return;
        if (at === null) client.editNotes({ kind: 'capture', text: result.text, notes: result.notes, now: Date.now() });
        else client.editNotes({ kind: 'update', at, card: previous, text: result.text, notes: result.notes });
    };
    const label = (key: string) => key === TITLE_COLUMN ? 'Title' : key === SECTION_COLUMN ? 'Section' : key;

    return (
        <div className="table-page" data-page="table">
            <div className="table-wrap">
                <header>
                    <div className="titles"><h1>{title}</h1>{description && <p className="dim">{description}</p>}</div>
                    <button className="button" onClick={() => setDialog({ at: null, text: '', notes: [] })}>+ New Row</button>
                </header>
                <input ref={entry} className="capture" value={text} placeholder="Add a row: type, then Enter" aria-label="Quick capture to the table"
                    onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); capture(); } }} />
                {rows.length === 0 ? <div className="empty-page"><h2>The table is empty</h2><p>Type a row above and press Enter.</p></div> : (
                    <table className="notes-table">
                        <thead>
                            <tr>
                                {checks && <th aria-label="Done" />}
                                {keys.map(key => (
                                    <th key={key} aria-sort={sort?.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                                        <button title="Sort by this column" onClick={() => setSortOverride(nextSort(sort, key))}>{label(key)}{sort?.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}</button>
                                    </th>
                                ))}
                                <th aria-label="Delete" />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => {
                                const ref = refOf(row.at, row.card);
                                const item = readItem(row.card.text, schema);
                                return (
                                    <tr key={`${row.at.column}:${row.at.index}:${row.card.text}`} className={row.card.done === true ? 'done' : ''}>
                                        {checks && (
                                            <td className="check-cell">
                                                {row.card.done !== null && <input type="checkbox" checked={row.card.done} aria-label={`Mark done: ${item.title}`} onChange={() => client.editNotes({ kind: 'toggle', ...ref })} />}
                                            </td>
                                        )}
                                        {keys.map(key => {
                                            if (key === TITLE_COLUMN) return <td key={key} className="title-cell" onClick={() => setDialog({ at: row.at, text: row.card.text, notes: row.card.notes })}><Inline text={item.title} /></td>;
                                            if (key === SECTION_COLUMN) return <td key={key} className={row.section ? '' : 'dim'}>{row.section || 'No section'}</td>;
                                            const def = schema.find(f => f.key === key);
                                            if (!def) return <td key={key} />;
                                            return (
                                                <td key={key} className="field-cell" title="Click to change" data-field={key}
                                                    onClick={e => openField(ref, row.card.text, key, { x: e.clientX, y: e.clientY })}>
                                                    <Value row={row} def={def} parsed={item.fields[key]} today={today} />
                                                </td>
                                            );
                                        })}
                                        <td className="delete-cell">
                                            <button className="icon-button" title="Delete row" aria-label={`Delete row: ${item.title}`}
                                                onClick={async () => { if (await client.confirm(`Delete the note “${item.title}”?`, '', 'Delete')) client.editNotes({ kind: 'delete', ...ref }); }}>×</button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
            {fieldPopover}
            {dialog && <CardDialog heading={dialog.at ? 'Edit Note' : 'New Row'} kind="note" text={dialog.text} notes={dialog.notes} schema={schema} onDone={r => answer(dialog.at, dialog.text, r)} />}
        </div>
    );
}
