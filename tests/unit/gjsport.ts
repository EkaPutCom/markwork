// Tests of the GJS implementation of the platform port (platform/gjs/) where it guards against GJS's own failures. The
// behaviour every implementation shares (the libsoup transport included) is tested through platform() in the core tests.

import Gio from 'gi://Gio';
import { agentGit, gitLimits } from '../../src/git.js';
import { section, test, eq, contains, within, tmp } from '../framework.js';

export async function gjsPortTests(): Promise<void> {
    section('Platform on GJS');

    await test('runGit: a result lost by GJS ends as a failure instead of waiting forever', async () => {
        const limits = { ...gitLimits };
        const communicate = Gio.Subprocess.prototype.communicate_utf8_async;
        try {
            // What GJS does when it blocks the callback during garbage collection: git exits, nothing calls back.
            Gio.Subprocess.prototype.communicate_utf8_async = (() => {}) as unknown as typeof communicate;   // a narrow cast: only the callback form is used
            gitLimits.lostMs = 300;
            const lost = await within(agentGit(tmp, { kind: 'log', file: null, limit: 10 }));
            eq(lost.ok, false, 'a lost result is a failure');
            if (!lost.ok) contains(lost.message, 'result was lost');
        } finally {
            Gio.Subprocess.prototype.communicate_utf8_async = communicate;
            Object.assign(gitLimits, limits);
        }
    });
}
