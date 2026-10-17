// Meaning of clicks on text: checking task boxes, reading link URLs, and [[wikilink]] targets.

import type Gtk from 'gi://Gtk?version=4.0';
import { cpToU16, cpLength } from '../markdown/offsets.js';
import type { Tags } from './tags.js';
import { lineText } from './editing.js';
import { WIKILINK, parseWikiLink, type WikiLink } from '../markdown/wikilink.js';

// Click on "[ ]" / "[x]" → flip its checked state. Returns true if handled.
export function toggleTaskAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): boolean {
    if (!iter.has_tag(tags.task) && !iter.has_tag(tags.taskdone)) return false;
    const [line, ls] = lineText(buffer, iter);
    const k = line.lastIndexOf('[', cpToU16(line, iter.get_line_offset()));
    if (k < 0 || !/^\[[ xX]\]/.test(line.slice(k))) return false;
    const a = ls.copy();
    a.forward_chars(cpLength(line.slice(0, k + 1)));
    const b = a.copy();
    b.forward_char();
    buffer.begin_user_action();
    buffer.delete(a, b);
    buffer.insert(a, line[k + 1] === ' ' ? 'x' : ' ', -1);
    buffer.end_user_action();
    return true;
}

const LINK_PATTERNS = [
    /!?\[[^\]]*\]\(([^)\s]*)[^)]*\)/g,          // [text](url) and ![alt](url)
    /<((?:https?|mailto|ftp):[^\s>]+)>/g,          // <https://...>
    /\bhttps?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"]/g,  // bare URL
];

// URL of the link at the iter position, or null.
export function linkAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): string | null {
    if (!iter.has_tag(tags.link) && !iter.has_tag(tags.image)) return null;
    const [line] = lineText(buffer, iter);
    const pos = cpToU16(line, iter.get_line_offset());
    for (const re of LINK_PATTERNS) {
        re.lastIndex = 0;
        let r: RegExpExecArray | null;
        while ((r = re.exec(line))) {
            if (pos >= r.index && pos <= r.index + r[0].length) return r[1] ?? r[0];
        }
    }
    return null;
}

// [[Note]] at the iter position, or null.
export function wikiLinkAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): WikiLink | null {
    if (!iter.has_tag(tags.link)) return null;
    const [line] = lineText(buffer, iter);
    const pos = cpToU16(line, iter.get_line_offset());
    for (const r of line.matchAll(WIKILINK())) {
        if (pos >= r.index && pos <= r.index + r[0].length) return parseWikiLink(r[0].slice(2, -2));
    }
    return null;
}
