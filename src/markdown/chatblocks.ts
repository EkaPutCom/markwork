// The line-level structure of the assistant's Markdown answers: headings, bullets, quotes, rules, code lines, and
// plain lines. chatmarkup.ts draws the blocks as Pango, chathtml.ts as HTML.
// Called repeatedly while an answer streams in, so it tolerates text cut off in the middle
// (an unclosed code block is still treated as code until the end of the text). Pure TypeScript.

export type ChatBlock =
    | { kind: 'code'; text: string }
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'bullet'; depth: number; text: string }
    | { kind: 'quote'; text: string }
    | { kind: 'rule' }
    | { kind: 'text'; text: string };

const FENCE = /^\s*(```|~~~)/;

// One block per line; the fence lines themselves are dropped.
export function chatBlocks(text: string): ChatBlock[] {
    const out: ChatBlock[] = [];
    let fenced = false;
    for (const line of text.replace(/\r/g, '').split('\n')) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            out.push({ kind: 'code', text: line });
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            out.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
            continue;
        }
        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            out.push({ kind: 'bullet', depth: Math.floor(bullet[1].length / 2), text: bullet[2] });
            continue;
        }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            out.push({ kind: 'quote', text: quote[1] });
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push({ kind: 'rule' });
            continue;
        }
        out.push({ kind: 'text', text: line });
    }
    return out;
}
