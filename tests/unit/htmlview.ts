// HTML viewer tests: which files open there, the address scheme, and the rule that keeps a page inside its folder.

import { section, test, eq } from '../core/framework';
import { HTML_CSP, htmlContentType, htmlViewUrl, isHtmlFile, parseHtmlUrl, resolveHtmlRequest } from '../../src/markdown/htmlview';

export function htmlViewTests(): void {
    section('HTML viewer');
    const root = '/home/u/site';
    const links: Record<string, string> = {
        '/home/u/site/out': '/etc',                  // points out of the folder
        '/home/u/site/in': 'sub',                    // points inside, relative
        '/home/u/site/abs': '/home/u/site/sub/x.js', // points inside, absolute
        '/home/u/site/up': '..',                     // points to the parent
        '/home/u/site/loop': 'loop',                 // points at itself
        '/home/u/site/sub/back': '../../../etc',     // relative, climbs out
    };
    const readLink = (path: string): string | null => links[path] ?? null;
    const resolve = (requested: string) => resolveHtmlRequest(root, requested, readLink);

    test('the viewer opens HTML files by extension, whatever the case', () => {
        eq(['a.html', 'A.HTM', 'x.xhtml', 'a.md', 'html', 'a.html.txt'].map(isHtmlFile), [true, true, true, false, false, false]);
    });
    test('a file below the folder gets an address and a file outside gets none', () => {
        eq(htmlViewUrl(3, root, '/home/u/site/index.html'), 'mwhtml://v3/index.html');
        eq(htmlViewUrl(3, root, '/home/u/site/a b/ü.html'), 'mwhtml://v3/a%20b/%C3%BC.html');
        eq(htmlViewUrl(3, root, '/home/u/other/index.html'), null);
        eq(htmlViewUrl(3, root, '/home/u/site'), null, 'the folder itself');
        eq(htmlViewUrl(3, root, '/home/u/sitemap/index.html'), null, 'a sibling that shares the prefix');
        eq(htmlViewUrl(3, root, '/home/u/site/../x.html'), null, 'a path that climbs out');
    });
    test('an address gives the viewer and the decoded path, without the query or fragment', () => {
        eq(parseHtmlUrl('mwhtml://v12/a%20b/c.css?x=1#top'), { id: 12, path: '/a b/c.css' });
        eq(parseHtmlUrl('mwhtml://v1'), { id: 1, path: '/' });
        eq(parseHtmlUrl('https://example.org/'), null);
        eq(parseHtmlUrl('mwhtml://doc/x'), null);
        eq(parseHtmlUrl('mwhtml://v1/%E0%A4%A'), null, 'a malformed escape');
    });
    test('a request below the folder is answered', () => {
        eq(resolve('/index.html'), '/home/u/site/index.html');
        eq(resolve('/sub/../a.css'), '/home/u/site/a.css');
        eq(resolve('//sub///./a.css'), '/home/u/site/sub/a.css');
    });
    test('a request that climbs out of the folder is refused', () => {
        eq(resolve('/../secret.txt'), null);
        eq(resolve('/sub/../../secret.txt'), null);
        eq(resolve('/..'), null);
        eq(resolve('/%2e%2e/x'), '/home/u/site/%2e%2e/x', 'an escape was already decoded once; what is left is a plain name');
    });
    test('a request for the folder itself, or with a NUL or a backslash, is refused', () => {
        eq(resolve('/'), null);
        eq(resolve(''), null);
        eq(resolve('/a\0.html'), null);
        eq(resolve('/..\\x'), null);
    });
    test('a Windows folder works with \\ or /, and a link to a drive path is read as absolute', () => {
        const win = 'C:\\Users\\u\\site';
        eq(htmlViewUrl(2, win, 'C:\\Users\\u\\site\\a b\\index.html'), 'mwhtml://v2/a%20b/index.html');
        eq(htmlViewUrl(2, win, 'C:\\Users\\u\\other\\index.html'), null);
        const winLinks: Record<string, string> = { 'C:/Users/u/site/in': 'C:\\Users\\u\\site\\sub', 'C:/Users/u/site/out': 'D:\\secret' };
        const winResolve = (requested: string) => resolveHtmlRequest(win, requested, path => winLinks[path] ?? null);
        eq(winResolve('/a b/index.html'), 'C:/Users/u/site/a b/index.html');
        eq(winResolve('/../x.html'), null);
        eq(winResolve('/in/x.js'), 'C:/Users/u/site/sub/x.js');
        eq(winResolve('/out/x'), null);
    });
    test('a symbolic link is followed only while it stays inside the folder', () => {
        eq(resolve('/out/passwd'), null, 'a link to /etc');
        eq(resolve('/in/x.js'), '/home/u/site/sub/x.js', 'a link to a folder inside');
        eq(resolve('/abs'), '/home/u/site/sub/x.js', 'an absolute link inside');
        eq(resolve('/up/site/index.html'), null, 'a link to the parent is outside the folder');
        eq(resolve('/sub/back/passwd'), null, 'a relative link that climbs out');
        eq(resolve('/loop'), null, 'a link loop');
    });
    test('the policy allows the page its own scripts and styles and nothing from outside', () => {
        for (const part of ["default-src 'self'", "'unsafe-inline'", "connect-src 'self'", "object-src 'none'", "form-action 'self'"]) {
            eq(HTML_CSP.includes(part), true, part);
        }
        eq(/https?:|\*/.test(HTML_CSP), false, 'no remote source');
    });
    test('content types follow the extension', () => {
        eq(['a.html', 'a.CSS', 'a.js', 'a.svg', 'a.woff2', 'a.unknown', 'noext'].map(htmlContentType),
            ['text/html', 'text/css', 'text/javascript', 'image/svg+xml', 'font/woff2', 'application/octet-stream', 'application/octet-stream']);
    });
}
