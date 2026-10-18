// Automated tests for Markwork. Bundled by Vite into dist/run-tests.js.
//
//   npm test                                         build, then all tests including the mouse in Xvfb
//   npm run test:ui                                 build, then all tests including the mouse on the desktop
//   gjs -m dist/run-tests.js --no-gui                only the Markdown → HTML conversion tests
//   gjs -m dist/run-tests.js --only-agents          only the GUI tests of agents on another machine (needs a display)
//   gjs -m dist/run-tests.js --only-harness         only the GUI tests of kanban cards worked on by a fake pi (needs a display)
//   gjs -m dist/run-tests.js --only-csv            only the GUI tests of the CSV tab (needs a display)
//   gjs -m dist/run-tests.js --only-html           only the GUI tests of an HTML page in its tab (needs a display)
//   gjs -m dist/run-tests.js --only-history         only the GUI tests of the History tab and the history viewer (needs a display)
//   gjs -m dist/run-tests.js --only-worktrees        only the harness queue and the worktree per card (real git, no display)
//   gjs -m dist/run-tests.js --only-daemon           only the markworkd client tests (the live part needs Go to build the daemon)
//   gjs -m dist/run-tests.js --mouse                 add real mouse clicks (the pointer will move)
//   gjs -m dist/run-tests.js --screenshot=a.png      save a screenshot of the editor window
//   gjs -m dist/run-tests.js --shot-proposal=/tmp/p  save screenshots of the agent proposal review window (/tmp/p-<n>-review.png and -main.png)
//   gjs -m dist/run-tests.js --shot-csv=/tmp/c       save screenshots of the CSV tab light/dark and a file of 20,000 rows (/tmp/c-light.png, /tmp/c-dark.png, /tmp/c-big.png)
//   gjs -m dist/run-tests.js --shot-inbox=/tmp/i     save screenshots of the inbox light/dark (/tmp/i-light.png, /tmp/i-dark.png)
//   gjs -m dist/run-tests.js --shot-agents=/tmp/a    save screenshots of agents on another machine: Home with the connection, the Preferences page, the close question (/tmp/a-home-connected.png, -preferences.png, -close.png, and -dark)
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

import '../src/platform/gjs/install.js';   // the core reaches the runtime through platform()
import './host-gjs.js';   // the tests reach the runtime through host(), installed before framework.ts
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import System from 'system';

import { DIM, GREEN, RED, RESET, collectBeforeEachTest, errorMessage, opt, optVal, recordFailure, setRoot, settle, summary } from './framework.js';
import { WELCOME } from '../src/welcome.js';
import { createContext, type GuiContext } from './gui/context.js';
import { widgetPixbuf } from './widgets.js';
import { incrementalTests } from './unit/incremental.js';
import { settingsTests } from './unit/settings.js';
import { actionTests } from './unit/actions.js';
import { tableTests } from './unit/table.js';
import { codeLanguageTests } from './unit/codelang.js';
import { discardTests } from './unit/discard.js';
import { gjsPortTests } from './unit/gjsport.js';
import { runCoreTests } from './core-tests.js';
import { dialogTests } from './gui/dialogs.js';
import { harnessTests } from './gui/harness.js';
import { agentsHostTests } from './gui/agentshost.js';
import { chatTests } from './gui/chat.js';
import { syntaxHidingTests } from './gui/syntax.js';
import { listTests, listIndentTests } from './gui/lists.js';
import { formatTests } from './gui/format.js';
import { fileTests } from './gui/file.js';
import { imageTests } from './gui/image.js';
import { imageZoomTests } from './gui/imagezoom.js';
import { codeColorTests } from './gui/codecolor.js';
import { mermaidTests } from './gui/mermaid.js';
import { htmlPageTests } from './gui/htmlpage.js';
import { csvTests as csvGuiTests } from './gui/csv.js';
import { csvMouseTests } from './gui/csv-mouse.js';
import { tableGridTests } from './gui/table.js';
import { codeBlockTests } from './gui/codeblock.js';
import { conflictLayerTests } from './gui/conflicts.js';
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
import { collabTests } from './gui/collab.js';
import { forgejoTests } from './gui/forgejo.js';
import { tabTests } from './gui/tabs.js';
import { homeTests } from './gui/home.js';
import { journalTests } from './gui/journal.js';

setRoot(import.meta.url);

// The core's tests (shared with the Node runner, run-core-node.ts), then the unit tests that need GJS: the editor
// engine's GTK parts, GSettings, the file tree's Gio operations, and the GJS port's own guards. settle() runs the main
// loop while the async ones wait.
function runUnitTests(): void {
    settle(runCoreTests(), 30 * 60 * 1000);
    incrementalTests();
    settingsTests();
    actionTests();
    tableTests();
    codeLanguageTests();
    discardTests();
    settle(gjsPortTests(), 60 * 1000);
}

// Close the shared test window. Its "unrealize" handler destroys the editors; if it never ran (GJS drops callbacks while
// a collection is sweeping), the editor's widgets would reach the final collection still wired up, so say so here.
function closeMain(c: GuiContext): void {
    c.buf.set_modified(false);
    c.w.win.destroy();
    if (!c.ed.isDestroyed) {
        recordFailure();
        print(`${RED}The test window closed without destroying its editor (its unrealize handler did not run)${RESET}`);
    }
}

function runGuiTests(app: Adw.Application): void {
    collectBeforeEachTest(true);
    const c = createContext(app);
    if (opt('only-agents')) {
        agentsHostTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-dialogs')) {
        dialogTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-gnome')) {
        gnomeTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-chat')) {
        chatTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-forgejo')) {
        forgejoTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-collab')) {
        collabTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-journal')) {
        journalTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-harness')) {
        harnessTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-history')) {
        historyTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-home')) {
        homeTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-html')) {
        htmlPageTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-csv')) {
        csvGuiTests(c);
        if (opt('with-kanban-mouse')) csvMouseTests(c);
        closeMain(c);
        return;
    }
    if (opt('only-folder-mouse')) {
        folderMouseTests(c);
        closeMain(c);
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
    conflictLayerTests(c);
    mermaidTests(c);
    htmlPageTests(c);
    kanbanBoardTests(c);
    inboxTests(c);
    tableLayoutGuiTests(c);
    csvGuiTests(c);
    layoutsGuiTests(c);
    harnessTests(c);
    agentsHostTests(c);
    dialogTests(c);
    // The folder tests create another window and replace the app actions. Check undo/redo
    // with the mouse while the actions are still connected to this context's window.
    if (opt('with-kanban-mouse')) kanbanMouseTests(c);
    if (opt('with-kanban-mouse')) csvMouseTests(c);
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
    collabTests(c);
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

    closeMain(c);
}

// ───────────────────────── Run ─────────────────────────

if (opt('only-worktrees')) {
    settle(runCoreTests('worktrees'), 30 * 60 * 1000);
    const { passed, failed } = summary();
    print(`\n${failed ? RED : GREEN}${passed} passed, ${failed} failed${RESET}`);
    System.exit(failed ? 1 : 0);
}

if (opt('only-daemon')) {
    settle(runCoreTests('daemon'), 30 * 60 * 1000);
    const { passed, failed } = summary();
    print(`\n${failed ? RED : GREEN}${passed} passed, ${failed} failed${RESET}`);
    System.exit(failed ? 1 : 0);
}

if (!opt('only-agents') && !opt('only-forgejo') && !opt('only-harness')) runUnitTests();

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
