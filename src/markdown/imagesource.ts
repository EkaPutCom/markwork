// Where the image in ![alt](url) comes from: a URL as written, or a file path resolved from the document folder. Pure; the
// caller passes the path operations of its runtime (GLib in editor/images.ts, platform().paths elsewhere) and turns the
// result into what it loads (a GIO URI, an app:// URL).

export interface PathOps {
    isAbsolute(path: string): boolean;
    join(...parts: string[]): string;
}

export type ImageSource = { kind: 'url'; url: string } | { kind: 'path'; path: string };

// A URL with a scheme stays as it is; an absolute path is used as written; a relative one is percent-decoded and
// joined to baseDir.
export function imageSource(url: string, baseDir: string, paths: PathOps): ImageSource {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return { kind: 'url', url };
    return { kind: 'path', path: paths.isAbsolute(url) ? url : paths.join(baseDir, decodeURI(url)) };
}
