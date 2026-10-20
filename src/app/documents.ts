// The open tabs: the documents (which one is active, opening files into them, saving, asking before discarding
// changes) and the pages (Home, an HTML file in its sandbox), and restoring the tabs of the last session. The window composes the widgets; it gives this
// controller hooks for what must follow a document on screen (DocumentsHost), and keeps thin public methods that
// pass through for the actions and tests.

import { after, type Awaitable } from '../awaitable.js';
import type { AppSettings } from '../settings.js';
import { readTextFile, writeTextFile, fileExists, insideName } from '../files.js';
import { platform } from '../platform/index.js';
import { moveRecent, rememberRecent } from '../markdown/home.js';
import { markdownToHtml } from '../markdown/html.js';
import { _, fmt, ngettext } from '../i18n.js';
import { errorMessage, type Doc, type Page, type TextEditor, type ToastAction } from './document.js';
import type { ChooseFileOptions } from './dialogs.js';
import type { Autosaver } from './autosave.js';
import { below } from '../markdown/paths.js';

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
    return below(source, path) ? target + path.slice(source.length) : null;
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
    // The document's tab appears or goes. The one empty document kept while only pages are open has no tab.
    listTab(id: number, listed: boolean): void;
    // doc became the active document: the outline, search, tab row, and side panels follow it.
    activated(id: number): void;
    // A page: its tab and contents are added, and removed again when it is closed.
    attachPage(page: Page): void;
    detachPage(id: number): void;
    // A page became the shown tab: the tab row and the content area follow it; no document is active then.
    pageActivated(id: number): void;
    // The active document's contents or file changed: pick the view (text/board/inbox), the title, the tree highlight, history.
    contentChanged(id: number): void;
    refreshTitle(id: number): void;
    tabOrder(): number[];                       // tab ids (documents and pages) in the order of the tab row
    refreshHome(): void;
    openFolder(path: string): void;
    fileSaved(path: string): void;              // a new file was written through Save As: show it in the tree
}

type MutableDoc = { -readonly [K in keyof Doc]: Doc[K] };

export class DocumentController<E extends TextEditor> {
    private docs: Doc<E>[] = [];
    private current!: Doc<E>;   // the active document; while a page is shown, the last one that was (what the page leaves behind)
    private pages: Page[] = [];
    private shown: Page | null = null;     // the page that is shown instead of the active document
    // While only pages are open there is still one empty document, because the application always has an active one. It
    // has no tab, and it comes back when a file is opened or a new document made.
    private parked: Doc<E> | null = null;
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

    // The page that is shown, or null when a document is.
    get page(): Page | null {
        return this.shown;
    }

    get allPages(): readonly Page[] {
        return this.pages;
    }

    // Create an empty document together with its editor, without activating it.
    add(): Doc<E> {
        const id = this.nextId++;
        const doc: Doc<E> = { id, editor: this.host.createEditor(id), file: null };
        this.host.attach(id);
        this.docs.push(doc);
        return doc;
    }

    // Make doc the active document: all components follow it.
    activate(doc: Doc<E>): void {
        if (doc === this.current && !this.shown && this.parked !== doc) return;
        const previous = this.current;
        this.current = doc;
        this.shown = null;
        if (this.parked === doc) this.unpark(doc);
        this.host.autosaver.now(previous);   // leaving a tab = a safe point to save
        if (doc.file) this.rememberRecent(doc.file);
        this.host.activated(doc.id);
    }

    // Tab name/title for a document.
    nameOf(doc: Doc): string {
        return doc.file ? platform().paths.basename(doc.file) : UNTITLED;
    }

    // Tab name/title for a page.
    nameOfPage(page: Page): string {
        return page.file ? platform().paths.basename(page.file) : HOME;
    }

    // A document without a file and without changes has no contents that need to be kept,
    // so it may be reused for the next file that is opened.
    isPristine(doc: Doc): boolean {
        return !doc.file && !doc.editor.isModified();
    }

    // The tab after/before the one shown (wraps around).
    switchTab(step: number): void {
        const ids = this.host.tabOrder();
        const at = ids.indexOf((this.shown ?? this.current).id);
        this.select(ids[(at + step + ids.length) % ids.length]);
    }

