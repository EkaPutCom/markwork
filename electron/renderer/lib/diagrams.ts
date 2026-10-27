// Mermaid and DBML blocks drawn as pictures. Mermaid runs here, in the page: its script
// (copied next to the renderer at build time, scripts/electron-build.mjs) is loaded the first time a diagram is on screen, so a
// window without diagrams does not pay for it. DBML is drawn by dbmldiagram.ts, without Mermaid. Like a table, a diagram
// gives way to its source while the cursor is in the block.

import { WidgetType, type EditorView } from '@codemirror/view';
import { DbmlError } from '../../../src/markdown/dbml';
import { dbmlToSvg } from './dbmldiagram';
import { DELETE_ICON, SOURCE_ICON, ZOOM_ICON, blockTools, copyTool } from './blocktools';
import { fencedBlockAt, pick, removeBlock } from './blockselect';
import type { ZoomedImage } from './images';
import type { Kind } from '../../../src/markdown/diagram';

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

// Mermaid wants plain colors, not the oklch() or color-mix() of the tokens, so each token is read back through a canvas as #rrggbb.
const swatch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
const token = (name: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    swatch.clearRect(0, 0, 1, 1);
    swatch.fillStyle = '#000';   // ui-allow: the canvas's reset, so a value it cannot read does not keep the last color
    swatch.fillStyle = value;
    swatch.fillRect(0, 0, 1, 1);
    const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
};

// The shadcn look: flat cards on the page background, thin borders, muted lines, the interface's own font.
function themeVariables(): Record<string, string> {
    const background = token('--background'), card = token('--card'), muted = token('--muted');
    const foreground = token('--foreground'), dim = token('--muted-foreground'), border = token('--border');
    return {
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif', fontSize: '13px',
        background, mainBkg: card, primaryColor: card, primaryTextColor: foreground, primaryBorderColor: border,
        secondaryColor: muted, secondaryTextColor: foreground, secondaryBorderColor: border,
        tertiaryColor: background, tertiaryTextColor: foreground, tertiaryBorderColor: border,
        nodeBorder: border, nodeTextColor: foreground, textColor: foreground, titleColor: foreground,
        lineColor: dim, arrowheadColor: dim, edgeLabelBackground: background,
        clusterBkg: muted, clusterBorder: border, noteBkg: muted, noteTextColor: foreground, noteBorderColor: border,
        rowOdd: card, rowEven: muted, attributeBackgroundColorOdd: card, attributeBackgroundColorEven: muted,
        actorBkg: card, actorBorder: border, actorTextColor: foreground, actorLineColor: dim, signalColor: dim, signalTextColor: foreground,
        labelBoxBkgColor: muted, labelBoxBorderColor: border, labelTextColor: foreground, loopTextColor: foreground,
    };
}

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
            if (kind === 'dbml') return { ok: true, svg: dbmlToSvg(source) };
            const mermaid = await loadMermaid();
            mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: themeVariables(), look: 'classic', securityLevel: 'strict' });
            const { svg } = await mermaid.render(`mw-diagram-${++counter}`, source);
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

// The drawn diagram as a picture of its own size, for the viewer: the page gave Mermaid's SVG a fluid width.
function zoomed(box: HTMLElement, title: string): ZoomedImage | null {
    const svg = box.querySelector('svg');
    if (!svg) return null;
    const { width, height } = svg.viewBox.baseVal.width ? svg.viewBox.baseVal : svg.getBoundingClientRect();
    const copy = svg.cloneNode(true) as SVGElement;
    copy.removeAttribute('style');
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    return { src: '', title, svg: copy.outerHTML, width, height };
}

export class DiagramWidget extends WidgetType {
    constructor(private readonly kind: Kind, private readonly source: string, private readonly onOpen: (view: EditorView, element: HTMLElement) => void, private readonly onZoom: (image: ZoomedImage) => void, private readonly dim = false) { super(); }

    override eq(other: DiagramWidget): boolean { return other.kind === this.kind && other.source === this.source && other.dim === this.dim; }

    override toDOM(view: EditorView): HTMLElement {
        const box = document.createElement('div');
        box.className = 'cm-md-diagram' + (this.dim ? ' cm-md-dim' : '');
        box.textContent = 'Drawing the diagram…';
        const title = this.kind === 'dbml' ? 'DBML diagram' : 'Mermaid diagram';
        const zoom = () => { const image = zoomed(box, title); if (image) this.onZoom(image); };
        void render(this.kind, this.source, isDark()).then(result => {
            if (result.ok) {
                box.innerHTML = result.svg;
                box.append(blockTools([
                    { label: 'Zoom', icon: ZOOM_ICON, run: zoom },
                    { label: 'Edit source', icon: SOURCE_ICON, run: () => this.onOpen(view, box) },
                    copyTool(() => this.source),
                    { label: 'Delete', icon: DELETE_ICON, run: () => { const b = fencedBlockAt(view, box, 'diagram'); if (b) removeBlock(view, b); } },
                ]));
            } else {
                box.classList.add('error');
                box.textContent = result.error;
            }
            view.requestMeasure();
        });
        // A click picks the diagram as one object (blockselect.ts); a double click zooms. Its source opens from the toolbar.
        box.addEventListener('mousedown', event => {
            event.preventDefault();
            const block = fencedBlockAt(view, box, 'diagram');
            if (event.detail < 2) { if (block) pick(view, block); return; }
            const image = zoomed(box, title);
            if (image) this.onZoom(image); else this.onOpen(view, box);
        });
        return box;
    }

    override ignoreEvent(): boolean { return true; }
}
