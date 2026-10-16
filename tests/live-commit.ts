// Live test of the commit message writer (agent/commitmessage.ts) against the real DeepSeek API: a throwaway git
// repository, the real workingDiff/recentSubjects, and the message checked the way the commit box would show it.
// Part of npm run test:live.

import GLib from 'gi://GLib';
import { systemKeyStore } from '../src/agent/apikey.js';
import { writeCommitMessage } from '../src/agent/commitmessage.js';
import type { Provider } from '../src/agent/provider.js';
import { recentSubjects, workingDiff } from '../src/git.js';
import { DIM, GREEN, RED, RESET, errorMessage, tmp } from './framework.js';
import { Cancellable } from '../src/cancel.js';

interface CommitScenario {
    name: string;
    history: string[];                     // earlier commit subjects, oldest first
    before: Record<string, string>;        // committed contents
    after: Record<string, string>;         // the working tree to describe
    check: Array<[RegExp, string]>;        // the message must match each pattern
    stopAfter?: number;                    // press Stop once this many characters have streamed in
}

const PLAN = '# Release plan\n\n## Schedule\n\nThe public release is on 15 November.\nThe beta opens two weeks before.\n';

const SCENARIOS: CommitScenario[] = [
    {
        name: 'one file, English history with a "docs:" prefix',
        history: ['docs: add the release plan', 'docs: add a schedule section'],
        before: { 'plan.md': PLAN },
        after: { 'plan.md': PLAN.replace('15 November', '22 November') },
        check: [[/^docs: ?/i, 'follows the "docs:" prefix'], [/22|november|release|date|move|postpone|delay|reschedul/i, 'says what changed']],
    },
    {
        name: 'two files, Indonesian history',
        history: ['Tambah bab satu', 'Perbaiki ejaan di bab satu'],
        before: { 'bab-1.md': '# Bab 1\n\nRaka berumur tujuh belas tahun.\n', 'bab-2.md': '# Bab 2\n\nKapal itu berwarna putih.\n' },
        after: { 'bab-1.md': '# Bab 1\n\nRaka berumur dua puluh lima tahun.\n', 'bab-2.md': '# Bab 2\n\nKapal itu berwarna hitam.\n' },
        check: [[/\b(ubah|ganti|perbaiki|samakan|sesuaikan|umur|usia|warna|kapal|raka)/i, 'written in Indonesian, about the change']],
    },
    {
        name: 'Stop while it writes keeps the text so far',
        history: ['Add notes'],
        before: { 'notes.md': '# Notes\n' },
        after: { 'notes.md': '# Notes\n\n- Call the printer about the cover proof\n- Send chapter three to the editor\n' },
        check: [],
        stopAfter: 1,
    },
];

function makeRepo(sc: CommitScenario, n: number): string {
    const repo = GLib.build_filenamev([tmp, `live-commit-${n}`]);
    GLib.mkdir_with_parents(repo, 0o755);
    const git = (...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args],
            null, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const write = (files: Record<string, string>) => {
        for (const [name, text] of Object.entries(files)) GLib.file_set_contents(GLib.build_filenamev([repo, name]), text);
    };
    git('init', '-q');
    write(sc.before);
    sc.history.forEach((subject, i) => {
        if (i > 0) GLib.file_set_contents(GLib.build_filenamev([repo, `.step-${i}`]), String(i));
        git('add', '-A');
        git('commit', '-q', '-m', subject);
    });
    write(sc.after);
    return repo;
}

export async function liveCommitMessage(provider: Provider, model: string): Promise<number> {
    print('\nCommit message writer');
    let failures = 0;
    for (const [n, sc] of SCENARIOS.entries()) {
        print(`\n▶ ${sc.name}`);
        try {
            const repo = makeRepo(sc, n);
            const files = Object.keys(sc.after).map(name => GLib.build_filenamev([repo, name]));
            const cancellable = new Cancellable();
            let updates = 0;
            const started = GLib.get_monotonic_time();
            const result = await writeCommitMessage({
                keyStore: systemKeyStore, makeProvider: () => provider, model: () => model,
                diff: workingDiff, subjects: recentSubjects,
            }, files, message => {
                updates++;
                if (sc.stopAfter && message.length >= sc.stopAfter) cancellable.cancel();
            }, cancellable);
            const secs = ((GLib.get_monotonic_time() - started) / 1e6).toFixed(1);
            const problems: string[] = [];
            if (!result.ok) {
                problems.push(`failed (${result.reason}): ${result.message}`);
            } else {
                print(`  “${result.message}”  ${DIM}${secs} s · ${updates} updates${result.cancelled ? ' · stopped' : ''}${RESET}`);
                const msg = result.message;
                if (sc.stopAfter) {
                    if (!result.cancelled) problems.push('Stop did not end the request');
                    if (!msg) problems.push('nothing kept after Stop');
                } else {
                    if (!msg) problems.push('empty message');
                    if (msg.includes('\n')) problems.push('more than one line');
                    if (msg.length > 72) problems.push(`${msg.length} characters, over 72`);
                    if (/\.$/.test(msg)) problems.push('trailing period');
                    if (/^["'`“]/.test(msg)) problems.push('quoted');
                    if (/update\s+\S+\.md/i.test(msg)) problems.push('names the file instead of the change');
                    for (const [re, what] of sc.check) if (!re.test(msg)) problems.push(`does not ${what} (${re})`);
                    if (updates < 1) problems.push('nothing streamed');
                }
            }
            if (problems.length) { failures++; print(`  ${RED}✗ ${problems.join('; ')}${RESET}`); }
            else print(`  ${GREEN}✓ passed${RESET}`);
        } catch (e) {
            failures++;
            print(`  ${RED}✗ error: ${errorMessage(e)}${RESET}`);
        }
    }
    print(`\n${failures ? RED : GREEN}${SCENARIOS.length - failures}/${SCENARIOS.length} commit message scenarios passed${RESET}`);
    return failures;
}
