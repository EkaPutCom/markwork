// Renders Mermaid code into an image.
//
// Mermaid only runs in a browser environment (it needs the DOM and text measurement), so
// a WebKitGTK that is not displayed is used:
//
//   1. A WebKitWebView that is never attached to a window loads a blank page
//      that includes mermaid.min.js (copied to dist/ at build time, see vite.config.ts).
//   2. For each diagram, the page runs mermaid.render(), attaches its SVG, then
//      sends its size back through a script message handler.
//   3. A snapshot of the whole document (WebKit draws it even though the view is not shown; its size
//      follows the page contents) is cropped to the diagram's size into a pixbuf.
//
// A snapshot is chosen over loading the SVG through librsvg because Mermaid labels use
// <foreignObject> (HTML inside SVG), which librsvg does not support.
//
// WebKitGTK is loaded with import() when the first diagram is needed, not at program start:
// without the library the app still runs and diagrams show an error message.
//
// There is only one WebView and it is created when the first diagram is needed, so documents without
// diagrams do not pay its cost. Diagrams are rendered one at a time (a queue), and the results
// are kept in a cache per (theme, code).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type GdkPixbuf from 'gi://GdkPixbuf';
import type WebKit from 'gi://WebKit?version=6.0';
import type JavaScriptCore from 'gi://JavaScriptCore?version=6.0';
import { pixbufFromTexture } from '../gtkutil.js';
import { _ } from '../i18n.js';

const PAD = 12;              // space around the diagram in the resulting image
const MAX_SIZE = 8000;       // diagrams larger than this (pixels) are rejected
const TIMEOUT_SECONDS = 20;  // time limit for one diagram
const SETTLE_MS = 150;       // pause after the diagram is attached, before the snapshot
const CACHE_LIMIT = 100;

export interface DiagramTheme {
    dark: boolean;
    bg: string;   // image background color; must match the editor background
    fg: string;   // text and lines
    accent: string;   // node border line
    node: string;     // node fill
}

export type DiagramResult =
    | { ok: true; pixbuf: GdkPixbuf.Pixbuf }
    | { ok: false; error: string };

interface Job {
    id: number;
    code: string;
    theme: DiagramTheme;
    key: string;
    callbacks: ((result: DiagramResult) => void)[];
}

// Find mermaid.min.js next to the running code (dist/ or dist/chunks/).
function findScript(): string | null {
    const here = Gio.File.new_for_uri(import.meta.url).get_parent();
    for (const dir of [here, here?.get_parent()]) {
        const file = dir?.get_child('mermaid.min.js');
        if (file?.query_exists(null)) return file.get_path();
    }
    return null;
}

export class MermaidRenderer {
    private webkit: typeof WebKit | null = null;
    private loading = false;
    private view: WebKit.WebView | null = null;
    private ready = false;
    private failure: string | null = null;

    private queue: Job[] = [];
    private current: Job | null = null;
    private timeout = 0;
    private nextId = 1;
    private cache = new Map<string, DiagramResult>();

    // Available if the Mermaid script exists (without it, diagrams show an error message).
    get available(): boolean {
        return findScript() !== null;
    }

    // Result from the cache if the same diagram has been rendered before.
    cached(code: string, theme: DiagramTheme): DiagramResult | undefined {
        return this.cache.get(this.keyOf(code, theme));
    }

    // Render `code`; the callback is called (async) with the result. Identical requests
    // that are queued are merged.
    render(code: string, theme: DiagramTheme, callback: (result: DiagramResult) => void): void {
        const key = this.keyOf(code, theme);
        const hit = this.cache.get(key);
        if (hit) {
            callback(hit);
            return;
        }
        const pending = [...this.queue, ...(this.current ? [this.current] : [])].find(j => j.key === key);
        if (pending) {
            pending.callbacks.push(callback);
            return;
        }
        this.queue.push({ id: this.nextId++, code, theme, key, callbacks: [callback] });
        this.next();
    }

