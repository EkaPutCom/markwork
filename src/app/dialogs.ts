// The file chooser as the application layer asks for it; each frontend shows its own (Gtk.FileDialog under GTK).

// A yes-or-no question as a controller asks it. Its sentences are written (and translated) in the core, so every frontend
// asks the same question; the frontend only draws it.
export interface Question {
    message: string;
    detail: string;
    accept: string;              // the label of the button that says yes (a verb)
    destructive?: boolean;       // the yes button destroys something (drawn as such)
}

// One line of text a controller asks for.
export interface Prompt {
    title: string;
    label: string;
    value?: string;              // what the entry starts with
    accept?: string;             // the label of the confirm button; the frontend's own default without one
}

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
