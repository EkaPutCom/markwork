// The renderer's side of the app protocol as a store React can subscribe to. It speaks the protocol (connection, one
// DocMirror per document), keeps what the core shows (tabs, files, boards, toasts), and offers the actions the UI calls.
// It holds no widgets: the editor registers itself, and the views read the snapshot.

import { COMMANDS, type Command, type FrontendCommands } from '../../../src/app/commands.js';
import type { StatusCounts } from '../../../src/app/protocol/screen.js';
import { DocMirror } from '../../../src/app/protocol/mirror.js';
import { RequestError, type Change, type Message } from '../../../src/app/protocol/messages.js';
import { Connection, type Handler } from '../../../src/app/protocol/wire.js';
import type { ChooseFileOptions, Prompt, Question } from '../../../src/app/dialogs.js';
import type { CancelSignal } from '../../../src/platform/index.js';
import type { Board } from '../../../src/markdown/kanban.js';
import { applyNoteEdit, type NoteEdit } from '../../../src/markdown/noteedit.js';
import type { FormatAt, MarkdownEditor } from './editor.js';
import * as P from './panes.js';
import { appUrl, type ZoomedImage } from './images.js';
import type { SearchQuery, SearchResults } from '../../../src/app/protocol/search.js';
import type { FolderEntry, NewKind } from '../../../src/app/protocol/tree.js';
import type { HomeData, ProgramsData } from '../../../src/app/protocol/screen.js';
import type { PreferencesData } from '../../../src/app/protocol/preferences.js';
import type { SchemaDialogOptions } from '../../../src/app/protocol/schema.js';
import type { FieldDef } from '../../../src/markdown/fields.js';
import type { ChangeKind, Commit, DiscardOutcome, HistoryChanges, HistoryText, WriteResult } from '../../../src/app/protocol/history.js';
import type { CollabSnapshot, MergeMethod, PullSnapshot, RepoRef, SendChangesAnswer, SendChangesOptions, TokenSource } from '../../../src/app/protocol/collab.js';
import type { HarnessAsk, PullRequestAnswer, PullRequestOptions, ReviewSnapshot, ReviewTab } from '../../../src/app/protocol/harness.js';
import type { ProjectPage, WorktreeList } from '../../../src/app/protocol/preferences.js';
import type { TraceUpdate } from '../../../src/agent/tracefeed.js';
import { TraceReplica } from '../../../src/agent/tracefeed.js';
import { ChatModel } from './chatmodel.js';

declare global {
    interface Window {
        markwork: { registerHtml(id: number, root: string): Promise<void>; unregisterHtml(id: number): Promise<void>; pathsOf(files: File[]): string[]; closeWindow(): Promise<void>; chooseFile(options: ChooseFileOptions): Promise<string | null>; initialFolder(): Promise<string | null>; openFolder(path: string): Promise<void>; devMode: boolean; onInspect?: (answer: (request: unknown) => Promise<unknown>) => void };
    }
}

export interface Tab {
    id: number;
    mirror: DocMirror;
    name: string;
    file: string | null;
    place: string | null;         // where it is, as the core words it (doc.title): its folder, ~ for the home folder
    page: string;                 // 'text' or the structured page the core shows ('board', …); 'home', 'programs', and 'html' for the pages that are tabs
    board: Board | null;
    groupField: string | null;    // a board grouped by a field: its name (view.notes)
    agents: boolean;              // a board lets agents be assigned to cards
    capture: number;              // how many times the core asked for the cursor in the capture line (view.focusCapture)
    csv: string | null;           // a CSV tab: the text the core sent (view.csv)
    csvRev: number;               // how many times it sent it
    home: HomeData | null;        // a Home tab: what the page shows (view.home)
    programs: ProgramsData | null;   // the Programs tab: what the page shows (view.programs)
    html: { file: string; root: string } | null;   // an HTML tab: the file, and the folder it may read
    runs: Record<string, string>;   // the runs of a board's cards by card text: the status of each (view.runs)
}

// A run's log window (view.runlog.*): the log is a copy of the core's, kept up to date by its updates.
export interface RunLog { run: number; title: string; log: TraceReplica; rev: number }

// A question of the agents that waits for the user: the answer of a harness, a line of steering or a reply, a machine to add.
export type AgentAsk =
    | { id: number; kind: 'answer'; ask: HarnessAsk; agent: string }
    | { id: number; kind: 'text'; title: string; label: string; context: string; text: string }
    | { id: number; kind: 'machine'; taken: string[] };

// What a card's menu offers: the entries are the core's, each one run by its token.
export interface CardMenuEntry { label: string; enabled?: boolean; token: number }

// A dialog in the window: a question with buttons, and an entry when it asks for text. The first button is the default.
export interface DialogButton { label: string; value: string; style?: 'suggested' | 'destructive' }
export interface Dialog {
    title: string;
    detail: string;
    buttons: DialogButton[];
    entry: { label: string; value: string } | null;
    close(value: string | null, text: string): void;   // null = dismissed (Escape, or the core withdrew the question)
}

// A command as the core's table lists it in the `hello` reply.
export interface CommandEntry { id: string; label: string | null; keys: string[]; kind: string; scope: string; runs: 'core' | 'editor' }

// The Search panel: what its fields hold, whether the Replace row is open, and the last results. `focus` counts the times a
// command asked for the query field, so the panel can take the focus again.
export interface SearchPanel { form: SearchQuery; replacement: string; replace: boolean; results: SearchResults | null; focus: number }

// The Files tree: the entries of every folder the core has sent (by folder path), the folders shown open, and the file to highlight.
export interface FileTree { root: string | null; folders: Record<string, FolderEntry[]>; expanded: string[]; revealed: string | null }

// The History tab: the commits of the active file, its uncommitted files, and the message of the commit form as the core wrote it so far
// (`messageRev` counts the times, so the form takes the text again when it arrives).
export interface HistoryPanel {
    commits: Commit[]; more: boolean; note: string;
    changes: HistoryChanges | null;
    message: string; messageRev: number;
}

// A history viewer: one commit (changes and contents), or one file's uncommitted changes with a commit form (commit = null).
export interface Viewer {
    id: number; file: string; commit: Commit | null;
    diff: HistoryText | null; content: string | null;
    message: string; messageRev: number;
}

// The token dialog the core asked for, and the form that sends changes.
export interface TokenAsk { id: number; repo: RepoRef; hasToken: boolean; source: TokenSource | null }
export interface SendAsk { id: number; options: SendChangesOptions }

// What the discard question says: a new file goes to the Trash, a deleted one comes back, changes to a tracked file are lost.
export function discardPrompt(kind: ChangeKind, path: string): { heading: string; detail: string; accept: string } {
    const name = path.split(/[\\/]/).pop() ?? path;
    if (kind === 'untracked' || kind === 'added') return { heading: `Delete the new file “${name}”?`, detail: 'The file is not in the last commit. It will be moved to the Trash.', accept: 'Move to Trash' };
    if (kind === 'deleted') return { heading: `Restore “${name}”?`, detail: 'The file comes back as it is in the last commit.', accept: 'Restore' };
    return { heading: `Discard the changes to “${name}”?`, detail: 'The file goes back to the last commit. This cannot be undone.', accept: 'Discard Changes' };
}

// The sections of the Files view, in order, and what each starts as.
export type SectionId = 'editors' | 'folder' | 'outline' | 'timeline';
export interface SectionState { open: boolean; hidden: boolean; size: number }
export const SECTIONS: readonly SectionId[] = ['editors', 'folder', 'outline', 'timeline'];
const SECTION_DEFAULTS: Record<SectionId, Pick<SectionState, 'open' | 'size'>> = { editors: { open: true, size: 1 }, folder: { open: true, size: 2 }, outline: { open: true, size: 1 }, timeline: { open: false, size: 1 } };
export const SIDEBAR_WIDTH = { min: 200, max: 480, default: 280 };

export interface Toast { text: string; action: { label: string; token: number } | null; at: number }

