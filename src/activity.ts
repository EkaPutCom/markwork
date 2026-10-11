// Daily activity log for the journal: one JSONL file per day in <work folder>/.markwork/activity/.
// Append-only, so no index can go stale and an interrupted write corrupts at most
// one line (skipped when read). Dot folders are not read by the workspace (workspace.ts), so the agent does not
// traverse them; their contents reach the agent only through the Activity section of the journal file.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readTextFile, writeTextFile } from './files.js';
import { parseActivity, serializeActivity, type Activity } from './markdown/journal.js';
import { localDate } from './markdown/home.js';

const enc = new TextEncoder();

export const activityDir = (root: string): string => GLib.build_filenamev([root, '.markwork', 'activity']);
const logPath = (root: string, date: string) => GLib.build_filenamev([activityDir(root), `${date}.jsonl`]);

// Record one activity in that day's log (by its time). A failed write must not disturb the work
// that triggered it, so the error is swallowed and reported as false.
export function recordActivity(root: string, activity: Activity): boolean {
    try {
        GLib.mkdir_with_parents(activityDir(root), 0o755);
        // Same as conversation history: do not get committed by accident.
        const ignore = GLib.build_filenamev([root, '.markwork', '.gitignore']);
        if (!GLib.file_test(ignore, GLib.FileTest.EXISTS)) writeTextFile(ignore, '*\n');
        const file = Gio.File.new_for_path(logPath(root, localDate(new Date(activity.time * 1000))));
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(enc.encode(`${serializeActivity(activity)}\n`), null);
        stream.close(null);
        return true;
    } catch (e) {
        return false;
    }
}

export function readActivity(root: string, date: string): Activity[] {
    const path = logPath(root, date);
    try {
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? parseActivity(readTextFile(path)) : [];
    } catch (e) {
        return [];
    }
}
