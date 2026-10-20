// Tests for agent action capabilities: new edit tools, delete/move files, extra kanban actions, partial approval,
// user notes, Undo (the inverse of a change), Git history tools, and structure verification. Without a GUI and network,
// except one test that runs real git in a temporary folder.

import type { SourceFile } from '../../src/agent/context.js';
import { changeState, invertChange, planChange, preflight, type Change } from '../../src/agent/changes.js';
import { applyBatch, planBatch } from '../../src/agent/batch.js';
import { parseEvents, reconcileEvents, type ActionEvent } from '../../src/agent/journal.js';
import { formatGit, parseGitCall, type GitRequest } from '../../src/agent/gittools.js';
import { verifyWork } from '../../src/agent/verification.js';
import { ChatSession, type ProposalResult, type TurnHandlers } from '../../src/agent/session.js';
import type { ChatRequest, ChatResult, Provider, ToolCall } from '../../src/agent/provider.js';
import { localLinks, newIssues, resolveLink, structureIssues } from '../../src/markdown/lint.js';
import { agentGit, gitLimits, runGit } from '../../src/base/git.js';
import { section, test, eq, ok, contains, within, tmp, disk } from '../core/framework.js';

const NOTES = '---\ntitle: meeting\n---\n# Meeting\n\nRelease November 15.\nNote: November 15 final.\n';
const BOARD = '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Release material\n\n## In Progress\n\n## Done\n\n- [x] Book venue\n';
const base = (): SourceFile[] => [{ name: 'meeting.md', text: NOTES }, { name: 'board.md', text: BOARD }, { name: 'archive/old.md', text: '# Old\n' }];

const planned = (name: string, args: object, files = base()): Change => {
    const r = planChange(name, JSON.stringify({ reason: 'test', ...args }), files);
    if (!r.ok) throw new Error(r.message);
    return r.change;
};
const refused = (name: string, args: object, files = base()): string => {
    const r = planChange(name, JSON.stringify({ reason: 'test', ...args }), files);
    ok(!r.ok, 'should have been rejected');
    return r.ok ? '' : r.message;
};

const call = (name: string, args: unknown, id = name): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const result = (toolCalls: ToolCall[] = []): ChatResult => ({ usage: null, cancelled: false, toolCalls, reasoning: '' });

