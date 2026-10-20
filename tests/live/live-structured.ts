// Live evaluation of the tools for structured documents (describe_schema, query_notes, edit_note, edit_schema) against a
// real model. Each scenario writes fixtures into a temporary folder, lets the model work, approves every proposal like
// the Apply button would, and then checks the files. Part of npm run test:live with --structured (or --structured-only).

import type { Change } from '../../src/agent/changes.js';
import type { Provider } from '../../src/agent/provider.js';
import { applyBatch } from '../../src/agent/batch.js';
import { structuredIssues } from '../../src/agent/notes.js';
import { ChatSession } from '../../src/agent/session.js';
import { fileExists, readTextFile, writeTextFile } from '../../src/files.js';
import { parseSchema, readItem } from '../../src/markdown/fields.js';
import { layoutOf } from '../../src/markdown/layout.js';
import { WorkspaceRepository } from '../../src/workspace.js';
import { DIM, GREEN, RED, RESET, errorMessage } from '../core/framework.js';
import { disk, say } from '../core/framework.js';
import { host } from '../core/host.js';
import { platform } from '../../src/platform/index.js';

const TASKS = `---
layout: table
add: bottom
fields:
  status: select(todo:gray, doing:blue, done:green) = todo
  due: date
  owner: person[]
---

# Tasks

- Write spec #docs [status:: doing] [due:: 2026-10-20]
- Fix login [status:: todo] [due:: 2026-10-25 09:00] [owner:: Ana, Budi]
- Ship release [status:: done] [due:: 2026-10-10]
- Plan retreat [status:: todo]
`;

const BOARD = `---
layout: board
fields:
  priority: select(high:red, low)
---

## Plan

- [ ] Release material [priority:: high]

## In Progress

## Done

- [x] Book venue
`;

interface Run { read: (name: string) => string; answer: string; tools: string[]; proposals: number }

interface Scenario {
    name: string;
    question: string;
    files: Record<string, string>;
    check: (run: Run) => string[];   // what is wrong, empty = passed
    expectTool?: string;             // a tool the scenario is meant to exercise (reported when unused, not a failure)
}

// The note of `file` whose title contains `title`, read against the document's own fields.
function noteOf(text: string, title: string) {
    const doc = parseSchema(text).fields;
    const line = text.split('\n').find(l => l.includes(title)) ?? '';
    return readItem(line.replace(/^- (\[.\] )?/, ''), doc);
}

const value = (text: string, title: string, key: string): string => {
    const parsed = noteOf(text, title).fields[key];
    return parsed?.ok ? JSON.stringify(parsed.value) : parsed ? `invalid:${parsed.raw}` : '';
};

// The list items of an answer (also when a model puts them on one line).
const bullets = (answer: string): string[] => answer.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s/.test(l)).flatMap(l => l.split(/\s+-\s+(?=[A-Z])/));

const body = (text: string): string => text.split('\n---\n').slice(1).join('\n---\n');

const unchanged = (before: string, after: string, ...skip: string[]): boolean => {
    const old = before.split('\n').filter(l => !skip.some(s => l.includes(s)));
    const now = after.split('\n').filter(l => !skip.some(s => l.includes(s)));
    return old.join('\n') === now.join('\n');
};

