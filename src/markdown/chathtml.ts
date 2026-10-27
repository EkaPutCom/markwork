// Turns the assistant's Markdown answers into HTML for a renderer in a web page: the same blocks as chatmarkup.ts
// (chatblocks.ts), with inline formatting through cellHtml. Safe as innerHTML; the classes carry no colors, the page's
// stylesheet does. Pure TypeScript.

import { chatBlocks, type ChatBlock } from './chatblocks';
import { cellHtml, escapeHtml } from './inlinehtml';

function blockHtml(block: Exclude<ChatBlock, { kind: 'code' }>): string {
    switch (block.kind) {
        case 'heading':
            return `<div class="md-heading md-h${block.level}">${cellHtml(block.text)}</div>`;
        case 'bullet':
            return `<div class="md-bullet" data-depth="${block.depth}">${cellHtml(block.text)}</div>`;
        case 'quote':
            return `<blockquote class="md-quote">${cellHtml(block.text)}</blockquote>`;
        case 'rule':
            return '<hr class="md-rule">';
        case 'text':
            return block.text ? `<p class="md-line">${cellHtml(block.text)}</p>` : '<br>';
    }
}

// Consecutive code lines are one <pre>; an unclosed block while the answer streams is still a block.
export function chatHtml(text: string): string {
    const out: string[] = [];
    let code: string[] | null = null;
    for (const block of chatBlocks(text)) {
        if (block.kind === 'code') {
            (code ??= []).push(block.text);
            continue;
        }
        if (code) { out.push(`<pre class="md-code">${escapeHtml(code.join('\n'))}</pre>`); code = null; }
        out.push(blockHtml(block));
    }
    if (code) out.push(`<pre class="md-code">${escapeHtml(code.join('\n'))}</pre>`);
    return out.join('\n');
}
