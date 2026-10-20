// Markdown → HTML conversion for the "Export HTML" feature.
// Pure JavaScript, so it is easy to test.
//
// The flow has two stages:
//   1. blocksHtml()  splits the document line by line into blocks: headings, paragraphs,
//                    lists, quotes, tables, code blocks.
//   2. inlineHtml()  formats the contents of each block: bold, italic, code, links, etc.

import { RE, ESCAPE_OR_CODE, startsTable } from './syntax.js';
import { parseTable, tableEnd } from './table.js';
import { dbmlToMermaid } from './dbml.js';
import { WIKILINK, parseWikiLink, wikiLabel } from './wikilink.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string): string => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const slug = (s: string): string => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function emphHtml(s: string): string {
    return s
        .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/(?<!\w)___(?=\S)([\s\S]*?\S)___(?!\w)/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>')
        .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>')
        .replace(/(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '<em>$1</em>')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
        .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
}

function inlineHtml(s: string): string {
    const codes: string[] = [], escs: string[] = [], links: string[] = [];
    s = s.replace(ESCAPE_OR_CODE(), (_: string, ch: string | undefined, _ticks: string, code: string) => ch !== undefined
        ? `\u0002${escs.push(esc(ch)) - 1}\u0002`
        : `\u0001${codes.push(`<code>${esc(code)}</code>`) - 1}\u0001`);
    s = esc(s);
    const tok = (html: string) => `\u0003${links.push(html) - 1}\u0003`;
    // [[Note#Section|text]] → <a href="Note.md#section">text</a>. The contents are already escaped, so the href
    // is built from the original text and then escaped again.
    s = s.replace(WIKILINK(), (whole: string, ref: string, alias?: string) => {
        const link = parseWikiLink(unesc(alias === undefined ? ref : `${ref}|${alias}`));
        if (!link.target && !link.heading) return whole;
        const file = link.target ? encodeURI(/\.(md|markdown)$/i.test(link.target) ? link.target : `${link.target}.md`) : '';
        const href = file + (link.heading ? `#${slug(link.heading)}` : '');
        return tok(`<a class="wikilink" href="${esc(href)}">${esc(wikiLabel(link))}</a>`);
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\)/g,
        (_: string, alt: string, src: string, t?: string) => tok(`<img src="${src}" alt="${alt}"${t ? ` title="${t}"` : ''}>`));
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\)/g,
        (_: string, txt: string, href: string, t?: string) => tok(`<a href="${href}"${t ? ` title="${t}"` : ''}>${emphHtml(txt)}</a>`));
    s = s.replace(/&lt;((?:https?|mailto|ftp):[^\s&]+)&gt;/g, (_: string, u: string) => tok(`<a href="${u}">${u}</a>`));
    s = s.replace(/\bhttps?:\/\/[^\s<\u0003]*[^\s<\u0003.,;:!?)\]'"]/g, u => tok(`<a href="${u}">${u}</a>`));
    s = emphHtml(s);
    s = s.replace(/ {2,}\n|\\\n/g, '<br>\n');
    s = s.replace(/\u0003(\d+)\u0003/g, (_, i: string) => links[Number(i)]);
    s = s.replace(/\u0002(\d+)\u0002/g, (_, i: string) => escs[Number(i)]);
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => codes[Number(i)]);
    return s;
}

const indentWidth = (s: string): number => s.replace(/\t/g, '    ').length;
// Indentation width at the start of a line (tab = 4 spaces).
const indentOf = (line: string): number => indentWidth(/^[ \t]*/.exec(line)![0]);

interface ListItem {
    num: number;
    task: boolean | null;   // null = not a task list
    lines: string[];
    ci: number;             // indentation of the item's content
}

// Parses a list starting at line i. Result: [html, index of the line after the list].
function parseList(lines: string[], i: number): [string, number] {
    const first = RE.list.exec(lines[i])!;
    const list = new ListReader(lines, indentWidth(first[1]), /\d/.test(first[2]));
    const next = list.read(i);
    return [list.html(), next];
}

// The items of one list level: an item marker at the base indentation with the same kind (ordered or not) starts an
// item; deeper lines, blank lines followed by more of the list, and lazy continuation lines belong to the last item.
class ListReader {
    readonly items: ListItem[] = [];
    private loose = false;   // items separated by blank lines are wrapped in <p>

