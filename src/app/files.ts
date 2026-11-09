// The Files tab in the application layer: the work folder, the contents of the
// folders the tree shows (read and watched
// through the platform port), and what the user does with files there (create,
// rename, move to the Trash, move, copy in
// from a file manager). The tree of a frontend draws the folder contents it is
// sent and reports what the user did
// through its on* actions (docs/design/protocol.md 6.5); a path it sends back
// is one it was shown, or one the user
// dropped in from outside (copied, never written over).

import { platform } from '../platform/index';
import { insideName } from '../base/files';
import {
    copyEntry,
    createFile,
    createFolder,
    moveEntry,
    renameEntry,
    trashEntry,
} from '../base/fileops';
import { newList } from '../markdown/inbox';
import { newTable } from '../markdown/tablelayout';
import { newBoard, serializeBoard } from '../markdown/kanban';
import { isHtmlFile } from '../markdown/htmlview';
import { isCsvFile, newCsvText } from '../markdown/csv';
import { _, fmt } from '../base/i18n';
import { errorMessage, type DocumentHost } from './document';

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];
export const IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
    '.bmp',
];
const SKIPPED_FOLDERS = new Set(['node_modules']);
// ms; consecutive changes on disk are merged into one refresh
const REFRESH_DELAY = 150;

export const isMarkdownFile = (name: string): boolean =>
    MARKDOWN_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
export { isCsvFile, isHtmlFile };
export const isImageFile = (name: string): boolean =>
    IMAGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

// One file or folder as the tree shows it.
export interface FolderEntry {
    name: string;
    path: string;
    isDir: boolean;
    agent?: boolean;
}

export type NewKind =
    'file' | 'folder' | 'board' | 'inbox' | 'table' | 'csv' | 'agent';

// Subfolders first, then files; each alphabetical and case-insensitive,
// with numbers sorted naturally ("chapter 2" before "chapter 10").
function compareEntries(a: FolderEntry, b: FolderEntry): number {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}

// What a name in a listing is, following a symbolic link the way the tree
// always has; null = not shown.
function entryKind(path: string, kind: string): 'dir' | 'file' | null {
    if (kind === 'directory') return 'dir';
    if (kind === 'file') return 'file';
    if (kind !== 'symlink') return null;
    return platform().fs.isDirectory(path)
        ? 'dir'
        : platform().fs.exists(path)
          ? 'file'
          : null;
}

// Folder listings do not read file contents: unknown files are checked only
// when opened.
// No dot files or node_modules. Empty when the folder is gone or cannot be
// read.
export function listFolder(path: string): FolderEntry[] {
    const { fs, paths } = platform();
    let infos;
    try {
        infos = fs.listInfo(path);
    } catch {
        return [];
    }
    const entries: FolderEntry[] = [];
    for (const info of infos) {
        if (info.name.startsWith('.') || SKIPPED_FOLDERS.has(info.name))
            continue;
        const full = paths.join(path, info.name);
        const kind = entryKind(full, info.kind);
        if (!kind) continue;
        entries.push({
            name: info.name,
            path: full,
            isDir: kind === 'dir',
            ...(kind === 'dir' && fs.exists(paths.join(full, 'agent.json'))
                ? { agent: true }
                : {}),
        });
    }
    return entries.sort(compareEntries);
}

// Bounded metadata-only discovery for shell tools, whose completion events need
// not name their outputs.
// Never follow links or hidden/dependency folders, and do not infer new files
// from a truncated inventory.
function workspaceFiles(root: string): Map<string, string> | null {
    const { fs, paths } = platform(),
        files = new Map<string, string>();
    const pending = [{ dir: root, depth: 0 }];
    let count = 0;
    while (pending.length) {
        const { dir, depth } = pending.pop()!;
        let entries;
        try {
            if (fs.kind(dir) !== 'directory') continue;
            entries = fs.list(dir);
        } catch {
            continue;
        }
        if (entries.length > 1000 - count) return null;
        count += entries.length;
        for (const name of entries) {
            if (name.startsWith('.') || SKIPPED_FOLDERS.has(name)) continue;
            const path = paths.join(dir, name);
            let info;
            try {
                info = fs.info(path);
            } catch {
                continue;
            }
            if (info.kind === 'file') files.set(path, info.stamp);
            else if (info.kind === 'directory') {
                if (depth >= 8) return null;
                pending.push({ dir: path, depth: depth + 1 });
            }
        }
    }
    return files;
}

// The tree as this controller drives it. It draws the folders it is sent and
// reports what the user did.
export interface FileTreeView {
    // a folder needs its contents (first opened)
    onOpenFolder: (dir: string) => void;
    onActivate: (path: string) => void; // a file was clicked
    onCreate: (kind: NewKind, dir: string) => Promise<string | null>;
    onRename: (path: string) => Promise<string | null>;
    onRemove: (path: string) => Promise<boolean>;
    // dragged inside the tree
    onMove: (source: string, dir: string) => Promise<boolean>;
    // dropped in from a file manager
    onCopy: (sources: string[], dir: string) => Promise<boolean>;
    // the work folder (null = none) and its contents
    showRoot(root: string | null, entries: FolderEntry[]): void;
    // the contents of a folder the tree has open
    showFolder(dir: string, entries: FolderEntry[]): void;
    expand(dir: string): void;
    // highlight a file, opening the folders above it
    reveal(path: string | null): void;
}

