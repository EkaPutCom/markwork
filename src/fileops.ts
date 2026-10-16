// On-disk file operations for the folder tree: create a file, create a folder, move.
// All throw an Error with a message ready to show to the user.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { flushWrites, notifyDiskChange, trashFile } from './files.js';

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

const join = (dir: string, name: string): string => GLib.build_filenamev([dir, name]);
const exists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);

// Return the clean name, or throw if it must not be used.
function cleanName(raw: string): string {
    const name = raw.trim();
    if (!name) throw new Error('Name cannot be empty.');
    if (name.includes('/')) throw new Error('Name cannot contain “/”.');
    if (name === '.' || name === '..') throw new Error('Invalid name.');
    // Dot files are not shown in the tree, so the result would seem to vanish.
    if (name.startsWith('.')) throw new Error('Name cannot start with a dot (it would be hidden from the tree).');
    return name;
}

// Create a file (empty, or containing `content`); .md is appended if the extension is not a Markdown one, so it shows in the tree.
export function createFile(dir: string, rawName: string, content = ''): string {
    let name = cleanName(rawName);
    if (!MARKDOWN_EXTENSION.test(name)) name += '.md';
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        const stream = Gio.File.new_for_path(path).create(Gio.FileCreateFlags.NONE, null);
        if (content) stream.write_all(new TextEncoder().encode(content), null);
        stream.close(null);
    } catch (e) {
        throw new Error(`Failed to create file: ${(e as Error).message}`);
    }
    notifyDiskChange(path);
    return path;
}

export function createFolder(dir: string, rawName: string): string {
    const name = cleanName(rawName);
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        Gio.File.new_for_path(path).make_directory(null);
    } catch (e) {
        throw new Error(`Failed to create folder: ${(e as Error).message}`);
    }
    notifyDiskChange(path);
    return path;
}

// Move a file/folder into destDir. Returns the new path, or null if
// nothing changed (it is already in that folder).
export function moveEntry(source: string, destDir: string): string | null {
    const name = GLib.path_get_basename(source);
    if (GLib.path_get_dirname(source) === destDir) return null;
    if (destDir === source || destDir.startsWith(`${source}/`)) {
        throw new Error('A folder cannot be moved into itself.');
    }
    const target = join(destDir, name);
    if (exists(target)) throw new Error(`“${name}” already exists in the destination folder.`);
    try {
        flushWrites(source);
        Gio.File.new_for_path(source).move(Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        throw new Error(`Failed to move: ${(e as Error).message}`);
    }
    notifyDiskChange(source, target);
    return target;
}

// A free name in dir: the name itself, or "name (2).ext", "name (3).ext", … if it is taken.
function freeName(dir: string, name: string): string {
    if (!exists(join(dir, name))) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) {
        const candidate = `${stem} (${n})${ext}`;
        if (!exists(join(dir, candidate))) return candidate;
    }
}

function copyRecursive(source: Gio.File, target: Gio.File): void {
    if (source.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) !== Gio.FileType.DIRECTORY) {
        source.copy(target, Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, null, null);
        return;
    }
    target.make_directory(null);
    const children = source.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info: Gio.FileInfo | null;
    while ((info = children.next_file(null))) {
        copyRecursive(source.get_child(info.get_name()), target.get_child(info.get_name()));
    }
    children.close(null);
}

// Copy a file/folder (e.g. dropped from a file manager) into destDir. A name that is already
// taken gets a number ("photo (2).png") instead of overwriting. Returns the new path.
export function copyEntry(source: string, destDir: string): string {
    const name = GLib.path_get_basename(source);
    if (destDir === source || destDir.startsWith(`${source}/`)) {
        throw new Error('A folder cannot be copied into itself.');
    }
    const target = join(destDir, freeName(destDir, name));
    try {
        copyRecursive(Gio.File.new_for_path(source), Gio.File.new_for_path(target));
    } catch (e) {
        throw new Error(`Failed to copy “${name}”: ${(e as Error).message}`);
    }
    notifyDiskChange(target);
    return target;
}

// remapPath (where a path lands when its folder moves) is in app/documents.ts; re-exported for the file tree.
export { remapPath } from './app/documents.js';

// Rename a file/folder in place. Returns the new path, or null if the name did not change.
// Files keep a Markdown extension so they do not disappear from the tree.
export function renameEntry(path: string, rawName: string): string | null {
    let name = cleanName(rawName);
    const isDir = GLib.file_test(path, GLib.FileTest.IS_DIR);
    if (!isDir && !MARKDOWN_EXTENSION.test(name)) name += '.md';
    if (name === GLib.path_get_basename(path)) return null;
    const target = join(GLib.path_get_dirname(path), name);
    if (exists(target)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        flushWrites(path);
        Gio.File.new_for_path(path).move(Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        throw new Error(`Failed to rename: ${(e as Error).message}`);
    }
    notifyDiskChange(path, target);
    return target;
}

// Move to the Trash (recoverable), not a permanent delete.
export const trashEntry = trashFile;
