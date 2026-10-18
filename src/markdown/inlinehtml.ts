// Turns inline Markdown text into HTML for a renderer in a web page: <strong>, <em>, <s>, <code>, <mark>, and a
// span.md-link for a link's text. Every character of the text is escaped, so the result is safe to set as innerHTML; the
// only attribute value that is not fixed is the href of a [[note]] link, and it is escaped too. Colors are the page's:
// the classes carry no values. The same runs as pango.ts (inlineruns.ts), so a frontend shows what GTK shows.
// Pure TypeScript.

import { inlineRuns, NOTE_URI, type InlineStyle } from './inlineruns.js';

export const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const WRAP: Record<InlineStyle, [string, string]> = {
    bold: ['<strong>', '</strong>'],
    italic: ['<em>', '</em>'],
    strike: ['<s>', '</s>'],
    code: ['<code>', '</code>'],
    link: ['<span class="md-link">', '</span>'],
    mark: ['<mark>', '</mark>'],
};

// links = true: a [[note]] becomes <a class="md-note" href="markwork-note:…">, which the page turns into "open this note".
export function cellHtml(text: string, links = false): string {
    let out = '';
    for (const run of inlineRuns(text, links)) {
        let html = escapeHtml(run.text);
        for (const style of [...run.styles].reverse()) html = WRAP[style][0] + html + WRAP[style][1];
        out += run.note !== undefined ? `<a class="md-note" href="${escapeHtml(NOTE_URI + encodeURIComponent(run.note))}">${html}</a>` : html;
    }
    return out;
}
