// The frontend's side of one document: the live text, its version, and the rules of docs/design/protocol.md section 5
// that do not depend on a widget. A frontend keeps one per open document and calls these from its editor's events; the
// tests use the same class as a scripted frontend. Texts are JavaScript strings; the changes that cross the line are in
// code points (changes.ts).

import { cpLength } from '../../markdown/offsets.js';
import { applyChanges, diffChanges } from './changes.js';
import type { Change } from './messages.js';

// The edits sent that the core may still refer to as the `base` of a doc.replace; older ones are forgotten.
const KEPT_EDITS = 256;

export interface EditMessage { doc: number; version: number; modified: boolean; changes: Change[] }

export class DocMirror {
    private saved: string;
    private sent: EditMessage[] = [];

    constructor(readonly id: number, public text: string, public version: number) {
        this.saved = text;
    }

    get modified(): boolean { return this.text !== this.saved; }

    // The user typed: the text is now `after`. Null when nothing changed. The message is sent at once, before any request.
    typed(after: string): EditMessage | null {
        const changes = diffChanges(this.text, after);
        if (changes.length === 0) return null;
        this.text = after;
        this.version++;
        const message = { doc: this.id, version: this.version, modified: this.modified, changes };
        this.sent.push(message);
        if (this.sent.length > KEPT_EDITS) this.sent.shift();
        return message;
    }

    // doc.reset: the core replaced the whole text.
    reset(text: string, version: number): void {
        this.text = text;
        this.saved = text;
        this.version = version;
        this.sent = [];
    }

    // doc.replace: apply the core's change. If the text is still the one it was computed against, as it is; if the user has
    // typed since (the edits after `base` are known), the change moves over those edits, unless it touches what they
    // touched (overlapping or adjacent), and then it is refused with the current version (docs/design/protocol.md, 5.4).
    replace(base: number, changes: readonly Change[]): { ok: true; version: number; applied: Change[] } | { ok: false; version: number } {
        const moved = this.version === base ? [...changes] : this.rebase(base, changes);
        if (!moved) return { ok: false, version: this.version };
        this.text = applyChanges(this.text, moved);
        this.version++;
        return { ok: true, version: this.version, applied: moved };
    }

    // One change moved over the edits made after `base`; null when it touches one, or when those edits are not all known.
    // The core's writes are a single change (a diff of its text and ours), so a batch of several is not rebased.
    private rebase(base: number, changes: readonly Change[]): Change[] | null {
        const edits = this.sent.filter(e => e.version > base);
        if (changes.length !== 1 || edits.length !== this.version - base || edits[0]?.version !== base + 1) return null;
        let { from, to } = changes[0];
        for (const { changes: made } of edits) {
            for (const edit of made) {
                if (to >= edit.from && from <= edit.to) return null;
                if (edit.to < from) {
                    const delta = cpLength(edit.insert) - (edit.to - edit.from);
                    from += delta;
                    to += delta;
                }
            }
        }
        return [{ from, to, insert: changes[0].insert }];
    }

    // doc.saved: the core wrote `version` to disk. If the user typed since, the text stays modified.
    savedAt(version: number): void {
        if (version === this.version) this.saved = this.text;
    }

    // doc.resync: the whole state, which wins.
    snapshot(cursor: number): { version: number; text: string; modified: boolean; cursor: number } {
        return { version: this.version, text: this.text, modified: this.modified, cursor };
    }
}
