// Entry point of the GTK 4 + libadwaita application.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import System from 'system';

import { APP_ID } from './config.js';
import { systemSettings } from './platform/gjs/settings.js';
import { MainWindow } from './window.js';

// argv: command-line arguments; the first argument that is not an option = the file or folder to open.
export function main(argv: string[]): number {
    const path = argv.find(a => !a.startsWith('-')) ?? null;
    // NON_UNIQUE: every command opens its own window (process).
    const app = new Adw.Application({ application_id: APP_ID, flags: Gio.ApplicationFlags.NON_UNIQUE });
    app.connect('activate', () => {
        new MainWindow(app, systemSettings(), path);
    });
    // Arguments are not passed on to GApplication; the path was already read above.
    return app.run([System.programInvocationName]);
}
