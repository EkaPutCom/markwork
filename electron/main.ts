// The Electron main process: a window, the core in a utility process, and the channel between them. It holds no
// application logic; the file dialogs are the one thing only it can show.

import { BrowserWindow, Menu, MessageChannelMain, app, dialog, ipcMain, nativeTheme, protocol, safeStorage, shell, utilityProcess } from 'electron';
import { readlinkSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdates } from './updater.js';
import { SecretVault, answerSecret } from '../src/platform/node/vault.js';
import { HTML_CSP, HTML_SCHEME, htmlContentType, parseHtmlUrl, resolveHtmlRequest } from '../src/markdown/htmlview.js';

const here = dirname(fileURLToPath(import.meta.url));

// The keyring of the core where the OS gives Node none (core.ts): safeStorage, which only this process can call.
let vault: SecretVault | null = null;
const secretVault = () => vault ??= new SecretVault(join(app.getPath('userData'), 'secrets.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: text => safeStorage.encryptString(text),
    decrypt: data => safeStorage.decryptString(Buffer.from(data)),
});

// The images of a document: app://file/<absolute path>, so the page (which may not load file: URLs) can show the
// pictures next to the text. Only image files are served, and only to this app's own pages.
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
};
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: HTML_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// The folder each open HTML tab may read, by the id the page was served under (html-register).
const htmlRoots = new Map<number, string>();
ipcMain.handle('html-register', (_event, id: unknown, root: unknown) => {
    if (typeof id === 'number' && typeof root === 'string' && isAbsolute(root)) htmlRoots.set(id, root);
});
ipcMain.handle('html-unregister', (_event, id: unknown) => { if (typeof id === 'number') htmlRoots.delete(id); });

const linkOf = (path: string): string | null => { try { return readlinkSync(path); } catch { return null; } };

// Windows the page has let go (the core agreed to the close).
const mayClose = new WeakSet<BrowserWindow>();
ipcMain.handle('close-window', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    mayClose.add(win);
    win.close();
});

function createWindow(): void {
    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        title: 'Markwork',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#fafafa',
        webPreferences: {
            preload: join(here, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });
    // Links in a document open in the browser, never in the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    // A page in an HTML tab stays on its own scheme; a link that clicks out to the web opens in the browser.
    win.webContents.on('will-frame-navigate', event => {
        const target = parseHtmlUrl(event.url);
        if (target && htmlRoots.has(target.id)) return;
        event.preventDefault();
        if (!event.isMainFrame && /^(https?|mailto):/i.test(event.url)) void shell.openExternal(event.url);
    });

    const core = utilityProcess.fork(join(here, 'core.js'), [], { stdio: 'pipe' });
    let stderr = '';
    core.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    let coreGone = false;
    core.on('exit', code => {
        coreGone = true;
        if (!win.isDestroyed()) win.webContents.send('core-exit', code, stderr);
    });
    core.on('message', message => {
        const reply = answerSecret(secretVault(), (message as { secrets?: unknown } | null)?.secrets);
        if (reply) core.postMessage({ secrets: reply });
    });
    const { port1, port2 } = new MessageChannelMain();
    core.postMessage('port', [port1]);
    win.webContents.once('did-finish-load', () => win.webContents.postMessage('port', null, [port2]));
    win.on('closed', () => core.kill());
    // Closing waits for the core, which asks about unsaved documents; the page says when the window may go (close-window).
    // Without a core to ask (it has exited) the window just closes.
    win.on('close', event => {
        if (mayClose.has(win) || core.pid === undefined || coreGone) return;
        event.preventDefault();
        win.webContents.send('close-request');
    });

    void win.loadFile(join(here, 'renderer', 'index.html'));
}

// The core's file chooser (ask.file, app/dialogs.ts ChooseFileOptions): open, save, or a folder.
const FILTERS: Record<string, { name: string; extensions: string[] }> = {
    markdown: { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
    image: { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
    html: { name: 'HTML', extensions: ['html', 'htm'] },
    all: { name: 'All Files', extensions: ['*'] },
};

interface ChooseFile { title?: string; save?: boolean; selectFolder?: boolean; filters?: string[]; name?: string | null; folder?: string | null }

ipcMain.handle('choose-file', async (event, options: ChooseFile) => {
    // For tests that cannot drive a native dialog.
    const preset = options.selectFolder ? process.env.MARKWORK_PICK_FOLDER : process.env.MARKWORK_CHOOSE_FILE;
    if (preset !== undefined) return preset || null;
    const win = BrowserWindow.fromWebContents(event.sender);
    const filters = (options.filters ?? []).map(f => FILTERS[f]).filter(f => f !== undefined);
    const defaultPath = options.folder && options.name ? join(options.folder, options.name) : options.name ?? options.folder ?? undefined;
    if (options.save) {
        const save = { title: options.title, defaultPath, filters, properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const] };
        const result = win ? await dialog.showSaveDialog(win, save) : await dialog.showSaveDialog(save);
        return result.canceled ? null : result.filePath ?? null;
    }
    const open = {
        title: options.title, defaultPath, filters,
        properties: options.selectFolder ? ['openDirectory' as const, 'createDirectory' as const] : ['openFile' as const],
    };
    const result = win ? await dialog.showOpenDialog(win, open) : await dialog.showOpenDialog(open);
    return result.canceled ? null : result.filePaths[0] ?? null;
});

// A folder in the file manager (reveal.folder): only an existing folder, never a file the system would run.
ipcMain.handle('open-folder', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
    await shell.openPath(path);
});

// `electron . <folder>` opens that folder at start.
ipcMain.handle('initial-folder', () => process.argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('-')) ?? null);

void app.whenReady().then(() => {
    // For the Playwright tests on a machine without a keychain: safeStorage on its plain-text backend (Linux only).
    if (process.env.MARKWORK_TEST_PLAIN_STORAGE && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
    // An HTML page: every request is answered from the page's folder (a link out of it is refused) with the page policy.
    protocol.handle(HTML_SCHEME, async request => {
        const target = parseHtmlUrl(request.url);
        const root = target && htmlRoots.get(target.id);
        const file = root ? resolveHtmlRequest(root, target.path, linkOf) : null;
        if (!file) return new Response('not found', { status: 404 });
        try {
            return new Response(await readFile(file), { headers: { 'content-type': htmlContentType(file), 'content-security-policy': HTML_CSP } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    });
    protocol.handle('app', async request => {
        try {
            const path = decodeURIComponent(new URL(request.url).pathname);
            if (!isAbsolute(path) || !IMAGE_FILE.test(path)) return new Response('not an image', { status: 403 });
            const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';
            return new Response(await readFile(path), { headers: { 'content-type': type } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    });
    // The keys belong to the command table of the page (app/commands.ts); a default menu would take Ctrl+W and others first.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    checkForUpdates();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
