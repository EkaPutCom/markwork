// The open documents as the application layer sees them: an id, a file, and a text editor it can read and change,
// never a widget. Every frontend gives its editor this shape (MarkdownView under GTK), and each feature controller in
// app/ gets a narrow host that hands out these records.

// How the editor shows the text: source = raw Markdown, focus = dim all but the current paragraph, typewriter = keep
// the cursor line in the middle.
export type EditorMode = 'source' | 'focus' | 'typewriter';

// What app/ may do with a document's text. The frontend's editor keeps the text (a GtkSourceBuffer under GTK, for
// speed); the controllers only go through these calls.
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
    readonly headings: readonly { text: string; line: number }[];
    jumpToLine(line: number): void;
    setMode(mode: EditorMode, enabled: boolean): void;
    readonly cursorOffset: number;               // code points from the start
    readonly cursorLine: number;                 // the line of the cursor, from 0
    readonly selection: string;                  // the selected text; empty when nothing is selected
    restoreCursor(offset: number): void;         // put the cursor back (a reopened tab) without taking the focus
}

// A button on a toast.
export interface ToastAction { label: string; run: () => void }

// One open document (one tab). The file and Home flag change only through the document controller; the view and
// autosave state of a document is kept by the controllers that own it.
export interface Doc<E extends TextEditor = TextEditor> {
    readonly id: number;
    readonly editor: E;
    readonly file: string | null;          // document path, null = never saved
    readonly home: boolean;                // Home tab: its editor is unused, the tab contents are the Home view
}

// The part of the window every controller needs: the open documents and the work folder.
export interface DocumentHost<E extends TextEditor = TextEditor> {
    root(): string | null;                      // the work folder shown in the Files tab
    active(): Doc<E>;
    docs(): readonly Doc<E>[];
    openInTab(path: string): boolean;
    toast(message: string, action?: ToastAction): void;
}

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// The open document for an absolute path, if any.
export const docFor = <E extends TextEditor>(host: DocumentHost<E>, path: string): Doc<E> | undefined => host.docs().find(d => d.file === path);
