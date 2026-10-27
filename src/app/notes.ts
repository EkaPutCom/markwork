// Following [[note]] links from the editor, a board card, or an inbox item.

import { newNotePath, resolveWikiLink, type WikiLink } from '../markdown/wikilink';
import { platform } from '../platform/index';
import { insideName } from '../base/files';
import type { WorkspaceRepository } from '../base/workspace';
import { _, fmt } from '../base/i18n';
import type { Doc, DocumentHost } from './document';

export interface NoteHost extends DocumentHost {
    readonly workspace: WorkspaceRepository;
}

export class NoteLinks {
    constructor(private readonly host: NoteHost) {}

    // The folder where [[notes]] are looked up: the work folder if the document is inside it (or not saved yet),
    // otherwise the document's own folder.
    rootFor(doc: Doc): string | null {
        const root = this.host.root();
        if (root && (!doc.file || insideName(root, doc.file) !== null)) return root;
        return doc.file ? platform().paths.dirname(doc.file) : null;
    }

    // Note names for [[ suggestions from `doc`.
    names(doc: Doc): string[] {
        const root = this.rootFor(doc);
        return root ? this.host.workspace.names(root) : [];
    }

    // The same for a document named by its id, as a frontend in another process asks (docs/design/protocol.md 7);
    // none for an id that is not open.
    namesFor(id: number): string[] {
        const doc = this.host.docs().find(d => d.id === id);
        return doc ? this.names(doc) : [];
    }

    // Ctrl+click on a link in the document named by its id, as a frontend in another process reports it; false for an
    // id that is not open.
    openFor(id: number, link: WikiLink): boolean {
        const doc = this.host.docs().find(d => d.id === id);
        if (doc) this.open(link, doc);
        return !!doc;
    }

    // Ctrl+click [[note]]: open its file in a tab. A note that does not exist yet is opened as an empty document
    // next to the source document and only written to disk when saved, so a mistaken click leaves no file behind.
    open(link: WikiLink, doc: Doc): void {
        const { host } = this;
        if (!link.target) {
            if (link.heading) this.jumpToHeading(doc, link.heading);
            return;
        }
        const root = this.rootFor(doc);
        if (!root) {
            host.toast(_('Open a folder or save the document first to follow [[note]] links'));
            return;
        }
        const from = doc.file ? insideName(root, doc.file) : null;
        const found = resolveWikiLink(link.target, host.workspace.names(root), from);
        const rel = found ?? newNotePath(link.target, from);
        if (!rel) {
            host.toast(fmt(_('Invalid note name: {target}'), { target: link.target }));
            return;
        }
        const { fs, paths } = platform();
        const path = paths.join(root, ...rel.split('/'));
        if (!found) fs.makeDirs(paths.dirname(path), 0o755);
        if (!host.openInTab(path)) return;
        if (!found) host.toast(fmt(_('New note: {rel} (saved once filled in)'), { rel }));
        else if (link.heading) this.jumpToHeading(host.active(), link.heading);
    }

    private jumpToHeading(doc: Doc, heading: string): void {
        const want = heading.trim().toLowerCase();
        const found = doc.editor.headings.find(h => h.text.trim().toLowerCase() === want);
        if (found) doc.editor.jumpToLine(found.line);
        else this.host.toast(fmt(_('Section not found: {heading}'), { heading }));
    }
}
