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
// Any other value, or no `layout:` line, is an ordinary document. Pure TypeScript without GTK.

export type Layout = 'board' | 'list';

const LAYOUTS: readonly Layout[] = ['board', 'list'];
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
