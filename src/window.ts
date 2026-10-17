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
import { fileExists } from './files.js';
import { WELCOME } from './welcome.js';
import { MarkdownView, type Mode } from './editor/view.js';
import { Outline } from './ui/outline.js';
import { CollabPanel } from './ui/collab.js';
import { PullView } from './ui/pullview.js';
import { History } from './ui/history.js';
import { HistoryViewers } from './ui/historyviewer.js';
import { askDiscard } from './ui/discard.js';
import { FileTree } from './ui/filetree.js';
import { isImageFile } from './app/files.js';
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
import { askSaveChanges, chooseFile, closeAgentsDialog, confirmDialog, decideDialog, harnessAskDialog, harnessTextDialog, machineDialog, mergeDialog, promptDialog, showAbout, showError } from './ui/dialogs.js';
import { registerActions } from './actions.js';
import type { CommandHost, EditCommands, ViewOption } from './app/commands.js';
import { wrapSelection, insertLink, insertBlock, togglePrefix, setHeading } from './editor/editing.js';
import { PreferencesPresenter } from './ui/preferences.js';
import { CommandPalette } from './ui/palette.js';
import { showShortcuts } from './ui/shortcuts.js';
import { ImageViewer } from './ui/imageviewer.js';
import { KanbanBoard } from './ui/kanban.js';
import { InboxView } from './ui/inbox.js';
import { TableView } from './ui/table.js';
import { CalendarView } from './ui/calendar.js';
import { TimelineView } from './ui/timeline.js';
import { GalleryView } from './ui/gallery.js';
import { ChartView } from './ui/chart.js';
import type { StructuredView } from './ui/structured.js';
import { HomeView } from './ui/home.js';
import { _, fmt } from './i18n.js';
import type { Doc } from './window/doc.js';
import { mergeMethodName, type PullReviewController } from './app/pulls.js';
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
import type { ToastButton } from './app/document.js';
import { UNTITLED, type DocumentController } from './app/documents.js';
import { AppSession, type AppDialogs, type AppFrontend, type FrontendHost } from './app/session.js';
import { gsettingsOf } from './platform/gjs/settings.js';
import { sendChangesDialog } from './ui/sendchanges.js';
import { tokenDialog } from './ui/serverdialog.js';

const isFolder = (path: string): boolean => GLib.file_test(path, GLib.FileTest.IS_DIR);

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

export class MainWindow implements CommandHost {
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
    // The edits the commands make to the active document's text (CommandHost).
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
        this.gallery.baseDir = () => (this.doc.file ? GLib.path_get_dirname(this.doc.file) : null);
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
        this.board.harness = {
            status: card => this.harness.status(card),
            menu: (card, at) => this.harness.menu(card, at),
            runMenu: token => this.harness.runMenu(token),
        };
        this.tabBar.onSelect = id => {
            const doc = this.docs.find(d => d.id === id);
            if (doc) this.activate(doc);
        };
        this.tabBar.onClose = id => {
            const doc = this.docs.find(d => d.id === id);
            if (doc) this.closeTab(doc);
        };
        // The "no API key" link of a commit form opens the Assistant's settings.
        this.history.writer.onOpenSettings = () => this.openChatSettings();
        this.historyViewers.onOpenSettings = () => this.openChatSettings();
        this.sidebar.onPageChanged = page => {
            this.settings.sidebarPage = page;
            this.syncHistory();
        };

        // Layout
        const [width, height] = fitToScreen(settings.width, settings.height);
        this.win = new Adw.ApplicationWindow({ application: app, default_width: width, default_height: height });
        addBundledIcons(this.win.get_display());
        this.win.set_icon_name(APP_ID);
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        column.append(this.tabBar.widget);
        column.append(this.findBar);
        this.content.add_named(this.board.widget, 'board');
        this.content.add_named(this.inbox.widget, 'inbox');
        this.content.add_named(this.table.widget, 'table');
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
        // New commits are usually made outside the app; when returning to the window, reload the history.
        this.win.connect('notify::is-active', () => {
            if (!this.win.is_active) return;
            this.syncHistory(true);
            this.refreshHome();   // files may change outside the app (git pull, agent, another editor)
        });

