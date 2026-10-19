// Hands the core's MessagePort to the page. The page gets no Node and no Electron objects, only this bridge.

import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('port', event => window.postMessage('markwork-port', '*', event.ports));
ipcRenderer.on('core-exit', (_event, code: number | null, stderr: string) => window.postMessage({ coreExit: { code, stderr } }, '*'));

ipcRenderer.on('close-request', () => window.postMessage('markwork-close-request', '*'));

contextBridge.exposeInMainWorld('markwork', {
    initialFolder: (): Promise<string | null> => ipcRenderer.invoke('initial-folder'),
    openFolder: (path: string): Promise<void> => ipcRenderer.invoke('open-folder', path),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('close-window'),
    chooseFile: (options: Record<string, unknown>): Promise<string | null> => ipcRenderer.invoke('choose-file', options),
});
