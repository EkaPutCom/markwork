// GUI tests: kanban cards worked on by an external harness (a fake pi that is a shell script speaking RPC, run
// for real as a process) in a separate project folder. It does not call the real pi or any API.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { readTextFile } from '../../src/files.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { findEntry } from '../../src/ui/menu.js';
import { findDialog, harnessAskDialog } from '../../src/ui/dialogs.js';
import { descendants, whenDialogReady, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, contains, tmp, optVal, settle } from '../framework.js';
import type { HarnessAsk, HarnessReply } from '../../src/agent/harness.js';
import type { GuiContext } from './context.js';

const BOARD = `---
layout: board
project: shop
---

## Plan

- [ ] Checkout with QRIS [agent:: pi] #feature
  Use the official SDK.
- [ ] Test the cart
- [ ] Tidy up README [agent:: pi]

## In Progress

## Review

## Done
`;

// A fake pi that speaks RPC over stdin/stdout. MODE is read on every run: ok (fast), slow
// (waits for the release file), fail, hang, permission (extension confirmation dialog), or ask (a question at the end of the turn).
// When finished it waits for stdin to close, like the real pi; lines that still arrive are recorded in "rest".
const fakePi = (dir: string) => `#!/bin/sh
mode=$(cat "${dir}/mode")
printf '%s\\n' "$*" >> "${dir}/args"
printf '%s\\n' "$PWD" >> "${dir}/cwd"
printf 'start %s\\n' "$4" >> "${dir}/order"
read -r cmd
echo '{"id":"markwork-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"test-session"}}'
read -r cmd
printf '%s' "$cmd" > "${dir}/prompt"
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
echo '{"type":"turn_start"}'
echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"checkout.ts"}}'
case "$mode" in
  slow) while [ ! -e "${dir}/release" ]; do sleep 0.05; done ;;
  hang) sleep 30 ;;
  permission) echo  '{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"Allow the bash command?","message":"rm -rf build"}'
        read -r ans; printf '%s\\n' "$ans" >> "${dir}/answer" ;;
esac
echo '{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
if [ "$mode" = fail ]; then echo "No API key found for deepseek" >&2; exit 1; fi
if [ "$mode" = ask ]; then
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I checked.\\n\\nShould I use SDK A or B?"}],"stopReason":"stop"}}'
  echo '{"type":"agent_settled"}'
  read -r ans || { printf 'finish %s\\n' "$4" >> "${dir}/order"; exit 0; }
  printf '%s\\n' "$ans" >> "${dir}/answer"
fi
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"QRIS checkout added in checkout.ts"}],"stopReason":"stop","usage":{"totalTokens":120,"cost":{"total":0.002}}}}'
echo '{"type":"agent_settled"}'
printf 'finish %s\\n' "$4" >> "${dir}/order"
while read -r x; do printf '%s\\n' "$x" >> "${dir}/rest"; done
`;

