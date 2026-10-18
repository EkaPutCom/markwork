// The main window: composes the components and connects the callbacks between components. The open
// documents (tabs, open/save, the Home tab) are kept by window/documents.ts; the window shows them.
//
//   ┌ HeaderBar ─────────────────────────────────────┐
//   │ Sidebar   │ TabBar (if ≥ 2 documents)          │
//   │ ┌Files┬Outline┬History┐ FindBar               │
//   │ FileTree / Outline / History │ MarkdownView    │
//   │           │ StatusBar                          │
//   └───────────┴────────────────────────────────────┘
//
// Each document has its own MarkdownView (undo, cursor, and scroll are preserved when switching
// tabs); the other components (outline, status, search, kanban board) follow the active document.
// Features that span components (journal, harness runs, Home, agent writes, autosave) are controllers in
// window/*; they see the window only through the host built in makeHost().

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';

import { APP_ID, APP_NAME } from './config.js';
import { addBundledIcons, after, type Awaitable } from './gtkutil.js';
import { type AppSettings } from './settings.js';
import { MarkdownView, type Mode } from './editor/view.js';
import { Outline } from './ui/outline.js';
import { CollabPanel } from './ui/collab.js';
import { PullView } from './ui/pullview.js';
import { History } from './ui/history.js';
import { HistoryViewers } from './ui/historyviewer.js';
import { askDiscard } from './ui/discard.js';
import { FileTree } from './ui/filetree.js';
import { Sidebar } from './ui/sidebar.js';
import { SearchPanel } from './ui/searchpanel.js';
import { ChatPanel } from './ui/chat.js';
import { WorkspaceRepository } from './workspace.js';
import type { WikiLink } from './markdown/wikilink.js';
import { FindBar } from './ui/findbar.js';
import { StatusBar } from './ui/statusbar.js';
import { TabBar } from './ui/tabbar.js';
import { HeaderBar, LAYOUT_CHOICES } from './ui/headerbar.js';
import type { Palette } from './colors.js';
import { applyTheme, systemPrefersDark } from './ui/theme.js';
import { askSaveChanges, chooseFile, closeAgentsDialog, confirmDialog, confirmOpenLink, decideDialog, harnessAskDialog, harnessTextDialog, machineDialog, mergeDialog, promptDialog, showAbout, showError } from './ui/dialogs.js';
import { registerActions } from './actions.js';
import type { CommandHost, EditCommands, FrontendCommands, ViewOption } from './app/commands.js';
import { wrapSelection, insertLink, insertBlock, togglePrefix, setHeading } from './editor/editing.js';
import { PreferencesPresenter } from './ui/preferences.js';
import { CommandPalette } from './ui/palette.js';
import { showShortcuts } from './ui/shortcuts.js';
import { HtmlPage } from './ui/htmlpage.js';
import { ImageViewer } from './ui/imageviewer.js';
import { KanbanBoard } from './ui/kanban.js';
import { InboxView } from './ui/inbox.js';
import { TableView } from './ui/table.js';
import { CsvView } from './ui/csvpage.js';
import { CalendarView } from './ui/calendar.js';
import { TimelineView } from './ui/timeline.js';
import { GalleryView } from './ui/gallery.js';
import { ChartView } from './ui/chart.js';
import type { StructuredView } from './ui/structured.js';
import { HomeView } from './ui/home.js';
import { _, fmt } from './i18n.js';
import type { Doc } from './window/doc.js';
import type { PullReviewController } from './app/pulls.js';
import type { CollabController } from './app/collab.js';
import type { ContributeController } from './app/contribute.js';
import type { JournalController } from './app/journal.js';
import type { HarnessController } from './app/harness.js';
import { HarnessLogWindows } from './window/harnesslogs.js';
import type { HarnessReviewController } from './app/harnessreview.js';
import { HarnessReviewView } from './ui/harnessreview.js';
import type { HomeController } from './app/home.js';
import type { ViewScreen } from './app/views.js';
import { editSchemaDialog } from './ui/schemadialog.js';
import type { Page, ToastButton } from './app/document.js';
import { HOME, UNTITLED, type DocumentController } from './app/documents.js';
import { AppSession, type AppDialogs, type AppFrontend, type DocumentTitle, type FrontendHost } from './app/session.js';
import { gsettingsOf } from './platform/gjs/settings.js';
import { pullRequestDialog } from './ui/pullrequestdialog.js';
import { sendChangesDialog } from './ui/sendchanges.js';
import { tokenDialog } from './ui/serverdialog.js';

// The saved window size may be larger than the screen (for example after moving
// to a smaller monitor); limit it to the monitor size. GTK 4 no longer gives the general
// work area (without panels), so the size of the first monitor is used.
function fitToScreen(width: number, height: number): [number, number] {
    const monitor = Gdk.Display.get_default()?.get_monitors().get_item(0) as Gdk.Monitor | null;
    if (!monitor) return [width, height];
    const area = monitor.get_geometry();
    return [Math.min(width, area.width), Math.min(height, area.height)];
}
const MODE_LABELS: Record<Mode, string> = { source: _('Source'), focus: _('Focus'), typewriter: _('Typewriter') };

