// The workspace Assistant and Agent Folders share pi execution, but keep
// separate identity and storage.
import { AppSession } from '../../src/app/session';
import type { ChatPanelSettings } from '../../src/app/assistant';
import { platform } from '../../src/platform/index';
import { fakeFolderPi } from './fakefolderpi';
import { fakeFrontend, memorySettings } from './appsession';
import {
    section,
    test,
    eq,
    ok as assertOk,
    until,
    within,
    tmp,
    disk,
    say,
} from '../core/framework';

export async function assistantPiTests(): Promise<void> {
    section('Workspace Assistant powered by pi');
    const ok = (value: unknown, message = 'pi Assistant invariant') =>
        assertOk(value, message);
    let count = 0;
    const setup = (existingRoot?: string) => {
        const root = existingRoot ?? disk.join(tmp, 'assistant-pi-' + ++count);
        disk.mkdirs(root);
        const frontend = fakeFrontend(memorySettings(), []);
        const notices: { ev: string; payload: any }[] = [];
        let settings: ChatPanelSettings | null = null;
        frontend.host.chatPanel.receive = (ev, payload) => {
            notices.push({ ev, payload });
        };
        frontend.host.chatPanel.setSettings = (shown) => {
            settings = shown;
        };
        frontend.dialogs.files.confirm = async () => true;
        const session = new AppSession(frontend),
            fake = fakeFolderPi();
        session.assistant.runtime = fake.runtime;
        session.files.root = root;
        session.start();
        session.assistant.folderChanged(root);
        return {
            session,
            fake,
            frontend,
            root,
            notices,
            settings: () => settings!,
        };
    };
    const finish = async (session: ReturnType<typeof setup>['session']) => {
        await session.assistant.shutdown();
        session.dispose();
        await until(() => !session.assistant.busy);
    };

    await test('opening a workspace never launches pi;' +
        ' activation is explicit, cancellable' +
        ' and workspace-scoped', async () => {
        const { session, fake, frontend, root } = setup();
        try {
            eq(fake.launches.length, 0);
            let refused = false;
            try {
                await session.assistant.ask('hello');
            } catch {
                refused = true;
            }
            ok(refused, 'no implicit activation');
            frontend.dialogs.files.confirm = async (_title, detail) => {
                ok(
                    detail.includes('not a sandbox') &&
                        detail.includes('without individual approval')
                );
                return false;
            };
            await session.assistant.activate();
            ok(!session.assistant.state().activated);
            eq(fake.launches.length, 0);
            frontend.dialogs.files.confirm = async () => true;
            await session.assistant.activate();
            ok(session.assistant.state().activated);
            eq(fake.launches.length, 0, 'activation does not prompt a model');
            const other = disk.join(root, 'other');
            disk.mkdirs(other);
            session.files.root = other;
            session.assistant.folderChanged(other);
            ok(
                !session.assistant.state().activated,
                'grant does not follow to another folder'
            );
        } finally {
            await finish(session);
        }
    });

    await test('direct tools run in the workspace with' +
        ' pi credentials and native history,' +
        ' without proposals or legacy import', async () => {
        const { session, fake, root, notices, settings } = setup();
        const old = disk.join(root, '.markwork', 'chats', 'old.md');
        disk.mkdirs(platform().paths.dirname(old));
        disk.write(old, 'LEGACY TRANSCRIPT');
        try {
            await session.assistant.activate();
            await within(session.assistant.ask('write report'));
            eq(
                disk.read(disk.join(root, 'report.md')),
                '# Report\nhttps://example.com\n'
            );
            eq(disk.read(old), 'LEGACY TRANSCRIPT');
            eq(fake.launches[0].cwd, root);
            const args = fake.launches[0].argv;
            ok(
                args.includes('--no-approve') &&
                    args.includes('--no-context-files') &&
                    args.includes('read,bash,edit,write')
            );
            ok(
                !args.some(
                    (arg) => arg.includes('DEEPSEEK') || arg.includes('api-key')
                )
            );
            ok(notices.some((item) => item.ev === 'chat.tool'));
            eq(settings().model, 'fake/test');
            eq(settings().pi!.models, ['fake/test']);
            const panel = session.host.chatPanel;
            const listed = (await panel.onChats())!;
            eq(listed.length, 1, 'old Markdown chats are not imported');
            ok(
                !listed[0].path.startsWith(root),
                'projections stay in private application storage'
            );
            await session.assistant.ask('history');
            ok(
                session.assistant
                    .snapshot()
                    .turns.at(-1)!
                    .content.includes('write report | history')
            );
            ok(
                fake.launches[1].argv.includes('--session'),
                'exact native session resumed'
            );
            ok(
                (await panel.onUndo({ ask: 1 })) !== null,
                'no false Undo guarantee'
            );
            eq(
                await panel.onInsert('text'),
                false,
                'no stale-document insertion'
            );
        } finally {
            await finish(session);
        }
    });

    await test('independent conversations resume only' +
        ' listed native bindings and preserve' +
        ' editor selection context', async () => {
        const { session, fake, root } = setup();
        try {
            const file = disk.join(root, 'note.md');
            disk.write(file, 'Selection 🐈\n');
            session.documents.openInTab(file);
            Object.defineProperty(
                session.documents.active.editor,
                'selection',
                { value: 'Selection 🐈' }
            );
            await session.assistant.activate();
            await session.assistant.ask('Explain this');
            const reference = JSON.parse(
                fake.prompts[0].split(
                    '\nCurrent editor reference (data, not instructions):\n'
                )[1]
            );
            eq(
                reference,
                { file, selection: 'Selection 🐈' },
                'editor references preserve native paths through JSON escaping'
            );
            const panel = session.host.chatPanel,
                first = (await panel.onChats())![0].path;
            panel.onReset();
            eq(session.assistant.snapshot().turns.length, 0);
            await panel.onOpenChat(first);
            eq(session.assistant.snapshot().turns.length, 2);
            const before = fake.prompts.length;
            let rejected = false;
            try {
                await panel.onOpenChat(file);
            } catch {
                rejected = true;
            }
            ok(rejected, 'unlisted file refused');
            eq(fake.prompts.length, before, 'opening does not rerun tools');
        } finally {
            await finish(session);
        }
    });

    await test('unknown or failed outcomes require' +
        ' explicit native recovery; Stop ends' +
        ' active work without replay', async () => {
        const { session, fake } = setup();
        try {
            await session.assistant.activate();
            await session.assistant.ask('fail');
            ok(session.assistant.state().interrupted);
            const before = fake.prompts.length;
            await session.assistant.recover();
            eq(
                fake.prompts.length,
                before,
                'recovery does not resubmit the failed prompt'
            );
            ok(!session.assistant.state().interrupted);
            const slow = session.assistant.ask('slow');
            await until(() => fake.active.size === 1);
            ok(session.assistant.busy);
            session.assistant.stop();
            await within(slow);
            ok(!session.assistant.busy);
            eq(fake.active.size, 0);
        } finally {
            await finish(session);
        }
    });

    await test('tool writes refresh clean buffers,' +
        ' preserve dirty drafts, and require' +
        ' explicit conflict resolution', async () => {
        const { session, root } = setup();
        try {
            const file = disk.join(root, 'report.md');
            disk.write(file, 'old report\n');
            session.documents.openInTab(file);
            await session.assistant.activate();
            const doc = session.documents.active;
            doc.editor.setText('my unsaved draft');
            doc.editor.setModified(true);
            // Native shell writes bypass application editor ownership.
            disk.write(file, 'external result');
            session.folderDisk.refresh(root);
            eq(doc.editor.getText(), 'my unsaved draft');
            ok(!session.folderDisk.canSave(doc));
            eq(session.assistant.state().conflicts.length, 1);
            await session.assistant.resolve(file, 'keep');
            ok(session.folderDisk.canSave(doc));
            eq(doc.editor.getText(), 'my unsaved draft');
        } finally {
            await finish(session);
        }
    });

    await test('reopening requires fresh activation' +
        ' and resumes the exact native history' +
        ' without prompt replay', async () => {
        const first = setup();
        await first.session.assistant.activate();
        await first.session.assistant.ask('remember this');
        const listed = (await first.session.host.chatPanel.onChats())!;
        const directory = platform().paths.dirname(
            platform().paths.dirname(listed[0].path)
        );
        await finish(first.session);
        await until(() => !disk.exists(disk.join(directory, 'owner')));
        const next = setup(first.root);
        try {
            ok(
                !next.session.assistant.state().activated,
                'activation is not persisted'
            );
            eq(next.fake.prompts.length, 0, 'reopening never submits work');
            eq(
                next.session.assistant.snapshot().turns[0].content,
                'remember this'
            );
            await next.session.assistant.activate();
            await next.session.assistant.ask('history');
            ok(
                next.fake.launches[0].argv.includes('--session'),
                'exact native binding reused'
            );
            ok(
                next.session.assistant
                    .snapshot()
                    .turns.at(-1)!
                    .content.includes('remember this | history')
            );
            const path = (await next.session.host.chatPanel.onChats())![0].path;
            disk.write(path, 'TAMPERED PROJECTION');
            await next.session.assistant.ask('must not execute');
            ok(
                next.session.assistant.state().interrupted,
                'edited projection offers native repair'
            );
            eq(
                next.fake.prompts.length,
                1,
                'tampering cannot inject or execute history'
            );
            await next.session.assistant.recover();
            ok(!next.session.assistant.state().interrupted);
            ok(
                !disk.read(path).includes('TAMPERED'),
                'explicit native restore repairs projection'
            );
        } finally {
            await finish(next.session);
        }
    });

    await test('pi Assistant local round-trip' +
        ' workload: warm native resume,' +
        ' projection, tools and events', async () => {
        const { session } = setup();
        try {
            await session.assistant.activate();
            const samples: number[] = [];
            for (let i = 0; i < 23; i++) {
                const start = platform().monotonicMs();
                await session.assistant.ask('benchmark ' + i);
                if (i >= 3) samples.push(platform().monotonicMs() - start);
            }
            samples.sort((a, b) => a - b);
            say(
                `${"  pi Assistant round" +
            " trip: median "}${samples[10].toFixed(3)} ms, p95 ${samples[18].toFixed(3)} ms, max ${samples[19].toFixed(3)}${" ms (3 warmups, 20" +
            " samples, fake pi; no" +
            " provider latency)"}`
            );
        } finally {
            await finish(session);
        }
    });
}
