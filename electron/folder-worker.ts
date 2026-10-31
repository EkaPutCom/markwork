// A daemon-owned entry point. Stdout is JSONL only; credentials are resolved here and never carried in daemon records.
import '../src/platform/node/install';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { FolderWorker } from '../src/agent/folderworker';
import { loadAgentFolder } from '../src/agent/folder';
import { systemKeyStore } from '../src/agent/apikey';
import type { Provider } from '../src/agent/provider';

const root = process.cwd();
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--check')) {
    const found = await systemKeyStore.get();
    output({ version: 1, available: !!found, agent: loadAgentFolder(root).kind === 'agent' });
} else {
    const session = process.argv[2];
    if (!session || basename(session) !== session || !session.endsWith('.md')) throw Error('Expected a session filename');
    const testModule = process.env.MARKWORK_TEST_MODEL;
    const provider = testModule ? (await import(/* @vite-ignore */ testModule) as { provider: Provider }).provider : null;
    const worker = new FolderWorker(root, session, value => { output(value); if (value.event === 'done') { worker.dispose(); process.exitCode = 0; input.close(); process.stdin.destroy(); } }, provider ? () => provider : undefined);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', line => {
        if (line.length > 1024 * 1024) { output({ event: 'error', data: { error: 'Worker command is too large' } }); return; }
        void worker.command(line).catch(error => { output({ event: 'error', data: { error: String(error) } }); worker.dispose(); process.exitCode = 1; input.close(); process.stdin.destroy(); });
    });
    process.on('SIGTERM', () => { worker.dispose(); input.close(); process.stdin.destroy(); });
}
