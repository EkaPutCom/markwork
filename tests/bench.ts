// Performance of the Markdown module (markdown/), on Node. The editor of the Electron window is measured by Chromium's own
// tools.
//
//   npm run bench                        build, then measure
//   npm run bench -- --size=2000         document size (number of sample blocks), default 100
//   npm run bench -- --runs=10           number of repetitions, default 10
//   npm run bench -- --budget=ms         fail (exit code 1) if a median exceeds ms
//   npm run bench -- --fixture=long      a long document, 10 lines per block; --fixture=book a book manuscript
//   npm run bench -- --save=f.json       save the results to f.json (to compare later)
//   npm run bench -- --compare=f.json    show the difference against the saved results
//
// The results are the median, p95, and maximum; the JSON also stores the raw samples.

import '../src/platform/node/install.js';   // the core reaches the runtime through platform()
import './host-node.js';   // the tests reach the runtime through host(), installed before framework.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DIM, GREEN, RED, RESET, errorMessage, optVal, say } from './framework.js';
import { readTextFile, writeTextFile } from '../src/files.js';
import { markdownToHtml } from '../src/markdown/html.js';
import { parseInline } from '../src/markdown/inline.js';
import { findTables, parseTable, renderTable } from '../src/markdown/table.js';
import { parseBoard, serializeBoard } from '../src/markdown/kanban.js';

function fail(message: string): never {
    say(`${RED}Benchmark failed: ${message}${RESET}`);
    process.exit(1);
}

const FIXTURE = optVal('fixture') ?? 'mixed';
if (!['mixed', 'long', 'book'].includes(FIXTURE)) fail('--fixture must be mixed, long, or book.');
const SIZE = Number(optVal('size') ?? 100);
const RUNS = Number(optVal('runs') ?? 10);
const BUDGET = optVal('budget') !== undefined ? Number(optVal('budget')) : null;
for (const [name, value] of [['size', SIZE], ['runs', RUNS]] as [string, number][]) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`--${name} must be a positive integer.`);
}
if (BUDGET !== null && (!Number.isFinite(BUDGET) || BUDGET <= 0)) fail('--budget must be a positive number.');

interface Stats { median: number; p95: number; max: number; samples: number[] }
interface Saved {
    version: number; date: string; size: number; runs: number; fixture: string;
    environment: { node: string; host: string; commit: string };
    results: Record<string, number>; stats: Record<string, Stats>;
}
const results: Record<string, number> = {};
const statistics: Record<string, Stats> = {};
let overBudget = false;

const environment = { node: process.version, host: hostname(), commit: 'unknown' };
try { environment.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Git is not required. */ }

const COMPARE = optVal('compare');
let baseline: Saved | null = null;
if (COMPARE) {
    try { baseline = JSON.parse(readTextFile(COMPARE)) as Saved; } catch (e) { fail(`the baseline cannot be read: ${errorMessage(e)}`); }
    // The commit may differ: the purpose of a baseline is to compare code changes.
    if (baseline.version !== 3 || baseline.size !== SIZE || baseline.fixture !== FIXTURE || baseline.runs !== RUNS ||
        baseline.environment?.node !== environment.node || baseline.environment?.host !== environment.host) {
        say(`${DIM}The baseline is not equivalent (format, size, repetitions, or environment); the difference is skipped.${RESET}`);
        baseline = null;
    }
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

function measure(fn: () => void, runs = RUNS): number[] {
    fn();  // warm-up (JIT and cache)
    const t: number[] = [];
    for (let i = 0; i < runs; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
    return t;
}

function report(name: string, t: number[]): void {
    const sorted = [...t].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const max = sorted[sorted.length - 1];
    const over = BUDGET !== null && med > BUDGET;
    if (over) overBudget = true;
    results[name] = med;
    statistics[name] = { median: med, p95, max, samples: [...t] };
    const before = baseline?.results[name];
    let delta = '';
    if (before !== undefined && before > 0) {
        const pct = (med - before) / before * 100;
        const color = Math.abs(pct) < 25 ? DIM : pct < 0 ? GREEN : RED;
        delta = `   ${color}${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% (was ${before.toFixed(2)} ms)${RESET}`;
    }
    say(`  ${name.padEnd(34)} median ${med.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms   max ${max.toFixed(2)} ms${delta}${over ? `  ${RED}> ${BUDGET} ms${RESET}` : ''}`);
}

const text = doc(SIZE);
const lines = text.split('\n');
say(`${DIM}Size ${SIZE} blocks (${FIXTURE}, ≈ ${(text.length / 1024).toFixed(0)} KB), ${RUNS} repetitions${BUDGET !== null ? `, budget ${BUDGET} ms` : ''}${RESET}`);
report('markdownToHtml', measure(() => markdownToHtml(text, 'bench')));
report('parseInline (per line)', measure(() => { for (const l of lines) parseInline(l); }));
report('findTables', measure(() => findTables(lines)));
report('parseTable + renderTable', measure(() => {
    for (const r of findTables(lines)) renderTable(parseTable(lines.slice(r.start, r.end)));
}));
const kanban = KANBAN(Math.max(10, Math.floor(SIZE / 3)));
report('parseBoard + serializeBoard', measure(() => serializeBoard(parseBoard(kanban))));

const SAVE = optVal('save');
if (SAVE) {
    const saved: Saved = { version: 3, date: new Date().toISOString(), size: SIZE, runs: RUNS, fixture: FIXTURE, environment, results, stats: statistics };
    mkdirSync(dirname(SAVE), { recursive: true });
    writeTextFile(SAVE, JSON.stringify(saved, null, 2) + '\n');
    say(`\n${DIM}Results saved: ${SAVE}${RESET}`);
}
say(overBudget ? `\n${RED}A measurement exceeded the budget.${RESET}` : `\n${GREEN}Done.${RESET}`);
process.exit(overBudget ? 1 : 0);
