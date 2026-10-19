// Whether a path lies strictly below a folder, by text: the separator after the folder is / everywhere, and also \ when
// the folder is a Windows path (a drive letter or a UNC share). Not a normalizer: both paths are taken as they are.

const isWindowsPath = (path: string): boolean => /^([A-Za-z]:|\\\\)/.test(path);

export function below(folder: string, path: string): boolean {
    const end = folder.length;
    if (path.length <= end + 1 || !path.startsWith(folder)) return false;
    const next = path[end];
    return next === '/' || (next === '\\' && isWindowsPath(folder));
}

// The same, for the folder itself too.
export const atOrBelow = (folder: string, path: string): boolean => path === folder || below(folder, path);
