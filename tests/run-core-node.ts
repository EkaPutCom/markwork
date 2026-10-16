// The core's tests on Node, with the Node platform: proof that the core needs nothing from GJS. Bundled by Vite
// (vite.node.config.ts) into dist-node/run-core-node.js.
//
//   npm run test:core:node                          build, then every core test on Node
//   node dist-node/run-core-node.js --only-worktrees  only the harness queue and the worktree per card
//   node dist-node/run-core-node.js --only-daemon     only the markworkd client tests

import '../src/platform/node/install.js';   // the core reaches the runtime through platform()
import './host-node.js';                    // the tests reach the runtime through host(), installed before framework.ts
import { GREEN, RED, RESET, errorMessage, opt, recordFailure, say, setRoot, summary } from './framework.js';
import { runCoreTests } from './core-tests.js';

setRoot(import.meta.url);

try {
    await runCoreTests(opt('only-worktrees') ? 'worktrees' : opt('only-daemon') ? 'daemon' : 'all');
} catch (e) {
    recordFailure();
    say(`${RED}The core tests stopped: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
}
const { passed, failed } = summary();
say(`\n${failed ? RED : GREEN}${passed} passed, ${failed} failed${RESET} (Node ${process.version})`);
process.exit(failed ? 1 : 0);
