// The gallery: a card with a cover for every note, a search that hides the cards that do not match, and three sizes. A
// click on a card edits the note, the ✕ on its cover deletes it.

import { useEffect, useMemo, useState } from 'react';
import { displayValue, readItem } from '../../src/markdown/fields.js';
import { CARD_WIDTH, galleryCards, GALLERY_SIZES, gallerySize, type GallerySize } from '../../src/markdown/gallery.js';
import { boardSchema, type Board } from '../../src/markdown/kanban.js';
import { imageUrl } from './images.js';
import { Chip, PageHeader, Tags, useNoteDialog } from './notes.js';
import { useClient } from './useClient.js';

const SIZE_LABEL: Record<GallerySize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

export function Gallery({ board }: { board: Board }) {
    const client = useClient();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const [sizeOverride, setSizeOverride] = useState<GallerySize | null>(null);
    const [query, setQuery] = useState('');
    const { node, edit, add } = useNoteDialog(board, schema);
    const head = board.head.join('\n');
    useEffect(() => setSizeOverride(null), [head]);
    const size = sizeOverride ?? gallerySize(board);
    const width = CARD_WIDTH[size];
    const cards = useMemo(() => galleryCards(board, schema), [board, schema]);
    const q = query.trim().toLowerCase();
    const shown = cards.filter(c => !q || `${c.title} ${c.snippet} ${c.tags.join(' ')}`.toLowerCase().includes(q));

    return (
        <div className="layout-page gallery" data-page="gallery">
            <PageHeader board={board} fallback="Gallery" onNew={() => add()} />
            <div className="gallery-bar">
                <input type="search" value={query} placeholder="Search notes…" aria-label="Search the notes of the gallery" onChange={e => setQuery(e.target.value)} />
                <span className="linked">{GALLERY_SIZES.map(s => <button key={s} className={`button${size === s ? ' checked' : ''}`} aria-pressed={size === s} onClick={() => setSizeOverride(s)}>{SIZE_LABEL[s]}</button>)}</span>
            </div>
            <div className="gallery-grid">
                {shown.map(card => {
                    const item = readItem(card.card.text, schema);
                    const src = card.cover.kind === 'image' ? imageUrl(card.cover.path, client.baseDir()) : null;
                    return (
                        <div key={`${card.at.column}:${card.at.index}`} className="gallery-card" style={{ width }} role="article" aria-label={card.title} tabIndex={0} title="Click to edit"
                            onClick={() => edit(card.at)} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) edit(card.at); }}>
                            <div className={`cover ${card.cover.kind === 'color' ? `cover-${card.cover.index}` : card.cover.kind === 'image' ? 'cover-missing' : 'cover-none'}`} style={{ height: Math.round(width * 0.45) }}>
                                {src && <img src={src} alt={card.title} onError={e => { e.currentTarget.hidden = true; }} />}
                                <button className="delete icon-button" title="Delete note" aria-label={`Delete note: ${card.title}`}
                                    onClick={async e => { e.stopPropagation(); if (await client.confirm(`Delete the note “${card.title}”?`, '', 'Delete')) client.editNotes({ kind: 'delete', at: card.at, card: card.card.text }); }}>✕</button>
                            </div>
                            <div className="text">
                                <h3>{card.title}</h3>
                                {card.snippet && <p className="dim caption">{card.snippet}</p>}
                                <div className="badges">
                                    <Tags tags={card.tags} />
                                    {schema.map(def => {
                                        const parsed = item.fields[def.key];
                                        if (def.key === 'cover' || !parsed?.ok) return null;
                                        const text = displayValue(def, parsed.value);
                                        const color = def.type === 'select' && !Array.isArray(parsed.value) ? def.colors?.[String(parsed.value)] : undefined;
                                        return <Chip key={def.key} text={def.type === 'select' || def.type === 'progress' ? text : `${def.key}: ${text}`} className={`field${color ? ` opt-${color}` : ''}`} />;
                                    })}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
            {cards.length === 0 && <p className="dim">The gallery is empty. Add a note to get the first card.</p>}
            {node}
        </div>
    );
}
