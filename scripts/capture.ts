// Takes screenshots of the real app for the landing page (docs/). Bundled by Vite into dist/capture.js.
//
//   npm run docs
//
// Writes PNGs and GIFs to docs/assets/. A real window is opened, so a desktop session is needed.

import '../src/platform/gjs/install.js';   // the core reaches the runtime through platform()
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import Gio from 'gi://Gio';
import System from 'system';

import { MainWindow } from '../src/window.js';
import { moveCard, parseBoard } from '../src/markdown/kanban.js';
import { isBoard } from '../src/markdown/layout.js';
import type { Provider } from '../src/agent/provider.js';
import { listChats, saveChat } from '../src/agent/chatstore.js';
import { iterAtLine } from '../src/gtkutil.js';
import { descendants, whenDialogReady, widgetPixbuf } from '../tests/widgets.js';
import { editCardDialog, findDialog, harnessAskDialog } from '../src/ui/dialogs.js';
import { findEntry } from '../src/ui/menu.js';
import { localDate } from '../src/markdown/home.js';
import { sendChangesDialog } from '../src/ui/sendchanges.js';
import type { HttpRequest, HttpResponse } from '../src/forge/types.js';
import { inMemorySettings } from '../src/platform/gjs/settings.js';

// A sample work folder for the Assistant panel screenshots (a fake provider; no network and no API key):
// a product launch project with a plan, meeting notes, research, and a task board.
const WORK: Record<string, string> = {
    'plans/launch.md': '# Markwork 1.0 Launch Plan\n\n## Goal\n\nRelease Markwork 1.0 for Linux users, complete with folder syncing.\n\n## Schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n- Evaluation: 30 November\n\n## Budget\n\nTotal $3,000, including the redesign and a test server.\n',
    'notes/meeting-1-oct.md': '# Weekly meeting, 1 October\n\n## Decisions\n\n- The public release is postponed to **22 November** because the sync testing is not finished.\n- The budget does not change.\n- Sari prepares the release material.\n\n## Follow-up\n\n- [ ] Budi fixes the sync bug\n- [ ] Dewi schedules the beta trial\n',
    'notes/meeting-8-oct.md': '# Weekly meeting, 8 October\n\nThe sync bug is still open. The closed beta stays on 20 October.\n',
    'research/competitors.md': '# Competitor research\n\nThree similar note apps; all of them are paid and closed.\n',
    'research/users.md': '# User interviews\n\nFive users want syncing without an account.\n',
    'tasks.md': '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Prepare the release material #marketing [due:: 2026-11-10]\n- [ ] Write the release notes #docs\n\n## In Progress\n\n- [ ] Fix the sync bug #bug #important [due:: 2026-10-25]\n\n## Done\n\n- [x] Redesign the home page #design\n',
    'ideas.md': '# Ideas\n\nA PDF export feature.\n',
};
const ASK_READ = 'Is there a meeting decision that has not made it into the launch plan yet?';
const ANSWER = `There is **one decision that is not in the plan yet**:

- In *notes/meeting-1-oct.md* › Decisions: "The public release is postponed to 22 November because the sync testing is not finished."
- In *plans/launch.md* › Schedule: "Public release: 15 November."

The budget is already consistent ($3,000) and the closed beta stays on 20 October. Shall I propose a change to the date?`;
const ASK_ACT = 'Yes, update the release date and move the release material card to In Progress.';
const ANSWER_ACT = 'Done. The release date in the plan is now **22 November**, and the card *Prepare the release material* is in the *In Progress* list.';

// A development board for the orchestrator scene: @pi cards are worked on in another project repo.
const PI_BOARD = `---
layout: board
project: web-ecommerce
---

## Plan

- [ ] Checkout with QRIS [agent:: pi] #feature
  Use the official SDK.
- [ ] Test the cart [agent:: pi] #test
- [ ] Tidy up the README #docs

## In Progress

## Review

## Done

- [x] Product page #feature
`;

// A fake pi that speaks RPC over stdin/stdout (the same as the harness GUI test): MODE slow waits for the file
// "release", ask ends the turn with a question. It calls neither the real pi nor any API.
const fakePi = (dir: string) => `#!/bin/sh
mode=$(cat "${dir}/mode")
read -r cmd
echo '{"id":"markwork-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"7f3c2a91"}}'
read -r cmd
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
echo '{"type":"turn_start"}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Look at the project structure first, then find the payment module."}}'
echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls src/checkout"}}'
printf '%s\\n' '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"cart.ts\\npayment.ts\\nindex.ts"}]},"isError":false}'
echo '{"type":"tool_execution_start","toolCallId":"t2","toolName":"edit","args":{"path":"src/checkout/qris.ts"}}'
if [ "$mode" = slow ]; then while [ ! -e "${dir}/release" ]; do sleep 0.05; done; fi
echo '{"type":"tool_execution_end","toolCallId":"t2","toolName":"edit","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
if [ "$mode" = ask ]; then
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I have read the README.\\n\\nThe installation section uses both npm and pnpm. Shall I standardize it on pnpm only?"}],"stopReason":"stop"}}'
  echo '{"type":"agent_settled"}'
  read -r ans || exit 0
fi
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"QRIS added in src/checkout/qris.ts with 3 tests"}],"stopReason":"stop","usage":{"input":5210,"output":640,"totalTokens":5850,"cost":{"total":0.0042}}}}'
echo '{"type":"agent_settled"}'
while read -r x; do :; done
`;

const GIF_WIDTH = 900;   // the original PNG is larger
const GIF_STEP = 140;    // ms per frame
const GIF_COLORS = 128;
const OUT = GLib.getenv('MARKWORK_OUT') ?? 'docs/assets';

const DOC = `# Product Meeting Notes

Weekly meeting, **Friday morning**. Things that *need* follow-up are below, this text is ==highlighted== and ~~this one is struck through~~.

## Decisions

- The \`1.0\` release is postponed by one week
- [x] Fix the HTML export bug
- [ ] Write the kanban feature [documentation](https://github.com/EkaPutCom/markwork)

> A quote from a user: "At last, an editor that stays out of the way."

\`\`\`ts
function remainingBudget(total: number, spent: number): number {
    return total - spent;
}
\`\`\`

## Schedule

| Task | Owner | Deadline |
| :---- | :--------------: | ------: |
| Redesign | **Sari** | 10 Oct |
| Trial run | *Budi* | 17 Oct |
`;

const TABLE_DOC = `# Project Budget

Tables are rendered as a grid. Click a cell to edit it.

| Item | Owner | Cost ($) |
| :-- | :--------------: | ---------: |
| **Design** | Sari | 750 |
| Development | *Budi* | 2,800 |
| Testing | Dewi | 530 |
| \`Server\` | Andi | 375 |
| [License](https://example.com) | Rina | 200 |

The total cost is still below the **budget**.
`;

const DIAGRAM_DOC = `# Diagrams from Text

Write a diagram as code and see the result right away.

\`\`\`mermaid
graph LR
    A[Note] --> B{Needs follow-up?}
    B -->|yes| C[Create a task]
    B -->|not yet| A
    C --> D[Review together with the agent]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    You->>Agent: Update the release schedule
    Agent-->>You: Change proposal (diff)
    You->>Agent: Apply
\`\`\`
`;