    constructor(private readonly lines: string[], private readonly base: number, private readonly ordered: boolean) {}

    // Returns the index of the first line after the list.
    read(i: number): number {
        const lines = this.lines;
        while (i < lines.length) {
            if (this.startItem(i)) { i++; continue; }
            const it = this.items[this.items.length - 1];
            if (!lines[i].trim()) {
                const j = this.blankRunEnd(i);
                if (j < 0) break;
                this.loose = true;
                for (; i < j; i++) it.lines.push('');
                continue;
            }
            const ind = indentOf(lines[i]);
            if (ind > this.base) it.lines.push(lines[i].replace(/^[ \t]*/, ' '.repeat(Math.max(0, ind - it.ci))));
            else if (isLazyContinuation(lines[i])) it.lines.push(lines[i]);
            else break;
            i++;
        }
        return i;
    }

    // A marker of this list at line i starts a new item.
    private startItem(i: number): boolean {
        const m = RE.list.exec(this.lines[i]);
        if (!m || indentWidth(m[1]) !== this.base || /\d/.test(m[2]) !== this.ordered) return false;
        const contentIndent = this.base + m[2].length + Math.max(1, m[3].length);
        this.items.push({ num: parseInt(m[2]), task: m[4] ? /x/i.test(m[4]) : null, lines: [this.lines[i].slice(m[0].length)], ci: contentIndent });
        return true;
    }

    // Blank lines inside the list: the index of the next non-blank line if the list goes on after them, otherwise -1.
    private blankRunEnd(i: number): number {
        const lines = this.lines;
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) return -1;
        const ind = indentOf(lines[j]);
        return (RE.list.test(lines[j]) && ind === this.base) || ind > this.base ? j : -1;
    }

    html(): string {
        const tag = this.ordered ? 'ol' : 'ul';
        const start = this.ordered && this.items[0].num !== 1 ? ` start="${this.items[0].num}"` : '';
        const body = this.items.map((it): string => {
            let html: string = blocksHtml(it.lines);
            if (!this.loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
            if (it.task !== null)
                return `<li class="task"><input type="checkbox" disabled${it.task ? ' checked' : ''}> ${html}</li>`;
            return `<li>${html}</li>`;
        }).join('\n');
        return `<${tag}${start}>\n${body}\n</${tag}>`;
    }
}

// A line that continues the previous item's paragraph without indentation (not the start of another block).
const isLazyContinuation = (line: string): boolean =>
    !RE.list.test(line) && !RE.fence.test(line) && !RE.heading.test(line) && !RE.hr.test(line) && !/^[ \t]*>/.test(line);

// A block reader looks at line i: null = not its kind of block, otherwise its HTML and the line after it.
type BlockReader = (lines: string[], i: number, inParagraph: boolean) => [string, number] | null;

// In this order: the first reader that recognizes a line wins; other lines are paragraph text.
const BLOCK_READERS: BlockReader[] = [
    (lines, i) => {
        const m = RE.fence.exec(lines[i]);
        return m ? codeBlock(lines, i, m) : null;
    },
    (lines, i) => {
        const m = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
        if (!m) return null;
        const t = m[2] || '';
        return [`<h${m[1].length} id="${slug(t)}">${inlineHtml(t)}</h${m[1].length}>`, i + 1];
    },
    (lines, i) => RE.hr.test(lines[i]) ? ['<hr>', i + 1] : null,
    (lines, i) => {
        if (!/^[ \t]*>/.test(lines[i])) return null;
        const q = [];
        while (i < lines.length && /^[ \t]*>/.test(lines[i])) q.push(lines[i++].replace(/^[ \t]*>[ \t]?/, ''));
        return [`<blockquote>\n${blocksHtml(q)}\n</blockquote>`, i];
    },
    (lines, i) => startsTable(lines, i) ? tableHtml(lines, i) : null,
    // Inside a paragraph, only a list item with text after its marker starts a list.
    (lines, i, inParagraph) => RE.list.test(lines[i]) && (!inParagraph || RE.list.exec(lines[i])![3]) ? parseList(lines, i) : null,
];

