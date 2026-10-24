#!/usr/bin/env node
// The Editor Inspector from another process (docs/design/debugger.md, section 8.4): `npm run editor -- <op> …` talks to
// a Markwork window started in dev mode (--inspect-editor or MARKWORK_DEV=1) over its socket, and prints JSON. An agent,
// a test, or a developer reads the same answers the inspector panel shows.
//
// Exit codes: 0 done, 1 a check failed (or a replay did not come out as expected), 2 a usage or connection error.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuzz, kindsOf, play } from './editor-fuzz.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: npm run editor -- [--pid N] [--pretty] [--headless [--folder DIR] [--keep]] <op> [args] [--then <op> [args]]…

  snapshot [--at cursor|POS] [--all]      what the editor shows and hides
  press KEY… [--explain]                  real keys: Backspace, Enter, Mod+b, Ctrl+Shift+z, ArrowDown
  type TEXT [--explain]                   real typing
  click --visible TEXT [--start|--end]    a click on text the eye sees (its end by default)
  click --pos N [--mods M] [--explain]    a click at a position of the text
  select FROM [TO] [--explain]            a selection, dispatched (marked select.inspect)
  log [--since N] [--flagged] [--follow]  the recorded transactions
  decorations [--line N]                  the decorations of a line (around the cursor by default)
  check [NAME…]                           the findings of the last transaction
  open PATH                               a file of the work folder, or any file by its absolute path
  mode visual|live|source [--focus|--no-focus]
  save-repro FILE [--note TEXT] [--blur]  the recording as a repro (.mwrepro.json); --blur: letters x, digits 0
  load FILE                               a repro's start in a new tab
  replay FILE                             a repro played again with every check: pass, fail, or differs
  screenshot FILE [--overlay]             a PNG of the editor
  fuzz [--docs GLOB,…] [--runs N] [--steps N] [--seed S] [--keys K,…] [--quiet MS] [--out DIR] [--shrink-seconds N]
                                          random keys and clicks with every check; a failure is shrunk and saved
  test-from FILE [--name NAME] [--dir D]  a repro as a test: tests/electron/repros/NAME.mwrepro.json
  hello                                   the window's process

