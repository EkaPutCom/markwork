// Automated tests for Markwork. Bundled by Vite into dist/run-tests.js.
//
//   npm test                                         build, then all tests including the mouse in Xvfb
//   npm run test:ui                                 build, then all tests including the mouse on the desktop
//   gjs -m dist/run-tests.js --no-gui                only the Markdown → HTML conversion tests
//   gjs -m dist/run-tests.js --mouse                 add real mouse clicks (the pointer will move)
//   gjs -m dist/run-tests.js --screenshot=a.png      save a screenshot of the editor window
//   gjs -m dist/run-tests.js --shot-proposal=/tmp/p  save screenshots of the agent proposal review window (/tmp/p-<n>-review.png and -main.png)
//   gjs -m dist/run-tests.js --shot-inbox=/tmp/i     save screenshots of the inbox light/dark (/tmp/i-light.png, /tmp/i-dark.png)
//   gjs -m dist/run-tests.js --shot-harness=/tmp/h   save screenshots of the board with pi cards working/queued and the pi log (/tmp/h-board.png, -log.png)
//   gjs -m dist/run-tests.js --shot-log=/tmp/l       save a screenshot of the agent log with a tool call selected (/tmp/l-log.png)
//   gjs -m dist/run-tests.js --shot-tree-menu=/tmp/m  save screenshots of the file tree right-click menu and a new kanban board (/tmp/m-menu.png, -board.png)
//   gjs -m dist/run-tests.js --shot-wikilink=/tmp/w   save screenshots of [[note]] suggestions light/dark (/tmp/w-light.png, -light-suggest.png, -dark*.png)
//   gjs -m dist/run-tests.js --shot-gnome=/tmp/g      save screenshots of the narrow window, shortcuts dialog, light/dark theme (/tmp/g-narrow.png, -shortcuts.png, -light.png, -dark.png)
//   gjs -m dist/run-tests.js --shot-home=/tmp/b       save screenshots of Home light/dark/narrow (/tmp/b-light.png, -dark.png, -narrow.png)
//   gjs -m dist/run-tests.js --shot-journal=/tmp/j     save screenshots of the journal light/dark, Home, and the quick capture dialog (/tmp/j-journal.png, -journal-dark.png, -home.png, -capture.png)
//   gjs -m dist/run-tests.js --shot-layouts=/tmp/l   save screenshots of the calendar, timeline, gallery, chart, and board by field light/dark (/tmp/l-<layout>-light.png, -dark.png)
//   gjs -m dist/run-tests.js --shot-due=/tmp/d        save screenshots of the due date calendar and the card dialog light/dark (/tmp/d-calendar.png, -dialog.png, -dialog-dark.png)
//
// GUI tests open real windows, so a desktop session (X11/Wayland) is needed.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import System from 'system';

import { DIM, GREEN, RED, RESET, errorMessage, opt, optVal, recordFailure, setRoot, summary } from './framework.js';
import { WELCOME } from '../src/welcome.js';
import { createContext } from './gui/context.js';
import { widgetPixbuf } from './widgets.js';
import { incrementalTests } from './unit/incremental.js';
import { inlineTests } from './unit/inline.js';
import { wikiLinkTests } from './unit/wikilink.js';
import { settingsTests } from './unit/settings.js';
import { tableTests } from './unit/table.js';
import { kanbanModelTests } from './unit/kanban.js';
import { inboxModelTests } from './unit/inbox.js';
import { fieldsModelTests } from './unit/fields.js';
import { layoutTests } from './unit/layout.js';
import { tableLayoutTests } from './unit/tablelayout.js';
import { sampleDocumentTests } from './unit/samples.js';
import { layoutsModelTests } from './unit/layouts.js';
import { homeModelTests } from './unit/home.js';
import { journalModelTests } from './unit/journal.js';
import { codeLanguageTests } from './unit/codelang.js';
import { htmlTests } from './unit/html.js';
import { dbmlTests } from './unit/dbml.js';
import { gitLogTests } from './unit/gitlog.js';
import { fileOpsTests } from './unit/fileops.js';
import { fileWriteTests } from './unit/files.js';
import { workspaceTests } from './unit/workspace.js';
import { chatControllerTests } from './unit/chatcontroller.js';
import { agentTests, apiKeyTests, toolTests } from './unit/agent.js';
import { transcriptTests } from './unit/transcript.js';
import { agenticTests } from './unit/agentic.js';
import { agentActionTests } from './unit/agentactions.js';
import { workTests } from './unit/work.js';
import { traceTests } from './unit/trace.js';
import { changeTests } from './unit/changes.js';
import { deepseekTests } from './unit/deepseek.js';
import { commitMessageTests } from './unit/commitmessage.js';
import { dialogTests } from './gui/dialogs.js';
import { harnessTests as harnessModelTests } from './unit/harness.js';
import { harnessTests } from './gui/harness.js';
import { chatTests } from './gui/chat.js';
import { syntaxHidingTests } from './gui/syntax.js';
import { listTests, listIndentTests } from './gui/lists.js';
import { formatTests } from './gui/format.js';
import { fileTests } from './gui/file.js';
import { imageTests } from './gui/image.js';
import { imageZoomTests } from './gui/imagezoom.js';
import { codeColorTests } from './gui/codecolor.js';
import { mermaidTests } from './gui/mermaid.js';
import { tableGridTests } from './gui/table.js';
import { codeBlockTests } from './gui/codeblock.js';
import { kanbanBoardTests } from './gui/kanban.js';
import { inboxTests } from './gui/inbox.js';
import { tableLayoutGuiTests } from './gui/tablelayout.js';
import { layoutsGuiTests } from './gui/layouts.js';
import { kanbanMouseTests } from './gui/kanban-mouse.js';
import { folderTests } from './gui/folder.js';
import { folderMouseTests } from './gui/folder-mouse.js';
import { wikiLinkGuiTests } from './gui/wikilink.js';
import { sampleTests } from './gui/sample.js';
import { windowSizeTests } from './gui/window.js';
import { gnomeTests } from './gui/gnome.js';
import { robustnessTests } from './gui/robust.js';
import { historyTests } from './gui/history.js';
import { tabTests } from './gui/tabs.js';
import { homeTests } from './gui/home.js';
import { journalTests } from './gui/journal.js';

