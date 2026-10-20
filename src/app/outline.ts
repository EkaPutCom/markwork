// The Outline tab in the application layer: the headings of the active document, sent to the panel as plain data, and a
// jump to the heading the user chose. A frontend tells the controller when a document became active and when its
// headings changed (over the app protocol the core computes them from its replica,
// docs/design/protocol.md 5.1). The panel draws what it is sent and reports the place of the heading in that list, so a
// jump lands on the line the list had, whatever the document did since.

import type { Doc, DocumentHost, TextEditor } from './document.js';

// One heading as the panel shows it.
export interface OutlineHeading {
    level: number;     // 1 to 6
    text: string;
    line: number;      // from 0
}

export interface OutlineView {
    onJump: (index: number) => void;                    // a heading of the list was chosen
    showHeadings(headings: readonly OutlineHeading[]): void;
}

export interface OutlineHost<E extends TextEditor = TextEditor> extends DocumentHost<E> {
    readonly outlineView: OutlineView;
}

export class OutlineController<E extends TextEditor = TextEditor> {
    private shown: readonly OutlineHeading[] = [];

    constructor(private readonly host: OutlineHost<E>) {
        host.outlineView.onJump = index => this.jump(index);
    }

    // The active document changed: show its headings.
    show(doc: Doc<E>): void {
        this.send(doc.editor.headings);
    }

    // A page is shown: there are no headings.
    clear(): void {
        this.send([]);
    }

    // A document's headings changed; only the active document's are shown.
    changed(doc: Doc<E>): void {
        if (doc === this.host.active()) this.show(doc);
    }

    private send(headings: readonly OutlineHeading[]): void {
        this.shown = headings;
        this.host.outlineView.showHeadings(headings);
    }

    private jump(index: number): void {
        const heading = this.shown[index];
        if (heading) this.host.active().editor.jumpToLine(heading.line);
    }
}