export function harnessTests(c: GuiContext): void {
    const { w, pump } = c;
    section('External harness (board)');

    const kb = w.board;
    const dir = GLib.dir_make_tmp('markwork-pi-XXXXXX');           // control files of the fake pi
    const project = GLib.dir_make_tmp('markwork-shop-XXXXXX');     // the project "repo", outside the work folder
    const script = GLib.build_filenamev([dir, 'pi']);
    GLib.file_set_contents(script, fakePi(dir));
    GLib.spawn_command_line_sync(`chmod +x ${script}`);
    const mode = (m: string) => GLib.file_set_contents(GLib.build_filenamev([dir, 'mode']), m);
    const read = (name: string) => { try { return readTextFile(GLib.build_filenamev([dir, name])); } catch { return ''; } };
    const board = GLib.build_filenamev([tmp, 'harness-board.md']);
    const savedProjects = w.settings.projects;
    const savedProgram = w.harness.orchestrator.program;
    const savedDialogs = w.harness.dialogs;
    w.harness.orchestrator.program = () => script;
    const chosen: string[] = [];
    let pick: string | null = null;
    let answers: (HarnessReply | null)[] = [];
    let texts: (string | null)[] = [];
    const asked: HarnessAsk[] = [];
    w.harness.dialogs = {
        chooseFolder: title => { chosen.push(title); return pick; },
        answer: ask => { asked.push(ask); return answers.shift() ?? null; },
        text: () => texts.shift() ?? null,
        remoteFolder: () => null,
        closeAgents: () => 'stop',
    };

    const waitFor = (cond: () => boolean, ms = 5000) => {
        for (let i = 0; i < ms / 10 && !cond(); i++) { pump(); GLib.usleep(10000); }
        pump();
        return cond();
    };
    const open = () => {
        GLib.file_set_contents(board, BOARD);
        for (const f of ['cwd', 'order', 'prompt', 'release', 'args', 'answer', 'rest']) GLib.unlink(GLib.build_filenamev([dir, f]));
        w.load(board);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(5000); }
    };
    const titles = (col: number) => kb.getBoard().columns[col].cards.map(card => card.text);
    const at = (text: string) => {
        const b = kb.getBoard();
        for (let column = 0; column < b.columns.length; column++) {
            const index = b.columns[column].cards.findIndex(card => card.text.startsWith(text));
            if (index >= 0) return { column, index };
        }
        throw new Error(`card "${text}" does not exist`);
    };
    const menu = (text: string, label: string) => {
        const { column, index } = at(text);
        const entry = findEntry(kb.cardMenu(column, index), label);
        if (!entry) throw new Error(`menu "${label}" does not exist for card "${text}"`);
        return entry;
    };
    const run = (text: string) => menu(text, 'Work on it with pi').run!();
    const badge = (text: string) => {
        kb.render();
        const { column, index } = at(text);
        const label = descendants(kb.columns[column].cards[index]).find(x => x.has_css_class('kanban-agent')) as Gtk.Label | undefined;
        return label?.label ?? '';
    };
    const runOf = (text: string) => w.harness.orchestrator.queue.find(board, kb.getBoard().columns[at(text).column].cards[at(text).index].text);

    test('an [agent:: pi] card runs in the project folder, moves to In Progress and then Review with a result note', () => {
        w.settings.projects = { shop: project };
        mode('slow');
        open();
        contains(badge('Checkout'), 'pi');
        run('Checkout');
        ok(waitFor(() => read('order').includes('start')), 'the fake pi did not run');
        eq(titles(1), ['Checkout with QRIS [agent:: pi] #feature'], 'moved to In Progress on start');
        contains(badge('Checkout'), 'working');
        eq(read('cwd').trim(), project, 'cwd = project folder');
        contains(read('prompt'), '# Checkout with QRIS');
        contains(read('prompt'), 'Use the official SDK.');
        eq(findEntry(kb.cardMenu(1, 0), 'Work on it with pi')?.enabled, false, 'cannot be run twice');
        GLib.file_set_contents(GLib.build_filenamev([dir, 'release']), '');
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        eq(titles(2), ['Checkout with QRIS [agent:: pi] #feature'], 'moved to Review when done');
        const card = kb.getBoard().columns[2].cards[0];
        ok(card.notes[card.notes.length - 1].startsWith('↳ pi done'), `notes: ${card.notes.join(' | ')}`);
        contains(card.notes[card.notes.length - 1], 'QRIS checkout added');
        contains(badge('Checkout'), 'done');
        eq(parseBoard(c.text()).columns[2].cards[0].text, card.text, 'the board change reached the document text');
    });

    test('the pi log contains the session, tools, and cost', () => {
        const r = runOf('Checkout')!;
        const viewer = w.harnessLogs.show(r.id)!;
        pump();
        ok(viewer.window.title?.includes('pi Log'), `title: ${viewer.window.title}`);
        const text = r.trace.text();
        contains(text, 'pi --session test-session');
        contains(text, 'edit');
        contains(text, '$0.0020');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(viewer.window)?.savev(`${shot}-log.png`, 'png', [], []);
        }
        viewer.window.destroy();
        pump();
    });

    test('a second card in the same project waits its turn', () => {
        mode('slow');
        open();
        run('Checkout');
        run('Tidy up');
        ok(waitFor(() => read('order').includes('start')), 'the first pi did not run');
        eq(runOf('Tidy up')?.status, 'queued');
        contains(badge('Tidy up'), 'queued');
        eq(titles(0).filter(t => t.startsWith('Tidy up')).length, 1, 'the queued card stays in Plan');
        ok(menu('Tidy up', 'Cancel Queue'), 'the cancel-queue menu');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-board.png`, 'png', [], []);
            w.setOption('dark', true);
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-board-dark.png`, 'png', [], []);
            w.setOption('dark', false);
        }
        GLib.file_set_contents(GLib.build_filenamev([dir, 'release']), '');
        ok(waitFor(() => runOf('Tidy up')?.status === 'done'), `second status: ${runOf('Tidy up')?.status}`);
        eq(read('order').trim().split('\n').map(l => l.split(' ')[0]), ['start', 'finish', 'start', 'finish'], 'did not run at the same time');
        eq(titles(2).map(t => t.split(' ')[0]), ['Checkout', 'Tidy']);
    });

    test('stop and failure: the card stays in In Progress, a failure gets a note', () => {
        mode('hang');
        open();
        run('Checkout');
        ok(waitFor(() => read('order').includes('start')), 'pi did not run');
        menu('Checkout', 'Stop pi').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'stopped'), `status: ${runOf('Checkout')?.status}`);
        eq(titles(1), ['Checkout with QRIS [agent:: pi] #feature']);
        eq(kb.getBoard().columns[1].cards[0].notes, ['Use the official SDK.'], 'stopping adds no note');

        mode('fail');
        run('Tidy up');
        ok(waitFor(() => runOf('Tidy up')?.status === 'failed'), `status: ${runOf('Tidy up')?.status}`);
        const card = kb.getBoard().columns[1].cards.find(x => x.text.startsWith('Tidy up'))!;
        ok(card, 'the failed card stays in In Progress');
        contains(card.notes.join('\n'), '↳ pi failed');
        contains(card.notes.join('\n'), 'No API key found');
        contains(badge('Tidy up'), 'failed');
    });

    test('a card without a project: the folder is asked for, mapped, and recorded as a tag', () => {
        mode('ok');
        open();
        w.settings.projects = {};
        const other = GLib.dir_make_tmp('markwork-other-XXXXXX');
        // A board without project frontmatter.
        GLib.file_set_contents(board, BOARD.replace('project: shop\n', ''));
        w.load(board);
        pump();
        pick = null;
        run('Test the cart');
        eq(chosen.pop(), 'Choose a project folder');
        eq(w.harness.orchestrator.queue.runs.filter(r => r.board === board && r.card.startsWith('Test')).length, 0, 'cancelling the choice = not run');
        pick = other;
        run('Test the cart');
        const name = GLib.path_get_basename(other);
        eq(w.settings.projects[name], other, 'the mapping is saved');
        ok(waitFor(() => runOf('Test the cart')?.status === 'done'), `status: ${runOf('Test the cart')?.status}`);
        eq(titles(2), [`Test the cart #project/${name} [agent:: pi]`], 'the project tag and the assignment were added');
        eq(read('cwd').trim().split('\n').pop(), other);
    });

    test('a board that is not open is still updated on disk', () => {
        mode('slow');
        w.settings.projects = { shop: project };
        open();
        run('Checkout');
        ok(waitFor(() => read('order').includes('start')), 'pi did not run');
        ok(w.save(), 'the board was not saved');
        // Replace the active tab's contents with another file (not closing the tab: c.ed belongs to the first tab and is used by other tests).
        const other =  GLib.build_filenamev([tmp, 'not-a-board.md']);
        GLib.file_set_contents(other,  '# Other\n');
        w.load(other);
        pump();
        ok(w.file !== board && !w.boardMode, 'the board is still open');
        GLib.file_set_contents(GLib.build_filenamev([dir, 'release']), '');
        ok(waitFor(() => w.harness.orchestrator.queue.runs.every(r => r.status !== 'working')), 'the run did not finish');
        const disk = parseBoard(readTextFile(board));
        eq(disk.columns[2].cards.map(x => x.text), ['Checkout with QRIS [agent:: pi] #feature'], 'Review on disk');
        ok(disk.columns[2].cards[0].notes.some(n => n.startsWith('↳ pi done')), 'the result note on disk');
        w.load(board);
        pump();
    });

    test('pi asks for permission: the card waits, is answered from Markwork, then pi continues', () => {
        mode('permission');
        w.settings.projects = { shop: project };
        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'waiting'), `status: ${runOf('Checkout')?.status}`);
        contains(badge('Checkout'), 'waiting for an answer');
        eq(titles(1), ['Checkout with QRIS [agent:: pi] #feature'], 'the card waits in In Progress');
        eq(runOf('Checkout')?.ask?.kind, 'confirm');
        eq(findEntry(kb.cardMenu(1, 0), 'Work on it with pi')?.enabled, false, 'cannot be run twice while waiting');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-waiting.png`, 'png', [], []);
            // The real answer dialog (modal): captured from a timer while shown, then closed ("Later").
            const capture = (ask: HarnessAsk, name: string) => {
                whenDialogReady(() => findDialog('Answer pi'), dialog => {
                    widgetPixbuf(dialog)?.savev(`${shot}-${name}.png`, 'png', [], []);
                    dialog.close();
                });
                settle(harnessAskDialog(w.win, ask, 'pi'));
            };
            capture(runOf('Checkout')!.ask!, 'answer-permission');
            capture({ kind: 'question', id: null, title: 'pi asks', message: 'I checked the project structure.\n\nQRIS checkout can use the official SDK (more complete) or the API directly (lighter). Which one do you want?', options: [], prefill: '', timeout: null }, 'answer-question');
        }
        answers = [null];
        menu('Checkout', 'Answer pi…').run!();
        eq(asked.pop()?.message, 'rm -rf build', 'the dialog shows the command');
        eq(runOf('Checkout')?.status, 'waiting', '"Later" leaves pi waiting');
        answers = [{ confirmed: true }];
        menu('Checkout', 'Answer pi…').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        const reply = JSON.parse(read('answer').trim());
        eq(reply, { type: 'extension_ui_response', id: 'ui-1', confirmed: true });
        eq(titles(2), ['Checkout with QRIS [agent:: pi] #feature'], 'to Review after finishing');
        const log = runOf('Checkout')!.trace.text();
        contains(log, 'pi is waiting: Allow the bash command?');
        contains(log, 'Answer: allowed');
    });

    test('pi asks at the end of the turn: answered and continued, or ended without replying', () => {
        mode('ask');
        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'waiting'), `status: ${runOf('Checkout')?.status}`);
        const ask = runOf('Checkout')!.ask!;
        eq([ask.kind, ask.message], ['question', 'I checked.\n\nShould I use SDK A or B?']);
        answers = [{ value: 'Use SDK A' }];
        menu('Checkout', 'Answer pi…').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        const sent = JSON.parse(read('answer').trim());
        eq([sent.type, sent.message], ['prompt', 'Use SDK A']);
        contains(kb.getBoard().columns[2].cards[0].notes.join('\n'), 'QRIS checkout added');
        contains(runOf('Checkout')!.trace.text(), 'Your answer');

        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'waiting'), 'not waiting');
        answers = [{ cancelled: true }];
        menu('Checkout', 'Answer pi…').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        eq(read('answer'), '', 'no answer was sent');
        contains(kb.getBoard().columns[2].cards[0].notes.join('\n'), '↳ pi done');
    });

    test('steering while working and a reply after finishing continue the same session', () => {
        mode('slow');
        open();
        run('Checkout');
        ok(waitFor(() => read('order').includes('start')), 'pi did not run');
        texts = ['Use SDK version 2'];
        menu('Checkout', 'Steer pi…').run!();
        GLib.file_set_contents(GLib.build_filenamev([dir, 'release']), '');
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        const steer = JSON.parse(read('rest').trim().split('\n')[0]);
        eq([steer.type, steer.message], ['steer', 'Use SDK version 2']);

        mode('ok');
        const first = runOf('Checkout')!;
        texts = ['Also add the tests'];
        menu('Checkout', 'Reply to pi…').run!();
        ok(waitFor(() => runOf('Checkout') !== first && runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        contains(read('args').trim().split('\n').pop()!, '--session test-session');
        eq(JSON.parse(read('prompt')).message, 'Also add the tests');
        eq(runOf('Checkout')!.trace, first.trace, 'the same log was continued');
        contains(first.trace.text(), 'Your reply');
        eq(titles(2), ['Checkout with QRIS [agent:: pi] #feature'], 'back to Review');
        eq(kb.getBoard().columns[2].cards[0].notes.filter(n => n.startsWith('↳ pi done')).length, 2, 'one note per run');
    });

    test('[[note]] on a card: the note contents go into the pi prompt, the link can be clicked without opening the edit dialog', () => {
        const folder = GLib.build_filenamev([tmp, 'board-wiki']);
        GLib.mkdir_with_parents(GLib.build_filenamev([folder, 'specs']), 0o755);
        GLib.file_set_contents(GLib.build_filenamev([folder, 'specs', 'Spec.md']), '# Spec\n\n## Colors\n\nThe pay button is green #1a7f37.\n\n## Other\n\nOther secret.\n');
        GLib.file_set_contents(GLib.build_filenamev([folder, 'Meeting Notes.md']), 'The client asked for dynamic QRIS.\n');
        const board = GLib.build_filenamev([folder, 'board.md']);
        GLib.file_set_contents(board, BOARD.replace('- [ ] Checkout with QRIS [agent:: pi] #feature\n  Use the official SDK.',
            '- [ ] Checkout with QRIS [[Spec#Colors]] [agent:: pi] #feature\n  Use the official SDK, see [[meeting notes]] and [[Missing]].'));
        for (const f of ['cwd', 'order', 'prompt', 'release', 'args', 'answer', 'rest']) GLib.unlink(GLib.build_filenamev([dir, f]));
        mode('ok');
        ok(w.load(board), 'load board');
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(5000); }

        // A link in the title is an <a>, a link in the notes becomes its own row below the chip.
        kb.render();
        const widget = kb.columns[0].cards[at('Checkout').index];
        const text = descendants(widget).find(x => x.has_css_class('kanban-card-text')) as Gtk.Label;
        contains(text.get_label(), '<a href="markwork-note:Spec%23Colors">');
        eq(descendants(widget).filter(x => x.has_css_class('kanban-note-link')).map(x => (x as Gtk.Label).get_text()), ['↗ meeting notes', '↗ Missing']);

        // --shot-kanban-wiki=<prefix>: a card with [[ ]] links in the light and dark themes (<prefix>-light.png, -dark.png).
        const shot = optVal('shot-kanban-wiki');
        if (shot) {
            for (const dark of [false, true]) {
                w.setOption('dark', dark);
                for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(w.win)?.savev(`${shot}-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
            w.setOption('dark', false);
            kb.render();
        }
        const edited: string[] = [];
        const savedEdit = kb.dialogs.editCard;
        kb.dialogs = { ...kb.dialogs, editCard: (_p, card) => { edited.push(card.text); return null; } };
        const { column, index } = at('Checkout');
        kb.onCardPress(column, index, widget, 5, 5);
        ok(text.emit('activate-link', 'markwork-note:meeting%20notes'), 'the link was not handled');
        kb.onCardRelease();
        kb.dialogs = { ...kb.dialogs, editCard: savedEdit };
        eq(edited, [], 'the edit dialog opened too');
        eq(w.file, GLib.build_filenamev([folder, 'Meeting Notes.md']), 'the opened note');
        ok(w.closeTab(), 'closeTab');
        eq(w.file, board, 'back to the board');

        run('Checkout');
        const wikiRun = () => w.harness.orchestrator.queue.find(board, kb.getBoard().columns[at('Checkout').column].cards[at('Checkout').index].text);
        ok(waitFor(() => wikiRun()?.status === 'done'), `status: ${wikiRun()?.status}`);
        const prompt = JSON.parse(read('prompt')).message as string;
        contains(prompt, '## Related notes from Markwork');
        contains(prompt, '### [[Spec#Colors]] — specs/Spec.md');
        contains(prompt, 'The pay button is green #1a7f37.');
        ok(!prompt.includes('Other secret.'), 'another section was copied too');
        contains(prompt, 'The client asked for dynamic QRIS.');
        contains(prompt, '### [[Missing]]\n\n(not found in the Markwork work folder)');
        contains(wikiRun()!.trace.text(), 'The pay button is green');
    });

    // A project that is a Git repository: every card gets a worktree on a branch of its own, so two run side by side.
    const savedOptions = w.settings.projectOptions;
    const repoParent = GLib.dir_make_tmp('markwork-repo-XXXXXX');
    const repo = GLib.build_filenamev([repoParent, 'shop']);
    const git = (...args: string[]) => {
        const [, out, err, status] = GLib.spawn_sync(repo, ['git', ...args], ['GIT_AUTHOR_NAME=T', 'GIT_AUTHOR_EMAIL=t@example.com', 'GIT_COMMITTER_NAME=T', 'GIT_COMMITTER_EMAIL=t@example.com', `PATH=${GLib.getenv('PATH')}`, `HOME=${GLib.get_home_dir()}`], GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
        return new TextDecoder().decode(out ?? undefined).trim();
    };
    GLib.mkdir_with_parents(repo, 0o755);
    git('init', '-q', '-b', 'main');
    GLib.file_set_contents(`${repo}/checkout.ts`, 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'First');

    test('in a Git project each card gets its own worktree, and two cards work at the same time', () => {
        w.settings.projects = { shop: repo };
        w.settings.projectOptions = {};
        mode('slow');
        open();
        run('Checkout');
        run('Tidy up');
        ok(waitFor(() => read('order').trim().split('\n').filter(l => l.startsWith('start')).length === 2), `order: ${read('order')}`);
        eq([runOf('Checkout')?.status, runOf('Tidy up')?.status], ['working', 'working'], 'side by side, not queued');
        const root = `${repoParent}/.markwork-worktrees/shop`;
        eq(read('cwd').trim().split('\n').sort(), [`${root}/checkout-with-qris`, `${root}/tidy-up-readme`]);
        ok(titles(1).includes('Checkout with QRIS [agent:: pi] #feature [branch:: markwork/checkout-with-qris]'), `the card notes its branch: ${titles(1).join(' | ')}`);
        eq(runOf('Checkout')?.worktree?.branch, 'markwork/checkout-with-qris');
        eq(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the project folder stays on main');
        contains(read('prompt'), 'Git worktree made for this card');
        GLib.file_set_contents(GLib.build_filenamev([dir, 'release']), '');
        ok(waitFor(() => runOf('Checkout')?.status === 'done' && runOf('Tidy up')?.status === 'done'), `status: ${runOf('Checkout')?.status} ${runOf('Tidy up')?.status}`);
        eq(titles(2).map(t => t.split(' ')[0]).sort(), ['Checkout', 'Tidy']);
        eq(w.lastToastAction?.label, 'Review', `the finish toast offers the review: ${w.lastToast}`);
    });

    const review = w.review;
    const rv = w.reviewView;
    const reviewOpen = (text: string) => {
        menu(text, 'Review Changes').run!();
        ok(waitFor(() => review.showing !== null), 'the review did not load');
        return review.showing!;
    };

    test('the review of a card shows what changed in its worktree, and comments become the reply', () => {
        const wt = runOf('Checkout')!.worktree!;
        // What "pi" did: a change it committed, a new file it left uncommitted.
        GLib.file_set_contents(`${wt.cwd}/checkout.ts`, 'export const qris = true;\n');
        GLib.spawn_sync(wt.path, ['git', '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-a', '-m', 'Add QRIS'], null, GLib.SpawnFlags.SEARCH_PATH, null);
        GLib.file_set_contents(`${wt.cwd}/qris.ts`, 'export const payload = "";\n');
        const open = reviewOpen('Checkout');
        eq((rv.widget.get_parent() as Gtk.Stack).visible_child_name, 'review', 'the review replaces the board');
        eq(open.review.files.map(f => `${f.status} ${f.path}`), ['modified checkout.ts', 'added qris.ts']);
        eq(open.review.commits.map(c => c.subject), ['Add QRIS']);
        contains(rv.meta.label, 'markwork/checkout-with-qris');
        eq(rv.merge.label, 'Merge');
        rv.onInclude(1, false);
        eq(rv.merge.label, 'Merge 1 of 2', 'a file left out');
        rv.onInclude(1, true);
        rv.onComment(2, 'Read the flag from the settings.');   // line 0 is the hunk, 1 the removed line, 2 the added one
        eq(rv.reply.label, 'Reply with 1 Comment…');
        let asked: { text?: string } | null = null;
        w.harness.dialogs = { ...w.harness.dialogs, text: options => { asked = options; return null; } };
        rv.onReply();
        pump();
        contains(asked!.text ?? '', 'checkout.ts:1');
        contains(asked!.text ?? '', 'Read the flag from the settings.');
        rv.onTab('summary');
        pump();
        contains(descendants(rv.summary).map(x => x instanceof Gtk.Label ? x.label : '').join('\n'), 'QRIS checkout added');
        rv.onTab('changes');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-review.png`, 'png', [], []);
            w.setOption('dark', true);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-review-dark.png`, 'png', [], []);
            w.setOption('dark', false);
        }
        w.harness.dialogs = { ...w.harness.dialogs, text: () => texts.shift() ?? null };
    });

    test('merging takes the work into the project, removes the worktree, and moves the card to Done', () => {
        const open = review.showing!;
        review.dialogs = { ...review.dialogs, merge: async () => true };
        rv.onFinish('merge');
        ok(waitFor(() => review.showing === null), `merged: ${w.lastToast}`);
        contains(w.lastToast, 'Merged');
        eq(git('log', '-1', '--format=%s'), 'Checkout with QRIS');
        ok(GLib.file_test(`${repo}/qris.ts`, GLib.FileTest.EXISTS), 'the uncommitted file came along');
        ok(!GLib.file_test(open.wt.path, GLib.FileTest.EXISTS), 'the worktree is gone');
        const done = kb.getBoard().columns[3].cards.find(card => card.text.startsWith('Checkout'))!;
        ok(done, `in Done: ${titles(3).join(' | ')}`);
        eq([done.text.includes('[branch::'), done.done], [false, true], 'the branch is forgotten and the card checked');
        contains(done.notes.at(-1) ?? '', '↳ merged into main');
        ok((rv.widget.get_parent() as Gtk.Stack).visible_child_name !== 'review', 'back to the board');
    });

    test('discarding deletes the worktree and its branch and leaves the project folder alone', () => {
        const head = git('rev-parse', 'HEAD');
        const open = reviewOpen('Tidy up');
        eq(open.review.files, [], 'the fake pi changed nothing');
        contains(descendants(rv.widget).map(x => x instanceof Gtk.Label ? x.label : '').join('\n'), 'changed nothing');
        review.dialogs = { ...review.dialogs, discard: async () => true };
        rv.onFinish('discard');
        ok(waitFor(() => review.showing === null), `discarded: ${w.lastToast}`);
        eq(git('branch', '--list', 'markwork/tidy-up-readme'), '');
        eq(git('rev-parse', 'HEAD'), head);
        const card = kb.getBoard().columns[2].cards.find(c => c.text.startsWith('Tidy up'))!;
        eq(card.text.includes('[branch::'), false);
        contains(card.notes.at(-1) ?? '', 'discarded');
        ok(!findEntry(kb.cardMenu(at('Tidy up').column, at('Tidy up').index), 'Review Changes'), 'nothing left to review');
    });

    test('with worktrees off in the project settings, cards work in the project folder one at a time', () => {
        w.settings.projectOptions = { shop: '{"worktrees":false}' };
        mode('ok');
        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        eq(read('cwd').trim(), repo);
        eq(runOf('Checkout')?.worktree, null);
        ok(!titles(2)[0]?.includes('[branch::'), 'no branch on the card');
    });

    w.settings.projectOptions = savedOptions;
    w.settings.projects = savedProjects;
    w.harness.orchestrator.program = savedProgram;
    w.harness.dialogs = savedDialogs;
    c.buf.set_modified(false);
}
