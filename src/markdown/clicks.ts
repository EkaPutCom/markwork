// Shared click meanings: task boxes, link URLs, and [[wikilink]] targets.
// Columns use code points, the app protocol's unit (docs/design/protocol.md).

import { cpToU16, cpLength } from './offsets';
import { WIKILINK, parseWikiLink, type WikiLink } from './wikilink';

// Column (code points) of the task-box character and its replacement.
export interface TaskToggle {
    column: number;
    text: 'x' | ' ';
}

// The edit that flips a task box at `col`, or null if none is there.
export function taskToggleAt(line: string, col: number): TaskToggle | null {
    const k = line.lastIndexOf('[', cpToU16(line, col));
    if (k < 0 || !/^\[[ xX]\]/.test(line.slice(k))) return null;
    return {
        column: cpLength(line.slice(0, k + 1)),
        text: line[k + 1] === ' ' ? 'x' : ' ',
    };
}

export const LINK_PATTERNS: readonly RegExp[] = [
    /!?\[[^\]]*\]\(([^)\s]*)[^)]*\)/g, // [text](url) and ![alt](url)
    /<((?:https?|mailto|ftp):[^\s>]+)>/g, // <https://...>
    /\bhttps?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"]/g, // bare URL
];

// URL of the link at `col`, or null.
export function linkAt(line: string, col: number): string | null {
    const pos = cpToU16(line, col);
    for (const re of LINK_PATTERNS) {
        re.lastIndex = 0;
        let r: RegExpExecArray | null;
        while ((r = re.exec(line))) {
            if (pos >= r.index && pos <= r.index + r[0].length) {
                return r[1] ?? r[0];
            }
        }
    }
    return null;
}

// [[Note]] at `col`, or null.
export function wikiLinkAt(line: string, col: number): WikiLink | null {
    const pos = cpToU16(line, col);
    for (const r of line.matchAll(WIKILINK())) {
        if (pos >= r.index && pos <= r.index + r[0].length) {
            return parseWikiLink(r[0].slice(2, -2));
        }
    }
    return null;
}
