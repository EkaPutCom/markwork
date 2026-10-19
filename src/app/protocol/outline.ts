// The Outline panel over the protocol: the headings of the active document go out as `view.outline` whenever the controller
// sends them, and the heading the user chose comes back as its place in that list (`act.outline.jump`, docs/design/protocol.md).

import type { OutlineHeading, OutlineView } from '../outline.js';
import type { Wire } from './messages.js';

export class ProtocolOutline implements OutlineView {
    onJump: (index: number) => void = () => {};

    constructor(private readonly wire: Wire) {}

    showHeadings(headings: readonly OutlineHeading[]): void {
        this.wire.notify('view.outline', { headings });
    }
}
