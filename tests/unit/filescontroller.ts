// The Files tab: FilesController (app/files.ts) on a real temporary folder, through the platform port, with
// a view that records what it is sent.

import { AppSession } from '../../src/app/session';
import { listFolder, type FileTreeView, type FolderEntry } from '../../src/app/files';
import { section, test, eq, ok, until, pause, tmp, disk } from '../core/framework';
import { host } from '../core/host';
import { fakeFrontend, memorySettings, quiet } from './appsession';

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
    section('Files tab in the application session');
    let n = 0;
    const setup = () => {
        const dir = disk.join(tmp, `files-${++n}`);
        disk.mkdirs(disk.join(dir, 'sub'));
        disk.write(disk.join(dir, 'b.md'), '# B\n');
        disk.write(disk.join(dir, 'sub', 'inner.md'), '# Inner\n');
        const rec = recordingTree();
        const errors: string[] = [];
        const answers: (string | null)[] = [];
        const frontend = fakeFrontend(memorySettings(), [], undefined, { fileTree: rec.tree });
        const session = new AppSession(frontend);
        Object.assign(session.files.dialogs, { name: async () => answers.shift() ?? null, confirm: async () => false, error: (m: string) => { errors.push(m); } });
        session.start();
        // The files opened in tabs: a file chosen in the tree opens there (AppSession answers FilesHost.openFile).
        const opened = () => session.documents.all.map(d => d.file).filter(f => f !== null);
        return { dir, session, frontend, files: session.files, opened, errors, answers, ...rec };
    };

    await test('a listing shows folders first, then all files in natural order; dot files and node_modules are not shown', () => {
        const dir = disk.join(tmp, 'files-listing');
        for (const name of ['chapter 10.md', 'chapter 2.md', 'photo.png', 'report.html', 'old.htm', 'sales.csv', 'notes.txt', '.hidden.md']) {
            disk.mkdirs(dir);
            disk.write(disk.join(dir, name), '');
        }
        disk.mkdirs(disk.join(dir, 'z-folder'));
        disk.mkdirs(disk.join(dir, 'node_modules'));
        disk.mkdirs(disk.join(dir, '.git'));
        host().symlink(disk.join(dir, 'z-folder'), disk.join(dir, 'linked'));
        eq(listFolder(dir).map(e => [e.name, e.isDir]), [['linked', true], ['z-folder', true], ['chapter 2.md', false], ['chapter 10.md', false], ['notes.txt', false], ['old.htm', false], ['photo.png', false], ['report.html', false], ['sales.csv', false]]);
        eq(listFolder(disk.join(dir, 'gone')), [], 'a missing folder lists as empty');
    });

    await test('code opens as a read-only page outside the document set, reuses its tab, and closes when moved', async () => {
        const { dir, session, files, opened, answers } = setup();
        const path = disk.join(dir, 'main.ts');
        const text = 'const emoji = "🐈";\n';
        disk.write(path, text);
        files.setRoot(dir);
        session.host.fileTree.onActivate(path);
        eq([session.documents.page?.kind, session.documents.page?.text], ['code', text]);
        eq(opened(), [], 'code is not a manuscript document');
        const id = session.documents.page!.id;
        session.host.fileTree.onActivate(path);
        eq(session.documents.page?.id, id, 'no duplicate tab');
        ok(await session.documents.save(), 'Save is harmless for a page');
        eq(disk.read(path), text);
        answers.push('renamed.ts');
        eq(await session.host.fileTree.onRename(path), disk.join(dir, 'renamed.ts'));
        ok(!session.documents.allPages.some(p => p.id === id), 'the old snapshot closes on rename');
        session.host.fileTree.onActivate(disk.join(dir, 'renamed.ts'));
        eq(session.documents.page?.text, text);
        session.documents.fileDeleted(disk.join(dir, 'renamed.ts'));
        ok(!session.documents.allPages.some(p => p.kind === 'code'), 'deleted snapshots close');
        const note = disk.join(dir, 'b.md');
        session.host.fileTree.onActivate(note);
        session.host.fileTree.onActivate(disk.join(dir, 'renamed.ts'));
        eq(session.documents.page?.kind, 'code');
        session.host.fileTree.onActivate(note);
        eq(session.documents.page, null, 'the tree reactivates the Markdown document behind a code page');
        eq(session.documents.active.file, note);
        session.dispose();
    });

    await test('binary, non-UTF-8, oversized, symbolic-link and missing files do not open code pages', () => {
        const { dir, session, frontend } = setup();
        const errors: string[] = [];
        frontend.documents.dialogs.showError = message => { errors.push(message); };
        for (const [name, text] of [['binary.bin', 'abc\u0000def'], ['invalid.txt', '\ufffd'], ['large.txt', 'x'.repeat(2 * 1024 * 1024 + 1)]]) {
            const path = disk.join(dir, name);
            disk.write(path, text);
            session.host.fileTree.onActivate(path);
        }
        disk.write(disk.join(dir, 'target.ts'), 'const safe = true;');
        host().symlink(disk.join(dir, 'target.ts'), disk.join(dir, 'link.ts'));
        session.host.fileTree.onActivate(disk.join(dir, 'link.ts'));
        session.host.fileTree.onActivate(disk.join(dir, 'missing.txt'));
        eq(errors.length, 5);
        ok(!session.documents.allPages.some(p => p.kind === 'code'), 'no code pages');
        session.dispose();
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

    await test('a new CSV table is a .csv file with a header and an empty row, and opens in a tab; a CSV file keeps its extension when renamed', async () => {
        const { dir, session, files, folders, opened, answers } = setup();
        files.setRoot(dir);
        answers.push('sales');
        const path = disk.join(dir, 'sales.csv');
        eq(await session.host.fileTree.onCreate('csv', dir), path);
        eq(disk.read(path), 'Column 1,Column 2,Column 3\n,,\n');
        eq(opened().at(-1), path);
        ok(folders.get(dir)?.includes('sales.csv'), 'the tree lists it');
        answers.push('sales.csv');
        eq(await session.host.fileTree.onCreate('csv', dir), null, 'a taken name is refused');
        answers.push('q3');
        eq(await session.host.fileTree.onRename(path), disk.join(dir, 'q3.md'), 'a name with no known extension becomes a Markdown file');
        answers.push('q3.csv');
        eq(await session.host.fileTree.onRename(disk.join(dir, 'q3.md')), disk.join(dir, 'q3.csv'), 'a CSV name is kept');
        session.dispose();
    });

    await test('rename, move, and copy keep the tree and the open documents in step', async () => {
        const { dir, session, files, folders, expanded, answers } = setup();
        files.setRoot(dir);
        ok(session.host.openInTab(disk.join(dir, 'b.md')), 'open b.md');
        session.host.fileTree.onOpenFolder(disk.join(dir, 'sub'));
        ok(await session.host.fileTree.onMove(disk.join(dir, 'b.md'), disk.join(dir, 'sub')), 'move');
        eq([folders.get(dir), folders.get(disk.join(dir, 'sub'))], [['sub'], ['b.md', 'inner.md']]);
        eq(session.documents.active.file, disk.join(dir, 'sub', 'b.md'), 'the open document moved along');
        eq(expanded, [disk.join(dir, 'sub')], 'the folder it went into is opened');
        eq(await session.host.fileTree.onMove(disk.join(dir, 'sub'), disk.join(dir, 'sub')), false, 'a folder into itself is refused');
        answers.push('renamed');
        eq(await session.host.fileTree.onRename(disk.join(dir, 'sub')), disk.join(dir, 'renamed'));
        eq(session.documents.active.file, disk.join(dir, 'renamed', 'b.md'), 'the open document follows a renamed folder');
        const outside = disk.join(tmp, `files-outside-${n}`);
        disk.mkdirs(outside);
        disk.write(disk.join(outside, 'photo.png'), 'png bytes');
        disk.write(disk.join(outside, 'notes.txt'), 'x');
        ok(await session.host.fileTree.onCopy([disk.join(outside, 'photo.png')], dir), 'copy');
        ok(await session.host.fileTree.onCopy([disk.join(outside, 'photo.png'), disk.join(outside, 'notes.txt')], dir), 'second copy');
        eq(folders.get(dir), ['renamed', 'notes.txt', 'photo (2).png', 'photo.png'], 'a taken name gets a number');
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
