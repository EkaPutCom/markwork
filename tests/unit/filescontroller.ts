// The Files tab without GTK: FilesController (app/files.ts) on a real temporary folder, through the platform port, with
// a view that records what it is sent. Runs on GJS and on Node.

import { AppSession } from '../../src/app/session.js';
import { listFolder, type FileTreeView, type FolderEntry } from '../../src/app/files.js';
import { section, test, eq, ok, until, pause, tmp, disk } from '../framework.js';
import { host } from '../host.js';
import { fakeFrontend, memorySettings, quiet } from './appsession.js';

// A tree that keeps the last contents it was sent per folder, and what it was asked to highlight and open.
function recordingTree() {
    const folders = new Map<string, string[]>();
    const revealed: (string | null)[] = [];
    const expanded: string[] = [];
    let root: string | null = null;
    const names = (entries: FolderEntry[]) => entries.map(e => e.name);
    const tree = quiet<FileTreeView>({
        showRoot: (path, entries) => { root = path; folders.clear(); if (path) folders.set(path, names(entries)); },
        showFolder: (dir, entries) => { folders.set(dir, names(entries)); },
        reveal: path => { revealed.push(path); },
        expand: dir => { expanded.push(dir); },
    });
    return { tree, folders, revealed, expanded, root: () => root };
}