--headless starts its own window on a scratch folder (a copy of --folder, which is never written) and closes it at the
end unless --keep.`;

class Usage extends Error {}
const fail = (message, code = 2) => { process.stderr.write(`editor: ${message}\n`); process.exit(code); };

// ---------- Arguments ----------

// The flags that take the next word as their value.
const VALUED = new Set(['at', 'since', 'line', 'pos', 'mods', 'note', 'visible', 'docs', 'runs', 'steps', 'seed', 'keys', 'quiet', 'out', 'shrink-seconds', 'name', 'dir']);

const whole = (v, what) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Usage(`${what} ${v} is not a whole number`);
    return n;
};

// Each op's request, from its words and flags; `one(what)` is its single word.
const OPS = {
    hello: () => ({}),
    snapshot: (_w, f) => ({ at: f.at === undefined || f.at === 'cursor' ? f.at : whole(f.at, '--at'), all: f.all === true }),
    press: (w, f) => { if (!w.length) throw new Usage('press needs a key'); return { keys: w, explain: f.explain === true }; },
    type: (_w, f, one) => ({ text: one('the text'), explain: f.explain === true }),
    click: (_w, f) => {
        const explain = f.explain === true;
        if (f.visible !== undefined) return { visible: f.visible, edge: f.start ? 'start' : 'end', mods: f.mods, explain };
        if (f.pos !== undefined) return { pos: whole(f.pos, '--pos'), mods: f.mods, explain };
        throw new Usage('click needs --visible TEXT or --pos N');
    },
    select: (w, f) => {
        if (w.length < 1 || w.length > 2) throw new Usage('select needs FROM and maybe TO');
        return { from: whole(w[0], 'FROM'), to: whole(w[1], 'TO'), explain: f.explain === true };
    },
    log: (_w, f) => ({ since: whole(f.since, '--since'), flagged: f.flagged === true, follow: f.follow === true }),
    decorations: (_w, f) => ({ line: f.line === undefined ? undefined : Number(f.line) }),
    check: w => ({ names: w }),
    open: (_w, _f, one) => ({ path: one('a path') }),
    mode: (_w, f, one) => ({ mode: one('visual, live, or source'), focus: f.focus === true ? true : f['no-focus'] === true ? false : undefined }),
    'save-repro': (_w, f, one) => ({ file: one('a file'), note: f.note, blur: f.blur === true }),
    load: (_w, _f, one) => ({ file: one('a file') }),
    replay: (_w, _f, one) => ({ file: one('a file') }),
    screenshot: (_w, f, one) => ({ file: one('a file'), overlay: f.overlay === true }),
    fuzz: (_w, f) => ({
        docs: f.docs ?? join(repo, 'tests', 'samples', 'all-formats.md'), runs: whole(f.runs, '--runs') ?? 1, steps: whole(f.steps, '--steps') ?? 100,
        seed: whole(f.seed, '--seed') ?? 1, keys: f.keys, quiet: whole(f.quiet, '--quiet') ?? 60, out: f.out ?? '.', shrinkSeconds: whole(f['shrink-seconds'], '--shrink-seconds') ?? 120,
    }),
    'test-from': (_w, f, one) => ({ file: one('a repro file'), name: f.name, dir: f.dir }),
};

function parseOp(args) {
    const [op, ...rest] = args;
    if (!op) throw new Usage('no op given');
    if (!Object.hasOwn(OPS, op)) throw new Usage(`no such op: ${op}`);
    const flags = {}, words = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('--') || a === '--') { words.push(a); continue; }
        const name = a.slice(2);
        if (!VALUED.has(name)) { flags[name] = true; continue; }
        if (i + 1 >= rest.length) throw new Usage(`--${name} needs a value`);
        flags[name] = rest[++i];
    }
    const one = what => { if (words.length !== 1) throw new Usage(`${op} needs ${what}`); return words[0]; };
    return { op, ...OPS[op](words, flags, one) };
}

function parseArgs(argv) {
    const global = { pretty: false, headless: false, keep: false, pid: undefined, folder: undefined };
    let i = 0;
    for (; i < argv.length && argv[i].startsWith('--'); i++) {
        const a = argv[i];
        if (a === '--pretty') global.pretty = true;
        else if (a === '--headless') global.headless = true;
        else if (a === '--keep') global.keep = true;
        else if (a === '--pid' || a === '--folder') {
            if (i + 1 >= argv.length) throw new Usage(`${a} needs a value`);
            global[a.slice(2)] = argv[++i];
        } else if (a === '--help' || a === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
        else throw new Usage(`unknown option ${a}`);
    }
    const ops = [];
    let current = [];
    for (const a of argv.slice(i)) {
        if (a === '--then') { ops.push(current); current = []; } else current.push(a);
    }
    ops.push(current);
    return { global, ops: ops.map(parseOp) };
}

// ---------- The socket ----------

// The folder of the sockets, as the app finds it (src/platform/node/dirs.ts userDirs: runtime, then markwork/).
function socketFolder() {
    const env = process.env, home = homedir();
    if (process.platform === 'darwin') return join(env.TMPDIR || join(home, 'Library', 'Caches'), 'markwork');
    return join(env.XDG_RUNTIME_DIR || env.XDG_CACHE_HOME || join(home, '.cache'), 'markwork');
}
const socketOf = pid => process.platform === 'win32' ? `\\\\.\\pipe\\markwork-inspect-${pid}` : join(socketFolder(), `inspect-${pid}.sock`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// The socket of the one window in dev mode that is running, or the one asked for.
function findSocket(pid) {
    if (pid !== undefined) return socketOf(pid);
    let names;
    try {
        names = process.platform === 'win32' ? readdirSync('\\\\.\\pipe\\').filter(n => n.startsWith('markwork-inspect-')) : readdirSync(socketFolder());
    } catch { names = []; }
    const pids = names.map(n => /inspect-(\d+)(\.sock)?$/.exec(n)?.[1]).filter(Boolean).map(Number).filter(alive);
    if (!pids.length) throw new Usage('no Markwork window in dev mode is running (start it with MARKWORK_DEV=1, or use --headless)');
    if (pids.length > 1) throw new Usage(`more than one window in dev mode is running (${pids.join(', ')}): choose one with --pid`);
    return socketOf(pids[0]);
}

class Connection {
    constructor(socket) {
        this.socket = socket;
        this.next = 1;
        this.waiting = new Map();
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            buffer += chunk;
            for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const reply = JSON.parse(line);
                this.waiting.get(reply.re)?.(reply);
                this.waiting.delete(reply.re);
            }
        });
        socket.on('close', () => { for (const done of this.waiting.values()) done({ ok: false, error: { code: 'closed', message: 'the window closed the connection' } }); this.waiting.clear(); });
    }
    static open(path) {
        return new Promise((resolve, reject) => {
            const socket = connect(path);
            socket.once('connect', () => resolve(new Connection(socket)));
            socket.once('error', e => reject(new Usage(`cannot reach ${path}: ${e.message}`)));
        });
    }
    // The answer, or an Error with the window's code and message.
    async ask(request) {
        const id = this.next++;
        const reply = await new Promise(resolve => { this.waiting.set(id, resolve); this.socket.write(`${JSON.stringify({ ...request, id })}\n`); });
        if (!reply.ok) throw Object.assign(new Error(reply.error?.message ?? 'failed'), { code: reply.error?.code });
        const { re: _re, ok: _ok, ...answer } = reply;
        return answer;
    }
    close() { this.socket.end(); }
}

// ---------- Headless ----------

// A window of its own, as the tests start one (tests/electron/support.mjs launchApp): its settings and data in a scratch
// folder, dev mode on, and a virtual display on Linux when there is none.
async function startHeadless(folder) {
    if (!existsSync(join(repo, 'dist-electron', 'main.js'))) throw new Usage('the app is not built: run npm run electron:build');
    if (folder && !existsSync(folder)) throw new Usage(`--folder ${folder} does not exist`);
    const scratch = mkdtempSync(join(tmpdir(), 'markwork-editor-'));
    // The window works on a copy: the keys it is sent edit the text, and autosave would write them into the folder.
    const notes = join(scratch, 'notes');
    if (folder) cpSync(resolve(folder), notes, { recursive: true }); else mkdirSync(notes, { recursive: true });
    const electron = createRequire(import.meta.url)('electron');
    const env = { ...process.env, MARKWORK_DEV: '1', XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data') };
    const args = [repo, notes, '--inspect-editor'];
    // Chromium on Linux refuses to start when its sandbox helper is not set up (owned by root, setuid), as in a container
    // or a fresh npm install; the tests' Playwright starts it without the sandbox too.
    if (process.platform === 'linux') {
        const helper = statSync(join(dirname(electron), 'chrome-sandbox'), { throwIfNoEntry: false });
        if (!helper || helper.uid !== 0 || !(helper.mode & 0o4000)) args.push('--no-sandbox');
    }
    const virtual = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    const child = virtual
        ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', electron, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    // The window says where its socket is once it listens.
    const path = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Usage(`the window did not start within 30 s\n${stderr}`)), 30_000);
        child.stdout.on('data', chunk => {
            out += chunk;
            const found = /Editor Inspector: (.+)/.exec(out);
            if (found) { clearTimeout(timer); resolve(found[1].trim()); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Usage(`the window exited (${code}) before it listened\n${stderr}`)); });
    });
    const stop = () => {
        // xvfb-run passes no signal on to its child: the window's own pid is in its socket's name.
        const pid = Number(/inspect-(\d+)/.exec(path)?.[1]);
        try { if (pid) process.kill(pid); } catch { /* already gone */ }
        child.kill();
        rmSync(scratch, { recursive: true, force: true });
    };
    return { path, stop, notes, pid: Number(/inspect-(\d+)/.exec(path)?.[1]) };
}

// Until the page answers: the socket listens as soon as the main process is up, the page a little later.
async function waitReady(conn) {
    for (const end = Date.now() + 30_000; Date.now() < end;) {
        const hello = await conn.ask({ op: 'hello' });
        if (hello.ready) return hello;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Usage('the page did not start answering within 30 s');
}

// ---------- The ops ----------

const readJSON = file => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Usage(`cannot read ${file}: ${e.message}`); }
};

async function replay(conn, file) {
    const repro = readJSON(file);
    const loaded = await conn.ask({ op: 'load', repro });
    let doc = repro.start?.doc ?? '', first = null;
    for (const [i, step] of repro.steps.entries()) {
        const { answer, failing } = await play(conn, step);
        doc = answer.doc;
        if (failing && !first) first = { step: i + 1, ...step, finding: failing };
    }
    const expected = repro.expect?.doc;
    const result = first ? 'fail' : expected !== undefined && expected !== doc ? 'differs' : 'pass';
    return { result, steps: repro.steps.length, ...(first ? { first } : {}), doc, ...(result === 'differs' ? { expected } : {}), widthDiffers: loaded.widthDiffers };
}

// The texts a fuzz run types into: files named by glob patterns, comma-separated.
function fuzzDocs(patterns) {
    const files = patterns.split(',').flatMap(p => globSync(p.trim())).filter(f => statSync(f).isFile());
    if (!files.length) throw new Usage(`--docs ${patterns}: no file`);
    return files.map(name => ({ name, doc: readFileSync(name, 'utf8') }));
}

function runFuzz(conn, request) {
    let kinds;
    try { kinds = kindsOf(request.keys); } catch (e) { throw new Usage(e.message); }
    if (!existsSync(request.out)) mkdirSync(request.out, { recursive: true });
    return fuzz(conn, { ...request, docs: fuzzDocs(request.docs), kinds });
}

// A repro kept as a test (tests/electron/repros.mjs plays each): it must pass every check, and come out as the text it
// expects when it has one. A repro of a failure is the test of its fix.
function testFrom(request) {
    const repro = readJSON(request.file);
    if (repro.format !== 'markwork-repro') throw new Usage(`${request.file} is not a markwork repro`);
    const name = (request.name ?? basename(request.file).replace(/\.mwrepro\.json$|\.json$/, '')).replace(/[^\w.-]+/g, '-');
    const folder = request.dir ? resolve(request.dir) : join(repo, 'tests', 'electron', 'repros');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${name}.mwrepro.json`);
    const { actual: _actual, ...kept } = repro;
    writeFileSync(file, `${JSON.stringify({ ...kept, expect: { ...repro.expect, checks: 'pass' } }, null, 2)}\n`);
    return { file, steps: repro.steps.length, failedBefore: repro.actual?.failed ?? [] };
}