// The questions about files; a test replaces them with immediate answers.
export interface FilesDialogs {
    name(title: string, label: string, value?: string): Promise<string | null>;
    confirm(
        message: string,
        detail: string,
        accept?: string,
        destructive?: boolean
    ): Promise<boolean>;
    error(message: string): void;
}

export interface FilesHost extends DocumentHost {
    readonly fileTree: FileTreeView;
    newAgent(parent: string): Promise<string | null>;
    // a file of the tree was chosen: an editor tab, or the image viewer
    openFile(path: string): void;
    // a file or folder was moved or renamed: open documents follow
    entryMoved(from: string, to: string): void;
    entryDeleted(path: string): void; // a file or folder went to the Trash
}

export class FilesController {
    root: string | null = null;
    // folders the tree shows → stops watching them
    private readonly open = new Map<string, (() => void) | null>();
    private readonly agentFiles = new Map<string, Map<string, string>>();
    // folders whose refresh waits → cancels it
    private readonly pending = new Map<string, () => void>();

    constructor(
        private readonly host: FilesHost,
        readonly dialogs: FilesDialogs
    ) {
        const tree = host.fileTree;
        tree.onOpenFolder = (dir) => this.openFolder(dir);
        tree.onActivate = (path) => host.openFile(path);
        tree.onCreate = (kind, dir) => this.create(kind, dir);
        tree.onRename = (path) => this.rename(path);
        tree.onRemove = (path) => this.remove(path);
        tree.onMove = async (source, dir) => this.move(source, dir);
        tree.onCopy = async (sources, dir) => this.copyInto(sources, dir);
    }

    // Show a folder as the work folder; null = no folder.
    setRoot(path: string | null): void {
        for (const dir of [...this.open.keys()]) this.close(dir);
        this.root = path;
        this.agentFiles.clear();
        this.host.fileTree.showRoot(path, path ? listFolder(path) : []);
        if (path) this.watch(path);
    }

    // Read a folder the tree shows again and send its contents; a folder that
    // is gone takes its subfolders with it.
    refresh(dir: string): void {
        // never read; it is read fresh when the tree opens it
        if (!this.open.has(dir)) return;
        const entries = listFolder(dir);
        const kept = new Set(entries.filter((e) => e.isDir).map((e) => e.path));
        for (const other of [...this.open.keys()]) {
            if (platform().paths.dirname(other) === dir && !kept.has(other))
                this.close(other);
        }
        this.host.fileTree.showFolder(dir, entries);
    }

    refreshAgent(
        root: string,
        workdir = platform().paths.join(root, 'workspace')
    ): void {
        const { paths } = platform();
        for (const dir of [...this.open.keys()])
            if (paths.same(dir, root) || insideName(root, dir) !== null)
                this.refresh(dir);
        const files = workspaceFiles(workdir),
            before = this.agentFiles.get(root);
        if (!files) {
            this.agentFiles.delete(root);
            return;
        }
        this.agentFiles.set(root, files);
        if (!before) return;
        const directories = new Set<string>();
        for (const [file, stamp] of files)
            if (before.get(file) !== stamp)
                this.outputParents(file, directories);
        for (const dir of [...directories].sort(
            (a, b) => a.length - b.length
        )) {
            this.openFolder(dir);
            this.host.fileTree.expand(dir);
        }
    }

    private outputParents(file: string, directories: Set<string>): void {
        const { paths } = platform();
        for (
            let dir = paths.dirname(file);
            this.root &&
            !paths.same(this.root, dir) &&
            insideName(this.root, dir) !== null;
            dir = paths.dirname(dir)
        )
            directories.add(dir);
    }

    reveal(path: string | null): void {
        this.host.fileTree.reveal(path);
    }

    // The window closes: stop watching.
    dispose(): void {
        this.setRoot(null);
    }

    // ---------- What the user does ----------

    create(kind: NewKind, dir: string): Promise<string | null> {
        if (kind === 'agent')
            return this.host.newAgent(dir).then((path) => {
                if (path) this.refresh(dir);
                return path;
            });
        const title =
            kind === 'file'
                ? _('New File')
                : kind === 'board'
                  ? _('New Kanban Board')
                  : kind === 'inbox'
                    ? _('New Inbox')
                    : kind === 'table'
                      ? _('New Table')
                      : kind === 'csv'
                        ? _('New CSV Table')
                        : _('New Folder');
        return this.dialogs
            .name(title, kind === 'folder' ? _('Folder name') : _('File name'))
            .then((name) => this.createNamed(kind, dir, name));
    }

