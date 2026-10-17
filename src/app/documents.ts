// The open documents (tabs): which one is active, opening files into them, saving, asking before discarding
// changes, the Home tab, and restoring the tabs of the last session. The window composes the widgets; it gives this
// controller hooks for what must follow a document on screen (DocumentsHost), and keeps thin public methods that
// pass through for the actions and tests.

import { after, type Awaitable } from '../awaitable.js';
import type { AppSettings } from '../settings.js';
import { readTextFile, writeTextFile, fileExists, insideName } from '../files.js';
import { platform } from '../platform/index.js';
import { moveRecent, rememberRecent } from '../markdown/home.js';
import { markdownToHtml } from '../markdown/html.js';
import { _, fmt, ngettext } from '../i18n.js';
import { errorMessage, type Doc, type TextEditor, type ToastAction } from './document.js';
import type { ChooseFileOptions } from './dialogs.js';
import type { Autosaver } from './autosave.js';

export const UNTITLED = _('Untitled');
export const HOME = _('Home');
// The marker of the Home tab in the saved tab list (not a file path).
const HOME_TAB = 'markwork:home';

// The questions about documents; each frontend shows its own dialogs.
export interface DocumentDialogs {
    askSaveChanges(documentName: string): Promise<'save' | 'discard' | 'cancel'>;
    showError(message: string): void;
    chooseFile(options: ChooseFileOptions): Promise<string | null>;   // null = cancelled
}

// Where `path` lands when `source` is moved to `target`; null if path is outside source.
export function remapPath(path: string, source: string, target: string): string | null {
    if (path === source) return target;
    return path.startsWith(`${source}/`) ? target + path.slice(source.length) : null;
}

export interface DocumentsHost<E extends TextEditor> {
    readonly settings: AppSettings;
    readonly dialogs: DocumentDialogs;
    createEditor(id: number): E;                // the editor for a new document (a MarkdownView under GTK, a replica over the protocol)
    readonly autosaver: Autosaver;
    root(): string | null;
    toast(message: string, action?: ToastAction): void;
    // A new document: connect its editor, and add its page and tab. Called before it joins the list, so the
    // active document is still the previous one (a new document inherits its modes).
    attach(id: number): void;
    // A closed document: remove its tab and page and destroy its editor (it is no longer in the list).
    detach(id: number): void;
    // doc became the active document: the outline, search, tab row, and side panels follow it.
    activated(id: number): void;
    // The active document's contents or file changed: pick the view (text/board/inbox/Home), the title, the tree highlight, history.
    contentChanged(id: number): void;
    refreshTitle(id: number): void;
    setIcon(id: number, icon: string | null): void;
    tabOrder(): number[];                       // document ids in the order of the tab row
    refreshHome(): void;
    openFolder(path: string): void;
    fileSaved(path: string): void;              // a new file was written through Save As: show it in the tree
}

type MutableDoc = { -readonly [K in keyof Doc]: Doc[K] };

export class DocumentController<E extends TextEditor> {
    private docs: Doc<E>[] = [];
    private current!: Doc<E>;
    private nextId = 1;
    private restoring = false;   // a tab from the last session is being reopened: do not record it as newly opened

    constructor(private readonly host: DocumentsHost<E>) {}

    // The first document, active without the activation hooks (the window is still being built).
    start(): Doc<E> {
        this.current = this.add();
        return this.current;
    }

    get active(): Doc<E> {
        return this.current;
    }

    get all(): readonly Doc<E>[] {
        return this.docs;
    }

    // Create an empty document together with its editor, without activating it.
    add(): Doc<E> {
        const id = this.nextId++;
        const doc: Doc<E> = { id, editor: this.host.createEditor(id), file: null, home: false };
        this.host.attach(id);
        this.docs.push(doc);
        return doc;
    }

    // Make doc the active document: all components follow it.
    activate(doc: Doc<E>): void {
        if (doc === this.current) return;
        const previous = this.current;
        this.current = doc;
        this.host.autosaver.now(previous);   // leaving a tab = a safe point to save
        if (doc.file) this.rememberRecent(doc.file);
        this.host.activated(doc.id);
    }

    // Tab name/title for a document.
    nameOf(doc: Doc): string {
        if (doc.home) return HOME;
        return doc.file ? platform().paths.basename(doc.file) : UNTITLED;
    }

    // A document without a file and without changes has no contents that need to be kept,
    // so it may be reused for the next file that is opened.
    isPristine(doc: Doc): boolean {
        return !doc.home && !doc.file && !doc.editor.isModified();
    }

