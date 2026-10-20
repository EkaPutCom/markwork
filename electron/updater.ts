// Updates of the packaged app: electron-updater reads the release feed that electron-builder publishes (the GitHub
// releases of electron-builder.yml), downloads a newer build in the background, and installs it when the app quits. It
// does nothing in development or in a package that cannot update itself (a .deb: the package manager does that).

import { app } from 'electron';
import electronUpdater from 'electron-updater';

// Whether this run may update itself: a packaged app, not switched off, and on Linux only an AppImage.
export function canUpdate(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, packaged: boolean = app.isPackaged): boolean {
    if (!packaged || env.MARKWORK_NO_UPDATE) return false;
    return platform !== 'linux' || Boolean(env.APPIMAGE);
}

export function checkForUpdates(): void {
    if (!canUpdate()) return;
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // A failed check (offline, no release yet) is not worth a dialog; the next start tries again.
    autoUpdater.on('error', error => console.error(`update check failed: ${error.message}`));
    void autoUpdater.checkForUpdates().catch(() => { /* reported by the error event */ });
}
