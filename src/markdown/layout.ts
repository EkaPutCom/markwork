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
//   ---
//   layout: calendar     ← a month grid; notes sit on the day of a date field (`date:`, default `due`)
//   layout: timeline     ← a bar per note from `start:` to `end:` (defaults `start` and `due`)
//   layout: gallery      ← cards with a cover (`cover:`, default `cover`)
//   layout: chart        ← counts and charts over the notes (`by:`, `group:`)
//   ---
//
// `layout: board` can also say `group: status` to make the columns the values of a select field.
//
// Any other value, or no `layout:` line, is an ordinary document. Other one-line options sit beside it (`add:`, see
// inbox.ts) and are read with `optionOf`. Pure TypeScript.

export type Layout = 'board' | 'list' | 'table' | 'calendar' | 'timeline' | 'gallery' | 'chart';

export const LAYOUTS: readonly Layout[] = ['board', 'list', 'table', 'calendar', 'timeline', 'gallery', 'chart'];
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
export const isCalendar = (text: string): boolean => layoutOf(text) === 'calendar';
export const isTimeline = (text: string): boolean => layoutOf(text) === 'timeline';
export const isGallery = (text: string): boolean => layoutOf(text) === 'gallery';
export const isChart = (text: string): boolean => layoutOf(text) === 'chart';

// Any of the layouts: the text is shown as a board, a list, a table, a calendar, a timeline, a gallery, or a chart.
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

// The text with its frontmatter naming `layout` instead: the `layout:` line is replaced, or added after the opening `---`,
// or a frontmatter is put in front of a document that has none. Nothing else in the text changes.
export function withLayout(text: string, layout: Layout): string {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return `---\nlayout: ${layout}\n---\n${text.startsWith('\n') ? '' : '\n'}${text}`;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') break;
        if (MARKER.test(lines[i])) {
            lines[i] = `layout: ${layout}`;
            return lines.join('\n');
        }
    }
    lines.splice(1, 0, `layout: ${layout}`);
    return lines.join('\n');
}

// The text with the one-line option `key` set to `value` in its frontmatter, or removed if `value` is null: the line is
// replaced, or added after the `layout:` line (else after the opening `---`). Nothing else in the text changes; a text
// without a frontmatter is returned as it is.
export function withOption(text: string, key: string, value: string | null): string {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return text;
    const line = new RegExp(`^${key}:[ \\t]*`, 'i');
    let close = lines.length, layoutAt = 0;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { close = i; break; }
        if (MARKER.test(lines[i])) layoutAt = i;
    }
    const at = lines.findIndex((l, i) => i > 0 && i < close && line.test(l));
    if (at >= 0) {
        if (value === null) lines.splice(at, 1); else lines[at] = `${key}: ${value}`;
    } else if (value !== null) {
        lines.splice(layoutAt + 1, 0, `${key}: ${value}`);
    }
    return lines.join('\n');
}