    // The tab after/before the active one (wraps around).
    switchTab(step: number): void {
        const ids = this.host.tabOrder();
        const at = ids.indexOf(this.current.id);
        const doc = this.docs.find(d => d.id === ids[(at + step + ids.length) % ids.length]);
        if (doc) this.activate(doc);
    }

    // Close a tab (asks if there are changes). Closing the only tab empties its document.
    closeTab(doc: Doc<E> = this.current): Awaitable<boolean> {
        return after(this.confirmDiscard(doc), yes => yes && this.docs.includes(doc) && this.remove(doc));
    }

    // Close the tabs whose file lies outside folder (asks about unsaved changes first).
    // false = the user cancelled, so the folder should not be switched.
    closeOutside(folder: string): Awaitable<boolean> {
        const stale = this.docs.filter(d => d.file && insideName(folder, d.file) === null);
        if (stale.length === 0) return true;
        return after(this.confirmDiscardAll(stale), yes => {
            if (!yes) return false;
            for (const doc of stale) if (this.docs.includes(doc)) this.remove(doc);
            return true;
        });
    }

    private remove(doc: Doc<E>): boolean {
        if (this.docs.length === 1) {
            if (doc.home && this.host.settings.home) return true;
            this.reset(doc);
            if (this.host.settings.home) this.makeHome(doc);
            return true;
        }
        const index = this.docs.indexOf(doc);
        this.host.autosaver.cancel(doc);
        this.docs.splice(index, 1);
        // Move first, then destroy: the search and other components still point at this editor.
        if (doc === this.current) this.activate(this.docs[Math.min(index, this.docs.length - 1)]);
        this.host.detach(doc.id);
        return true;
    }

    // ---------- Asking before discarding ----------

    // If there are changes, ask first. true = it is fine to go on and discard this document.
    // Without changes that need asking about, the answer is immediate (without a Promise).
    confirmDiscard(doc: Doc<E> = this.current): Awaitable<boolean> {
        if (this.host.autosaver.now(doc)) return true;
        this.activate(doc);   // the user needs to see which document is being asked about
        return this.host.dialogs.askSaveChanges(this.nameOf(doc)).then(answer => {
            if (answer !== 'save') return answer === 'discard';
            this.activate(doc);
            return this.save();
        });
    }

    // Ask about documents one by one; stop at the first Cancel answer.
    confirmDiscardAll(docs: Doc<E>[] = [...this.docs]): Awaitable<boolean> {
        for (let i = 0; i < docs.length; i++) {
            const answer = this.confirmDiscard(docs[i]);
            if (answer === false) return false;
            if (answer !== true) return answer.then(yes => yes && this.confirmDiscardAll(docs.slice(i + 1)));
        }
        return true;
    }

    // ---------- New and opened documents ----------

    // The document that may be overwritten: the active one if it has no contents that need to be kept, otherwise a new tab.
    blank(): Doc<E> {
        const doc = this.isPristine(this.current) ? this.current : this.add();
        this.activate(doc);
        return doc;
    }

    // Empty doc (or fill it with text) as a new document without a file.
    reset(doc: Doc<E>, text = ''): void {
        this.activate(doc);
        this.set(doc, { file: null, home: false });
        this.host.setIcon(doc.id, null);
        doc.editor.setText(text);
        this.host.contentChanged(doc.id);
    }

    // Fill the active document with the absolute file that has been read (text).
    private show(absolute: string, text: string): void {
        const doc = this.current;
        // The file is set before setText(): relative image paths are resolved from its folder.
        this.set(doc, { file: absolute });
        this.rememberRecent(absolute);
        doc.editor.setText(text);
        this.host.contentChanged(doc.id);
    }

    private read(absolute: string): string | null {
        try {
            return fileExists(absolute) ? readTextFile(absolute) : '';  // a new file if it does not exist yet
        } catch (e) {
            this.host.dialogs.showError(fmt(_('Failed to open the file:\n{error}'), { error: errorMessage(e) }));
            return null;
        }
    }

    // Open a file in the active document, replacing its contents. If the path turns out to be a folder (for example chosen
    // through the Open File dialog, or given on the command line), that folder is opened in the Files tab.
    load(path: string): boolean {
        const absolute = platform().paths.resolve(path);
        if (platform().fs.isDirectory(absolute)) {
            this.host.openFolder(absolute);
            return true;
        }
        const text = this.read(absolute);
        if (text === null) return false;
        this.show(absolute, text);
        return true;
    }

