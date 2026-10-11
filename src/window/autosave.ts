// Autosave: a document with a file is written to disk after a pause without keystrokes, or right away at safe
// points (leaving a tab, closing). Failures are toasts, not dialogs, because autosave keeps trying.

import GLib from 'gi://GLib';
import { writeTextFile, writeTextFileAsync } from '../files.js';
import type { AppSettings } from '../settings.js';
import { _, fmt } from '../i18n.js';
import { errorMessage, type Doc, type ToastAction } from './doc.js';

// Pause without keystrokes before autosave writes to disk.
const AUTOSAVE_DELAY_MS = 1000;

export interface AutosaveHost {
    readonly settings: AppSettings;
    docs(): readonly Doc[];
    toast(message: string, action?: ToastAction): void;
}

// Autosave state of one document, kept here rather than on the document record.
interface Pending {
    timer: number;        // autosave timeout id, 0 = none
    lastChange: number;   // time (µs, monotonic) of the last text change
    changes: number;      // number of text changes; marks the contents written by a background autosave
}

export class Autosaver {
    private readonly pending = new WeakMap<Doc, Pending>();

    constructor(private readonly host: AutosaveHost) {}

    private state(doc: Doc): Pending {
        let state = this.pending.get(doc);
        if (!state) this.pending.set(doc, state = { timer: 0, lastChange: 0, changes: 0 });
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
        state.lastChange = GLib.get_monotonic_time();
        if (state.timer) return;
        state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTOSAVE_DELAY_MS, () => this.tick(doc));
    }

    private tick(doc: Doc): boolean {
        const state = this.state(doc);
        const waited = (GLib.get_monotonic_time() - state.lastChange) / 1000;
        if (waited < AUTOSAVE_DELAY_MS) {
            state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(AUTOSAVE_DELAY_MS - waited), () => this.tick(doc));
            return GLib.SOURCE_REMOVE;
        }
        state.timer = 0;
        this.inBackground(doc);
        return GLib.SOURCE_REMOVE;
    }

    // Autosave from the timer: the file is written in a worker thread (see writeTextFileAsync), so
    // the main thread only copies the text. A later synchronous write to the same file
    // waits for this one to finish. true = the write started.
    inBackground(doc: Doc, done: () => void = () => {}): boolean {
        this.cancel(doc);
        const path = doc.file;
        if (!doc.editor.buffer.get_modified() || !this.host.settings.autosave || !path) return false;
        const state = this.state(doc), changes = state.changes;
        writeTextFileAsync(path, doc.editor.getText(), error => {
            if (error) {
                this.host.toast(fmt(_('Autosave failed: {error}'), { error: errorMessage(error) }));
            } else if (this.host.docs().includes(doc) && doc.file === path && state.changes === changes) {
                // The text did not change while being written: the contents on disk equal the buffer.
                doc.editor.buffer.set_modified(false);
            }
            done();
        });
        return true;
    }

    // Save quietly without a dialog or toast. true = no changes left behind.
    now(doc: Doc): boolean {
        this.cancel(doc);
        if (!doc.editor.buffer.get_modified()) return true;
        if (!this.host.settings.autosave || !doc.file) return false;
        try {
            writeTextFile(doc.file, doc.editor.getText());
        } catch (e) {
            // Not a dialog: autosave keeps trying, and repeated dialogs get in the way of typing.
            this.host.toast(fmt(_('Autosave failed: {error}'), { error: errorMessage(e) }));
            return false;
        }
        doc.editor.buffer.set_modified(false);
        return true;
    }

    cancel(doc: Doc): void {
        const state = this.pending.get(doc);
        if (!state?.timer) return;
        GLib.source_remove(state.timer);
        state.timer = 0;
    }
}