export interface State {
    ready: boolean;
    coreError: string | null;
    root: string | null;
    files: string[];
    tabs: Tab[];
    active: number;
    toast: Toast | null;
    line: number;                 // the cursor, from 1
    column: number;
    format: FormatAt;             // what the text at the cursor is, for the visual editor's toolbar
    source: boolean;              // source mode of the focused pane: no syntax is hidden
    panes: P.Layout;              // the panes of the editor area, and which has the focus
    palette: boolean;
    sidebar: boolean;             // the `sidebar` setting
    width: number;                // the window's width, which decides whether the side panels float (layoutOf)
    floating: { sidebar: boolean; chat: boolean };   // a side panel opened over the content while the window is too narrow for it
    settings: Record<string, unknown>;   // the core's settings, as `hello` and `setting` notices give them
    commands: CommandEntry[];     // the core's command table
    dialog: Dialog | null;        // the dialog shown; others wait behind it
    disabled: string[];           // the commands the core says do not apply now (commands.state)
    status: { visible: boolean; counts: StatusCounts };   // the counts at the foot (view.status)
    image: ZoomedImage | null;   // the picture shown large (view.image, or a double click)
    recent: string[];                // the Recent files of the menus (recent), latest first
    programsMissing: number;         // needed programs that are missing (programs.missing): the mark on the sidebar's Programs
    prefs: PreferencesData | null;   // the Preferences dialog while it is open (view.prefs.open)
    info: 'shortcuts' | 'about' | null;   // the Keyboard Shortcuts or About dialog
    tree: FileTree;
    search: SearchPanel;             // the Search panel's fields and the core's results (view.search)
    outline: { level: number; text: string; line: number }[];   // the headings of the active document (view.outline)
    layout: { layout: string | null; structured: boolean };   // the layout button (view.layout): '' = text, null = hidden
    schema: { id: number; options: SchemaDialogOptions } | null;   // the Fields… dialog while the core asks for it (ask.schema)
    csvFind: { n: number; replace: boolean };   // how many times the CSV tab's search bar was asked for
    history: HistoryPanel;
    viewers: Viewer[];               // the history viewers that are open, the latest last
    collab: CollabSnapshot;          // the pull requests tab (view.collab)
    pull: PullSnapshot | null;       // the pull request the core opened for review (view.pull)
    pullShown: boolean;              // the content area shows it, not the document (view.pull.show, until the next page)
    tokenAsk: TokenAsk | null;       // the token dialog while the core asks for it (ask.token)
    sendAsk: SendAsk | null;         // the form that sends changes while the core asks for it (ask.sendChanges)
    runLogs: RunLog[];               // the log windows of agent runs that are open, the latest last
    review: ReviewSnapshot | null;   // the review of a card's worktree (view.review)
    reviewShown: boolean;            // the content area shows it, not the document (view.review.show, until the next page)
    agentAsks: AgentAsk[];           // the questions of the agents that wait; the first is the one shown
    pullAsk: { id: number; options: PullRequestOptions } | null;   // the form that sends a worktree's branch as a pull request (ask.pullRequest)
    project: ProjectPage | null;     // the project page of Preferences → Agents (view.prefs.project)
    worktrees: WorktreeList | null;  // its card worktrees (view.prefs.worktrees)
}

// The core commands this window can carry out so far; the others need dialogs or views that are not carried over yet.
const CORE_COMMANDS = new Set(['send-changes', 'preferences', 'open-recent', 'home', 'programs', 'visual', 'focus', 'typewriter', 'new', 'open', 'open-folder', 'save', 'save-as', 'export-html', 'image', 'close-tab', 'next-tab', 'prev-tab',
    'kanban-new', 'kanban-view', 'inbox-new', 'table-new', 'csv-new', 'fields-edit', 'layout', 'sidebar', 'dark', 'autosave', 'chat', 'journal', 'journal-capture', 'journal-summary']);
const EDITOR_COMMANDS_UNAVAILABLE = new Set<string>();

export const isAvailable = (command: Command): boolean =>
    command.runs === 'core' ? CORE_COMMANDS.has(command.id) : !EDITOR_COMMANDS_UNAVAILABLE.has(command.id);

// The adaptive layout: below NARROW the Assistant panel no longer takes editor
// width but floats over it, below PHONE the side panel does too and the header bar shows icons only. A floating panel is
// opened on demand and closes when the content is clicked; the settings keep what the wide layout shows, so a panel closed
// on purpose stays closed when the window widens again.
export const NARROW = 900, PHONE = 600;

export interface PanelLayout {
    compact: boolean;                                          // the header bar shows icons only
    sidebar: { shown: boolean; floats: boolean };
    chat: { shown: boolean; floats: boolean };
}

export function layoutOf(state: Pick<State, 'width' | 'sidebar' | 'settings' | 'floating'>): PanelLayout {
    const chatFloats = state.width <= NARROW, sidebarFloats = state.width <= PHONE;
    return {
        compact: sidebarFloats,
        sidebar: { floats: sidebarFloats, shown: sidebarFloats ? state.floating.sidebar : state.sidebar },
        chat: { floats: chatFloats, shown: chatFloats ? state.floating.chat : state.settings.chat === true },
    };
}

export class Client {
    private snapshot: State = {
        ready: false, coreError: null, root: null, files: [], tabs: [], active: 0, toast: null, line: 1, column: 1, format: { block: 'paragraph', marks: [] },
        source: false, panes: P.initialLayout(), palette: false, sidebar: true, width: 1100, floating: { sidebar: false, chat: false }, settings: {}, commands: [], dialog: null, image: null, recent: [], programsMissing: 0, prefs: null, info: null, tree: { root: null, folders: {}, expanded: [], revealed: null }, outline: [], search: { form: { text: '', include: '', exclude: '', caseSensitive: false, wholeWord: false, regex: false }, replacement: '', replace: false, results: null, focus: 0 }, disabled: [],
        status: { visible: true, counts: { kind: 'text' } }, layout: { layout: '', structured: false },
        schema: null, csvFind: { n: 0, replace: false },
        history: { commits: [], more: false, note: '', changes: null, message: '', messageRev: 0 }, viewers: [],
        collab: { note: null, server: null, pulls: [] }, pull: null, pullShown: false, tokenAsk: null, sendAsk: null,
        runLogs: [], review: null, reviewShown: false, agentAsks: [], pullAsk: null, project: null, worktrees: null,
    };
    // The Assistant panel's state: a store of its own, because an answer streams in many small notices.
    readonly chat = new ChatModel(() => this.conn);
    private readonly waitingDialogs: Dialog[] = [];
    private schemaAnswer: ((fields: FieldDef[] | null) => void) | null = null;
    private schemaCount = 0;
    private tokenAnswer: ((token: string | null) => void) | null = null;
    private sendAnswer: ((answer: SendChangesAnswer | null) => void) | null = null;
    private askCount = 0;
    // The questions of the agents the core waits on, by number; the first of `agentAsks` is the one drawn.
    private readonly waiting = new Map<number, (reply: Record<string, unknown>) => void>();
    private pullAnswer: ((answer: PullRequestAnswer | null) => void) | null = null;
    private readonly listeners = new Set<() => void>();
    private conn: Connection | null = null;
    // One editor for each pane; the focused pane's is the one the commands, the find bar, and the cursor go to.
    private readonly editors = new Map<number, MarkdownEditor>();
    private get editor(): MarkdownEditor | null { return this.editors.get(this.snapshot.panes.current) ?? null; }
    // The focused pane's editor, for the Editor Inspector (components/Inspector.tsx), which only reads it.
    get currentEditor(): MarkdownEditor | null { return this.editor; }
    // A pane a file is being opened into (dropped on it from the sidebar): the next document the core shows goes there.
    private openInto: number | null = null;
    private cursorTimer: ReturnType<typeof setTimeout> | null = null;

    // ---------- Store ----------

    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    getState = (): State => this.snapshot;

    private set(patch: Partial<State>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        for (const l of this.listeners) l();
    }

    private changeTab(id: number, patch: Partial<Tab>): void {
        this.set({ tabs: this.snapshot.tabs.map(t => t.id === id ? { ...t, ...patch } : t) });
    }

    private tab(id = this.snapshot.active): Tab | undefined { return this.snapshot.tabs.find(t => t.id === id); }

    get activeTab(): Tab | undefined { return this.tab(); }

    // ---------- The editor ----------

    // The core asked to show a line of a document (a [[note#section]] link): now if its tab is the one shown, else when it is.
    private reveal: { doc: number; line: number; select?: [column: number, length: number] } | null = null;
    private applyReveal(): void {
        if (!this.reveal || this.reveal.doc !== this.snapshot.active || !this.editor) return;
        const { line, select } = this.reveal;
        if (select) this.editor.select(line, select[0], select[1]); else this.editor.reveal(line);
        this.reveal = null;
    }

    // Visual, focus, and typewriter mode are settings the core keeps; every editor draws them. Source mode is the pane's own.
    private applyModes(): void {
        const { settings, panes } = this.snapshot;
        for (const [id, editor] of this.editors) {
            editor.setVisualMode(settings.visual !== false);
            editor.setFocusMode(settings.focus === true);
            editor.setTypewriterMode(settings.typewriter === true);
            editor.setSourceMode(P.paneById(panes, id)?.source === true);
        }
    }