export class MainWindow {
    readonly app: Adw.Application;
    readonly settings: AppSettings;
    readonly outline: Outline;
    readonly history: History;
    readonly historyViewers = new HistoryViewers(() => this.win, () => this.dark);
    readonly fileTree: FileTree;
    readonly sidebar: Sidebar;
    readonly searchPanel: SearchPanel;
    readonly preferences: PreferencesPresenter;
    readonly findBar: FindBar;
    // The last notification text (for tests; the toast itself disappears on its own).
    lastToast = '';
    lastToastAction: ToastButton | null = null;
    private readonly toasts = new Adw.ToastOverlay();
    readonly statusBar: StatusBar;
    readonly tabBar: TabBar;
    readonly board: KanbanBoard;
    readonly inbox: InboxView;
    readonly table: TableView;
    readonly csv: CsvView;
    readonly gallery: GalleryView;
    readonly layouts: Record<'calendar' | 'timeline' | 'gallery' | 'chart', StructuredView>;
    readonly home: HomeView;
    readonly journal: JournalController;
    readonly collab: CollabController;
    readonly collabPanel: CollabPanel;
    readonly pullView: PullView;
    readonly pulls: PullReviewController;
    readonly contribute: ContributeController;
    readonly harness: HarnessController;
    readonly harnessLogs = new HarnessLogWindows(() => this.win);
    readonly reviewView: HarnessReviewView;
    readonly review: HarnessReviewController;
    readonly homePage: HomeController;
    // The application layer: the controllers and what ties them together (app/session.ts); this class is its GTK frontend.
    readonly session: AppSession<MarkdownView>;
    private closing = false;   // closing the window has been confirmed through a dialog
    readonly chat: ChatPanel;
    readonly chatSplit: Adw.OverlaySplitView;
    private readonly content: Gtk.Stack;
    readonly header: HeaderBar;
    readonly win: Adw.ApplicationWindow;

    readonly documents: DocumentController<MarkdownView>;
    readonly workspace: WorkspaceRepository;
    // What the commands run on (actions.ts): the session's part, and this window's (FrontendCommands).
    readonly commands: CommandHost;
    // The edits the commands make to the active document's text (FrontendCommands).
    readonly edit: EditCommands = {
        undo: () => this.editor.buffer.undo(),
        redo: () => this.editor.buffer.redo(),
        wrap: marker => wrapSelection(this.editor.buffer, marker),
        link: () => insertLink(this.editor.buffer),
        block: (before, after) => insertBlock(this.editor.buffer, before, after),
        prefix: (pattern, text) => togglePrefix(this.editor.buffer, pattern, text),
        heading: level => setHeading(this.editor.buffer, level),
        table: operation => this.editor.tableCommand(operation),
        zoomImage: () => this.editor.zoomImage(),
    };
    private palette: Palette | null = null;
    dark: boolean;
    private colorScheme: boolean | null = null;   // the last choice applied by setDark (null = follow the system)