    // Open a file in a tab: switch to its tab if already open, use the active empty document if there is one,
    // otherwise open a new tab.
    openInTab(path: string): boolean {
        const absolute = platform().paths.resolve(path);
        if (platform().fs.isDirectory(absolute)) {
            this.host.openFolder(absolute);
            return true;
        }
        const open = this.docs.find(d => d.file === absolute);
        if (open) {
            this.activate(open);
            return true;
        }
        const text = this.read(absolute);
        if (text === null) return false;
        this.activate(this.isPristine(this.current) ? this.current : this.add());
        this.show(absolute, text);
        return true;
    }

    rememberRecent(path: string): void {
        if (this.restoring) return;
        this.host.settings.recentFiles = rememberRecent(this.host.settings.recentFiles, path, Math.floor(Date.now() / 1000));
    }

    // ---------- Home ----------

    // Switch to the Home tab, or open it if there is none (using the active empty tab if there is one).
    openHome(): void {
        const open = this.docs.find(d => d.home);
        if (open) {
            if (open === this.current) this.host.refreshHome();
            else this.activate(open);
            return;
        }
        this.makeHome(this.isPristine(this.current) ? this.current : this.add());
    }

    private makeHome(doc: Doc<E>): void {
        this.set(doc, { file: null, home: true });
        this.host.setIcon(doc.id, 'user-home-symbolic');
        this.activate(doc);
        this.host.contentChanged(doc.id);
    }

    // ---------- Saving ----------

    write(path: string, text: string): boolean {
        try {
            writeTextFile(path, text);
            return true;
        } catch (e) {
            this.host.dialogs.showError(fmt(_('Failed to save:\n{error}'), { error: errorMessage(e) }));
            return false;
        }
    }

    // A file document is saved instantly (a boolean result); a new document waits for the Save As dialog.
    save(): Awaitable<boolean> {
        const doc = this.current;
        if (doc.home) return true;
        if (!doc.file) return this.saveAs();
        if (!this.write(doc.file, doc.editor.getText())) return false;
        doc.editor.setModified(false);
        this.host.autosaver.cancel(doc);
        this.host.toast(_('Saved'));
        return true;
    }

    async saveAs(): Promise<boolean> {
        const doc = this.current;
        if (doc.home) return false;
        let path = await this.host.dialogs.chooseFile({
            title: _('Save Markdown'), save: true, filters: ['markdown', 'all'],
            name: doc.file ? this.nameOf(doc) : `${this.suggestName()}.md`,
            // A new document is saved in the folder that is currently open.
            folder: doc.file ? null : this.host.root(),
        });
        if (!path || !this.docs.includes(doc)) return false;
        if (!/\.[^/]+$/.test(platform().paths.basename(path))) path += '.md';
        this.activate(doc);
        this.set(doc, { file: path });
        this.host.refreshTitle(doc.id);
        if (!this.save()) return false;
        this.host.fileSaved(path);
        return true;
    }

    // Save all changed file documents (before a git commit). Documents without a file are not touched.
    saveOpenFiles(): boolean {
        for (const doc of this.docs) {
            if (!doc.file || !doc.editor.isModified()) continue;
            if (!this.write(doc.file, doc.editor.getText())) return false;
            doc.editor.setModified(false);
            this.host.autosaver.cancel(doc);
        }
        return true;
    }

