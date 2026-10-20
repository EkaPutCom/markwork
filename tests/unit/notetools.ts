// Tests for the agent tools of structured documents: describe_schema, query_notes, edit_note, edit_schema, and the
// field checks of verify_work. Without a GUI and network; the model is replaced by calls written in the test.

import type { SourceFile } from '../../src/agent/context.js';
import { planBatch } from '../../src/agent/batch.js';
import { CHANGE_TOOLS, planChange, type Change } from '../../src/agent/changes.js';
import { projectMap } from '../../src/agent/context.js';
import { planNote } from '../../src/agent/notechanges.js';
import { structuredIssues } from '../../src/agent/notes.js';
import { describeSchema, queryNotes } from '../../src/agent/schematools.js';
import { describeCall, runTool, TOOLS } from '../../src/agent/tools.js';
import { verifyWork } from '../../src/agent/verification.js';
import { parseSchema } from '../../src/markdown/fields.js';
import { section, test, eq, ok, contains } from '../core/framework.js';

const TABLE = `---
layout: table
add: bottom
fields:
  status: select(todo:gray, doing:blue, done:green) = todo
  due: date
  owner: person[]
  progress: progress
---

# Tasks

- Write spec #docs [status:: doing] [due:: 2026-10-20] [progress:: 3/5]
- Fix login [status:: todo] [due:: 2026-10-25 09:00] [owner:: Ana, Budi]
- Ship release [status:: done] [due:: 2026-10-10]
- Plan retreat
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
const GROUPED = `---
layout: board
group: status
fields:
  status: select(todo, doing, done) = todo
---

