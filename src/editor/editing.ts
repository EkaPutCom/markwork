// Formatting commands that change the buffer contents: bold, link, heading, quote, etc. What they do is
// markdown/editcommands.ts; this applies it to a GtkTextBuffer (textedit.ts), so a single Ctrl+Z undoes each one.

import type Gtk from 'gi://Gtk?version=4.0';
import { block, heading, link, togglePrefix as toggle, wrap } from '../markdown/editcommands.js';
import { runEdit } from './textedit.js';

// Contents of one line with its start and end iters: [text, start, end].
export function lineText(buffer: Gtk.TextBuffer, iter: Gtk.TextIter): [string, Gtk.TextIter, Gtk.TextIter] {
    const s = iter.copy();
    s.set_line_offset(0);
    const e = iter.copy();
    if (!e.ends_line()) e.forward_to_line_end();
    return [buffer.get_text(s, e, true), s, e];
}

// The formatting commands of markdown/editcommands.ts on the buffer, each one undo step.

export const wrapSelection = (buffer: Gtk.TextBuffer, left: string, right = left): void => {
    // With a selection only the markers are inserted/removed, the selection is never empty. On X11, a selection that
    // was briefly empty releases the PRIMARY clipboard, and GTK 4 cancels the new selection as soon as the server
    // confirms that release (the second Ctrl+B then does not remove **). wrap() keeps it that way.
    runEdit(buffer, 'lines', state => wrap(state, left, right));
};
export const insertLink = (buffer: Gtk.TextBuffer): void => { runEdit(buffer, 'lines', link); };
export const insertBlock = (buffer: Gtk.TextBuffer, before: string, after: string): void => {
    runEdit(buffer, 'lines', state => block(state, before, after));
};
export const togglePrefix = (buffer: Gtk.TextBuffer, re: RegExp, prefix: string): void => {
    runEdit(buffer, 'lines', state => toggle(state, re, prefix));
};
export const setHeading = (buffer: Gtk.TextBuffer, level: number): void => { runEdit(buffer, 'lines', state => heading(state, level)); };
