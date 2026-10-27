// What a click on a line of Markdown means: a task box to flip, a link URL, or a [[wikilink]] target. Pure functions over
// the line's text and a column in code points (the app protocol's unit, docs/design/protocol.md), so every frontend
// shares them.

import { cpToU16, cpLength } from './offsets';
import { WIKILINK, parseWikiLink, type WikiLink } from './wikilink';

// The task box to flip: the column (code points) of the character between the brackets and what replaces it.
export interface TaskToggle {
    column: number;
    text: 'x' | ' ';
}

// Click on "[ ]" / "[x]" at `col` → the edit that flips its checked state, or null if there is no box there.
export function taskToggleAt(line: string, col: number): TaskToggle | null {
    const k = line.lastIndexOf('[', cpToU16(line, col));
    if (k < 0 || !/^\[[ xX]\]/.test(line.slice(k))) return null;
    return { column: cpLength(line.slice(0, k + 1)), text: line[k + 1] === ' ' ? 'x' : ' ' };
}

export const LINK_PATTERNS: readonly RegExp[] = [
    /!?\[[^\]]*\]\(([^)\s]*)[^)]*\)/g,          // [text](url) and ![alt](url)
    /<((?:https?|mailto|ftp):[^\s>]+)>/g,          // <https://...>
    /\bhttps?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"]/g,  // bare URL
];

// URL of the link at `col`, or null.
export function linkAt(line: string, col: number): string | null {
    const pos = cpToU16(line, col);
    for (const re of LINK_PATTERNS) {
        re.lastIndex = 0;
        let r: RegExpExecArray | null;
        while ((r = re.exec(line))) {
            if (pos >= r.index && pos <= r.index + r[0].length) return r[1] ?? r[0];
        }
    }
    return null;
}

// [[Note]] at `col`, or null.
export function wikiLinkAt(line: string, col: number): WikiLink | null {
    const pos = cpToU16(line, col);
    for (const r of line.matchAll(WIKILINK())) {
        if (pos >= r.index && pos <= r.index + r[0].length) return parseWikiLink(r[0].slice(2, -2));
    }
    return null;
}
