// Turns inline Markdown text (table cell contents) into Pango markup for Gtk.Label:
// **bold**, *italic*, ~~strikethrough~~, ==highlight==, `code`, and [links](url).
// The Markdown markers themselves are dropped. Pure TypeScript without GTK. The runs come from inlineruns.ts, which
// inlinehtml.ts draws as HTML.

import { inlineRuns, NOTE_URI, type InlineStyle } from './inlineruns.js';

export { NOTE_URI };

export interface MarkupColors {
    code: string;
    codeBg: string;
    link: string;
    mark: string;
}

export const escapeMarkup = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function attributes(styles: InlineStyle[], colors: MarkupColors): string {
    const attrs: string[] = [];
    if (styles.includes('bold')) attrs.push('font_weight="bold"');
    if (styles.includes('italic')) attrs.push('font_style="italic"');
    if (styles.includes('strike')) attrs.push('strikethrough="true"');
    if (styles.includes('code')) attrs.push(`font_family="monospace" foreground="${colors.code}" background="${colors.codeBg}"`);
    if (styles.includes('link')) attrs.push(`foreground="${colors.link}" underline="single"`);
    if (styles.includes('mark')) attrs.push(`background="${colors.mark}"`);
    return attrs.join(' ');
}

// links = true: [[note]] is wrapped in <a href="markwork-note:…"> so it can be clicked in a Gtk.Label.
export function cellMarkup(text: string, colors: MarkupColors, links = false): string {
    let out = '';
    for (const run of inlineRuns(text, links)) {
        const attrs = attributes(run.styles, colors);
        const piece = escapeMarkup(run.text);
        const styled = attrs ? `<span ${attrs}>${piece}</span>` : piece;
        out += run.note !== undefined ? `<a href="${escapeMarkup(NOTE_URI + encodeURIComponent(run.note))}">${styled}</a>` : styled;
    }
    return out;
}
