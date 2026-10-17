// The log windows of harness runs (HarnessLogs in app/harness.ts): one LogViewer per run, raised again when it is already
// open. The viewer reads a TraceReplica, which the core keeps up to date with the updates it sends while the window is open.

import type Gtk from 'gi://Gtk?version=4.0';
import type { HarnessLogs } from '../app/harness.js';
import { TraceReplica, type TraceUpdate } from '../agent/tracefeed.js';
import { LogViewer } from '../ui/logviewer.js';

export class HarnessLogWindows implements HarnessLogs {
    onClear: (runId: number) => void = () => {};
    onClosed: (runId: number) => void = () => {};
    private readonly open = new Map<number, { replica: TraceReplica; viewer: LogViewer }>();

    constructor(private readonly parent: () => Gtk.Window) {}

    show(runId: number, title: string): void {
        const open = this.open.get(runId);
        if (open?.viewer.window.get_realized()) { open.viewer.show(); return; }
        const replica = new TraceReplica();
        replica.onClear = () => this.onClear(runId);
        const viewer = new LogViewer(this.parent(), replica, title);
        viewer.window.connect('unrealize', () => {
            if (this.open.get(runId)?.viewer === viewer) this.open.delete(runId);
            this.onClosed(runId);
        });
        this.open.set(runId, { replica, viewer });
        viewer.show();
    }

    update(runId: number, update: TraceUpdate): void {
        this.open.get(runId)?.replica.apply(update);
    }

    // The window of a run, if it is open.
    viewerOf(runId: number): LogViewer | undefined {
        return this.open.get(runId)?.viewer;
    }
}
