// Paths as text, the same on every system and in the renderer: which ones are Windows paths, the / form of one, and
// whether a path lies below a folder. Not a normalizer: paths are taken as they are written, and nothing touches the
// disk. The one place that knows Windows spellings (C:\notes, C:/notes, \\server\share), so a fix lands everywhere.

// A drive path: C:\notes or C:/notes.
export const hasDrive = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path);

// A Windows path: one that starts with a drive letter, or a UNC share (\\server\share).
export const isWindowsPath = (path: string): boolean => /^([A-Za-z]:|\\\\)/.test(path);

// An absolute path on any system: /home/eka, C:\Users\eka, or \\server\share.
export const isAbsolutePath = (path: string): boolean => path.startsWith('/') || hasDrive(path) || path.startsWith('\\\\');

// A Windows path with / for its separators, which Windows accepts too; other paths are left alone, since on Linux and
// macOS \ is a letter of a name.
export const slashed = (path: string): string => isWindowsPath(path) ? path.replace(/\\/g, '/') : path;

// Whether `path` lies strictly below `folder`: the separator after the folder is / everywhere, and also \ when the
// folder is a Windows path.
export function below(folder: string, path: string): boolean {
    const end = folder.length;
    if (path.length <= end + 1 || !path.startsWith(folder)) return false;
    const next = path[end];
    return next === '/' || (next === '\\' && isWindowsPath(folder));
}

// The same, for the folder itself too.
export const atOrBelow = (folder: string, path: string): boolean => path === folder || below(folder, path);
