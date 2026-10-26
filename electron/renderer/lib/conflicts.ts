// Git conflict markers as a choice: each side of a conflict gets a background, and a
// row of buttons above it keeps the current lines, the incoming lines, or both. Where the conflicts are and what a choice turns
// one into is markdown/conflicts.ts; here is the drawing and the one transaction that applies a choice.

import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { findConflicts, resolution, roles, type Choice, type Conflict } from '../../../src/markdown/conflicts.js';
import { domButton } from '../ui/dom.js';

const CHOICES: { choice: Choice; label: string; tip: (c: Conflict) => string }[] = [
    { choice: 'current', label: 'Accept Current', tip: c => `Keep the lines from ${c.current || 'the current side'} and drop the other side` },
    { choice: 'incoming', label: 'Accept Incoming', tip: c => `Keep the lines from ${c.incoming || 'the incoming side'} and drop the other side` },
    { choice: 'both', label: 'Accept Both', tip: () => 'Keep both sides, the current lines first' },
];

// Replace the whole conflict, markers included, by a choice: one undo step, the cursor at its start.
export function choose(view: EditorView, conflict: Conflict, choice: Choice): void {
    const { doc } = view.state;
    const lines = doc.toString().split('\n');
    const replacement = resolution(lines, conflict, choice);
    const from = doc.line(conflict.start + 1).from;
    const atEnd = conflict.end + 1 >= doc.lines;
    const to = atEnd ? doc.length : doc.line(conflict.end + 2).from;
    const insert = replacement.join('\n') + (!atEnd && replacement.length ? '\n' : '');
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from }, scrollIntoView: true, userEvent: 'input' });
    view.focus();
}

class ConflictBar extends WidgetType {
    constructor(private readonly conflict: Conflict) { super(); }

    override eq(other: ConflictBar): boolean {
        const a = this.conflict, b = other.conflict;
        return a.start === b.start && a.mid === b.mid && a.end === b.end && a.current === b.current && a.incoming === b.incoming;
    }

    override toDOM(view: EditorView): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'cm-md-conflict-bar';
        for (const { choice, label, tip } of CHOICES) {
            // A text button has no title (ui.md "Tooltip and title"); what it keeps is said to a screen reader.
            const button = domButton({ label, size: 'xs', onClick: () => {
                // The position may have moved since the widget was made: find this conflict again by its place.
                const now = findConflicts(view.state.doc.toString().split('\n'));
                const at = view.state.doc.lineAt(view.posAtDOM(bar)).number;
                const found = now.find(c => c.start + 1 >= at - 1 && c.start + 1 <= at + 1) ?? now.find(c => c.start === this.conflict.start);
                if (found) choose(view, found, choice);
            } });
            button.setAttribute('aria-description', tip(this.conflict));
            bar.append(button);
        }
        return bar;
    }

    override ignoreEvent(): boolean { return true; }
}

const roleLines = new Map<string, Decoration>();
const roleLine = (role: string) => {
    let d = roleLines.get(role);
    if (!d) roleLines.set(role, d = Decoration.line({ class: `cm-md-conflict cm-md-conflict-${role}` }));
    return d;
};

// The decorations for the conflicts of a text, and the lines (from 0) they cover, which keep no Markdown styling: the markers
// `=======` and `>>>>>>>` are not a heading underline and a quote here.
export function conflictDecorations(doc: Text): { ranges: ReturnType<Decoration['range']>[]; covered: Set<number> } {
    const ranges: ReturnType<Decoration['range']>[] = [], covered = new Set<number>();
    const text = doc.toString();
    if (!text.includes('<<<<<<<')) return { ranges, covered };
    const conflicts = findConflicts(text.split('\n'));
    for (const [line, role] of roles(conflicts)) {
        ranges.push(roleLine(role).range(doc.line(line + 1).from));
        covered.add(line);
    }
    for (const c of conflicts) ranges.push(Decoration.widget({ widget: new ConflictBar(c), block: true, side: -1 }).range(doc.line(c.start + 1).from));
    return { ranges, covered };
}
