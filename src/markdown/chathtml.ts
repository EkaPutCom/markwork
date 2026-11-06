// Safe chat HTML from shared chat blocks, GFM tables and inline runs. Raw HTML
// and remote image loads remain disabled.

import { chatBlocks, type ChatBlock } from './chatblocks';
import { cellHtml, escapeHtml } from './inlinehtml';
import type { Table } from './table';

function tableHtml(table: Table): string {
    const row = (cells: string[], tag: 'th' | 'td') =>
        '<tr>' +
        cells
            .map(
                (text, col) =>
                    `<${tag} class="md-align-${table.aligns[col] || 'left'}"` +
                    `${tag === 'th' ? ' scope="col"' : ''}>` +
                    `${cellHtml(text)}</${tag}>`
            )
            .join('') +
        '</tr>';
    return (
        '<div class="md-table-scroll" role="region" aria-label="Markdown ' +
        'table" ' +
        `tabindex="0"><table><thead>` +
        `${row(table.header, 'th')}</thead>` +
        `<tbody>${table.rows
            .map((cells) => row(cells, 'td'))
            .join('')}</tbody>` +
        '</table></div>'
    );
}

function blockHtml(block: Exclude<ChatBlock, { kind: 'code' }>): string {
    switch (block.kind) {
        case 'heading':
            return `<div class="md-heading md-h${block.level}">` +
                `${cellHtml(block.text)}</div>`;
        case 'bullet': {
            const marker =
                block.task !== undefined
                    ? block.task
                        ? '☑'
                        : '☐'
                    : block.marker;
            return `<div class="md-bullet" data-depth="${block.depth}"` +
                `${marker ? ` data-marker="${escapeHtml(marker)}"` : ''}>` +
                `${cellHtml(block.text)}</div>`;
        }
        case 'table':
            return tableHtml(block.table);
        case 'quote':
            return `<blockquote class="md-quote">` +
                `${cellHtml(block.text)}</blockquote>`;
        case 'rule':
            return '<hr class="md-rule">';
        case 'text':
            return block.text
                ? `<p class="md-line">${cellHtml(block.text)}</p>`
                : '<br>';
    }
}

// Consecutive code lines are one <pre>; an unclosed block while the answer
// streams is still a block.
export function chatHtml(text: string): string {
    const out: string[] = [];
    let code: string[] | null = null;
    for (const block of chatBlocks(text)) {
        if (block.kind === 'code') {
            (code ??= []).push(block.text);
            continue;
        }
        if (code) {
            out.push(
                `<pre class="md-code">${escapeHtml(code.join('\n'))}</pre>`
            );
            code = null;
        }
        out.push(blockHtml(block));
    }
    if (code)
        out.push(`<pre class="md-code">${escapeHtml(code.join('\n'))}</pre>`);
    return out.join('\n');
}
