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
import { WELCOME } from './welcome.js';
import { MarkdownView, type Mode } from './editor/view.js';
import { Outline } from './ui/outline.js';
import { CollabPanel } from './ui/collab.js';
import { PullView } from './ui/pullview.js';
import { History } from './ui/history.js';
import { HistoryViewer } from './ui/historyviewer.js';
import { FileTree, isDirectory, isImageFile } from './ui/filetree.js';
import { Sidebar } from './ui/sidebar.js';
import { ChatPanel } from './ui/chat.js';
import { WorkspaceRepository } from './workspace.js';
import type { WikiLink } from './markdown/wikilink.js';
import { agentGit, recentSubjects, workingDiff } from './git.js';
import { writeCommitMessage } from './agent/commitmessage.js';
import type { MessageWriter } from './ui/messagewriter.js';
import { FindBar } from './ui/findbar.js';
import { StatusBar } from './ui/statusbar.js';
import { TabBar } from './ui/tabbar.js';
import { HeaderBar } from './ui/headerbar.js';
import type { Palette } from './colors.js';
import { applyTheme, systemPrefersDark } from './ui/theme.js';
import { chooseFile, showError } from './ui/dialogs.js';
import { registerActions, type Option } from './actions.js';
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
import { Autosaver, type AutosaveHost } from './window/autosave.js';
import { CollabController, type CollabHost } from './window/collab.js';
import { ContributeController, type ContributeHost } from './window/contribute.js';
import { PullReviewController, type PullHost } from './window/pulls.js';
import { JournalController, type JournalHost } from './window/journal.js';
import { HarnessController, type HarnessHost } from './window/harness.js';
import { HomeController, type HomeHost } from './window/home.js';
import { ViewController, type ViewHost } from './window/views.js';
import { NoteLinks, type NoteHost } from './window/notes.js';
import type { ToastAction } from './window/doc.js';
import { DocumentController, UNTITLED, type DocumentsHost } from './window/documents.js';
import { applyChange, applyChangeBatch, type AgentWriteHost } from './window/agentwrites.js';

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

// The window as seen by its controllers; each controller is typed with only the part it needs.
type WindowHost = AutosaveHost & JournalHost & HarnessHost & HomeHost & AgentWriteHost & ViewHost & NoteHost & CollabHost & PullHost & ContributeHost;

export class MainWindow {
    readonly app: Adw.Application;
    readonly settings: AppSettings;
    readonly outline: Outline;
    readonly history: History;
    readonly fileTree: FileTree;
    readonly sidebar: Sidebar;
    readonly findBar: FindBar;
    // The last notification text (for tests; the toast itself disappears on its own).
    lastToast = '';
    lastToastAction: ToastAction | null = null;
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
    readonly homePage: HomeController;
    private readonly views: ViewController;
    private readonly notes: NoteLinks;
    private readonly autosaver: Autosaver;
    private readonly host: WindowHost;
    private closing = false;   // closing the window has been confirmed through a dialog
    readonly chat: ChatPanel;
    readonly chatSplit: Adw.OverlaySplitView;
    private readonly content: Gtk.Stack;
    readonly header: HeaderBar;
    readonly win: Adw.ApplicationWindow;

    readonly documents: DocumentController;
    // The Markdown files of the work folder; documents with unsaved changes are read from their editor.
    readonly workspace = new WorkspaceRepository(() => new Map(this.docs
        .filter(d => d.file && d.editor.buffer.get_modified()).map(d => [d.file!, d.editor.getText()])));
    private palette: Palette | null = null;
    dark: boolean;
    private colorScheme: boolean | null = null;   // the last choice applied by setDark (null = follow the system)

