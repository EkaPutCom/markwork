// The list (inbox): notes captured from a line at the top, in sections, each with its age, tags, and fields. A note is
// edited in a dialog, moved by dragging between rows or from its menu, and a section has a menu of its own.

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { boardSchema, dropSpot, type Board, type DropRow, type DropSpot, type Position } from '../../src/markdown/kanban.js';
import { ageOf, itemFields, itemMeta } from '../../src/markdown/inbox.js';
import { CardDialog, FieldChips, headingOf, Inline, PopupMenu, refOf, Tags, usePopup, useFieldEditor, type CardAnswer, type MenuEntry } from './notes.js';
import { Icon } from './Icons.js';
import { useClient, useStore } from './useClient.js';

export function ageLabel(captured: Date, now: Date): string {
    const age = ageOf(captured, now);
    const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    switch (age.unit) {
        case 'now': return 'just now';
        case 'minutes': return plural(age.n, 'minute');
        case 'hours': return plural(age.n, 'hour');
        case 'days': return plural(age.n, 'day');
        default: return captured.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: captured.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    }
}

export function Inbox({ board, focus, tab }: { board: Board; focus: number; tab: number }) {
    const client = useClient();
    const { active } = useStore();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const [text, setText] = useState('');
    const entry = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const [menu, setMenu, closeMenu] = usePopup<{ at: { x: number; y: number }; entries: MenuEntry[] }>();
    const [dialog, setDialog, closeDialog] = usePopup<{ at: Position | null; text: string; notes: string[] }>();
    const [drag, setDrag] = useState<{ from: Position; spot: DropSpot | null } | null>(null);
    const [openField, fieldPopover] = useFieldEditor(schema, (card, key, raw, field, option) => client.editNotes({ kind: 'field', ...card, key, raw, field, option }));
    const now = new Date();
    const { title, description } = headingOf(board, 'Inbox');
    const count = board.columns.reduce((n, c) => n + c.cards.length, 0);

    // A new list, or a new inbox, has the cursor in the capture line.
    useEffect(() => { if (focus > 0 && active === tab) entry.current?.focus(); }, [focus, active, tab]);

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

    const newSection = async (at: Position, card: string) => {
        const name = await client.promptText('New Section', 'Section name', '');
        if (name) client.editNotes({ kind: 'section', at, card, title: name });
    };
    const noteEntries = (at: Position): MenuEntry[] => {
        const col = board.columns[at.column], item = col.cards[at.index], ref = refOf(at, item);
        const sections = board.columns.flatMap((c, t): MenuEntry[] => t === at.column || c.title === '' ? [] : [{ label: c.title, run: () => client.editNotes({ kind: 'move', ...ref, to: { column: t, index: c.cards.length } }) }]);
        return [
            { label: 'Edit…', run: () => setDialog({ at, text: item.text, notes: item.notes }) },
            { label: 'Move to', submenu: [...sections, ...(sections.length ? [{ separator: true }] : []), { label: 'New section…', run: () => void newSection(at, item.text) }] },
            { label: 'Move Up', enabled: at.index > 0, run: () => client.editNotes({ kind: 'move', ...ref, to: { column: at.column, index: at.index - 1 } }) },
            { label: 'Move Down', enabled: at.index < col.cards.length - 1, run: () => client.editNotes({ kind: 'move', ...ref, to: { column: at.column, index: at.index + 1 } }) },
            { separator: true },
            { label: 'Delete', run: () => void deleteNote(at) },
        ];
    };
    const deleteNote = async (at: Position) => {
        const item = board.columns[at.column]?.cards[at.index];
        if (item && await client.confirm(`Delete the note “${itemMeta(item.text).title}”?`, '', 'Delete')) client.editNotes({ kind: 'delete', ...refOf(at, item) });
    };
    const sectionEntries = (column: number): MenuEntry[] => {
        const section = board.columns[column];
        const first = board.columns[0]?.title === '' ? 1 : 0;
        const rename = async () => {
            const name = await client.promptText('Rename Section', 'Section name', section.title);
            if (name) client.editNotes({ kind: 'renameColumn', column, title: section.title, to: name });
        };
        const remove = async () => {
            if (!section.cards.length) { client.editNotes({ kind: 'deleteColumn', column, title: section.title, keepCards: true }); return; }
            const choice = await client.choose(`Delete the section “${section.title}”?`, `It has ${section.cards.length} notes.`, [
                { label: 'Keep Notes', value: 'keep', style: 'suggested' }, { label: 'Delete Notes', value: 'delete', style: 'destructive' }, { label: 'Cancel', value: 'cancel' }]);
            if (choice === 'keep' || choice === 'delete') client.editNotes({ kind: 'deleteColumn', column, title: section.title, keepCards: choice === 'keep' });
        };
        return [
            { label: 'Rename…', run: () => void rename() },
            { label: 'Move Up', enabled: column > first, run: () => client.editNotes({ kind: 'moveColumn', column, title: section.title, to: column - 1 }) },
            { label: 'Move Down', enabled: column < board.columns.length - 1, run: () => client.editNotes({ kind: 'moveColumn', column, title: section.title, to: column + 1 }) },
            { separator: true },
            { label: 'Delete Section…', run: () => void remove() },
        ];
    };

    // Where a dragged note would land: the rows are measured as drawn.
    const spotAt = (y: number): DropSpot | null => {
        const rows: DropRow[] = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].map(el => {
            const r = el.getBoundingClientRect();
            const [column, index] = el.dataset.row!.split(':').map(Number);
            return { top: r.top, bottom: r.bottom, note: el.dataset.kind === 'note' ? { column, index } : null, section: column };
        });
        return dropSpot(rows, y);
    };
    const dragOver = (e: DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        const spot = spotAt(e.clientY);
        if (spot?.row !== drag.spot?.row || spot?.side !== drag.spot?.side) setDrag({ ...drag, spot });
    };
    const drop = (e: DragEvent) => {
        e.preventDefault();
        const d = drag;
        setDrag(null);
        const spot = d && spotAt(e.clientY);
        const item = d && board.columns[d.from.column]?.cards[d.from.index];
        if (d && spot && item) client.editNotes({ kind: 'place', ...refOf(d.from, item), point: spot.point });
    };

    let row = 0;
    return (
        <div className="inbox" data-page="inbox">
            <div className="inbox-page">
                <header>
                    <div className="titles"><h1>{title}</h1>{description && <p className="dim">{description}</p>}</div>
                    <button className="button" title="Add a note with a title, tags, and full notes" onClick={() => setDialog({ at: null, text: '', notes: [] })}><Icon name="list-add" />New Note</button>
                </header>
                <input ref={entry} className="capture" value={text} placeholder="Write an idea, link, or quick note…" aria-label="Quick capture to the inbox"
                    onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); capture(); } }} />
                <div ref={list} className="inbox-list" role="list" onDragOver={dragOver} onDrop={drop}>
                    {board.columns.map((column, c) => (
                        <div key={`${c}:${column.title}`} className="inbox-group">
                            {column.title !== '' && (() => {
                                const mark = drag?.spot?.row === row ? ` drop-${drag.spot.side}` : '';
                                row++;
                                return <h2 data-row={`${c}:0`} data-kind="section" className={`inbox-section${mark}`} onContextMenu={e => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, entries: sectionEntries(c) }); }}>{column.title}</h2>;
                            })()}
                            {column.cards.map((card, index) => {
                                const at = { column: c, index };
                                const meta = itemMeta(card.text);
                                const mark = drag?.spot?.row === row ? ` drop-${drag.spot.side}` : '';
                                row++;
                                const sub = [meta.captured ? ageLabel(meta.captured, now) : null, card.notes.length ? 'has notes' : null].filter(Boolean).join(' · ');
                                const ref = refOf(at, card);
                                return (
                                    <div key={`${index}:${card.text}`} data-row={`${c}:${index}`} data-kind="note" role="listitem" tabIndex={0} draggable
                                        className={`inbox-row${mark}${drag?.from.column === c && drag.from.index === index ? ' dragging' : ''}`}
                                        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.text); setDrag({ from: at, spot: null }); }}
                                        onDragEnd={() => setDrag(null)}
                                        onClick={() => setDialog({ at, text: card.text, notes: card.notes })}
                                        onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) setDialog({ at, text: card.text, notes: card.notes }); }}
                                        onContextMenu={e => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, entries: noteEntries(at) }); }}>
                                        <div className="text"><div className="title"><Inline text={meta.title} /></div>{sub && <div className="dim caption">{sub}</div>}</div>
                                        <FieldChips chips={itemFields(card.text, schema)} onEdit={(key, e) => openField(ref, card.text, key, { x: e.clientX, y: e.clientY })} />
                                        <Tags tags={meta.tags} />
                                        <button className="button flat circular remove" title="Delete note" aria-label={`Delete note: ${meta.title}`}
                                            onClick={e => { e.stopPropagation(); void deleteNote(at); }}><Icon name="window-close" /></button>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
                {count === 0 && board.columns.every(c => c.title === '') && (
                    <div className="empty-page"><h2>The inbox is empty</h2><p>Write something above to capture it.</p></div>
                )}
            </div>
            {menu && <PopupMenu at={menu.at} entries={menu.entries} onClose={closeMenu} />}
            {fieldPopover}
            {dialog && <CardDialog heading={dialog.at ? 'Edit Note' : 'New Note'} kind="note" text={dialog.text} notes={dialog.notes} schema={schema} onDone={r => answer(dialog.at, dialog.text, r)} />}
        </div>
    );
}