// A session with an in-memory disk; the provider plays a list of tool calls and then answers. The tool messages that come back are collected.
function harness(steps: ToolCall[][], answer: (changes: Change[]) => ProposalResult = () => ({ applied: true })) {
    const disk = new Map(base().map(f => [f.name, f.text]));
    const files = () => [...disk].map(([name, text]) => ({ name, text }));
    const session = new ChatSession();
    const replies: string[] = [];
    const handlers: TurnHandlers = {
        onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: files,
        onProposal: async c => { const a = answer([c]); if (a.applied) sync(disk, c); return a; },
        onBatchProposal: async changes => {
            const a = answer(changes);
            if (!a.applied) return a;
            const chosen = changes.filter((_, i) => !a.accepted || a.accepted.includes(i));
            const error = applyBatch(chosen, { read: f => disk.get(f) ?? null, write: c => sync(disk, c), rollback: () => {} });
            return error ? { applied: false, error } : a;
        },
    };
    let n = 0;
    const provider: Provider = { chat: async (req: ChatRequest) => {
        for (const m of req.messages) if (m.role === 'tool' && !replies.includes(m.content)) replies.push(m.content);
        if (n < steps.length) return result(steps[n++]);
        req.onText('Done.'); return result();
    } };
    const input = () => ({ question: 'Do it', active: null, selection: '', files: files(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 });
    return { disk, session, handlers, replies, run: () => within(session.ask(input(), provider, 'fake', handlers)) };
}
function sync(disk: Map<string, string>, c: Change): void {
    if (c.kind === 'delete') disk.delete(c.file);
    else if (c.kind === 'move') { disk.delete(c.file); disk.set(c.to!, c.after); }
    else disk.set(c.file, c.after);
}

export async function agentActionTests(): Promise<void> {
    section('Agent: edit and file tools');

    await test('edit_file all=true replaces every occurrence; without it a non-unique one is still rejected', async () => {
        eq(planned('edit_file', { name: 'meeting', old_text: 'November 15', new_text: 'November 22', all: true }).after, NOTES.replaceAll('November 15', 'November 22'));
        contains(refused('edit_file', { name: 'meeting', old_text: 'November 15', new_text: 'November 22' }), 'all=true');
    });

    await test('insert_text: start after the frontmatter, end, and after a line with the line_text safeguard', async () => {
        eq(planned('insert_text', { name: 'meeting', position: 'start', text: '> Summary' }).after, NOTES.replace('---\n# Meeting', '---\n> Summary\n# Meeting'));
        eq(planned('insert_text', { name: 'meeting', position: 'end', text: '- Follow-up\n' }).after, `${NOTES}- Follow-up\n`);
        eq(planned('insert_text', { name: 'meeting', position: 'after_line', line: 6, line_text: 'Release November 15.', text: 'Approved by all.' }).after,
            NOTES.replace('Release November 15.\n', 'Release November 15.\nApproved by all.\n'));
        contains(refused('insert_text', { name: 'meeting', position: 'after_line', line: 5, line_text: 'Release November 15.', text: 'x' }), 'is on line 6');
        contains(refused('insert_text', { name: 'meeting', position: 'after_line', line: 99, line_text: 'x', text: 'x' }), 'The "line" argument must');
        contains(refused('insert_text', { name: 'meeting', position: 'after_line', line: 6, text: 'x' }), 'line_text');
        contains(refused('insert_text', { name: 'meeting', position: 'middle', text: 'x' }), 'position');
        // A file without a newline at the end: only an insertion at the end adds one.
        const bare = [{ name: 'a.md', text: 'one\ntwo' }];
        eq(planned('insert_text', { name: 'a', position: 'end', text: 'three' }, bare).after, 'one\ntwo\nthree\n');
        eq(planned('insert_text', { name: 'a', position: 'start', text: 'zero' }, bare).after, 'zero\none\ntwo');
        eq(planned('insert_text', { name: 'a', position: 'end', text: 'content' }, [{ name: 'a.md', text: '' }]).after, 'content\n');
    });

    await test('delete_file and move_file: the proposal shape, a safe destination name, a taken destination is rejected', async () => {
        const del = planned('delete_file', { name: 'archive/old' });
        eq([del.kind, del.file, del.before, del.after], ['delete', 'archive/old.md', '# Old\n', '']);
        const move = planned('move_file', { name: 'meeting', destination: 'archive/meeting-oct' });
        eq([move.kind, move.file, move.to, move.after], ['move', 'meeting.md', 'archive/meeting-oct.md', NOTES]);
        contains(refused('move_file', { name: 'meeting', destination: '../outside' }), 'not valid');
        contains(refused('move_file', { name: 'meeting', destination: 'BOARD.md' }), 'already exists');
        contains(refused('move_file', { name: 'meeting', destination: 'meeting.md' }), 'same');
        contains(refused('delete_file', { name: 'nonexistent' }), 'was not found');
    });

    await test('edit_note on a board: change a card title, delete a card, and manage groups; a group containing cards cannot be deleted', async () => {
        const note = (args: object) => planned('edit_note', { name: 'board', ...args }).after;
        contains(note({ action: 'update', note: 'Release', title: 'Release material v2', tags: ['important'] }), '- [ ] Release material v2 #important');
        ok(!note({ action: 'delete', note: 'Book venue' }).includes('Book venue'), 'the card was not deleted');
        contains(note({ action: 'add_group', group: 'Postponed' }), '## Postponed');
        contains(note({ action: 'rename_group', group: 'In Progress', title: 'Running' }), '## Running');
        ok(!note({ action: 'delete_group', group: 'In Progress' }).includes('## In Progress'), 'the empty group was not deleted');
        contains(refused('edit_note', { name: 'board', action: 'delete_group', group: 'Plan' }), 'still contains 1 notes');
        contains(refused('edit_note', { name: 'board', action: 'add_group', group: 'done' }), 'already exists');
        contains(refused('edit_note', { name: 'board', action: 'rename_group', group: 'Done', title: 'plan' }), 'already exists');
        contains(refused('edit_note', { name: 'board', action: 'rename_group', group: 'Done' }), '"title" argument');
        contains(refused('edit_note', { name: 'board', action: 'update', note: 'Release' }), 'Give "title"');
    });

    await test('the inverse of a change and the state check for each kind', async () => {
        const read = (files: Map<string, string>) => (f: string) => files.get(f) ?? null;
        const kinds: Change[] = [
            { kind: 'create', file: 'new.md', before: '', after: 'content\n', reason: 'r' },
            { kind: 'edit', file: 'a.md', before: 'old\n', after: 'new\n', reason: 'r' },
            { kind: 'delete', file: 'a.md', before: 'old\n', after: '', reason: 'r' },
            { kind: 'move', file: 'a.md', to: 'b/a.md', before: 'old\n', after: 'old\n', reason: 'r' },
        ];
        for (const c of kinds) {
            const disk = new Map(c.kind === 'create' ? [] : [['a.md', 'old\n']]);
            eq(changeState(c, read(disk)), 'before', `${c.kind} before`);
            eq(preflight(c, read(disk)), null, `${c.kind} preflight`);
            sync(disk, c);
            eq(changeState(c, read(disk)), 'after', `${c.kind} after`);
            const back = invertChange(c);
            eq(preflight(back, read(disk)), null, `${c.kind} undo preflight`);
            sync(disk, back);
            eq([...disk], c.kind === 'create' ? [] : [['a.md', 'old\n']], `${c.kind} restored`);
        }
        contains(preflight(kinds[3], f => f === 'a.md' ? 'old\n' : 'present') ?? '', 'b/a.md already exists');
        contains(preflight(kinds[1], () => 'edited by the user') ?? '', 'changed since it was proposed');
    });

    await test('batch: a deleted/moved file must not be touched by another action; delete and move can be batched', async () => {
        const act = (tool: string, args: object) => ({ tool, arguments: JSON.stringify({ reason: 'x', ...args }) });
        const blocked = planBatch(JSON.stringify({ actions: [act('edit_file', { name: 'meeting', old_text: 'Release', new_text: 'Launch' }), act('move_file', { name: 'meeting', destination: 'archive/meeting' })] }), base());
        contains(blocked.error ?? '', 'deleted or moved');
        const after = planBatch(JSON.stringify({ actions: [act('move_file', { name: 'meeting', destination: 'archive/meeting' }), act('edit_file', { name: 'archive/meeting', old_text: 'Release', new_text: 'x' })] }), base());
        contains(after.error ?? '', 'deleted or moved');
        const ok2 = planBatch(JSON.stringify({ actions: [act('move_file', { name: 'meeting', destination: 'archive/meeting' }), act('delete_file', { name: 'archive/old' })] }), base());
        eq(ok2.changes.map(c => c.kind), ['move', 'delete']);
        const disk = new Map(base().map(f => [f.name, f.text]));
        eq(applyBatch(ok2.changes, { read: f => disk.get(f) ?? null, write: c => sync(disk, c), rollback: () => {} }), null);
        eq([...disk.keys()].sort(), ['archive/meeting.md', 'board.md']);
    });

    await test('journal: move/delete are validated, recovered after an interruption, and the undone status is accepted', async () => {
        const move: Change = { kind: 'move', file: 'a.md', to: 'b.md', before: 'x', after: 'x', reason: 'r' };
        const ev = (changes: Change[], status: ActionEvent['status'] = 'proposed'): ActionEvent => ({ id: '1', question: 'q', tool: 'move_file', status, changes, summary: '', time: 't' });
        eq(parseEvents([ev([move]), ev([{ ...move, to: '../outside.md' }]), ev([{ ...move, to: undefined }]), ev([move], 'reverted')]).length, 2);
        const events = [ev([move]), ev([{ kind: 'delete', file: 'c.md', before: 'y', after: '', reason: 'r' }])];
        reconcileEvents(events, [{ name: 'b.md', text: 'x' }]);
        eq(events.map(e => e.status), ['applied', 'applied']);
        const pending = [ev([move])];
        reconcileEvents(pending, [{ name: 'a.md', text: 'x' }]);
        eq(pending[0].status, 'interrupted');
    });

    section('Agent: structure verification');

    await test('structure: tables, skipped/empty headings, an unclosed code block; code contents and frontmatter are ignored', async () => {
        const text = '---\ntitle: x\n---\n# A\n### Jump\n##\n\n| a | b |\n| - | - |\n| 1 |\n| 1 | 2 |\n\n```\n# not a heading\n| x |\n';
        const issues = structureIssues(text).map(i => i.text);
        ok(issues.some(t => t.includes('jumps from H1 to H3')), issues.join('\n'));
        ok(issues.some(t => t.includes('empty heading')), issues.join('\n'));
        ok(issues.some(t => t.includes('1 cells, header has 2 columns')), issues.join('\n'));
        ok(issues.some(t => t.includes('is not closed')), issues.join('\n'));
        eq(issues.length, 4, issues.join('\n'));
        eq(structureIssues('## Start from H2\n### Down one\n').length, 0);
    });

    await test('local links: taken outside code, URLs and anchors skipped, relative paths resolved', async () => {
        const links = localLinks('[a](../b.md#x) ![g](image.png) [web](https://x.id) [j](#top) `[k](code.md)` [s](<with%20space.md>)');
        eq(links.map(l => l.target), ['../b.md', 'image.png', 'with space.md']);
        eq(resolveLink('chapter/one.md', '../b.md'), 'b.md');
        eq(resolveLink('one.md', '../b.md'), null);
        eq(newIssues([{ line: 1, key: 'x', text: '' }], [{ line: 9, key: 'x', text: '' }, { line: 10, key: 'x', text: 'new' }]).map(i => i.text), ['new']);
    });

    await test('verifyWork: "*" looks for leftover text in the whole folder; structure only fails new problems', async () => {
        const files = [{ name: 'a.md', text: 'Release November 22\n' }, { name: 'b.md', text: 'still November 15\n[to c](c.md)\n' }];
        const v = verifyWork(JSON.stringify({ checks: [{ file: '*', kind: 'absent', text: 'November 15' }, { file: '*', kind: 'present', text: 'November 22' }] }), files);
        eq(v.checks.map(c => c.passed), [false, true]);
        contains(v.checks[0].label, 'b.md:1');
        const broken = '| a | b |\n| - | - |\n| 1 |\n';
        const struct = (baseline: string | null) => verifyWork(JSON.stringify({ checks: [{ file: 'b.md', kind: 'structure' }] }), [{ name: 'b.md', text: `${broken}[to c](c.md)\n` }], () => baseline).checks[0];
        eq(struct(null).passed, false);
        contains(struct(null).label, 'the link to "c.md"');
        eq(struct(`${broken}[to c](c.md)\n`).passed, true);
        contains(struct(`${broken}[to c](c.md)\n`).label, '2 old problems');
        eq(struct('[to c](c.md)\n').passed, false);
        eq(verifyWork(JSON.stringify({ checks: [{ file: 'a.md', kind: 'present' }] }), files).checks[0].label, 'Invalid check');
    });

    section('Agent: partial approval, notes, and automatic verification');

    const act = (tool: string, args: object) => ({ tool, arguments: JSON.stringify({ reason: 'x', ...args }) });
    const pack = call('propose_batch', { actions: [
        act('edit_file', { name: 'meeting', old_text: 'November 15', new_text: 'November 22', all: true }),
        act('edit_note', { name: 'board', action: 'move', note: 'Release', group: 'In Progress' }),
        act('delete_file', { name: 'archive/old' }),
    ] });

    await test('a batch applied partly: only the chosen files change, the journal records two decisions, the model is told', async () => {
        const h = harness([[pack]], () => ({ applied: true, accepted: [0, 2], note: 'I will arrange the board myself' }));
        const r = await h.run();
        eq(r.applied, 2);
        contains(h.disk.get('meeting.md')!, 'November 22');
        eq(h.disk.get('board.md'), BOARD);
        eq(h.disk.has('archive/old.md'), false);
        eq(h.session.events.map(e => [e.status, e.changes.map(c => c.file)]), [['applied', ['meeting.md', 'archive/old.md']], ['rejected', ['board.md']]]);
        const reply = h.replies.find(m => m.includes('only part'))!;
        contains(reply, 'Rejected (do not repeat without asking): board.md');
        contains(reply, 'User note: I will arrange the board myself');
    });

    await test('a single proposal rejected with a note: the note reaches the model', async () => {
        const h = harness([[call('edit_file', { name: 'meeting', old_text: 'Release November 15', new_text: 'Release November 16', reason: 'x' })]], () => ({ applied: false, note: 'The date is 22, not 16' }));
        await h.run();
        ok(h.replies.some(m => m.includes('User note: The date is 22, not 16')), h.replies.join('\n'));
    });

    await test('automatic verification: a deleted file is checked as absent, the structure of a changed file is checked too', async () => {
        const breakTable = call('insert_text', { name: 'meeting', position: 'end', text: '| a | b |\n| - | - |\n| 1 |', reason: 'x' }, 's1');
        const del = call('delete_file', { name: 'archive/old', reason: 'x' }, 'h1');
        const verify = call('verify_work', { checks: [{ file: 'meeting.md', kind: 'present', text: '| a | b |' }] });
        const h = harness([[call('set_work', { goal: 'g', steps: [{ text: 'a', status: 'done' }], note: '' })], [breakTable], [del], [verify]]);
        await h.run();
        const checks = h.session.work!.verification!.checks;
        ok(checks.some(c => c.file === 'archive/old.md' && c.passed && c.label.includes('deleted')), JSON.stringify(checks));
        ok(checks.some(c => c.file === 'meeting.md' && !c.passed && c.label.includes('1 cells, header has 2 columns')), JSON.stringify(checks));
        eq(h.session.work!.status, 'paused');
    });

    section('Agent: Git history tools');

    await test('parseGitCall validates the commit and file; formatGit tidies the log, diff, and file contents', async () => {
        eq(parseGitCall('git_log', '{}'), { kind: 'log', file: null, limit: 15 });
        eq(parseGitCall('git_log', '{"file":"plan.md","max":500}'), { kind: 'log', file: 'plan.md', limit: 50 });
        for (const bad of ['--output=/tmp/x', 'main', 'abc', 'HEAD;rm']) contains(parseGitCall('show_commit', JSON.stringify({ commit: bad })) as string, 'not valid');
        contains(parseGitCall('file_at_commit', '{"commit":"HEAD~2","file":"../x.md"}') as string, 'not valid');
        contains(parseGitCall('file_at_commit', '{"commit":"HEAD"}') as string, 'required');
        const log = formatGit({ kind: 'log', file: null, limit: 5 }, { ok: true, text: '\x1ea1b2c3d\x1f2026-10-01 10:00\x1fEka\x1fPostpone release\n\nM\tplan.md\nR100\told.md\tarchive/old.md\n' });
        eq(log.content, 'a1b2c3d 2026-10-01 10:00 · Eka · Postpone release\n  edit plan.md\n  move old.md → archive/old.md');
        eq(log.summary, '1 commit');
        eq(formatGit({ kind: 'show', commit: 'HEAD', file: null }, { ok: true, text: 'a1b2 2026 · Eka · x\n' }).summary, 'no changes');
        eq(formatGit({ kind: 'file', commit: 'HEAD', file: 'a.md' }, { ok: true, text: 'one\ntwo\n' }).content, '[a.md at HEAD, 2 lines]\n1│ one\n2│ two');
        eq(formatGit({ kind: 'log', file: null, limit: 1 }, { ok: false, message: 'fatal: not a git repository' }).content, 'The work folder is not a Git repository.');
    });

    await test('session: Git tools are only offered when there is a handler; the result goes back to the model', async () => {
        const asked: GitRequest[] = [];
        const h = harness([[call('git_log', { file: 'meeting.md' })]]);
        let tools: string[] = [];
        h.handlers.git = async request => { asked.push(request); return { ok: true, text: '\x1ea1b2c3d\x1f2026-10-01 10:00\x1fEka\x1fPostpone release\n\nM\tmeeting.md\n' }; };
        const provider: Provider = { chat: async req => { tools = req.tools?.map(t => t.name) ?? tools; return result(); } };
        await within(h.session.ask({ question: 'q', active: null, selection: '', files: base(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 }, provider, 'fake', h.handlers));
        ok(tools.includes('git_log') && tools.includes('file_at_commit'), tools.join(','));
        await h.run();
        eq(asked, [{ kind: 'log', file: 'meeting.md', limit: 15 }]);
        ok(h.replies.some(m => m.includes('Postpone release')), h.replies.join('\n'));
        delete h.handlers.git;
        await within(h.session.ask({ question: 'q', active: null, selection: '', files: base(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 }, provider, 'fake', h.handlers));
        ok(!tools.includes('git_log'), 'Git tool offered without a handler');
    });

    await test('agentGit in a real repository: log, diff, and file contents are limited to non-hidden Markdown', async () => {
        const root = disk.join(tmp, 'git-agent');
        disk.mkdirs(disk.join(root, '.secret'));
        const write = (name: string, text: string) => disk.write(disk.join(root, name), text);
        const git = async (...args: string[]) => {
            const run = await within(runGit(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args]));
            ok(run?.status === 0, `git ${args.join(' ')} failed`);
        };
        await git('init', '-q');
        write('plan.md', 'Release November 15\n'); write('.secret/x.md', 'secret\n'); write('code.txt', 'x\n');
        await git('add', '-A'); await git('commit', '-qm', 'Initial');
        write('plan.md', 'Release November 22\n'); write('.secret/x.md', 'secret 2\n');
        await git('commit', '-qam', 'Postpone release');
        const log = formatGit({ kind: 'log', file: null, limit: 10 }, await within(agentGit(root, { kind: 'log', file: null, limit: 10 })));
        contains(log.content, 'Postpone release');
        contains(log.content, 'edit plan.md');
        ok(!log.content.includes('secret') && !log.content.includes('code.txt'), log.content);
        const show = formatGit({ kind: 'show', commit: 'HEAD', file: null }, await within(agentGit(root, { kind: 'show', commit: 'HEAD', file: null })));
        contains(show.content, '+Release November 22');
        ok(!show.content.includes('secret'), show.content);
        const old = formatGit({ kind: 'file', commit: 'HEAD~1', file: 'plan.md' }, await within(agentGit(root, { kind: 'file', commit: 'HEAD~1', file: 'plan.md' })));
        contains(old.content, '1│ Release November 15');
    });

    await test('runGit: a git that hangs ends as a failure instead of waiting forever', async () => {
        const limits = { ...gitLimits };
        try {
            gitLimits.runMs = 500;
            const started = Date.now();
            const hung = await within(runGit(tmp, ['-c', 'alias.wait=!sleep 3', 'wait']));
            eq(hung?.status, -1, 'a hanging git is stopped');
            contains(hung?.err ?? '', 'did not finish');
            ok(Date.now() - started < 2500, `stopped after ${Date.now() - started} ms`);
            eq((await within(runGit(tmp, ['--version'])))?.status, 0, 'a normal run still answers');
        } finally {
            Object.assign(gitLimits, limits);
        }
    });
}
