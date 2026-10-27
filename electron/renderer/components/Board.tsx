// The kanban board: lists of cards that move between lists by dragging, a dialog to edit a card, a menu on the card and on
// the list, and a popover on a card's field chips. A board grouped by a field (`group:`) shows the values of the field as
// its lists. Every change is an operation (markdown/noteedit.ts) the client shows at once and the core applies to the text.

import { useMemo, useState, type DragEvent } from 'react';
import { boardSchema, cardFields, cardMeta, dropIndex, dueStatus, type Board as BoardData, type Position } from '../../../src/markdown/kanban';
import { wikiLinksIn } from '../../../src/markdown/wikilink';
import { Icon } from './Icons';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { CardDialog, Chip, FieldChips, formatDay, Inline, PopupMenu, refOf, Tags, todayString, usePopup, useFieldEditor, type CardAnswer, type MenuEntry } from './notes';
import type { CardMenuEntry } from '../lib/client';
import { useClient } from '../lib/useClient';

interface Drag { from: Position; text: string; target: Position | null }

// The position a card dropped at height `y` takes in a list: the cards other than the dragged one whose middle is above it.
function dropAt(list: HTMLElement, y: number): number {
    const centers = [...list.querySelectorAll<HTMLElement>('.card:not(.dragging)')].map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
    return dropIndex(centers, y);
}

// The badge of an assigned card: what its run is doing.
const RUN_LABEL: Record<string, string> = { queued: 'queued', working: 'working', waiting: 'waiting for an answer', done: 'done', failed: 'failed', stopped: 'stopped' };

function AgentChip({ agent, status }: { agent: string; status: string | null }) {
    const title = status === 'waiting' ? `${agent} is waiting for your answer: right click the card → Answer ${agent}…`
        : status ? `${agent}: ${RUN_LABEL[status] ?? status} (right click the card for the log)` : `Assigned to ${agent}; right click the card → Work on it with ${agent}`;
    return <Chip text={`${agent}${status ? ` · ${RUN_LABEL[status] ?? status}` : ''}`} className={`agent run-${status ?? 'idle'}`} title={title} />;
}