    // Suggested file name from the first heading.
    suggestName(): string {
        const h = this.current.editor.headings[0];
        return h?.text ? h.text.replace(/[\/\\:*?"<>|]/g, '').slice(0, 60) : UNTITLED;
    }

    // ---------- The file of an open document ----------

    // The only place the file and Home flag of a document change.
    private set(doc: Doc<E>, change: Partial<Pick<Doc, 'file' | 'home'>>): void {
        Object.assign(doc as MutableDoc, change);
    }

    // Set the file without reading it, e.g. before saving a new document there (tests, the window's file setter).
    setFile(doc: Doc<E>, path: string | null): void {
        this.set(doc, { file: path });
    }

    // The document's file was moved or renamed (in the tree, or by an agent change); the contents do not change.
    fileMoved(doc: Doc<E>, path: string): void {
        this.set(doc, { file: path });
        this.host.refreshTitle(doc.id);
    }

    // The document's file was deleted: its contents stay in the editor, marked as unsaved.
    fileGone(doc: Doc<E>): void {
        this.set(doc, { file: null });
        doc.editor.setModified(true);
        this.host.refreshTitle(doc.id);
    }

    // A deleted file was written back with the editor's contents (an undone delete): the document is saved again.
    fileBack(doc: Doc<E>, path: string): void {
        this.set(doc, { file: path });
        doc.editor.setModified(false);
        this.host.refreshTitle(doc.id);
    }

    // ---------- Files moved or deleted in the tree ----------

    // Open documents under `from` move along to `to`; their contents do not change.
    filesMoved(from: string, to: string): void {
        for (const doc of this.docs) {
            const moved = doc.file ? remapPath(doc.file, from, to) : null;
            if (moved) this.fileMoved(doc, moved);
        }
        this.host.settings.recentFiles = moveRecent(this.host.settings.recentFiles, from, to);
    }

    // Open documents at or under `path` lose their file: their contents stay in the editor, marked as unsaved.
    fileDeleted(path: string): void {
        for (const doc of this.docs) {
            if (doc.file && remapPath(doc.file, path, path)) this.fileGone(doc);
        }
    }

    // ---------- Export and images ----------

    async exportHtml(): Promise<void> {
        const doc = this.current;
        if (doc.home) return;
        const base = doc.file ? this.nameOf(doc).replace(/\.[^.]+$/, '') : this.suggestName();
        const text = doc.editor.getText(), title = doc.editor.headings[0]?.text || base;
        const path = await this.host.dialogs.chooseFile({
            title: _('Export HTML'), save: true, filters: ['html', 'all'], name: `${base}.html`,
            folder: doc.file ? platform().paths.dirname(doc.file) : null,
        });
        if (!path) return;
        const html = markdownToHtml(text, title);
        if (this.write(path, html)) this.host.toast(fmt(_('Exported to {name}'), { name: platform().paths.basename(path) }));
    }

    // Insert ![name](path). The path is made relative to the file if possible.
    async insertImage(): Promise<void> {
        const doc = this.current;
        let path = await this.host.dialogs.chooseFile({ title: _('Choose Image'), filters: ['image'] });
        if (!path || doc !== this.current) return;
        const { paths } = platform();
        if (doc.file) path = paths.relative(paths.dirname(doc.file), path) ?? path;
        const alt = paths.basename(path).replace(/\.[^.]+$/, '');
        doc.editor.insertAtCursor(`![${alt}](${encodeURI(path)})`);
    }

    // ---------- Tab restoration ----------

    // Record file tabs (ordered like the tab row) together with their cursors for the next launch.
    // Documents without a file are not recorded: their contents are not on disk to be read again.
    rememberTabs(): void {
        const docs = this.host.tabOrder()
            .map(id => this.docs.find(d => d.id === id))
            .filter((d): d is Doc<E> => !!d && (!!d.file || d.home));
        this.host.settings.tabs = docs.map(d => ({ file: d.home ? HOME_TAB : d.file!, cursor: d.home ? 0 : d.editor.cursorOffset }));
        this.host.settings.activeTab = docs.indexOf(this.current);
    }

    // Reopen tabs from the settings. Files that have gone missing are skipped (not recreated).
    // true = some tabs were restored.
    restoreTabs(): boolean {
        const settings = this.host.settings;
        const saved = Array.isArray(settings.tabs) ? settings.tabs : [];
        const opened: [Doc<E>, number][] = [];
        let active: Doc<E> | null = null;
        let missing = 0;
        this.restoring = true;
        for (const [i, tab] of saved.entries()) {
            if (tab?.file === HOME_TAB) {
                this.openHome();
                opened.push([this.current, 0]);
                if (i === settings.activeTab) active = this.current;
                continue;
            }
            if (typeof tab?.file !== 'string' || !fileExists(tab.file) || platform().fs.isDirectory(tab.file)) {
                missing++;
                continue;
            }
            if (!this.openInTab(tab.file)) continue;
            opened.push([this.current, Number(tab.cursor) || 0]);
            if (i === settings.activeTab) active = this.current;
        }
        this.restoring = false;
        if (!opened.length) return false;
        for (const [doc, cursor] of opened) doc.editor.restoreCursor(cursor);
        this.activate(active ?? opened[opened.length - 1][0]);
        if (missing) this.host.toast(fmt(ngettext('{missing} file from the last session was not found', '{missing} files from the last session were not found', missing), { missing }));
        return true;
    }
}
