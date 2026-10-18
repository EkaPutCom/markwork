// HTML page: the contents of a tab that shows an .html file the way a browser would, scripts included, but sealed in.
//
// The page is interactive (JavaScript runs), so what it may reach is limited from the outside:
//
//   - It is served by this module under a private scheme (`mwhtml://v<id>/…`, markdown/htmlview.ts), never from
//     `file://`. A request is answered only from the work folder and below (the HTML file's own folder when the file is
//     not inside the work folder), so `../assets/x.png` works inside a project; a path that climbs out, or a
//     symbolic link that points out, is refused. So it cannot read other files, scripts included.
//   - Every response carries a Content-Security-Policy (HTML_CSP) that lets the page load and connect to nothing but
//     that scheme, `data:`, and `blob:`. So no scripts, images, fonts, fetches, WebSockets, or forms go to the network.
//   - As a second wall, all network traffic of the web session is sent to a proxy that does not exist, and WebRTC and
//     the media devices are off, which the policy does not cover.
//   - Storage is ephemeral (nothing a page keeps survives the window), downloads and permission requests are refused,
//     and a page cannot open windows or navigate by itself. A link the user clicks that points to the web is handed to
//     the window, which shows the whole address and opens it in the system's browser only if the user agrees; the page
//     never loads it. (A script can click a link too, and WebKit cannot tell that from the user, hence the question.)
//
// WebKitGTK is loaded with import() when the first page is opened, so the app still runs without it.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type WebKit from 'gi://WebKit?version=6.0';
import type Soup from 'gi://Soup?version=3.0';
import { onKeyPress } from '../gtkutil.js';
import { HTML_CSP, HTML_SCHEME, htmlContentType, htmlViewUrl, parseHtmlUrl, resolveHtmlRequest } from '../markdown/htmlview.js';
import { _ } from '../i18n.js';

const RELOAD_DELAY = 200;   // ms; saves in quick succession (an editor writes twice) reload once

// Shared by every viewer: WebKit, the network session, and the folders the open viewers serve.
interface Runtime {
    webkit: typeof WebKit;
    soup: typeof Soup;
    session: WebKit.NetworkSession;
}

let runtime: Runtime | null = null;
let nextId = 1;
const roots = new Map<number, string>();   // viewer id → the folder it serves

function readLink(path: string): string | null {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::is-symlink,standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return info.get_is_symlink() ? info.get_symlink_target() : null;
    } catch {
        return null;   // it does not exist: the read below reports that
    }
}

async function loadRuntime(): Promise<Runtime> {
    if (runtime) return runtime;
    let webkit: typeof WebKit, soup: typeof Soup;
    try {
        webkit = (await import('gi://WebKit?version=6.0')).default;
        soup = (await import('gi://Soup?version=3.0')).default;
    } catch {
        throw new Error(_('WebKitGTK is not installed (package gir1.2-webkit-6.0)'));
    }
    const session = webkit.NetworkSession.new_ephemeral();
    // Nothing leaves through a proxy that is not there; only the private scheme, which never uses the network, works.
    session.set_proxy_settings(webkit.NetworkProxyMode.CUSTOM, webkit.NetworkProxySettings.new('http://127.0.0.1:1', null));
    session.connect('download-started', (_s, download) => download.cancel());
    const loaded: Runtime = { webkit, soup, session };
    webkit.WebContext.get_default().register_uri_scheme(HTML_SCHEME, request => serve(loaded, request));
    runtime = loaded;
    return loaded;
}

function refuse(request: WebKit.URISchemeRequest, code: number, message: string): void {
    request.finish_error(GLib.Error.new_literal(Gio.io_error_quark(), code, message));
}

