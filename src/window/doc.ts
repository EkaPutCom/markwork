// What the main window shares with its feature controllers (window/*.ts): the open document record and the
// narrow host each controller is given. A controller never sees MainWindow itself; the window builds its host
// from closures, so the dependency stays one way (window.ts → window/*).

import type Adw from 'gi://Adw?version=1';
import type { MarkdownView } from '../editor/view.js';

// One open document (one tab). The file and Home flag change only through DocumentController (window/documents.ts);
// the view and autosave state of a document is kept by ViewController and Autosaver themselves.
// A button on a toast.
export interface ToastAction { label: string; run: () => void }

export interface Doc {
    readonly id: number;
    readonly editor: MarkdownView;
    readonly file: string | null;          // document path, null = never saved
    readonly home: boolean;                // Home tab: its editor is unused, the tab contents are a HomeView
}

// The part of the window every controller needs: the open documents and the work folder.
export interface DocumentHost {
    readonly win: Adw.ApplicationWindow;
    root(): string | null;                      // the work folder shown in the Files tab
    active(): Doc;
    docs(): readonly Doc[];
    openInTab(path: string): boolean;
    toast(message: string, action?: ToastAction): void;
}

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// The open document for an absolute path, if any.
export const docFor = (host: DocumentHost, path: string): Doc | undefined => host.docs().find(d => d.file === path);
