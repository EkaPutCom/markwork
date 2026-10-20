// Pictures in the text: ![alt](url) is shown under its line as a block widget, so the text stays what the user wrote
//. Where a picture comes from is decided by markdown/imagesource.ts; the page
// loads a file through the app:// scheme the main process serves (main.ts).

import { WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { ImageRef } from '../../src/markdown/highlight.js';
import { imageSource, type PathOps } from '../../src/markdown/imagesource.js';
import { isAbsolutePath, slashed } from '../../src/markdown/paths.js';

const MAX_HEIGHT = 480, MAX_WIDTH = 700;

export interface ZoomedImage { src: string; title: string }

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

export interface PictureItem { src: string; alt: string }

export function pictures(refs: readonly ImageRef[], baseDir: string | null): Map<number, PictureItem[]> {
    const byLine = new Map<number, PictureItem[]>();
    for (const ref of refs) {
        const src = imageUrl(ref.url, baseDir);
        if (!src) continue;
        const list = byLine.get(ref.line) ?? [];
        list.push({ src, alt: ref.alt });
        byLine.set(ref.line, list);
    }
    return byLine;
}

export interface PictureEvents {
    activate(view: EditorView, element: HTMLElement): void;       // one click: the cursor goes to the picture's line
    zoom(image: ZoomedImage): void;                               // double click
}

// The pictures of one line.
export class PicturesWidget extends WidgetType {
    constructor(readonly items: readonly PictureItem[], private readonly events: PictureEvents, private readonly dim = false) { super(); }

    override eq(other: PicturesWidget): boolean {
        return other.dim === this.dim && other.items.length === this.items.length && other.items.every((it, i) => it.src === this.items[i].src && it.alt === this.items[i].alt);
    }

    override toDOM(view: EditorView): HTMLElement {
        const box = document.createElement('div');
        box.className = 'cm-md-pictures' + (this.dim ? ' cm-md-dim' : '');
        for (const item of this.items) {
            const img = document.createElement('img');
            img.src = item.src;
            img.alt = item.alt;
            img.draggable = false;
            img.style.maxHeight = `${MAX_HEIGHT}px`;
            img.style.maxWidth = `min(100%, ${MAX_WIDTH}px)`;
            img.addEventListener('error', () => {
                const missing = document.createElement('span');
                missing.className = 'cm-md-picture-missing';
                missing.textContent = item.alt || 'Image not found';
                img.replaceWith(missing);
            });
            img.addEventListener('click', event => { if (event.detail === 1) this.events.activate(view, box); });
            img.addEventListener('dblclick', () => this.events.zoom({ src: item.src, title: item.alt || decodeURIComponent(item.src.split('/').pop() ?? '') }));
            box.append(img);
        }
        return box;
    }

    override ignoreEvent(): boolean { return true; }
}
