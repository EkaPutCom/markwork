// Turns the assistant's Markdown answers into Pango markup for Gtk.Label: headings, lists, quotes,
// code blocks, and inline formatting (through cellMarkup). Pure TypeScript without GTK.
// The structure comes from chatblocks.ts, which tolerates text cut off in the middle while an answer streams in.

import { chatBlocks, type ChatBlock } from './chatblocks.js';
import { cellMarkup, escapeMarkup, type MarkupColors } from './pango.js';

function blockMarkup(block: ChatBlock, colors: MarkupColors): string {
    switch (block.kind) {
        case 'code':
            return `<span font_family="monospace" foreground="${colors.code}" background="${colors.codeBg}">${escapeMarkup(block.text) || ' '}</span>`;
        case 'heading':
            return `<span font_weight="bold" size="${block.level <= 2 ? 'larger' : 'medium'}">${cellMarkup(block.text, colors)}</span>`;
        case 'bullet':
            return `${'    '.repeat(block.depth)}•  ${cellMarkup(block.text, colors)}`;
        case 'quote':
            return `<span foreground="${colors.link}">▎</span> <span font_style="italic">${cellMarkup(block.text, colors)}</span>`;
        case 'rule':
            return '──────';
        case 'text':
            return cellMarkup(block.text, colors);
    }
}

export function chatMarkup(text: string, colors: MarkupColors): string {
    return chatBlocks(text).map(block => blockMarkup(block, colors)).join('\n');
}