    // The tab with this id (a document or a page) becomes the shown one.
    select(id: number): void {
        const doc = this.docs.find(d => d.id === id);
        if (doc) {
            this.activate(doc);
            return;
        }
        const page = this.pages.find(p => p.id === id);
        if (page) this.activatePage(page);
    }

    // The close button of a tab: a document asks about its changes, a page closes at once.
    closeById(id: number): Awaitable<boolean> {
        const doc = this.docs.find(d => d.id === id);
        if (doc) return this.closeTab(doc);
        const page = this.pages.find(p => p.id === id);
        return page ? this.closePage(page) : false;
    }

    // Close a tab (asks if there are changes); the shown tab if no document is named. Closing the only tab empties its document.
    closeTab(doc?: Doc<E>): Awaitable<boolean> {
        if (!doc && this.shown) return this.closePage(this.shown);
        const target = doc ?? this.current;
        return after(this.confirmDiscard(target), yes => yes && this.docs.includes(target) && this.remove(target));
    }

    // Close the tabs whose file lies outside folder (asks about unsaved changes first).
    // false = the user cancelled, so the folder should not be switched.
    closeOutside(folder: string): Awaitable<boolean> {
        const stale = this.docs.filter(d => d.file && insideName(folder, d.file) === null);
        const stalePages = this.pages.filter(p => p.file && insideName(folder, p.file) === null);
        if (stale.length === 0 && stalePages.length === 0) return true;
        return after(this.confirmDiscardAll(stale), yes => {
            if (!yes) return false;
            for (const doc of stale) if (this.docs.includes(doc)) this.remove(doc);
            for (const page of stalePages) if (this.pages.includes(page)) this.closePage(page);
            return true;
        });
    }

