// An image URL as written, or a path resolved from the document folder.
// The caller supplies runtime path operations (the renderer's own or
// platform().paths) and turns the result into a loadable URI or app:// URL.

export interface PathOps {
    isAbsolute(path: string): boolean;
    join(...parts: string[]): string;
}

export type ImageSource =
    | { kind: 'url'; url: string }
    | { kind: 'path'; path: string };

// Schemed URLs and absolute paths stay as written. Relative paths are
// percent-decoded and joined to baseDir.
export function imageSource(
    url: string, baseDir: string, paths: PathOps
): ImageSource {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return { kind: 'url', url };
    return {
        kind: 'path',
        path: paths.isAbsolute(url) ? url : paths.join(baseDir, decodeURI(url)),
    };
}
