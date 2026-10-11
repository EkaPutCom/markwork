// How a Markdown document is shown. The frontmatter names the layout:
//
//   ---
//   layout: board        ← a column per `##` heading, a card per list item
//   ---
//
//   ---
//   layout: list         ← one list of notes (an inbox, a reading list, …)
//   ---
//
//   ---
//   layout: table        ← one row per note, one column per field
//   ---
//
// Any other value, or no `layout:` line, is an ordinary document. Other one-line options sit beside it (`add:`, see
// inbox.ts) and are read with `optionOf`. Pure TypeScript without GTK.

export type Layout = 'board' | 'list' | 'table';

const LAYOUTS: readonly Layout[] = ['board', 'list', 'table'];
const MARKER = /^layout:\s*["']?([A-Za-z-]+)["']?\s*$/i;

// The layout in the frontmatter (looked for in its first 40 lines), or null for an ordinary document.
export function layoutOf(text: string): Layout | null {
    const lines = text.split('\n', 40);
    if (lines[0]?.trim() !== '---') return null;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return null;
        const name = MARKER.exec(lines[i])?.[1]?.toLowerCase();
        if (name) return LAYOUTS.find(l => l === name) ?? null;
    }
    return null;
}

export const isBoard = (text: string): boolean => layoutOf(text) === 'board';
export const isList = (text: string): boolean => layoutOf(text) === 'list';
export const isTable = (text: string): boolean => layoutOf(text) === 'table';

// Any of the layouts: the text is shown as a board, a list, or a table.
export const isStructured = (text: string): boolean => layoutOf(text) !== null;

// The value of a one-line option such as `add: top` in the frontmatter (the first 40 lines, before the closing `---`),
// without quotes; null if there is none. Indented lines belong to a block such as `fields:` and are not options.
export function optionOf(text: string, key: string): string | null {
    const lines = text.split('\n', 40);
    if (lines[0]?.trim() !== '---') return null;
    const line = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'i');
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return null;
        const value = line.exec(lines[i])?.[1];
        if (value !== undefined) return value.replace(/^(["'])(.*)\1$/, '$2') || null;
    }
    return null;
}
