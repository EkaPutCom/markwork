// The tests of the core (markdown/, agent/, forge/, the base modules, the orchestrator, the daemon client) and of the
// application layer's pure parts. They reach the runtime only through the platform port and the test host, so the
// same list runs on GJS (run-tests.ts) and on Node (run-core-node.ts). A test that needs GTK or GI belongs in
// run-tests.ts instead.

import { inlineTests } from './unit/inline.js';
import { wikiLinkTests } from './unit/wikilink.js';
import { searchFilterTests, searchTests } from './unit/search.js';
import { kanbanModelTests } from './unit/kanban.js';
import { inboxModelTests } from './unit/inbox.js';
import { fieldsModelTests } from './unit/fields.js';
import { layoutTests } from './unit/layout.js';
import { tableLayoutTests } from './unit/tablelayout.js';
import { sampleDocumentTests } from './unit/samples.js';
import { layoutsModelTests } from './unit/layouts.js';
import { homeModelTests } from './unit/home.js';
import { journalModelTests } from './unit/journal.js';
import { htmlTests } from './unit/html.js';
import { dbmlTests } from './unit/dbml.js';
import { gitLogTests } from './unit/gitlog.js';
import { fileWriteTests } from './unit/files.js';
import { workspaceTests } from './unit/workspace.js';
import { chatControllerTests } from './unit/chatcontroller.js';
import { agentTests, apiKeyTests, toolTests } from './unit/agent.js';
import { transcriptTests } from './unit/transcript.js';
import { agenticTests } from './unit/agentic.js';
import { agentActionTests } from './unit/agentactions.js';
import { noteToolTests } from './unit/notetools.js';
import { workTests } from './unit/work.js';
import { traceTests } from './unit/trace.js';
import { changeTests } from './unit/changes.js';
import { deepseekTests } from './unit/deepseek.js';
import { forgeTests } from './unit/forge.js';
import { platformTests } from './unit/platform.js';
import { noteDiffTests } from './unit/notediff.js';
import { contributeTests } from './unit/contribute.js';
import { resolveTests } from './unit/resolve.js';
import { conflictTests } from './unit/conflicts.js';
import { commitMessageTests } from './unit/commitmessage.js';
import { harnessTests } from './unit/harness.js';
import { worktreeTests } from './unit/worktree.js';
import { daemonClientTests } from './unit/daemon.js';
import { daemonLiveTests, daemonSshTests } from './unit/daemon-live.js';
import { daemonAppTests } from './unit/daemonapp.js';

export type CoreFocus = 'all' | 'worktrees' | 'daemon';

// Runs the tests one module after another; a module whose tests wait is awaited before the next starts.
export async function runCoreTests(focus: CoreFocus = 'all'): Promise<void> {
    if (focus === 'worktrees') {
        harnessTests();
        await worktreeTests();
        return;
    }
    if (focus === 'daemon') {
        await daemonClientTests();
        await daemonAppTests();
        await daemonLiveTests();
        await daemonSshTests();
        return;
    }
    inlineTests();
    wikiLinkTests();
    searchTests();
    searchFilterTests();
    kanbanModelTests();
    inboxModelTests();
    fieldsModelTests();
    layoutTests();
    tableLayoutTests();
    layoutsModelTests();
    sampleDocumentTests();
    homeModelTests();
    journalModelTests();
    htmlTests();
    dbmlTests();
    gitLogTests();
    await fileWriteTests();
    await workspaceTests();
    await chatControllerTests();
    await agentTests();
    await apiKeyTests();
    toolTests();
    transcriptTests();
    await workTests();
    await traceTests();
    await agenticTests();
    noteToolTests();
    await agentActionTests();
    await changeTests();
    await deepseekTests();
    await forgeTests();
    await platformTests();
    noteDiffTests();
    await contributeTests();
    await resolveTests();
    conflictTests();
    await commitMessageTests();
    harnessTests();
    await worktreeTests();
    await daemonClientTests();
    await daemonAppTests();
    await daemonLiveTests();
    await daemonSshTests();
}