const SCENARIOS: Scenario[] = [
    {
        name: 'find notes by a date and a status (read-only)',
        question: 'Which tasks in tasks.md are not done and are due before 26 October 2026? List only their titles.',
        files: { 'tasks.md': TASKS },
        check: r => [
            ...(/write spec/i.test(r.answer) && /fix login/i.test(r.answer) ? [] : ['the answer misses Write spec or Fix login']),
            // Only the items of a list count: the model may explain why it left a task out.
            ...(bullets(r.answer).some(l => /ship release|plan retreat/i.test(l)) ? ['the answer lists a task that is done or has no due date'] : []),
            ...(r.proposals ? ['it proposed a change to answer a question'] : []),
        ],
        expectTool: 'query_notes',
    },
    {
        name: 'count the notes per status',
        question: 'How many tasks does tasks.md have in each status? Answer with the three numbers.',
        files: { 'tasks.md': TASKS },
        check: r => [
            ...(/todo\D{0,20}\b2\b|\b2\b\D{0,20}todo/i.test(r.answer) ? [] : ['todo should be 2']),
            ...(/doing\D{0,20}\b1\b|\b1\b\D{0,20}doing/i.test(r.answer) ? [] : ['doing should be 1']),
            ...(/done\D{0,20}\b1\b|\b1\b\D{0,20}done/i.test(r.answer) ? [] : ['done should be 1']),
        ],
        expectTool: 'query_notes',
    },
    {
        name: 'change the fields of one note (edit_note)',
        question: 'In tasks.md, set Fix login to doing and move its due date to 3 November 2026. Change nothing else.',
        files: { 'tasks.md': TASKS },
        check: r => {
            const text = r.read('tasks.md');
            return [
                ...(value(text, 'Fix login', 'status') === '"doing"' ? [] : [`status is ${value(text, 'Fix login', 'status')}`]),
                ...(/"date":"2026-11-03"/.test(value(text, 'Fix login', 'due')) ? [] : [`due is ${value(text, 'Fix login', 'due')}`]),
                ...(value(text, 'Fix login', 'owner') === '["Ana","Budi"]' ? [] : ['the owner was lost']),
                ...(unchanged(TASKS, text, 'Fix login') ? [] : ['another line changed']),
                ...structuredIssues(text).map(i => i.text),
            ];
        },
        expectTool: 'edit_note',
    },
    {
        name: 'add a field with options, then use it (edit_schema + edit_note)',
        question: 'Add a priority field to tasks.md with the options high, medium, and low, and set Write spec to high.',
        files: { 'tasks.md': TASKS },
        check: r => {
            const text = r.read('tasks.md');
            const priority = parseSchema(text).fields.find(f => f.key === 'priority');
            return [
                ...(priority?.type === 'select' && ['high', 'medium', 'low'].every(o => priority.options.includes(o)) ? [] : ['priority is not a select with high, medium, low']),
                ...(value(text, 'Write spec', 'priority') === '"high"' ? [] : [`Write spec priority is ${value(text, 'Write spec', 'priority')}`]),
                ...structuredIssues(text).map(i => i.text),
            ];
        },
        expectTool: 'edit_schema',
    },
    {
        name: 'a value the schema does not have must not end up in the file',
        question: 'Add a task "Review PR" to tasks.md with the status blocked. If blocked is not an existing status, add it as a new status first.',
        files: { 'tasks.md': TASKS },
        check: r => {
            const text = r.read('tasks.md');
            return [
                ...(text.includes('Review PR') ? [] : ['the task was not added']),
                ...(value(text, 'Review PR', 'status') === '"blocked"' ? [] : [`status is ${value(text, 'Review PR', 'status')}`]),
                ...(parseSchema(text).fields.find(f => f.key === 'status')?.options.includes('blocked') ? [] : ['blocked was not declared as an option']),
                ...structuredIssues(text).map(i => i.text),
            ];
        },
        expectTool: 'edit_note',
    },
    {
        name: 'move a note on a board and set its field',
        question: 'On the board in board.md, move Release material to In Progress and set its priority to low.',
        files: { 'board.md': BOARD },
        check: r => {
            const text = r.read('board.md');
            return [
                ...(/## In Progress\n\n- \[ \] Release material/.test(text) ? [] : ['the card is not in In Progress']),
                ...(value(text, 'Release material', 'priority') === '"low"' ? [] : [`priority is ${value(text, 'Release material', 'priority')}`]),
                ...(/- \[x\] Book venue/.test(text) ? [] : ['Book venue changed']),
                ...structuredIssues(text).map(i => i.text),
            ];
        },
    },
    {
        name: 'show a document as a calendar (edit_schema set_layout)',
        question: 'Show tasks.md as a calendar.',
        files: { 'tasks.md': TASKS },
        check: r => [
            ...(layoutOf(r.read('tasks.md')) === 'calendar' ? [] : [`the layout is ${layoutOf(r.read('tasks.md'))}`]),
            // Options such as `date: due` in the frontmatter are fine; the notes must stay as they were.
            ...(body(r.read('tasks.md')) === body(TASKS) ? [] : ['the notes changed']),
        ],
        expectTool: 'edit_schema',
    },
];

async function runScenario(sc: Scenario, provider: Provider, model: string, thinking: boolean): Promise<boolean> {
    const root = host().makeTempDir();
    const path = (name: string) => disk.join(root, name);
    const workspace = new WorkspaceRepository();
    let proposals = 0;
    try {
        for (const [name, text] of Object.entries(sc.files)) writeTextFile(path(name), text);
        const session = new ChatSession();
        session.thinking = thinking;
        const apply = async (changes: Change[]) => {
            proposals++;
            const error = applyBatch(changes, { read: f => fileExists(path(f)) ? readTextFile(path(f)) : null,
                write: c => { writeTextFile(path(c.file), c.after); },
                rollback: c => { if (c.kind === 'create') disk.remove(path(c.file)); else writeTextFile(path(c.file), c.before); } });
            return { applied: !error, ...(error ? { error } : {}) };
        };
        const started = (platform().monotonicMs() * 1000);
        const r = await session.ask({ question: sc.question, active: null, files: workspace.files(root), selection: '', mentions: [], options: { project: true, activeDocument: true, selection: true }, budget: 8000 }, provider, model, {
            onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: () => workspace.files(root, { freshness: 'fresh' }),
            onTool: s => { if (s.summary) say(`    ${DIM}• ${s.label} → ${s.summary}${RESET}`); },
            onProposal: c => apply([c]), onBatchProposal: apply,
        });
        const tools = session.events.map(e => e.tool);
        const problems = sc.check({ read: n => readTextFile(path(n)), answer: r.text, tools, proposals });
        const secs = (((platform().monotonicMs() * 1000) - started) / 1e6).toFixed(1);
        const used = sc.expectTool && !tools.includes(sc.expectTool) && !tools.includes('propose_batch')
            ? ` (note: ${sc.expectTool} was not used; tools: ${[...new Set(tools)].join(', ') || 'none'})` : '';
        say(`  ${problems.length ? RED : GREEN}${problems.length ? '✗' : '✓'} ${sc.name}: ${proposals} proposals, ${secs} s${used}${RESET}`);
        for (const p of problems) say(`      ${RED}${p}${RESET}`);
        if (problems.length) say(`      ${DIM}answer: ${r.text.trim().slice(0, 300).replace(/\n/g, ' ')}${RESET}`);
        return problems.length === 0;
    } catch (e) {
        say(`  ${RED}✗ ${sc.name}: ${errorMessage(e)}${RESET}`);
        return false;
    } finally {
        for (const f of workspace.files(root)) disk.remove(path(f.name));
        disk.remove(root);
    }
}

export async function liveStructured(provider: Provider, model: string, thinking: boolean): Promise<number> {
    say('\nStructured documents');
    let failures = 0;
    for (const sc of SCENARIOS) if (!await runScenario(sc, provider, model, thinking)) failures++;
    say(`${failures ? RED : GREEN}${SCENARIOS.length - failures}/${SCENARIOS.length} structured scenarios passed${RESET}`);
    return failures;
}