    // path: the file or folder to open when the window appears.
    constructor(app: Adw.Application, settings: AppSettings, path: string | null = null) {
        this.app = app;
        this.settings = settings;
        this.dark = settings.dark ?? systemPrefersDark();

        // Components
        this.content = new Gtk.Stack({ vexpand: true, hexpand: true, hhomogeneous: false });
        this.tabBar = new TabBar();
        this.outline = new Outline();
        this.history = new History();
        this.fileTree = new FileTree();
        this.collabPanel = new CollabPanel();
        this.pullView = new PullView();
        this.reviewView = new HarnessReviewView();
        this.searchPanel = new SearchPanel();
        this.preferences = new PreferencesPresenter(() => this.win, () => this.session.preferences.closed());
        this.sidebar = new Sidebar(this.fileTree.widget, this.searchPanel.widget, this.outline.widget, this.history.widget, this.collabPanel.widget);
        this.statusBar = new StatusBar();
        this.board = new KanbanBoard();
        this.inbox = new InboxView();
        this.table = new TableView();
        this.csv = new CsvView();
        this.gallery = new GalleryView();
        this.layouts = { calendar: new CalendarView(), timeline: new TimelineView(), gallery: this.gallery, chart: new ChartView() };
        this.home = new HomeView();
        this.chat = new ChatPanel();
        this.header = new HeaderBar();

        // The application layer: its controllers are created before the first document, whose buffer already queues autosaves.
        this.session = new AppSession<MarkdownView>({ settings, createEditor: id => this.createEditor(id), host: this.frontendHost(), documents: this.documentsHost(), dialogs: this.appDialogs() });
        const session = this.session;
        ({ journal: this.journal, collab: this.collab, pulls: this.pulls, contribute: this.contribute, harness: this.harness,
            review: this.review, homePage: this.homePage, documents: this.documents, workspace: this.workspace } = session);
        session.start();
        this.commands = session.commands(this.frontendCommands());
        // The log window follows the live agent log; the review and log windows are transient for the main window.
        this.chat.window = () => this.win;
        this.doc.editor.modes.focus = settings.focus;
        this.doc.editor.modes.typewriter = settings.typewriter;
        this.findBar = new FindBar(this.doc.editor.buffer, this.doc.editor.view);

        // The components do not know each other; the window is what connects them.
        this.inbox.onOpenNote = link => this.openNote(link);
        this.inbox.listNotes = () => this.session.notes.namesFor(this.doc.id);
        this.table.onOpenNote = link => this.openNote(link);
        this.table.listNotes = () => this.session.notes.namesFor(this.doc.id);
        for (const view of Object.values(this.layouts)) {
            view.onOpenNote = link => this.openNote(link);
            view.listNotes = () => this.session.notes.namesFor(this.doc.id);
        }
        this.gallery.baseDir = () => this.session.folderOf(this.doc.id);
        this.home.onOpenFile = path => this.openInTab(path);
        this.home.onOpenTask = task => this.homePage.openWorkspaceFile(task.file);
        this.home.onToggleTask = (task, done) => this.homePage.toggleTask(task, done);
        this.home.onOpenInbox = file => this.homePage.openWorkspaceFile(file);
        this.home.onOpenRun = id => this.harness.open(id);
        this.home.onOpenFolder = () => void this.chooseFolder();
        this.home.onNewDocument = () => this.newDocument();
        this.home.onOpenJournal = () => this.journal.open();
        this.home.onCaptureJournal = () => this.journal.capture();
        this.board.onOpenNote = link => this.openNote(link);
        this.board.listNotes = () => this.session.notes.namesFor(this.doc.id);
        this.tabBar.onSelect = id => this.documents.select(id);
        this.tabBar.onClose = id => { void this.documents.closeById(id); };
        // The "no API key" link of a commit form opens the Assistant's settings.
        this.history.writer.onOpenSettings = () => this.openChatSettings();
        this.historyViewers.onOpenSettings = () => this.openChatSettings();
        this.sidebar.onPageChanged = page => {
            this.settings.sidebarPage = page;
            this.reportSidebar();
        };

        // Layout
        const [width, height] = fitToScreen(settings.width, settings.height);
        this.win = new Adw.ApplicationWindow({ application: app, default_width: width, default_height: height });
        addBundledIcons(this.win.get_display());
        this.csv.trackFocus(this.win);
        this.win.set_icon_name(APP_ID);
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        column.append(this.tabBar.widget);
        column.append(this.findBar);
        this.content.add_named(this.board.widget, 'board');
        this.content.add_named(this.inbox.widget, 'inbox');
        this.content.add_named(this.table.widget, 'table');
        this.content.add_named(this.csv.widget, 'csv');
        for (const [name, view] of Object.entries(this.layouts)) this.content.add_named(view.widget, name);
        this.content.add_named(this.home.widget, 'home');
        this.content.add_named(this.pullView.widget, 'pull');
        this.content.add_named(this.reviewView.widget, 'review');
        column.append(this.content);
        column.append(this.statusBar);
        // The Assistant panel on the right, a fixed width; the rest for the editor.
        this.chatSplit = new Adw.OverlaySplitView({
            sidebar_position: Gtk.PackType.END, sidebar: this.chat.widget, content: column,
            min_sidebar_width: 360, max_sidebar_width: 360, enable_show_gesture: false, enable_hide_gesture: false,
        });
        this.sidebar.setContent(this.chatSplit);
        const main = this.sidebar.widget;
        this.toasts.set_child(main);
        const toolbar = new Adw.ToolbarView({ content: this.toasts });
        toolbar.add_top_bar(this.header);
        this.win.set_content(toolbar);
        this.addBreakpoints();
        // true = hold the closing. If there are documents that need to be asked about, the window is held first and
        // closed again after all dialogs are answered with consent.
        this.win.connect('close-request', () => {
            if (this.closing) return false;
            const allowed = this.onClose();
            if (typeof allowed === 'boolean') return !allowed;
            void allowed.then(yes => {
                if (!yes) return;
                this.closing = true;
                this.win.close();
            });
            return true;
        });
        // The window is destroyed (closed, or destroy() in tests). GTK 4 does not emit "destroy"
        // for widgets still held by JavaScript, so the components' timers are stopped here.
        this.win.connect('unrealize', () => this.dispose());
        this.win.connect('notify::is-active', () => this.session.windowFocused(this.win.is_active));

        registerActions(app, this);
        this.setDark(settings.dark);
        // The system theme changed (GNOME Dark Style) while its setting is "follow system".
        Adw.StyleManager.get_default().connect('notify::dark', () => {
            if (this.settings.dark === null && Adw.StyleManager.get_default().dark !== this.dark) this.setDark(null);
        });
        // The system accent changed (libadwaita ≥ 1.6): recolor the text tags; older libadwaita has no such property.
        if (GObject.Object.find_property.call(Adw.StyleManager, 'accent-color'))
            Adw.StyleManager.get_default().connect('notify::accent-color', () => this.setDark(this.colorScheme));
        settings.onChanged(null, key => this.onSettingChanged(key));
        // Panel visibility follows GSettings in both directions; side effects are installed on widget changes.
        this.bindPanel('sidebar', this.sidebar.widget);
        this.bindPanel('chat', this.chatSplit);
        this.sidebar.widget.connect('notify::show-sidebar', () => this.reportSidebar());
        this.chatSplit.connect('notify::show-sidebar', () => {
            if (!this.chatSplit.show_sidebar) return;
            this.chat.updateContextSummary();
            this.chat.focusInput();
        });
        this.tabBar.setActive(this.doc.id);

        // Initial contents (AppSession.open): a path on the command line means the user asked for specific contents.
        this.sidebar.setPage(settings.sidebarPage);
        this.reportSidebar();
        session.open(path);
        this.win.present();
        this.editor.view.grab_focus();
    }