const DBML_DOC = `# Database Schema

A \`dbml\` block (the dbdiagram.io language) is drawn as an ER diagram.

\`\`\`dbml
Table projects {
  id int [pk]
  name varchar
}

Table tasks {
  id int [pk]
  title varchar
  project_id int
}

Ref: tasks.project_id > projects.id
\`\`\`
`;

const BOARD = `---
layout: board
---

## Plan

- [ ] User research #research [due:: 2026-10-10]
  Interview five active users.
- [ ] Redesign the home page #design
- [ ] Write the **API** documentation #docs [due:: 2026-10-25]

## In Progress

- [ ] Implement the kanban board #feature #important
- [ ] Fix the \`HTML export\` bug #bug [due:: 2026-10-03]

## Review

- [ ] Trial on Ubuntu 24.04 #qa

## Done

- [x] Choose the project name: Markwork
- [x] Set up the GitHub repository #infra
`;

const CODE_DOC = `# Colored Code Blocks

\`\`\`python
from datetime import date

def days_left(release, today):
    return (release - today).days

print(days_left(date(2026, 11, 22), date(2026, 10, 5)))
\`\`\`

\`\`\`rust
fn total_budget(costs: &[u64]) -> u64 {
    costs.iter().sum()
}
\`\`\`

\`\`\`bash
git add plans/ && git commit -m "Update the release schedule"
\`\`\`
`;

// A fake model provider plays a script: every round contains a tool call or the final answer.
type Call = { id: string; name: string; arguments: string };
const tool = (id: string, name: string, args: object): Call => ({ id, name, arguments: JSON.stringify(args) });

// The scenes run in this order on one window; some reuse what an earlier scene set up (the work folder, the git repo).
const SCENES: (keyof Capture & string)[] = [
    'screenshots', 'syntaxGif', 'typingGif', 'diagramGif', 'kanbanGif', 'layouts', 'themeGif', 'assistant', 'proposals', 'files',
    'gitHistory', 'imageZoom', 'tabs', 'chatHistory', 'contextPopover', 'workPlan', 'agentLog', 'agentGit', 'cardDialog',
    'orchestrator', 'dailyFlow', 'collab',
];

function main(app: Adw.Application): void {
    GLib.mkdir_with_parents(OUT, 0o755);
    const capture = new Capture(app);
    capture.settle(30);
    // MARKWORK_SCENES=layouts,kanbanGif runs only those scenes (some need the work folder an earlier scene sets up).
    const only = GLib.getenv('MARKWORK_SCENES')?.split(',');
    for (const scene of SCENES) if (!only || only.includes(scene)) (capture[scene] as () => void)();
    writeGifs(capture.pending);
    print(`Done: ${OUT}`);
    capture.close();
}

// GIF: frames are collected per name; writeGifs() builds one palette per GIF, marks the pixels that did not
// change from the previous frame as transparent (much smaller), and then writes the file.
type Frames = Map<string, { px: GdkPixbuf.Pixbuf; delay: number }[]>;

// A pixbuf can be RGB or RGBA and its rows can contain padding; gifenc needs packed RGBA.
function toRgba(px: GdkPixbuf.Pixbuf): Uint8Array {
    const width = px.get_width(), height = px.get_height();
    const raw = px.get_pixels(), stride = px.get_rowstride(), n = px.get_n_channels();
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * stride + x * n, o = (y * width + x) * 4;
            rgba[o] = raw[i]; rgba[o + 1] = raw[i + 1]; rgba[o + 2] = raw[i + 2]; rgba[o + 3] = 255;
        }
    }
    return rgba;
}

function writeGifs(pending: Frames): void {
    for (const [name, frames] of pending) writeGif(name, frames.map(f => ({ rgba: toRgba(f.px), delay: f.delay })), frames[0].px.get_height());
}

function writeGif(name: string, list: { rgba: Uint8Array; delay: number }[], height: number): void {
    const width = GIF_WIDTH;
    // One palette from all the frames at once (sampled every 4 pixels), leaving one index for "transparent".
    const sample = new Uint8Array(list.reduce((sum, f) => sum + Math.ceil(f.rgba.length / 16) * 4, 0));
    let at = 0;
    for (const f of list) for (let i = 0; i < f.rgba.length; i += 16) { sample.set(f.rgba.subarray(i, i + 4), at); at += 4; }
    const palette = quantize(sample, GIF_COLORS - 1);
    const clear = palette.length;
    palette.push([0, 0, 0]);
    const enc = GIFEncoder();
    let prev: Uint8Array | null = null;
    for (const f of list) {
        const index = applyPalette(f.rgba, palette);
        if (!prev) {
            enc.writeFrame(index, width, height, { palette, delay: f.delay });
        } else {
            const diff = index.slice();
            for (let i = 0; i < diff.length; i++) if (diff[i] === prev[i]) diff[i] = clear;
            enc.writeFrame(diff, width, height, { delay: f.delay, transparent: true, transparentIndex: clear, dispose: 1 });
        }
        prev = index;
    }
    enc.finish();
    const bytes = enc.bytes();
    GLib.file_set_contents(`${OUT}/${name}.gif`, bytes);
    print(`${name}.gif: ${list.length} frames,  ${Math.round(bytes.length / 1024)} KB`);
}

const saveWidget = (widget: Gtk.Widget, name: string): boolean => widgetPixbuf(widget)!.savev(`${OUT}/${name}.png`, 'png', [], []);

// The window, the capture helpers, and the scenes.
class Capture {
    readonly w: MainWindow;
    readonly pending: Frames = new Map();
    private streamFrames = false;
    private readonly context = GLib.MainContext.default();
    // Set up by the Assistant scene; the work folder of the launch project and its plan.
    private proj = '';
    private plan = '';
    // Set up by the Git history scene.
    private repo = '';
    private note = '';

    constructor(app: Adw.Application) {
        const settings = inMemorySettings({ welcomed: true, home: false, dark: false, sidebarPage: 'files', width: 1280, height: 780 });
        this.w = new MainWindow(app, settings, null);
    }

    private get ed() { return this.w.editor; }
    private get buf() { return this.w.editor.buffer; }

    close(): void {
        this.buf.set_modified(false);
        this.w.win.destroy();
    }

    // ---------- Helpers ----------

    pump(): void { for (let i = 0; i < 200 && this.context.pending(); i++) this.context.iteration(false); }
    settle(n = 12): void { for (let i = 0; i < n; i++) { this.pump(); GLib.usleep(15000); } }
    private idle(ms: number): void { for (let i = 0; i < ms / 10; i++) { this.pump(); GLib.usleep(10000); } }
    private until(done: () => boolean): void { while (!done()) { this.pump(); GLib.usleep(5000); } }
    private waitFor(cond: () => boolean, ms = 8000): boolean { for (let i = 0; i < ms / 10 && !cond(); i++) { this.pump(); GLib.usleep(10000); } this.idle(200); return cond(); }

    // Dialogs answer through a Promise; the capture is scheduled by a timer and then the dialog is closed, so wait for its answer.
    private waitPromise(promise: Promise<unknown>): void {
        let done = false;
        void promise.finally(() => { done = true; });
        for (let i = 0; i < 2000 && !done; i++) { this.pump(); GLib.usleep(5000); }
    }

    private waitMermaid(): void {
        for (let i = 0; i < 3000 && this.ed.mermaid.blocks.some(b => b.busy || b.timer); i++) { this.pump(); GLib.usleep(10000); }
        this.settle();
    }

