// Mermaid and DBML blocks drawn as pictures (the GTK editor's editor/mermaid.ts). Mermaid runs here, in the page: its script
// (copied next to the renderer at build time, scripts/electron-build.mjs) is loaded the first time a diagram is on screen, so a
// window without diagrams does not pay for it. DBML is translated to Mermaid first (markdown/dbml.ts). Like a table, a diagram
// gives way to its source while the cursor is in the block.

import { WidgetType, type EditorView } from '@codemirror/view';
import { DbmlError, dbmlToMermaid } from '../../src/markdown/dbml.js';
import type { Kind } from '../../src/markdown/diagram.js';

interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string): Promise<{ svg: string }>;
}

let script: Promise<MermaidApi> | null = null;
const loadMermaid = (): Promise<MermaidApi> => script ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'mermaid.min.js';
    el.onload = () => resolve((window as unknown as { mermaid: MermaidApi }).mermaid);
    el.onerror = () => { script = null; reject(new Error('The diagram library could not be loaded')); };
    document.head.append(el);
});

const isDark = (): boolean => {
    const set = document.documentElement.dataset.theme;
    return set ? set === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

type Result = { ok: true; svg: string } | { ok: false; error: string };
const cache = new Map<string, Result>();
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

// One diagram at a time: Mermaid keeps its configuration and its scratch elements globally.
function render(kind: Kind, source: string, dark: boolean): Promise<Result> {
    const key = `${dark ? 'dark' : 'light'}\n${kind}\n${source}`;
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit);
    const run = async (): Promise<Result> => {
        try {
            const code = kind === 'dbml' ? dbmlToMermaid(source) : source;
            const mermaid = await loadMermaid();
            mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
            const { svg } = await mermaid.render(`mw-diagram-${++counter}`, code);
            return { ok: true, svg };
        } catch (e) {
            const error = e instanceof DbmlError || e instanceof Error ? e.message : String(e);
            document.querySelectorAll('[id^="dmw-diagram-"], [id^="mw-diagram-"]').forEach(n => { if (n.parentElement === document.body) n.remove(); });
            return { ok: false, error };
        }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result.then(r => { if (cache.size > 100) cache.clear(); cache.set(key, r); return r; });
}

export class DiagramWidget extends WidgetType {
    constructor(private readonly kind: Kind, private readonly source: string, private readonly onOpen: (view: EditorView, element: HTMLElement) => void, private readonly dim = false) { super(); }

    override eq(other: DiagramWidget): boolean { return other.kind === this.kind && other.source === this.source && other.dim === this.dim; }

    override toDOM(view: EditorView): HTMLElement {
        const box = document.createElement('div');
        box.className = 'cm-md-diagram' + (this.dim ? ' cm-md-dim' : '');
        box.textContent = 'Drawing the diagram…';
        void render(this.kind, this.source, isDark()).then(result => {
            if (result.ok) {
                box.innerHTML = result.svg;
            } else {
                box.classList.add('error');
                box.textContent = result.error;
            }
            view.requestMeasure();
        });
        box.addEventListener('mousedown', event => { event.preventDefault(); this.onOpen(view, box); });
        return box;
    }

    override ignoreEvent(): boolean { return true; }
}
