// The log windows of harness runs (HarnessLogs in app/harness.ts): one LogViewer per run, raised again when it is
// already open.

import type Gtk from 'gi://Gtk?version=4.0';
import type { Run } from '../agent/harness.js';
import type { HarnessLogs } from '../app/harness.js';
import { LogViewer } from '../ui/logviewer.js';
import { _, fmt } from '../i18n.js';

export class HarnessLogWindows implements HarnessLogs {
    private readonly logs = new Map<number, LogViewer>();

    // runOf: the run with an id, from the queue.
    constructor(private readonly parent: () => Gtk.Window, private readonly runOf: (id: number) => Run | undefined) {}

    // The log window of the run with this id, made if needed; null for a run that is not in the queue.
    show(runId: number): LogViewer | null {
        const run = this.runOf(runId);
        if (!run) return null;
        const open = this.logs.get(run.id);
        if (open?.window.get_realized()) { open.show(); return open; }
        const viewer = new LogViewer(this.parent(), run.trace, fmt(_('{agent} Log — {title}'), { agent: run.agent, title: run.title }));
        this.logs.set(run.id, viewer);
        viewer.show();
        return viewer;
    }
}