async function runOp(conn, request) {
    switch (request.op) {
        case 'open': {
            const absolute = isAbsolute(request.path);
            return conn.ask({ op: 'open', path: request.path, absolute });
        }
        case 'save-repro': {
            const { repro, ...where } = await conn.ask({ op: 'repro', note: request.note, blur: request.blur });
            writeFileSync(request.file, `${JSON.stringify(repro, null, 2)}\n`);
            return { ...where, file: resolve(request.file), steps: repro.steps.length, failed: repro.actual.failed };
        }
        case 'load': return conn.ask({ op: 'load', repro: readJSON(request.file) });
        case 'fuzz': return runFuzz(conn, request);
        case 'test-from': return testFrom(request);
        case 'replay': return replay(conn, request.file);
        case 'screenshot': {
            const { png, ...area } = await conn.ask({ op: 'screenshot', overlay: request.overlay });
            writeFileSync(request.file, Buffer.from(png, 'base64'));
            return { ...area, file: resolve(request.file) };
        }
        case 'log': {
            if (!request.follow) return conn.ask(request);
            // Followed by asking again for what came since: one JSON line per transaction, until interrupted.
            let since = request.since ?? (await conn.ask({ op: 'last' })).n;
            for (;;) {
                const { entries } = await conn.ask({ op: 'log', since, flagged: request.flagged });
                for (const entry of entries) { process.stdout.write(`${JSON.stringify(entry)}\n`); since = entry.n; }
                await new Promise(r => setTimeout(r, 250));
            }
        }
        default: return conn.ask(request);
    }
}

