// Editing tables in their raw text: Tab/Enter move between cells and rows, plus commands to add/delete rows and
// columns, align, and tidy up columns. What they do is markdown/editcommands.ts (the table model is markdown/table.ts);
// this applies it to a GtkTextBuffer (textedit.ts) and words why a command could not run.
//
// The commands read the document from the buffer (not from the last highlighting result), so they always match the
// text being displayed.

import type Gtk from 'gi://Gtk?version=4.0';
import { enterInTable as enterLine, runTableCommand as runOnText, tabInTable as tabLine, type TableCommand, type TableFailure } from '../markdown/editcommands.js';
import { runEdit } from './textedit.js';
import { _ } from '../i18n.js';

export type { TableCommand };

export type CommandResult = { ok: true } | { ok: false; reason: string };

// Tab / Shift+Tab: move to the next / previous cell. In the last cell, Tab adds a new row. true if the cursor is in a
// table (the key was handled).
export const tabInTable = (buffer: Gtk.TextBuffer, backward: boolean): boolean =>
    runEdit(buffer, 'document', state => tabLine(state, backward));

// Enter: move to the same cell in the next row (a new row if already on the last row); on an empty last body row, leave
// the table. true if the cursor is in a table.
export const enterInTable = (buffer: Gtk.TextBuffer): boolean => runEdit(buffer, 'document', enterLine);

const REASON: Record<TableFailure, () => string> = {
    'not-in-table': () => _('The cursor must be inside a table'),
    'row-above-header': () => _('Cannot insert a row above the table header'),
    'delete-header': () => _('The header row cannot be deleted'),
    'delete-last-column': () => _('The last column cannot be deleted'),
};

// Runs a command on the table at the cursor position.
export function runTableCommand(buffer: Gtk.TextBuffer, command: TableCommand): CommandResult {
    const failed: { reason?: TableFailure } = {};
    runEdit(buffer, 'document', state => {
        const result = runOnText(state, command);
        if (result.ok) return result.edit;
        failed.reason = result.reason;
        return null;
    });
    return failed.reason ? { ok: false, reason: REASON[failed.reason]() } : { ok: true };
}
