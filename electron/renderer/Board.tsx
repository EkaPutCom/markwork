import { useState } from 'react';
import type { Board as BoardData } from '../../src/markdown/kanban.js';
import { Icon } from './Icons.js';
import { useClient } from './useClient.js';

export function Board({ board }: { board: BoardData }) {
    const client = useClient();
    const [drafts, setDrafts] = useState<Record<number, string>>({});
    return (
        <div className="board">
            {board.columns.map((column, c) => (
                <section key={c} className="column" aria-label={column.title}>
                    <h2>{column.title}<span className="count">{column.cards.length}</span></h2>
                    {column.cards.map((card, index) => {
                        const at = { column: c, index };
                        return (
                            <div key={`${index}:${card.text}`} className={`card${card.done ? ' done' : ''}`}>
                                <button className="check" aria-label={`${card.done ? 'Mark not done' : 'Mark done'}: ${card.text}`} onClick={() => client.editNotes({ kind: 'toggle', at, card: card.text })}>
                                    {card.done ? <Icon name="emblem-ok" /> : <span className="ring" />}
                                </button>
                                <span className="text">{card.text}</span>
                                <span className="moves">
                                    <button aria-label={`Move left: ${card.text}`} disabled={c === 0}
                                        onClick={() => client.editNotes({ kind: 'move', at, card: card.text, to: { column: c - 1, index: board.columns[c - 1].cards.length } })}>
                                        <Icon name="go-previous" />
                                    </button>
                                    <button aria-label={`Move right: ${card.text}`} disabled={c === board.columns.length - 1}
                                        onClick={() => client.editNotes({ kind: 'move', at, card: card.text, to: { column: c + 1, index: board.columns[c + 1].cards.length } })}>
                                        <Icon name="go-next" />
                                    </button>
                                </span>
                            </div>
                        );
                    })}
                    <form onSubmit={e => {
                        e.preventDefault();
                        const text = (drafts[c] ?? '').trim();
                        if (!text) return;
                        client.editNotes({ kind: 'add', column: c, text, notes: [], now: Date.now() });
                        setDrafts(d => ({ ...d, [c]: '' }));
                    }}>
                        <input value={drafts[c] ?? ''} onChange={e => setDrafts(d => ({ ...d, [c]: e.target.value }))} placeholder="Add a card" aria-label={`Add a card to ${column.title}`} />
                    </form>
                </section>
            ))}
        </div>
    );
}