// Whether an answer says a check failed: exit code 1.
const failed = answer => answer.failed === true || (Array.isArray(answer.failed) && answer.failed.length > 0)
    || answer.result === 'fail' || answer.result === 'differs' || answer.findings?.some?.(f => f.severity === 'fail');

// ---------- Printing ----------

const short = text => JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}…` : text);

function txLine(e) {
    const key = e.input?.key ? ` ${e.input.mods ? `${e.input.mods}+` : ''}${e.input.key}` : '';
    const input = e.input ? ` ${e.input.kind}${key}` : '';
    const effects = e.effects.length ? ` effects ${e.effects.join(',')}` : '';
    const found = (e.findings ?? []).map(f => `\n      ${f.severity} ${f.check}: ${f.message}`).join('');
    return `  #${e.n} ${e.userEvent ?? '-'}${input} sel ${JSON.stringify(e.selAfter)}${effects}${found}`;
}

const ranges = list => list.map(([a, b]) => `${a}–${b}`).join(' ') || 'none';

function prettySnapshot(a) {
    const prefix = a.cursor.inPrefix ? ' in a hidden prefix' : '';
    return [
        `${a.path ?? a.name} · ${a.mode}${a.focus ? ' · focus' : ''} · ${a.length} chars, ${a.lines} lines`,
        `cursor ${a.cursor.pos} (line ${a.cursor.line}, col ${a.cursor.col})${prefix}; visible before: ${JSON.stringify(a.visibleBefore?.char ?? null)}`,
        `hidden: ${ranges(a.hidden)}`,
        `prefixes: ${ranges(a.prefixes)}`,
        ...a.decorations.map(d => `  ${d.from}–${d.to} ${d.kind}${d.block ? ' block' : ''} ${d.what}`),
    ];
}