    // The side panel's page while it is open, for what the session reads only while it is shown (the history).
    private reportSidebar(): void {
        this.session.sidebarShown(this.sidebar.visible ? this.sidebar.page : null);
    }

    // The commands this window carries out alone: the editor's edits and its own windows.
    private frontendCommands(): FrontendCommands {
        return {
            edit: this.edit,
            openFind: replace => this.openFind(replace),
            showSearch: replace => this.showSearch(replace),
            setSource: on => { for (const doc of this.docs) doc.editor.setMode('source', on); },
            showPalette: () => this.showPalette(),
            showShortcuts: () => this.showShortcuts(),
            showAbout: () => this.showAbout(),
            quit: () => this.quit(),
        };
    }

    // A short notification that disappears on its own (Adw.Toast).
    toast(message: string, action?: ToastButton): void {
        this.lastToast = message;
        this.lastToastAction = action ?? null;
        const toast = new Adw.Toast({ title: message, timeout: action ? 8 : 3 });
        if (action) {
            toast.set_button_label(action.label);
            toast.connect('button-clicked', () => this.session.toastActivated(action.token));
        }
        this.toasts.add_toast(toast);
    }

    // What the application layer needs from the GTK widgets and the system (AppFrontend.host).
    private frontendHost(): FrontendHost<MarkdownView> {
        const w = this;
        return {
            screen: this.viewScreen(),
            get chatPanel() { return w.chat; },
            get historyTab() { return w.history; },
            get historyViewers() { return w.historyViewers; },
            get board() { return w.board; },
            get logs() { return w.harnessLogs; },
            get collabPanel() { return w.collabPanel; },
            get pullView() { return w.pullView; },
            get reviewView() { return w.reviewView; },
            get inbox() { return w.inbox; },
            get table() { return w.table; },
            get csv() { return w.csv; },
            get layouts() { return w.layouts; },
            get fileTree() { return w.fileTree; },
            get searchView() { return w.searchPanel; },
            get outlineView() { return w.outline; },
            get preferencesView() { return w.preferences; },
            toast: (message, action) => this.toast(message, action),
            showSidebar: page => {
                this.sidebar.setPage(page);
                this.settings.sidebar = true;
            },
            showImage: path => {
                try {
                    new ImageViewer(this.win, GdkPixbuf.Pixbuf.new_from_file(path), GLib.path_get_basename(path)).show();
                } catch {
                    void showError(this.win, fmt(_('Could not open image: {name}'), { name: GLib.path_get_basename(path) }));
                }
            },
            setRecent: paths => this.header.setRecent(paths),
            notify: (id, title, body) => {
                const notification = new Gio.Notification();
                notification.set_title(title);
                notification.set_body(body);
                this.app.send_notification(id, notification);
            },
            openUri: uri => this.launchUri(uri),
            showPull: () => { this.content.visible_child_name = 'pull'; },
            showReview: () => { this.content.visible_child_name = 'review'; },
            openFolder: path => new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) }).launch(this.win, null, null),
        };
    }

    // Hand a link to the system (its default browser or mail app); a toast says so when it cannot.
    private launchUri(uri: string): void {
        new Gtk.UriLauncher({ uri }).launch(this.win, null, (launcher, result) => {
            try {
                launcher!.launch_finish(result);
            } catch {
                this.toast(fmt(_('Cannot open {url}'), { url: uri }));
            }
        });
    }

    // The questions the application layer asks, as GTK dialogs (AppFrontend.dialogs).
    private appDialogs(): AppDialogs {
        return {
            preferences: {
                machine: taken => machineDialog(this.win, taken),
                removeWorktree: q => decideDialog(this.win, q.message, q.detail, q.accept, q.destructive),
            },
            search: {
                confirm: (message, detail, accept) => decideDialog(this.win, message, detail, accept),
            },
            files: {
                name: (title, label, value) => promptDialog(this.win, { title, label, value }),
                confirm: (message, detail) => confirmDialog(this.win, message, detail),
                error: message => void showError(this.win, message),
            },
            history: {
                // Asked over the window it came from: the History tab's main window, or the viewer.
                discard: (kind, path, viewer) => askDiscard(viewer === null ? this.win : this.historyViewers.get(viewer)?.window ?? this.win, kind, path),
            },
            journal: {
                capture: prompt => promptDialog(this.win, prompt),
            },
            collab: {
                token: (repo, hasToken, source) => tokenDialog(this.win, {
                    host: repo.host, repository: `${repo.owner}/${repo.repo}`, hasToken, source,
                    test: token => this.collab.dialogs.onTestToken(repo, token),
                }),
                onTestToken: async () => '',
            },
            pulls: {
                local: q => decideDialog(this.win, q.message, q.detail, q.accept, q.destructive),
                abort: q => decideDialog(this.win, q.message, q.detail, q.accept, q.destructive),
                merge: q => mergeDialog(this.win, q.message, q.detail),
            },
            contribute: { send: options => sendChangesDialog(this.win, options) },
            harness: {
                chooseFolder: title => chooseFile(this.win, { title, selectFolder: true }),
                answer: (ask, agent) => harnessAskDialog(this.win, ask, agent),
                text: options => harnessTextDialog(this.win, options),
                remoteFolder: prompt => promptDialog(this.win, prompt),
                closeAgents: activity => closeAgentsDialog(this.win, activity),
            },
            review: {
                merge: q => decideDialog(this.win, q.message, q.detail, q.accept, q.destructive),
                discard: q => decideDialog(this.win, q.message, q.detail, q.accept, q.destructive),
                pullRequest: options => pullRequestDialog(this.win, options),
            },
            views: { editSchema: options => editSchemaDialog(this.win, options) },
        };
    }

    // The content area and what is around it, as ViewController drives them (ViewScreen in app/views.ts).
    private viewScreen(): ViewScreen<MarkdownView> {
        const setState = (name: string, state: GLib.Variant) => {
            const action = this.app.lookup_action(name);
            if (action instanceof Gio.SimpleAction) action.set_state(state);
        };
        return {
            showHome: data => {
                this.content.visible_child_name = 'home';
                this.home.render(data);
            },
            showPageTab: id => { this.content.visible_child_name = `page-${id}`; },
            showText: id => {
                const editor = this.editors.get(id);
                if (!editor) return;
                this.content.visible_child_name = `doc-${id}`;
                editor.updateCursor(true);
                editor.view.grab_focus();
            },
            showPage: page => { this.content.visible_child_name = page; },
            closeFind: () => this.findBar.close(),
            setStatusVisible: visible => this.statusBar.set_visible(visible),
            setCounts: text => this.statusBar.setCounts(text),
            setBoardCounts: (lists, cards) => this.statusBar.setBoardCounts(lists, cards),
            setInboxCounts: items => this.statusBar.setInboxCounts(items),
            setCsvCounts: (rows, columns) => this.statusBar.setCsvCounts(rows, columns),
            showLayout: layout => {
                setState('layout', GLib.Variant.new_string(layout ?? ''));
                const choice = LAYOUT_CHOICES.find(c => c.target === (layout ?? ''))!;
                this.header.setLayoutButton(layout === null ? null : { label: choice.label(), icon: choice.icon });
            },
            setStructuredState: on => setState('kanban-view', GLib.Variant.new_boolean(on)),
            enableActions: (names, enabled) => {
                for (const name of names) {
                    const action = this.app.lookup_action(name);
                    if (action instanceof Gio.SimpleAction) action.set_enabled(enabled);
                }
            },
        };
    }

    // ---------- Active document ----------

    get editor(): MarkdownView {
        return this.doc.editor;
    }

    // The active document's path, null = never saved.
    // The work folder, as the Files tab shows it (app/files.ts).
    get root(): string | null {
        return this.session.files.root;
    }

    get file(): string | null {
        return this.doc.file;
    }

    set file(path: string | null) {
        this.documents.setFile(this.doc, path);
    }

    // The number of open tabs: documents and pages (the empty document that waits behind Home has none).
    get documentCount(): number {
        return this.tabBar.count;
    }

    // The active document and all open documents (kept by the document controller).
    private get doc(): Doc {
        return this.documents.active;
    }

    private get docs(): readonly Doc[] {
        return this.documents.all;
    }

    // What follows the documents on screen.
    private documentsHost(): AppFrontend<MarkdownView>['documents'] {
        return {
            dialogs: {
                askSaveChanges: name => askSaveChanges(this.win, name),
                showError: message => void showError(this.win, message),
                chooseFile: options => chooseFile(this.win, options),
            },
            attach: id => this.attach(id),
            detach: id => {
                const editor = this.editors.get(id);
                this.editors.delete(id);
                this.titles.delete(id);
                this.tabBar.remove(id);
                if (!editor) return;
                editor.destroy();
                this.content.remove(editor.widget);
            },
            listTab: (id, listed) => {
                if (!listed) {
                    this.tabBar.remove(id);
                    return;
                }
                this.tabBar.add(id, UNTITLED);
                this.showTitle(id);
            },
            activated: id => {
                const doc = this.docById(id);
                if (!doc) return;
                this.findBar.setTarget(doc.editor.buffer, doc.editor.view);
                this.tabBar.setActive(id);
                if (this.chatSplit.show_sidebar) this.chat.updateContextSummary();
            },
            attachPage: page => this.attachPage(page),
            detachPage: id => {
                this.titles.delete(id);
                this.tabBar.remove(id);
                const html = this.htmlPages.get(id);
                if (!html) return;
                this.htmlPages.delete(id);
                this.content.remove(html.widget);
                html.dispose();
            },
            pageActivated: id => {
                // What a page leaves behind is the last document: search and the Assistant keep pointing at it.
                this.findBar.setTarget(this.doc.editor.buffer, this.doc.editor.view);
                this.tabBar.setActive(id);
                if (this.chatSplit.show_sidebar) this.chat.updateContextSummary();
            },
            setTitle: (id, title) => {
                this.titles.set(id, title);
                this.showTitle(id);
            },
            tabOrder: () => this.tabBar.ids(),
        };
    }

    // The HTML pages that are open, by tab id; Home is one widget in the content area, shown by name.
    private readonly htmlPages = new Map<number, HtmlPage>();

    // A page: its tab, and its contents in the content area. The tab gets its title from the session.
    private attachPage(page: Page): void {
        if (page.kind === 'html') {
            const html = new HtmlPage(page.file!, page.root!, uri => {
                void confirmOpenLink(this.win, uri).then(yes => { if (yes) this.launchUri(uri); });
            });
            this.htmlPages.set(page.id, html);
            this.content.add_named(html.widget, `page-${page.id}`);
        }
        this.tabBar.add(page.id, page.kind === 'home' ? HOME : GLib.path_get_basename(page.file ?? ''));
        this.tabBar.setIcon(page.id, page.kind === 'home' ? 'user-home-symbolic' : 'web-browser-symbolic');
    }

    // The editors of the open documents by id: the application layer names a document by its id, and the widgets are found here.
    private readonly editors = new Map<number, MarkdownView>();

    private createEditor(id: number): MarkdownView {
        const editor = new MarkdownView();
        this.editors.set(id, editor);
        return editor;
    }

    private docById(id: number): Doc | undefined {
        return this.docs.find(d => d.id === id);
    }

    // Connect a new document's editor, and add its page and tab.
    private attach(id: number): void {
        const editor = this.editors.get(id)!;
        // Editor callbacks only apply while their document is active; background ones do not touch the outline and status bar.
        editor.onHighlighted = ({ words, characters }) => {
            const doc = this.docById(id);
            if (!doc || doc !== this.doc) return;
            this.session.headingsChanged(id);
            if (!this.session.views.structuredMode && !this.session.views.csvMode) this.statusBar.setDocumentCounts(words, characters);
        };
        editor.onCursorMoved = (line, column) => {
            if (id !== this.doc.id) return;
            if (!this.session.views.csvMode) this.statusBar.setCursor(line, column);   // the table shows no text cursor
            this.statusBar.setModes((Object.keys(MODE_LABELS) as Mode[]).filter(m => editor.modes[m]).map(m => MODE_LABELS[m]));
        };
        editor.onMessage = msg => this.toast(msg);
        editor.onViewImage = (pixbuf, title) => new ImageViewer(this.win, pixbuf, title).show();
        editor.getBaseDir = () => this.session.folderOf(id) ?? GLib.get_home_dir();
        editor.onOpenNote = link => { const doc = this.docById(id); if (doc) this.openNote(link, doc); };
        editor.onOpenLink = url => this.session.openLink(id, url);
        editor.listNotes = () => this.session.notes.namesFor(id);
        editor.buffer.connect('modified-changed', () => this.showTitle(id));
        editor.buffer.connect('changed', () => this.session.edited(id));

        // A new document inherits the mode and theme of the currently active document.
        if (this.docs.length) {
            for (const mode of Object.keys(MODE_LABELS) as Mode[]) if (this.doc.editor.modes[mode]) editor.setMode(mode, true);
        }
        if (this.palette) editor.setPalette(this.palette);
        this.content.add_named(editor.widget, `doc-${id}`);
        this.tabBar.add(id, UNTITLED);
    }

    // The tab after/before the active one (wraps around).
    switchTab(step: number): void {
        this.documents.switchTab(step);
    }

    // Close a tab (asks if there are changes). Closing the only tab empties its document.
    closeTab(doc?: Doc): Awaitable<boolean> {
        return this.documents.closeTab(doc);
    }

    // ---------- View settings ----------

    // gsettings.bind(key, split, 'show-sidebar') plus the behavior when the window narrows. Without a pin,
    // OverlaySplitView hides the panel when collapsing and always opens it again when widening, so a panel
    // that was closed on purpose opens as well. With a pin, this is handled here: collapsing closes the panel (the setting
    // becomes false too so the header button stays consistent), widening restores the setting from before collapsing.
    private readonly widePanels = new Map<'sidebar' | 'chat', boolean>();   // the panel settings before collapsing

    private bindPanel(key: 'sidebar' | 'chat', split: Adw.OverlaySplitView): void {
        const gs = gsettingsOf(this.settings);
        split.pin_sidebar = true;
        // A panel that takes editor width appears at once: sliding it re-wraps the text on every frame, one frame
        // behind the panel. Connected before the binding below, so animations are off when the binding opens the
        // panel (the animation checks this when it starts); a floating panel (collapsed) keeps its slide.
        gs.connect(`changed::${key}`, () => {
            const settings = Gtk.Settings.get_default();
            if (!settings || split.collapsed || !settings.gtk_enable_animations) return;
            settings.gtk_enable_animations = false;
            GLib.idle_add(GLib.PRIORITY_HIGH, () => { settings.gtk_enable_animations = true; return GLib.SOURCE_REMOVE; });
        });
        gs.bind(key, split, 'show-sidebar', Gio.SettingsBindFlags.DEFAULT);
        split.connect('notify::collapsed', () => {
            if (split.collapsed) {
                this.widePanels.set(key, gs.get_boolean(key));
                gs.set_boolean(key, false);
            } else if (this.widePanels.has(key)) {
                gs.set_boolean(key, this.widePanels.get(key)!);
                this.widePanels.delete(key);
            }
        });
    }

    // Adaptive layout (HIG): in a narrow window the side panels no longer take up editor width, but
    // float above it (OverlaySplitView collapsed) and close when the content is clicked. The Assistant panel
    // (360) collapses before the sidebar (240). A minimum window size is required for the breakpoints.
    private addBreakpoints(): void {
        this.win.set_size_request(360, 294);
        const narrow = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 900sp') });
        narrow.add_setter(this.chatSplit, 'collapsed', true);
        this.win.add_breakpoint(narrow);
        const phone = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 600sp') });
        phone.add_setter(this.chatSplit, 'collapsed', true);
        phone.add_setter(this.header, 'compact', true);
        phone.add_setter(this.sidebar.widget, 'collapsed', true);
        this.win.add_breakpoint(phone);
    }

    // dark null = follow the system theme.
    setDark(dark: boolean | null): void {
        const palette = applyTheme(dark);
        this.colorScheme = dark;
        this.dark = palette.dark;
        this.palette = palette;
        for (const doc of this.docs) doc.editor.setPalette(palette);
        this.board.setPalette(palette);
        this.inbox.setPalette(palette);
        this.table.setPalette(palette);
        for (const view of Object.values(this.layouts)) view.setPalette(palette);
        this.chat.setPalette(palette);
    }

    // ---------- [[note]] links ----------

    // Ctrl+click [[note]]: see NoteLinks.open.
    openNote(link: WikiLink, doc = this.doc): void {
        this.session.notes.open(link, doc);
    }

    // ---------- Views: text, board, inbox, Home ----------

    get boardMode(): boolean {
        return this.session.views.boardMode;
    }

    get inboxMode(): boolean {
        return this.session.views.inboxMode;
    }

    get tableMode(): boolean {
        return this.session.views.tableMode;
    }

    get csvMode(): boolean {
        return this.session.views.csvMode;
    }

    get homeMode(): boolean {
        return this.session.views.homeMode;
    }

    setBoardMode(on: boolean): void {
        this.session.views.show(on ? 'board' : 'text');
    }

    // Text editor actions are disabled while a board, inbox, or Home is shown.
    syncActionsEnabled(): void {
        this.session.views.syncActionsEnabled();
    }

    // The "Board View" menu/shortcut.
    toggleBoardView(on: boolean): void {
        this.session.views.toggle(on);
    }

    // The layout menu in the header bar.
    setLayout(layout: string): void {
        this.session.views.setLayout(layout);
    }

    // The "Fields…" menu for the board or list that is shown.
    sendChanges(): void {
        void this.contribute.start();
    }

    editFields(): void {
        this.session.views.editFields();
    }

    // A new document containing an empty kanban board.
    newBoardDocument(): void {
        this.session.views.newBoard();
    }

    // A new document containing an empty inbox.
    newInboxDocument(): void {
        this.session.views.newInbox();
    }

    // A new document containing an empty table.
    newTableDocument(): void {
        this.session.views.newTable();
    }

    // ---------- Home ----------

    // Alt+Home: switch to the Home tab, or open it if there is none (using the active empty tab if there is one).
    openHome(): void {
        this.documents.openHome();
    }

    // Redraw Home if it is shown; the data is recomputed from the files every time.
    refreshHome(): void {
        this.session.refreshHome();
    }

    private openChatSettings(): void {
        this.settings.chat = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.chat.openSettings(); return GLib.SOURCE_REMOVE; });
    }

    // Change a view option. All but source mode are settings the session writes; the sidebar and assistant are bound to
    // their keys (Gio.Settings.bind) and the rest is applied by onSettingChanged. The toggle actions in the menu
    // (Gio.Settings.create_action) use the same path.
    setOption(key: ViewOption, value: boolean): void {
        if (key === 'source') this.commands.setSource(value);
        else this.commands.setOption(key, value);
    }

    // GSettings changes (menu, preferences dialog, or another process) that need to be applied to the components.
    private onSettingChanged(key: string): void {
        const s = this.settings;
        if (key === 'color-scheme') {
            if (s.dark !== this.colorScheme) this.setDark(s.dark);
            const dark = this.app.lookup_action('dark');
            if (dark instanceof Gio.SimpleAction) dark.set_state(GLib.Variant.new_boolean(this.dark));
        } else if (key === 'focus' || key === 'typewriter') for (const doc of this.docs) doc.editor.setMode(key, s[key]);
    }

    // ---------- Auto save ----------

    // The active document unless given; see Autosaver.
    autosaveInBackground(doc: Doc = this.doc, done?: () => void): boolean {
        return this.session.autosaver.inBackground(doc, done);
    }

    autosave(doc: Doc = this.doc): boolean {
        return this.session.autosaver.now(doc);
    }

    // ---------- Documents ----------

    get documentName(): string {
        const page = this.documents.page;
        return page ? this.documents.nameOfPage(page) : this.documents.nameOf(this.doc);
    }

    // The HTML page that is shown, if one is (for tests).
    get shownHtml(): HtmlPage | null {
        const page = this.documents.page;
        return page ? this.htmlPages.get(page.id) ?? null : null;
    }

    // Suggested file name from the first heading.
    suggestName(): string {
        return this.documents.suggestName();
    }

    updateTitle(): void {
        this.session.refreshTitle(this.doc.id);
    }

    // The titles the session last sent, by document id; the mark for unsaved changes is added here, from the buffer.
    private readonly titles = new Map<number, DocumentTitle>();

    // Tab title for a document, and the window title if it is the active one.
    private showTitle(id: number): void {
        const title = this.titles.get(id), doc = this.docById(id);
        if (!title) return;
        const page = this.documents.page;
        if (title.page) {
            this.tabBar.setTitle(id, title.name, title.file);
            if (page?.id !== id) return;
            this.header.setTitle(title.name, title.place ?? APP_NAME);
            this.win.set_title(`${title.name} — ${APP_NAME}`);
            return;
        }
        if (!doc) return;
        const mark = doc.editor.buffer.get_modified() ? '• ' : '';
        this.tabBar.setTitle(id, `${mark}${title.name}`, title.file);
        if (doc !== this.doc || page) return;
        const where = title.place ?? APP_NAME;
        this.header.setTitle(`${mark}${title.name}`, title.file && !mark ? `${where} · ${_('Saved')}` : where, true);
        this.win.set_title(`${mark}${title.name} — ${APP_NAME}`);
    }

    // If there are changes, ask first. true = it is fine to go on and discard this document.
    confirmDiscard(doc: Doc = this.doc): Awaitable<boolean> {
        return this.documents.confirmDiscard(doc);
    }

    // Ctrl+N: an empty document in a new tab.
    newDocument(): void {
        this.documents.reset(this.documents.blank());
    }

    // Open a file in the active document, replacing its contents (a folder opens in the Files tab).
    load(path: string): boolean {
        return this.documents.load(path);
    }

    // Open a file in a tab: its own tab if already open, the active empty document, or a new tab.
    openInTab(path: string): boolean {
        return this.documents.openInTab(path);
    }

    // Ctrl+Shift+F: show the Search panel with the selected text as the query.
    showSearch(withReplace = false): void {
        this.settings.sidebar = true;
        this.sidebar.setPage('search');
        const [has, s, e] = this.editor.buffer.get_selection_bounds();
        this.searchPanel.focus(has ? this.editor.buffer.get_text(s, e, false) : '', withReplace);
    }

    // Open the file chosen in the file tree.
    openFile(path: string): void {
        this.session.host.openFile(path);
    }

    chooseFolder(): Promise<void> {
        return this.commands.chooseFolder();
    }

    // Show a folder in the Files tab (AppSession.openFolder).
    openFolder(path: string, show = true): void {
        void this.session.openFolder(path, show);
    }

    open(): Promise<void> {
        return this.commands.open();
    }

    // A file document is saved instantly (a boolean result); a new document waits for the Save As dialog.
    save(): Awaitable<boolean> {
        return this.documents.save();
    }

    saveAs(): Promise<boolean> {
        return this.documents.saveAs();
    }

    exportHtml(): Promise<void> {
        return this.documents.exportHtml();
    }

    insertImage(): Promise<void> {
        return this.documents.insertImage();
    }

    // true = the window may be closed. Every changed document is asked about one by one.
    onClose(): Awaitable<boolean> {
        return after(this.session.closeRequest(), yes => yes && this.rememberWindow());
    }

    private rememberWindow(): true {
        // Closed while narrow: save the panel settings for the wide layout, not the collapsed state.
        for (const [key, value] of this.widePanels) this.settings.store.set(key, value);
        // In GTK 4 the default size follows the current window size.
        const [width, height] = this.win.get_default_size();
        Object.assign(this.settings, { width, height });
        return true;
    }

    // ---------- Commands (CommandHost) ----------

    openFind(withReplace = false): void {
        if (this.session.views.csvMode) this.csv.openFind(withReplace);   // the table finds and replaces in its cells
        else this.findBar.open(withReplace);
    }

    showPreferences(): void {
        this.session.preferences.open();
    }

    showPalette(): void {
        new CommandPalette(this.app).present(this.win);
    }

    showShortcuts(): void {
        showShortcuts(this.app, this.win);
    }

    showAbout(): void {
        showAbout(this.win);
    }

    quit(): void {
        this.win.close();
    }

    // Stop the timers and idles of all components after the window is destroyed.
    private dispose(): void {
        for (const doc of this.docs) doc.editor.destroy();
        for (const html of this.htmlPages.values()) html.dispose();
        this.htmlPages.clear();
        this.session.dispose();
        this.chat.destroy();
        this.history.destroy();
        this.historyViewers.destroy();
        this.fileTree.destroy();
    }
}
