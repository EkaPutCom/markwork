// The Electron main process: a window, the core in a utility process, and the channel between them. It holds no
// application logic; the file dialogs are the one thing only it can show.

import { BrowserWindow, Menu, MessageChannelMain, app, dialog, ipcMain, nativeTheme, shell, utilityProcess } from 'electron';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

    const core = utilityProcess.fork(join(here, 'core.js'), [], { stdio: 'pipe' });
    let stderr = '';
    core.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    core.on('exit', code => {
        if (!win.isDestroyed()) win.webContents.send('core-exit', code, stderr);
    });
    const { port1, port2 } = new MessageChannelMain();
    core.postMessage('port', [port1]);
    win.webContents.once('did-finish-load', () => win.webContents.postMessage('port', null, [port2]));
    win.on('closed', () => core.kill());

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
    // The keys belong to the command table of the page (app/commands.ts); a default menu would take Ctrl+W and others first.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