    rename(path: string): Promise<string | null> {
        const isDir = platform().fs.isDirectory(path);
        return this.dialogs
            .name(
                _('Rename'),
                isDir ? _('Folder name') : _('File name'),
                platform().paths.basename(path)
            )
            .then((name) => this.renameTo(path, name));
    }

    // Move to the Trash after confirmation.
    remove(path: string): Promise<boolean> {
        const isDir = platform().fs.isDirectory(path);
        const name = platform().paths.basename(path);
        const detail = isDir
            ? _('The folder and everything in it will be moved to the Trash.')
            : _('The file will be moved to the Trash.');
        return this.dialogs
            .confirm(fmt(_('Delete “{name}”?'), { name }), detail)
            .then((yes) => yes && this.trash(path));
    }

    // Move source into dir; open documents follow it.
    move(source: string, dir: string): boolean {
        const target = this.attempt(() => moveEntry(source, dir));
        if (!target) return false;
        this.refresh(platform().paths.dirname(source));
        this.refresh(dir);
        this.showInto(dir, target);
        this.host.entryMoved(source, target);
        return true;
    }

    // Copy files from outside (a file manager) into dir, without interpreting
    // their contents.
    copyInto(sources: string[], dir: string): boolean {
        const { fs, paths } = platform();
        const accepted = sources.filter(
            (p) => fs.isDirectory(p) || fs.exists(p)
        );
        let last: string | null = null;
        for (const source of accepted) {
            const copied = this.attempt(() => copyEntry(source, dir));
            if (!copied) break;
            last = copied;
        }
        if (accepted.length < sources.length) {
            const skipped = sources
                .filter((p) => !accepted.includes(p))
                .map((p) => paths.basename(p))
                .join(', ');
            this.dialogs.error(
                fmt(_('Some sources no longer exist. Skipped: {names}'), {
                    names: skipped,
                })
            );
        }
        if (!last) return false;
        this.refresh(dir);
        this.showInto(dir, last);
        return true;
    }

    // ---------- Inside ----------

    private createNamed(
        kind: NewKind,
        dir: string,
        name: string | null
    ): string | null {
        if (name === null) return null;
        const content =
            kind === 'board'
                ? serializeBoard(newBoard())
                : kind === 'inbox'
                  ? serializeBoard(newList())
                  : kind === 'table'
                    ? serializeBoard(newTable())
                    : '';
        const path = this.attempt(() =>
            kind === 'folder'
                ? createFolder(dir, name)
                : kind === 'csv'
                  ? createFile(
                        dir,
                        name,
                        newCsvText([
                            _('Column 1'),
                            _('Column 2'),
                            _('Column 3'),
                        ]),
                        '.csv',
                        /\.csv$/i
                    )
                  : createFile(dir, name, content)
        );
        if (!path) return null;
        this.refresh(dir);
        this.reveal(path);
        if (kind !== 'folder') this.host.openFile(path);
        return path;
    }

    private renameTo(path: string, name: string | null): string | null {
        if (name === null) return null;
        const target = this.attempt(() => renameEntry(path, name));
        if (!target) return null;
        this.refresh(platform().paths.dirname(path));
        this.reveal(target);
        this.host.entryMoved(path, target);
        return target;
    }

    private trash(path: string): boolean {
        if (
            this.attempt(() => {
                trashEntry(path);
                return path;
            }) === null
        )
            return false;
        this.refresh(platform().paths.dirname(path));
        this.host.entryDeleted(path);
        return true;
    }

    // Runs a file operation; its error is shown to the user and the result is
    // null.
    private attempt(operation: () => string | null): string | null {
        try {
            return operation();
        } catch (e) {
            this.dialogs.error(errorMessage(e));
            return null;
        }
    }

    // After something landed in dir: open dir in the tree (if it is a folder
    // the tree has read) and highlight it.
    private showInto(dir: string, path: string): void {
        if (dir !== this.root && this.open.has(dir))
            this.host.fileTree.expand(dir);
        this.reveal(path);
    }

    private openFolder(dir: string): void {
        if (!this.open.has(dir)) this.watch(dir);
        this.host.fileTree.showFolder(dir, listFolder(dir));
    }

    // Watch a folder the tree shows; a folder that cannot be watched (a network
    // file system) still works, without
    // updates from outside.
    private watch(dir: string): void {
        let stop: (() => void) | null = null;
        try {
            stop = platform().fs.watchDir(dir, () => this.schedule(dir));
        } catch {
            /* not watchable */
        }
        this.open.set(dir, stop);
    }

    private schedule(dir: string): void {
        this.pending.get(dir)?.();
        this.pending.set(
            dir,
            platform().scheduler.idleAfter(REFRESH_DELAY, () => {
                this.pending.delete(dir);
                this.refresh(dir);
            })
        );
    }

    // Stop showing a folder and every folder inside it.
    private close(dir: string): void {
        for (const other of [...this.open.keys()]) {
            if (other !== dir && insideName(dir, other) === null) continue;
            this.open.get(other)?.();
            this.open.delete(other);
            this.pending.get(other)?.();
            this.pending.delete(other);
        }
    }
}
