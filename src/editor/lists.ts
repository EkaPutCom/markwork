// Enter and Tab behavior inside lists and quotes. What they do is markdown/editcommands.ts; this applies it to a
// GtkTextBuffer (textedit.ts).

import type Gtk from 'gi://Gtk?version=4.0';
import { continueBlock as continueLine, indentListItem as indentLine } from '../markdown/editcommands.js';
import { runEdit } from './textedit.js';

// Enter on a list/quote line. true if handled (see continueBlock in editcommands.ts).
export const continueBlock = (buffer: Gtk.TextBuffer): boolean => runEdit(buffer, 'lines', continueLine);

// Tab / Shift+Tab on a list line: increase or decrease the indentation by 4 spaces. true if handled.
export const indentListItem = (buffer: Gtk.TextBuffer, outdent: boolean): boolean =>
    runEdit(buffer, 'lines', state => indentLine(state, outdent));
