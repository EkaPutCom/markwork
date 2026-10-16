// The file chooser as the application layer asks for it; each frontend shows its own (Gtk.FileDialog under GTK).

// Which files a chooser offers.
export type FileKind = 'markdown' | 'image' | 'html' | 'all';

export interface ChooseFileOptions {
    title: string;
    save?: boolean;
    selectFolder?: boolean;     // choose a folder, not a file
    filters?: FileKind[];
    name?: string | null;       // suggested file name (save dialog)
    folder?: string | null;     // initial folder
}