    // A pane's editor was made (or is gone): it shows the pane's document.
    attachEditor(pane: number, editor: MarkdownEditor | null): void {
        if (editor) this.editors.set(pane, editor); else this.editors.delete(pane);
        this.syncEditors();
        this.applyModes();
    }

    // Every editor shows the document of its pane.
    private syncEditors(): void {
        for (const [id, editor] of this.editors) {
            const doc = P.paneById(this.snapshot.panes, id)?.active ?? 0;
            const tab = this.tab(doc);
            if (tab && editor.shown !== doc) editor.show(doc, tab.mirror.text);
        }
    }

    // The panes changed: the focused pane's document is the active one, and its source mode is the one the window shows.
    private setPanes(panes: P.Layout, extra: Partial<State> = {}): void {
        const doc = P.activeDoc(panes);
        this.set({ panes, source: P.currentPane(panes).source, ...(doc ? { active: doc } : {}), ...extra });
        this.syncEditors();
        this.applyModes();
        this.applyReveal();
    }

    // The user typed in a pane: the editor reports its whole text, the mirror turns it into a small edit and the core gets it
    // at once; another pane that shows the document gets the same edit.
    typed(text: string, pane = this.snapshot.panes.current): void {
        const doc = P.paneById(this.snapshot.panes, pane)?.active ?? 0;
        const tab = this.tab(doc);
        const edit = tab?.mirror.typed(text);
        if (tab && edit) {
            this.conn?.notify('doc.edit', { ...edit });
            for (const other of P.showing(this.snapshot.panes, doc)) if (other.id !== pane) this.editors.get(other.id)?.applyFromCore(edit.changes);
        }
        if (tab) this.changeTab(tab.id, {});
    }

    // The format at the cursor and the cursor itself are the focused pane's.
    // The document a pane shows.
    paneDoc(pane: number): number { return P.paneById(this.snapshot.panes, pane)?.active ?? this.snapshot.active; }

    formatted(format: FormatAt, pane = this.snapshot.panes.current): void { if (pane === this.snapshot.panes.current) this.set({ format }); }

