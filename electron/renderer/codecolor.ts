// The colors inside a fenced code block, by its language (```js, ```python, ...). The GTK editor reads them from
// GtkSourceView (editor/codehighlight.ts); here the grammars are CodeMirror's (@codemirror/language-data), loaded the first
// time a block names the language, so the window starts without them. A block of a language that is not known, or not loaded
// yet, keeps the plain code style.

import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { CodeBlock } from '../../src/markdown/highlight.js';
import { diagramKind } from '../../src/markdown/diagram.js';

const loaded = new Map<string, LanguageSupport | null>();   // null = no such language, or it failed to load
const loading = new Set<string>();

const marks = new Map<string, Decoration>();
const mark = (cls: string) => {
    let d = marks.get(cls);
    if (!d) marks.set(cls, d = Decoration.mark({ class: cls }));
    return d;
};

// The language named after a fence: "js", "python", "c++", also with options ("js title=x").
function describe(lang: string): LanguageDescription | null {
    const name = lang.trim().split(/[\s{]/)[0];
    return name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
}

type Span = [from: number, to: number, cls: string];

// The colored spans of a block's text (UTF-16 offsets in `block.text`): [] for a language that is not known, and also while its
// grammar is on its way, when `loadedLanguage` is called once it has arrived so the caller builds again.
export function spansOf(block: CodeBlock, loadedLanguage: () => void): { spans: Span[]; ready: boolean } {
    const description = describe(block.lang);
    if (!description) return { spans: [], ready: true };
    const key = description.name;
    const support = loaded.get(key);
    if (support === undefined) {
        if (!loading.has(key)) {
            loading.add(key);
            description.load().then(s => loaded.set(key, s), () => loaded.set(key, null)).then(() => { loading.delete(key); loadedLanguage(); });
        }
        return { spans: [], ready: false };
    }
    if (!support) return { spans: [], ready: true };
    const spans: Span[] = [];
    highlightTree(support.language.parser.parse(block.text), classHighlighter, (from, to, cls) => { if (to > from) spans.push([from, to, cls]); });
    return { spans, ready: true };
}

// The decorations for the colored text of the blocks shown as source. `offset(block, i)` is the document position of the
// UTF-16 index i in the block's text.
export function codeColors(blocks: readonly CodeBlock[], offset: (block: CodeBlock, index: number) => number, loadedLanguage: () => void) {
    const ranges: ReturnType<Decoration['range']>[] = [];
    for (const block of blocks) {
        if (!block.closed || !block.text || diagramKind(block)) continue;
        for (const [from, to, cls] of spansOf(block, loadedLanguage).spans) ranges.push(mark(cls).range(offset(block, from), offset(block, to)));
    }
    return ranges;
}

// A code block while the cursor is elsewhere (the GTK editor's editor/codelayer.ts): a box with the colored code, which scrolls
// sideways instead of wrapping. A click puts the cursor on the first line of the code, which opens the block for editing.
export class CodeBoxWidget extends WidgetType {
    private readonly key: string;

    constructor(private readonly text: string, private readonly spans: readonly Span[]) {
        super();
        this.key = `${text}\0${spans.map(s => s.join(':')).join(',')}`;
    }

    override eq(other: CodeBoxWidget): boolean { return other.key === this.key; }

    override toDOM(view: EditorView): HTMLElement {
        const box = document.createElement('div');
        box.className = 'cm-md-codebox';
        const pre = document.createElement('pre');
        const text = this.text.replace(/\n$/, '');
        let at = 0;
        for (const [from, to, cls] of this.spans) {
            if (from < at || from >= text.length) continue;
            if (from > at) pre.append(text.slice(at, from));
            const span = document.createElement('span');
            span.className = cls;
            span.textContent = text.slice(from, Math.min(to, text.length));
            pre.append(span);
            at = Math.min(to, text.length);
        }
        pre.append(text.slice(at));
        box.append(pre);
        box.addEventListener('mousedown', event => {
            event.preventDefault();
            const { doc } = view.state;
            const fence = doc.lineAt(view.posAtDOM(box));
            const first = doc.line(Math.min(doc.lines, fence.number + 1));
            view.dispatch({ selection: { anchor: first.from }, scrollIntoView: true });
            view.focus();
        });
        return box;
    }

    override ignoreEvent(): boolean { return true; }
}
