// Autosave: a document with a file is written to disk after a pause without keystrokes, or right away at safe
// points (leaving a tab, closing). Failures are toasts, not dialogs, because autosave keeps trying.

import { writeTextFile, writeTextFileAsync } from '../base/files.js';
import { platform } from '../platform/index.js';
import type { AppSettings } from '../base/settings.js';
import { _, fmt } from '../base/i18n.js';
import { errorMessage, type Doc, type ToastAction } from './document.js';

// Pause without keystrokes before autosave writes to disk.
const AUTOSAVE_DELAY_MS = 1000;

export interface AutosaveHost {
    readonly settings: AppSettings;
    docs(): readonly Doc[];
    toast(message: string, action?: ToastAction): void;
}

// Autosave state of one document, kept here rather than on the document record.
interface Pending {
    timer: ReturnType<typeof setTimeout> | null;   // the pending autosave
    lastChange: number;   // time (ms, monotonic) of the last text change
    changes: number;      // number of text changes; marks the contents written by a background autosave
}

export class Autosaver {
    private readonly pending = new WeakMap<Doc, Pending>();

    constructor(private readonly host: AutosaveHost) {}

    private state(doc: Doc): Pending {
        let state = this.pending.get(doc);
        if (!state) this.pending.set(doc, state = { timer: null, lastChange: 0, changes: 0 });
        return state;
    }

    // The text of doc changed (every keystroke): count it and queue an autosave.
    edited(doc: Doc): void {
        this.state(doc).changes++;
        this.queue(doc);
    }

    // Kept cheap because it runs on every keystroke: it only records the time. The timer is not
    // recreated per keystroke; when it fires, it postpones itself again if there are newer keystrokes.
    queue(doc: Doc): void {
        if (!this.host.settings.autosave || !doc.file) return;
        const state = this.state(doc);
        state.lastChange = platform().monotonicMs();
        if (state.timer) return;
        state.timer = setTimeout(() => this.tick(doc), AUTOSAVE_DELAY_MS);
    }

    private tick(doc: Doc): void {
        const state = this.state(doc);
        const waited = platform().monotonicMs() - state.lastChange;
        if (waited < AUTOSAVE_DELAY_MS) {
            state.timer = setTimeout(() => this.tick(doc), Math.ceil(AUTOSAVE_DELAY_MS - waited));
            return;
        }
        state.timer = null;
        this.inBackground(doc);
    }

    // Autosave from the timer: the file is written in a worker thread (see writeTextFileAsync), so
    // the main thread only copies the text. A later synchronous write to the same file
    // waits for this one to finish. true = the write started.
    inBackground(doc: Doc, done: () => void = () => {}): boolean {
        this.cancel(doc);
        const path = doc.file;
        if (!doc.editor.isModified() || !this.host.settings.autosave || !path) return false;
        const state = this.state(doc), changes = state.changes;
        writeTextFileAsync(path, doc.editor.getText(), error => {
            if (error) {
                this.host.toast(fmt(_('Autosave failed: {error}'), { error: errorMessage(error) }));
            } else if (this.host.docs().includes(doc) && doc.file === path && state.changes === changes) {
                // The text did not change while being written: the contents on disk equal the buffer.
                doc.editor.setModified(false);
            }
            done();
        });
        return true;
    }

    // Save quietly without a dialog or toast. true = no changes left behind.
    now(doc: Doc): boolean {
        this.cancel(doc);
        if (!doc.editor.isModified()) return true;
        if (!this.host.settings.autosave || !doc.file) return false;
        try {
            writeTextFile(doc.file, doc.editor.getText());
        } catch (e) {
            // Not a dialog: autosave keeps trying, and repeated dialogs get in the way of typing.
            this.host.toast(fmt(_('Autosave failed: {error}'), { error: errorMessage(e) }));
            return false;
        }
        doc.editor.setModified(false);
        return true;
    }

    cancel(doc: Doc): void {
        const state = this.pending.get(doc);
        if (!state?.timer) return;
        clearTimeout(state.timer);
        state.timer = null;
    }
}