export async function filesControllerTests(): Promise<void> {
    section('Files tab in the application session (no GTK)');
    let n = 0;
    const setup = () => {
        const dir = disk.join(tmp, `files-${++n}`);
        disk.mkdirs(disk.join(dir, 'sub'));
        disk.write(disk.join(dir, 'b.md'), '# B\n');
        disk.write(disk.join(dir, 'sub', 'inner.md'), '# Inner\n');
        const rec = recordingTree();
        const errors: string[] = [];
        const answers: (string | null)[] = [];
        const session = new AppSession(fakeFrontend(memorySettings(), [], undefined, { fileTree: rec.tree }));
        Object.assign(session.files.dialogs, { name: () => answers.shift() ?? null, confirm: () => false, error: (m: string) => { errors.push(m); } });
        session.start();
        // The files opened in tabs: a file chosen in the tree opens there (AppSession answers FilesHost.openFile).
        const opened = () => session.documents.all.map(d => d.file).filter(f => f !== null);
        return { dir, session, files: session.files, opened, errors, answers, ...rec };
    };

    await test('a listing shows folders first, then Markdown files, HTML pages, and images, in natural order; dot files and node_modules are not shown', () => {
        const dir = disk.join(tmp, 'files-listing');
        for (const name of ['chapter 10.md', 'chapter 2.md', 'photo.png', 'report.html', 'old.htm', 'notes.txt', '.hidden.md']) {
            disk.mkdirs(dir);
            disk.write(disk.join(dir, name), '');
        }
        disk.mkdirs(disk.join(dir, 'z-folder'));
        disk.mkdirs(disk.join(dir, 'node_modules'));
        disk.mkdirs(disk.join(dir, '.git'));
        host().symlink(disk.join(dir, 'z-folder'), disk.join(dir, 'linked'));
        eq(listFolder(dir).map(e => [e.name, e.isDir]), [['linked', true], ['z-folder', true], ['chapter 2.md', false], ['chapter 10.md', false], ['old.htm', false], ['photo.png', false], ['report.html', false]]);
        eq(listFolder(disk.join(dir, 'gone')), [], 'a missing folder lists as empty');
    });

    await test('the work folder and the folders the tree opens are sent as plain data; root answers the other controllers', () => {
        const { dir, session, files, folders } = setup();
        files.setRoot(dir);
        eq(folders.get(dir), ['sub', 'b.md']);
        eq(session.host.root(), dir, 'the host asks the files controller for the work folder');
        session.host.fileTree.onOpenFolder(disk.join(dir, 'sub'));
        eq(folders.get(disk.join(dir, 'sub')), ['inner.md']);
        for (const entries of folders.values()) eq(JSON.parse(JSON.stringify(entries)), entries, 'not plain data');
        files.setRoot(null);
        eq(session.host.root(), null);
        session.dispose();
    });

    await test('a file made outside the app shows up through the folder watch; after dispose nothing more is sent', async () => {
        const { dir, session, files, folders } = setup();
        files.setRoot(dir);
        disk.write(disk.join(dir, 'outside.md'), 'x');
        await until(() => folders.get(dir)?.includes('outside.md') ?? false);
        session.dispose();
        disk.write(disk.join(dir, 'later.md'), 'x');
        await pause(400);
        ok(!folders.get(dir)?.includes('later.md'), 'a disposed controller still watched');
    });

    await test('create asks for a name, makes the file, highlights it, and opens it; a bad name is reported, not thrown', async () => {
        const { dir, session, files, folders, revealed, opened, errors, answers } = setup();
        files.setRoot(dir);
        answers.push('plan');
        eq(await session.host.fileTree.onCreate('board', dir), disk.join(dir, 'plan.md'));
        ok(disk.read(disk.join(dir, 'plan.md')).includes('layout: board'), 'a board file');
        eq(folders.get(dir), ['sub', 'b.md', 'plan.md']);
        eq([revealed.at(-1), opened().at(-1)], [disk.join(dir, 'plan.md'), disk.join(dir, 'plan.md')]);
        answers.push('chapters');
        eq(await session.host.fileTree.onCreate('folder', dir), disk.join(dir, 'chapters'));
        eq(opened().length, 1, 'a folder is not opened');
        answers.push('.secret');
        eq(await session.host.fileTree.onCreate('file', dir), null);
        eq(errors, ['Name cannot start with a dot (it would be hidden from the tree).']);
        eq(await session.host.fileTree.onCreate('file', dir), null, 'cancelled');
        session.dispose();
    });

    await test('rename, move, and copy keep the tree and the open documents in step', async () => {
        const { dir, session, files, folders, expanded, answers } = setup();
        files.setRoot(dir);
        ok(session.host.openInTab(disk.join(dir, 'b.md')), 'open b.md');
        session.host.fileTree.onOpenFolder(disk.join(dir, 'sub'));
        ok(session.host.fileTree.onMove(disk.join(dir, 'b.md'), disk.join(dir, 'sub')), 'move');
        eq([folders.get(dir), folders.get(disk.join(dir, 'sub'))], [['sub'], ['b.md', 'inner.md']]);
        eq(session.documents.active.file, disk.join(dir, 'sub', 'b.md'), 'the open document moved along');
        eq(expanded, [disk.join(dir, 'sub')], 'the folder it went into is opened');
        eq(session.host.fileTree.onMove(disk.join(dir, 'sub'), disk.join(dir, 'sub')), false, 'a folder into itself is refused');
        answers.push('renamed');
        eq(await session.host.fileTree.onRename(disk.join(dir, 'sub')), disk.join(dir, 'renamed'));
        eq(session.documents.active.file, disk.join(dir, 'renamed', 'b.md'), 'the open document follows a renamed folder');
        const outside = disk.join(tmp, `files-outside-${n}`);
        disk.mkdirs(outside);
        disk.write(disk.join(outside, 'photo.png'), 'png bytes');
        disk.write(disk.join(outside, 'notes.txt'), 'x');
        ok(session.host.fileTree.onCopy([disk.join(outside, 'photo.png')], dir), 'copy');
        ok(session.host.fileTree.onCopy([disk.join(outside, 'photo.png'), disk.join(outside, 'notes.txt')], dir), 'second copy');
        eq(folders.get(dir), ['renamed', 'photo (2).png', 'photo.png'], 'a taken name gets a number');
        eq(disk.read(disk.join(dir, 'photo.png')), 'png bytes', 'copied as it is');
        session.dispose();
    });

    await test('remove asks first and leaves the file when the answer is no', async () => {
        const { dir, session, files } = setup();
        files.setRoot(dir);
        eq(await session.host.fileTree.onRemove(disk.join(dir, 'b.md')), false);
        ok(disk.exists(disk.join(dir, 'b.md')), 'removed without a yes');
        session.dispose();
    });
}
