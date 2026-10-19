// The Electron main process: a window, the core in a utility process, and the channel between them. It holds no
// application logic; the folder dialog is the one thing only it can show.

import { BrowserWindow, Menu, MessageChannelMain, app, dialog, ipcMain, nativeTheme, shell, utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        title: 'Markwork',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
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

ipcMain.handle('pick-folder', async event => {
    // For tests that cannot drive a native dialog.
    if (process.env.MARKWORK_PICK_FOLDER) return process.env.MARKWORK_PICK_FOLDER;
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory' as const] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
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