    private keyOf(code: string, theme: DiagramTheme): string {
        return `${theme.dark ? 'd' : 'l'}${theme.bg}${theme.fg}${theme.accent}${theme.node}\n${code}`;
    }

    // ---------- Queue ----------

    private next(): void {
        if (this.current || !this.queue.length) return;
        this.ensureView();
        if (this.failure) {
            const failure = this.failure;
            for (const job of this.queue.splice(0)) this.finish(job, { ok: false, error: failure }, false);
            return;
        }
        if (!this.ready) return;   // continued by load-changed (or after WebKit finishes loading)
        this.current = this.queue.shift()!;
        this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
            this.timeout = 0;
            if (this.current) this.finish(this.current, { ok: false, error: _('Rendering timed out') }, false);
            return GLib.SOURCE_REMOVE;
        });
        this.run(this.current);
    }

    // cache = false for temporary errors (timeout, missing script), so it can be tried again.
    private finish(job: Job, result: DiagramResult, cache = true): void {
        if (this.current === job) {
            this.current = null;
            if (this.timeout) GLib.source_remove(this.timeout);
            this.timeout = 0;
        }
        if (cache) this.remember(job.key, result);
        for (const callback of job.callbacks) callback(result);
        this.next();
    }

    private remember(key: string, result: DiagramResult): void {
        if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
        this.cache.set(key, result);
    }

    // ---------- WebView ----------

    private ensureView(): void {
        if (this.view || this.failure || this.loading) return;
        const script = findScript();
        if (!script) {
            this.failure = 'mermaid.min.js not found (run npm run build)';
            return;
        }
        if (!this.webkit) {
            this.loading = true;
            import('gi://WebKit?version=6.0').then(module => {
                this.webkit = module.default;
            }, () => {
                this.failure = _('WebKitGTK is not installed (package gir1.2-webkit-6.0)');
            }).then(() => {
                this.loading = false;
                this.next();
            });
            return;
        }
        const WebKit = this.webkit;
        const manager = new WebKit.UserContentManager();
        manager.register_script_message_handler('markwork', null);
        manager.connect('script-message-received::markwork', (_m, value) => this.onMessage(value));

        const view = new WebKit.WebView({ user_content_manager: manager });
        const settings = view.get_settings();
        settings.enable_write_console_messages_to_stdout = false;
        settings.enable_developer_extras = false;
        this.view = view;

        view.connect('load-changed', (_v, event) => {
            if (event !== WebKit.LoadEvent.FINISHED) return;
            this.ready = true;
            this.next();
        });
        view.connect('load-failed', () => {
            this.failure = _('Failed to load Mermaid');
            this.next();
        });
        const base = GLib.path_get_dirname(script);
        view.load_html('<!DOCTYPE html><html><head><meta charset="utf-8"><script src="mermaid.min.js"></script></head><body></body></html>',
            // The trailing slash is required: without it "mermaid.min.js" is looked up in the parent folder.
            `${Gio.File.new_for_path(base).get_uri()}/`);
    }

    private run(job: Job): void {
        const t = job.theme;
        // JSON.stringify produces a JavaScript literal that is safe for any code.
        const script = `(async () => {
            const post = o => window.webkit.messageHandlers.markwork.postMessage(JSON.stringify({ id: ${job.id}, ...o }));
            try {
                document.body.innerHTML = '';
                document.documentElement.style.background = ${JSON.stringify(t.bg)};
                document.body.style.cssText = 'margin:0;padding:${PAD}px;background:' + ${JSON.stringify(t.bg)};
                // The 'base' theme with colors from the editor palette: Mermaid's default theme has too little contrast
                // on a dark background. Lines are thickened and edge labels use the background color.
                mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
                    theme: 'base', fontSize: 16,
                    themeVariables: {
                        darkMode: ${t.dark}, background: ${JSON.stringify(t.bg)}, fontSize: '16px',
                        primaryColor: ${JSON.stringify(t.node)}, primaryTextColor: ${JSON.stringify(t.fg)},
                        primaryBorderColor: ${JSON.stringify(t.accent)}, lineColor: ${JSON.stringify(t.fg)},
                        secondaryColor: ${JSON.stringify(t.node)}, tertiaryColor: ${JSON.stringify(t.bg)},
                        textColor: ${JSON.stringify(t.fg)}, edgeLabelBackground: ${JSON.stringify(t.bg)},
                        noteBkgColor: ${JSON.stringify(t.node)}, noteTextColor: ${JSON.stringify(t.fg)},
                    } });
                const css = document.createElement('style');
                css.textContent = '.flowchart-link, .edgePath path, .messageLine0, .messageLine1, .relation { stroke-width: 2px !important; }' +
                    ' .node rect, .node polygon, .node circle, .node ellipse, .node path, .actor { stroke-width: 2px !important; }' +
                    ' .edgeLabel, .edgeLabel p, .edgeLabel span, .labelBkg { background-color: ${t.bg} !important; }';
                document.head.appendChild(css);
                const { svg } = await mermaid.render('diagram${job.id}', ${JSON.stringify(job.code)});
                document.body.innerHTML = svg;
                const el = document.querySelector('svg');
                // The diagram's real size, not "100%" of the window width.
                const vb = el.viewBox && el.viewBox.baseVal;
                if (vb && vb.width && vb.height) {
                    el.setAttribute('width', vb.width);
                    el.setAttribute('height', vb.height);
                }
                el.style.maxWidth = 'none';
                const r = el.getBoundingClientRect();
                post({ w: r.width, h: r.height });
            } catch (e) {
                post({ error: String((e && e.message) || e) });
            }
        })();`;
        this.view!.evaluate_javascript(script, -1, null, null, null, null);
    }

    private onMessage(value: JavaScriptCore.Value): void {
        const job = this.current;
        if (!job) return;
        let msg: { id: number; w?: number; h?: number; error?: string };
        try {
            msg = JSON.parse(value.to_string());
        } catch {
            return;
        }
        if (msg.id !== job.id) return;   // leftovers of a diagram that was cancelled
        if (msg.error !== undefined) {
            // Mermaid syntax error: the message spans several lines, take the useful one.
            this.finish(job, { ok: false, error: msg.error.split('\n').find(l => l.trim()) ?? msg.error });
            return;
        }
        const w = Math.ceil(msg.w ?? 0) + 2 * PAD, h = Math.ceil(msg.h ?? 0) + 2 * PAD;
        if (w > MAX_SIZE || h > MAX_SIZE) {
            this.finish(job, { ok: false, error: _('The diagram is too large') });
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            if (this.current === job) this.snapshot(job, w, h);
            return GLib.SOURCE_REMOVE;
        });
    }

    private snapshot(job: Job, w: number, h: number): void {
        const view = this.view!;
        const WebKit = this.webkit!;
        view.get_snapshot(WebKit.SnapshotRegion.FULL_DOCUMENT, WebKit.SnapshotOptions.NONE, null, (_v, res) => {
            if (this.current !== job) return;
            try {
                const texture = view.get_snapshot_finish(res);
                // On HiDPI screens the snapshot has device pixel size.
                const sw = texture.get_width(), sh = texture.get_height();
                const factor = Math.max(1, view.get_scale_factor());
                const full = pixbufFromTexture(texture);
                const cw = Math.min(sw, w * factor), ch = Math.min(sh, h * factor);
                let pixbuf = full.new_subpixbuf(0, 0, cw, ch);
                if (factor > 1) pixbuf = pixbuf.scale_simple(Math.round(cw / factor), Math.round(ch / factor), 2 /* BILINEAR */) ?? pixbuf;
                this.finish(job, { ok: true, pixbuf });
            } catch (e) {
                this.finish(job, { ok: false, error: e instanceof Error ? e.message : String(e) });
            }
        });
    }
}

// One renderer is shared by all windows.
let shared: MermaidRenderer | null = null;
export const mermaidRenderer = (): MermaidRenderer => shared ??= new MermaidRenderer();
