// Files panel: a folder tree containing subfolders and Markdown files.
//
// - The contents of a new subfolder are read when that folder is opened (lazy), so a large folder
//   still opens quickly. Until then, the subfolder holds a single empty row
//   as a placeholder so the ▸ marker still shows.
// - Every folder that has been read is watched with a Gio.FileMonitor. If a
//   file is added or removed on disk, only the changed rows are
//   inserted/removed, so a subfolder that is open does not get closed.
// - Hidden files and folders (starting with a dot) and node_modules are not shown.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import { copyEntry, createFile, createFolder, moveEntry, renameEntry, trashEntry } from '../fileops.js';
import { newList } from '../markdown/inbox.js';
import { newTable } from '../markdown/tablelayout.js';
import { newBoard, serializeBoard } from '../markdown/kanban.js';
import { confirmDialog, promptDialog, showError } from './dialogs.js';
import { after, onClick, pack, type Awaitable } from '../gtkutil.js';
import { popupMenu, separator, type MenuEntry } from './menu.js';
import { _, fmt } from '../i18n.js';

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
const SKIPPED_FOLDERS = new Set(['node_modules']);
const EXPAND_DELAY = 600;   // ms; a closed folder opens automatically if held over during a drag
const NO_ACTION = 0 as Gdk.DragAction;
const REFRESH_DELAY = 150;  // ms; consecutive changes on disk are merged into one refresh

// One file or folder in the tree.
class FileNode extends GObject.Object {
    static { GObject.registerClass({ GTypeName: 'MarkworkFileNode' }, this); }
    name = '';
    path = '';
    isDir = false;
}

const nodeOf = (entry: FolderEntry): FileNode => Object.assign(new FileNode(), entry);

export interface FolderEntry {
    name: string;
    path: string;
    isDir: boolean;
}

export const isMarkdownFile = (name: string): boolean =>
    MARKDOWN_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));

export const isImageFile = (name: string): boolean =>
    IMAGE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));

export const isDirectory = (path: string): boolean => GLib.file_test(path, GLib.FileTest.IS_DIR);

