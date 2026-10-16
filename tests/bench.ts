// Performance tests for Markwork. Bundled by Vite into dist/bench.js.
//
//   npm run bench                        build, then measure under Xvfb
//   gjs -m dist/bench.js --no-gui        only the Markdown module (no window)
//   gjs -m dist/bench.js --size=2000     document size (number of sample blocks), default 100
//   gjs -m dist/bench.js --runs=10       number of repetitions per size, default 10
//   gjs -m dist/bench.js --budget=ms     fail (exit code 1) if the median of a GUI operation exceeds ms
//   gjs -m dist/bench.js --sizes=100,400 document sizes for the GUI part (default: size/4, size/2, size)
//   gjs -m dist/bench.js --fixture=long  a long document, 10 lines per block without table grids
//   gjs -m dist/bench.js --fixture=book  a book manuscript: long paragraphs, dialogue, *italic*/**bold**, ±1.6 KB per block
//   gjs -m dist/bench.js --timeout=120 time limit of each GUI process (seconds)
//   gjs -m dist/bench.js --save=f.json   save the results to f.json (to compare later)
//   gjs -m dist/bench.js --compare=f.json  show the difference against the saved results
//
//   npm run bench:save                   save to bench/<date-time>.json
//   npm run bench:compare                compare with bench/baseline.json
//
// The results are the median, p95, and maximum; the JSON also stores the raw samples.

import '../src/platform/gjs/install.js';   // the core reaches the runtime through platform()
import './host-gjs.js';   // the tests reach the runtime through host(), installed before framework.ts
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import System from 'system';

import { DIM, GREEN, RED, RESET, errorMessage, opt, optVal } from './framework.js';
import { readTextFile, writeTextFile } from '../src/files.js';
import { MainWindow } from '../src/window.js';
import { markdownToHtml } from '../src/markdown/html.js';
import { parseInline } from '../src/markdown/inline.js';
import { findTables, parseTable, renderTable } from '../src/markdown/table.js';
import { parseBoard, serializeBoard } from '../src/markdown/kanban.js';
import { iterAtLine } from '../src/gtkutil.js';
import { inMemorySettings } from '../src/platform/gjs/settings.js';

const FIXTURE = optVal('fixture') ?? 'mixed';
if (!['mixed', 'long', 'book'].includes(FIXTURE)) { printerr('--fixture must be mixed, long, or book.'); System.exit(1); }
const SIZE = Number(optVal('size') ?? 100);
const RUNS = Number(optVal('runs') ?? 10);
const GUI_SIZES = (optVal('sizes') ?? [...new Set([SIZE / 4, SIZE / 2, SIZE].map(n => Math.max(1, Math.round(n))))].join(',')).split(',').map(Number);
const TIMEOUT = Number(optVal('timeout') ?? 120);
const BUDGET = optVal('budget') !== undefined ? Number(optVal('budget')) : null;

function fail(message: string): never {
    printerr(`Benchmark failed: ${message}`);
    System.exit(1);
    throw new Error(message);
}
for (const [name, value] of [['size', SIZE], ['runs', RUNS], ['timeout', TIMEOUT], ...GUI_SIZES.map(n => ['sizes', n])] as [string, number][]) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`--${name} must be a positive integer.`);
}
if (BUDGET !== null && (!Number.isFinite(BUDGET) || BUDGET <= 0)) fail('--budget must be a positive number.');
if (new Set(GUI_SIZES).size !== GUI_SIZES.length) fail('--sizes must not repeat.');

let overBudget = false;
let invalid = false;

