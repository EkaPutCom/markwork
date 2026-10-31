// Generate an explicit daemon program launcher. It uses Electron's bundled Node runtime, not a system Node.
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [destination, executable, bundle] = process.argv.slice(2);
if (!destination) throw Error('Usage: node scripts/agent-worker-launcher.mjs <destination> [Electron-or-Markwork-executable] [folder-worker.js]');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const target = resolve(destination);
const runtime = resolve(executable ?? join(root, 'node_modules/electron/dist/electron'));
const worker = resolve(bundle ?? join(root, 'dist-electron/folder-worker.js'));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(runtime)} ${quote(worker)} "$@"\n`);
chmodSync(target, 0o755);
console.log(target);