    moved(line: number, column: number, pane = this.snapshot.panes.current): void {
        if (pane !== this.snapshot.panes.current) return;
        this.set({ line, column });
        if (this.cursorTimer) clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => {
            const tab = this.tab(), editor = this.editor;
            if (!tab || !editor) return;
            const { offset, selection } = editor.cursor();
            this.conn?.notify('doc.cursor', { doc: tab.id, version: tab.mirror.version, offset, selection });
        }, 150);
    }

    say(text: string, action: Toast['action'] = null): void { this.set({ toast: { text, action, at: Date.now() } }); }
    dismissToast(): void { this.set({ toast: null }); }
    runToast(token: number): void { void this.conn?.request('act.token', { token }); this.dismissToast(); }

    // ---------- Actions ----------

    // A request the user caused: a refusal is told, not swallowed.
    private async ask(op: string, payload: Record<string, unknown> = {}): Promise<void> {
        const reply = await this.conn?.request(op, payload);
        if (reply && !reply.ok) this.say(reply.error.message);
    }

    async openFolder(): Promise<void> {
        const path = await window.markwork.chooseFile({ title: 'Open Folder', selectFolder: true });
        if (path) await this.ask('open.folder', { path });
    }
    openFile = (name: string): void => { void this.ask('open.file', { name }); };
    // A tab pressed in a pane: the pane shows it and has the focus; the core makes it the active document.
    selectTab = (doc: number, pane = this.snapshot.panes.current): void => {
        // A tab pressed while the review is shown brings the document back, even the one that is already the active tab.
        if (this.snapshot.pullShown) { this.set({ pullShown: false }); void this.ask('act.pull.close'); }
        if (this.snapshot.reviewShown) { this.set({ reviewShown: false }); void this.ask('act.review.close'); }
        this.setPanes(P.select(this.snapshot.panes, pane, doc));
        void this.ask('tab.select', { doc });
    };

    // A tab closed in a pane: the document closes with its last tab; while another pane shows it, only the tab goes.
    closeTab = (doc: number, pane = this.snapshot.panes.current): void => {
        const { layout, closesDocument } = P.closeTab(this.snapshot.panes, pane, doc);
        if (closesDocument) void this.ask('tab.close', { doc });
        else this.setPanes(layout);
    };

    // ---------- Panes ----------

    // A pane got the focus (a click, the keyboard): the document it shows is the active one.
    focusPane(pane: number): void {
        const { panes, active } = this.snapshot;
        if (panes.current === pane) return;
        const next = P.focus(panes, pane), doc = P.activeDoc(next);
        this.setPanes(next);
        if (doc && doc !== active) void this.ask('tab.select', { doc });
    }

    splitPane(side: Exclude<P.Zone, 'center'>, pane = this.snapshot.panes.current): void { this.setPanes(P.split(this.snapshot.panes, pane, side)); }

    // A tab dropped on a pane (`from` is the pane it came from, null for a file of the sidebar that is open already).
    dropTab(from: number | null, doc: number, to: number, zone: P.Zone): void {
        const before = this.snapshot.active;
        this.setPanes(P.drop(this.snapshot.panes, from, doc, to, zone));
        if (this.snapshot.active !== before) void this.ask('tab.select', { doc: this.snapshot.active });
    }

    // A file of the sidebar dropped on a pane: a document that is open is a tab there; one that is not is opened into it.
    dropFile(name: string, to: number, zone: P.Zone): void {
        const open = this.snapshot.tabs.find(t => t.file === name || (t.file && t.file.endsWith(`/${name}`)) || (t.file && t.file.endsWith(`\\${name}`)));
        if (open) { this.dropTab(null, open.id, to, zone); return; }
        const base = P.focus(this.snapshot.panes, to);
        this.setPanes(zone === 'center' ? base : this.emptyBeside(base, to, zone));
        this.openInto = this.snapshot.panes.current;
        setTimeout(() => { this.openInto = null; }, 5000);
        this.activateEntry(name);
    }

    // An empty pane beside `pane`, for the file about to open into it.
    private emptyBeside(panes: P.Layout, pane: number, side: Exclude<P.Zone, 'center'>): P.Layout {
        const made = P.split(panes, pane, side);
        const fresh = P.currentPane(made);
        // The split shows the same document in the new pane; the new document replaces it when the core opens it.
        return { ...made, columns: made.columns.map(c => ({ ...c, panes: c.panes.map(p => p.id === fresh.id ? { ...p, tabs: [], active: 0 } : p) })) };
    }

    closePane(pane = this.snapshot.panes.current): void { this.setPanes(P.closePane(this.snapshot.panes, pane)); this.refocus(); }
    joinPanes(): void { this.setPanes(P.joinAll(this.snapshot.panes)); this.refocus(); }
    moveToNextPane(step = 1): void { this.setPanes(P.moveToNextPane(this.snapshot.panes, step)); this.refocus(); }
    reorderTab(pane: number, doc: number, before: number | null): void { this.setPanes(P.reorder(this.snapshot.panes, pane, doc, before)); }
    resizeColumns(index: number, delta: number): void { this.set({ panes: P.resizeColumns(this.snapshot.panes, index, delta) }); }
    resizePanes(column: number, index: number, delta: number): void { this.set({ panes: P.resizePanes(this.snapshot.panes, column, index, delta) }); }

    // After the focused pane changed on its own, the core is told which document is active.
    private refocus(): void {
        const doc = P.activeDoc(this.snapshot.panes);
        if (doc) void this.ask('tab.select', { doc });
        this.editor?.focus();
    }

    // The next (or previous) tab of the focused pane, when there are several panes (the core's order is all the tabs').
    private stepTab(step: number): void {
        const pane = P.currentPane(this.snapshot.panes), doc = P.neighbor(pane, step);
        if (doc && doc !== pane.active) this.selectTab(doc, pane.id);
    }

    // A change the user made on the board: shown at once with the function the core applies, then sent.
    editNotes(edit: NoteEdit): void {
        const tab = this.tab();
        const next = tab?.board && applyNoteEdit(tab.board, edit);
        if (tab && next) this.changeTab(tab.id, { board: next });
        void this.conn?.request('act.notes.edit', { doc: this.snapshot.active, edit });
    }

    // ---------- The structured pages ----------

    // The CSV tab changed: the whole text, one undo step in the document.
    csvChange(text: string): void { void this.conn?.request('act.csv.change', { doc: this.snapshot.active, text }); }
    csvShape(rows: number, columns: number): void { void this.conn?.request('act.csv.shape', { rows, columns }); }

    // A yes-or-no question of a page (delete a card): the generic dialog, answered here.
    async confirm(message: string, detail: string, accept: string): Promise<boolean> {
        const { value } = await this.showDialog({ title: message, detail, entry: null, buttons: [{ label: accept, value: 'yes', style: 'destructive' }, { label: 'Cancel', value: 'no' }] });
        return value === 'yes';
    }

    // A line of text a page asks for (a list's name); null = dismissed.
    async promptText(title: string, label: string, value = ''): Promise<string | null> {
        const answer = await this.showDialog({ title, detail: '', entry: { label, value }, buttons: [{ label: 'OK', value: 'ok', style: 'suggested' }, { label: 'Cancel', value: 'cancel' }] });
        return answer.value === 'ok' && answer.text.trim() ? answer.text.trim() : null;
    }

    // One of several answers; null = dismissed.
    async choose(title: string, detail: string, buttons: DialogButton[]): Promise<string | null> {
        return (await this.showDialog({ title, detail, entry: null, buttons })).value;
    }

    // The Fields… dialog is answered with the fields, or null.
    answerSchema(id: number, fields: FieldDef[] | null): void {
        if (this.snapshot.schema?.id !== id) return;
        this.set({ schema: null });
        this.schemaAnswer?.(fields);
        this.schemaAnswer = null;
        this.editor?.focus();
    }

    zoomImage(image: ZoomedImage): void { this.set({ image }); }
    closeImage(): void { this.set({ image: null }); this.editor?.focus(); }

    // The folder of the active document, which its relative picture paths start from.
    baseDir(doc = this.snapshot.active): string | null {
        const file = this.tab(doc)?.file ?? null;
        const cut = file ? Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) : -1;   // C:\notes\a.md on Windows
        return file && cut >= 0 ? file.slice(0, cut) || '/' : null;
    }

    // A link Ctrl+clicked in the active document: the core decides (a note in a tab, a URL in the browser).
    openLink(url: string, doc = this.snapshot.active): void { void this.ask('open.link', { doc, url }); }

    // [[link]] Ctrl+clicked in the active document: the core finds or makes the note and opens its tab.
    openNote(link: string, doc = this.snapshot.active): void { void this.ask('open.note', { doc, link }); }

    // The notes a [[ suggestion offers for the active document.
    async noteNames(doc = this.snapshot.active): Promise<string[]> {
        const reply = await this.conn?.request('ask.notes', { doc });
        return reply?.ok ? (reply.names as string[]) : [];
    }

    focusEditor(): void { this.editor?.focus(); }
    openPalette(open = true): void { this.set({ palette: open }); }
    toggleSidebar(): void {
        if (layoutOf(this.snapshot).sidebar.floats) this.float('sidebar', !this.snapshot.floating.sidebar);
        else this.setSetting('sidebar', !this.snapshot.sidebar);
    }

    // The sections of the Files view: which are folded or hidden, and their shares of its height. The settings keep them as
    // JSON the window writes (settingskeys 'sidebar-sections'); a missing or broken value is the defaults.
    sidebarSections(): Record<SectionId, SectionState> {
        let saved: Partial<Record<SectionId, Partial<SectionState>>> = {};
        try { const parsed: unknown = JSON.parse(String(this.snapshot.settings['sidebar-sections'] || '{}')); if (parsed && typeof parsed === 'object') saved = parsed as typeof saved; } catch { /* the defaults */ }
        const result = {} as Record<SectionId, SectionState>;
        for (const id of SECTIONS) {
            const was = saved[id], base = SECTION_DEFAULTS[id];
            result[id] = { open: typeof was?.open === 'boolean' ? was.open : base.open, hidden: was?.hidden === true,
                size: typeof was?.size === 'number' && was.size > 0 ? was.size : base.size };
        }
        return result;
    }
    setSection(id: SectionId, patch: Partial<SectionState>): void { this.writeSections({ ...this.sidebarSections(), [id]: { ...this.sidebarSections()[id], ...patch } }); }
    writeSections(sections: Record<SectionId, SectionState>): void {
        this.setSetting('sidebar-sections', JSON.stringify(sections));
        this.timelineShown(sections.timeline.open && !sections.timeline.hidden);
    }
    // The core reads the history of the open file while the Timeline is shown.
    timelineShown(on: boolean): void { if (this.snapshot.settings['timeline-open'] !== on) this.setSetting('timeline-open', on); }
    collapseFolders(): void { this.set({ tree: { ...this.snapshot.tree, expanded: [] } }); }
    setSidebarWidth(px: number): void { this.setSetting('sidebar-width', Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, px)))); }

    // A rail button: its page opens; the button of the page that is open closes the side panel.
    showSidebarPage(page: string): void {
        const { sidebar, floating, settings } = this.snapshot;
        if (layoutOf(this.snapshot).sidebar.floats) {
            if (floating.sidebar && settings['sidebar-page'] === page) { this.float('sidebar', false); return; }
            if (settings['sidebar-page'] !== page) this.setSetting('sidebar-page', page);
            this.float('sidebar', true);
            return;
        }
        if (sidebar && settings['sidebar-page'] === page) { this.setSetting('sidebar', false); return; }
        this.setSetting('sidebar-page', page);
        if (!sidebar) this.setSetting('sidebar', true);
    }

    // The window was resized. A panel that starts or stops floating starts closed as a floating one.
    setWidth(width: number): void {
        const before = layoutOf(this.snapshot), after = layoutOf({ ...this.snapshot, width });
        const floating = { ...this.snapshot.floating };
        if (before.sidebar.floats !== after.sidebar.floats) floating.sidebar = false;
        if (before.chat.floats !== after.chat.floats) floating.chat = false;
        this.set({ width, floating });
    }

    // Open or close a floating panel; closeFloating() closes both (a click on the content, Escape). There is room for one
    // floating panel at a time, so opening one closes the other if that one floats too.
    float(panel: 'sidebar' | 'chat', open: boolean): void {
        const other = panel === 'chat' ? 'sidebar' : 'chat';
        const floating = { ...this.snapshot.floating, [panel]: open };
        if (open && layoutOf(this.snapshot)[other].floats) floating[other] = false;
        this.set({ floating });
        if (panel === 'chat' && open) this.chat.focusInput();
    }
    closeFloating(): void {
        const { floating } = this.snapshot;
        if (floating.sidebar || floating.chat) this.set({ floating: { sidebar: false, chat: false } });
    }

    // ---------- Preferences, Keyboard Shortcuts, About ----------

    // A change in the dialog: shown at once, written by the core, which sends the values again (a refused one comes back as they were).
    setPreference(key: string, value: string | number | boolean): void {
        const { prefs } = this.snapshot;
        if (prefs) this.set({ prefs: { ...prefs, [key]: value } });
        void this.ask('act.prefs.set', { key, value });
    }
    closePreferences(): void { this.set({ prefs: null, project: null, worktrees: null }); void this.conn?.request('act.prefs.closed', {}); this.editor?.focus(); }
    showInfo(info: State['info']): void { this.set({ info }); }

    // ---------- Home ----------

    openRecent(path: string): void { void this.ask('act.home.openFile', { path }); }
    openWorkspaceFile(name: string): void { void this.ask('act.home.openWorkspaceFile', { name }); }
    openRun(id: number): void { void this.ask('act.home.openRun', { id }); }
    openJournal(): void { void this.ask('act.home.openJournal'); }

    // ---------- Programs ----------

    openPrograms(): void { void this.ask('act.programs.open'); }
    checkPrograms(): void { void this.ask('act.programs.check'); }
    hideSetup(): void { void this.ask('act.programs.hideSetup'); }
    runAgentsHere(): void { void this.ask('act.programs.runHere'); }
    openTerminalFor(machine: string | null): void { void this.ask('act.programs.openTerminal', { machine }); }
    openProgramSite(name: string): void { void this.ask('act.programs.openSite', { name }); }
    // A task checked on Home: true = the core wrote it to its board, false = put the box back.
    async toggleTask(task: unknown, done: boolean): Promise<boolean> {
        const reply = await this.conn?.request('act.home.toggleTask', { task, done });
        return reply?.ok === true && reply.written === true;
    }

    // ---------- The Files tree ----------

    private expandFolder(dir: string): void {
        const { tree } = this.snapshot;
        if (tree.expanded.includes(dir)) return;
        if (!tree.folders[dir]) void this.conn?.request('act.tree.openFolder', { dir });
        this.set({ tree: { ...tree, expanded: [...tree.expanded, dir] } });
    }

    // Highlight a file, with the folders above it open.
    private revealPath(path: string | null): void {
        const { tree } = this.snapshot;
        this.set({ tree: { ...tree, revealed: path } });
        if (!path || !tree.root || !path.startsWith(tree.root)) return;
        const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
        const parts = path.slice(tree.root.length + 1).split(sep).slice(0, -1);
        let dir = tree.root;
        for (const part of parts) { dir = `${dir}${sep}${part}`; this.expandFolder(dir); }
    }

    toggleFolder(dir: string): void {
        const { tree } = this.snapshot;
        if (tree.expanded.includes(dir)) this.set({ tree: { ...tree, expanded: tree.expanded.filter(d => d !== dir) } });
        else this.expandFolder(dir);
    }

    activateEntry = (path: string): void => { void this.ask('act.tree.activate', { path }); };
    createEntry(kind: NewKind, dir: string): void { void this.ask('act.tree.create', { kind, dir }); }
    renameEntry(path: string): void { void this.ask('act.tree.rename', { path }); }
    removeEntry(path: string): void { void this.ask('act.tree.remove', { path }); }
    moveEntry(source: string, dir: string): void { void this.ask('act.tree.move', { source, dir }); }
    copyInto(sources: string[], dir: string): void { if (sources.length) void this.ask('act.tree.copy', { sources, dir }); }

    // ---------- Search in all notes ----------

    // Show the Search page with the selected text as the query (Ctrl+Shift+F), and the Replace row too (Ctrl+Shift+H).
    showSearch(replace = false): void {
        const selected = this.editor?.selectedText ?? '';
        const { search } = this.snapshot;
        const form = selected && !selected.includes('\n') ? { ...search.form, text: selected } : search.form;
        if (this.snapshot.settings['sidebar-page'] !== 'search' || !this.snapshot.sidebar) { this.setSetting('sidebar-page', 'search'); this.setSetting('sidebar', true); }
        this.set({ search: { ...search, form, replace: replace || search.replace, focus: search.focus + 1 } });
        if (form.text) this.runSearch(form);
    }

    setSearchForm(patch: Partial<SearchPanel>): void {
        const search = { ...this.snapshot.search, ...patch };
        this.set({ search });
        if (patch.form) this.runSearch(search.form);
    }

    private runSearch(query: SearchQuery): void { void this.ask('act.search.run', { query }); }
    openHit(file: string, index: number): void { void this.ask('act.search.openHit', { file, index }); }
    replaceAll(): void { void this.ask('act.search.replaceAll', { replacement: this.snapshot.search.replacement }); }

    jumpToHeading(index: number): void { void this.ask('act.outline.jump', { index }); }

    // ---------- History ----------

    refreshHistory = (): void => { void this.ask('act.history.refresh'); };
    moreHistory = (): void => { void this.ask('act.history.more'); };
    openCommit = (hash: string): void => { void this.ask('act.history.open', { hash }); };
    openChanges = (path: string): void => { void this.ask('act.history.openChanges', { path }); };

    // An error to show, or null once the commit is made.
    async commitFiles(files: string[], message: string): Promise<string | null> {
        const reply = await this.conn?.request('act.history.commit', { files, message });
        if (!reply) return 'The core is not running';
        return reply.ok ? (reply.error as string | null) : reply.error.message;
    }

    // 'done' (the core asked and threw the changes away), 'declined', or an error to show.
    async discardFile(path: string): Promise<DiscardOutcome> {
        const reply = await this.conn?.request('act.history.discard', { path });
        return reply?.ok ? reply.outcome as DiscardOutcome : { error: reply && !reply.ok ? reply.error.message : 'The core is not running' };
    }

    // The assistant writes the commit message from these files; it streams into the form as history.messageText.
    async writeMessage(files: string[]): Promise<WriteResult> {
        const reply = await this.conn?.request('act.history.write', { files });
        return reply?.ok ? reply.result as WriteResult : { ok: false, reason: 'failed', message: reply && !reply.ok ? reply.error.message : 'The core is not running' };
    }
    stopWriting = (): void => { void this.ask('act.history.stopWriting'); };

    private changeViewer(id: number, patch: Partial<Viewer>): void {
        this.set({ viewers: this.snapshot.viewers.map(v => v.id === id ? { ...v, ...patch } : v) });
    }

    async viewerCommit(viewer: number, message: string): Promise<string | null> {
        const reply = await this.conn?.request('act.historyViewer.commit', { viewer, message });
        if (!reply) return 'The core is not running';
        return reply.ok ? (reply.error as string | null) : reply.error.message;
    }
    async viewerDiscard(viewer: number): Promise<DiscardOutcome> {
        const reply = await this.conn?.request('act.historyViewer.discard', { viewer });
        return reply?.ok ? reply.outcome as DiscardOutcome : { error: reply && !reply.ok ? reply.error.message : 'The core is not running' };
    }
    async viewerWrite(viewer: number): Promise<WriteResult> {
        const reply = await this.conn?.request('act.historyViewer.write', { viewer });
        return reply?.ok ? reply.result as WriteResult : { ok: false, reason: 'failed', message: reply && !reply.ok ? reply.error.message : 'The core is not running' };
    }
    viewerStopWriting = (viewer: number): void => { void this.ask('act.historyViewer.stopWriting', { viewer }); };
    closeViewer(viewer: number): void {
        this.set({ viewers: this.snapshot.viewers.filter(v => v.id !== viewer) });
        void this.ask('act.historyViewer.closed', { viewer });
        this.editor?.focus();
    }

    // ---------- Pull requests ----------

    openPull = (number: number): void => { void this.ask('act.collab.open', { number }); };
    refreshPulls = (): void => { void this.ask('act.collab.refresh'); };
    editServer = (): void => { void this.ask('act.collab.server'); };
    sendChanges = (): void => { void this.ask('act.collab.send'); };

    closePull(): void { this.set({ pullShown: false }); void this.ask('act.pull.close'); this.editor?.focus(); }
    selectPullFile = (path: string): void => {
        if (this.snapshot.pull) this.set({ pull: { ...this.snapshot.pull, selected: path } });
        void this.ask('act.pull.select', { path });
    };
    mergePull = (method: MergeMethod): void => { void this.ask('act.pull.merge', { method }); };
    pullInBrowser = (): void => { void this.ask('act.pull.browser'); };
    commentOnPull = (text: string): void => { void this.ask('act.pull.comment', { text }); };
    resolvePull = (): void => { void this.ask('act.pull.resolve'); };
    finishPull = (): void => { void this.ask('act.pull.finish'); };
    abortPull = (): void => { void this.ask('act.pull.abort'); };

    // The token dialog: the token to save, '' to forget the saved one, null for Cancel. Test tries a token without saving it.
    answerToken(id: number, token: string | null): void {
        if (this.snapshot.tokenAsk?.id !== id) return;
        this.set({ tokenAsk: null });
        this.tokenAnswer?.(token);
        this.tokenAnswer = null;
        this.editor?.focus();
    }
    async testToken(id: number, token: string): Promise<string> {
        const reply = await this.conn?.request('act.collab.testToken', { ask: id, token });
        if (!reply) throw new Error('The core is not running');
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.message as string;
    }

    // The form that sends changes: the answer, or null for Cancel.
    answerSend(id: number, answer: SendChangesAnswer | null): void {
        if (this.snapshot.sendAsk?.id !== id) return;
        this.set({ sendAsk: null });
        this.sendAnswer?.(answer);
        this.sendAnswer = null;
        this.editor?.focus();
    }

    // ---------- Agents ----------

    // A card's menu: the harness entries of the core, or none (a card that is gone, a board grouped by a field).
    async cardMenu(column: number, index: number, text: string): Promise<CardMenuEntry[]> {
        const reply = await this.conn?.request('act.card.menu', { column, index, text });
        return reply?.ok ? reply.entries as CardMenuEntry[] : [];
    }
    runCardEntry = (token: number): void => { void this.ask('act.card.run', { token }); };

    // Open the log of a run again, or raise the window that is open.
    closeRunLog(run: number): void {
        this.set({ runLogs: this.snapshot.runLogs.filter(l => l.run !== run) });
        void this.ask('act.runlog.closed', { run });
        this.editor?.focus();
    }

    // The question of an agent, answered; the next one waits behind it. `{}` is "no answer".
    answerAsk(id: number, reply: Record<string, unknown>): void {
        const resolve = this.waiting.get(id);
        if (!resolve) return;
        this.waiting.delete(id);
        this.set({ agentAsks: this.snapshot.agentAsks.filter(a => a.id !== id) });
        resolve(reply);
        if (!this.snapshot.agentAsks.length) this.editor?.focus();
    }

    private askAgent(make: (id: number) => AgentAsk, cancel: CancelSignal): Promise<Record<string, unknown>> {
        return new Promise(resolve => {
            const ask = make(++this.askCount);
            this.waiting.set(ask.id, resolve);
            this.set({ agentAsks: [...this.snapshot.agentAsks, ask] });
            cancel.onCancel(() => this.answerAsk(ask.id, {}));
        });
    }

    closeReview(): void { this.set({ reviewShown: false }); void this.ask('act.review.close'); this.editor?.focus(); }
    selectReviewFile = (index: number): void => {
        if (this.snapshot.review) this.set({ review: { ...this.snapshot.review, selected: index } });
        void this.ask('act.review.select', { index });
    };
    includeReviewFile = (index: number, included: boolean): void => { void this.ask('act.review.include', { index, included }); };
    finishReview = (action: string): void => { void this.ask('act.review.finish', { action }); };
    reviewTab = (tab: ReviewTab): void => {
        if (this.snapshot.review) this.set({ review: { ...this.snapshot.review, tab } });
        void this.ask('act.review.tab', { tab });
    };
    commentOnReview = (line: number, text: string): void => { void this.ask('act.review.comment', { line, text }); };
    reviewAction = (action: 'pullRequest' | 'reply' | 'folder' | 'terminal' | 'log' | 'banner'): void => { void this.ask(`act.review.${action}`); };

    // The form that sends a worktree's branch as a pull request: the answer, or null for Cancel.
    answerPullRequest(id: number, answer: PullRequestAnswer | null): void {
        if (this.snapshot.pullAsk?.id !== id) return;
        this.set({ pullAsk: null });
        this.pullAnswer?.(answer);
        this.pullAnswer = null;
        this.editor?.focus();
    }

    // Preferences → Agents.
    addMachine = (): void => { void this.ask('act.prefs.addMachine'); };
    removeMachine = (name: string): void => { void this.ask('act.prefs.removeMachine', { name }); };
    openProject = (name: string): void => { this.set({ project: null, worktrees: null }); void this.ask('act.prefs.openProject', { name }); };
    closeProject = (): void => { this.set({ project: null, worktrees: null }); };
    // An error to show, or null once the change is written (the core sends the page again).
    async setProject(name: string, patch: Record<string, unknown>): Promise<string | null> {
        const reply = await this.conn?.request('act.prefs.setProject', { name, patch });
        if (!reply) return 'The core is not running';
        return reply.ok ? reply.error as string | null : reply.error.message;
    }
    async removeWorktree(name: string, path: string): Promise<string | null> {
        const reply = await this.conn?.request('act.prefs.removeWorktree', { name, path });
        if (!reply) return 'The core is not running';
        return reply.ok ? reply.error as string | null : reply.error.message;
    }

    // ---------- Settings ----------

    // Shown at once, then written by the core, which sends the value back.
    setSetting(key: string, value: unknown): void {
        this.applySettings({ [key]: value });
        this.conn?.notify('setting', { key, value });
    }

    private applySettings(changed: Record<string, unknown>): void {
        const opened = (key: string) => changed[key] === true && this.snapshot.settings[key] !== true;
        const settings = { ...this.snapshot.settings, ...changed };
        this.set({ settings, sidebar: settings.sidebar !== false });
        // Something opened a panel (the core asks the Assistant for a journal summary) while it floats: show it floating.
        const panels = layoutOf(this.snapshot);
        if (opened('chat') && panels.chat.floats) this.float('chat', true);
        if (opened('sidebar') && panels.sidebar.floats) this.float('sidebar', true);
        // 'system' follows the system theme (the media query of theme.css); 'light' and 'dark' win over it.
        this.applyModes();
        const scheme = settings['color-scheme'];
        if (scheme === 'light' || scheme === 'dark') document.documentElement.dataset.theme = scheme;
        else delete document.documentElement.dataset.theme;
    }

    // The argument of an on/off command run from a key or the palette: the opposite of what is shown now.
    private toggled(command: Command): boolean | undefined {
        const { settings } = this.snapshot;
        if (command.id === 'kanban-view') return !this.snapshot.layout.structured;
        if (command.id === 'source') return !this.snapshot.source;
        if (command.id === 'dark') return settings['color-scheme'] !== 'dark';
        if (command.kind === 'setting') return settings[command.id] !== true;
        return undefined;
    }

    // ---------- Dialogs ----------

    // Show a dialog, or queue it behind the one shown. cancel = the core withdrew the question: it closes unanswered.
    showDialog(spec: Omit<Dialog, 'close'>, cancel?: CancelSignal): Promise<{ value: string | null; text: string }> {
        return new Promise(resolve => {
            let stop: (() => void) | undefined;
            const dialog: Dialog = {
                ...spec,
                close: (value, text) => {
                    stop?.();
                    const at = this.waitingDialogs.indexOf(dialog);
                    if (at < 0) return;
                    this.waitingDialogs.splice(at, 1);
                    this.set({ dialog: this.waitingDialogs[0] ?? null });
                    resolve({ value, text });
                },
            };
            this.waitingDialogs.push(dialog);
            this.set({ dialog: this.waitingDialogs[0] });
            stop = cancel?.onCancel(() => dialog.close(null, ''));
        });
    }

    // Any question of the core this window has no dialog of its own for: a `Question` (yes or no) or a `Prompt` (a line
    // of text), drawn with the generic dialog (app/protocol/asks.ts).
    private genericAsk = (op: string): Handler | null => {
        if (!op.startsWith('ask.')) return null;
        return async (p, cancel) => {
            if (p.question && typeof p.question === 'object') {
                const q = p.question as Question;
                const { value } = await this.showDialog({
                    title: q.message, detail: q.detail, entry: null,
                    buttons: [{ label: q.accept, value: 'yes', style: q.destructive ? 'destructive' : 'suggested' }, { label: 'Cancel', value: 'no' }],
                }, cancel);
                return { answer: value === 'yes' };
            }
            if (p.prompt && typeof p.prompt === 'object') {
                const q = p.prompt as Prompt;
                const { value, text } = await this.showDialog({
                    title: q.title, detail: '', entry: { label: q.label, value: q.value ?? '' },
                    buttons: [{ label: q.accept ?? 'OK', value: 'ok', style: 'suggested' }, { label: 'Cancel', value: 'cancel' }],
                }, cancel);
                return value === 'ok' ? { text } : {};
            }
            throw new RequestError('unknown_op', `no dialog for ${op}`);
        };
    };

    // Whether a command applies now: this window carries it out, and the core has not said it does not apply to what is
    // shown (commands.state).
    enabled(command: Command): boolean {
        if (!isAvailable(command) || this.snapshot.disabled.includes(command.id)) return false;
        return command.scope === 'always' || this.snapshot.tabs.length > 0;
    }

    // The half of FrontendCommands that is this window's: its editor and its own panels.
    private frontendCommands(): FrontendCommands {
        const editor = this.editor;
        const none = () => this.say('This is not available in this window yet');
        return {
            edit: editor?.edit ?? ({ undo: none, redo: none, wrap: none, link: none, block: none, prefix: none, heading: none, lineKind: none, moveBlock: none, table: none, zoomImage: none }),
            openFind: replace => {
                if (this.tab()?.page === 'csv') this.set({ csvFind: { n: this.snapshot.csvFind.n + 1, replace: replace === true } });
                else if (editor) editor.openFind(replace === true); else none();
            },
            showSearch: replace => this.showSearch(replace === true),
            setSource: on => this.setPanes(P.setSource(this.snapshot.panes, this.snapshot.panes.current, on)),
            splitPane: side => this.splitPane(side),
            closePane: () => this.closePane(),
            moveToNextPane: () => this.moveToNextPane(),
            showPalette: () => this.openPalette(),
            showShortcuts: () => this.showInfo('shortcuts'), showAbout: () => this.showInfo('about'),
            quit: () => window.close(),
        };
    }

    run(id: string, arg?: boolean | string): void {
        const command = COMMANDS.find(c => c.id === id);
        if (!command || !this.enabled(command)) return;
        if ((id === 'next-tab' || id === 'prev-tab') && !P.isSolo(this.snapshot.panes)) { this.stepTab(id === 'next-tab' ? 1 : -1); return; }
        const argument = arg ?? this.toggled(command);
        // The core's table says where a command runs; the window's own copy is the fallback before `hello` arrives.
        const runs = this.snapshot.commands.find(c => c.id === id)?.runs ?? command.runs;
        // A setting command is the setting of the same name (app/commands.ts): the frontend writes it.
        const panels = layoutOf(this.snapshot);
        if ((id === 'chat' && panels.chat.floats) || (id === 'sidebar' && panels.sidebar.floats)) {
            this.float(id, arg === undefined ? !this.snapshot.floating[id] : arg === true);
            return;
        }
        if (command.kind === 'setting') {
            // The visual editor and source mode exclude each other: turning the visual editor on leaves source mode.
            if (id === 'visual' && argument === true && this.snapshot.source) this.run('source', false);
            this.setSetting(id, argument === true);
            if (id === 'chat' && argument === true) this.chat.focusInput();
            return;
        }
        if (runs === 'core') {
            void this.ask('command', { name: id, arg: argument });
            return;
        }
        // The editor commands only use the part of the host that is theirs.
        command.run(this.frontendCommands() as never, argument);
    }

    // ---------- The core's side of the conversation ----------

    connect(port: MessagePort): void {
        const c = new Connection(m => port.postMessage(m), 'f');
        this.conn = c;
        port.onmessage = ({ data }: MessageEvent<Message>) => c.receive(data);

        c.onNotice((ev, p) => this.notice(ev, p));
        c.on('doc.replace', p => {
            const tab = this.tab(p.doc as number);
            if (!tab) throw new RequestError('stale', 'that document is closed');
            const result = tab.mirror.replace(p.base as number, p.changes as Change[]);
            if (!result.ok) throw new RequestError('conflict', 'text changed', { version: result.version });
            for (const pane of P.showing(this.snapshot.panes, tab.id)) this.editors.get(pane.id)?.applyFromCore(result.applied);
            this.changeTab(tab.id, {});
            return result;
        });
        c.on('doc.close', p => { this.dropDoc(p.doc as number); });
        c.on('doc.resync', p => {
            const tab = this.tab(p.doc as number);
            if (!tab) throw new RequestError('stale', 'that document is closed');
            return tab.mirror.snapshot(0);
        });
        c.on('ask.saveChanges', async (p, cancel) => {
            const { value } = await this.showDialog({
                title: 'Save Changes?', detail: `${String(p.document)} contains unsaved changes. Changes which are not saved will be permanently lost.`,
                entry: null,
                buttons: [{ label: 'Save', value: 'save', style: 'suggested' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Cancel', value: 'cancel' }],
            }, cancel);
            return { answer: value ?? 'cancel' };
        });
        c.on('ask.schema', (p, cancel) => new Promise(resolve => {
            const id = ++this.schemaCount;
            this.schemaAnswer = fields => resolve(fields ? { fields } : {});
            this.set({ schema: { id, options: p as unknown as SchemaDialogOptions } });
            cancel?.onCancel(() => this.answerSchema(id, null));
        }));
        // A change the agent proposes: the review is the user's, and the answer is their note.
        c.on('ask.proposal', (p, cancel) => this.chat.ask(p, listener => { cancel.onCancel(listener); }));
        c.on('ask.discard', async (p, cancel) => {
            const { heading, detail, accept } = discardPrompt(p.kind as ChangeKind, String(p.path));
            const { value } = await this.showDialog({ title: heading, detail, entry: null, buttons: [{ label: accept, value: 'yes', style: 'destructive' }, { label: 'Cancel', value: 'no' }] }, cancel);
            return { answer: value === 'yes' };
        });
        c.on('ask.token', (p, cancel) => new Promise(resolve => {
            const id = ++this.askCount;
            this.tokenAnswer = token => resolve(token === null ? {} : { token });
            this.set({ tokenAsk: { id, repo: p.repo as RepoRef, hasToken: p.hasToken === true, source: (p.source as TokenSource | null) ?? null } });
            cancel.onCancel(() => this.answerToken(id, null));
        }));
        c.on('ask.sendChanges', (p, cancel) => new Promise(resolve => {
            const id = ++this.askCount;
            this.sendAnswer = answer => resolve(answer ? { answer } : {});
            this.set({ sendAsk: { id, options: p.options as SendChangesOptions } });
            cancel.onCancel(() => this.answerSend(id, null));
        }));
        c.on('ask.file', async p => ({ path: await window.markwork.chooseFile(p as unknown as ChooseFileOptions) }));
        c.on('ask.folder', async p => {
            const path = await window.markwork.chooseFile({ title: String(p.title), selectFolder: true });
            return path ? { path } : {};
        });
        // What a harness waits for, a line for the agent, a machine to add; the answers are read again by the core.
        c.on('ask.harness.answer', async (p, cancel) => {
            const reply = await this.askAgent(id => ({ id, kind: 'answer', ask: p.ask as HarnessAsk, agent: String(p.agent) }), cancel);
            return reply;
        });
        c.on('ask.text', (p, cancel) => {
            const o = p.options as { title: string; label: string; context?: string; text?: string };
            return this.askAgent(id => ({ id, kind: 'text', title: o.title, label: o.label, context: o.context ?? '', text: o.text ?? '' }), cancel);
        });
        c.on('ask.machine', (p, cancel) => this.askAgent(id => ({ id, kind: 'machine', taken: (p.taken as string[]) ?? [] }), cancel));
        c.on('ask.closeAgents', async (p, cancel) => {
            const a = p.activity as { children: number; detachable: number; queued: number };
            const stopping = a.children + a.queued, keeping = a.detachable;
            const detail = [
                stopping ? `${stopping} ${stopping === 1 ? 'agent works' : 'agents work'} in this window and will be stopped.` : '',
                keeping ? `${keeping} ${keeping === 1 ? 'agent works' : 'agents work'} on a machine and can go on without this window.` : '',
            ].filter(Boolean).join(' ');
            const buttons: DialogButton[] = [{ label: 'Cancel', value: 'cancel' }, ...keeping ? [{ label: 'Keep Them Going', value: 'keep' }] : [], { label: 'Stop Agents and Quit', value: 'stop', style: 'destructive' as const }];
            const { value } = await this.showDialog({ title: 'Agents are still working', detail, entry: null, buttons }, cancel);
            return { answer: value ?? 'cancel' };
        });
        c.on('ask.pullRequest', (p, cancel) => new Promise(resolve => {
            const id = ++this.askCount;
            this.pullAnswer = answer => resolve(answer ? { answer } : {});
            this.set({ pullAsk: { id, options: p.options as PullRequestOptions } });
            cancel.onCancel(() => this.answerPullRequest(id, null));
        }));
        c.onOther(this.genericAsk);

        void (async () => {
            const hello = await c.request('hello', { proto: 1, frontend: 'electron' });
            if (hello.ok) {
                this.set({ commands: (hello.commands as CommandEntry[] | undefined) ?? [] });
                this.applySettings((hello.settings as Record<string, unknown> | undefined) ?? {});
            }
            await c.request('start', { path: await window.markwork.initialFolder() });
            await this.chat.sync();
            c.notify('window.active', { active: true });
            this.set({ ready: true });
        })();
    }

    // The window was asked to close: the core asks about unsaved documents, then the window goes (or stays).
    async closeRequested(): Promise<void> {
        const reply = await this.conn?.request('app.close', {});
        if (!this.conn || (reply?.ok && reply.allowed === true)) await window.markwork.closeWindow();
    }

    coreExited(code: number | null, stderr: string): void {
        this.conn = null;
        this.set({ coreError: stderr || `The core exited with code ${code}` });
    }

    windowActive(active: boolean): void { this.conn?.notify('window.active', { active }); }

    // The review is a page of the content area; the next page the core shows (a document, Home) takes its place.
    private leaveReview(): void { if (this.snapshot.pullShown || this.snapshot.reviewShown) this.set({ pullShown: false, reviewShown: false }); }

    // A document or a page was opened: a tab of the focused pane (or of the pane a file was dropped on).
    private addTab(id: number): void {
        const into = this.openInto;
        this.openInto = null;
        this.setPanes(P.open(into !== null ? P.focus(this.snapshot.panes, into) : this.snapshot.panes, id));
    }

    // The core made a document the active one: the pane that has it shows it (see panes.ts show); a file dropped on a pane opens there.
    private showDoc(id: number): void {
        const into = this.openInto;
        this.openInto = null;
        const panes = into !== null && P.paneById(this.snapshot.panes, into) ? P.open(P.focus(this.snapshot.panes, into), id) : P.show(this.snapshot.panes, id);
        this.setPanes(panes);
    }

    // A document or a page was closed: its tab goes from every pane.
    private dropDoc(id: number): void {
        for (const editor of this.editors.values()) editor.forget(id);
        this.setPanes(P.close(this.snapshot.panes, id), { tabs: this.snapshot.tabs.filter(t => t.id !== id) });
    }

    private notice(ev: string, p: Record<string, unknown>): void {
        if (ev.startsWith('chat.') && this.chat.notice(ev, p)) return;
        const id = p.doc as number;
        const tab = this.tab(id);
        switch (ev) {
            case 'doc.open':
                this.set({ tabs: [...this.snapshot.tabs, { id, mirror: new DocMirror(id, p.text as string, p.version as number), name: 'Untitled', file: null, place: null, page: 'text', board: null, groupField: null, agents: true, capture: 0, csv: null, csvRev: 0, home: null, programs: null, html: null, runs: {} }] });
                this.addTab(id);
                break;
            case 'page.open': {
                const page = p.page as number, kind = p.kind as string, file = p.file as string | null;
                this.set({ tabs: [...this.snapshot.tabs, {
                    id: page, mirror: new DocMirror(page, '', 0), name: kind === 'home' ? 'Home' : kind === 'programs' ? 'Programs' : (file?.split(/[\\/]/).pop() ?? 'Page'), file, place: null, page: kind, board: null, groupField: null, agents: true, capture: 0, csv: null, csvRev: 0,
                    home: null, programs: null, html: kind === 'html' ? { file: file!, root: p.root as string } : null, runs: {},
                }] });
                this.addTab(page);
                break;
            }
            case 'page.close': this.dropDoc(p.page as number); break;
            case 'page.active': this.leaveReview(); this.showDoc(p.page as number); break;
            case 'view.home': {
                this.leaveReview();
                const home = this.snapshot.tabs.find(t => t.page === 'home');
                if (home) this.changeTab(home.id, { home: p.data as HomeData });
                break;
            }
            case 'view.programs': {
                this.leaveReview();
                const programs = this.snapshot.tabs.find(t => t.page === 'programs');
                if (programs) this.changeTab(programs.id, { programs: p.data as ProgramsData });
                break;
            }
            case 'programs.missing': this.set({ programsMissing: p.count as number }); break;
            case 'doc.reset':
                if (!tab) break;
                tab.mirror.reset(p.text as string, p.version as number);
                this.changeTab(id, { board: null });
                for (const pane of P.showing(this.snapshot.panes, id)) this.editors.get(pane.id)?.reset(p.text as string);
                break;
            case 'doc.active': this.leaveReview(); this.showDoc(id); break;
            case 'doc.select': this.reveal = { doc: id, line: p.line as number, select: [p.column as number, p.length as number] }; this.applyReveal(); break;
            case 'doc.reveal': this.reveal = { doc: id, line: p.line as number }; this.applyReveal(); break;
            case 'doc.title': {
                const title = p.title as { name: string; file: string | null; place: string | null };
                this.changeTab(id, { name: title.name, file: title.file, place: title.place ?? null });
                for (const pane of P.showing(this.snapshot.panes, id)) this.editors.get(pane.id)?.rebuild();
                break;
            }
            case 'doc.saved': tab?.mirror.savedAt(p.version as number); this.changeTab(id, {}); break;
            case 'view.page': this.leaveReview(); this.changeTab(id, { page: p.page as string }); break;
            case 'view.notes': this.changeTab(id, { board: p.board as Board, page: p.page as string, groupField: (p.groupField as string | null) ?? null, agents: p.agents !== false }); break;
            case 'view.csv': this.changeTab(id, { csv: p.text as string, csvRev: (tab?.csvRev ?? 0) + 1 }); break;
            case 'view.focusCapture': this.changeTab(id, { capture: (tab?.capture ?? 0) + 1 }); break;
            case 'view.files': this.set({ root: p.root as string, files: p.files as string[] }); break;
            case 'toast': this.say(p.text as string, (p.action as Toast['action']) ?? null); break;
            case 'error': this.say(p.message as string); break;
            case 'view.tree.root': {
                const root = p.root as string | null;
                this.set({ tree: { root, folders: root ? { [root]: p.entries as FolderEntry[] } : {}, expanded: [], revealed: null } });
                break;
            }
            case 'view.tree.folder': this.set({ tree: { ...this.snapshot.tree, folders: { ...this.snapshot.tree.folders, [p.dir as string]: p.entries as FolderEntry[] } } }); break;
            case 'view.tree.expand': this.expandFolder(p.dir as string); break;
            case 'view.tree.reveal': this.revealPath(p.path as string | null); break;
            case 'recent': this.set({ recent: p.paths as string[] }); break;
            case 'view.prefs.open': this.set({ prefs: p.data as PreferencesData }); break;
            case 'view.prefs.values': if (this.snapshot.prefs) this.set({ prefs: p.data as PreferencesData }); break;
            case 'view.search': this.set({ search: { ...this.snapshot.search, results: p.results as SearchResults } }); break;
            case 'view.outline': this.set({ outline: p.headings as State['outline'] }); break;
            case 'view.image': this.set({ image: { src: appUrl(p.path as string), title: String(p.path).split(/[\\/]/).pop() ?? '' } }); break;
            case 'view.history': this.set({ history: { ...this.snapshot.history, commits: p.commits as Commit[], more: p.more === true, note: String(p.note ?? '') } }); break;
            case 'view.historyChanges': this.set({ history: { ...this.snapshot.history, changes: p as unknown as HistoryChanges } }); break;
            case 'history.messageText': this.set({ history: { ...this.snapshot.history, message: p.text as string, messageRev: this.snapshot.history.messageRev + 1 } }); break;
            case 'view.historyViewer.open':
                this.set({ viewers: [...this.snapshot.viewers, { id: p.viewer as number, file: p.file as string, commit: (p.commit as Commit | null) ?? null, diff: null, content: null, message: '', messageRev: 0 }] });
                break;
            case 'view.historyViewer.diff': this.changeViewer(p.viewer as number, { diff: p.diff as HistoryText }); break;
            case 'view.historyViewer.content': this.changeViewer(p.viewer as number, { content: p.text as string }); break;
            case 'view.historyViewer.messageText': {
                const viewer = this.snapshot.viewers.find(v => v.id === p.viewer);
                if (viewer) this.changeViewer(viewer.id, { message: p.text as string, messageRev: viewer.messageRev + 1 });
                break;
            }
            case 'view.historyViewer.close': this.set({ viewers: this.snapshot.viewers.filter(v => v.id !== p.viewer) }); break;
            case 'view.collab': this.set({ collab: { note: (p.note as string | null) ?? null, server: (p.server as string | null) ?? null, pulls: p.pulls as CollabSnapshot['pulls'] } }); break;
            case 'view.pull': this.set({ pull: p as unknown as PullSnapshot }); break;
            case 'view.pull.show': this.set({ pullShown: true, reviewShown: false }); break;
            case 'view.review': this.set({ review: p as unknown as ReviewSnapshot }); break;
            case 'view.review.show': this.set({ reviewShown: true, pullShown: false }); break;
            case 'view.runs': this.changeTab(id, { runs: Object.fromEntries((p.runs as { card: string; status: string }[]).map(r => [r.card, r.status])) }); break;
            case 'view.runlog.open': {
                const run = p.run as number, title = String(p.title);
                const open = this.snapshot.runLogs.find(l => l.run === run);
                if (open) { this.set({ runLogs: [...this.snapshot.runLogs.filter(l => l.run !== run), { ...open, title }] }); break; }
                const log = new TraceReplica();
                log.onClear = () => { void this.ask('act.runlog.clear', { run }); };
                log.onChange = () => this.set({ runLogs: this.snapshot.runLogs.map(l => l.run === run ? { ...l, rev: l.rev + 1 } : l) });
                this.set({ runLogs: [...this.snapshot.runLogs, { run, title, log, rev: 0 }] });
                break;
            }
            case 'view.runlog.update': this.snapshot.runLogs.find(l => l.run === p.run)?.log.apply(p.update as TraceUpdate); break;
            case 'view.prefs.project': this.set({ project: p.page as ProjectPage, worktrees: null }); break;
            case 'view.prefs.worktrees': if (this.snapshot.project?.name === (p.list as WorktreeList).project) this.set({ worktrees: p.list as WorktreeList }); break;
            case 'open.uri': window.open(p.uri as string); break;
            case 'setting': this.applySettings({ [p.key as string]: p.value }); break;
            case 'commands.state': this.set({ disabled: p.disabled as string[] }); break;
            case 'view.status': this.set({ status: { visible: p.visible !== false, counts: p.counts as StatusCounts } }); break;
            case 'view.layout': this.set({ layout: { layout: p.layout as string | null, structured: p.structured === true } }); break;
            case 'find.close': this.editor?.closeFind(); break;
            // A desktop notification only when the window does not have the focus; otherwise the toast says it.
            case 'notify':
                if (!document.hasFocus()) new Notification(p.title as string, { body: p.body as string, tag: p.id as string });
                break;
            case 'reveal.folder': void window.markwork.openFolder(p.path as string); break;
        }
    }
}
