// Fuzzing the visual editor through the inspector's bridge (docs/design/debugger.md, section 10): random keys and clicks
// on sample texts, every check after every step, and a failure shrunk to the fewest steps that still fail, saved as a
// repro. The keys are real input (the bridge sends them as a person's), so what a fuzz run finds a person can hit.
// Used by scripts/editor.mjs (`fuzz`); a seed makes a run the same each time.

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// mulberry32: small, fast, and the same on every system for a seed.
export function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// The kinds of step a run takes, with how often: mostly typing and the keys that bring hidden syntax next to the cursor.
const KINDS = [
    ['type', 30], ['space', 5], ['Backspace', 14], ['Delete', 6], ['Enter', 8], ['Tab', 2], ['Shift+Tab', 2],
    ['ArrowLeft', 6], ['ArrowRight', 6], ['ArrowUp', 4], ['ArrowDown', 4], ['Home', 3], ['End', 3], ['click', 6], ['click-pos', 2],
];
export const KIND_NAMES = KINDS.map(([name]) => name);

function pick(rng, kinds) {
    const total = kinds.reduce((sum, [, weight]) => sum + weight, 0);
    let at = rng() * total;
    for (const [name, weight] of kinds) { if ((at -= weight) < 0) return name; }
    return kinds.at(-1)[0];
}

// One random step for a text of `length` characters on `lines` lines. A click is where a person clicks, at the start or
// past the end of what a line shows (the bugs of the visual editor come from where such a click lands); `click-pos` is
// a click at a position of the text, which may be one hidden from the eye.
export function randomStep(rng, length, lines, kinds) {
    const kind = pick(rng, kinds);
    if (kind === 'type') return { type: LETTERS[Math.floor(rng() * LETTERS.length)] };
    if (kind === 'space') return { type: ' ' };
    if (kind === 'click') return { click: { line: 1 + Math.floor(rng() * lines), edge: rng() < 0.5 ? 'start' : 'end' } };
    if (kind === 'click-pos') return { click: { pos: Math.floor(rng() * (length + 1)) } };
    return { key: kind };
}

// The kinds a `--keys` list keeps (all when there is none).
export function kindsOf(list) {
    if (!list) return KINDS;
    const names = list.split(',').map(k => k.trim()).filter(Boolean);
    const unknown = names.filter(n => !KIND_NAMES.includes(n));
    if (unknown.length) throw new Error(`--keys: ${unknown.join(', ')} not one of ${KIND_NAMES.join(', ')}`);
    return KINDS.filter(([name]) => names.includes(name));
}

// ---------- Playing steps ----------

// The request of one step of a repro: the same input a person gave.
export function stepRequest(step) {
    if ('key' in step) return { op: 'press', keys: [step.key] };
    if ('type' in step) return { op: 'type', text: step.type };
    if ('select' in step) return { op: 'select', from: step.select[0], to: step.select[1] };
    if ('external' in step) return { op: 'apply', changes: step.external };
    if ('visible' in step.click) return { op: 'click', visible: step.click.visible, edge: step.click.edge ?? 'end' };
    if ('line' in step.click) return { op: 'click', line: step.click.line, edge: step.click.edge };
    return { op: 'click', pos: step.click.pos, mods: step.click.mods };
}

// The first failing finding of an answer's transactions, or null.
const failingOf = answer => answer.entries.flatMap(e => (e.findings ?? []).map(f => ({ ...f, tx: e.n }))).find(f => f.severity === 'fail') ?? null;

// Plays one step; its answer and the first finding that failed.
export async function play(conn, step, quiet) {
    const answer = await conn.ask({ ...stepRequest(step), explain: true, quiet });
    return { answer, failing: failingOf(answer) };
}

// Whether the steps from `start` still make check `check` fail (any step). A step that cannot be played (a click past the
// end of a shorter text) means they do not.
async function stillFails(conn, base, steps, check, quiet) {
    await conn.ask({ op: 'load', repro: { ...base, steps } });
    for (const step of steps) {
        let failing;
        try { ({ failing } = await play(conn, step, quiet)); } catch { return false; }
        if (failing?.check === check) return true;
    }
    return false;
}

// Delta debugging, simplified: drops one of n chunks of the steps while the failure stays, with smaller chunks when none
// can go, until single steps cannot go or the time is up.
export async function shrink(conn, base, steps, check, { quiet, seconds }) {
    const end = Date.now() + seconds * 1000;
    let n = 2, tries = 0;
    while (steps.length >= 2 && Date.now() < end) {
        const size = Math.ceil(steps.length / n);
        let dropped = false;
        for (let i = 0; i < steps.length && Date.now() < end; i += size) {
            const candidate = [...steps.slice(0, i), ...steps.slice(i + size)];
            tries++;
            if (candidate.length && await stillFails(conn, base, candidate, check, quiet)) { steps = candidate; n = Math.max(n - 1, 2); dropped = true; break; }
        }
        if (dropped) continue;
        if (size === 1) break;
        n = Math.min(steps.length, n * 2);
    }
    return { steps, tries };
}

// ---------- A fuzz run ----------

const reproOf = (doc, seed, run) => ({
    format: 'markwork-repro', version: 1, app: { version: 'fuzz', os: process.platform },
    editor: { mode: 'visual', focus: false, width: 0 },
    start: { doc, selection: [[0, 0]] }, steps: [], note: `fuzz --seed ${seed}, run ${run + 1}`, blurred: false,
});

// One run on one text: random steps until a check fails or the steps run out. The failure, shrunk and saved, or null.
async function fuzzOne(conn, { doc, name, seed, run, steps, kinds, quiet, out, shrinkSeconds }) {
    const rng = random(seed * 1000 + run);
    const repro = reproOf(doc, seed, run);
    await conn.ask({ op: 'load', repro });
    let length = doc.length, lines = doc.split('\n').length;
    for (let i = 0; i < steps; i++) {
        const step = randomStep(rng, length, lines, kinds);
        let played;
        try {
            played = await play(conn, step, quiet);
        } catch (e) {
            // A click on a place that is not drawn (folded away, or off the lines the editor keeps) is no step a person
            // could take: another one is taken instead.
            if (e.code === 'not-found') continue;
            throw e;
        }
        repro.steps.push(step);
        const { answer, failing } = played;
        length = answer.doc.length;
        lines = answer.doc.split('\n').length;
        if (!failing) continue;
        const found = { run: run + 1, doc: name, step: i + 1, check: failing.check, message: failing.message };
        const shrunk = await shrink(conn, repro, repro.steps, failing.check, { quiet, seconds: shrinkSeconds });
        const file = join(out, `fuzz-${seed}-${run + 1}.mwrepro.json`);
        writeFileSync(file, `${JSON.stringify({ ...repro, steps: shrunk.steps, actual: { doc: answer.doc, failed: [failing.check] } }, null, 2)}\n`);
        return { ...found, steps: shrunk.steps.length, tries: shrunk.tries, file };
    }
    return null;
}

// `runs` runs over the texts in turn. Answers what was found.
export async function fuzz(conn, { docs, runs, steps, seed, kinds, quiet, out, shrinkSeconds }) {
    const failures = [];
    let played = 0;
    for (let run = 0; run < runs; run++) {
        const { name, doc } = docs[run % docs.length];
        const found = await fuzzOne(conn, { doc, name: basename(name), seed, run, steps, kinds, quiet, out, shrinkSeconds });
        played += found ? found.step : steps;
        if (found) failures.push(found);
    }
    return { seed, runs, steps: played, failures, failed: failures.length > 0 };
}
