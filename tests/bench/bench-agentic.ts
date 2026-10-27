// Measure the cost of the new feature locally, without a model provider or widgets.
import '../../src/platform/node/install';   // the core reaches the runtime through platform()
import '../core/host-node';
import { planBatch } from '../../src/agent/batch';
import { verifyWork } from '../../src/agent/verification';
import { serializeChat, parseChat, type SavedChat } from '../../src/agent/transcript';
import { compactHistory } from '../../src/agent/recovery';
import { readTextFile, writeTextFile } from '../../src/base/files';
import type { ActionEvent } from '../../src/agent/journal';
import { disk, say } from '../core/framework';
import { host } from '../core/host';
import { platform } from '../../src/platform/index';

const directory = host().makeTempDir();
const checkpoint = disk.join(directory, 'checkpoint.md');
const measure = (name: string, action: () => void) => {
    for (let i = 0; i < 3; i++) action();
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) { const start = (platform().monotonicMs() * 1000); action(); samples.push(((platform().monotonicMs() * 1000) - start) / 1000); }
    const sorted = [...samples].sort((a, b) => a - b);
    say(`${name}: median ${((sorted[4] + sorted[5]) / 2).toFixed(3)} ms · p95 ${sorted[9].toFixed(3)} ms · max ${sorted[9].toFixed(3)} ms`);
};
try {
    for (const length of [2000, 32000]) {
        const text = 'Meeting notes.\n'.repeat(length);
        const files = Array.from({ length: 20 }, (_, n) => ({ name: `${n}.md`, text }));
        const raw = JSON.stringify({ actions: files.map(f => ({ tool: 'edit_file', arguments: JSON.stringify({ name: f.name, old_text: f.text, new_text: f.text + 'Release: 22 November\n', reason: 'Meeting decision' }) })) });
        const planned = planBatch(raw, files);
        if (planned.error) throw Error(planned.error);
        const events: ActionEvent[] = [{ id: '1', question: 'Sync the schedule', tool: 'propose_batch', status: 'applied', changes: planned.changes, summary: 'Applied', time: '2026-10-05' }];
        const chat: SavedChat = { title: 'Schedule', model: 'fake', created: '2026-10-05', turns: [{ role: 'user', content: 'Sync the schedule' }, { role: 'assistant', content: 'Checked and finished' }], events };
        say(`\n20 files × ${text.length} characters; 10 repetitions, 3 warm-ups`);
        measure('Plan batch', () => { if (planBatch(raw, files).changes.length !== 20) throw Error('the batch is incomplete'); });
        const changed = planned.changes.map(c => ({ name: c.file, text: c.after }));
        const checks = JSON.stringify({ checks: changed.map(f => ({ file: f.name, kind: 'present', text: '22 November' })) });
        measure('Verify the result', () => { if (!verifyWork(checks, changed).passed) throw Error('verification failed'); });
        // The structure is compared with the contents before the change, so each file is parsed twice.
        const before = new Map(planned.changes.map(c => [c.file, c.before]));
        const structure = JSON.stringify({ checks: changed.map(f => ({ file: f.name, kind: 'structure' })) });
        measure('Verify structure (with baseline)', () => { if (!verifyWork(structure, changed, f => before.get(f) ?? null).passed) throw Error('structure failed'); });
        const leftover = JSON.stringify({ checks: [{ file: '*', kind: 'absent', text: '15 November' }] });
        measure('Find leftover text across the folder (*)', () => { if (!verifyWork(leftover, changed).passed) throw Error('leftover found'); });
        measure('Text checkpoint without a journal (control)', () => { writeTextFile(checkpoint, serializeChat({ ...chat, events: [] })); if (!parseChat(readTextFile(checkpoint))) throw Error('checkpoint failed'); });
        measure('Checkpoint with a journal', () => { writeTextFile(checkpoint, serializeChat(chat)); if (parseChat(readTextFile(checkpoint))?.events?.[0].changes.length !== 20) throw Error('journal failed'); });
    }
    const history = Array.from({ length: 200 }, (_, n) => ({ role: n % 2 ? 'assistant' as const : 'user' as const, content: 'Old notes '.repeat(2000) }));
    measure('Summarize 200 turns', () => { if (!compactHistory(history, 12000).summary) throw Error('empty summary'); });
} finally {
    disk.remove(checkpoint); disk.remove(directory);
}