- [ ] Alpha [status:: todo]
- [ ] Beta [status:: doing]
`;
const NOTES = '# Notes\n\nPlain text.\n';

const files = (): SourceFile[] => [
    { name: 'tasks.md', text: TABLE }, { name: 'board.md', text: BOARD }, { name: 'grouped.md', text: GROUPED }, { name: 'notes.md', text: NOTES },
];

const NOW = new Date(2026, 9, 12, 9, 5);

function plan(tool: string, name: string, args: object, set = files()): { change?: Change; message: string } {
    const r = planChange(tool, JSON.stringify({ name, reason: 'test', ...args }), set);
    return r.ok ? { change: r.change, message: '' } : { message: r.message };
}
const after = (tool: string, name: string, args: object, set = files()): string => {
    const r = plan(tool, name, args, set);
    ok(r.change, `should have been planned: ${r.message}`);
    return r.change.after;
};
const refused = (tool: string, name: string, args: object, set = files()): string => {
    const r = plan(tool, name, args, set);
    ok(!r.change, 'should have been rejected');
    return r.message;
};
const note = (args: object, name = 'tasks.md', set = files()): string => after('edit_note', name, args, set);
const schema = (args: object, name = 'tasks.md', set = files()): string => after('edit_schema', name, args, set);

// The lines of `text` that differ from `base`: what a change touched.
const touched = (base: string, text: string): string[] => {
    const old = base.split('\n');
    return text.split('\n').filter(l => !old.includes(l));
};

export function noteToolTests(): void {
    section('Structured documents: describe_schema');

    test('describe_schema lists the layout, options, fields, select options, defaults, and groups', () => {
        const r = describeSchema(files(), { name: 'tasks' });
        contains(r.content, 'tasks.md — layout: table · 4 notes');
        contains(r.content, 'options: add: bottom');
        contains(r.content, '- status: select(todo:gray, doing:blue, done:green) = todo — one of: todo, doing, done');
        contains(r.content, '- due: date');
        contains(r.content, '- owner: person[] — several, comma-separated: a name');
        contains(r.content, '- progress: progress');
    });

    test('describe_schema marks the built-in fields of a board and the groups', () => {
        const r = describeSchema(files(), { name: 'board.md' });
        contains(r.content, 'in 3 groups (Plan 1, In Progress 0, Done 1)');
        contains(r.content, '- due: date (built in to boards)');
        contains(r.content, '- priority: select(high:red, low)');
    });

    test('describe_schema without a name summarizes every structured file and skips ordinary ones', () => {
        const r = describeSchema(files(), {});
        contains(r.content, 'tasks.md');
        contains(r.content, 'board.md');
        contains(r.content, 'grouped.md');
        ok(!r.content.includes('notes.md'), 'an ordinary file is not listed');
        contains(describeSchema(files(), { name: 'notes' }).content, 'ordinary document');
        contains(describeSchema(files(), { name: 'zzz' }).content, 'not found');
        contains(describeSchema([{ name: 'a.md', text: NOTES }], {}).content, 'No file in the folder has a layout');
    });

    test('describe_schema reports problems in the declaration', () => {
        const bad = '---\nlayout: list\nfields:\n  a: wibble\n  b: text\n---\n- x\n';
        contains(describeSchema([{ name: 'bad.md', text: bad }], { name: 'bad.md' }).content, 'unknown type "wibble"');
    });

    test('describe_schema is a registered read tool and reaches runTool', () => {
        ok(TOOLS.some(t => t.name === 'describe_schema') && TOOLS.some(t => t.name === 'query_notes'), 'registered');
        contains(runTool('describe_schema', '{"name":"tasks.md"}', files()).content, 'layout: table');
        eq(describeCall('describe_schema', '{"name":"tasks.md"}'), 'Reading the setup of tasks.md');
        eq(describeCall('query_notes', '{"file":"tasks.md"}'), 'Querying notes in tasks.md');
        eq(describeCall('edit_note', '{"name":"tasks.md"}'), 'Proposing a note change in tasks.md');
        eq(describeCall('edit_schema', '{"name":"tasks.md"}'), 'Proposing a schema change in tasks.md');
    });

    test('list_files shows the layout of a structured document', () => {
        const map = projectMap(files().map(f => ({ ...f, opened: false })), 4000);
        contains(map, '- tasks.md · layout: table · ');
        ok(!map.split('\n').find(l => l.startsWith('- notes.md'))!.includes('layout'), 'an ordinary file has no layout');
    });

    section('Structured documents: query_notes');

    const titles = (content: string): string[] => content.split('\n').slice(1).filter(l => l.startsWith('tasks.md')).map(l => /· (?:\[.\] )?(.*?)( —|$)/.exec(l)![1]);

    test('query_notes filters by a select, a date comparison, and today', () => {
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'status', op: 'eq', value: 'DOING' }] }, NOW).content), ['Write spec']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'due', op: 'lt', value: 'today' }] }, NOW).content), ['Ship release']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'due', op: 'gte', value: '2026-10-20' }, { field: 'status', op: 'ne', value: 'done' }] }, NOW).content), ['Write spec', 'Fix login']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'due', op: 'eq', value: '2026-10-25' }] }, NOW).content), ['Fix login']);
    });

    test('query_notes: empty, not_empty, tag, title, multiple values, progress, and ne counts notes without a value', () => {
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'due', op: 'empty' }] }, NOW).content), ['Plan retreat']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'owner', op: 'not_empty' }] }, NOW).content), ['Fix login']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'tag', op: 'eq', value: '#docs' }] }, NOW).content), ['Write spec']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'title', op: 'contains', value: 'LOGIN' }] }, NOW).content), ['Fix login']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'owner', op: 'eq', value: 'budi' }] }, NOW).content), ['Fix login']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'progress', op: 'gt', value: '50%' }] }, NOW).content), ['Write spec']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'status', op: 'ne', value: 'done' }] }, NOW).content), ['Write spec', 'Fix login', 'Plan retreat']);
    });

    test('query_notes sorts (notes without a value last) and limits', () => {
        const asc = queryNotes(files(), { file: 'tasks.md', sort_by: 'due' }, NOW).content;
        eq(titles(asc), ['Ship release', 'Write spec', 'Fix login', 'Plan retreat']);
        eq(titles(queryNotes(files(), { file: 'tasks.md', sort_by: 'due', desc: true }, NOW).content), ['Fix login', 'Write spec', 'Ship release', 'Plan retreat']);
        const limited = queryNotes(files(), { file: 'tasks.md', sort_by: 'due', limit: 2 }, NOW).content;
        eq(titles(limited), ['Ship release', 'Write spec']);
        contains(limited, '2 more not shown');
    });

    test('query_notes counts per value, including notes without one', () => {
        const r = queryNotes(files(), { file: 'tasks.md', count_by: 'status' }, NOW);
        contains(r.content, '4 notes counted by status');
        for (const line of ['todo: 1', 'doing: 1', 'done: 1', '—: 1']) contains(r.content, line);
        contains(queryNotes(files(), { file: 'tasks.md', count_by: 'due' }, NOW).content, '—: 1');
    });

    test('query_notes spans every structured file and explains its errors', () => {
        const all = queryNotes(files(), { where: [{ field: 'done', op: 'eq', value: 'true' }] }, NOW).content;
        contains(all, 'board.md › Done · [x] Book venue');
        contains(queryNotes(files(), { where: [{ field: 'group', op: 'eq', value: 'plan' }] }, NOW).content, 'board.md › Plan');
        contains(queryNotes(files(), { where: [{ field: 'colour', op: 'eq', value: 'red' }] }, NOW).content, 'No structured document has a field "colour"');
        contains(queryNotes(files(), { where: [{ field: 'status', op: 'wobble', value: 'x' }] }, NOW).content, 'needs a "field" and an "op"');
        contains(queryNotes(files(), { where: [{ field: 'status', op: 'eq' }] }, NOW).content, 'needs a "value"');
        contains(queryNotes(files(), { file: 'notes.md' }, NOW).content, 'ordinary document');
        contains(queryNotes(files(), { file: 'tasks.md', where: [{ field: 'status', op: 'eq', value: 'nothing' }] }, NOW).content, 'No note matches');
    });

    section('Structured documents: edit_note');

    test('edit_note add: fields are written in normal form and the defaults of the document are filled in', () => {
        const out = note({ action: 'add', text: 'Draft docs #docs', fields: { due: '2026-11-02 9:30', owner: ['Ana', 'Budi'], progress: '40%' } });
        contains(out, '- Plan retreat\n- Draft docs #docs [due:: 2026-11-02 09:30] [owner:: Ana, Budi] [progress:: 40%] [status:: todo]\n');
        eq(touched(TABLE, out).length, 1, 'only the new note is added (add: bottom)');
    });

    test('edit_note add: where a list puts new notes, and a group when the layout allows one', () => {
        const list = '---\nlayout: list\nfields:\n  created: date = now\n---\n\n- Old\n';
        const set = [{ name: 'inbox.md', text: list }];
        const out = planNote({ action: 'add', text: 'New idea' }, 'inbox.md', list, NOW);
        ok(out.ok && out.after.includes('- New idea [created:: 2026-10-12 09:05]\n- Old'), 'on top, with the capture time');
        contains(refused('edit_note', 'inbox.md', { action: 'add', text: 'x', group: 'Nope' }, [{ name: 'inbox.md', text: '---\nlayout: list\n---\n\n## A\n\n- 1\n' }]), 'does not exist');
        eq(set.length, 1);
    });

    test('edit_note add: a board needs a group, matched like the other group arguments', () => {
        contains(refused('edit_note', 'board.md', { action: 'add', text: 'Hire' }), 'The "group" argument is required');
        const out = note({ action: 'add', text: 'Hire a caterer', group: 'progress', fields: { priority: 'LOW', due: '2026-11-01' } }, 'board.md');
        contains(out, '## In Progress\n\n- [ ] Hire a caterer [priority:: low] [due:: 2026-11-01]\n');
    });

    test('edit_note refuses what the schema does not accept, with a message the model can use', () => {
        contains(refused('edit_note', 'tasks.md', { action: 'add', text: 'x', fields: { status: 'blocked' } }), 'not one of: todo, doing, done');
        contains(refused('edit_note', 'tasks.md', { action: 'add', text: 'x', fields: { due: '2026-02-31' } }), 'no such day');
        contains(refused('edit_note', 'tasks.md', { action: 'add', text: 'x', fields: { progress: '9/5' } }), 'Expected: done/total');
        const unknown = refused('edit_note', 'tasks.md', { action: 'add', text: 'x', fields: { priority: 'high' } });
        contains(unknown, 'no field "priority"');
        contains(unknown, 'status, due, owner, progress');
        contains(unknown, 'edit_schema add_field');
        contains(refused('edit_note', 'tasks.md', { action: 'add', text: 'x', fields: 'status=todo' }), 'must be an object');
        contains(refused('edit_note', 'tasks.md', { action: 'add', text: 'x', fields: { status: { a: 1 } } }), 'must be text, a number');
        contains(refused('edit_note', 'tasks.md', { action: 'add', text: 'two\nlines' }), 'single line');
        contains(refused('edit_note', 'tasks.md', { action: 'fly' }), 'must be one of: add, update, move, mark, delete');
    });

    test('edit_note on an ordinary file points to edit_file and set_layout', () => {
        const message = refused('edit_note', 'notes.md', { action: 'add', text: 'x' });
        contains(message, 'ordinary document');
        contains(message, 'set_layout');
    });

    test('edit_note update: only the fields given change and the rest of the line stays as it was', () => {
        const out = note({ action: 'update', note: 'Fix login', fields: { status: 'doing', due: '', progress: '1/4' } });
        eq(touched(TABLE, out), ['- Fix login [status:: doing] [owner:: Ana, Budi] [progress:: 1/4]']);
    });

    test('edit_note update: a new title and new tags keep the fields; today and now are filled in for dates', () => {
        const out = note({ action: 'update', note: 'Write spec', title: 'Write the spec', tags: ['docs', 'q4'] });
        eq(touched(TABLE, out), ['- Write the spec #docs #q4 [status:: doing] [due:: 2026-10-20] [progress:: 3/5]']);
        const r = planNote({ action: 'update', note: 'Plan retreat', fields: { due: 'today' } }, 'tasks.md', TABLE, NOW);
        ok(r.ok && r.after.includes('- Plan retreat [due:: 2026-10-12]'), 'today');
        const r2 = planNote({ action: 'update', note: 'Plan retreat', fields: { due: 'now' } }, 'tasks.md', TABLE, NOW);
        ok(r2.ok && r2.after.includes('[due:: 2026-10-12 09:05]'), 'now');
    });

    test('edit_note update: errors for no match, several matches, and nothing to change', () => {
        contains(refused('edit_note', 'tasks.md', { action: 'update', note: 'Zebra', fields: { status: 'done' } }), 'No note contains "Zebra"');
        contains(refused('edit_note', 'tasks.md', { action: 'update', note: 'i', fields: { status: 'done' } }), 'matches');
        contains(refused('edit_note', 'tasks.md', { action: 'update', note: 'Fix login' }), 'Give "title", "tags", and/or "fields"');
        contains(refused('edit_note', 'tasks.md', { action: 'update', note: 'Fix login', fields: { status: 'todo' } }), 'Nothing changed');
        contains(refused('edit_note', 'tasks.md', { action: 'update', note: 'Fix login', title: 'a\nb' }), 'single line');
        contains(refused('edit_note', 'tasks.md', { action: 'update', note: 'Fix login', tags: 'x' }), 'list of text');
    });

    test('edit_note move: to another group of a board, and not to the group it is in', () => {
        const out = note({ action: 'move', note: 'Release material', group: 'In Progress' }, 'board.md');
        contains(out, '## Plan\n\n## In Progress\n\n- [ ] Release material [priority:: high]\n');
        contains(refused('edit_note', 'board.md', { action: 'move', note: 'Release material', group: 'plan' }), 'already in that group');
        contains(refused('edit_note', 'board.md', { action: 'move', note: 'Release material', group: 'Later' }), 'does not exist');
    });

    test('edit_note on a board grouped by a field: move and add set that field', () => {
        const moved = note({ action: 'move', note: 'Alpha', group: 'DONE' }, 'grouped.md');
        contains(moved, '- [ ] Alpha [status:: done]');
        contains(refused('edit_note', 'grouped.md', { action: 'move', note: 'Alpha', group: 'Blocked' }), "board's columns are: todo, doing, done");
        const added = note({ action: 'add', text: 'Gamma', group: 'doing' }, 'grouped.md');
        contains(added, '- [ ] Gamma [status:: doing]');
        contains(note({ action: 'add', text: 'Delta' }, 'grouped.md'), '- [ ] Delta [status:: todo]');
    });

    test('edit_note mark and delete', () => {
        contains(note({ action: 'mark', note: 'Fix login', done: true }), '- [x] Fix login');
        contains(note({ action: 'mark', note: 'Book venue', done: false }, 'board.md'), '- [ ] Book venue');
        contains(refused('edit_note', 'board.md', { action: 'mark', note: 'Book venue', done: true }), 'already has that status');
        contains(refused('edit_note', 'board.md', { action: 'mark', note: 'Book venue' }), '"done" argument');
        const out = note({ action: 'delete', note: 'Ship release' });
        ok(!out.includes('Ship release') && out.includes('Fix login'), 'only that note is deleted');
    });

    section('Structured documents: edit_schema');

    test('edit_schema add_field declares a field in the frontmatter, in order, and leaves the notes alone', () => {
        const out = schema({ action: 'add_field', field: 'priority', type: 'select(high:red, low)', default: 'low' });
        contains(out, '  progress: progress\n  priority: select(high:red, low) = low\n---');
        eq(parseSchema(out).fields.map(f => f.key), ['status', 'due', 'owner', 'progress', 'priority']);
        eq(out.split('# Tasks')[1], TABLE.split('# Tasks')[1], 'the body is unchanged');
        contains(schema({ action: 'add_field', field: 'team', type: 'person[]' }), '  team: person[]\n');
        contains(schema({ action: 'add_field', field: 'start', type: 'date', default: 'today' }), '  start: date = today\n');
    });

    test('edit_schema add_field refuses bad names, duplicates, and bad types', () => {
        contains(refused('edit_schema', 'tasks.md', { action: 'add_field', field: 'Status', type: 'text' }), 'already has a field');
        contains(refused('edit_schema', 'board.md', { action: 'add_field', field: 'due', type: 'date' }), 'already has a field');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_field', field: 'two words', type: 'text' }), 'not a valid field name');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_field', field: 'x', type: 'wibble' }), 'unknown type');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_field', field: 'x' }), '"type" argument is required');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_field', field: 'x', type: 'number', default: 'many' }), 'does not fit');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_field', field: 'x', type: 'text(a)' }), 'only select takes options');
    });

    test('edit_schema remove_field is refused while notes use the field, unless forced', () => {
        contains(refused('edit_schema', 'tasks.md', { action: 'remove_field', field: 'owner' }), '1 notes still have a value for "owner"');
        const forced = schema({ action: 'remove_field', field: 'owner', force: true });
        ok(!forced.includes('  owner:') && forced.includes('[owner:: Ana, Budi]'), 'the declaration goes and the values stay');
        const unused = schema({ action: 'add_field', field: 'x', type: 'text' });
        ok(!schema({ action: 'remove_field', field: 'x' }, 'tasks.md', [{ name: 'tasks.md', text: unused }]).includes('  x:'), 'an unused field goes');
        contains(refused('edit_schema', 'board.md', { action: 'remove_field', field: 'due' }), 'does not declare a field "due"');
        contains(refused('edit_schema', 'tasks.md', { action: 'remove_field', field: 'nope' }), 'Declared fields: status, due, owner, progress');
    });

    test('edit_schema add_option and remove_option', () => {
        const added = schema({ action: 'add_option', field: 'status', option: 'blocked', color: 'red' });
        contains(added, '  status: select(todo:gray, doing:blue, done:green, blocked:red) = todo');
        contains(note({ action: 'update', note: 'Fix login', fields: { status: 'blocked' } }, 'tasks.md', [{ name: 'tasks.md', text: added }]), '[status:: blocked]');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_option', field: 'status', option: 'DOING' }), 'already has it');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_option', field: 'status', option: 'a, b' }), 'no comma');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_option', field: 'status', option: 'x', color: 'mauve' }), 'not a color');
        contains(refused('edit_schema', 'tasks.md', { action: 'add_option', field: 'due', option: 'x' }), 'not a select');

        contains(refused('edit_schema', 'tasks.md', { action: 'remove_option', field: 'status', option: 'doing' }), '1 notes use "doing"');
        contains(refused('edit_schema', 'tasks.md', { action: 'remove_option', field: 'status', option: 'todo' }), '1 notes use "todo"');
        contains(refused('edit_schema', 'tasks.md', { action: 'remove_option', field: 'status', option: 'zzz' }), 'no option "zzz"');
        const gone = schema({ action: 'remove_option', field: 'status', option: 'blocked' }, 'tasks.md', [{ name: 'tasks.md', text: added }]);
        contains(gone, '  status: select(todo:gray, doing:blue, done:green) = todo');
        const spare = schema({ action: 'remove_option', field: 'priority', option: 'low' }, 'board.md');
        contains(spare, '  priority: select(high:red)');
    });

    test('edit_schema remove_option refuses the default of the field', () => {
        const text = '---\nlayout: list\nfields:\n  s: select(a, b) = a\n---\n- x\n';
        contains(refused('edit_schema', 'l.md', { action: 'remove_option', field: 's', option: 'a' }, [{ name: 'l.md', text }]), 'is the default');
        contains(schema({ action: 'remove_option', field: 's', option: 'b' }, 'l.md', [{ name: 'l.md', text }]), '  s: select(a) = a');
    });

    test('edit_schema reorder_fields needs every declared field exactly once', () => {
        const out = schema({ action: 'reorder_fields', order: ['due', 'status', 'progress', 'owner'] });
        eq(parseSchema(out).fields.map(f => f.key), ['due', 'status', 'progress', 'owner']);
        contains(refused('edit_schema', 'tasks.md', { action: 'reorder_fields', order: ['due', 'status'] }), 'every declared field exactly once');
        contains(refused('edit_schema', 'tasks.md', { action: 'reorder_fields', order: ['due', 'due', 'status', 'owner'] }), 'every declared field exactly once');
        contains(refused('edit_schema', 'tasks.md', { action: 'reorder_fields', order: 'due' }), 'list of field names');
    });

    test('edit_schema set_layout switches the layout when the document has what the layout needs', () => {
        contains(schema({ action: 'set_layout', layout: 'calendar' }), 'layout: calendar');
        contains(schema({ action: 'set_layout', layout: 'chart' }), 'layout: chart');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_layout', layout: 'table' }), 'already has layout table');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_layout', layout: 'spreadsheet' }), 'must be one of');
        const noDate = '---\nlayout: list\nfields:\n  s: select(a, b)\n---\n- x\n';
        const lacking = refused('edit_schema', 'l.md', { action: 'set_layout', layout: 'calendar' }, [{ name: 'l.md', text: noDate }]);
        contains(lacking, 'needs a date field');
        contains(lacking, 'add_field');
        contains(refused('edit_schema', 'board.md', { action: 'set_layout', layout: 'timeline' }), 'timeline');
    });

    test('edit_schema set_layout gives an ordinary file its first layout', () => {
        const out = schema({ action: 'set_layout', layout: 'list' }, 'notes.md');
        eq(out, '---\nlayout: list\n---\n\n# Notes\n\nPlain text.\n');
        contains(refused('edit_schema', 'notes.md', { action: 'set_layout', layout: 'calendar' }), 'needs a date field');
        contains(refused('edit_schema', 'notes.md', { action: 'add_field', field: 'x', type: 'text' }), 'ordinary document');
    });

    test('edit_schema set_option validates the value against the document and can remove an option', () => {
        contains(schema({ action: 'set_option', key: 'sort', value: '-due' }), 'sort: -due');
        contains(schema({ action: 'set_option', key: 'add', value: 'top' }), 'add: top');
        ok(!schema({ action: 'set_option', key: 'add', value: '' }).includes('add:'), 'an empty value removes the option');
        contains(schema({ action: 'set_option', key: 'columns', value: 'title, status' }), 'columns: [title, status]');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'sort', value: 'prio' }), 'sort must name a field');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'columns', value: 'title, nope' }), 'columns lists');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'group', value: 'due' }), 'group must name a select field');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'zoom', value: 'decade' }), 'zoom must be one of');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'layout', value: 'board' }), 'not a layout option');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'fields', value: 'x' }), 'not a layout option');
        contains(schema({ action: 'set_option', key: 'group', value: 'status' }, 'board.md', [{ name: 'board.md', text: BOARD.replace('priority: select(high:red, low)', 'priority: select(high:red, low)\n  status: select(a, b)') }]), 'group: status');
    });

    test('edit_schema set_option validates the panels of a chart', () => {
        contains(schema({ action: 'set_option', key: 'charts', value: 'kpi, donut:status, bar:due:month' }), 'charts: [kpi, donut:status, bar:due:month]');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'charts', value: 'kpi, pie' }), 'cannot be read');
        contains(refused('edit_schema', 'tasks.md', { action: 'set_option', key: 'charts', value: 'donut:due' }), 'cannot be read');
    });

    section('Structured documents: verification and batches');

    test('verify_work kind field checks the value of a field of one note', () => {
        const check = (c: object) => verifyWork(JSON.stringify({ checks: [{ file: 'tasks.md', kind: 'field', ...c }] }), files());
        eq(check({ text: 'Fix login', field: 'status', value: 'todo' }).passed, true);
        eq(check({ text: 'Fix login', field: 'status', value: 'TODO' }).passed, true, 'compared in normal form');
        eq(check({ text: 'Fix login', field: 'due', value: '2026-10-25 9:00' }).passed, true);
        eq(check({ text: 'Plan retreat', field: 'due', value: '' }).passed, true, 'no value expected');
        eq(check({ text: 'Plan retreat', field: 'due' }).passed, true);
        const wrong = check({ text: 'Fix login', field: 'status', value: 'done' });
        eq(wrong.passed, false);
        contains(wrong.checks[0].label, 'actual: todo');
        eq(check({ text: 'Fix login', field: 'due', value: '' }).passed, false, 'it has a value');
        eq(check({ text: 'Ship', field: 'status', value: 'done' }).passed, true, 'a piece of the note is enough');
        eq(check({ text: 'i', field: 'status', value: 'done' }).passed, false, 'several notes match');
        eq(check({ text: 'Fix login', field: 'colour', value: 'red' }).passed, false, 'no such field');
        eq(check({ text: 'Zebra', field: 'status', value: 'done' }).passed, false, 'no such note');
        const ordinary = verifyWork(JSON.stringify({ checks: [{ file: 'notes.md', kind: 'field', text: 'Plain', field: 'status', value: 'x' }] }), files());
        eq(ordinary.passed, false);
        eq(verifyWork(JSON.stringify({ checks: [{ file: 'tasks.md', kind: 'field', text: 'Fix login' }] }), files()).checks[0].label, 'Invalid check');
    });

    test('verify_work structure reports invalid values, undeclared fields, and a broken declaration', () => {
        eq(structuredIssues(TABLE).length, 0, 'a good document has no issues');
        eq(structuredIssues(NOTES).length, 0, 'an ordinary document is not checked here');
        const broken = TABLE.replace('[status:: done]', '[status:: finished] [colour:: red]').replace('  owner: person[]', '  owner: wibble');
        const text = structuredIssues(broken).map(i => i.text).join('\n');
        contains(text, '"Ship release": status "finished" is not valid (not one of: todo, doing, done)');
        contains(text, 'the field "colour" is not declared');
        contains(text, 'field declaration: owner: unknown type "wibble"');
        const v = verifyWork(JSON.stringify({ checks: [{ file: 'tasks.md', kind: 'structure' }] }), [{ name: 'tasks.md', text: broken }]);
        eq(v.passed, false);
        const withBaseline = verifyWork(JSON.stringify({ checks: [{ file: 'tasks.md', kind: 'structure' }] }), [{ name: 'tasks.md', text: broken }], () => broken);
        eq(withBaseline.passed, true, 'old problems are left alone');
    });

    test('verify_work kind note: one note, optionally in a group and done or not, in any layout', () => {
        const board = '---\nlayout: board\n---\n\n## Doing\n\n- [ ] Ship it #now [priority:: high]\n\n## Done\n\n- [x] Ship it later\n';
        const list = '---\nlayout: list\n---\n\n- Read the HIG #read\n- [x] Plan trip\n';
        const check = (text: string, file: string, c: object) => verifyWork(JSON.stringify({ checks: [{ file, kind: 'note', ...c }] }), [{ name: file, text }]).passed;
        eq(check(board, 'b.md', { text: 'Ship it', group: 'Doing', done: false }), true, 'the title matches although the card has fields and tags');
        eq(check(board, 'b.md', { text: 'Ship it', group: 'doing' }), true, 'the group is matched ignoring case');
        eq(check(board, 'b.md', { text: 'Ship it', group: 'Done' }), true, 'no exact match in that group, but only one note there contains it');
        eq(check(board, 'b.md', { text: 'Ship it', group: 'Done', done: false }), false);
        eq(check(board, 'b.md', { text: 'Ship it later', group: 'Done', done: true }), true);
        eq(check(board, 'b.md', { text: 'Ship it', group: 'Doing', done: true }), false);
        eq(check(board, 'b.md', { text: 'Ship it #now [priority:: high]', group: 'Doing' }), true, 'the whole text still matches');
        eq(check(board, 'b.md', { text: 'Zebra' }), false);
        eq(check(board, 'b.md', { text: 'ship' }), false, 'two notes contain it');
        eq(check(list, 'l.md', { text: 'Read the HIG', done: false }), true, 'a list item without a checkbox is not done');
        eq(check(list, 'l.md', { text: 'Plan trip', done: true }), true);
        eq(check(NOTES, 'n.md', { text: 'Plain' }), false, 'an ordinary file has no notes');
        const wrong = verifyWork(JSON.stringify({ checks: [{ file: 'b.md', kind: 'note', text: 'Ship it', group: 'Doing', done: true }] }), [{ name: 'b.md', text: board }]);
        contains(wrong.checks[0].label, 'it is not done');
        eq(verifyWork(JSON.stringify({ checks: [{ file: 'b.md', kind: 'kanban', text: 'Ship it' }] }), [{ name: 'b.md', text: board }]).passed, false, 'the old kind is gone');
    });

    test('edit_note and edit_schema work in a batch that depends on an earlier action', () => {
        const batch = planBatch(JSON.stringify({ actions: [
            { tool: 'edit_schema', arguments: JSON.stringify({ name: 'tasks.md', action: 'add_field', field: 'priority', type: 'select(high, low)', reason: 'new field' }) },
            { tool: 'edit_note', arguments: JSON.stringify({ name: 'tasks.md', action: 'update', note: 'Fix login', fields: { priority: 'high' }, reason: 'set it' }) },
        ] }), files());
        eq(batch.error, undefined);
        eq(batch.changes.length, 1, 'one change per file');
        contains(batch.changes[0].after, '  priority: select(high, low)');
        contains(batch.changes[0].after, '[priority:: high]');
        const bad = planBatch(JSON.stringify({ actions: [
            { tool: 'edit_note', arguments: JSON.stringify({ name: 'tasks.md', action: 'update', note: 'Fix login', fields: { priority: 'high' }, reason: 'before the field exists' }) },
            { tool: 'edit_schema', arguments: JSON.stringify({ name: 'tasks.md', action: 'add_field', field: 'priority', type: 'text', reason: 'too late' }) },
        ] }), files());
        contains(bad.error ?? '', 'no field "priority"');
    });

    test('the proposal tools for structured documents are listed, and edit_kanban is gone', () => {
        eq(CHANGE_TOOLS.map(t => t.name).slice(-2), ['edit_note', 'edit_schema']);
        ok(!CHANGE_TOOLS.some(t => t.name === 'edit_kanban'), 'edit_kanban was removed');
        contains(refused('edit_kanban', 'board.md', { action: 'move' }), 'not recognized');
    });

    test('a round trip through edit_note changes nothing outside the note it touched', () => {
        const out = note({ action: 'mark', note: 'Book venue', done: false }, 'board.md');
        eq(touched(BOARD, out), ['- [ ] Book venue']);
    });
}
