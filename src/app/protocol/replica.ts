// The core's copy of one document's text, kept in step with the frontend's editor (docs/design/protocol.md, section 5).
// It implements TextEditor, so AppSession and every controller work on it as on a widget, with one difference: a write is
// not visible until the frontend has applied it. The replica changes in exactly two ways: a `doc.edit` from the
// frontend, or the `applied` of an ok reply to a `doc.replace`.
//
// Deviation from the draft: `doc.reset` does not start again at version 0 but continues the numbering. An edit the
// frontend sent before it saw the reset then arrives with a version at or below the replica's and is dropped, instead of
// looking like a gap.

import { makeCpMap, makeU16Map } from '../../markdown/offsets.js';
import type { EditorMode, TextEditor } from '../document.js';
import { applyChanges, diffChanges } from './changes.js';
import type { Change, Wire } from './messages.js';

const MAX_RETRIES = 3;    // conflicts in a row before an update gives up (docs/design/protocol.md, 5.4)

// A write waiting for its turn: computes the new text from the text as it is when the write is sent.
interface Write {
    make(text: string): string | null;
    retry: boolean;       // recompute after a conflict; a whole text computed from older text must not be tried again
    attempts: number;
}

export interface Heading { level: number; text: string; line: number }

export function headingsOf(text: string): Heading[] {
    const found: Heading[] = [];
    let fence: string | null = null;
    text.split('\n').forEach((line, index) => {
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) { if (open && open[0] === fence[0] && open.length >= fence.length) fence = null; return; }
        if (open) { fence = open; return; }
        const m = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
        if (m) found.push({ level: m[1].length, text: m[2], line: index });
    });
    return found;
}

export class ProtocolEditor implements TextEditor {
    private current = '';
    private reported = '[]';     // the headings the session was last told of
    private get text(): string { return this.current; }
    private set text(text: string) {
        this.current = text;
        const headings = JSON.stringify(this.headings);
        if (headings !== this.reported) { this.reported = headings; this.onHeadings(); }
    }
    private _version = 0;
    private _modified = false;
    private cursor = 0;
    private selectedText = '';
    private readonly queue: Write[] = [];
    private flying = false;
    private generation = 0;      // changes with every reset, so a reply to a write made before it is ignored
    private cache: { text: string; headings: Heading[] } | null = null;

    // The headings of the text changed (the Outline panel lists them).
    onHeadings: () => void = () => {};

    // The text changed (typing arrived, or a write of the core landed): the session reacts as it does to a GTK buffer's `changed`.
    onEdited: () => void = () => {};
    // A write could not be made: the text changed under it too often, or the frontend refused it.
    onFailed: (message: string) => void = () => {};

    constructor(readonly id: number, private readonly wire: Wire) {}

    get version(): number { return this._version; }

    // ---------- TextEditor ----------

    getText(): string { return this.text; }

    setText(text: string): void {
        this.reset(text, 0);
    }

    replaceText(text: string): void {
        this.enqueue({ make: () => text, retry: false, attempts: 0 });
    }

    update(edit: (text: string) => string | null): void {
        this.enqueue({ make: edit, retry: true, attempts: 0 });
    }

    insertAtCursor(text: string): void {
        this.enqueue({
            make: current => { const at = makeU16Map(current)(this.cursor); return current.slice(0, at) + text + current.slice(at); },
            retry: true,
            attempts: 0,
        });
    }

    isModified(): boolean { return this._modified; }

    setModified(modified: boolean): void {
        this._modified = modified;
        // The frontend marks the text saved only if it has not moved past this version (docs/design/protocol.md, 5.7).
        if (!modified) this.wire.notify('doc.saved', { doc: this.id, version: this._version });
    }

    get headings(): readonly Heading[] {
        if (this.cache?.text !== this.text) this.cache = { text: this.text, headings: headingsOf(this.text) };
        return this.cache.headings;
    }

