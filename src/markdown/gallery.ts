// What a `layout: gallery` document shows: a card for every note, with a cover above its title. The model is the same as
// a board's or a list's (kanban.ts), so the same file can be shown as any of them.
//
//   ---
//   layout: gallery
//   cover: cover                     ← optional; the field that holds an image path or a color (default `cover`)
//   size: medium                     ← optional; small, medium, or large
//   fields:
//     cover: link
//   ---
//
// The cover of a note is its `cover` field, else the first image in the note (`![](images/a.png)`), else a color taken
// from its first tag. Pure TypeScript.

import type { FieldDef } from './fields.js';
import { readItem } from './fields.js';
import { optionOf } from './layout.js';
import { boardSchema, type Board, type Card, type Position } from './kanban.js';

export type GallerySize = 'small' | 'medium' | 'large';
export const GALLERY_SIZES: readonly GallerySize[] = ['small', 'medium', 'large'];
export const CARD_WIDTH: Record<GallerySize, number> = { small: 150, medium: 220, large: 320 };
export const COVER_COLORS = 8;

export function gallerySize(board: Board): GallerySize {
    const raw = optionOf(board.head.join('\n'), 'size')?.toLowerCase();
    return GALLERY_SIZES.find(s => s === raw) ?? 'medium';
}

export type Cover = { kind: 'image'; path: string } | { kind: 'color'; index: number } | { kind: 'none' };

export interface GalleryCard {
    at: Position;
    card: Card;
    title: string;
    snippet: string;
    tags: string[];
    cover: Cover;
}

const IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// A stable number 0..7 for a tag, so the same tag always gets the same color.
export function tagColorIndex(tag: string): number {
    let hash = 0;
    for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    return hash % COVER_COLORS;
}

export function coverOf(card: Card, schema: FieldDef[], key: string): Cover {
    const item = readItem(card.text, schema);
    const field = item.fields[key];
    const fromField = field?.ok && !Array.isArray(field.value) && typeof field.value === 'string' ? field.value.trim() : '';
    if (fromField && IMAGE_FILE.test(fromField)) return { kind: 'image', path: fromField };
    const inText = IMAGE.exec([card.text, ...card.notes].join('\n'))?.[1];
    if (inText && IMAGE_FILE.test(inText)) return { kind: 'image', path: inText };
    const color = /^color-([0-7])$/.exec(fromField)?.[1];
    if (color) return { kind: 'color', index: +color };
    return item.tags.length ? { kind: 'color', index: tagColorIndex(item.tags[0]) } : { kind: 'none' };
}

// The first line of text under the title, without images, as the card's preview.
export function snippetOf(card: Card): string {
    const line = card.notes.map(n => n.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()).find(Boolean) ?? '';
    return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

export function galleryCards(board: Board, schema: FieldDef[] = boardSchema(board)): GalleryCard[] {
    const key = optionOf(board.head.join('\n'), 'cover') ?? 'cover';
    return board.columns.flatMap((column, c) => column.cards.map((card, index): GalleryCard => {
        const item = readItem(card.text, schema);
        return { at: { column: c, index }, card, title: item.title, snippet: snippetOf(card), tags: item.tags, cover: coverOf(card, schema, key) };
    }));
}