        registerActions(app, this);
        this.refreshRecent();
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
        this.sidebar.widget.connect('notify::show-sidebar', () => this.syncHistory());
        this.chatSplit.connect('notify::show-sidebar', () => {
            if (!this.chatSplit.show_sidebar) return;
            this.chat.updateContextSummary();
            this.chat.focusInput();
        });
        this.tabBar.setActive(this.doc.id);

        // Initial contents: the folder from the argument, or the last folder; then the file, or the last tabs
        // if opened without an argument (a path on the command line means the user asked for specific contents).
        this.sidebar.setPage(settings.sidebarPage);
        if (path && isFolder(path)) this.openFolder(path);
        else if (settings.folder && isFolder(settings.folder)) this.openFolder(settings.folder, false);
        if (path && !isFolder(path)) {
            this.load(path);
        } else if (!path && this.documents.restoreTabs()) {
            // the last tabs are restored
        } else if (!settings.welcomed) {
            this.editor.setText(WELCOME);
            settings.welcomed = true;
        } else if (settings.home) {
            this.openHome();
        } else {
            this.editor.setText('');
        }
        this.session.views.sync();
        this.updateTitle();
        this.win.present();
        this.syncHistory();
        this.editor.view.grab_focus();
        // Agents that kept working while Markwork was closed are found again once the window is up.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.harness.reconnect(); return GLib.SOURCE_REMOVE; });
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
            get layouts() { return w.layouts; },
            get fileTree() { return w.fileTree; },
            get searchView() { return w.searchPanel; },
            get outlineView() { return w.outline; },
            get preferencesView() { return w.preferences; },
            openFile: path => this.openFile(path),
            toast: (message, action) => this.toast(message, action),
            refreshTree: () => { if (this.root) this.session.files.refresh(this.root); },
            filesMoved: () => { this.fileTree.reveal(this.file); this.syncHistory(true); },
            projectName: path => this.projectName(path),
            isActive: () => this.win.is_active,
            notify: (id, title, body) => {
                const notification = new Gio.Notification();
                notification.set_title(title);
                notification.set_body(body);
                this.app.send_notification(id, notification);
            },
            openUri: uri => Gio.AppInfo.launch_default_for_uri(uri, null),
            showPull: () => { this.content.visible_child_name = 'pull'; },
            showReview: () => { this.content.visible_child_name = 'review'; },
            openFolder: path => new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) }).launch(this.win, null, null),
        };
    }

    // The questions the application layer asks, as GTK dialogs (AppFrontend.dialogs).
    private appDialogs(): AppDialogs {
        return {
            preferences: {
                machine: taken => machineDialog(this.win, taken),
                removeWorktree: branch => decideDialog(this.win, fmt(_('Remove the worktree of {branch}?'), { branch }),
                    _('Its folder and its branch are deleted, with every change in them that was not merged. The project folder is not touched.'), _('Remove'), true),
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
                capture: () => promptDialog(this.win, { title: _('Add to Journal'), label: _('Recorded in today\'s journal with the current time.'), accept: _('Add') }),
            },
            collab: {
                token: (repo, hasToken, source) => tokenDialog(this.win, {
                    host: repo.host, repository: `${repo.owner}/${repo.repo}`, hasToken, source,
                    test: token => this.collab.dialogs.onTestToken(repo, token),
                }),
                onTestToken: async () => '',
            },
            pulls: {
                local: pull => decideDialog(this.win, fmt(_('Merge pull request #{number} in this folder?'), { number: pull.number }),
                    fmt(_('Markwork will merge it into your {base}. Files that conflict get conflict markers; you edit them in their tabs and then finish, which pushes the result to the server. “Abort merge” undoes it.'), { base: pull.baseRef }), _('Merge Here')),
                abort: pull => decideDialog(this.win, fmt(_('Undo the merge of pull request #{number}?'), { number: pull.number }),
                    _('The folder goes back to what it was before. Your edits to the conflicting files are lost.'), _('Undo the Merge'), true),
                merge: (pull, method) => mergeDialog(this.win, fmt(_('Merge pull request #{number}?'), { number: pull.number }),
                    fmt(_('“{title}” will be merged into {base} on the server with “{method}”. Everybody who uses this repository sees it.'), { title: pull.title, base: pull.baseRef, method: mergeMethodName(method) })),
            },
            contribute: { send: options => sendChangesDialog(this.win, options) },
            harness: {
                chooseFolder: title => chooseFile(this.win, { title, selectFolder: true }),
                answer: (ask, agent) => harnessAskDialog(this.win, ask, agent),
                text: options => harnessTextDialog(this.win, options),
                remoteFolder: (machine, project, current) => promptDialog(this.win, {
                    title: project ? fmt(_('Project folder “{name}”'), { name: project }) : _('Choose a project folder'),
                    label: fmt(_('The folder of the project on {machine} (an absolute path):'), { machine }), value: current, accept: _('Save'),
                }),
                closeAgents: activity => closeAgentsDialog(this.win, activity),
            },
            review: {
                merge: (title, base, method, partial) => decideDialog(this.win, fmt(_('Merge “{title}” into {base}?'), { title, base }),
                    [method === 'squash' || partial ? _('Everything becomes one commit on the base branch of the project folder.') : _('A merge commit joins the branch to the base branch of the project folder.'), partial, _('The worktree is removed afterwards.')].filter(Boolean).join(' '), _('Merge')),
                discard: (title, branch) => decideDialog(this.win, fmt(_('Discard the Work on “{title}”?'), { title }),
                    fmt(_('The worktree and the branch {branch} are deleted, with every change in them. The project folder is not touched.'), { branch }), _('Discard'), true),
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
            page: () => this.content.visible_child_name,
            showHome: data => {
                this.content.visible_child_name = 'home';
                this.home.render(data);
            },
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

    // The number of open documents (tabs).
    get documentCount(): number {
        return this.docs.length;
    }

    // The active document and all open documents (kept by the document controller).
    private get doc(): Doc {
        return this.documents.active;
    }

    private get docs(): readonly Doc[] {
        return this.documents.all;
    }

    private activate(doc: Doc): void {
        this.documents.activate(doc);
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
                this.tabBar.remove(id);
                if (!editor) return;
                editor.destroy();
                this.content.remove(editor.widget);
            },
            activated: id => {
                const doc = this.docById(id);
                if (!doc) return;
                this.findBar.setTarget(doc.editor.buffer, doc.editor.view);
                this.tabBar.setActive(id);
                this.session.outline.show(doc);
                this.session.views.sync();
                this.updateTitle();
                this.fileTree.reveal(doc.file);
                this.syncHistory();
                if (this.chatSplit.show_sidebar) this.chat.updateContextSummary();
            },
            contentChanged: id => {
                const doc = this.docById(id);
                if (!doc) return;
                this.session.views.replaced(doc);
                this.updateTitle();
                this.fileTree.reveal(doc.file);
                if (!doc.home) this.syncHistory();
            },
            refreshTitle: id => { const doc = this.docById(id); if (doc) this.refreshTitle(doc); },
            setIcon: (id, icon) => this.tabBar.setIcon(id, icon),
            tabOrder: () => this.tabBar.ids(),
            openFolder: path => this.openFolder(path),
            fileSaved: path => {
                // Show the new file in the tree without waiting for the disk monitor.
                this.session.files.refresh(GLib.path_get_dirname(path));
                this.session.files.reveal(path);
                this.syncHistory();
            },
        };
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
            this.session.outline.changed(doc);
            if (!this.session.views.structuredMode) this.statusBar.setDocumentCounts(words, characters);
        };
        editor.onCursorMoved = (line, column) => {
            if (id !== this.doc.id) return;
            this.statusBar.setCursor(line, column);
            this.statusBar.setModes((Object.keys(MODE_LABELS) as Mode[]).filter(m => editor.modes[m]).map(m => MODE_LABELS[m]));
        };
        editor.onMessage = msg => this.toast(msg);
        editor.onViewImage = (pixbuf, title) => new ImageViewer(this.win, pixbuf, title).show();
        editor.getBaseDir = () => { const file = this.docById(id)?.file; return file ? GLib.path_get_dirname(file) : GLib.get_home_dir(); };
        editor.onOpenNote = link => { const doc = this.docById(id); if (doc) this.openNote(link, doc); };
        editor.onOpenDocument = path => this.openInTab(path);
        editor.listNotes = () => this.session.notes.namesFor(id);
        editor.buffer.connect('modified-changed', () => { const doc = this.docById(id); if (doc) this.refreshTitle(doc); });
        // Text changed while the board is shown and not by the board itself (undo/redo): re-read.
        editor.buffer.connect('changed', () => {
            const doc = this.docById(id);
            if (!doc) return;
            this.session.views.queueReload(doc);
            this.session.autosaver.edited(doc);
        });

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
    closeTab(doc: Doc = this.doc): Awaitable<boolean> {
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

    // ---------- Assistant ----------

    // File name relative to the project folder (the same as the name in workspace.ts); null if outside the folder or not saved.
    private projectName(path: string | null): string | null {
        const root = this.root;
        return path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path ? GLib.path_get_basename(path) : null;
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

    // ---------- Git history ----------

    private openChatSettings(): void {
        this.settings.chat = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.chat.openSettings(); return GLib.SOURCE_REMOVE; });
    }

    // History is only loaded while its tab is visible, so git is not called needlessly (app/history.ts runs it).
    // force = re-read even for the same file.
    syncHistory(force = false): void {
        if (!this.sidebar.visible || this.sidebar.page !== 'history') return;
        this.session.history.show(this.file, this.root, force);
    }

    // Change a view option. All but source mode are GSettings keys: writing them is enough,
    // because the sidebar and assistant are bound to their keys (Gio.Settings.bind) and the rest is applied by
    // onSettingChanged. The toggle actions in the menu (Gio.Settings.create_action) use the same path.
    setOption(key: ViewOption, value: boolean): void {
        if (key === 'source') for (const doc of this.docs) doc.editor.setMode('source', value);
        else if (key === 'dark') {
            this.setDark(value);
            this.settings.dark = value;
        } else this.settings[key] = value;
    }

    // GSettings changes (menu, preferences dialog, or another process) that need to be applied to the components.
    private onSettingChanged(key: string): void {
        const s = this.settings;
        if (key === 'color-scheme') {
            if (s.dark !== this.colorScheme) this.setDark(s.dark);
            const dark = this.app.lookup_action('dark');
            if (dark instanceof Gio.SimpleAction) dark.set_state(GLib.Variant.new_boolean(this.dark));
        } else if (key === 'focus' || key === 'typewriter') for (const doc of this.docs) doc.editor.setMode(key, s[key]);
        else if (key === 'autosave') { if (s.autosave) for (const doc of this.docs) this.session.autosaver.queue(doc); }
        else if (key === 'recent-files') this.refreshRecent();
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
        return this.documents.nameOf(this.doc);
    }

    // Suggested file name from the first heading.
    suggestName(): string {
        return this.documents.suggestName();
    }

    updateTitle(): void {
        this.refreshTitle(this.doc);
    }

    // The Recent list of the New menu and the document's menu: the last files that still exist.
    private refreshRecent(): void {
        this.header.setRecent(this.settings.recentFiles.filter(r => fileExists(r.path) && !isFolder(r.path)).slice(0, 5).map(r => r.path));
    }

    // Tab title for doc, and the window title if doc is active.
    private refreshTitle(doc: Doc): void {
        if (!this.docs.includes(doc)) return;
        const mark = doc.editor.buffer.get_modified() ? '• ' : '';
        const name = this.documents.nameOf(doc);
        this.tabBar.setTitle(doc.id, `${mark}${name}`, doc.file);
        if (doc !== this.doc) return;
        if (doc.home) {
            this.header.setTitle(name, this.root ? GLib.path_get_basename(this.root) : APP_NAME);
            this.win.set_title(`${name} — ${APP_NAME}`);
            return;
        }
        const where = doc.file ? GLib.path_get_dirname(doc.file).replace(GLib.get_home_dir(), '~') : APP_NAME;
        this.header.setTitle(`${mark}${name}`, doc.file && !mark ? `${where} · ${_('Saved')}` : where, true);
        this.win.set_title(`${mark}${name} — ${APP_NAME}`);
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
        if (isImageFile(path)) {  // images are not editable: show them in the viewer
            try {
                new ImageViewer(this.win, GdkPixbuf.Pixbuf.new_from_file(path), GLib.path_get_basename(path)).show();
            } catch {
                void showError(this.win, fmt(_('Could not open image: {name}'), { name: GLib.path_get_basename(path) }));
            }
            return;
        }
        if (path === this.file) return;
        if (!this.openInTab(path)) this.fileTree.reveal(this.file);  // restore the highlight to the file that is still open
    }

    async chooseFolder(): Promise<void> {
        const path = await chooseFile(this.win, { title: _('Open Folder'), selectFolder: true, folder: this.root });
        if (path) this.openFolder(path);
    }

    // Show a folder in the Files tab and remember it to open again next time.
    // show = false when restoring the last folder, so a sidebar that was deliberately
    // closed does not suddenly appear.
    openFolder(path: string, show = true): void {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        // Switching to another folder: the files of the old folder do not belong here, close their tabs first.
        if (this.root && this.root !== absolute) {
            void after(this.documents.closeOutside(absolute), yes => {
                if (yes) this.applyFolder(absolute, show);
            });
            return;
        }
        this.applyFolder(absolute, show);
    }

    private applyFolder(absolute: string, show: boolean): void {
        this.session.files.setRoot(absolute);
        this.workspace.warm(absolute);
        this.fileTree.reveal(this.file);
        this.syncHistory();
        this.pulls.folderChanged();
        void this.collab.setFolder(absolute);
        this.settings.folder = absolute;
        if (this.doc.home) this.updateTitle();
        this.refreshHome();
        if (!show) return;
        this.sidebar.setPage('files');
        this.settings.sidebar = true;
    }

    async open(): Promise<void> {
        const path = await chooseFile(this.win, { title: _('Open Markdown'), filters: ['markdown', 'all'] });
        if (path) this.openInTab(path);
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
        return after(this.documents.confirmDiscardAll(), yes => yes ? after(this.harness.confirmClose(), stay => stay && this.rememberWindow()) : false);
    }

    private rememberWindow(): true {
        // Closed while narrow: save the panel settings for the wide layout, not the collapsed state.
        for (const [key, value] of this.widePanels) this.settings.store.set(key, value);
        // After confirmation: a new document saved through a dialog already has a file.
        this.documents.rememberTabs();
        // In GTK 4 the default size follows the current window size.
        const [width, height] = this.win.get_default_size();
        Object.assign(this.settings, { width, height });
        return true;
    }

    // ---------- Commands (CommandHost) ----------

    openFind(withReplace = false): void {
        this.findBar.open(withReplace);
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
        this.session.dispose();
        this.chat.destroy();
        this.history.destroy();
        this.historyViewers.destroy();
        this.fileTree.destroy();
    }
}
