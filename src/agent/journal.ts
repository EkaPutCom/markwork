import { changeState, cleanNewName, type Change } from './changes';
import type { SourceFile } from './context';

export interface ActionEvent {
    id: string;
    question: string;
    tool: string;
    status: 'proposed' | 'applied' | 'rejected' | 'failed' | 'interrupted' | 'read' | 'reverted';
    changes: Change[];
    summary: string;
    time: string;
}

const STATUSES = ['proposed', 'applied', 'rejected', 'failed', 'interrupted', 'read', 'reverted'];

// Metadata can be edited by the user: only valid data is restored, and it is never executed.
export function parseEvents(value: unknown): ActionEvent[] {
    if (!Array.isArray(value)) return [];
    return value.filter((e: any) => e && typeof e.id === 'string' && typeof e.question === 'string' &&
        typeof e.tool === 'string' && typeof e.summary === 'string' && typeof e.time === 'string' &&
        STATUSES.includes(e.status) && Array.isArray(e.changes) &&
        e.changes.every((c: any) => c && ['create', 'edit', 'delete', 'move'].includes(c.kind) && typeof c.file === 'string' && cleanNewName(c.file) === c.file &&
            (c.kind === 'move' ? typeof c.to === 'string' && cleanNewName(c.to) === c.to : c.to === undefined) &&
            typeof c.before === 'string' && typeof c.after === 'string' && typeof c.reason === 'string'));
}

export function reconcileEvents(events: ActionEvent[], files: SourceFile[]): void {
    const read = (name: string) => files.find(f => f.name === name)?.text ?? null;
    for (const e of events) {
        if (e.status !== 'proposed') continue;
        const states = e.changes.map(c => changeState(c, read));
        if (e.changes.length && states.every(s => s === 'after')) {
            e.status = 'applied'; e.summary = 'The actual result matches the whole proposal; restored after an interruption.';
        } else if (states.every(s => s === 'before')) {
            e.status = 'interrupted'; e.summary = 'The process stopped before applying; a new proposal and approval are needed.';
        } else {
            e.status = 'failed'; e.summary = 'The actual contents differ or the batch was only partly applied; check the files before continuing.';
        }
    }
}

const fileLabel = (c: Change): string => c.kind === 'move' ? `${c.file} → ${c.to}` : c.file;

export function journalText(events: ActionEvent[], maxChars = 8000): string {
    const lines: string[] = [];
    let size = 0;
    for (const e of [...events].reverse()) {
        const status = { proposed: 'Proposed', applied: 'Applied', rejected: 'Rejected', failed: 'Failed', interrupted: 'Interrupted', read: 'Browsing', reverted: 'Undone by the user' }[e.status];
        const line = `${status}: ${e.tool} ${e.changes.map(fileLabel).join(', ')} — ${e.summary}`.slice(0, 1500);
        if (size + line.length > maxChars) break;
        lines.unshift(line); size += line.length;
    }
    return lines.join('\n');
}