function blocksHtml(lines: string[]): string {
    const out: string[] = [];
    let para: string[] = [], i = 0;
    const flush = () => { if (para.length) { out.push(`<p>${inlineHtml(para.join('\n'))}</p>`); para = []; } };
    while (i < lines.length) {
        if (!lines[i].trim()) { flush(); i++; continue; }
        const block = readBlock(lines, i, para.length > 0);
        if (!block) { para.push(lines[i++]); continue; }
        flush();
        out.push(block[0]);
        i = block[1];
    }
    flush();
    return out.join('\n');
}

function readBlock(lines: string[], i: number, inParagraph: boolean): [string, number] | null {
    for (const read of BLOCK_READERS) {
        const block = read(lines, i, inParagraph);
        if (block) return block;
    }
    return null;
}

// A fenced code block from line i to its closing fence (or the end of the document).
function codeBlock(lines: string[], i: number, m: RegExpExecArray): [string, number] {
    const ch = m[2][0], n = m[2].length, lang = m[3].trim(), code = [];
    for (i++; i < lines.length; i++) {
        const c = RE.fence.exec(lines[i]);
        if (c && c[2][0] === ch && c[2].length >= n && !c[3].trim()) { i++; break; }
        code.push(lines[i]);
    }
    const text = code.join('\n');
    const kind = lang.split(/\s+/)[0].toLowerCase();
    // Mermaid diagrams are drawn by a script in <head> when the page is opened (see markdownToHtml).
    if (kind === 'mermaid') return [`<pre class="mermaid">${esc(text)}</pre>`, i];
    // DBML is translated to a Mermaid ER diagram; invalid syntax shows as a plain code block.
    if (kind === 'dbml') {
        try { return [`<pre class="mermaid">${esc(dbmlToMermaid(text))}</pre>`, i]; } catch { /* fall back to a code block */ }
    }
    return [`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(text)}</code></pre>`, i];
}

function tableHtml(lines: string[], i: number): [string, number] {
    const end = tableEnd(lines, i);
    const table = parseTable(lines.slice(i, end + 1));
    const cell = (tag: string, text: string, col: number) =>
        `<${tag}${table.aligns[col] ? ` style="text-align:${table.aligns[col]}"` : ''}>${inlineHtml(text)}</${tag}>`;
    const row = (tag: string, cells: string[]) => `<tr>${cells.map((c, k) => cell(tag, c, k)).join('')}</tr>`;
    return [`<table>\n<thead>${row('th', table.header)}</thead>\n<tbody>\n${table.rows.map(r => `${row('td', r)}\n`).join('')}</tbody>\n</table>`, end + 1];
}

export function markdownToHtml(src: string, title: string): string {
    const body = blocksHtml(src.replace(/\r\n?/g, '\n').split('\n'));
    // Mermaid is loaded from a CDN only if the document has a diagram, so ordinary documents stay self-contained.
    const mermaid = body.includes('<pre class="mermaid">') ? `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
</script>
` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { max-width: 760px; margin: 40px auto; padding: 0 20px; font: 16px/1.65 "Noto Sans", "Helvetica Neue", Arial, sans-serif; color: #333; }
h1, h2 { border-bottom: 1px solid #eee; padding-bottom: .3em; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 .6em; color: #1f2328; }
a { color: #4183c4; text-decoration: none; } a:hover { text-decoration: underline; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: .9em; background: #f3f4f4; padding: 2px 4px; border-radius: 3px; color: #c7254e; }
pre { background: #f6f8fa; padding: 12px 16px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; color: inherit; }
pre.mermaid { background: none; text-align: center; }
blockquote { margin: 1em 0; padding: 0 1em; color: #6a737d; border-left: 4px solid #dfe2e5; }
table { border-collapse: collapse; margin: 1em 0; } th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
tr:nth-child(2n) { background: #f8f8f8; }
hr { border: 0; border-top: 2px solid #eee; margin: 2em 0; }
img { max-width: 100%; } mark { background: #fff3a3; }
li.task { list-style: none; } li.task input { margin: 0 .3em 0 -1.3em; }
</style>
${mermaid}</head>
<body>
${body}
</body>
</html>
`;
}
