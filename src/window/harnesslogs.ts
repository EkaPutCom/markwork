// The log windows of harness runs (HarnessLogs in app/harness.ts): one LogViewer per run, raised again when it is
// already open.

import type Gtk from 'gi://Gtk?version=4.0';
import type { Run } from '../agent/harness.js';
import type { HarnessLogs } from '../app/harness.js';
import { LogViewer } from '../ui/logviewer.js';
import { _, fmt } from '../i18n.js';

export class HarnessLogWindows implements HarnessLogs {
    private readonly logs = new Map<number, LogViewer>();

    constructor(private readonly parent: () => Gtk.Window) {}

    show(run: Run): LogViewer {
        const open = this.logs.get(run.id);
        if (open?.window.get_realized()) { open.show(); return open; }
        const viewer = new LogViewer(this.parent(), run.trace, fmt(_('{agent} Log — {title}'), { agent: run.agent, title: run.title }));
        this.logs.set(run.id, viewer);
        viewer.show();
        return viewer;
    }
}