    // In the middle of layout (e.g. while an answer streams) the window size can briefly be 0 and the capture empty; retry.
    private grab(): GdkPixbuf.Pixbuf {
        for (let i = 0; i < 50; i++) {
            this.settle();
            const px = widgetPixbuf(this.w.win);
            if (px) return px;
        }
        throw new Error('the window cannot be captured');
    }

    private shot(name: string): void { this.grab().savev(`${OUT}/${name}.png`, 'png', [], []); }

    // `hold` = how many steps (GIF_STEP ms) this frame is held before it changes.
    // Only the pixbuf is stored (native memory): a large array on the JS heap triggers GC in the middle of capturing.
    private frame(gif: string, hold = 0): void {
        const src = this.grab();
        const px = src.scale_simple(GIF_WIDTH, Math.round(src.get_height() * GIF_WIDTH / src.get_width()), GdkPixbuf.InterpType.HYPER)!;
        if (!this.pending.has(gif)) this.pending.set(gif, []);
        this.pending.get(gif)!.push({ px, delay: GIF_STEP * (1 + hold) });
    }

    private load(text: string, dark = false, line = 0, sidebar = true): void {
        const { w, ed, buf } = this;
        w.setOption('dark', dark);
        w.setOption('sidebar', sidebar);
        w.file = null;
        ed.setText(text);
        w.setBoardMode(isBoard(text));
        buf.place_cursor(iterAtLine(buf, line));
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        this.settle(20);
    }

    private cursorTo(line: number, col = 0): void {
        const it = iterAtLine(this.buf, line);
        it.forward_chars(col);
        this.buf.place_cursor(it);
        this.settle(4);
    }

    private put(rel: string, text: string, root = this.proj): string {
        const path = GLib.build_filenamev([root, ...rel.split('/')]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, text);
        return path;
    }

