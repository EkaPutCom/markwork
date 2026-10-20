// What the HTML viewer needs that does not touch the runtime: which files it opens, the address a page is served
// under, and the rule that keeps a page inside its own folder.
//
// A page is served by the viewer itself under a private scheme, `mwhtml://v<id>/<path>`, where <id> names one open
// viewer and <path> is relative to the folder of the HTML file. The page runs with JavaScript on, so the rest of the
// sandbox is: every request is answered from that folder and nowhere else (resolveHtmlRequest), and the page's CSP
// keeps it from reaching anything but that scheme (HTML_CSP).

import { isWindowsPath, slashed } from './paths.js';

export const HTML_EXTENSIONS = ['.html', '.htm', '.xhtml'];
export const HTML_SCHEME = 'mwhtml';

export const isHtmlFile = (name: string): boolean => HTML_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));

// Sent with every response. Scripts and inline styles are allowed (the page is meant to be interactive), but nothing
// loads from, or connects to, anything except this scheme, `data:`, and `blob:`: no network, no `file:`. Forms can only
// post back to the viewer, and plugins are off.
export const HTML_CSP = [
    "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
    "connect-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
    css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', map: 'application/json',
    txt: 'text/plain', md: 'text/plain', csv: 'text/csv', xml: 'application/xml', wasm: 'application/wasm',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};

export function htmlContentType(name: string): string {
    const dot = name.lastIndexOf('.');
    return (dot >= 0 && CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

// The address of `file` for the viewer `id` whose folder is `root`; null if the file is not inside that folder.
export function htmlViewUrl(id: number, root: string, file: string): string | null {
    const below = relativeParts(slashed(root), slashed(file));
    return below && `${HTML_SCHEME}://v${id}/${below.map(encodeURIComponent).join('/')}`;
}

// A request address → the viewer it is for and the path asked for (percent-decoded, query and fragment dropped).
export function parseHtmlUrl(uri: string): { id: number; path: string } | null {
    const match = new RegExp(`^${HTML_SCHEME}://v(\\d+)(/[^?#]*)?`).exec(uri);
    if (!match) return null;
    try {
        return { id: Number(match[1]), path: decodeURIComponent(match[2] ?? '/') };
    } catch {
        return null;   // a malformed escape
    }
}

// Where a requested path is on disk, or null if the request must be refused. Only lexical: "..", ".", and doubled
// slashes are resolved without touching the disk, and the answer must be strictly below `root`. `readLink` gives the
// target of a symbolic link (null for anything else), so a link inside the folder that points out of it is refused too.
export function resolveHtmlRequest(root: string, requested: string, readLink: (path: string) => string | null): string | null {
    if (requested.includes('\0') || requested.includes('\\')) return null;
    root = slashed(root);
    let pending = splitPath(requested);
    let current = root;
    for (let hops = 0; pending.length;) {
        const [name, ...rest] = pending;
        if (name === '..') {
            if (current === root) return null;
            current = current.slice(0, current.lastIndexOf('/')) || '/';
            pending = rest;
            continue;
        }
        const next = `${current === '/' ? '' : current}/${name}`;
        const link = readLink(next);
        const target = link === null ? null : slashed(link);
        if (target === null) {
            current = next;
            pending = rest;
            continue;
        }
        if (++hops > 32) return null;   // a link loop
        // A link restarts the walk at its target, which must itself be inside the folder.
        const resolved = target.startsWith('/') || isWindowsPath(target) ? splitPath(target) : [...splitPath(current), ...splitPath(target)];
        const inside = relativeParts(root, normalize(resolved));
        if (!inside) return null;
        current = root;
        pending = [...inside, ...rest];
    }
    return current === root ? null : current;   // the folder itself is not a page
}

function splitPath(path: string): string[] {
    return path.split('/').filter(part => part !== '' && part !== '.');
}

// The parts of the path `resolved` is made of, with ".." applied; ".." past the start stays and so never matches a root.
function normalize(parts: string[]): string {
    const out: string[] = [];
    for (const part of parts) {
        if (part !== '..') out.push(part);
        else if (out.length) out.pop();
        else return '/\0';   // above the top of the filesystem: matches nothing
    }
    return `/${out.join('/')}`;
}

// The parts of `file` below `root`; null when it is not strictly below it.
function relativeParts(root: string, file: string): string[] | null {
    const base = splitPath(root), parts = splitPath(normalize(splitPath(file)));
    if (parts.length <= base.length || base.some((part, i) => parts[i] !== part)) return null;
    return parts.slice(base.length);
}