    // path: the file or folder to open when the window appears.
    constructor(app: Adw.Application, settings: AppSettings, path: string | null = null) {
        this.app = app;
        this.settings = settings;
        this.dark = settings.dark ?? systemPrefersDark();

        // Components
        this.content = new Gtk.Stack({ vexpand: true, hexpand: true });
        this.tabBar = new TabBar();
        this.outline = new Outline();
        this.history = new History();
        this.fileTree = new FileTree();
        this.collabPanel = new CollabPanel();
        this.pullView = new PullView();
        this.sidebar = new Sidebar(this.fileTree.widget, this.outline.widget, this.history.widget, this.collabPanel.widget);
        this.statusBar = new StatusBar();
        this.board = new KanbanBoard();
        this.inbox = new InboxView();
        this.table = new TableView();
        this.gallery = new GalleryView();
        this.layouts = { calendar: new CalendarView(), timeline: new TimelineView(), gallery: this.gallery, chart: new ChartView() };
        this.home = new HomeView();
        this.chat = new ChatPanel();
        this.header = new HeaderBar();

        // Feature controllers: created before the first document, whose buffer already queues autosaves.
        this.host = this.makeHost();
        this.autosaver = new Autosaver(this.host);
        this.journal = new JournalController(this.host);
        this.collab = new CollabController(this.host);
        this.pulls = new PullReviewController(this.host, { provider: () => this.collab.provider(), changed: () => void this.collab.refresh() });
        this.collab.onOpenPull = pull => void this.pulls.open(pull);
        this.contribute = new ContributeController(this.host, { session: () => this.collab.session(), refresh: () => void this.collab.refresh() });
        this.collab.onSend = () => void this.contribute.start();
        this.harness = new HarnessController(this.host);
        this.homePage = new HomeController(this.host);
        this.views = new ViewController(this.host);
        this.notes = new NoteLinks(this.host);

        this.documents = new DocumentController(this.documentsHost());
        this.documents.start();
        this.doc.editor.modes.focus = settings.focus;
        this.doc.editor.modes.typewriter = settings.typewriter;
        this.findBar = new FindBar(this.doc.editor.buffer, this.doc.editor.view);

        // The components do not know each other; the window is what connects them.
        this.inbox.onOpenNote = link => this.openNote(link);
        this.inbox.listNotes = () => this.notes.names(this.doc);
        this.table.onOpenNote = link => this.openNote(link);
        this.table.listNotes = () => this.notes.names(this.doc);
        for (const view of Object.values(this.layouts)) {
            view.onOpenNote = link => this.openNote(link);
            view.listNotes = () => this.notes.names(this.doc);
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
        this.board.listNotes = () => this.notes.names(this.doc);
        this.board.harness = {
            status: card => this.harness.status(card),
            menu: (card, at) => this.harness.menu(card, at),
        };
        this.outline.onJump = line => this.editor.jumpToLine(line);
        this.tabBar.onSelect = id => {
            const doc = this.docs.find(d => d.id === id);
            if (doc) this.activate(doc);
        };
        this.tabBar.onClose = id => {
            const doc = this.docs.find(d => d.id === id);
            if (doc) this.closeTab(doc);
        };
        this.fileTree.onOpenFile = file => this.openFile(file);
        this.fileTree.onMoved = (from, to) => {
            this.documents.filesMoved(from, to);
            this.syncHistory(true);
        };
        this.fileTree.onDeleted = path => {
            this.documents.fileDeleted(path);
            this.fileTree.reveal(this.file);
            this.syncHistory(true);
        };
        this.history.onOpen = commit => {
            if (this.file) new HistoryViewer(this.win, this.file, commit, this.dark).show();
        };
        // Only save file documents that have changes; without a file, do not bring up a save dialog.
        this.history.beforeCommit = () => this.documents.saveOpenFiles();
        this.history.onCommitted = () => {
            this.toast(_('Committed successfully'));
            this.syncHistory(true);
        };
        this.connectWriter(this.history.writer);
        this.history.onOpenChanges = file => {
            const viewer = new HistoryViewer(this.win, file, null, this.dark);
            this.connectWriter(viewer.writer);
            viewer.beforeCommit = () => this.documents.saveOpenFiles();
            viewer.onCommitted = () => {
                this.toast(_('Committed successfully'));
                this.syncHistory(true);
            };
            viewer.show();
        };
        this.chat.settings.setModel(settings.chatModel);
        this.chat.settings.setThinking(settings.chatThinking);
        this.chat.settings.onModelChanged = model => {
            this.settings.chatModel = model;
        };
        this.chat.settings.setSaveChats(settings.chatSave);
        this.chat.settings.onSaveChanged = save => {
            this.settings.chatSave = save;
        };
        this.chat.settings.onThinkingChanged = thinking => {
            this.settings.chatThinking = thinking;
        };
        this.chat.host = {
            active: () => {
                const buf = this.editor.buffer;
                return { name: this.projectName(this.file) ?? this.documentName, text: this.editor.getText(), cursorLine: buf.get_iter_at_mark(buf.get_insert()).get_line() };
            },
            selection: () => {
                const buf = this.editor.buffer;
                const bounds = buf.get_selection_bounds();
                return bounds[0] ? buf.get_text(bounds[1], bounds[2], false) : '';
            },
            root: () => this.fileTree.root,
            applyChange: change => applyChange(this.host, change),
            applyBatch: changes => applyChangeBatch(this.host, changes),
            git: request => this.fileTree.root ? agentGit(this.fileTree.root, request) : Promise.resolve({ ok: false, message: 'no work folder' }),
            window: () => this.win,
            insertText: text => this.insertIntoNote(text),
            // Other unsaved tabs are read from their editor, not the version on disk (see workspace).
            files: freshness => this.fileTree.root ? this.workspace.files(this.fileTree.root, { except: this.file, freshness }) : [],
        };
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
        this.setDark(settings.dark);
        // The system theme changed (GNOME Dark Style) while its setting is "follow system".
        Adw.StyleManager.get_default().connect('notify::dark', () => {
            if (this.settings.dark === null && Adw.StyleManager.get_default().dark !== this.dark) this.setDark(null);
        });
        // The system accent changed (libadwaita ≥ 1.6): recolor the text tags; older libadwaita has no such property.
        if (GObject.Object.find_property.call(Adw.StyleManager, 'accent-color'))
            Adw.StyleManager.get_default().connect('notify::accent-color', () => this.setDark(this.colorScheme));
        settings.gsettings.connect('changed', (_gs, key) => this.onSettingChanged(key));
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
        if (path && isDirectory(path)) this.openFolder(path);
        else if (settings.folder && isDirectory(settings.folder)) this.openFolder(settings.folder, false);
        if (path && !isDirectory(path)) {
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
        this.views.sync();
        this.updateTitle();
        this.win.present();
        this.syncHistory();
        this.editor.view.grab_focus();
    }

    // A short notification that disappears on its own (Adw.Toast).
    toast(message: string, action?: ToastAction): void {
        this.lastToast = message;
        this.lastToastAction = action ?? null;
        const toast = new Adw.Toast({ title: message, timeout: action ? 8 : 3 });
        if (action) {
            toast.set_button_label(action.label);
            toast.connect('button-clicked', action.run);
        }
        this.toasts.add_toast(toast);
    }

    private makeHost(): WindowHost {
        const w = this;
        return {
            get win() { return w.win; },
            get settings() { return w.settings; },
            get chat() { return w.chat; },
            get board() { return w.board; },
            get harness() { return w.harness; },
            get journal() { return w.journal; },
            get collabPanel() { return w.collabPanel; },
            get pullView() { return w.pullView; },
            showDocument: () => this.views.sync(),
            saveAll: () => this.documents.saveOpenFiles(),
            get workspace() { return w.workspace; },
            get app() { return w.app; },
            get content() { return w.content; },
            get inbox() { return w.inbox; },
            get table() { return w.table; },
            get layouts() { return w.layouts; },
            get home() { return w.home; },
            get header() { return w.header; },
            get homePage() { return w.homePage; },
            get statusBar() { return w.statusBar; },
            get findBar() { return w.findBar; },
            newDocument: text => this.documents.reset(this.documents.blank(), text),
            root: () => this.fileTree.root,
            active: () => this.doc,
            docs: () => this.docs,
            openInTab: path => this.openInTab(path),
            toast: (message, action) => this.toast(message, action),
            write: (path, text) => this.documents.write(path, text),
            refreshTree: () => { if (this.fileTree.root) this.fileTree.refresh(this.fileTree.root); },
            refreshHome: () => this.refreshHome(),
            fileMoved: (doc, path) => this.documents.fileMoved(doc, path),
            fileGone: doc => this.documents.fileGone(doc),
            fileBack: (doc, path) => this.documents.fileBack(doc, path),
            filesMoved: () => { this.fileTree.reveal(this.file); this.syncHistory(true); },
            projectName: path => this.projectName(path),
            showChat: () => { this.settings.chat = true; },
            boardShown: file => this.boardMode && this.file === file,
            updateBoardFile: (file, edit) => this.views.updateBoardFile(file, edit),
            record: (kind, text) => this.journal.record(kind, text),
        };
    }

    // ---------- Active document ----------

    get editor(): MarkdownView {
        return this.doc.editor;
    }

    // The active document's path, null = never saved.
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
    private documentsHost(): DocumentsHost {
        const w = this;
        return {
            get win() { return w.win; },
            get settings() { return w.settings; },
            get autosaver() { return w.autosaver; },
            root: () => this.fileTree.root,
            toast: (message, action) => this.toast(message, action),
            attach: doc => this.attach(doc),
            detach: doc => {
                this.tabBar.remove(doc.id);
                doc.editor.destroy();
                this.content.remove(doc.editor.widget);
            },
            activated: doc => {
                this.findBar.setTarget(doc.editor.buffer, doc.editor.view);
                this.tabBar.setActive(doc.id);
                this.outline.update(doc.editor.headings);
                this.views.sync();
                this.updateTitle();
                this.fileTree.reveal(doc.file);
                this.syncHistory();
                if (this.chatSplit.show_sidebar) this.chat.updateContextSummary();
            },
            contentChanged: doc => {
                this.views.replaced(doc);
                this.updateTitle();
                this.fileTree.reveal(doc.file);
                if (!doc.home) this.syncHistory();
            },
            refreshTitle: doc => this.refreshTitle(doc),
            setIcon: (doc, icon) => this.tabBar.setIcon(doc.id, icon),
            tabOrder: () => this.tabBar.ids(),
            refreshHome: () => this.refreshHome(),
            openFolder: path => this.openFolder(path),
            fileSaved: path => {
                // Show the new file in the tree without waiting for the disk monitor.
                this.fileTree.refresh(GLib.path_get_dirname(path));
                this.fileTree.reveal(path);
                this.syncHistory();
            },
        };
    }

    // Connect a new document's editor, and add its page and tab.
    private attach(doc: Doc): void {
        const editor = doc.editor;
        // Editor callbacks only apply while their document is active; background ones do not touch the outline and status bar.
        editor.onHighlighted = ({ headings, words, characters }) => {
            if (doc !== this.doc) return;
            this.outline.update(headings);
            if (!this.views.structuredMode) this.statusBar.setDocumentCounts(words, characters);
        };
        editor.onCursorMoved = (line, column) => {
            if (doc !== this.doc) return;
            this.statusBar.setCursor(line, column);
            this.statusBar.setModes((Object.keys(MODE_LABELS) as Mode[]).filter(m => editor.modes[m]).map(m => MODE_LABELS[m]));
        };
        editor.onMessage = msg => this.toast(msg);
        editor.onViewImage = (pixbuf, title) => new ImageViewer(this.win, pixbuf, title).show();
        editor.getBaseDir = () => doc.file ? GLib.path_get_dirname(doc.file) : GLib.get_home_dir();
        editor.onOpenNote = link => this.openNote(link, doc);
        editor.onOpenDocument = path => this.openInTab(path);
        editor.listNotes = () => this.notes.names(doc);
        editor.buffer.connect('modified-changed', () => this.refreshTitle(doc));
        // Text changed while the board is shown and not by the board itself (undo/redo): re-read.
        editor.buffer.connect('changed', () => {
            this.views.queueReload(doc);
            this.autosaver.edited(doc);
        });

        // A new document inherits the mode and theme of the currently active document.
        if (this.docs.length) {
            for (const mode of Object.keys(MODE_LABELS) as Mode[]) if (this.doc.editor.modes[mode]) editor.setMode(mode, true);
        }
        if (this.palette) editor.setPalette(this.palette);
        this.content.add_named(editor.widget, `doc-${doc.id}`);
        this.tabBar.add(doc.id, UNTITLED);
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
        const gs = this.settings.gsettings;
        split.pin_sidebar = true;
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
        const root = this.fileTree.root;
        return path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path ? GLib.path_get_basename(path) : null;
    }

    // ---------- [[note]] links ----------

    // Ctrl+click [[note]]: see NoteLinks.open.
    openNote(link: WikiLink, doc = this.doc): void {
        this.notes.open(link, doc);
    }

    // ---------- Views: text, board, inbox, Home ----------

    // The assistant's answer goes into the open note at the cursor, as one undo step. false: no editable note is shown.
    private insertIntoNote(text: string): boolean {
        if (this.views.structuredMode || this.homeMode) return false;
        const buffer = this.editor.buffer;
        buffer.begin_user_action();
        const inserted = buffer.insert_interactive_at_cursor(`${text.trim()}\n`, -1, true);
        buffer.end_user_action();
        return inserted;
    }

    get boardMode(): boolean {
        return this.views.boardMode;
    }

    get inboxMode(): boolean {
        return this.views.inboxMode;
    }

    get tableMode(): boolean {
        return this.views.tableMode;
    }

    get homeMode(): boolean {
        return this.views.homeMode;
    }

    setBoardMode(on: boolean): void {
        this.views.show(on ? 'board' : 'text');
    }

    // Text editor actions are disabled while a board, inbox, or Home is shown.
    syncActionsEnabled(): void {
        this.views.syncActionsEnabled();
    }

    // The "Board View" menu/shortcut.
    toggleBoardView(on: boolean): void {
        this.views.toggle(on);
    }

    // The layout menu in the header bar.
    setLayout(layout: string): void {
        this.views.setLayout(layout);
    }

    // The "Fields…" menu for the board or list that is shown.
    sendChanges(): void {
        void this.contribute.start();
    }

    editFields(): void {
        this.views.editFields();
    }

    // A new document containing an empty kanban board.
    newBoardDocument(): void {
        this.views.newBoard();
    }

    // A new document containing an empty inbox.
    newInboxDocument(): void {
        this.views.newInbox();
    }

    // A new document containing an empty table.
    newTableDocument(): void {
        this.views.newTable();
    }

    // ---------- Home ----------

    // Alt+Home: switch to the Home tab, or open it if there is none (using the active empty tab if there is one).
    openHome(): void {
        this.documents.openHome();
    }

    // Redraw Home if it is shown; the data is recomputed from the files every time.
    refreshHome(): void {
        if (this.doc.home && this.homeMode) this.home.render(this.homePage.data());
    }

    // ---------- Git history ----------

    // A commit form's assistant button writes with the Assistant panel's key and model.
    private connectWriter(writer: MessageWriter): void {
        writer.write = (files, onText, cancellable) => writeCommitMessage({
            keyStore: this.chat.keyStore, makeProvider: this.chat.makeProvider, model: () => this.chat.model,
            diff: workingDiff, subjects: recentSubjects,
        }, files, onText, cancellable);
        writer.onOpenSettings = () => {
            this.settings.chat = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.chat.openSettings(); return GLib.SOURCE_REMOVE; });
        };
    }