// Answer one request of the private scheme from the folder of the viewer it belongs to.
function serve(rt: Runtime, request: WebKit.URISchemeRequest): void {
    const parsed = parseHtmlUrl(request.get_uri());
    const root = parsed && roots.get(parsed.id);
    const path = root ? resolveHtmlRequest(root, parsed.path, readLink) : null;
    if (!path) {
        refuse(request, Gio.IOErrorEnum.PERMISSION_DENIED, _('Outside the page\'s folder'));
        return;
    }
    const file = Gio.File.new_for_path(path);
    file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (_f, queried) => {
        let size: number;
        try {
            const info = file.query_info_finish(queried);
            if (info.get_file_type() !== Gio.FileType.REGULAR) throw new Error('not a file');
            size = info.get_size();
        } catch {
            refuse(request, Gio.IOErrorEnum.NOT_FOUND, _('Not found'));
            return;
        }
        file.read_async(GLib.PRIORITY_DEFAULT, null, (_g, opened) => {
            try {
                const response = rt.webkit.URISchemeResponse.new(file.read_finish(opened), size);
                response.set_content_type(htmlContentType(path));
                const headers = rt.soup.MessageHeaders.new(rt.soup.MessageHeadersType.RESPONSE);
                headers.append('Content-Security-Policy', HTML_CSP);
                headers.append('Cache-Control', 'no-store');
                response.set_http_headers(headers);
                request.finish_with_response(response);
            } catch {
                refuse(request, Gio.IOErrorEnum.FAILED, _('Could not read the file'));
            }
        });
    });
}

export class HtmlPage {
    readonly widget: Gtk.Box;
    view: WebKit.WebView | null = null;   // after WebKit has loaded
    closed = false;
    loading = true;

    private readonly id = nextId++;
    private readonly back: Gtk.Button;
    private monitor: Gio.FileMonitor | null = null;
    private reloadTimer = 0;
    private rt: Runtime | null = null;
    private readonly root: string;
    private ready: (() => void) | null = null;

    // Resolves when the first load has finished (or failed). `openUri` is told of a link that was clicked, to ask the user
    // about it; it is never loaded here. `root` = the folder the page may read; it must hold `path`.
    readonly loaded: Promise<void>;

    constructor(private readonly path: string, root: string, private readonly openUri: (uri: string) => void) {
        this.root = root;
        roots.set(this.id, root);
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
        this.back = this.button('go-previous-symbolic', _('Back'), () => this.view?.go_back());
        this.back.sensitive = false;
        const bar = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        bar.add_css_class('toolbar');
        bar.append(this.back);
        bar.append(this.button('view-refresh-symbolic', _('Reload (Ctrl+R)'), () => this.reload()));
        const where = new Gtk.Label({ label: path, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.START, selectable: false });
        where.add_css_class('dim-label');
        where.add_css_class('caption');
        bar.append(where);
        this.widget.append(bar);
        this.widget.append(new Gtk.Separator());

        // Captured, so the shortcuts work while the page has the focus. Esc is left to the page (it closes its own dialogs).
        onKeyPress(this.widget, (keyval, state) => this.handleKey(keyval, state), Gtk.PropagationPhase.CAPTURE);

        this.loaded = new Promise(resolve => { this.ready = resolve; });
        void this.start();
    }