export function Board({ board, groupField, agents, runs }: { board: BoardData; groupField: string | null; agents: boolean; runs: Record<string, string> }) {
    const client = useClient();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const [menu, setMenu, closeMenu] = usePopup<{ at: { x: number; y: number }; entries: MenuEntry[] }>();
    const [editing, setEditing, closeEditing] = usePopup<Position & { text: string; notes: string[] }>();
    const [adding, setAdding] = useState<'list' | null>(null);
    // A new card is filled in through the same dialog as editing a card.
    const [addingCard, setAddingCard, closeAddingCard] = usePopup<number>();
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [drag, setDrag] = useState<Drag | null>(null);
    const [openField, fieldPopover] = useFieldEditor(schema, (card, key, raw, field, option) => client.editNotes({ kind: 'field', ...card, key, raw, field, option }));
    const today = todayString();
    const columnName = (title: string) => title || (groupField ? `No ${groupField}` : 'No list');

    const answer = (at: Position, text: string, result: CardAnswer | null) => {
        closeEditing();
        if (result) client.editNotes({ kind: 'update', at, card: text, text: result.text, notes: result.notes });
    };
    const deleteCard = async (at: Position) => {
        const card = board.columns[at.column]?.cards[at.index];
        if (card && await client.confirm(`Delete the card “${cardMeta(card.text).title}”?`, '', 'Delete')) client.editNotes({ kind: 'delete', ...refOf(at, card) });
    };
    const deleteColumn = async (column: number) => {
        const col = board.columns[column];
        const detail = col.cards.length ? `The ${col.cards.length} cards in it will also be deleted.` : '';
        if (await client.confirm(`Delete the list “${columnName(col.title)}”?`, detail, 'Delete')) client.editNotes({ kind: 'deleteColumn', column, title: col.title, keepCards: false });
    };
    const renameColumn = async (column: number) => {
        const current = board.columns[column].title;
        const name = await client.promptText('Rename List', 'List name', current);
        if (name) client.editNotes({ kind: 'renameColumn', column, title: current, to: name });
    };

    // The entries of a card's menu; the harness ones are the core's (asked for when the menu opens) and run by their token.
    const cardEntries = (at: Position, harness: CardMenuEntry[] = []): MenuEntry[] => {
        const col = board.columns[at.column], card = col.cards[at.index], ref = refOf(at, card);
        const move = board.columns.flatMap((target, t): MenuEntry[] => t === at.column ? []
            : [{ label: columnName(target.title), run: () => client.editNotes({ kind: 'move', ...ref, to: { column: t, index: target.cards.length } }) }]);
        return [
            { label: 'Edit…', run: () => setEditing({ ...at, text: card.text, notes: card.notes }) },
            { label: card.done ? 'Mark Not Done' : 'Mark Done', run: () => client.editNotes({ kind: 'toggle', ...ref }) },
            { label: 'Move to', enabled: board.columns.length > 1, submenu: move },
            { label: 'Move Up', enabled: at.index > 0, run: () => client.editNotes({ kind: 'move', ...ref, to: { column: at.column, index: at.index - 1 } }) },
            { label: 'Move Down', enabled: at.index < col.cards.length - 1, run: () => client.editNotes({ kind: 'move', ...ref, to: { column: at.column, index: at.index + 1 } }) },
            ...harness.length ? [{ separator: true } as MenuEntry, ...harness.map(e => ({ label: e.label, enabled: e.enabled, run: () => client.runCardEntry(e.token) }))] : [],
            { separator: true },
            { label: 'Delete', run: () => void deleteCard(at) },
        ];
    };
    const openCardMenu = async (at: Position, x: number, y: number) => {
        const card = board.columns[at.column]?.cards[at.index];
        const harness = agents && card ? await client.cardMenu(at.column, at.index, card.text) : [];
        setMenu({ at: { x, y }, entries: cardEntries(at, harness) });
    };
    const columnEntries = (column: number): MenuEntry[] => {
        // The group without a name stays first: it cannot be moved, and nothing is moved before it.
        const first = board.columns[0]?.title === '' ? 1 : 0;
        const movable = board.columns[column].title !== '';
        const title = board.columns[column].title;
        return [
            { label: 'Rename…', run: () => void renameColumn(column) },
            { label: 'Move Left', enabled: movable && column > first, run: () => client.editNotes({ kind: 'moveColumn', column, title, to: column - 1 }) },
            { label: 'Move Right', enabled: movable && column < board.columns.length - 1, run: () => client.editNotes({ kind: 'moveColumn', column, title, to: column + 1 }) },
            { separator: true },
            { label: 'Delete List…', run: () => void deleteColumn(column) },
        ];
    };

    const drop = (e: DragEvent, column: number) => {
        e.preventDefault();
        const d = drag;
        setDrag(null);
        if (!d) return;
        const card = board.columns[d.from.column]?.cards[d.from.index];
        const to = { column, index: dropAt(e.currentTarget as HTMLElement, e.clientY) };
        if (card && !(to.column === d.from.column && to.index === d.from.index)) client.editNotes({ kind: 'move', ...refOf(d.from, card), to });
    };

    return (
        <div className="board" data-page="board">
            {board.columns.map((column, c) => {
                let others = 0;
                const mark = <div className="drop-mark" aria-hidden="true" />;
                return (
                    <section key={`${c}:${column.title}`} className="column" aria-label={columnName(column.title)}
                        onDragOver={e => {
                            if (!drag) return;
                            e.preventDefault();
                            const index = dropAt(e.currentTarget, e.clientY);
                            if (drag.target?.column !== c || drag.target.index !== index) setDrag({ ...drag, target: { column: c, index } });
                        }}
                        onDrop={e => drop(e, c)}>
                        <h2>
                            <span className="name">{columnName(column.title)}</span><span className="count">{column.cards.length}</span>
                            <IconButton size="icon-xs" className="list-menu" label={`List menu: ${columnName(column.title)}`} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ at: { x: r.left, y: r.bottom }, entries: columnEntries(c) }); }}><Icon name="view-more-horizontal" /></IconButton>
                        </h2>
                        <div className="cards">
                            {column.cards.map((card, index) => {
                                const at = { column: c, index };
                                const dragging = drag?.from.column === c && drag.from.index === index;
                                const here = !dragging && drag?.target?.column === c && drag.target.index === others;
                                if (!dragging) others++;
                                const meta = cardMeta(card.text);
                                const inTitle = new Set(wikiLinksIn(card.text).map(l => l.target.toLowerCase()));
                                const links = card.notes.length ? wikiLinksIn(card.notes.join('\n')).filter(l => !inTitle.has(l.target.toLowerCase())) : [];
                                const ref = refOf(at, card);
                                return (
                                    <div key={`${index}:${card.text}`}>
                                        {here && mark}
                                        <div className={`card${card.done ? ' done' : ''}${dragging ? ' dragging' : ''}`} draggable tabIndex={0} role="group" aria-label={meta.title}
                                            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.text); setDrag({ from: at, text: card.text, target: null }); }}
                                            onDragEnd={() => setDrag(null)}
                                            onClick={() => setEditing({ ...at, text: card.text, notes: card.notes })}
                                            onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) setEditing({ ...at, text: card.text, notes: card.notes }); }}
                                            onContextMenu={e => { e.preventDefault(); void openCardMenu(at, e.clientX, e.clientY); }}>
                                            <Checkbox className="card-check" checked={card.done === true} aria-label={`Done: ${meta.title}`}
                                                onClick={e => e.stopPropagation()} onCheckedChange={() => client.editNotes({ kind: 'toggle', ...ref })} />
                                            <div className="body">
                                                <div className="text"><Inline text={meta.title} /></div>
                                                <div className="badges">
                                                    {meta.agent && <AgentChip agent={meta.agent} status={agents ? runs[card.text] ?? null : null} />}
                                                    <FieldChips chips={cardFields(card.text, schema)} onEdit={(key, e) => openField(ref, card.text, key, { x: e.clientX, y: e.clientY })} />
                                                    <Tags tags={meta.tags} />
                                                    {meta.due && <Chip icon="x-office-calendar" text={formatDay(meta.due, today)} className={`due due-${dueStatus(meta.due, today)}`} title="Due date" onClick={e => openField(ref, card.text, 'due', { x: e.clientX, y: e.clientY })} />}
                                                    {card.notes.length > 0 && <Chip icon="view-list" text="" className="notes" title="Has notes" />}
                                                </div>
                                                {links.map(l => {
                                                    const target = `${l.target}${l.heading ? `#${l.heading}` : ''}`;
                                                    return <a key={target} href="#" className="note-link-row" onClick={e => { e.preventDefault(); e.stopPropagation(); client.openNote(target); }}>↗ {l.alias || target}</a>;
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {drag?.target?.column === c && drag.target.index >= others && mark}
                        </div>
                        <Button variant="ghost" size="sm" className="add" onClick={() => setAddingCard(c)}><Icon name="list-add" />Add card</Button>
                    </section>
                );
            })}
            <div className="column add-list">
                {adding === 'list' ? (
                    <form onSubmit={e => {
                        e.preventDefault();
                        const title = (drafts.list ?? '').trim();
                        if (!title) return;
                        client.editNotes({ kind: 'addColumn', title });
                        setDrafts(d => ({ ...d, list: '' }));
                        setAdding(null);
                    }}>
                        <Input autoFocus value={drafts.list ?? ''} onChange={e => setDrafts(d => ({ ...d, list: e.target.value }))} placeholder="List name" aria-label="New list name"
                            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); } }} onBlur={() => { if (!(drafts.list ?? '').trim()) setAdding(null); }} />
                    </form>
                ) : <Button variant="ghost" size="sm" className="add" onClick={() => setAdding('list')}><Icon name="list-add" />Add list</Button>}
            </div>
            {menu && <PopupMenu at={menu.at} entries={menu.entries} onClose={closeMenu} />}
            {fieldPopover}
            {editing && <CardDialog heading="Edit Card" kind="card" text={editing.text} notes={editing.notes} schema={schema} agents={agents}
                onDone={result => answer({ column: editing.column, index: editing.index }, editing.text, result)} />}
            {addingCard !== null && <CardDialog heading="Add Card" kind="card" text="" notes={[]} schema={schema} agents={agents}
                onDone={result => {
                    closeAddingCard();
                    if (result) client.editNotes({ kind: 'add', column: addingCard, text: result.text, notes: result.notes, now: Date.now() });
                }} />}
        </div>
    );
}
