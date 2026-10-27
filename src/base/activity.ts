// Daily activity log for the journal: one JSONL file per day in <work folder>/.markwork/activity/.
// Append-only, so no index can go stale and an interrupted write corrupts at most
// one line (skipped when read). Dot folders are not read by the workspace (workspace.ts), so the agent does not
// traverse them; their contents reach the agent only through the Activity section of the journal file.

import { fileExists, readTextFile, writeTextFile } from './files';
import { platform } from '../platform/index';
import { parseActivity, serializeActivity, type Activity } from '../markdown/journal';
import { localDate } from '../markdown/home';

export const activityDir = (root: string): string => platform().paths.join(root, '.markwork', 'activity');
const logPath = (root: string, date: string) => platform().paths.join(activityDir(root), `${date}.jsonl`);

// Record one activity in that day's log (by its time). A failed write must not disturb the work
// that triggered it, so the error is swallowed and reported as false.
export function recordActivity(root: string, activity: Activity): boolean {
    try {
        const { fs, paths } = platform();
        fs.makeDirs(activityDir(root), 0o755);
        // Same as conversation history: do not get committed by accident.
        const ignore = paths.join(root, '.markwork', '.gitignore');
        if (!fileExists(ignore)) writeTextFile(ignore, '*\n');
        fs.append(logPath(root, localDate(new Date(activity.time * 1000))), `${serializeActivity(activity)}\n`);
        return true;
    } catch (e) {
        return false;
    }
}

export function readActivity(root: string, date: string): Activity[] {
    const path = logPath(root, date);
    try {
        return fileExists(path) ? parseActivity(readTextFile(path)) : [];
    } catch (e) {
        return [];
    }
}