interface Stats { median: number; p95: number; max: number; samples: number[] }
interface Saved {
    version: number; date: string; size: number;  runs: number; sizes: number[]; fixture?: string; mode: 'model' | 'gui';
    environment: { gjs : number; glib: string; gtk: string; host: string; backend: string; commit: string };
    results: Record<string, number>; stats: Record<string, Stats>; 
}
const results: Record<string, number> = {};
const statistics: Record<string, Stats> = {};
let group = '';
const COMPARE = optVal('compare');
let baseline: Saved | null = null;
if (COMPARE) {
    try {
        baseline = JSON.parse(readTextFile(COMPARE)) as Saved;
        if (!baseline || !baseline.results || typeof baseline.results !== 'object' ||
            Object.values(baseline.results).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
            fail('the baseline format is not valid.');
        }
    } catch (e) { fail(`the baseline cannot be read: ${errorMessage(e)}`); }
}
const environment = {
    gjs: System.version,
    glib: `${GLib.MAJOR_VERSION}.${GLib.MINOR_VERSION}.${GLib.MICRO_VERSION}`,
    gtk: `${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`,
    host: GLib.get_host_name(), backend: GLib.getenv('GDK_BACKEND') ?? 'default', commit: 'unknown',
};
try {
    const [, stdout, , status] = GLib.spawn_sync(null, ['git', 'rev-parse', 'HEAD'], null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (status === 0) environment.commit = new TextDecoder().decode(stdout!).trim();
} catch { /* Git is not required to run the benchmark. */ }
// The commit may differ: the purpose of a baseline is to compare code changes.
if (baseline && (baseline.version !== 2 || baseline.size !== SIZE || (baseline.fixture ?? 'mixed') !== FIXTURE || baseline.runs !== RUNS || baseline.mode !== (opt('no-gui') ? 'model' : 'gui') ||
    (JSON.stringify(baseline.sizes) !== JSON.stringify(GUI_SIZES) && !opt('child')) ||
    !baseline.environment ||  ['gjs', 'glib', 'gtk', 'host', 'backend'].some(k =>
        baseline!.environment[k as keyof Saved['environment']] !== environment[k as keyof typeof environment]))) {
    if (!opt('child')) print(`${DIM}The baseline is not equivalent (format, size, repetitions, or environment); the difference is skipped.${RESET}`);
    baseline = null;
}

const BLOCK = `## Section

Paragraph with **bold**, *italic*, ~~strikethrough~~, ==highlight==, \`code\`, and [link](https://example.com).

- Item one
- [x] Task done
- [ ] Task not done

> A short quote

\`\`\`ts
const x: number = 1;
\`\`\`

| A | B | C |
| :-- | :-: | --: |
| **one** | two | three |
| four | *five* | six |

`;

const KANBAN = (cards: number): string =>
    `---\nlayout: board\n---\n\n` + ['Plan', 'In Progress', 'Done'].map(c =>
        `## ${c}\n\n` + Array.from({ length: cards }, (_, i) => `- [ ] Card ${i} #tag @due(2026-01-01)\n`).join('') + '\n').join('');

// Book manuscript: one scene per block, a new chapter every 10 scenes. Paragraphs are written as one
// long line (wrapped by the editor), the way prose writers usually write.
const SCENE = (i: number): string =>
    (i % 10 === 0 ? `# Chapter ${i / 10 + 1}: The Voyage East\n\n` : '') + `## Scene ${i}\n\n` +
    `The morning wind blew in from the sea as Raka went down the steps of the pier for the ${i}th time. He carried a worn *notebook* that was always tucked into his jacket pocket, and on every page were written the names of the harbors he wanted to call at. In the distance, the ship **White Seagull** swayed gently with the waves — her hull a clean white, her sails sea blue, and her flag fluttering as if calling out.\n\n` +
    `“You are late again,” said Laras without turning around. Her hands were busy straightening the tangled mooring rope.\n\n` +
    `“I am not late. The ship is just too early,” Raka answered with a smile. He knew the answer would satisfy no one, but the morning was too beautiful to waste on arguing.\n\n` +
    `Captain Hasan stood at the bow with his arms folded across his chest. He was an old man with a deep voice who had led voyages to the east for thirty years, and was said never to have lost a single crew member. The people at the harbor called him *the Keeper of Directions*, a nickname he accepted in silence. As the sun began to rise, he gave a signal, and the crew pulled up the anchor at once. Raka felt the deck tremble beneath his feet; the journey he had dreamed of for so long had finally begun.\n\n` +
    `> The sea never promises anything, but it always keeps what it did not promise.\n\n` +
    `That night they anchored in a small bay that appeared on no map. The stars looked closer than usual, and the sound of crickets from the island was like singing. Raka sat at the stern, writing by lantern light, while Laras reread her father's letter for the umpteenth time — the letter she still refused to show to anyone.\n\n`;

const doc = (n: number): string => FIXTURE === 'mixed' ? BLOCK.repeat(n) : FIXTURE === 'book' ? Array.from({ length: n }, (_, i) => SCENE(i)).join('') : Array.from({ length: n }, (_, i) =>
    (i % 50 === 0 ? `## Section ${i}\n` : `Notes ${i}\n`) +
    Array.from({ length: 8 }, (_, j) => `Paragraph ${i}.${j} with different notes and long enough for a real document.\n`).join('') + '\n').join('');

const now = (): number => GLib.get_monotonic_time() / 1000;

function measure(fn: () => void, runs = RUNS): number[] {
    fn();  // warm-up (JIT and cache)
    const t: number[] = [];
    for (let i = 0; i < runs; i++) { const s = now(); fn(); t.push(now() - s); }
    return t;
}

async function measureAsync(fn: () => Promise<void>, runs = RUNS): Promise<number[]> {
    await fn();
    const t: number[] = [];
    for (let i = 0; i < runs; i++) {
        System.gc();  // finish any pending GC outside the measured time (see idle())
        const s = now();
        await fn();
        t.push(now() - s);
    }
    return t;
}

// Wait until the main loop is idle: all highlighting, layout, and redraws that are
// queued (with a priority higher than LOW) have finished. Control really returns to
// GLib, without spinning ctx.iteration() from inside JS: if the GJS GC is running incrementally,
// callbacks invoked from such a nested loop are blocked and highlighting silently dies.
const idle = (): Promise<void> => new Promise(resolve => {
    GLib.idle_add(GLib.PRIORITY_LOW, () => { resolve(); return GLib.SOURCE_REMOVE; });
});

function report(name: string, t: number[], budget = false): void {
    if (!t.length || t.some(n => !Number.isFinite(n) || n < 0)) throw new Error(`Sample ${name} is not valid.`);
    const sorted = [...t].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const max = sorted[sorted.length - 1];
    const over = budget && BUDGET !== null && med > BUDGET;
    if (over) overBudget = true;
    const key = `${group} / ${name}`;
    results[key] = med;
    statistics[key] = { median: med, p95, max, samples: [...t] };
    const before = baseline?.results[key];
    let delta = '';
    if (before !== undefined && before > 0) {
        const pct = (med - before) / before * 100;
        const color = Math.abs(pct) < 25 ? DIM : pct < 0 ? GREEN : RED;
        delta = `   ${color}${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% (was ${before.toFixed(2)} ms)${RESET}`;
    }
    print(`  ${name.padEnd(34)} median ${med.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms   max ${max.toFixed(2)} ms${delta}${over ? `  ${RED}> ${BUDGET} ms${RESET}` : ''}`);
}

function runModelBench(): void {
    group = 'Markdown module';
    print(`\nMarkdown module (${SIZE} blocks ≈ ${(doc(SIZE).length / 1024).toFixed(0)} KB)`);
    const text = doc(SIZE);
    const lines = text.split('\n');
    report('markdownToHtml', measure(() => markdownToHtml(text, 'bench')));
    report('parseInline (per line)', measure(() => { for (const l of lines) parseInline(l); }));
    report('findTables', measure(() => findTables(lines)));
    report('parseTable + renderTable', measure(() => {
        for (const r of findTables(lines)) renderTable(parseTable(lines.slice(r.start, r.end)));
    }));
    const kanban = KANBAN(Math.max(10, Math.floor(SIZE / 3)));
    report('parseBoard + serializeBoard', measure(() => serializeBoard(parseBoard(kanban))));
}

// The window is not destroyed: the child process exits right away, and destroy triggers GC warnings from GJS.
const windows: MainWindow[] = [];
async function runGuiBench(app: Adw.Application, n: number): Promise<void> {
    const w = new MainWindow(app, inMemorySettings({ welcomed: true, home: false, dark: false }), null);
    windows.push(w);
    const ed = w.editor;
    const buf = ed.buffer;
    await idle();

    const text = doc(n);
    group = `Editor GUI ${n} blocks`;
    print(`\nEditor GUI (${n} blocks, ${(text.length / 1024).toFixed(0)} KB)`);
    report('setText + highlight + layout', await measureAsync(async () => { ed.setText(text); await idle(); }), true);
    // setText itself is synchronous; the rest of the tags and line layout are done in installments in the background. What feels
    // "frozen" is the longest pause of the main loop from opening until everything is done.
    // The document alternates with different headings, like opening another file: the outline is rebuilt too.
    const other = text.replace(/^(#{1,6} )/gm, '$1Other: ');
    const stalls: number[] = [];
    for (let i = 0; i <= RUNS; i++) {
        System.gc();
        await idle();
        let worst = 0, last = now();
        const tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
            const t = now();
            worst = Math.max(worst, t - last);
            last = t;
            return GLib.SOURCE_CONTINUE;
        });
        ed.setText(i % 2 ? other : text);
        await idle();
        GLib.source_remove(tick);
        worst = Math.max(worst, now() - last);
        if (!ed.highlightComplete) throw new Error('Incremental highlighting did not finish.');
        if (i > 0) stalls.push(worst);
    }
    report('open: longest pause', stalls, true);
    const highlighted = measure(() => ed.highlight());
    report('highlight() again', highlighted, true);
    // Count the completed callbacks; the duration alone does not prove that highlighting ran.
    let highlights = 0;
    const onHighlighted = ed.onHighlighted;
    ed.onHighlighted = result => { highlights++; onHighlighted(result); };
    const edit = async (fn: () => void): Promise<void> => {
        await idle();
        const before = highlights;
        fn();
        await idle();
        if (highlights <= before) throw new Error('The text change did not complete highlighting.');
    };
    const operation = async (setup: () => Promise<void>, action: () => Promise<void>): Promise<number[]> => {
        const times: number[] = [];
        for (let i = 0; i <= RUNS; i++) {
            System.gc();
            await setup();
            const start = now();
            await action();
            if (i > 0) times.push(now() - start);
        }
        return times;
    };
    const characters: number[] = [];
    let typingRun = 0;
    const typed = await measureAsync(async () => {
        // Restore the document and the position so every repetition uses the same condition.
        ed.setText(text);
        buf.place_cursor(iterAtLine(buf, Math.floor(buf.get_line_count() / 2)));
        await idle();
        for (let i = 0; i < 20; i++) {
            const start = now();
            await edit(() => buf.insert_at_cursor('x', -1));
            if (typingRun > 0) characters.push(now() - start);
        }
        typingRun++;
    });
    // The total time above includes preparation: report the total of 20 keystrokes from the per-character samples.
    report('type 20 characters', Array.from({ length: typed.length }, (_, i) =>
        characters.slice(i * 20, (i + 1) * 20).reduce((a, b) => a + b, 0)));
    report('type per character', characters, true);
    // The same path as a real key press: the TextView keybinding signal inserts
    // the text as a user action (entering undo) and then scrolls to the cursor. The cursor is at the end of
    // a long paragraph in the middle of the document, where prose writers type most often.
    const paragraphEnd = (): void => {
        const middle = Math.floor(buf.get_line_count() / 2);
        let line = middle;
        while (line < buf.get_line_count() - 1 && (ed.lines[line] ?? '').length < 200) line++;
        if ((ed.lines[line] ?? '').length < 200) line = middle;
        const it = iterAtLine(buf, line);
        it.forward_to_line_end();
        buf.place_cursor(it);
    };
    const viewTyping: number[] = [];
    await measureAsync(async () => {
        ed.setText(text);
        paragraphEnd();
        ed.view.scroll_to_mark(buf.get_insert(), 0, true, 0, 0.5);
        await idle();
        for (const ch of ' word') {
            const start = now();
            await edit(() => ed.view.emit('insert-at-cursor', ch));
            viewTyping.push(now() - start);
        }
    });
    report('type via view (paragraph)', viewTyping.slice(5), true);
    report('Enter new paragraph', await operation(async () => { ed.setText(text); paragraphEnd(); await idle(); }, () => edit(() => {
        if (!ed.onKey(Gdk.KEY_Return, 0)) ed.view.emit('insert-at-cursor', '\n');
    })), true);
    // A large document, Unicode, and one long line test different editing paths.
    const paste = ('😀 note **bold**\n'.repeat(100)) + 'x'.repeat(10000);
    const prepare = async (): Promise<void> => {
        ed.setText(text);
        buf.place_cursor(iterAtLine(buf, Math.floor(buf.get_line_count() / 2)));
        await idle();
    };
    report('large paste + Unicode', await operation(prepare, () => edit(() => buf.insert_at_cursor(paste, -1))), true);
    const inserted = async (): Promise<void> => {
        await prepare();
        buf.begin_user_action();
        await edit(() => buf.insert_at_cursor(paste, -1));
        buf.end_user_action();
    };
    report('delete large text', await operation(inserted, () => edit(() => {
        const end = buf.get_iter_at_mark(buf.get_insert());
        const start = end.copy();
        start.backward_chars(Array.from(paste).length);
        buf.delete(start, end);
    })), true);
    report('undo large paste', await operation(inserted, () => edit(() => buf.undo())), true);
    report('redo large paste', await operation(async () => {
        await inserted();
        await edit(() => buf.undo());
    }, () => edit(() => buf.redo())), true);
    await prepare();
    report('move cursor 20 lines', await measureAsync(async () => {
        for (let i = 0; i < 20; i++) {
            buf.place_cursor(iterAtLine(buf, Math.min(i * 7, buf.get_line_count() - 1)));
            await idle();
        }
    }));
    // Autosave writes the whole document once per typing pause; the keystroke itself only records the time.
    const saveDir = GLib.dir_make_tmp('markwork-bench-XXXXXX');
    w.file = GLib.build_filenamev([saveDir, 'dok.md']);
    w.settings.autosave = true;
    report('autosave (write file)', await operation(() => edit(() => buf.insert_at_cursor('x', -1)), async () => {
        if (!w.autosave() || buf.get_modified()) throw new Error('Autosave did not save the document.');
    }), true);
    // The timer path: only the part on the main thread (copying the text, starting the write) is measured;
    // fsync and rename run on a Gio worker thread.
    const background: number[] = [];
    for (let i = 0; i <= RUNS; i++) {
        System.gc();
        await edit(() => buf.insert_at_cursor('x', -1));
        let finished: () => void = () => {};
        const written = new Promise<void>(resolve => { finished = resolve; });
        const start = now();
        if (!w.autosaveInBackground(undefined, () => finished())) throw new Error('Background autosave did not start.');
        if (i > 0) background.push(now() - start);
        await written;
        if (buf.get_modified()) throw new Error('Background autosave did not save the document.');
    }
    report('background autosave (main thread)', background, true);
    w.settings.autosave = false;
    GLib.unlink(w.file);
    GLib.rmdir(saveDir);
    w.file = null;
    ed.onHighlighted = onHighlighted;

    buf.set_modified(false);
}

// Child mode (--child): only measures the GUI for --sizes, without header and footer.
const CHILD = opt('child');

function runGuiInProcess(): void {
    const app = new Adw.Application({ application_id: 'com.ekaput.Markwork.Bench', flags: Gio.ApplicationFlags.NON_UNIQUE });
    app.connect('activate', () => {
        app.hold();
        void (async () => {
            try {
                for (const n of GUI_SIZES) await runGuiBench(app, n);
            } catch (e) {
                invalid = true;
                print(`${RED}GUI bench stopped: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
            }
            app.release();
            app.quit();
        })();
    });
    app.run([System.programInvocationName]);
}

// Each document size runs in its own GJS process. In one long process, the GC eventually
// cleans up widgets whose signals are still connected; GJS then blocks callbacks and highlighting
// silently dies, so the next size is measured much faster than it really is.
function runGuiInChildren(): void {
    const script = GLib.filename_from_uri(import.meta.url)[0];
    const dir = GLib.dir_make_tmp('markwork-bench-XXXXXX');
    for (const n of GUI_SIZES) {
        const out = GLib.build_filenamev([dir, `${n}.json`]);
        const argv = ['timeout', '--kill-after=5s', `${TIMEOUT}s`, 'gjs', '-m', script, '--child', `--sizes=${n}`, `--size=${SIZE}`, `--runs=${RUNS}`, `--fixture=${FIXTURE}`, `--save=${out}`];
        if (BUDGET !== null) argv.push(`--budget=${BUDGET}`);
        if (COMPARE && baseline) argv.push(`--compare=${COMPARE}`);
        const [, stdout, stderr, status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
        print(new TextDecoder().decode(stdout ?? undefined).trimEnd());
        if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
            const saved = JSON.parse(readTextFile(out)) as Saved;
            Object.assign(results, saved.results);
            Object.assign(statistics, saved.stats);
            if (status !== 0) overBudget = true;
            GLib.unlink(out);
        } else {
            invalid = true;
            print(`${RED}The child process for ${n} blocks failed.${RESET}\n${new TextDecoder().decode(stderr ?? undefined).slice(0, 2000)}`);
        }
    }
    GLib.rmdir(dir);
}

if (!CHILD) {
    print(`${DIM}Size ${SIZE} blocks, ${RUNS} repetitions${BUDGET !== null ? `, budget ${BUDGET} ms` : ''}${RESET}`);
    runModelBench();
}

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        invalid = true;
        print(`${RED}The GUI needs a display; use --no-gui for the Markdown module only.${RESET}`);
    } else if (CHILD) {
        runGuiInProcess();
    } else {
        runGuiInChildren();
    }
}

const SAVE = optVal('save');
if (SAVE && invalid) print(`${RED}The results were not saved because some measurements are not valid.${RESET}`);
else if (SAVE) {
    const saved: Saved = { version: 2, date: new Date().toISOString(), size: SIZE, runs: RUNS, sizes: GUI_SIZES, fixture: FIXTURE, mode: opt('no-gui') ? 'model' : 'gui', environment, results, stats: statistics };
    GLib.mkdir_with_parents(GLib.path_get_dirname(SAVE), 0o755);
    writeTextFile(SAVE, JSON.stringify(saved, null, 2) + '\n');
    if (!CHILD) print(`\n${DIM}Results saved:  ${SAVE}${RESET}`);
}

overBudget ||= invalid;
if (!CHILD) print(overBudget ? `\n${RED}A measurement exceeded the budget or the bench failed.${RESET}` : `\n${GREEN}Done.${RESET}`);
System.exit(overBudget ? 1 : 0);