    // History is only loaded while its tab is visible, so git is not called needlessly.
    // force = re-read even for the same file.
    syncHistory(force = false): void {
        if (!this.sidebar.visible || this.sidebar.page !== 'history') return;
        this.history.setFile(this.file, force, this.fileTree.root);
    }

    // Change a view option. All but source mode are GSettings keys: writing them is enough,
    // because the sidebar and assistant are bound to their keys (Gio.Settings.bind) and the rest is applied by
    // onSettingChanged. The toggle actions in the menu (Gio.Settings.create_action) use the same path.
    setOption(key: Option, value: boolean): void {
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
        else if (key === 'autosave') { if (s.autosave) for (const doc of this.docs) this.autosaver.queue(doc); }
        else if (key === 'chat-model') this.chat.settings.setModel(s.chatModel);
        else if (key === 'chat-thinking') this.chat.settings.setThinking(s.chatThinking);
        else if (key === 'chat-save') this.chat.settings.setSaveChats(s.chatSave);
    }

    // ---------- Auto save ----------

    // The active document unless given; see Autosaver.
    autosaveInBackground(doc: Doc = this.doc, done?: () => void): boolean {
        return this.autosaver.inBackground(doc, done);
    }

    autosave(doc: Doc = this.doc): boolean {
        return this.autosaver.now(doc);
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

    // Tab title for doc, and the window title if doc is active.
    private refreshTitle(doc: Doc): void {
        if (!this.docs.includes(doc)) return;
        const mark = doc.editor.buffer.get_modified() ? '• ' : '';
        const name = this.documents.nameOf(doc);
        this.tabBar.setTitle(doc.id, `${mark}${name}`, doc.file);
        if (doc !== this.doc) return;
        if (doc.home) {
            this.header.setTitle(name, this.fileTree.root ? GLib.path_get_basename(this.fileTree.root) : APP_NAME);
            this.win.set_title(`${name} — ${APP_NAME}`);
            return;
        }
        this.header.setTitle(`${mark}${name}`, doc.file ? GLib.path_get_dirname(doc.file).replace(GLib.get_home_dir(), '~') : APP_NAME);
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
        const path = await chooseFile(this.win, { title: _('Open Folder'), selectFolder: true, folder: this.fileTree.root });
        if (path) this.openFolder(path);
    }

    // Show a folder in the Files tab and remember it to open again next time.
    // show = false when restoring the last folder, so a sidebar that was deliberately
    // closed does not suddenly appear.
    openFolder(path: string, show = true): void {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        this.fileTree.setRoot(absolute);
        this.workspace.warm(absolute);
        this.fileTree.reveal(this.file);
        this.syncHistory();
        if (this.pulls.current) this.pulls.close();
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
        return after(this.documents.confirmDiscardAll(), yes => yes && this.rememberWindow());
    }

    private rememberWindow(): true {
        // Closed while narrow: save the panel settings for the wide layout, not the collapsed state.
        for (const [key, value] of this.widePanels) this.settings.gsettings.set_boolean(key, value);
        // After confirmation: a new document saved through a dialog already has a file.
        this.documents.rememberTabs();
        // In GTK 4 the default size follows the current window size.
        const [width, height] = this.win.get_default_size();
        Object.assign(this.settings, { width, height });
        return true;
    }

    // Stop the timers and idles of all components after the window is destroyed.
    private dispose(): void {
        for (const doc of this.docs) {
            this.autosaver.cancel(doc);
            doc.editor.destroy();
        }
        this.harness.dispose();
        this.collab.dispose();
        this.chat.destroy();
        this.history.destroy();
        this.fileTree.destroy();
        this.workspace.close();
    }
}
