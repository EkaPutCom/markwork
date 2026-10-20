// A fake agent program for the Electron tests (tests/electron/harness.mjs): the core loads it when MARKWORK_TEST_HARNESS names this
// file, so no test needs pi or a model. Given its prompt it writes notes.md in the folder it runs in and commits it, asks one
// yes-or-no question, and when that is answered says it is done and ends.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function spawn(_argv, cwd, handlers) {
    const say = event => setTimeout(() => handlers.line(JSON.stringify(event)), 0);
    return {
        write(line) {
            const message = JSON.parse(line);
            if (message.type === 'prompt') {
                writeFileSync(join(cwd, 'notes.md'), '# Notes\n\nWritten by the agent\n');
                execFileSync('git', ['add', '.'], { cwd });
                execFileSync('git', ['commit', '-q', '-m', 'Add notes'], { cwd });
                say({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', title: 'Run the tests?', message: 'npm test' });
            } else if (message.type === 'extension_ui_response') {
                say({ type: 'agent_settled' });
            }
            return true;
        },
        closeInput() { setTimeout(() => handlers.exit(0, ''), 0); },
        stop() { setTimeout(() => handlers.exit(143, ''), 0); },
    };
}
