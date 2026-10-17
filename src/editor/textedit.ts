// The GtkTextBuffer side of the editor commands (markdown/editcommands.ts): read the text and the selection, hand them
// to a command, and apply the edit it returns as one undo step. GTK counts code points and the commands count UTF-16
// units, so the offsets are converted here.

import type Gtk from 'gi://Gtk?version=4.0';
import { applyChanges, type TextEdit, type TextState } from '../markdown/editcommands.js';
import { makeCpMap, makeU16Map } from './offsets.js';

// What a command reads: the lines the selection touches (enough for every command that works on lines) or the whole
// document (the table commands, which find the table from its first line).
export type Scope = 'lines' | 'document';

interface Snapshot {
    readonly state: TextState;
    readonly start: number;   // code point offset in the buffer where state.text starts
}

function snapshot(buffer: Gtk.TextBuffer, scope: Scope): Snapshot {
    const head = buffer.get_iter_at_mark(buffer.get_insert());
    const anchor = buffer.get_iter_at_mark(buffer.get_selection_bound());
    let start: Gtk.TextIter, end: Gtk.TextIter;
    if (scope === 'document') {
        [start, end] = buffer.get_bounds();
    } else {
        const [first, last] = head.compare(anchor) <= 0 ? [head, anchor] : [anchor, head];
        start = first.copy();
        start.set_line_offset(0);
        end = last.copy();
        if (!end.ends_line()) end.forward_to_line_end();
    }
    const text = buffer.get_text(start, end, true);
    const toU16 = makeU16Map(text), base = start.get_offset();
    return { state: { text, anchor: toU16(anchor.get_offset() - base), head: toU16(head.get_offset() - base) }, start: base };
}

// Applies the edit: the changes from the last to the first, so the offsets of the earlier ones stay valid, then the
// selection. One user action, so a single Ctrl+Z undoes it.
function apply(buffer: Gtk.TextBuffer, { state, start }: Snapshot, edit: TextEdit): void {
    const toCp = makeCpMap(state.text);
    const at = (offset: number) => buffer.get_iter_at_offset(start + offset);
    buffer.begin_user_action();
    for (const change of [...edit.changes].reverse()) {
        const from = toCp(change.from), to = toCp(change.to);
        if (to > from) buffer.delete(at(from), at(to));
        if (change.insert) buffer.insert(at(from), change.insert, -1);
    }
    const after = edit.changes.length ? makeCpMap(applyChanges(state.text, edit.changes)) : toCp;
    const { anchor, head } = edit.selection;
    if (anchor === head) buffer.place_cursor(at(after(head)));
    else buffer.select_range(at(after(head)), at(after(anchor)));
    buffer.end_user_action();
}

// Runs a command on the buffer. false if the command did not handle it (it returned null): nothing changes.
export function runEdit(buffer: Gtk.TextBuffer, scope: Scope, command: (state: TextState) => TextEdit | null): boolean {
    const snap = snapshot(buffer, scope);
    const edit = command(snap.state);
    if (!edit) return false;
    apply(buffer, snap, edit);
    return true;
}
