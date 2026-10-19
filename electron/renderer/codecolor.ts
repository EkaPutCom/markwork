// The colors inside a fenced code block, by its language (```js, ```python, ...). The GTK editor reads them from
// GtkSourceView (editor/codehighlight.ts); here the grammars are CodeMirror's (@codemirror/language-data), loaded the first
// time a block names the language, so the window starts without them. A block of a language that is not known, or not loaded
// yet, keeps the plain code style.

import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { Decoration } from '@codemirror/view';
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

// The decorations for the colored text of the blocks; `loadedLanguage` is called once a grammar that was asked for arrives,
// so the caller builds again. `offset(block, i)` is the document position of the UTF-16 index i in the block's text.
export function codeColors(blocks: readonly CodeBlock[], offset: (block: CodeBlock, index: number) => number, loadedLanguage: () => void) {
    const ranges: ReturnType<Decoration['range']>[] = [];
    for (const block of blocks) {
        if (!block.closed || !block.text || diagramKind(block)) continue;
        const description = describe(block.lang);
        if (!description) continue;
        const key = description.name;
        const support = loaded.get(key);
        if (support === undefined) {
            if (!loading.has(key)) {
                loading.add(key);
                description.load().then(s => loaded.set(key, s), () => loaded.set(key, null)).then(() => { loading.delete(key); loadedLanguage(); });
            }
            continue;
        }
        if (!support) continue;
        const tree = support.language.parser.parse(block.text);
        highlightTree(tree, classHighlighter, (from, to, cls) => {
            if (to > from) ranges.push(mark(cls).range(offset(block, from), offset(block, to)));
        });
    }
    return ranges;
}
