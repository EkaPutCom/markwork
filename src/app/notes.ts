// Following [[note]] links from the editor, a board card, or an inbox item.

import { newNotePath, resolveWikiLink, type WikiLink } from '../markdown/wikilink.js';
import { platform } from '../platform/index.js';
import type { WorkspaceRepository } from '../workspace.js';
import { _, fmt } from '../i18n.js';
import type { Doc, DocumentHost } from './document.js';

export interface NoteHost extends DocumentHost {
    readonly workspace: WorkspaceRepository;
}

export class NoteLinks {
    constructor(private readonly host: NoteHost) {}

    // The folder where [[notes]] are looked up: the work folder if the document is inside it (or not saved yet),
    // otherwise the document's own folder.
    rootFor(doc: Doc): string | null {
        const root = this.host.root();
        if (root && (!doc.file || doc.file.startsWith(`${root}/`))) return root;
        return doc.file ? platform().paths.dirname(doc.file) : null;
    }

    // Note names for [[ suggestions from `doc`.
    names(doc: Doc): string[] {
        const root = this.rootFor(doc);
        return root ? this.host.workspace.names(root) : [];
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
        const from = doc.file?.startsWith(`${root}/`) ? doc.file.slice(root.length + 1) : null;
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