    private remove(doc: Doc<E>): boolean {
        if (this.docs.length === 1) {
            // The last document is emptied, not closed. What is shown next: a page that is open, else Home if it is
            // switched on, else the empty document itself.
            const was = this.shown;
            this.reset(doc);
            if (this.pages.length) {
                this.park(doc);
                this.activatePage(was ?? this.pages[this.pages.length - 1]);
            } else if (this.host.settings.home) this.openHome();
            return true;
        }
        const index = this.docs.indexOf(doc);
        this.host.autosaver.cancel(doc);
        this.docs.splice(index, 1);
        // Move first, then destroy: the search and other components still point at this editor.
        if (doc === this.current) {
            const next = this.docs[Math.min(index, this.docs.length - 1)];
            if (this.shown) {
                this.current = next;   // a page stays shown; what it leaves behind is now the neighbor
                this.host.pageActivated(this.shown.id);
            } else this.activate(next);
        }
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
        this.set(doc, { file: null });
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
        const open = this.docs.find(d => d.file !== null && platform().paths.same(d.file, absolute));
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

    // ---------- Pages: Home and HTML files ----------

    // Switch to the Home tab, or open it if there is none.
    openHome(): void {
        const open = this.pages.find(p => p.kind === 'home');
        if (open) {
            if (open === this.shown) this.host.refreshHome();
            else this.activatePage(open);
            return;
        }
        this.openPage({ kind: 'home', file: null, root: null });
    }

    // Show an HTML file in its own tab, or switch to the tab it already has. root = the folder the page may read.
    openHtml(path: string, root: string | null): void {
        const absolute = platform().paths.resolve(path);
        const open = this.pages.find(p => p.file !== null && platform().paths.same(p.file, absolute));
        if (open) {
            this.activatePage(open);
            return;
        }
        const folder = platform().paths.dirname(absolute);
        this.openPage({ kind: 'html', file: absolute, root: root && insideName(root, absolute) !== null ? root : folder });
    }

    private openPage(spec: Omit<Page, 'id'>): void {
        const page: Page = { id: this.nextId++, ...spec };
        this.pages.push(page);
        this.host.attachPage(page);
        this.retirePristine();
        this.activatePage(page);
    }

    // The tab of an empty document does not stay next to a page: it goes, or is parked if it is the only document.
    private retirePristine(): void {
        const doc = this.current;
        if (this.parked || !this.isPristine(doc)) return;
        if (this.docs.length === 1) {
            this.park(doc);
            return;
        }
        const index = this.docs.indexOf(doc);
        this.host.autosaver.cancel(doc);
        this.docs.splice(index, 1);
        this.current = this.docs[Math.min(index, this.docs.length - 1)];
        this.host.detach(doc.id);
    }

    private park(doc: Doc<E>): void {
        this.parked = doc;
        this.host.listTab(doc.id, false);
    }

    private unpark(doc: Doc<E>): void {
        this.parked = null;
        this.host.listTab(doc.id, true);
    }

    private activatePage(page: Page): void {
        if (page === this.shown) return;
        this.host.autosaver.now(this.current);   // leaving a document = a safe point to save
        this.shown = page;
        this.host.pageActivated(page.id);
    }

    // Close a page's tab. The last tab of all stays when it is Home and Home is switched on.
    closePage(page: Page): boolean {
        const ids = this.host.tabOrder();
        const at = ids.indexOf(page.id);
        const neighbor = ids[at + 1] ?? ids[at - 1];
        if (neighbor === undefined) {
            // The only tab: Home stays; an HTML page gives way to Home, or to the empty document.
            if (page.kind === 'home' && this.host.settings.home) return true;
            this.dropPage(page);
            if (this.host.settings.home) this.openHome();
            else if (this.parked) this.activate(this.parked);
            return true;
        }
        if (page === this.shown) this.select(neighbor);
        this.dropPage(page);
        return true;
    }

    private dropPage(page: Page): void {
        this.pages.splice(this.pages.indexOf(page), 1);
        if (this.shown === page) this.shown = null;
        this.host.detachPage(page.id);
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
        if (this.shown) return true;
        if (!doc.file) return this.saveAs();
        if (!this.write(doc.file, doc.editor.getText())) return false;
        doc.editor.setModified(false);
        this.host.autosaver.cancel(doc);
        this.host.toast(_('Saved'));
        return true;
    }

    async saveAs(): Promise<boolean> {
        const doc = this.current;
        if (this.shown) return false;
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

    // The only place the file of a document changes.
    private set(doc: Doc<E>, change: Partial<Pick<Doc, 'file'>>): void {
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
        if (this.shown) return;
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

    // Record file tabs and Home (ordered like the tab row) together with their cursors for the next launch.
    // Documents without a file are not recorded: their contents are not on disk to be read again. An HTML page is not
    // recorded either.
    rememberTabs(): void {
        const kept: { tab: { file: string; cursor: number }; at: Doc<E> | Page }[] = [];
        for (const id of this.host.tabOrder()) {
            const doc = this.docs.find(d => d.id === id);
            if (doc?.file) kept.push({ tab: { file: doc.file, cursor: doc.editor.cursorOffset }, at: doc });
            const page = this.pages.find(p => p.id === id);
            if (page?.kind === 'home') kept.push({ tab: { file: HOME_TAB, cursor: 0 }, at: page });
        }
        this.host.settings.tabs = kept.map(k => k.tab);
        const shown = this.shown ?? this.current;
        this.host.settings.activeTab = kept.findIndex(k => k.at === shown);
    }

    // Reopen tabs from the settings. Files that have gone missing are skipped (not recreated).
    // true = some tabs were restored.
    restoreTabs(): boolean {
        const settings = this.host.settings;
        const saved = Array.isArray(settings.tabs) ? settings.tabs : [];
        const opened: [Doc<E>, number][] = [];
        let restored = false;
        let active: Doc<E> | Page | null = null, last: Doc<E> | Page | null = null;
        let missing = 0;
        this.restoring = true;
        for (const [i, tab] of saved.entries()) {
            if (tab?.file === HOME_TAB) {
                this.openHome();
                last = this.pages.find(p => p.kind === 'home')!;
            } else if (typeof tab?.file !== 'string' || !fileExists(tab.file) || platform().fs.isDirectory(tab.file)) {
                missing++;
                continue;
            } else if (this.openInTab(tab.file)) {
                opened.push([this.current, Number(tab.cursor) || 0]);
                last = this.current;
            } else continue;
            restored = true;
            if (i === settings.activeTab) active = last;
        }
        this.restoring = false;
        if (!restored) return false;
        for (const [doc, cursor] of opened) doc.editor.restoreCursor(cursor);
        const target = active ?? last!;
        if ('editor' in target) this.activate(target);
        else this.activatePage(target);
        if (missing) this.host.toast(fmt(ngettext('{missing} file from the last session was not found', '{missing} files from the last session were not found', missing), { missing }));
        return true;
    }
}
