// Meaning of clicks on text: checking task boxes, reading link URLs, and [[wikilink]] targets. The text logic is
// markdown/clicks.ts; this adapter checks the tags under the iter and applies the result to the buffer.

import type Gtk from 'gi://Gtk?version=4.0';
import type { Tags } from './tags.js';
import { lineText } from './editing.js';
import { taskToggleAt, linkAt as linkInLine, wikiLinkAt as wikiLinkInLine } from '../markdown/clicks.js';
import type { WikiLink } from '../markdown/wikilink.js';

// Click on "[ ]" / "[x]" → flip its checked state. Returns true if handled.
export function toggleTaskAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): boolean {
    if (!iter.has_tag(tags.task) && !iter.has_tag(tags.taskdone)) return false;
    const [line, ls] = lineText(buffer, iter);
    const toggle = taskToggleAt(line, iter.get_line_offset());
    if (!toggle) return false;
    const a = ls.copy();
    a.forward_chars(toggle.column);
    const b = a.copy();
    b.forward_char();
    buffer.begin_user_action();
    buffer.delete(a, b);
    buffer.insert(a, toggle.text, -1);
    buffer.end_user_action();
    return true;
}

// URL of the link at the iter position, or null.
export function linkAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): string | null {
    if (!iter.has_tag(tags.link) && !iter.has_tag(tags.image)) return null;
    return linkInLine(lineText(buffer, iter)[0], iter.get_line_offset());
}

// [[Note]] at the iter position, or null.
export function wikiLinkAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): WikiLink | null {
    if (!iter.has_tag(tags.link)) return null;
    return wikiLinkInLine(lineText(buffer, iter)[0], iter.get_line_offset());
}
