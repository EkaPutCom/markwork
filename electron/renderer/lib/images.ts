// Pictures in the text: ![alt](url) is shown under its line as a block widget, so the text stays what the user wrote
//. Where a picture comes from is decided by markdown/imagesource.ts; the page
// loads a file through the app:// scheme the main process serves (main.ts).

import { WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { ImageRef } from '../../../src/markdown/highlight.js';
import { imageSource, type PathOps } from '../../../src/markdown/imagesource.js';
import { DELETE_ICON, SOURCE_ICON, ZOOM_ICON, blockTools } from './blocktools.js';
import { isAbsolutePath, slashed } from '../../../src/markdown/paths.js';

const MAX_HEIGHT = 480, MAX_WIDTH = 700;
const TOOLS_MIN_WIDTH = 120, TOOLS_MIN_HEIGHT = 60;

// A picture shown large: a file (src), or a drawn diagram (svg, with its size in pixels) which the viewer puts in the page so that
// the theme's colors reach it.
export interface ZoomedImage { src: string; title: string; svg?: string; width?: number; height?: number }

const PATHS: PathOps = {
    isAbsolute: isAbsolutePath,
    join: (...parts) => parts.join('/').replace(/\/{2,}/g, '/'),
};

// The URL the page loads a file by: app://file/<path>, one encoded segment at a time.
// A Windows path (C:\a\b.png) goes with / for a separator, as app://file/C%3A/a/b.png.
export const appUrl = (path: string): string => {
    const url = slashed(path);
    return 'app://file' + (url.startsWith('/') ? '' : '/') + url.split('/').map(encodeURIComponent).join('/');
};

// A picture's address as written → the URL to load, or null for a relative path in a document that is not saved.
export function imageUrl(url: string, baseDir: string | null): string | null {
    const source = imageSource(url, baseDir ?? '', PATHS);
    if (source.kind === 'url') return source.url;
    return baseDir === null && !PATHS.isAbsolute(url) ? null : appUrl(source.path);
}

// url: the address as written; nth: how many pictures before it on its line have the same address (it tells two copies apart);
// src: where the page loads it from, null when it cannot be told (a relative address in a text with no file yet)
export interface PictureItem { src: string | null; alt: string; url: string; nth: number }

// Where a picture's ![alt](url) is in its line's text: [start, end), or null.
export function pictureRange(text: string, item: Pick<PictureItem, 'url' | 'nth'>): [number, number] | null {
    const m = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]*)[^)]*\)/g)].filter(m => m[1] === item.url)[item.nth];
    return m ? [m.index, m.index + m[0].length] : null;
}

// A picture whose address cannot be told is a picture all the same: its markup is hidden like any other's, so it is drawn
// as missing, and the keys pick it and remove it whole rather than a hidden letter of it.
export function pictures(refs: readonly ImageRef[], baseDir: string | null): Map<number, PictureItem[]> {
    const byLine = new Map<number, PictureItem[]>();
    for (const ref of refs) {
        const src = imageUrl(ref.url, baseDir);
        const list = byLine.get(ref.line) ?? [];
        list.push({ src, alt: ref.alt, url: ref.url, nth: list.filter(it => it.url === ref.url).length });
        byLine.set(ref.line, list);
    }
    return byLine;
}

export interface PictureEvents {
    activate(view: EditorView, element: HTMLElement, item: PictureItem): void;   // one click: the picture is picked (blockselect.ts)
    zoom(image: ZoomedImage): void;                               // double click
    edit(view: EditorView, element: HTMLElement, item: PictureItem): void;     // the Edit tool: the box that changes its alt text and address
    remove(view: EditorView, element: HTMLElement, item: PictureItem): void;   // the Delete tool: the picture's markup leaves the text
}

// The pictures of one line.
export class PicturesWidget extends WidgetType {
    constructor(readonly items: readonly PictureItem[], private readonly events: PictureEvents, private readonly dim = false) { super(); }

    override eq(other: PicturesWidget): boolean {
        return other.dim === this.dim && other.items.length === this.items.length && other.items.every((it, i) => it.src === this.items[i].src && it.url === this.items[i].url && it.nth === this.items[i].nth && it.alt === this.items[i].alt);
    }

    override toDOM(view: EditorView): HTMLElement {
        const box = document.createElement('div');
        box.className = 'cm-md-pictures' + (this.dim ? ' cm-md-dim' : '');
        for (const item of this.items) {
            const frame = document.createElement('div');
            frame.className = 'cm-md-picture';
            frame.dataset.url = item.url;   // which markup it is (blockselect.ts finds a picked picture by it)
            frame.dataset.nth = String(item.nth);
            const src = item.src;
            const zoom = () => { if (src) this.events.zoom({ src, title: item.alt || decodeURIComponent(src.split('/').pop() ?? '') }); };
            const missing = () => {
                const span = document.createElement('span');
                span.className = 'cm-md-picture-missing';
                span.textContent = item.alt || 'Image not found';
                return span;
            };
            if (!src) {
                // Drawn as a picture that did not load (no toolbar, which would cover its text), and picked by a click like
                // one that did, so the keys take it whole.
                const span = missing();
                span.addEventListener('click', () => this.events.activate(view, frame, item));
                frame.append(span);
                box.append(frame);
                continue;
            }
            const img = document.createElement('img');
            img.src = src;
            img.alt = item.alt;
            img.draggable = false;
            img.style.maxHeight = `${MAX_HEIGHT}px`;
            img.style.maxWidth = `min(100%, ${MAX_WIDTH}px)`;
            // A picture too small to carry the toolbar keeps the double click only.
            img.addEventListener('load', () => frame.classList.toggle('small', img.width < TOOLS_MIN_WIDTH || img.height < TOOLS_MIN_HEIGHT));
            img.addEventListener('error', () => frame.replaceChildren(missing()));
            img.addEventListener('click', event => { if (event.detail === 1) this.events.activate(view, frame, item); });
            img.addEventListener('dblclick', zoom);
            frame.append(img, blockTools([
                { label: 'Zoom', icon: ZOOM_ICON, run: zoom },
                { label: 'Edit source', icon: SOURCE_ICON, run: () => this.events.edit(view, box, item) },
                { label: 'Delete', icon: DELETE_ICON, run: () => this.events.remove(view, box, item) },
            ]));
            box.append(frame);
        }
        return box;
    }

    override ignoreEvent(): boolean { return true; }
}