function prettyEntries(a) {
    const lines = a.doc === undefined ? [] : [`text: ${short(a.doc)}`];
    return [...lines, ...(a.entries.length ? a.entries.map(txLine) : ['  no transactions'])];
}

function prettyReplay(a) {
    const lines = [`${a.result}: ${a.steps} steps${a.widthDiffers ? ' (the editor is not as wide as when it was recorded)' : ''}`];
    if (a.first) lines.push(`  step ${a.first.step}: ${a.first.finding.check}: ${a.first.finding.message}`);
    if (a.result === 'differs') lines.push(`  text:     ${JSON.stringify(a.doc)}`, `  expected: ${JSON.stringify(a.expected)}`);
    return lines;
}

const prettyFuzz = a => [
    `seed ${a.seed}: ${a.runs} runs, ${a.steps} steps, ${a.failures.length ? `${a.failures.length} failed` : 'every check passed'}`,
    ...a.failures.map(f => `  run ${f.run} (${f.doc}) step ${f.step}: ${f.check}: ${f.message}\n    shrunk to ${f.steps} steps in ${f.tries} tries: ${f.file}`),
];

const prettyFindings = a => [`#${a.n}: ${a.findings.length ? '' : 'no findings'}`, ...a.findings.map(f => `  ${f.severity} ${f.check}: ${f.message}`)];

function pretty(request, answer) {
    const lines = request.op === 'snapshot' ? prettySnapshot(answer)
        : request.op === 'fuzz' ? prettyFuzz(answer)
        : Array.isArray(answer.entries) ? prettyEntries(answer)
        : request.op === 'replay' ? prettyReplay(answer)
        : Array.isArray(answer.findings) ? prettyFindings(answer)
        : [JSON.stringify(answer, null, 2)];
    return lines.join('\n');
}

// ---------- Main ----------

// The window to talk to: one of its own (--headless), or the one running in dev mode.
async function connectTo(global) {
    if (!global.headless) return { conn: await Connection.open(findSocket(global.pid === undefined ? undefined : Number(global.pid))), headless: null };
    const headless = await startHeadless(global.folder);
    try {
        const conn = await Connection.open(headless.path);
        await waitReady(conn);
        return { conn, headless };
    } catch (e) {
        headless.stop();
        throw e;
    }
}

// Runs the ops in order and prints each answer; the exit code: 1 when a check failed in any of them.
async function runAll(conn, ops, global) {
    let code = 0;
    for (const request of ops) {
        const answer = await runOp(conn, request);
        process.stdout.write(`${global.pretty ? pretty(request, answer) : JSON.stringify(answer)}\n`);
        if (failed(answer)) code = 1;
    }
    return code;
}

async function main() {
    let parsed;
    try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { if (e instanceof Usage) fail(`${e.message}\n\n${USAGE}`); throw e; }
    const { global, ops } = parsed;
    let window = null, code = 0, error = null;
    try {
        // test-from only copies a file: no window is needed for it.
        window = ops.every(op => op.op === 'test-from') ? { conn: null, headless: null } : await connectTo(global);
        code = await runAll(window.conn, ops, global);
        if (window.headless && global.keep) process.stderr.write(`editor: the window keeps running: --pid ${window.headless.pid}\n`);
    } catch (e) {
        error = e instanceof Usage || !e.code ? e.message : `${e.code}: ${e.message}`;
    } finally {
        window?.conn?.close();
        if (window?.headless && !global.keep) window.headless.stop();
    }
    if (error) fail(error);
    process.exit(code);
}

await main();
