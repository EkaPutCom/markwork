// A batch is planned on a copy of the manuscript: later actions see the results of earlier ones.
import { applyToFiles, changeFiles, CHANGE_TOOLS, planChange, preflight, type Change } from './changes';
import type { SourceFile } from './context';
import type { ToolSpec } from './provider';

export const BATCH_TOOL: ToolSpec = {
    name: 'propose_batch',
    description: 'Propose interdependent actions as a single batch (at most 20). The user reviews all diffs at once and may apply only some of the files; the per-file results are returned. For several changes to one file, use the contents resulting from the previous action. A file that is deleted or moved must not be touched by another action in the same batch.',
    parameters: { type: 'object', properties: {
        actions: { type: 'array', minItems: 1, maxItems: 20, items: {
            type: 'object', properties: {
                tool: { type: 'string', enum: CHANGE_TOOLS.map(t => t.name) },
                arguments: { type: 'string', description: 'JSON object of the arguments of the chosen tool' },
            }, required: ['tool', 'arguments'], additionalProperties: false,
        } },
    }, required: ['actions'], additionalProperties: false },
};

// One Change per file, and a deleted/moved file is touched by only one action. That way each
// Change in the batch stands on its own, so the user can safely apply just some of them.
export function planBatch(raw: string, files: SourceFile[]): { changes: Change[]; error?: string } {
    try {
        const a = JSON.parse(raw);
        if (!Array.isArray(a.actions) || !a.actions.length || a.actions.length > 20) return { changes: [], error: 'A batch must contain 1–20 actions.' };
        const virtual = files.map(f => ({ ...f }));
        const changes = new Map<string, Change>();
        const locked = new Set<string>();
        for (const item of a.actions) {
            if (!item || !CHANGE_TOOLS.some(t => t.name === item.tool) || typeof item.arguments !== 'string') return { changes: [], error: 'The tool or arguments of the batch are not valid.' };
            const plan = planChange(item.tool, item.arguments, virtual);
            if (!plan.ok) return { changes: [], error: plan.message };
            const c = plan.change, touched = changeFiles(c);
            const busy = touched.find(f => locked.has(f) || (c.kind === 'delete' || c.kind === 'move') && changes.has(f));
            if (busy) return { changes: [], error: `${busy} is deleted or moved together with another action in the same batch. Propose delete/move as a separate action for that file.` };
            if (c.kind === 'delete' || c.kind === 'move') touched.forEach(f => locked.add(f));
            const prior = changes.get(c.file);
            changes.set(c.file, prior ? { ...prior, after: c.after, reason: `${prior.reason}; ${c.reason}` } : c);
            applyToFiles(virtual, c);
        }
        const result = [...changes.values()].filter(c => c.kind !== 'edit' || c.before !== c.after);
        return result.length ? { changes: result } : { changes: [], error: 'The batch produces no changes.' };
    } catch { return { changes: [], error: 'The batch arguments are not a valid JSON object.' }; }
}

export interface BatchHost {
    read(file: string): string | null;
    write(change: Change): void;
    rollback(change: Change): void;
}

// Preflight the whole batch before writing; a write failure is returned together with any rollback failures.
// This is an in-process transaction, not an atomic guarantee against power loss or other processes.
export function applyBatch(changes: Change[], host: BatchHost): string | null {
    const written: Change[] = [];
    try {
        for (const c of changes) {
            const error = preflight(c, host.read);
            if (error) return changes.length > 1 ? `${error}; the whole batch was cancelled` : error;
        }
        for (const c of changes) { written.push(c); host.write(c); }
        return null;
    } catch (e) {
        const failures: string[] = [];
        for (const c of written.reverse()) {
            try { host.rollback(c); } catch (error) { failures.push(`${c.file}: ${String(error)}`); }
        }
        return `${String(e)}${failures.length ? `; recovery failed: ${failures.join('; ')}` : '; the batch changes were restored'}`;
    }
}