    // Answers streamed word by word; with streamFrames, every sixth word is a frame of `gif`.
    private scripted(rounds: (Call[] | string)[], gif = 'assistant'): Provider {
        let at = 0;
        return {
            chat: async req => {
                const step = rounds[Math.min(at++, rounds.length - 1)];
                if (typeof step !== 'string') return { usage: { prompt: 1840, cached: 1536, completion: 40 }, cancelled: false, reasoning: '', toolCalls: step };
                (step.match(/\S+\s*/g) ?? []).forEach((part, i) => {
                    req.onText(part);
                    if (this.streamFrames && i % 6 === 5) this.frame(gif, 0);
                });
                return { usage: { prompt: 3920, cached: 1536, completion: 148 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        };
    }

    // Send a question and wait for the whole answer.
    private askAndWait(question: string): void {
        let done = false;
        void this.w.chat.ask(question).then(() => { done = true; });
        this.until(() => done);
    }

    private nextViewer() {
        for (let i = 0; i < 800 && !this.w.chat.viewer; i++) { this.pump(); GLib.usleep(10000); }
        const viewer = this.w.chat.viewer;
        if (!viewer) throw new Error('the review window did not appear');
        this.idle(400);
        return viewer;
    }

    // The visible child window (a viewer); the invisible WebKit window of Mermaid is a toplevel too.
    private child(): Gtk.Window | undefined {
        return Gtk.Window.list_toplevels().find(t => t.get_visible() && (t as unknown as Gtk.Window).get_transient_for() === (this.w.win as unknown as Gtk.Window)) as Gtk.Window | undefined;
    }

    // Save the visible child window, if any, and close it.
    private saveChild(name: string): void {
        const win = this.child();
        if (!win) return;
        saveWidget(win, name);
        win.destroy();
    }

    // A GTK 4 popover has its own surface and its position cannot be read; place it the way GTK places it:
    // below (or above) its button, centered, and not outside the window.
    private grabWithPopover(button: Gtk.MenuButton, above = false): GdkPixbuf.Pixbuf {
        const popover = button.get_popover()!;
        popover.popup();
        this.idle(500);
        const main = this.grab();
        const pop = widgetPixbuf(popover);
        const [, tx, ty] = button.translate_coordinates(this.w.win, 0, 0);
        // The window capture includes the CSD frame; the widget coordinates start inside it.
        const [sx, sy] = this.w.win.get_surface_transform();
        const bx = tx + sx, by = ty + sy;
        if (pop) {
            const x = Math.max(0, Math.min(main.get_width() - pop.get_width(), Math.round(bx + button.get_width() / 2 - pop.get_width() / 2)));
            const y = above ? Math.max(0, Math.round(by - pop.get_height())) : Math.round(by + button.get_height());
            const h = Math.min(pop.get_height(), main.get_height() - y);
            pop.composite(main, x, y, pop.get_width(), h, x, y, 1, 1, GdkPixbuf.InterpType.NEAREST, 255);
        }
        popover.popdown();
        this.idle(200);
        return main;
    }

    // Write the sample work folder again (scenes change it) and open it with the plan.
    private openWork(): void {
        for (const [rel, text] of Object.entries(WORK)) this.put(rel, text);
        this.w.openFolder(this.proj, false);
        this.w.load(this.plan);
    }

    // ---------- Scenes ----------

    screenshots(): void {
        const load = this.load.bind(this), cursorTo = this.cursorTo.bind(this), shot = this.shot.bind(this);
        load(DOC, false, 0);
        cursorTo(2, 5);
        shot('editor-light');

        load(DOC, true, 0);
        cursorTo(2, 5);
        shot('editor-dark');
        load(DOC, false, 0);

        load(TABLE_DOC);
        cursorTo(0);
        shot('table');

        load(CODE_DOC);
        cursorTo(0);
        shot('code');

        for (const [text, name] of [[DIAGRAM_DOC, 'diagram'], [DBML_DOC, 'dbml']]) {
            load(text, false, 0, false);
            cursorTo(0);
            this.waitMermaid();
            shot(name);
        }

        load(BOARD, false, 0, false);
        shot('kanban');
        load(BOARD, true, 0, false);
        shot('kanban-dark');
        load(BOARD, false, 0, false);
    }

    // GIF 1: syntax appears and disappears.
    syntaxGif(): void {
        this.load(DOC, false, 0);
        for (const [line, col] of [[0, 8], [2, 20], [2, 55], [5, 12], [6, 8], [7, 20], [0, 0]] as const) {
            this.cursorTo(line, col);
            this.frame('syntax', 2);
        }
    }

    // GIF 2: typing Markdown.
    typingGif(): void {
        this.load('', false, 0);
        const typed = '# Meeting Notes\n\nDecision: release on **22 November**, the budget is *unchanged*, and the bug is in `syncing`.\n\n- [ ] Budi: fix the bug\n- [x] Sari: prepare the material\n- [ ] Dewi: schedule the beta\n';
        let acc = '';
        this.frame('typing', 2);
        for (const ch of typed) {
            this.buf.insert_at_cursor(ch, -1);
            acc += ch;
            if (ch === ' ' || ch === '\n' || ch === '*' || ch === '`' || ch === '#' || /[a-z]/i.test(ch) && acc.length % 3 === 0) this.frame('typing');
        }
        this.frame('typing', 6);
    }

    // GIF 3: a live diagram.
    diagramGif(): void {
        this.load('# Workflow\n\n```mermaid\ngraph LR\n    A[Note] --> B[Plan]\n```\n', false, 0, false);
        this.waitMermaid();
        this.frame('diagram', 3);
        this.cursorTo(4, 20);
        this.waitMermaid();
        this.frame('diagram', 3);
        for (const add of ['\n    B --> C[Do it]', '\n    C --> D[Review]', '\n    D --> A']) {
            const it = iterAtLine(this.buf, 4);
            it.forward_to_line_end();
            this.buf.insert(it, add, -1);
            this.waitMermaid();
            this.frame('diagram', 3);
        }
        this.cursorTo(0);
        this.waitMermaid();
        this.frame('diagram', 8);
    }

    // GIF 4: the kanban board. Cards move through the same board model that drag-and-drop uses.
    kanbanGif(): void {
        this.load(BOARD, false, 0, false);
        this.frame('kanban', 5);
        let board = parseBoard(this.w.editor.getText());
        const moves: [[number, number], [number, number]][] = [
            [[0, 0], [1, 0]],
            [[1, 1], [2, 0]],
            [[1, 0], [2, 0]],
        ];
        for (const [from, to] of moves) {
            board = moveCard(board, { column: from[0], index: from[1] }, { column: to[0], index: to[1] });
            this.w.board.commit(board);
            this.settle(20);
            this.frame('kanban', 5);
        }
        this.frame('kanban', 5);
    }

    // One file, many layouts: the same Markdown is shown as a board, list, table, calendar, timeline, gallery, and chart
    // by changing only its `layout:` line (the same path the header bar's layout menu takes). Dates are relative to today.
    layouts(): void {
        const w = this.w;
        const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDate(d); };
        const doc = `---
layout: board
fields:
  status: select(todo:gray, doing:blue, done:green) = todo
  start: date
  due: date
---

# Launch plan

One file. Change the layout: line and the same notes become a list, a table, a calendar, a timeline, a gallery, or a chart.

## Plan

- [ ] Write the changelog #docs [status:: todo] [start:: ${day(3)}] [due:: ${day(6)}]
- [ ] Prepare the release material #marketing [status:: todo] [start:: ${day(1)}] [due:: ${day(8)}]

## In Progress

- [ ] Fix the sync bug #bug [status:: doing] [start:: ${day(-4)}] [due:: ${day(2)}]
- [ ] Review the parser #dev [status:: doing] [start:: ${day(-1)}] [due:: ${day(4)}]

## Done

- [x] Redesign the home page #design [status:: done] [start:: ${day(-9)}] [due:: ${day(-3)}]
- [x] Migration to GTK 4 #dev [status:: done] [start:: ${day(-12)}] [due:: ${day(-6)}]
`;
        const dir = GLib.dir_make_tmp('markwork-layouts-XXXXXX');
        const path = this.put('launch-plan.md', doc, dir);
        w.setOption('chat', false);
        w.setOption('sidebar', false);
        w.setDark(false);
        w.openFile(path);
        this.idle(600);
        for (const layout of ['board', 'list', 'table', 'calendar', 'timeline', 'gallery', 'chart']) {
            w.setLayout(layout);
            this.idle(500);
            this.shot(`layout-${layout}`);
            this.frame('layouts', 8);
        }
        w.setLayout('board');
        this.idle(300);
        this.frame('layouts', 8);
        w.editor.buffer.set_modified(false);
    }

    // Collaboration: the pull requests tab, the review page, the discussion, a conflict resolved here, and the send dialog. The forge is
    // a fake that answers from a table, so no server is needed; git is real (a local bare repository stands for the server's).
    collab(): void {
        const w = this.w;
        const sh = (cwd: string, ...args: string[]): string => {
            const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
            const [, out, err, status] = GLib.spawn_sync(cwd, ['git', '-c', 'user.name=Sari', '-c', 'user.email=sari@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
            if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
            return new TextDecoder().decode(out ?? undefined).trim();
        };
        const root = GLib.dir_make_tmp('markwork-collab-XXXXXX');
        const bare = GLib.build_filenamev([root, 'forge.git']), work = GLib.build_filenamev([root, 'markwork-launch']), author = GLib.build_filenamev([root, 'author']);
        GLib.mkdir_with_parents(bare, 0o755);
        sh(bare, 'init', '-q', '--bare', '-b', 'main');
        sh(root, 'clone', '-q', bare, work);
        sh(work, 'checkout', '-q', '-B', 'main');
        const SCHEDULE = '---\ntitle: Release schedule\nlayout: list\n---\n# Release schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n';
        const RESEARCH = '# Competitor research\n\nThree similar note apps; all of them are paid and closed.\n';
        for (const [rel, text] of [['plans/launch.md', WORK['plans/launch.md']], ['plans/schedule.md', SCHEDULE], ['notes/meeting-1-oct.md', WORK['notes/meeting-1-oct.md']], ['research/competitors.md', RESEARCH]]) this.put(rel, text, work);
        sh(work, 'add', '-A');
        sh(work, 'commit', '-q', '-m', 'Start the launch project');
        sh(work, 'push', '-q', '-u', 'origin', 'main');
        // Pull request 12 edits a line that main changes too, so it conflicts. A forge keeps its head under refs/pull/12/head.
        sh(root, 'clone', '-q', bare, author);
        sh(author, 'checkout', '-q', '-b', 'typo');
        this.put('research/competitors.md', RESEARCH.replace('Three similar', 'Three similar, comparable'), author);
        sh(author, 'commit', '-q', '-a', '-m', 'Fix the wording');
        sh(author, 'push', '-q', 'origin', 'typo');
        sh(bare, 'update-ref', 'refs/pull/12/head', sh(author, 'rev-parse', 'HEAD'));
        this.put('research/competitors.md', RESEARCH.replace('Three similar note apps', 'Four similar note apps'), work);
        sh(work, 'commit', '-q', '-a', '-m', 'Count the fourth app');
        sh(work, 'push', '-q', 'origin', 'main');

        const BASE = 'b'.repeat(40), HEAD = 'a'.repeat(40);
        const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
        const HEADS: Record<number, string> = { 14: 'postpone-release', 13: 'calendar-schedule', 12: 'research-wording' };
        const pull = (n: number, title: string, user: string, hours: number, extra: object = {}) => ({
            number: n, title, state: 'open', merged: false, mergeable: true, user: { login: user }, head: { ref: HEADS[n], sha: HEAD }, base: { ref: 'main', sha: BASE },
            comments: 0, body: '', created_at: ago(hours + 1), updated_at: ago(hours), html_url: `https://git.example.org/markwork/launch/pulls/${n}`, ...extra,
        });
        const pulls = [
            pull(14, 'Postpone the public release to 22 November', 'sari', 2, { comments: 2, body: 'The 1 October meeting moved the release because the sync testing is not finished. This updates the plan and the schedule.' }),
            pull(13, 'Show the release schedule as a calendar', 'budi', 26, { comments: 1, body: 'The schedule note becomes a calendar, so the beta and the release show up next to each other.' }),
            pull(12, 'Fix the wording in the research notes', 'dewi', 70, { mergeable: false, body: 'A small wording fix.' }),
        ];
        const files: Record<number, object[]> = {
            14: [{ filename: 'plans/launch.md', status: 'modified', additions: 1, deletions: 1 }, { filename: 'plans/schedule.md', status: 'modified', additions: 1, deletions: 1 }],
            13: [{ filename: 'plans/schedule.md', status: 'modified', additions: 3, deletions: 1 }],
            12: [{ filename: 'research/competitors.md', status: 'modified', additions: 1, deletions: 1 }],
        };
        const launch = WORK['plans/launch.md'];
        const content: Record<string, string> = {
            [`plans/launch.md@${BASE}`]: launch, [`plans/launch.md@${HEAD}`]: launch.replace('Public release: 15 November', 'Public release: 22 November'),
            [`plans/schedule.md@${BASE}`]: SCHEDULE,
            [`plans/schedule.md@${HEAD}`]: SCHEDULE.replace('layout: list', 'layout: calendar\ndate: due').replace('15 November', '22 November'),
            [`research/competitors.md@${BASE}`]: RESEARCH, [`research/competitors.md@${HEAD}`]: RESEARCH.replace('Three similar', 'Three similar, comparable'),
        };
        const comments: Record<number, object[]> = {
            14: [{ id: 1, body: 'Agreed. The sync fix needs two more weeks.', user: { login: 'budi' }, created_at: ago(1.5) }, { id: 2, body: 'I moved the beta note too, so the schedule stays in one piece.', user: { login: 'sari' }, created_at: ago(1) }],
            13: [{ id: 3, body: 'The calendar reads better than the list. Merging after the release date is settled.', user: { login: 'dewi' }, created_at: ago(20) }],
        };
        const DIFF_14 = [
            'diff --git a/plans/launch.md b/plans/launch.md', '--- a/plans/launch.md', '+++ b/plans/launch.md', '@@ -5,7 +5,7 @@ Release Markwork 1.0 for Linux users, complete with folder syncing.',
            ' ## Schedule', ' ', ' - Closed beta: 20 October', '-- Public release: 15 November', '+- Public release: 22 November', ' - Evaluation: 30 November', '',
            'diff --git a/plans/schedule.md b/plans/schedule.md', '--- a/plans/schedule.md', '+++ b/plans/schedule.md', '@@ -5,4 +5,4 @@ layout: list',
            ' # Release schedule', ' ', ' - Closed beta: 20 October', '-- Public release: 15 November', '+- Public release: 22 November', '',
        ].join('\n');
        const API = 'https://git.example.org/api/v1/repos/markwork/launch';
        const answer = (request: HttpRequest): HttpResponse => {
            const json = (value: unknown): HttpResponse => ({ status: 200, body: JSON.stringify(value) });
            if (request.url === 'https://git.example.org/api/v1/user') return json({ login: 'eka' });
            const path = request.url.slice(API.length);
            if (path === '') return json({ name: 'launch', owner: { login: 'markwork' }, clone_url: bare, default_branch: 'main', fork: false, permissions: { push: false } });
            if (path.startsWith('/pulls?')) return json(pulls);
            const n = Number(/\/(?:pulls|issues)\/(\d+)/.exec(path)?.[1]);
            if (path.endsWith('/files') || path.includes('/files?')) return json(files[n] ?? []);
            if (path === '/pulls/14.diff') return { status: 200, body: DIFF_14 };
            if (path.endsWith('.diff')) return { status: 200, body: '' };
            if (path.endsWith('/comments')) return json(comments[n] ?? []);
            const raw = /^\/raw\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
            if (raw) { const hit = content[`${decodeURIComponent(raw[1])}@${raw[2]}`]; return hit === undefined ? { status: 404, body: '{}' } : { status: 200, body: hit }; }
            return { status: 404, body: '{"message":"not found"}' };
        };
        w.collab.services.tokens = { get: async () => ({ token: 'example', source: 'env' }), set: async () => 'env', clear: async () => {} };
        w.collab.services.transport = async request => answer(request);
        w.collab.services.remoteUrl = async () => 'https://git.example.org/markwork/launch.git';
        w.settings.forgeNotify = false;

        w.setOption('chat', false);
        w.setOption('dark', false);
        w.openFolder(work);
        w.openFile(GLib.build_filenamev([work, 'plans', 'launch.md']));
        this.idle(400);
        w.sidebar.setPage('collab');
        this.waitFor(() => w.collab.pulls.length === 3);
        this.idle(300);
        this.frame('collab', 8);

        // Review: the note view, then the raw diff, then the discussion.
        const view = w.pullView;
        const open = (n: number) => { this.waitPromise(w.pulls.open(w.collab.pulls.find(p => p.number === n)!)); this.waitFor(() => !!view.files.get_row_at_index(0)); this.idle(500); };
        open(14);
        w.pulls.dialogs.merge = async () => false;
        this.shot('collab-review');
        this.frame('collab', 10);
        view.rawButton.set_active(true);
        this.idle(300);
        this.shot('collab-diff');
        this.frame('collab', 8);
        view.discussionButton.set_active(true);
        this.idle(300);
        this.shot('collab-discussion');
        this.frame('collab', 10);

        // A pull request that conflicts is merged here: the file opens in source mode with git's markers.
        open(12);
        this.shot('collab-conflict');
        this.frame('collab', 8);
        w.pulls.dialogs.local = async () => true;
        w.pulls.dialogs.abort = async () => true;
        this.waitPromise(w.pulls.resolve());
        this.idle(800);
        this.shot('collab-resolve');
        this.frame('collab', 12);
        open(12);
        this.waitPromise(w.pulls.abort());
        this.idle(300);

        // Sending the changes of the folder as a pull request, from the document (the toast of the undo has faded by then).
        w.pulls.close();
        w.openFile(GLib.build_filenamev([work, 'plans', 'launch.md']));
        this.idle(4500);
        this.put('plans/launch.md', launch.replace('Public release: 15 November', 'Public release: 22 November'), work);
        const dialog = sendChangesDialog(w.win, { repository: 'markwork/launch', base: 'main', folder: work, changes: [{ path: GLib.build_filenamev([work, 'plans', 'launch.md']), kind: 'modified' }], canPush: false });
        this.waitFor(() => !!w.win.get_visible_dialog());
        const entry = descendants(w.win.get_visible_dialog() as Gtk.Widget).find((x): x is Gtk.Entry => x instanceof Gtk.Entry);
        entry?.set_text('Move the public release to 22 November');
        this.idle(600);
        this.shot('collab-send');
        this.frame('collab', 12);
        w.win.get_visible_dialog()?.close();
        this.waitPromise(dialog);
        w.collab.dispose();
        w.pulls.close();
    }

    // GIF 5: light ↔ dark mode.
    themeGif(): void {
        for (const dark of [false, true]) {
            this.load(DOC, dark, 0);
            this.cursorTo(0);
            this.frame('theme', 8);
        }
    }

    // The Assistant panel answering from the work folder, light and dark (the light run is also a GIF).
    assistant(): void {
        const w = this.w;
        // The folder name is shown in the Files tab and the window title, so give it a sensible name (not a temporary one).
        this.proj = GLib.build_filenamev([GLib.dir_make_tmp('markwork-work-XXXXXX'), 'markwork-launch']);
        GLib.mkdir_with_parents(this.proj, 0o755);
        this.plan = GLib.build_filenamev([this.proj, 'plans', 'launch.md']);
        this.openWork();
        w.session.assistant.chat.keyStore = { get: async () => ({ key: 'example', source: 'env' }), set: async () => 'env', clear: async () => {} };
        for (const dark of [false, true]) {
            w.session.assistant.chat.makeProvider = () => this.scripted([
                [{ id: 'a', name: 'search_text', arguments: '{"text":"Public release"}' }, { id: 'b', name: 'read_file', arguments: '{"name":"meeting-1-oct"}' }],
                ANSWER,
            ]);
            w.setDark(dark);
            w.chat.reset();
            w.setOption('chat', true);
            w.sidebar.setPage('files');
            this.streamFrames = !dark;
            if (this.streamFrames) this.frame('assistant', 4);
            this.askAndWait(ASK_READ);
            this.settle(20);
            if (this.streamFrames) this.frame('assistant', 10);
            this.shot(dark ? 'assistant-dark' : 'assistant-light');
        }
        w.setDark(false);
    }

    // The agent proposes changes (review window, then applied).
    proposals(): void {
        const w = this.w;
        w.session.assistant.chat.makeProvider = () => this.scripted([
            [{ id: 'u1', name: 'edit_file', arguments: JSON.stringify({ name: 'plans/launch.md', old_text: '- Public release: 15 November', new_text: '- Public release: 22 November', reason: 'The 1 October meeting postponed the public release to 22 November.' }) }],
            [{ id: 'u2', name: 'edit_note', arguments: JSON.stringify({ name: 'tasks.md', action: 'move', note: 'Prepare the release material', group: 'In Progress', reason: 'Sari started preparing the release material.' }) }],
            ANSWER_ACT,
        ], 'agent');
        this.streamFrames = true;
        w.chat.reset();
        let acted = false;
        void w.chat.ask(ASK_ACT).then(() => { acted = true; });
        for (const [name, hold] of [['proposal-diff', 6], ['proposal-kanban', 0]] as const) {
            const viewer = this.nextViewer();
            this.frame('agent', 8);
            saveWidget(viewer.window, name);
            viewer.applyButton.emit('clicked');
            if (hold) { this.idle(400); this.frame('agent', hold); }
        }
        this.until(() => acted);
        this.idle(600);
        this.frame('agent', 14);
        const agentShot = this.grab();
        agentShot.savev(`${OUT}/agent-done.png`, 'png', [], []);
        // The social share image (1200x631): the whole window is scaled down, and then its empty bottom part is cropped.
        agentShot.scale_simple(1200, Math.round(agentShot.get_height() * 1200 / agentShot.get_width()), GdkPixbuf.InterpType.HYPER)!
            .new_subpixbuf(0, 0, 1200, 631).savev(`${OUT}/og-image.png`, 'png', [], []);
        this.streamFrames = false;
        w.setOption('chat', false);
        w.editor.buffer.set_modified(false);
    }

    // Files: the folder tree. The sample contents are restored (the proposals changed the plan and the board),
    // so the next screenshots are consistent with the Assistant answers.
    files(): void {
        const w = this.w;
        this.openWork();
        w.setOption('sidebar', true);
        w.sidebar.setPage('files');
        w.fileTree.reveal(GLib.build_filenamev([this.proj, 'research', 'competitors.md']));
        w.fileTree.reveal(this.plan);
        this.settle(20);
        this.shot('files');
    }

    // Git history of a small repo, light and dark, and the commit reading window.
    gitHistory(): void {
        const w = this.w;
        const repo = this.repo = GLib.dir_make_tmp('markwork-history-XXXXXX');
        const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
        const git = (...args: string[]) => {
            const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Eka Putra', '-c', 'user.email=eka@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
            if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
        };
        const note = this.note = GLib.build_filenamev([repo, 'plan.md']);
        const versions = [
            ['Create the plan outline', '# Launch Plan\n\n## Goal\n\nRelease Markwork 1.0.\n'],
            ['Add a schedule section', '# Launch Plan\n\n## Goal\n\nRelease Markwork 1.0.\n\n## Schedule\n\n- Closed beta: October\n'],
            ['Clarify the goal and the dates', '# Launch Plan\n\n## Goal\n\nRelease Markwork 1.0 for Linux users, complete with folder syncing.\n\n## Schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n'],
        ];
        git('init', '-q');
        for (const [msg, text] of versions) {
            GLib.file_set_contents(note, text);
            git('add', 'plan.md');
            git('commit', '-q', '-m', msg);
        }
        GLib.file_set_contents(note, versions[2][1] + '- Evaluation: 30 November\n');
        GLib.file_set_contents(GLib.build_filenamev([repo, 'ideas.md']), '# Ideas\n\nA PDF export feature (not in git yet).\n');
        w.openFolder(repo, false);
        w.load(note);
        w.setOption('sidebar', true);
        w.sidebar.setPage('history');
        this.idle(3000);
        this.shot('history');
        w.setDark(true);
        this.idle(300);
        this.shot('history-dark');
        w.setDark(false);
        this.idle(300);

        // The commit reading window: taken from the history list like a user click.
        w.history.list.emit('activate', 0);
        this.idle(1500);
        if (this.child()) {
            this.idle(500);
            this.saveChild('history-diff');
        }
    }

    imageZoom(): void {
        const picture = GLib.build_filenamev([GLib.get_current_dir(), 'tests/samples/images/example.png']);
        this.load(`# Image\n\nDouble-click the image to enlarge it.\n\n![Example image](${picture})\n`, false, 4, false);
        this.idle(1200);
        this.cursorTo(4);
        this.ed.zoomImage();
        this.idle(800);
        this.saveChild('image-zoom');
    }

    // Document tabs, one with unsaved changes; afterwards back to one document.
    tabs(): void {
        const w = this.w;
        w.setOption('sidebar', true);
        w.sidebar.setPage('files');
        w.openFolder(this.proj, false);
        w.file = null;
        this.ed.setText('');
        w.setOption('autosave', false);   // so the • mark (unsaved) is shown on the tab
        for (const rel of ['notes/meeting-1-oct.md', 'plans/launch.md', 'research/competitors.md', 'research/users.md']) w.openFile(GLib.build_filenamev([this.proj, ...rel.split('/')]));
        w.switchTab(-2);   // the plan is active
        w.editor.buffer.place_cursor(w.editor.buffer.get_end_iter());
        w.editor.buffer.insert_at_cursor('\n## Risks\n\nThe sync bug could push back the public release.\n', -1);
        w.editor.view.scroll_to_iter(w.editor.buffer.get_start_iter(), 0, false, 0, 0);
        this.idle(600);
        this.shot('tab');
        // Clean up: save the changes and then close the tabs, back to one document.
        w.editor.buffer.set_modified(false);
        w.setOption('autosave', true);
        while (w.documentCount > 1) w.closeTab();
        w.file = null;
        this.ed.setText('');
    }

    // The conversation history popover with two earlier conversations, light and dark.
    chatHistory(): void {
        const w = this.w, proj = this.proj;
        const earlier: [string, string, string, string][] = [
            ['2026-10-02T21:05:00', 'Summarize this week\'s meeting notes', 'Summarize this week\'s meeting notes', 'The public release is postponed to 22 November, Sari prepares the release material, and Budi fixes the sync bug.'],
            ['2026-10-03T08:40:00', 'List the launch risks', 'List the launch risks', 'Main risks: the sync bug, a closed beta that slips, and a limited test server budget.'],
        ];
        // Remove the conversations from the Assistant scene above so the list only contains these examples.
        for (const old of listChats(proj)) GLib.unlink(old.path);
        for (const [created, title, q, a] of earlier) saveChat(proj, { title, model: 'deepseek-flash', created, turns: [{ role: 'user', content: q }, { role: 'assistant', content: a }] }, null);
        w.openFolder(proj, false);
        w.load(this.plan);
        w.setOption('sidebar', true);
        w.sidebar.setPage('files');
        w.setOption('chat', true);
        w.chat.reset();
        w.session.assistant.chat.makeProvider = () => this.scripted([ANSWER]);
        void w.chat.ask(ASK_READ);
        this.idle(1500);
        for (const dark of [false, true]) {
            w.setDark(dark);
            this.grabWithPopover(w.chat.historyButton).savev(`${OUT}/chat-history${dark ? '-dark' : ''}.png`, 'png', [], []);
        }
        w.setDark(false);
    }

    // Context: the breakdown sent to the model, with switches.
    contextPopover(): void {
        const w = this.w, buffer = w.editor.buffer;
        w.chat.reset();
        const text = w.editor.getText();
        const from = text.indexOf('- Public release'), to = text.indexOf('15 November') + '15 November'.length;
        buffer.select_range(buffer.get_iter_at_offset(from), buffer.get_iter_at_offset(to));
        w.chat.updateContextSummary();
        this.idle(300);
        this.grabWithPopover(w.chat.contextButton, true).savev(`${OUT}/context.png`, 'png', [], []);
        buffer.place_cursor(buffer.get_start_iter());
    }

    // Plan, partial batch, verification (GIF + screenshot).
    workPlan(): void {
        const w = this.w;
        this.openWork();
        w.setOption('sidebar', false);
        const steps = (...status: string[]) => ['Find meeting decisions that are not in the plan yet', 'Update the plan, the board, and the meeting notes', 'Check the result'].map((text, i) => ({ text, status: status[i] }));
        const goal = 'Sync the release schedule with the 1 October meeting decisions';
        w.session.assistant.chat.makeProvider = () => this.scripted([
            [tool('p1', 'set_work', { goal, steps: steps('done', 'pending', 'pending'), note: 'The public release is postponed to 22 November.' })],
            [tool('p2', 'propose_batch', { actions: [
                { tool: 'edit_file', arguments: JSON.stringify({ name: 'plans/launch.md', old_text: '- Public release: 15 November', new_text: '- Public release: 22 November', reason: 'The 1 October meeting postponed the public release.' }) },
                { tool: 'edit_note', arguments: JSON.stringify({ name: 'tasks.md', action: 'move', note: 'Prepare the release material', group: 'In Progress', reason: 'Sari started preparing the release material.' }) },
                { tool: 'insert_text', arguments: JSON.stringify({ name: 'notes/meeting-8-oct.md', position: 'end', text: '\nThe launch plan has been updated to 22 November.\n', reason: 'Record that the plan has been synced.' }) },
            ] })],
            [tool('p3', 'set_work', { goal, steps: steps('done', 'done', 'pending'), note: 'The batch was applied.' })],
            [tool('p4', 'verify_work', { checks: [
                { file: 'plans/launch.md', kind: 'present', text: 'Public release: 22 November' },
                { file: '*', kind: 'absent', text: '15 November' },
                { file: 'tasks.md', kind: 'kanban', text: 'Prepare the release material #marketing [due:: 2026-11-10]', list: 'In Progress', done: false },
                { file: 'notes/meeting-8-oct.md', kind: 'present', text: 'has been updated to 22 November' },
            ] })],
            [tool('p5', 'set_work', { goal, steps: steps('done', 'done', 'done'), note: 'All the checks passed.' })],
            'Done and verified. The plan uses **22 November**, the old date is left in no file, the card *Prepare the release material* is in *In Progress*, and the 8 October meeting notes record the update.',
        ], 'work');
        this.streamFrames = true;
        w.chat.reset();
        w.setOption('chat', true);
        this.frame('work', 4);
        let worked = false;
        void w.chat.ask('Sync the release schedule with the meeting decisions, and then make sure nothing is left behind.').then(() => { worked = true; });
        const pack = this.nextViewer();
        this.frame('work', 8);
        // Partial approval: uncheck one file and write a note, capture, then restore and apply everything.
        pack.checks[2].set_active(false);
        pack.noteEntry.set_text('I will write the 8 October meeting notes myself');
        this.idle(300);
        saveWidget(pack.window, 'proposal-batch');
        pack.checks[2].set_active(true);
        pack.noteEntry.set_text('');
        pack.applyButton.emit('clicked');
        this.until(() => worked);
        this.idle(600);
        this.frame('work', 16);
        this.shot('work');
        this.streamFrames = false;
        // The plan checklist at the start of the answer: scroll the panel to the top and then capture just the panel.
        w.chat.scroller.get_vadjustment().set_value(0);
        this.idle(300);
        saveWidget(w.chat.widget, 'plan');
    }

    // The agent log of the work above.
    agentLog(): void {
        this.w.chat.showLog();
        this.idle(600);
        const logWin = this.w.chat.logViewer?.window;
        if (!logWin) return;
        saveWidget(logWin, 'agent-log');
        logWin.close();
        this.idle(300);
    }

    // The agent reads the Git history.
    agentGit(): void {
        const w = this.w;
        w.openFolder(this.repo, false);
        w.load(this.note);
        w.setOption('sidebar', true);
        w.sidebar.setPage('history');
        w.session.assistant.chat.makeProvider = () => this.scripted([
            [tool('g1', 'git_log', { file: 'plan.md' })],
            [tool('g2', 'show_commit', { commit: 'HEAD', file: 'plan.md' })],
            'The date **15 November** first entered in the commit *Clarify the goal and the dates* by Eka Putra; the earlier commit only wrote "Closed beta: October". The line *Evaluation: 30 November* is not committed yet.',
        ]);
        w.chat.reset();
        this.askAndWait('When was the public release date written in the plan, and by whom?');
        this.idle(1500);
        this.shot('agent-git');
        w.setOption('chat', false);
    }

    // The kanban card dialog (a due date with a calendar).
    cardDialog(): void {
        this.load(BOARD, false, 0, false);
        whenDialogReady(() => findDialog('Edit Card'), dialog => {
            widgetPixbuf(dialog)?.savev(`${OUT}/kanban-card.png`, 'png', [], []);
            dialog.close();
        });
        this.waitPromise(editCardDialog(this.w.win, { text: 'User research #research [due:: 2026-10-10 09:00]', notes: ['Interview five active users.'] }));
    }

    // The orchestrator: cards worked on by pi (a fake RPC, no API).
    orchestrator(): void {
        const w = this.w;
        const piDir = GLib.dir_make_tmp('markwork-pi-XXXXXX');
        const shop = GLib.build_filenamev([GLib.dir_make_tmp('markwork-repo-XXXXXX'), 'web-ecommerce']);
        GLib.mkdir_with_parents(shop, 0o755);
        const piScript = GLib.build_filenamev([piDir, 'pi']);
        GLib.file_set_contents(piScript, fakePi(piDir));
        GLib.spawn_command_line_sync(`chmod +x ${piScript}`);
        const piMode = (m: string) => GLib.file_set_contents(GLib.build_filenamev([piDir, 'mode']), m);
        const savedProgram = w.harness.orchestrator.program, savedDialogs = w.harness.dialogs;
        w.harness.orchestrator.program = () => piScript;
        w.harness.dialogs = { ...savedDialogs, answer: () => null };
        w.settings.projects = { 'web-ecommerce': shop };
        const piBoard = this.put('development.md', PI_BOARD);
        w.load(piBoard);
        w.setOption('sidebar', false);
        this.settle(20);
        const runOf = (text: string) => w.harness.orchestrator.queue.find(piBoard, this.cardAt(text).text);
        const status = (text: string, wanted: string) => () => runOf(text)?.status === wanted;
        this.frame('pi', 8);
        piMode('slow');
        this.cardMenu('Checkout', 'Work on it with pi');
        this.cardMenu('Test the cart', 'Work on it with pi');
        this.waitFor(status('Checkout', 'working'));
        this.frame('pi', 10);
        this.shot('pi-board');
        GLib.file_set_contents(GLib.build_filenamev([piDir, 'release']), '');
        this.waitFor(status('Checkout', 'done'));
        this.waitFor(status('Test the cart', 'done'));
        this.frame('pi', 8);
        piMode('ask');
        this.cardMenu('Tidy up the README', 'Work on it with pi');
        this.waitFor(status('Tidy up the README', 'waiting'));
        this.frame('pi', 14);
        this.shot('pi-waiting');
        this.piDialogs(runOf);
        const waiting = runOf('Tidy up the README');
        if (waiting) w.harness.orchestrator.stop(waiting);
        this.waitFor(() => !w.harness.orchestrator.queue.runs.some(r => r.status === 'working' || r.status === 'waiting'));
        w.harness.orchestrator.program = savedProgram;
        w.harness.dialogs = savedDialogs;
        w.editor.buffer.set_modified(false);
    }

    // The answer dialog for the waiting card, and the log of a finished run.
    private piDialogs(runOf: (text: string) => ReturnType<MainWindow['harness']['orchestrator']['queue']['find']>): void {
        const ask = runOf('Tidy up the README')?.ask;
        if (ask) {
            whenDialogReady(() => findDialog('Answer pi'), dialog => {
                widgetPixbuf(dialog)?.savev(`${OUT}/pi-answer.png`, 'png', [], []);
                dialog.close();
            });
            this.waitPromise(harnessAskDialog(this.w.win, ask, 'pi'));
        }
        const done = runOf('Checkout');
        if (!done) return;
        const log = this.w.harnessLogs.show(done);
        this.idle(600);
        saveWidget(log.window, 'pi-log');
        log.window.destroy();
    }

    private cardAt(text: string): { column: number; index: number; text: string } {
        const b = this.w.board.getBoard();
        for (let column = 0; column < b.columns.length; column++) {
            const index = b.columns[column].cards.findIndex(c => c.text.startsWith(text));
            if (index >= 0) return { column, index, text: b.columns[column].cards[index].text };
        }
        throw new Error(`card "${text}" does not exist`);
    }

    private cardMenu(text: string, label: string): void {
        const { column, index } = this.cardAt(text);
        const entry = findEntry(this.w.board.cardMenu(column, index), label);
        if (!entry?.run) throw new Error(`menu "${label}" does not exist for "${text}"`);
        entry.run();
    }

    // The daily flow: Home, Inbox, Journal (one work folder, relative dates so Home always has due dates).
    dailyFlow(): void {
        const w = this.w;
        const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDate(d); };
        const flowDir = GLib.build_filenamev([GLib.dir_make_tmp('markwork-flow-XXXXXX'), 'markwork-launch']);
        for (const [rel, text] of Object.entries(WORK)) this.put(rel, text, flowDir);
        const flowBoard = this.put('tasks.md', `---\nlayout: board\nproject: launch\n---\n\n## Plan\n\n- [ ] Prepare the release material #marketing [due:: ${day(1)}]\n- [ ] Write the release notes #docs [due:: ${day(2)}]\n\n## In Progress\n\n- [ ] Fix the sync bug #bug #important [due:: ${day(0)}]\n\n## Done\n\n- [x] Redesign the home page #design\n`, flowDir);
        const flowInbox = this.put('inbox.md', `---\nlayout: list\n---\n\n# Inbox\n\nA place to capture ideas, notes, and things to process later.\n\n- Read the article about the GNOME HIG #read [created:: ${day(0)} 08:10]\n- Idea: offer a PDF export #idea [created:: ${day(-1)} 17:45]\n`, flowDir);
        w.openFolder(flowDir, false);
        w.setOption('chat', false);
        w.setOption('sidebar', true);
        w.sidebar.setPage('files');
        w.setDark(false);
        // Toasts from earlier scenes expire (3 s each, one at a time) and new ones are not shown, so they do not cover the frames.
        w.toast = () => {};
        this.idle(30000);
        this.home(flowDir);
        this.inbox(flowInbox);
        this.journal(flowBoard);
    }

    // Home → check the task that is due today: written straight back to its board.
    private home(flowDir: string): void {
        const w = this.w;
        w.settings.recentFiles = [];   // so Continue only shows this folder's files, not the earlier scenes'
        for (const rel of ['plans/launch.md', 'notes/meeting-1-oct.md', 'research/users.md']) w.openFile(GLib.build_filenamev([flowDir, ...rel.split('/')]));
        while (w.documentCount > 1) w.closeTab();
        w.file = null;
        this.ed.setText('');
        w.editor.buffer.set_modified(false);
        w.settings.recentFiles = w.settings.recentFiles.filter(r => r.path.startsWith(`${flowDir}/`));
        w.openHome();
        this.idle(600);
        this.frame('home', 10);
        const due = w.homePage.data().tasks.find(t => t.card.startsWith('Fix the sync bug'));
        if (due) w.home.onToggleTask(due, true);
        w.refreshHome();
        this.idle(400);
        this.frame('home', 6);
        w.journal.addNote('Standup: the sync bug is done, the beta is next');
        this.idle(400);
        this.frame('home', 12);
    }

    private inbox(flowInbox: string): void {
        const w = this.w;
        w.openFile(flowInbox);
        this.idle(500);
        this.frame('inbox', 8);
        for (const text of ['Ask Dewi about the beta schedule #question', 'Write the release notes for 1.0 #docs']) {
            w.inbox.capture(text);
            this.idle(300);
            this.frame('inbox', 8);
        }
        w.editor.buffer.set_modified(false);
    }

    // A card moved on the board is recorded as activity, then merged into the journal.
    private journal(flowBoard: string): void {
        const w = this.w;
        w.openFile(flowBoard);
        this.idle(500);
        w.board.commit(moveCard(parseBoard(w.editor.getText()), { column: 0, index: 0 }, { column: 1, index: 0 }));
        this.idle(300);
        const journal = w.journal.open();
        if (journal) this.waitPromise(journal);
        this.idle(600);
        w.editor.view.scroll_to_iter(w.editor.buffer.get_start_iter(), 0, false, 0, 0);
        this.frame('journal', 10);
        w.journal.addNote('? Does the beta need the sync fix first');
        this.idle(400);
        this.frame('journal', 14);
        w.editor.buffer.set_modified(false);
    }
}

const app = new Adw.Application({ application_id: 'com.ekaput.Markwork.Capture', flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    app.hold();
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        try { main(app); } catch (e) { printerr(e instanceof Error ? `${e.message}\n${e.stack}` : String(e)); }
        app.release();
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([System.programInvocationName]);
