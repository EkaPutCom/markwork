// The views of a document's notes (ViewController: board, list, table, and the layouts): what the user did, as an
// operation the core applies to the board it holds (docs/design/protocol.md, 6.3).

import type { NoteEdit } from '../../../markdown/noteedit.js';
import { RequestError } from '../messages.js';
import type { HandlerContext } from './context.js';

export function notesHandlers({ wire, session }: HandlerContext): void {
    wire.on('act.notes.edit', p => {
        const edit = p.edit as NoteEdit | undefined;
        if (!edit || typeof edit.kind !== 'string') throw new RequestError('bad_request', 'edit is missing');
        session.host.board.onEdit(edit);
    });
}
