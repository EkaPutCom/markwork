// The views of a document's notes (ViewController: board, list, table, and the layouts): what the user did, as an
// operation the core applies to the board it holds (docs/design/protocol.md, 6.3).

import type { NoteEdit } from '../../../markdown/noteedit.js';
import { parseWikiLink } from '../../../markdown/wikilink.js';
import { RequestError } from '../messages.js';
import { num, str, type HandlerContext } from './context.js';

export function notesHandlers({ wire, session, frontend }: HandlerContext): void {
    wire.on('act.notes.edit', p => {
        const edit = p.edit as NoteEdit | undefined;
        if (!edit || typeof edit.kind !== 'string') throw new RequestError('bad_request', 'edit is missing');
        frontend.editNotes(edit);
    });

    // The CSV tab: the frontend sends the text after each change, and the size of the table it shows.
    wire.on('act.csv.change', p => { frontend.csv.onChange(str(p.text, 'text')); });
    wire.on('act.csv.shape', p => { frontend.csv.onShape(num(p.rows, 'rows'), num(p.columns, 'columns')); });

    // The note names a [[ suggestion offers for a document: its files, relative to the folder the links are looked up in.
    wire.on('ask.notes', p => ({ names: session.notes.namesFor(num(p.doc, 'doc')) }));
    // Ctrl+click on [[target#heading|alias]]: `link` is what is between the brackets.
    wire.on('open.note', p => {
        if (!session.notes.openFor(num(p.doc, 'doc'), parseWikiLink(str(p.link, 'link')))) throw new RequestError('stale', 'that document is closed');
    });
    // Ctrl+click on a link that is not a [[note]]: a Markdown file opens in a tab, a URL in the browser, other files in the
    // app the system picks (AppSession.openLink). A relative link is read from the document's folder.
    wire.on('open.link', p => {
        const doc = num(p.doc, 'doc');
        if (!session.documents.all.some(d => d.id === doc)) throw new RequestError('stale', 'that document is closed');
        session.openLink(doc, str(p.url, 'url'));
    });
}
