// Hands the core's MessagePort to the page. The page gets no Node and no Electron objects, only this bridge.

import { contextBridge, ipcRenderer, webUtils } from 'electron';

ipcRenderer.on('port', event => window.postMessage('markwork-port', '*', event.ports));
ipcRenderer.on('core-exit', (_event, code: number | null, stderr: string) => window.postMessage({ coreExit: { code, stderr } }, '*'));

ipcRenderer.on('close-request', () => window.postMessage('markwork-close-request', '*'));

const devMode = ipcRenderer.sendSync('dev-mode') === true;

contextBridge.exposeInMainWorld('markwork', {
    initialFolder: (): Promise<string | null> => ipcRenderer.invoke('initial-folder'),
    openFolder: (path: string): Promise<void> => ipcRenderer.invoke('open-folder', path),
    // The paths of files dropped on the page from a file manager (the page itself cannot read them).
    pathsOf: (files: File[]): string[] => files.map(f => webUtils.getPathForFile(f)).filter(Boolean),
    // The folder an HTML tab may read, told to the main process, which serves the page (mwhtml://v<id>/).
    registerHtml: (id: number, root: string): Promise<void> => ipcRenderer.invoke('html-register', id, root),
    unregisterHtml: (id: number): Promise<void> => ipcRenderer.invoke('html-unregister', id),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('close-window'),
    chooseFile: (options: Record<string, unknown>): Promise<string | null> => ipcRenderer.invoke('choose-file', options),
    // Started with --inspect-editor or MARKWORK_DEV=1: the Editor Inspector is there (docs/design/debugger.md).
    devMode,
    // Dev mode: the requests of the inspector's bridge (electron/inspect.ts), answered by the page one by one.
    ...(devMode ? {
        onInspect: (answer: (request: unknown) => Promise<unknown>): void => {
            ipcRenderer.on('inspect', (_event, request: unknown) => { void answer(request).then(reply => ipcRenderer.send('inspect-reply', reply)); });
            ipcRenderer.send('inspect-ready');
        },
    } : {}),
});