setRoot(import.meta.url);

function runUnitTests(): void {
    inlineTests();
    wikiLinkTests();
    incrementalTests();
    settingsTests();
    tableTests();
    kanbanModelTests();
    inboxModelTests();
    fieldsModelTests();
    layoutTests();
    tableLayoutTests();
    layoutsModelTests();
    sampleDocumentTests();
    homeModelTests();
    journalModelTests();
    codeLanguageTests();
    htmlTests();
    dbmlTests();
    gitLogTests();
    fileOpsTests();
    fileWriteTests();
    workspaceTests();
    chatControllerTests();
    agentTests();
    apiKeyTests();
    toolTests();
    transcriptTests();
    workTests();
    traceTests();
    agenticTests();
    agentActionTests();
    changeTests();
    deepseekTests();
    commitMessageTests();
    harnessModelTests();
}

function runGuiTests(app: Adw.Application): void {
    const c = createContext(app);
    if (opt('only-dialogs')) {
        dialogTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    if (opt('only-gnome')) {
        gnomeTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    if (opt('only-chat')) {
        chatTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    if (opt('only-journal')) {
        journalTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    if (opt('only-home')) {
        homeTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    if (opt('only-folder-mouse')) {
        folderMouseTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    const { w, ed, buf, pump, setText, cursorTo } = c;
    pump();

    syntaxHidingTests(c);
    listTests(c);
    listIndentTests(c);
    formatTests(c);
    fileTests(c);
    imageTests(c);
    imageZoomTests(c);
    codeColorTests(c);
    tableGridTests(c);
    codeBlockTests(c);
    mermaidTests(c);
    kanbanBoardTests(c);
    inboxTests(c);
    tableLayoutGuiTests(c);
    layoutsGuiTests(c);
    harnessTests(c);
    dialogTests(c);
    // The folder tests create another window and replace the app actions. Check undo/redo
    // with the mouse while the actions are still connected to this context's window.
    if (opt('with-kanban-mouse')) kanbanMouseTests(c);
    folderTests(c);
    if (opt('with-kanban-mouse')) folderMouseTests(c);
    wikiLinkGuiTests(c);
    sampleTests(c);
    windowSizeTests(c);
    gnomeTests(c);
    tabTests(c);
    homeTests(c);
    journalTests(c);
    historyTests(c);
    chatTests(c);
    robustnessTests(c);

    const shot = optVal('screenshot');
    if (shot) {
        setText(WELCOME);
        cursorTo(0);
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(20000); }
        widgetPixbuf(w.win)?.savev(shot, 'png', [], []);
        print(`\n${DIM}Screenshot: ${shot}${RESET}`);
    }

    buf.set_modified(false);
    w.win.destroy();
}

// ───────────────────────── Run ─────────────────────────

runUnitTests();

if (opt('with-kanban-mouse') && opt('no-gui')) {
    recordFailure();
    print(`${RED}The mouse test option cannot be combined with --no-gui.${RESET}`);
}

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        if (opt('with-kanban-mouse')) recordFailure();
        print(`\n${DIM}GUI tests skipped: there is no display.${RESET}`);
    } else {
        const app = new Adw.Application({ application_id: 'com.ekaput.Markwork.Test', flags: Gio.ApplicationFlags.NON_UNIQUE });
        app.connect('activate', () => {
            app.hold();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    runGuiTests(app);
                } catch (e) {
                    recordFailure();
                    print(`${RED}GUI tests stopped: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
                }
                app.release();
                app.quit();
                return GLib.SOURCE_REMOVE;
            });
        });
        app.run([System.programInvocationName]);
    }
}

const { passed, failed } = summary();
print(`\n${failed ? RED : GREEN}${passed} passed, ${failed} failed${RESET}`);
System.exit(failed ? 1 : 0);
