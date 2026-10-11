// Evaluation of tool choice by a real model. It only writes fixtures in a temporary folder.
import GLib from 'gi://GLib';
import type { Provider } from '../src/agent/provider.js';
import { ChatSession } from '../src/agent/session.js';
import { applyBatch } from '../src/agent/batch.js';
import { readTextFile, writeTextFile, fileExists } from '../src/files.js';
import { WorkspaceRepository } from '../src/workspace.js';
import { GREEN, RED, RESET } from './framework.js';

export async function liveAgentic(provider: Provider, model: string, thinking: boolean): Promise<number> {
    let failures = 0;
    const workspace = new WorkspaceRepository();
    for (const decision of ['approve', 'reject', 'conflict'] as const) {
        const root = GLib.dir_make_tmp('markwork-eval-agentic-XXXXXX');
        const path = (name: string) => GLib.build_filenamev([root, name]);
        const original = { 'meeting.md': '# Meeting decisions\nThe release is postponed from 15 November to 22 November. The release material starts being worked on.\n',
            'plan.md': '# Plan\nRelease date: 15 November\n',
            'tasks.md': '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Release material\n\n## In Progress\n\n' };
        try {
            for (const [name, text] of Object.entries(original)) writeTextFile(path(name), text);
            const session = new ChatSession(); session.thinking = thinking;
            let proposals = 0;
            const apply = async (changes: import('../src/agent/changes.js').Change[]) => {
                proposals++;
                if (decision === 'reject') return { applied: false };
                if (decision === 'conflict') writeTextFile(path('plan.md'), '# Edited by the user\n');
                const error = applyBatch(changes, { read: f => fileExists(path(f)) ? readTextFile(path(f)) : null,
                    write: c => { writeTextFile(path(c.file), c.after); },
                    rollback: c => { if (c.kind === 'create') GLib.unlink(path(c.file)); else writeTextFile(path(c.file), c.before); } });
                return { applied: !error, ...(error ? { error } : {}) };
            };
            const r = await session.ask({ question: 'Use the decisions in meeting.md to sync the release date in plan.md and move Release material to In Progress in tasks.md. Record a work plan, propose both as a single batch, and check the actual result before declaring it finished. Do not change meeting.md or create other files.', active: null, files: workspace.files(root), selection: '', mentions: [], options: { project: true, activeDocument: true, selection: true }, budget: 8000 }, provider, model, {
                onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: () => workspace.files(root, { freshness: 'fresh' }),
                onProposal: c => apply([c]), onBatchProposal: apply,
            });
            const plan = readTextFile(path('plan.md')), board = readTextFile(path('tasks.md'));
            let passed = proposals > 0 && readTextFile(path('meeting.md')) === original['meeting.md'];
            if (decision === 'approve') passed &&= r.applied === 2 && session.events.some(e => e.tool === 'propose_batch' && e.status === 'applied') && session.work?.status === 'complete' && plan.includes('22 November') && !plan.includes('15 November') && board.includes('## In Progress\n\n- [ ] Release material');
            if (decision === 'reject') passed &&= r.applied === 0 && plan === original['plan.md'] && board === original['tasks.md'] && session.work?.status !== 'complete';
            if (decision === 'conflict') passed &&= r.applied === 0 && plan === '# Edited by the user\n' && board === original['tasks.md'] && session.work?.status !== 'complete';
            print(`${passed ? GREEN : RED}${passed ? '✓' : '✗'} agentic ${decision}: ${proposals} proposals, ${r.applied} changes, status ${session.work?.status ?? 'no plan'}${RESET}`);
            if (!passed) failures++;
        } catch (e) { failures++; print(`${RED}✗ agentic ${decision}: ${String(e)}${RESET}`); }
        finally {
            for (const name of Object.keys(original)) GLib.unlink(path(name));
            // If the model strays and proposes a new file, do not leave evaluation artifacts behind.
            for (const f of workspace.files(root)) GLib.unlink(path(f.name));
            GLib.rmdir(root);
        }
    }
    return failures;
}
