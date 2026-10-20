// The core's tests on Node, with the Node platform: proof that the core reaches the runtime only through the platform port. Bundled by Vite
// (vite.node.config.ts) into dist-node/run-core-node.js.
//
//   npm run test:core:node                          build, then every core test on Node
//   node dist-node/run-core-node.js --only-worktrees  only the harness queue and the worktree per card
//   node dist-node/run-core-node.js --only-daemon     only the markworkd client tests

import '../../src/platform/node/install.js';   // the core reaches the runtime through platform()
import './host-node.js';                    // the tests reach the runtime through host(), installed before framework.ts
import { GREEN, RED, RESET, errorMessage, opt, recordFailure, say, setRoot, summary } from './framework.js';
import { runCoreTests } from './core-tests.js';
import { crossOsTests } from '../unit/crossos.js';
import { nodePlatformTests } from '../unit/nodeplatform.js';

setRoot(import.meta.url);

try {
    const focus = opt('only-worktrees') ? 'worktrees' : opt('only-daemon') ? 'daemon' : 'all';
    await runCoreTests(focus);
    // What only the Node runtime has (its settings store and translations).
    if (focus === 'all') await nodePlatformTests();
    if (focus === 'all') await crossOsTests();
} catch (e) {
    recordFailure();
    say(`${RED}The core tests stopped: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
}
const { passed, failed } = summary();
say(`\n${failed ? RED : GREEN}${passed} passed, ${failed} failed${RESET} (Node ${process.version})`);
process.exit(failed ? 1 : 0);