    jumpToLine(line: number): void { this.wire.notify('doc.reveal', { doc: this.id, line }); }
    setMode(mode: EditorMode, enabled: boolean): void { this.wire.notify('doc.mode', { doc: this.id, mode, on: enabled }); }
    get cursorOffset(): number { return this.cursor; }
    get cursorLine(): number {
        const before = this.text.slice(0, makeU16Map(this.text)(this.cursor));
        return before.split('\n').length - 1;
    }
    get selection(): string { return this.selectedText; }

    selectRange(line: number, column: number, length: number): void {
        this.wire.notify('doc.select', { doc: this.id, line, column, length });
    }

    restoreCursor(offset: number): void {
        this.cursor = offset;
        this.wire.notify('doc.cursorTo', { doc: this.id, offset });
    }

    // ---------- What the frontend reports ----------

    // The frontend's editor changed. A version at or below ours is an edit sent before it saw a reset; one that skips
    // ahead means a message was lost, and the whole text is asked for.
    receiveEdit(version: number, modified: boolean, changes: readonly Change[]): void {
        if (version <= this._version) return;
        if (version !== this._version + 1) { void this.resync(); return; }
        this.text = applyChanges(this.text, changes);
        this._version = version;
        this._modified = modified;
        this.cursor = Math.min(this.cursor, makeCpMap(this.text)(this.text.length));
        this.onEdited();
    }

    receiveCursor(version: number, offset: number, selection: readonly [number, number] | null): void {
        if (version !== this._version) return;   // a cursor for text we do not have yet is about to be replaced by the next edit
        this.cursor = offset;
        const u16 = makeU16Map(this.text);
        this.selectedText = selection ? this.text.slice(u16(selection[0]), u16(selection[1])) : '';
    }

    // The frontend's text wins (docs/design/protocol.md, 5.6).
    async resync(): Promise<void> {
        const reply = await this.wire.request('doc.resync', { doc: this.id });
        if (!reply.ok) return;
        this.generation++;
        this.queue.length = 0;
        this.flying = false;
        this.text = String(reply.text);
        this._version = Number(reply.version);
        this._modified = Boolean(reply.modified);
        this.cursor = Number(reply.cursor ?? 0);
        this.onEdited();
    }

    // ---------- Writes of the core ----------

    // Replace the whole text outside the undo history (opening or reloading a file).
    private reset(text: string, cursor: number): void {
        this.generation++;
        this.queue.length = 0;
        this.flying = false;
        this.text = text;
        this._version++;
        this._modified = false;
        this.cursor = cursor;
        this.selectedText = '';
        this.wire.notify('doc.reset', { doc: this.id, text, version: this._version, cursor, modified: false });
        this.onEdited();
    }

    private enqueue(write: Write): void {
        this.queue.push(write);
        this.pump();
    }

    // At most one doc.replace is in flight per document; the next is computed against the replica as it is then.
    private pump(): void {
        if (this.flying) return;
        const write = this.queue.shift();
        if (!write) return;
        const next = write.make(this.text);
        const changes = next === null ? [] : diffChanges(this.text, next);
        if (changes.length === 0) { this.pump(); return; }
        this.flying = true;
        const generation = this.generation;
        void this.wire.request('doc.replace', { doc: this.id, base: this._version, undo: 'step', changes, cursor: null }).then(reply => {
            if (generation !== this.generation) return;   // the text was replaced while this was on its way
            this.flying = false;
            if (reply.ok) {
                this.text = applyChanges(this.text, reply.applied as Change[]);
                this._version = Number(reply.version);
                this._modified = true;
                this.onEdited();
            } else if (reply.error.code === 'conflict') {
                if (write.retry && ++write.attempts < MAX_RETRIES) this.queue.unshift(write);
                else this.onFailed(write.retry ? 'The text kept changing under this edit' : 'The text changed while this edit was on its way');
            } else {
                this.onFailed(reply.error.message);
                void this.resync();
            }
            this.pump();
        });
    }
}