    private async start(): Promise<void> {
        try {
            this.rt = await loadRuntime();
        } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error));
            return;
        }
        if (this.closed) return;
        const { webkit } = this.rt;
        const view = new webkit.WebView({ network_session: this.rt.session });
        view.vexpand = view.hexpand = true;
        this.view = view;
        this.sealSettings(view);
        view.connect('decide-policy', (_v, decision, type) => this.decide(decision, type));
        view.connect('permission-request', (_v, request) => { request.deny(); return true; });
        view.connect('load-changed', (_v, event) => {
            this.loading = event !== webkit.LoadEvent.FINISHED;
            this.back.sensitive = view.can_go_back();
            if (!this.loading) this.ready?.();
        });
        view.connect('load-failed', () => { this.loading = false; this.ready?.(); return false; });
        this.widget.append(view);
        this.monitor = this.watch(this.path);
        const url = htmlViewUrl(this.id, this.root, this.path);
        if (url) view.load_uri(url);
        else this.fail(_('The page is outside its folder'));
    }

    private fail(message: string): void {
        this.loading = false;
        const status = new Adw.StatusPage({ icon_name: 'dialog-warning-symbolic', title: _('Could not show this page'), description: message, vexpand: true });
        this.widget.append(status);
        this.ready?.();
    }

    reload(): void {
        this.view?.reload_bypass_cache();
    }

    // Runs a script in the page and gives its result as text (for tests and for diagnostics; never fed by a page).
    evaluate(script: string): Promise<string> {
        const view = this.view;
        if (!view) return Promise.reject(new Error('the page is not loaded'));
        return new Promise((resolve, reject) => {
            view.evaluate_javascript(script, -1, null, null, null, (_v, result) => {
                try {
                    resolve(view.evaluate_javascript_finish(result).to_string());
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    // ---------- The sandbox ----------

    private sealSettings(view: WebKit.WebView): void {
        const settings = view.get_settings();
        settings.enable_javascript = true;                       // the page is meant to be interactive
        settings.javascript_can_open_windows_automatically = false;
        settings.allow_file_access_from_file_urls = false;
        settings.allow_universal_access_from_file_urls = false;
        settings.enable_webrtc = false;                          // peer connections are not covered by the policy
        settings.enable_media_stream = false;
        settings.enable_developer_extras = false;
        settings.enable_write_console_messages_to_stdout = false;
        settings.enable_html5_database = false;
    }

    // Navigation: a page of the private scheme loads; a link that is clicked and points to the web is reported, not loaded;
    // everything else (a script that navigates, a redirect to `file:`, a new window) is dropped. true = decided.
    private decide(decision: WebKit.PolicyDecision, type: WebKit.PolicyDecisionType): boolean {
        if (!this.rt) return false;
        const { PolicyDecisionType } = this.rt.webkit;
        if (type !== PolicyDecisionType.NAVIGATION_ACTION && type !== PolicyDecisionType.NEW_WINDOW_ACTION) return false;
        const action = (decision as WebKit.NavigationPolicyDecision).get_navigation_action();
        const uri = action.get_request().get_uri() ?? '';
        if (uri.startsWith(`${HTML_SCHEME}://`) && type === PolicyDecisionType.NAVIGATION_ACTION) {
            const target = parseHtmlUrl(uri);
            if (target?.id === this.id) return false;   // a page of this folder: let it load
        }
        decision.ignore();
        const web = /^(https?|mailto):/i.test(uri);
        if (web && action.is_user_gesture() && action.get_navigation_type() === this.rt.webkit.NavigationType.LINK_CLICKED) this.openUri(uri);
        return true;
    }

    // ---------- Widgets ----------

    private button(icon: string, tooltip: string, run: () => void): Gtk.Button {
        const button = new Gtk.Button({ icon_name: icon, tooltip_text: tooltip });
        button.add_css_class('flat');
        button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
        button.connect('clicked', run);
        return button;
    }

    private handleKey(keyval: number, state: number): boolean {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0, alt = (state & Gdk.ModifierType.ALT_MASK) !== 0;
        if (keyval === Gdk.KEY_F5 || (ctrl && (keyval === Gdk.KEY_r || keyval === Gdk.KEY_R))) { this.reload(); return true; }
        if (alt && keyval === Gdk.KEY_Left && this.view?.can_go_back()) { this.view.go_back(); return true; }
        return false;
    }

    private watch(path: string): Gio.FileMonitor | null {
        try {
            const monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', (_m, _f, _o, event) => {
                if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT) return;
                if (this.reloadTimer) GLib.source_remove(this.reloadTimer);
                this.reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY, () => {
                    this.reloadTimer = 0;
                    if (!this.closed) this.reload();
                    return GLib.SOURCE_REMOVE;
                });
            });
            return monitor;
        } catch {
            return null;   // no live reload; the Reload button still works
        }
    }

    // The tab is closed: the page stops, and what it served is forgotten.
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        roots.delete(this.id);
        this.monitor?.cancel();
        if (this.reloadTimer) GLib.source_remove(this.reloadTimer);
        this.reloadTimer = 0;
        // A page's timers and scripts must not keep running with no tab (and WebKit complains at exit otherwise).
        this.view?.terminate_web_process();
        this.ready?.();
    }
}
