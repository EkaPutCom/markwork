import { platform } from '../platform/index';

// The open documents as the application layer sees them: an id, a file, and a text editor it can read and change,
// never a widget. Every frontend gives its editor this shape, and each feature controller in
// app/ gets a narrow host that hands out these records.

// How the editor shows the text: source = raw Markdown, focus = dim all but the current paragraph, typewriter = keep
// the cursor line in the middle.
export type EditorMode = 'source' | 'focus' | 'typewriter';

// What app/ may do with a document's text. The frontend's editor keeps the text; the controllers only go
// through these calls.
export interface TextEditor {
    getText(): string;
    setText(text: string): void;                 // the whole contents, outside the undo history (opening a file)
    replaceText(text: string): void;             // the smallest edit, as one undo step
    // Change the text from what it is when the change is applied (null = leave it), as one undo step. In one process that
    // is now; over the app protocol it may be after an earlier write has landed (docs/design/protocol.md 5.5), so a
    // read-modify-write that may follow another write in the same turn goes through here, not getText() + replaceText().
    update(edit: (text: string) => string | null): void;
    insertAtCursor(text: string): void;
    isModified(): boolean;                       // changed since it was last opened or saved
    setModified(modified: boolean): void;
    readonly headings: readonly { level: number; text: string; line: number }[];
    jumpToLine(line: number): void;
    setMode(mode: EditorMode, enabled: boolean): void;
    readonly cursorOffset: number;               // code points from the start
    readonly cursorLine: number;                 // the line of the cursor, from 0
    readonly selection: string;                  // the selected text; empty when nothing is selected
    selectRange(line: number, column: number, length: number): void;   // select `length` code points from `column` on a line, and scroll to them
    restoreCursor(offset: number): void;         // put the cursor back (a reopened tab) without taking the focus
}

// A button on a toast, as a controller asks for it: what it does is a function the session keeps.
export interface ToastAction { label: string; run: () => void }

// The same button as the frontend gets it: a token it reports back through AppSession.toastActivated.
export interface ToastButton { label: string; token: number }

// One open document (one tab). The file changes only through the document controller; the view and autosave state of a
// document is kept by the controllers that own it. A tab that is not a document (Home, an HTML page) is a Page.
export interface Doc<E extends TextEditor = TextEditor> {
    readonly id: number;
    readonly editor: E;
    readonly file: string | null;          // document path, null = never saved
}

// A tab whose contents are a view, not a text: Home, the Programs page, or an HTML file shown in its sandbox. It has an id from the same
// numbering as the documents, so the tab row can name either. It has no editor, nothing to save, and is closed without asking.
export type PageKind = 'home' | 'programs' | 'html';

export interface Page {
    readonly id: number;
    readonly kind: PageKind;
    readonly file: string | null;          // html: the file shown; home, programs: null
    readonly root: string | null;          // html: the folder the page may read (the work folder, or its own folder)
}

// The part of the window every controller needs: the open documents and the work folder.
export interface DocumentHost<E extends TextEditor = TextEditor> {
    root(): string | null;                      // the work folder shown in the Files tab
    active(): Doc<E>;
    page(): Page | null;                        // the page (Home, an HTML file) shown instead of the active document
    docs(): readonly Doc<E>[];
    openInTab(path: string): boolean;
    toast(message: string, action?: ToastAction): void;
}

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// The open document for an absolute path, if any.
export const docFor = <E extends TextEditor>(host: DocumentHost<E>, path: string): Doc<E> | undefined => host.docs().find(d => d.file !== null && platform().paths.same(d.file, path));
