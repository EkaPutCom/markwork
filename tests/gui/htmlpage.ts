// GUI tests: an HTML page in its tab (ui/htmlpage.ts) with a real WebKit. A page runs its scripts but reaches no network and no
// file outside its folder; a local listener counts every connection the page manages to make.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';
import Gtk from 'gi://Gtk?version=4.0';
import { HtmlPage } from '../../src/ui/htmlpage.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import { inMemorySettings } from '../../src/platform/gjs/settings.js';
import { widgetPixbuf } from '../widgets.js';

export function htmlPageTests(c: GuiContext): void {
    const { w, pump } = c;

    section('HTML page');
    const site = GLib.build_filenamev([tmp, 'html-site']);
    const outside = GLib.build_filenamev([tmp, 'html-outside']);
    const put = (dir: string, name: string, text: string) => {
        GLib.mkdir_with_parents(GLib.build_filenamev([dir, ...name.split('/').slice(0, -1)]), 0o755);
        GLib.file_set_contents(GLib.build_filenamev([dir, ...name.split('/')]), text);
        return GLib.build_filenamev([dir, ...name.split('/')]);
    };

    // The listener stands for "the network": a page that gets a connection through is a page that escaped.
    const listener = new Gio.SocketService();
    let connections = 0;
    listener.connect('incoming', () => { connections++; return false; });
    const port = listener.add_any_inet_port(null);
    listener.start();
    const remote = `http://127.0.0.1:${port}`;

    put(outside, 'secret.txt', 'top secret');
    put(site, 'sub/data.txt', 'sibling data');
    put(site, 'style.css', '#h { color: rgb(1, 2, 3); }');
    put(site, 'sub/lib.js', 'window.libLoaded = true;');
    put(site, 'two.html', '<!doctype html><title>Two</title><p id="p">second page</p>');
    // A symbolic link inside the folder that points out of it.
    try { GLib.unlink(GLib.build_filenamev([site, 'leak'])); } catch { /* not there yet */ }
    Gio.File.new_for_path(GLib.build_filenamev([site, 'leak'])).make_symbolic_link(outside, null);
    const index = put(site, 'index.html', `<!doctype html><html><head><meta charset="utf-8"><title>Report</title>
<link rel="stylesheet" href="style.css"></head><body>
<h1 id="h">Hello</h1><button id="b" onclick="document.title = 'clicked'">Go</button>
<a id="web" href="${remote}/page">outside link</a>
<script src="sub/lib.js"></script>
<script>
window.__out = null;
window.probe = async () => {
  const got = {};
  const attempt = async (name, run) => {
    try { got[name] = String(await Promise.race([run(), new Promise(r => setTimeout(() => r('TIMEOUT'), 1500))])); }
    catch (e) { got[name] = 'ERR'; }
  };
  const loads = (make) => () => new Promise(res => { const e = make(); e.onload = () => res('loaded'); e.onerror = () => res('blocked'); document.body.append(e); });
  await attempt('script', async () => 'ran');
  await attempt('sibling', async () => (await (await fetch('sub/data.txt')).text()).trim());
  await attempt('above', async () => (await (await fetch('../html-outside/secret.txt')).text()).trim());
  await attempt('link-out', async () => (await (await fetch('leak/secret.txt')).text()).trim());
  await attempt('file', async () => (await fetch('file://${outside}/secret.txt')).status);
  await attempt('fetch', async () => (await fetch('${remote}/a', { mode: 'no-cors' })).status);
  await attempt('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', '${remote}/b'); x.onload = () => res(x.status); x.onerror = () => rej(1); x.send(); }));
  await attempt('socket', () => new Promise((res, rej) => { const s = new WebSocket('ws://127.0.0.1:${port}/c'); s.onopen = () => res('open'); s.onerror = () => rej(1); }));
  await attempt('image', loads(() => Object.assign(new Image(), { src: '${remote}/d.png' })));
  await attempt('file-image', loads(() => Object.assign(new Image(), { src: 'file://${outside}/secret.txt' })));
  await attempt('remote-script', loads(() => Object.assign(document.createElement('script'), { src: '${remote}/e.js' })));
  await attempt('beacon', async () => navigator.sendBeacon('${remote}/f', 'x'));
  await attempt('iframe', loads(() => Object.assign(document.createElement('iframe'), { src: '${remote}/g' })));
  await attempt('css', loads(() => Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '${remote}/h.css' })));
  await attempt('form', async () => { const f = Object.assign(document.createElement('form'), { action: '${remote}/i', method: 'post' }); document.body.append(f); f.submit(); return 'submitted'; });
  await attempt('navigate', async () => { location.href = '${remote}/j'; return 'tried'; });
  await attempt('window', async () => String(window.open('${remote}/k')));
  await attempt('storage', async () => { localStorage.setItem('k', 'v'); return localStorage.getItem('k'); });
  window.__out = got;
};
</script></body></html>`);

    const until = (done: () => boolean, ms = 8000): boolean => {
        const end = GLib.get_monotonic_time() + ms * 1000;
        while (!done() && GLib.get_monotonic_time() < end) { pump(); GLib.usleep(10000); }
        return done();
    };
    const opened: string[] = [];
    const hosts = new Map<HtmlPage, Gtk.Window>();
    // A page on its own in a plain window, to test the sandbox without a tab around it.
    const openViewer = (path = index, root: string = site): HtmlPage => {
        const page = new HtmlPage(path, root, uri => { opened.push(uri); });
        const host = new Gtk.Window({ default_width: 960, default_height: 720, child: page.widget });
        host.present();
        hosts.set(page, host);
        ok(until(() => !page.loading && page.view !== null), 'the page did not load');
        return page;
    };
    const closeViewer = (page: HtmlPage) => {
        page.dispose();
        hosts.get(page)?.destroy();
        hosts.delete(page);
    };
    const value = (viewer: HtmlPage, script: string): string => {
        let result: string | null = null;
        viewer.evaluate(script).then(r => { result = r; }, e => { result = `ERROR ${e}`; });
        until(() => result !== null);
        return result!;
    };

    const viewer = openViewer();
    test('the page loads with its own styles and scripts from its folder', () => {
        eq(value(viewer, 'document.title'), 'Report');
        eq(value(viewer, 'getComputedStyle(document.getElementById("h")).color'), 'rgb(1, 2, 3)', 'the stylesheet');
        eq(value(viewer, 'String(window.libLoaded)'), 'true', 'the script file');
    });
    test('the page is interactive: a click runs its script', () => {
        value(viewer, 'document.getElementById("b").click()');
        eq(value(viewer, 'document.title'), 'clicked');
    });

    value(viewer, 'window.probe()');
    ok(until(() => value(viewer, 'String(window.__out !== null)') === 'true', 20000), 'the probe did not finish');
    const out = JSON.parse(value(viewer, 'JSON.stringify(window.__out)')) as Record<string, string>;
    GLib.usleep(300000); pump();
    test('scripts run, and the page can read the files of its own folder', () => {
        eq(out.script, 'ran');
        eq(out.sibling, 'sibling data');
        eq(out.storage, 'v');
    });
    test('a page cannot read a file outside its folder, by a path, a link, or file://', () => {
        eq([out.above, out['link-out'], out.file], ['ERR', 'ERR', 'ERR']);
        eq(out['file-image'], 'blocked');
    });
    test('a page cannot reach the network: not by fetch, XHR, WebSocket, an image, a script, a frame, a stylesheet, a beacon, a form, or navigation', () => {
        for (const name of ['fetch', 'xhr', 'socket', 'image', 'remote-script', 'css']) {
            ok(!['loaded', 'open', '200'].includes(out[name]), `${name}: ${out[name]}`);
        }
        eq(connections, 0, 'a connection reached the listener');
    });
    test('a script cannot open a window or send the page to a link by itself', () => {
        eq(out.window, 'null');
        eq(opened, [], 'neither window.open nor location.href handed anything over');
        eq(connections, 0);
    });
    test('a link that is clicked is handed over to be confirmed, and is not loaded', () => {
        // (WebKit counts a script run through the API as a user gesture, so this click stands for the user\'s.)
        value(viewer, 'document.getElementById("web").click()');
        for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
        eq(opened, [`${remote}/page`]);
        eq(value(viewer, 'document.title'), 'clicked', 'the page stayed where it was');
        eq(connections, 0);
    });
    test('a page of the same folder opens, Back returns to the first, and Reload keeps the page', () => {
        value(viewer, 'location.href = "two.html"');
        ok(until(() => value(viewer, 'document.title') === 'Two'), 'the second page did not load');
        ok(viewer.view!.can_go_back(), 'no way back');
        viewer.view!.go_back();
        const first = () => value(viewer, 'String(document.getElementById("h") !== null)') === 'true';
        ok(until(first), 'did not go back');
        viewer.reload();
        ok(until(() => !viewer.loading && first() && value(viewer, 'document.title') === 'Report'), 'reload gave a fresh page');
    });
    test('the page is shown again when its file changes on disk', () => {
        put(site, 'index.html', '<!doctype html><title>Changed</title><p>new</p>');
        ok(until(() => value(viewer, 'document.title') === 'Changed', 6000), 'the viewer did not follow the file');
    });
    test('a file outside the folder gets no address even when asked for by the viewer\'s own scheme', () => {
        value(viewer, 'location.href = "../html-outside/secret.txt"');
        for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
        ok(value(viewer, 'document.title') === 'Changed' || !value(viewer, 'document.body.innerText').includes('top secret'), 'the page showed a file outside its folder');
    });
    test('inside a work folder a page reaches its parent folders, but not what is above the work folder', () => {
        const page = put(site, 'pages/up.html', `<!doctype html><title>up</title><script>
Promise.all([fetch('../sub/data.txt').then(r => r.text()), fetch('../../html-outside/secret.txt').then(r => r.text()).catch(() => 'blocked')])
  .then(([a, b]) => { document.title = a.trim() + '|' + b; }).catch(() => { document.title = 'failed'; });</script>`);
        const alone = openViewer(page, GLib.path_get_dirname(page));   // only its own folder
        ok(until(() => value(alone, 'document.title') === 'failed'), 'the parent folder was readable without a work folder');
        closeViewer(alone);
        const inside = openViewer(page, site);
        ok(until(() => value(inside, 'document.title') === 'sibling data|blocked'), `inside the work folder: ${value(inside, 'document.title')}`);
        closeViewer(inside);
        const elsewhere = openViewer(page, GLib.path_get_dirname(page));
        ok(until(() => value(elsewhere, 'document.title') === 'failed'), 'a work folder that does not hold the page widened the reach');
        closeViewer(elsewhere);
    });
    test('closing the page stops it', () => {
        closeViewer(viewer);
        pump();
        ok(viewer.closed, 'still running');
    });



    listener.stop();
    listener.close();

    // ---------- In a window: the tab ----------

    const note = put(site, 'notes/n.md', '# Note\n');
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(8000); } };
    const openWindow = (extra: Record<string, unknown> = {}) => {
        const s = inMemorySettings({ welcomed: true, dark: false, autosave: false, folder: site, sidebar: false, home: false, ...extra });
        const win = new MainWindow(c.app, s, null);
        settle();
        return win;
    };
    const closeWindow = (win: MainWindow) => {
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };

    test('an HTML file in the Files tab opens as a tab next to the document, not as a window', () => {
        const win = openWindow();
        win.openFile(note); settle();
        win.openFile(index); settle();
        eq(win.documentCount, 2, 'the document and the page');
        eq(win.documentName, 'index.html', 'the shown tab');
        ok(win.shownHtml !== null, 'no HTML page is shown');
        ok(!win.statusBar.get_visible(), 'the status bar belongs to documents');
        ok(win.session.views.pageMode && !win.session.views.homeMode, 'a page that is not Home');
        win.openFile(index); settle();
        eq(win.documentCount, 2, 'the same file does not open a second tab');
        closeWindow(win);
    });
    test('the page in the tab runs its script and reaches only the work folder', () => {
        const tab = put(site, 'tab.html', '<!doctype html><title>Tab</title><script src="sub/lib.js"></script><script>window.hello = "yes";</script>');
        const win = openWindow();
        win.openFile(tab); settle();
        const shown = win.shownHtml!;
        ok(until(() => !shown.loading && shown.view !== null), 'the page did not load');
        eq([value(shown, 'window.hello'), value(shown, 'String(window.libLoaded)')], ['yes', 'true'], 'its script and the script file of its folder');
        closeWindow(win);
    });
    test('Save and the text actions are off on a page, and Ctrl+W closes the page and returns to the document', () => {
        const win = openWindow();
        win.openFile(note); settle();
        win.openFile(index); settle();
        ok(win.save() === true, 'Save on a page must not open a dialog');
        const page = win.shownHtml!;
        win.closeTab(); settle();
        ok(page.closed, 'the page was not stopped');
        eq([win.documentCount, win.file], [1, note], 'back on the document');
        ok(win.statusBar.get_visible(), 'the status bar is back');
        closeWindow(win);
    });
    test('an HTML page with Home: Home keeps its place, and the empty document waits without a tab', () => {
        const win = openWindow({ home: true });
        eq(win.documentName, 'Home', 'the window opens on Home');
        win.openFile(index); settle();
        eq(win.documentCount, 2, 'Home and the page');
        win.closeTab(); settle();   // the page
        ok(win.homeMode, 'Home is shown again');
        eq(win.documentCount, 1);
        win.openFile(note); settle();
        eq([win.documentCount, win.file], [2, note], 'the waiting document came back as a tab');
        closeWindow(win);
    });
    test('only the file tabs and Home are remembered, not the HTML page', () => {
        const win = openWindow({ home: true });
        win.openFile(note); settle();
        win.openFile(index); settle();
        ok(win.onClose(), 'onClose() refused');
        eq(win.settings.tabs.map(t => t.file), ['markwork:home', note], 'saved tabs');
        closeWindow(win);
    });

    const shot = optVal('shot-html');
    if (shot) {
        put(site, 'index.html', `<!doctype html><meta charset="utf-8"><title>Quarterly report</title><style>body{font:16px system-ui;margin:2rem}button{padding:.5rem 1rem}</style>
<h1>Quarterly report</h1><p>This page runs its own script. Press the button.</p><button onclick="this.textContent='Clicked '+(++window.n||(window.n=1))+' times'">Press me</button>`);
        const win = openWindow({ home: true });
        win.openFile(note); settle();
        win.openFile(index); settle();
        for (let i = 0; i < 60; i++) { pump(); GLib.usleep(10000); }
        const pixbuf = widgetPixbuf(win.win);
        if (pixbuf) pixbuf.savev(`${shot}-html.png`, 'png', [], []);
        closeWindow(win);
    }
}