// Subfolders first, then files; each alphabetical and case-insensitive,
// with numbers sorted naturally ("chapter 2" before "chapter 10").
function compareEntries(a: FolderEntry, b: FolderEntry): number {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// The contents of one folder displayed in the tree, already sorted.
export function listFolder(path: string): FolderEntry[] {
    const entries: FolderEntry[] = [];
    let enumerator: Gio.FileEnumerator;
    try {
        enumerator = Gio.File.new_for_path(path).enumerate_children(
            'standard::name,standard::type,standard::is-hidden', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return entries;  // the folder was deleted or cannot be read
    }
    let info: Gio.FileInfo | null;
    while ((info = enumerator.next_file(null))) {
        const name = info.get_name();
        if (name.startsWith('.') || info.get_is_hidden() || SKIPPED_FOLDERS.has(name)) continue;
        const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
        if (!isDir && !isMarkdownFile(name) && !isImageFile(name)) continue;
        entries.push({ name, path: GLib.build_filenamev([path, name]), isDir });
    }
    enumerator.close(null);
    return entries.sort(compareEntries);
}

export class FileTree {
    readonly list: Gtk.ListView;
    readonly widget: Gtk.Box;
    root: string | null = null;

    onOpenFile: (path: string) => void = () => {};  // a file was clicked
    onMoved: (from: string, to: string) => void = () => {};  // a file/folder was moved or renamed
    onDeleted: (path: string) => void = () => {};            // a file/folder was moved to the trash

    // Can be replaced in tests with immediate answers; the real dialog answers through a Promise.
    dialogs: {
        prompt: (title: string, label: string, value?: string) => Awaitable<string | null>;
        confirm: (message: string, detail: string) => Awaitable<boolean>;
        error: (message: string) => void;
    } = {
        prompt: (title, label, value) => promptDialog(this.parentWindow(), { title, label, value }),
        confirm: (message, detail) => confirmDialog(this.parentWindow(), message, detail),
        error: message => void showError(this.parentWindow(), message),
    };

    private readonly rootStore = new Gio.ListStore({ item_type: FileNode.$gtype });
    private readonly dirStores = new Map<string, Gio.ListStore>();   // path of a folder that has been read → its contents
    private readonly tree: Gtk.TreeListModel;
    private readonly selection: Gtk.SingleSelection;
    private readonly title: Gtk.Label;
    private readonly pages: Gtk.Stack;
    private monitors = new Map<string, Gio.FileMonitor>();  // folder path → monitor
    private pendingRefresh = new Map<string, number>();     // path folder → id timeout
    private dragSource: string | null = null;               // the path being dragged
    private expandTimer = 0;
    private revealed: string | null = null;                 // the file last highlighted by reveal()

    constructor() {
        this.tree = Gtk.TreeListModel.new(this.rootStore, false, false, item => this.childrenOf(item as FileNode));
        this.selection = new Gtk.SingleSelection({ model: this.tree, autoselect: false, can_unselect: true });
        this.selection.selected = Gtk.INVALID_LIST_POSITION;
        this.list = new Gtk.ListView({ model: this.selection, factory: this.createFactory(), single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        onClick(this.list, (_n, x, y) => this.showContextMenu(x, y), 3);
        this.setupDrag();
        this.list.connect('activate', (_list, position) => this.activatePosition(position));

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });

        // The view when no folder is open yet.
        const empty = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, valign: Gtk.Align.CENTER, margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16 });
        const hint = new Gtk.Label({ label: _('No folder is open'), wrap: true, justify: Gtk.Justification.CENTER });
        hint.add_css_class('dim-label');
        const button = new Gtk.Button({ label: _('Open Folder…'), action_name: 'app.open-folder', halign: Gtk.Align.CENTER });
        empty.append(hint);
        empty.append(button);

        this.pages = new Gtk.Stack({ vexpand: true });
        this.pages.add_named(empty, 'empty');
        this.pages.add_named(scroll, 'tree');

        this.title = new Gtk.Label({ label: _('FILES'), xalign: 0, margin_start: 16, margin_top: 4, margin_bottom: 8,
            ellipsize: Pango.EllipsizeMode.END });
        this.title.add_css_class('side-title');

        // Title = root folder; dropping an item here moves it out of all subfolders.
        const titleBox = new Gtk.Box();
        this.title.set_hexpand(true);
        titleBox.append(this.title);
        this.setupTitleDrop(titleBox);

        // hexpand false: the title expands inside its box, and GTK 4 passes that up to the sidebar.
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: false });
        this.widget.append(titleBox);
        pack(this.widget, this.pages, true);
    }

    private createFactory(): Gtk.SignalListItemFactory {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            const box = new Gtk.Box({ spacing: 6 });
            box.append(new Gtk.Image());
            box.append(new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END }));
            (item as Gtk.ListItem).child = new Gtk.TreeExpander({ child: box });
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const row = listItem.item as Gtk.TreeListRow;
            const node = row.get_item() as FileNode;
            const expander = listItem.child as Gtk.TreeExpander;
            expander.set_list_row(row);
            const box = expander.get_child() as Gtk.Box;
            (box.get_first_child() as Gtk.Image).icon_name = node.isDir ? 'folder-symbolic' : isImageFile(node.name) ? 'image-x-generic-symbolic' : 'text-x-generic-symbolic';
            (box.get_last_child() as Gtk.Label).label = node.name;
        });
        return factory;
    }

    // The children of a folder for the TreeListModel; null = not a folder. It is also called just
    // to check whether a row can be opened, so the result is stored and the contents are read once.
    private childrenOf(node: FileNode): Gio.ListModel | null {
        if (!node.isDir) return null;
        let store = this.dirStores.get(node.path);
        if (!store) {
            store = new Gio.ListStore({ item_type: FileNode.$gtype });
            store.splice(0, 0, listFolder(node.path).map(nodeOf));
            this.dirStores.set(node.path, store);
            this.watch(node.path);
        }
        return store;
    }

    // Window closed: stop the disk monitors and timers.
    destroy(): void {
        this.cancelExpand();
        this.setRoot(null);
    }

    // Change the displayed folder; null = no folder.
    setRoot(path: string | null): void {
        for (const monitor of this.monitors.values()) monitor.cancel();
        this.monitors.clear();
        for (const id of this.pendingRefresh.values()) GLib.source_remove(id);
        this.pendingRefresh.clear();
        this.dirStores.clear();
        this.rootStore.remove_all();
        this.root = path;

        if (!path) {
            this.title.label = _('FILES');
            this.title.tooltip_text = null;
            this.pages.visible_child_name = 'empty';
            return;
        }
        this.title.label = GLib.path_get_basename(path).toUpperCase();
        this.title.tooltip_text = path;
        this.dirStores.set(path, this.rootStore);
        this.rootStore.splice(0, 0, listFolder(path).map(nodeOf));
        this.watch(path);
        this.pages.visible_child_name = 'tree';
    }

    // ---------- Positions and rows ----------

    private rowAt(position: number): Gtk.TreeListRow | null {
        return position >= 0 && position < this.tree.get_n_items() ? this.tree.get_row(position) : null;
    }

    private nodeAt(position: number): FileNode | null {
        return (this.rowAt(position)?.get_item() as FileNode | null) ?? null;
    }

    // The position of the row currently shown for a path; -1 if absent (or its parent is closed).
    private positionOf(path: string): number {
        for (let i = 0, n = this.tree.get_n_items(); i < n; i++) if (this.nodeAt(i)?.path === path) return i;
        return -1;
    }

    private select(position: number): void {
        this.selection.selected = position < 0 ? Gtk.INVALID_LIST_POSITION : position;
    }

    // The row position at point (x, y) in ListView coordinates; -1 = empty area.
    private positionAtPoint(x: number, y: number): number {
        let widget = this.list.pick(x, y, Gtk.PickFlags.DEFAULT);
        // ListView rows are direct children of the ListView; their contents are a TreeExpander that knows its row.
        while (widget && widget.get_parent() !== this.list) widget = widget.get_parent();
        const expander = widget?.get_first_child();
        return expander instanceof Gtk.TreeExpander ? expander.get_list_row()?.get_position() ?? -1 : -1;
    }

    private pathAtPoint(x: number, y: number): string | null {
        return this.nodeAt(this.positionAtPoint(x, y))?.path ?? null;
    }

    // Highlight a file in the tree, opening its parent folders if needed.
    // false if the file is not inside the open folder.
    reveal(filePath: string | null): boolean {
        this.revealed = filePath;
        const position = filePath ? this.expandTo(filePath) : -1;
        if (position < 0) {
            this.select(-1);
            return false;
        }
        this.select(position);
        this.list.scroll_to(position, Gtk.ListScrollFlags.NONE, null);
        return true;
    }

    // Open all the folders above the path and return its position; -1 if absent.
    private expandTo(path: string): number {
        if (!this.root || !path.startsWith(`${this.root}/`)) return -1;
        const parts = path.slice(this.root.length + 1).split('/');
        let current = this.root;
        for (const part of parts.slice(0, -1)) {
            current = GLib.build_filenamev([current, part]);
            const row = this.rowAt(this.positionOf(current));
            if (!row) return -1;
            if (!row.expanded) row.expanded = true;
        }
        return this.positionOf(path);
    }

    // Re-read one folder from disk and sync its items.
    refresh(dirPath: string): void {
        const store = this.dirStores.get(dirPath);
        if (!store) return;   // never read; it is read fresh when needed
        const entries = listFolder(dirPath);
        const wanted = new Set(entries.map(e => e.path));

        // 1. Remove items that are no longer on disk.
        for (let i = store.n_items - 1; i >= 0; i--) {
            const node = store.get_item(i) as FileNode;
            if (wanted.has(node.path)) continue;
            store.remove(i);
            this.forget(node.path);
        }

        // 2. Insert new items at their sorted position. The store's contents are now
        //    an ordered subset of entries, so walking them together is enough.
        let at = 0;
        for (const entry of entries) {
            if (at < store.n_items && (store.get_item(at) as FileNode).path === entry.path) at++;
            else store.insert(at++, nodeOf(entry));
        }
    }

    // Forget a deleted folder together with all its contents: the monitor and the stored contents.
    private forget(dirPath: string): void {
        for (const path of [...this.monitors.keys()]) {
            if (path === dirPath || path.startsWith(`${dirPath}/`)) {
                this.monitors.get(path)!.cancel();
                this.monitors.delete(path);
            }
        }
        for (const path of [...this.dirStores.keys()]) if (path === dirPath || path.startsWith(`${dirPath}/`)) this.dirStores.delete(path);
    }

    // ---------- For tests ----------

    // The names of the direct children of a folder that has been read (empty if not read yet).
    childNames(dir: string): string[] {
        const store = this.dirStores.get(dir);
        const names: string[] = [];
        for (let i = 0; store && i < store.n_items; i++) names.push((store.get_item(i) as FileNode).name);
        return names;
    }

    isExpanded(path: string): boolean {
        return this.rowAt(this.positionOf(path))?.expanded ?? false;
    }

    expand(path: string, expanded = true): void {
        const row = this.rowAt(this.positionOf(path));
        if (row) row.expanded = expanded;
    }

    get selectedPath(): string | null {
        return this.nodeAt(this.selection.selected)?.path ?? null;
    }

    // As if the row was clicked: a file is opened, a folder is opened/closed.
    activate(path: string): void {
        this.activatePosition(this.positionOf(path));
    }

    // The point in the middle of row `path` in ListView coordinates; null if the row is shown.
    // Found by scanning downward, because the row height is not known before drawing.
    rowPoint(path: string): [number, number] | null {
        const position = this.positionOf(path);
        let first = -1, last = -1;
        for (let y = 1; position >= 0 && y < this.list.get_height(); y += 2) {
            if (this.positionAtPoint(60, y) !== position) {
                if (first >= 0) break;
                continue;
            }
            if (first < 0) first = y;
            last = y;
        }
        return first < 0 ? null : [60, (first + last) / 2];
    }

    // ---------- Create file/folder ----------

    private parentWindow(): Gtk.Window | null {
        const top = this.widget.get_root();
        return top instanceof Gtk.Window ? top : null;
    }

    // The folder where a new item is created for the right-clicked row: the folder itself,
    // or the file's parent folder; null (empty area) = root.
    private targetDir(path: string | null): string | null {
        if (path) return isDirectory(path) ? path : GLib.path_get_dirname(path);
        return this.root;
    }

    // Ask for a name and then create the file/folder in dir. A new file is opened in the editor right away.
    // `board`: a file containing an empty kanban board, shown right away as a board when opened.
    create(kind: 'file' | 'folder' | 'board' | 'inbox' | 'table', dir: string): Awaitable<string | null> {
        const title = kind === 'file' ? _('New File') : kind === 'board' ? _('New Kanban Board') : kind === 'inbox' ? _('New Inbox') : kind === 'table' ? _('New Table') : _('New Folder');
        return after(this.dialogs.prompt(title, kind === 'folder' ? _('Folder name') : _('File name')), name => this.createNamed(kind, dir, name));
    }

    private createNamed(kind: 'file' | 'folder' | 'board' | 'inbox' | 'table', dir: string, name: string | null): string | null {
        if (name === null) return null;
        let path: string;
        try {
            path = kind === 'folder' ? createFolder(dir, name)
                : createFile(dir, name, kind === 'board' ? serializeBoard(newBoard()) : kind === 'inbox' ? serializeBoard(newList()) : kind === 'table' ? serializeBoard(newTable()) : '');
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return null;
        }
        this.refresh(dir);
        this.reveal(path);
        if (kind !== 'folder') this.onOpenFile(path);
        return path;
    }

    // Rename a file/folder through a dialog.
    rename(path: string): Awaitable<string | null> {
        const isDir = isDirectory(path);
        return after(this.dialogs.prompt(_('Rename'), isDir ? _('Folder name') : _('File name'), GLib.path_get_basename(path)), name => this.renameTo(path, name));
    }

    private renameTo(path: string, name: string | null): string | null {
        if (name === null) return null;
        let target: string | null;
        try {
            target = renameEntry(path, name);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return null;
        }
        if (!target) return null;
        this.refresh(GLib.path_get_dirname(path));
        this.reveal(target);
        this.onMoved(path, target);
        return target;
    }

    // Move to the Trash after confirmation.
    remove(path: string): Awaitable<boolean> {
        const isDir = isDirectory(path);
        const name = GLib.path_get_basename(path);
        const detail = isDir ? _('The folder and everything in it will be moved to the Trash.') : _('The file will be moved to the Trash.');
        return after(this.dialogs.confirm(fmt(_('Delete “{name}”?'), { name }), detail), yes => yes && this.trash(path));
    }

    private trash(path: string): boolean {
        try {
            trashEntry(path);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return false;
        }
        this.refresh(GLib.path_get_dirname(path));
        this.onDeleted(path);
        return true;
    }

    // Right-click menu for a specific row (null = empty area).
    contextMenu(rowPath: string | null): MenuEntry[] {
        const dir = this.targetDir(rowPath);
        const entries: MenuEntry[] = [
            { label: _('New File…'), enabled: dir !== null, run: () => { if (dir) this.create('file', dir); } },
            { label: _('New Folder…'), enabled: dir !== null, run: () => { if (dir) this.create('folder', dir); } },
            { label: _('New Kanban Board…'), enabled: dir !== null, run: () => { if (dir) this.create('board', dir); } },
            { label: _('New Inbox…'), enabled: dir !== null, run: () => { if (dir) this.create('inbox', dir); } },
            { label: _('New Table…'), enabled: dir !== null, run: () => { if (dir) this.create('table', dir); } },
        ];
        if (rowPath) {
            entries.push(separator());
            entries.push({ label: _('Rename…'), enabled: true, run: () => this.rename(rowPath) });
            entries.push({ label: _('Delete'), enabled: true, run: () => this.remove(rowPath) });
        }
        return entries;
    }

    // Right click at (x, y), ListView coordinates.
    private showContextMenu(x: number, y: number): boolean {
        if (!this.root) return false;
        const position = this.positionAtPoint(x, y);
        this.select(position);
        this.popupContextMenu(this.nodeAt(position)?.path ?? null, x, y);
        return true;
    }

    // Context menu at (x, y) in ListView coordinates. The popover is attached to the outer box, not to the ListView,
    // so it does not scroll or get clipped along with the list.
    popupContextMenu(rowPath: string | null, x: number, y: number): Gtk.PopoverMenu {
        const [, px, py] = this.list.translate_coordinates(this.widget, x, y);
        return popupMenu(this.widget, this.contextMenu(rowPath), px, py);
    }

    // ---------- Drag and drop: moving inside the tree, copying in from a file manager ----------

    private setupDrag(): void {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', (_s, x, y) => {
            this.dragSource = this.pathAtPoint(x, y);
            if (!this.dragSource) return null;
            // Drag icon: the icon of the file's type. A widget as the icon (GtkDragIcon) triggers
            // a Gtk-CRITICAL when the drag ends in GTK 4.14.
            const icon = Gtk.IconTheme.get_for_display(this.list.get_display()).lookup_icon(
                isDirectory(this.dragSource) ? 'folder-symbolic' : 'text-x-generic-symbolic', null, 32,
                this.list.get_scale_factor(), Gtk.TextDirection.NONE, 0 as Gtk.IconLookupFlags);
            source.set_icon(icon, 0, 0);
            return Gdk.ContentProvider.new_for_value(this.dragSource);
        });
        source.connect('drag-end', () => { this.dragSource = null; });
        this.list.add_controller(source);

        const target = this.dropTarget();
        target.connect('motion', (_t, x, y) => {
            const dir = this.dropDirAt(x, y);
            const action = this.dropAction(dir);
            this.highlightDrop(action ? this.positionAtPoint(x, y) : -1);
            this.scheduleExpand(x, y);
            return action;
        });
        target.connect('leave', () => {
            this.highlightDrop(-1);
            this.cancelExpand();
        });
        target.connect('drop', (_t, value, x, y) => {
            this.cancelExpand();
            this.highlightDrop(-1);
            return this.dropInto(value, this.dropDirAt(x, y));
        });
        this.list.add_controller(target);
    }

    private setupTitleDrop(box: Gtk.Box): void {
        const target = this.dropTarget();
        target.connect('motion', () => {
            const action = this.dropAction(this.root);
            if (action) box.add_css_class('side-drop'); else box.remove_css_class('side-drop');
            return action;
        });
        target.connect('leave', () => box.remove_css_class('side-drop'));
        target.connect('drop', (_t, value) => {
            box.remove_css_class('side-drop');
            return this.dropInto(value, this.root);
        });
        box.add_controller(target);
    }

    // Accepts a path from our own drag (moved) and files from a file manager (copied).
    private dropTarget(): Gtk.DropTarget {
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE | Gdk.DragAction.COPY });
        target.set_gtypes([Gdk.FileList.$gtype, GObject.TYPE_STRING]);
        return target;
    }

    private dropAction(dir: string | null): Gdk.DragAction {
        if (this.dragSource) return this.canMoveTo(dir) ? Gdk.DragAction.MOVE : NO_ACTION;
        return dir ? Gdk.DragAction.COPY : NO_ACTION;
    }

    private dropInto(value: unknown, dir: string | null): boolean {
        if (!dir) return false;
        if (this.dragSource) return this.canMoveTo(dir) && this.moveTo(this.dragSource, dir);
        const files = value instanceof Gdk.FileList ? value.get_files() : [];
        return this.copyInto(files.map(f => f.get_path()).filter((p): p is string => !!p), dir);
    }

    // Highlight the target row with the selection; -1 = restore the highlight to the open file.
    private highlightDrop(position: number): void {
        if (position >= 0) return this.select(position);
        this.select(this.revealed ? this.positionOf(this.revealed) : -1);
    }

    // The destination folder at that position: the folder pointed at, the parent folder of the file pointed at, or the root.
    private dropDirAt(x: number, y: number): string | null {
        return this.targetDir(this.pathAtPoint(x, y));
    }

    // Dropping into the folder the item is already in = useless, and a folder into itself is forbidden.
    private canMoveTo(dir: string | null): boolean {
        const source = this.dragSource;
        if (!source || !dir) return false;
        if (GLib.path_get_dirname(source) === dir) return false;
        return dir !== source && !dir.startsWith(`${source}/`);
    }

    private scheduleExpand(x: number, y: number): void {
        this.cancelExpand();
        const row = this.rowAt(this.positionAtPoint(x, y));
        if (!row || row.expanded || !(row.get_item() as FileNode).isDir) return;
        this.expandTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXPAND_DELAY, () => {
            this.expandTimer = 0;
            row.expanded = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    private cancelExpand(): void {
        if (this.expandTimer) GLib.source_remove(this.expandTimer);
        this.expandTimer = 0;
    }

    // Move source into dir, update the tree, and notify the owner (an open file moves along).
    moveTo(source: string, dir: string): boolean {
        let target: string | null;
        try {
            target = moveEntry(source, dir);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return false;
        }
        if (!target) return false;
        this.refresh(GLib.path_get_dirname(source));
        this.refresh(dir);
        if (dir !== this.root && this.dirStores.has(dir)) this.expand(dir);
        this.reveal(target);
        this.onMoved(source, target);
        return true;
    }

    // Copy files from outside (a file manager) into dir. Only folders, Markdown files, and images
    // are copied, since other files would not show in the tree.
    copyInto(sources: string[], dir: string): boolean {
        const accepted = sources.filter(p => isDirectory(p) || isMarkdownFile(p) || isImageFile(p));
        let last: string | null = null;
        try {
            for (const source of accepted) last = copyEntry(source, dir);
        } catch (e) {
            this.dialogs.error((e as Error).message);
        }
        if (accepted.length < sources.length) {
            const skipped = sources.filter(p => !accepted.includes(p)).map(p => GLib.path_get_basename(p)).join(', ');
            this.dialogs.error(fmt(_('Only folders, Markdown files, and images can be added. Skipped: {names}'), { names: skipped }));
        }
        if (!last) return false;
        this.refresh(dir);
        if (dir !== this.root && this.dirStores.has(dir)) this.expand(dir);
        this.reveal(last);
        return true;
    }

    private activatePosition(position: number): void {
        const row = this.rowAt(position);
        const node = row?.get_item() as FileNode | undefined;
        if (!row || !node) return;
        if (node.isDir) row.expanded = !row.expanded;
        else this.onOpenFile(node.path);
    }

    // ---------- Disk monitoring ----------

    private watch(dirPath: string): void {
        if (this.monitors.has(dirPath)) return;
        try {
            const monitor = Gio.File.new_for_path(dirPath).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', () => this.scheduleRefresh(dirPath));
            this.monitors.set(dirPath, monitor);
        } catch {
            // Cannot be monitored (for example a network file system); the tree is still usable.
        }
    }

    private scheduleRefresh(dirPath: string): void {
        const pending = this.pendingRefresh.get(dirPath);
        if (pending) GLib.source_remove(pending);
        this.pendingRefresh.set(dirPath, GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this.pendingRefresh.delete(dirPath);
            this.refresh(dirPath);
            return GLib.SOURCE_REMOVE;
        }));
    }
}
