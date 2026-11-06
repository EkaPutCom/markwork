// Safe chat block structure, shared by chat renderers. Incomplete streaming
// input remains readable.
import { RE, startsTable } from './syntax';
import { parseTable, tableEnd, type Table } from './table';

export type ChatBlock =
    | { kind: 'code'; text: string }
    | { kind: 'table'; table: Table }
    | { kind: 'heading'; level: number; text: string }
    | {
          kind: 'bullet';
          depth: number;
          text: string;
          marker?: string;
          task?: boolean;
      }
    | { kind: 'quote'; text: string }
    | { kind: 'rule' }
    | { kind: 'text'; text: string };

function plainBlock(line: string): ChatBlock {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading)
        return { kind: 'heading', level: heading[1].length, text: heading[2] };
    if (RE.hr.test(line)) return { kind: 'rule' };
    const item = RE.list.exec(line);
    if (item)
        return {
            kind: 'bullet',
            depth: Math.floor(item[1].replace(/\t/g, '    ').length / 2),
            text: line.slice(item[0].length),
            ...(/^\d/.test(item[2]) ? { marker: item[2] } : {}),
            ...(item[4] ? { task: /x/i.test(item[4]) } : {}),
        };
    const quote = /^\s*>\s?(.*)$/.exec(line);
    return quote
        ? { kind: 'quote', text: quote[1] }
        : { kind: 'text', text: line };
}

export function chatBlocks(text: string): ChatBlock[] {
    const out: ChatBlock[] = [],
        lines = text.replace(/\r/g, '').split('\n');
    let fence: { ch: string; length: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i],
            match = RE.fence.exec(line);
        if (fence) {
            if (
                match &&
                match[2][0] === fence.ch &&
                match[2].length >= fence.length &&
                !match[3].trim()
            )
                fence = null;
            else out.push({ kind: 'code', text: line });
        } else if (match) {
            fence = { ch: match[2][0], length: match[2].length };
        } else if (startsTable(lines, i)) {
            const end = tableEnd(lines, i);
            out.push({
                kind: 'table',
                table: parseTable(lines.slice(i, end + 1)),
            });
            i = end;
        } else out.push(plainBlock(line));
    }
    return out;
}
