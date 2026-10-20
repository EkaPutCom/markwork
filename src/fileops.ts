// On-disk file operations for the folder tree: create a file, create a folder, move, rename, copy in, and move to the
// Trash, through the platform port. All throw an Error with a message ready to show to the user.

import { platform } from './platform/index.js';
import { flushWrites, notifyDiskChange, trashFile } from './files.js';
import { atOrBelow } from './markdown/pathbelow.js';

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;
// Every kind of file the tree shows; a rename keeps these, so the file does not disappear from the tree.
const SHOWN_EXTENSION = /\.(md|markdown|mdown|mkd|csv|html?|xhtml)$/i;

const join = (dir: string, name: string): string => platform().paths.join(dir, name);
const exists = (path: string): boolean => platform().fs.kind(path) !== 'missing';
const messageOf = (e: unknown): string => e instanceof Error ? e.message : String(e);

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

// Create a file (empty, or containing `content`); `extension` (.md by default) is appended if the name does not end in
// one that `keep` accepts (a Markdown one by default), so the file shows in the tree.
export function createFile(dir: string, rawName: string, content = '', extension = '.md', keep = MARKDOWN_EXTENSION): string {
    let name = cleanName(rawName);
    if (!keep.test(name)) name += extension;
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        platform().fs.writeText(path, content);
    } catch (e) {
        throw new Error(`Failed to create file: ${messageOf(e)}`);
    }
    notifyDiskChange(path);
    return path;
}

export function createFolder(dir: string, rawName: string): string {
    const name = cleanName(rawName);
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” already exists in this folder.`);
    if (!platform().fs.isDirectory(dir)) throw new Error(`Failed to create folder: ${dir} is not a folder`);
    try {
        platform().fs.makeDirs(path, 0o755);
    } catch (e) {
        throw new Error(`Failed to create folder: ${messageOf(e)}`);
    }
    notifyDiskChange(path);
    return path;
}

// Move a file/folder into destDir. Returns the new path, or null if
// nothing changed (it is already in that folder).
export function moveEntry(source: string, destDir: string): string | null {
    const { paths } = platform();
    const name = paths.basename(source);
    if (paths.dirname(source) === destDir) return null;
    if (atOrBelow(source, destDir)) {
        throw new Error('A folder cannot be moved into itself.');
    }
    const target = join(destDir, name);
    if (exists(target)) throw new Error(`“${name}” already exists in the destination folder.`);
    try {
        flushWrites(source);
        platform().fs.move(source, target);
    } catch (e) {
        throw new Error(`Failed to move: ${messageOf(e)}`);
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

// Copy a file/folder (e.g. dropped from a file manager) into destDir. A name that is already
// taken gets a number ("photo (2).png") instead of overwriting. Returns the new path.
export function copyEntry(source: string, destDir: string): string {
    const name = platform().paths.basename(source);
    if (atOrBelow(source, destDir)) {
        throw new Error('A folder cannot be copied into itself.');
    }
    const target = join(destDir, freeName(destDir, name));
    try {
        platform().fs.copy(source, target);
    } catch (e) {
        throw new Error(`Failed to copy “${name}”: ${messageOf(e)}`);
    }
    notifyDiskChange(target);
    return target;
}

// Rename a file/folder in place. Returns the new path, or null if the name did not change.
// Files keep an extension the tree shows (Markdown, CSV, HTML), and get .md otherwise, so they do not disappear from it.
export function renameEntry(path: string, rawName: string): string | null {
    const { fs, paths } = platform();
    let name = cleanName(rawName);
    if (!fs.isDirectory(path) && !SHOWN_EXTENSION.test(name)) name += '.md';
    if (name === paths.basename(path)) return null;
    const target = join(paths.dirname(path), name);
    if (exists(target)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        flushWrites(path);
        fs.move(path, target);
    } catch (e) {
        throw new Error(`Failed to rename: ${messageOf(e)}`);
    }
    notifyDiskChange(path, target);
    return target;
}

// Move to the Trash (recoverable), not a permanent delete.
export const trashEntry = trashFile;
