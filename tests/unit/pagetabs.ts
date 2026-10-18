// Page tabs (Home, an HTML file) next to the document tabs, without GTK: which tab is shown, what stays when a tab closes,
// the empty document that waits without a tab, and which tabs the next launch gets back.

import { AppSession } from '../../src/app/session.js';
import { section, test, eq, ok, tmp, disk } from '../framework.js';
import { fakeFrontend, memorySettings, quiet, tabRow } from './appsession.js';

export function pageTabTests(): void {
    section('Page tabs');
    const dir = disk.join(tmp, 'pagetabs');
    disk.mkdirs(dir);
    const file = (name: string) => { const path = disk.join(dir, name); disk.write(path, '# x\n'); return path; };
    const a = file('a.md'), b = file('b.md'), page = file('report.html'), other = file('other.html');

    const setup = (home = true) => {
        const settings = memorySettings();
        settings.store.set('home', home);
        const frontend = fakeFrontend(settings, []);
        const row = frontend.documents.tabOrder;
        const session = new AppSession(frontend);
        session.start();
        const ids = () => row();
        const shown = () => (session.documents.page ?? session.documents.active).id;
        return { session, settings, docs: session.documents, ids, shown };
    };

    test('Home is a page, not a document: the empty document waits without a tab', () => {
        const { session, docs, ids, shown } = setup();
        docs.openHome();
        eq(docs.page?.kind, 'home');
        eq(ids(), [docs.page!.id], 'only the Home tab is in the row');
        eq(shown(), docs.page!.id);
        eq(docs.all.length, 1, 'the application still has an active document');
        eq(docs.active.file, null);
        docs.openHome();
        eq(docs.allPages.length, 1, 'Home opens once');
        session.dispose();
    });

    test('opening a file brings the waiting document back, after Home, and shows it', () => {
        const { session, docs, ids } = setup();
        docs.openHome();
        const homeId = docs.page!.id;
        docs.openInTab(a);
        eq(docs.page, null, 'a document is shown');
        eq(ids(), [homeId, docs.active.id], 'Home first, then the document');
        eq(docs.all.length, 1, 'the waiting document was used, not a new one');
        docs.openInTab(b);
        eq(ids().length, 3);
        session.dispose();
    });

    test('an HTML file opens as a page of its own, once; the document that was shown stays behind it', () => {
        const { session, docs, ids } = setup();
        docs.openInTab(a);
        const doc = docs.active;
        docs.openHtml(page, dir);
        eq([docs.page?.kind, docs.page?.file, docs.page?.root], ['html', page, dir]);
        eq(docs.active, doc, 'the document is what the page leaves behind');
        eq(ids().length, 2);
        docs.openHtml(page, dir);
        eq(docs.allPages.length, 1, 'the same file does not get a second tab');
        docs.openHtml(other, dir);
        eq(docs.allPages.length, 2);
        session.dispose();
    });

    test('the folder a page may read is the work folder if the file is inside it, else its own folder', () => {
        const { session, docs } = setup();
        docs.openHtml(page, tmp);
        eq(docs.page?.root, tmp, 'inside the work folder');
        docs.openHtml(other, disk.join(tmp, 'elsewhere'));
        eq(docs.page?.root, dir, 'outside it: its own folder');
        session.dispose();
    });

    test('Save, Save As, and Export do nothing while a page is shown', async () => {
        const { session, docs } = setup();
        docs.openInTab(a);
        docs.active.editor.setModified(true);
        docs.openHtml(page, dir);
        eq(docs.save(), true);
        eq(await docs.saveAs(), false);
        ok(docs.active.editor.isModified(), 'the document behind the page was not saved by it');
        session.dispose();
    });

    test('closing a shown page shows its neighbor; closing a page that is not shown changes nothing', () => {
        const { session, docs, ids, shown } = setup();
        docs.openInTab(a);
        const docId = docs.active.id;
        docs.openHtml(page, dir);
        docs.openHtml(other, dir);
        const [first, second] = docs.allPages;
        eq(ids(), [docId, first.id, second.id]);
        eq(shown(), second.id);
        docs.closeById(first.id);
        eq([shown(), ids()], [second.id, [docId, second.id]], 'a page behind the shown one closed');
        docs.closeById(second.id);
        eq([docs.page, shown()], [null, docId], 'the neighbor is shown');
        session.dispose();
    });

    test('closing the last document leaves the page that is open; with none, Home comes back', () => {
        const { session, docs, ids, shown } = setup();
        docs.openInTab(a);
        docs.openHtml(page, dir);
        const pageId = docs.page!.id;
        docs.select(docs.active.id);
        eq(docs.closeById(docs.active.id), true);
        eq([docs.page?.id, ids(), docs.all.length], [pageId, [pageId], 1], 'the page stays, the empty document waits');
        docs.closeById(pageId);
        eq(docs.page?.kind, 'home', 'the last tab closed: Home is shown');
        eq(ids().length, 1);
        eq(shown(), docs.page!.id);
        session.dispose();
    });

    test('Home stays when it is the last tab; with Home switched off the empty document takes its place', () => {
        const on = setup(true);
        on.docs.openHome();
        on.docs.closeById(on.docs.page!.id);
        eq(on.docs.page?.kind, 'home', 'Home is the last tab and stays');
        on.session.dispose();
        const off = setup(false);
        off.docs.openHome();
        off.docs.closeById(off.docs.page!.id);
        eq([off.docs.page, off.ids()], [null, [off.docs.active.id]], 'the empty document is a tab again');
        off.session.dispose();
    });

    test('a page closes without asking; a changed document is still asked about', async () => {
        const { session, docs } = setup();
        docs.openInTab(a);
        docs.openHtml(page, dir);
        eq(await docs.closeById(docs.page!.id), true);
        eq(docs.allPages.length, 0);
        session.dispose();
    });

    test('switching to the next tab goes through documents and pages alike', () => {
        const { session, docs, ids, shown } = setup();
        docs.openInTab(a);
        docs.openHtml(page, dir);
        const [docId, pageId] = ids();
        docs.switchTab(1);
        eq(shown(), docId, 'wraps around');
        docs.switchTab(1);
        eq(shown(), pageId);
        session.dispose();
    });

    test('the next launch gets back the file tabs and Home, not an HTML page', () => {
        const { session, settings, docs } = setup();
        docs.openHome();
        docs.openInTab(a);
        docs.openHtml(page, dir);
        docs.openInTab(b);
        docs.rememberTabs();
        eq(settings.tabs.map(t => t.file), ['markwork:home', a, b], 'order of the tab row');
        eq(settings.activeTab, 2, 'the shown document');
        session.dispose();

        const next = setup();
        next.settings.tabs = settings.tabs;
        next.settings.activeTab = settings.activeTab;
        eq(next.docs.restoreTabs(), true);
        eq([next.docs.all.map(d => d.file), next.docs.allPages.map(p => p.kind), next.docs.active.file], [[a, b], ['home'], b]);
        next.session.dispose();
    });

    test('Home can be the tab that is brought back as shown', () => {
        const { session, settings, docs } = setup();
        docs.openInTab(a);
        docs.openHome();
        docs.rememberTabs();
        eq(settings.activeTab, 1);
        session.dispose();
        const next = setup();
        next.settings.tabs = settings.tabs;
        next.settings.activeTab = settings.activeTab;
        next.docs.restoreTabs();
        eq(next.docs.page?.kind, 'home');
        next.session.dispose();
    });

    test('switching the work folder closes the HTML pages that are outside it', async () => {
        const { session, docs } = setup();
        const inside = disk.join(tmp, 'pagetabs-other');
        disk.mkdirs(inside);
        docs.openHtml(page, dir);
        eq(await docs.closeOutside(inside), true);
        eq(docs.allPages.map(p => p.kind), ['home'], 'the page is gone; the last tab gave way to Home');
        session.dispose();
    });

    test('the title of a page is a page title; Home is named by the work folder', () => {
        const settings = memorySettings();
        const titles: Record<number, { name: string; page: boolean; place: string | null }> = {};
        const base = fakeFrontend(settings, []);
        const session = new AppSession({ ...base, documents: quiet<typeof base.documents>({ ...tabRow(), setTitle: (id, t) => { titles[id] = t; } }) });
        session.start();
        session.documents.openHtml(page, dir);
        const id = session.documents.page!.id;
        eq([titles[id].name, titles[id].page], ['report.html', true]);
        ok(titles[id].place !== null, 'a page has a place');
        session.documents.openHome();
        const home = session.documents.page!.id;
        eq([titles[home].name, titles[home].page], ['Home', true]);
        session.dispose();
    });
}
