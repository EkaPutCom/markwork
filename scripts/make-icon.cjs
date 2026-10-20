// Renders the app icon (resources/icon.svg) to resources/icon.png at 1024 px, the source electron-builder
// turns into .icns and .ico. Run with Electron: `xvfb-run electron scripts/make-icon.cjs`.
const { app, BrowserWindow } = require('electron');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const svg = readFileSync(join(root, 'resources/icon.svg'), 'utf8');
const SIZE = 1024;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
    const page = `<style>html,body{margin:0;background:transparent}svg{width:${SIZE}px;height:${SIZE}px;display:block}</style>${svg}`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    await new Promise(r => setTimeout(r, 500));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    mkdirSync(join(root, 'resources'), { recursive: true });
    writeFileSync(join(root, 'resources/icon.png'), image.toPNG());
    app.quit();
});
