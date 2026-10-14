// Tes GUI: Folder.

import GLib from 'gi://GLib';
import { parseBoard } from '../../src/markdown/kanban.js';
import { isBoard } from '../../src/markdown/layout.js';
import { AppSettings } from '../../src/settings.js';
import { listFolder } from '../../src/ui/filetree.js';
import { MainWindow } from '../../src/window.js';
import { widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';
import type { MenuEntry } from '../../src/ui/menu.js';

export function folderTests(c: GuiContext): void {
    const { app, w, ed, buf, pump } = c;

    section('Folder');
    // Test structure:
    //   project/a.md  b.txt  Notes.markdown  sub/c.md  sub/inner/d.md
    //   project/.hidden/x.md  node_modules/y.md  z-empty/
    const proj = GLib.build_filenamev([tmp, 'project']);
    const write = (rel: string, content = '') => {
        const full = GLib.build_filenamev([proj, rel]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(full), 0o755);
        GLib.file_set_contents(full, content);
        return full;
    };
    write('a.md', '# A');
    write('b.txt', 'not markdown');
    write('Notes.markdown', '# Notes');
    write('sub/c.md', '# C');
    const dPath = write('sub/inner/d.md', '# D');
    write('.hidden/x.md');
    write('node_modules/y.md');
    GLib.mkdir_with_parents(GLib.build_filenamev([proj, 'z-empty']), 0o755);

    const ft = w.fileTree;
    // Names of the children of folder `dir` (default root); [] if that folder has not been read yet.
    const childNames = (dir: string = proj) => ft.childNames(dir);
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 300 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };

    const abs0 = (...p: string[]) => GLib.build_filenamev([proj, ...p]);
    test('folder contents: subfolders first, Markdown only, no hidden files', () => {
        eq(listFolder(proj).map(e => e.name), ['sub', 'z-empty', 'a.md', 'Notes.markdown']);
    });
    test('opening a folder shows the tree in the Files tab', () => {
        w.openFolder(proj);
        pump();
        eq(ft.root, proj, 'root');
        eq(childNames(), ['sub', 'z-empty', 'a.md', 'Notes.markdown'], 'root rows');
        eq(w.sidebar.page, 'files', 'sidebar tab');
        ok(w.sidebar.visible, 'the sidebar is not visible');
        eq(w.settings.folder, proj, 'the folder is saved in the settings');
    });
    test('the contents of a subfolder are read when it is opened', () => {
        const sub = abs0('sub');
        ok(!ft.isExpanded(sub), 'sub is already open');
        ft.expand(sub);
        pump();
        ok(ft.isExpanded(sub), 'sub did not open');
        eq(childNames(sub), ['inner', 'c.md'], 'after opening');
    });
    test('clicking a file in the tree opens it in the editor (a new tab if the active document is in use)', () => {
        ft.activate(abs0('a.md'));
        pump();
        eq(w.file, GLib.build_filenamev([proj, 'a.md']), 'file');
        eq(w.editor.getText(), '# A', 'editor contents');
        // Go back to the original editor so the next tests use the same buffer.
        if (w.editor !== ed) ok(w.closeTab(), 'closeTab() failed');
        ok(w.editor === ed, 'the original editor is no longer active');
    });
    test('the opened file is highlighted, its parent folder is opened too', () => {
        ok(w.load(dPath), 'load() failed');
        pump();
        eq(ft.selectedPath, dPath, 'highlighted row');
        ok(ft.isExpanded(abs0('sub', 'inner')), 'the "inner" folder did not open');
    });
    test('a new file on disk appears without closing the open subfolder', () => {
        write('b-new.md', '# New');
        ok(waitFor(() => childNames().includes('b-new.md')), 'the new file did not appear');
        eq(childNames(), ['sub', 'z-empty', 'a.md', 'b-new.md', 'Notes.markdown'], 'order');
        ok(ft.isExpanded(abs0('sub')), 'the subfolder was closed too');
    });
    test('a file deleted on disk disappears from the tree', () => {
        GLib.unlink(GLib.build_filenamev([proj, 'b-new.md']));
        ok(waitFor(() => !childNames().includes('b-new.md')), 'the deleted file is still shown');
    });
    test('an image file that is added appears; other file types do not', () => {
        write('picture.png');
        write('c-new.md');
        ok(waitFor(() => childNames().includes('c-new.md')), 'the new Markdown file did not appear');
        ok(childNames().includes('picture.png'), 'the .png file was not shown');
    });
    test('load() with a folder path opens the folder, not an error', () => {
        ft.setRoot(null);
        // Before the fix, this showed an "Is a directory" error dialog (and the test hung on that dialog).
        ok(w.load(proj), 'load() failed');
        pump();
        eq(ft.root, proj, 'root');
        eq(w.sidebar.page, 'files', 'sidebar tab');
        eq(w.file, GLib.build_filenamev([proj, 'sub', 'inner', 'd.md']), 'the open file did not change');
    });
    test('a folder as an argument opens that folder', () => {
        const w2 = new MainWindow(app, AppSettings.inMemory({ welcomed: true, home: false, dark: false }), proj);
        pump();
        eq(w2.fileTree.root, proj, 'root of the second window');
        eq(w2.file, null, 'no file was opened');
        w2.editor.buffer.set_modified(false);
        w2.win.destroy();
        pump();
    });
    test('the last folder is restored without forcing the sidebar open', () => {
        const w3 = new MainWindow(app, AppSettings.inMemory({ welcomed: true, home: false, dark: false, folder: proj, sidebar: false }), null);
        pump();
        eq(w3.fileTree.root, proj, 'root');
        ok(!w3.sidebar.visible, 'the sidebar was forced open');
        w3.editor.buffer.set_modified(false);
        w3.win.destroy();
        pump();
    });
    test('an Assistant panel that is open from the start shows the context summary right away', () => {
        const w4 = new MainWindow(app, AppSettings.inMemory({ welcomed: true, home: false, dark: false, folder: proj, chat: true }), null);
        pump();
        ok(w4.chatSplit.show_sidebar, 'the Assistant panel did not open');
        ok(w4.chat.contextButton.get_label()?.startsWith('Context · ≈'), `the context summary is empty:  "${w4.chat.contextButton.get_label()}"`);
        w4.editor.buffer.set_modified(false);
        w4.win.destroy();
        pump();
    });
    // ---------- Manage files through the tree ----------
    const prompts: (string | null)[] = [];
    const errors: string[] = [];
    const confirms: boolean[] = [];
    ft.dialogs = { prompt: () => prompts.shift() ?? null, confirm: () => confirms.shift() ?? false, error: msg => { errors.push(msg); } };
    const menuLabels = (m: MenuEntry[]) => m.map(i => i.label);
    const activate = (m: MenuEntry[], label: string) => m.find(i => i.label === label)!.run!();
    const opened: string[] = [];
    const openBefore = ft.onOpenFile;
    ft.onOpenFile = p => { opened.push(p); openBefore(p); };
    ft.setRoot(proj);
    w.file = null;
    buf.set_modified(false);

    test('the right-click menu contains New File, New Folder, New Kanban Board, and New Inbox', () => {
        eq(menuLabels(ft.contextMenu(null)), ['New File…', 'New Folder…', 'New Kanban Board…', 'New Inbox…', 'New Table…']);
    });
    test('right-clicking an empty area creates a file at the root and opens it', () => {
        prompts.push('blank-new');
        activate(ft.contextMenu(null), 'New File…');
        pump();
        ok(waitFor(() => childNames().includes('blank-new.md')), 'the file did not appear in the tree');
        ok(GLib.file_test(GLib.build_filenamev([proj, 'blank-new.md']), GLib.FileTest.EXISTS), 'the file is not on disk');
        eq(opened, [GLib.build_filenamev([proj, 'blank-new.md'])], 'the file was not opened');
        eq(w.file, GLib.build_filenamev([proj, 'blank-new.md']), 'editor file');
    });
    test('right-clicking a folder creates a file inside that folder', () => {
        prompts.push('in-sub.md');
        activate(ft.contextMenu(abs0('sub')), 'New File…');
        pump();
        ok(GLib.file_test(GLib.build_filenamev([proj, 'sub', 'in-sub.md']), GLib.FileTest.EXISTS), 'the file is not on disk');
        ok(childNames(abs0('sub')).includes('in-sub.md'), 'the file did not appear in the folder');
        ok(ft.isExpanded(abs0('sub')), 'the target folder did not open');
    });
    test('right-clicking a file creates a file in its parent folder', () => {
        prompts.push('beside');
        activate(ft.contextMenu(abs0('sub', 'c.md')), 'New File…');
        pump();
        ok(GLib.file_test(GLib.build_filenamev([proj, 'sub', 'beside.md']), GLib.FileTest.EXISTS), 'the file is not in the parent folder');
    });
    test('a new file from the menu opens in its own tab; the first document remains', () => {
        eq(w.documentCount, 3, 'number of tabs');
        eq(w.file, GLib.build_filenamev([proj, 'sub', 'beside.md']), 'active tab file');
        eq(ed.getText(), '', 'contents of the first document');
        // Go back to the original editor so the next tests use the same buffer.
        while (w.editor !== ed) ok(w.closeTab(), 'closeTab() failed');
        eq(w.documentCount, 1, 'number of tabs after closing');
    });
    test('New Kanban Board creates a board file in the clicked folder and opens it as a board', () => {
        // --shot-tree-menu=<prefix>: save a screenshot of the right-click menu (<prefix>-menu.png) and of the created board (<prefix>-board.png).
        const shot = optVal('shot-tree-menu');
        if (shot) {
            const popover = ft.popupContextMenu(abs0('sub'), 40, 40);
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(popover)?.savev(`${shot}-menu.png`, 'png', [], []);
            popover.popdown();
            // The popover is detached from the TreeView in idle; wait until it is detached before the tree is changed.
            ok(waitFor(() => !popover.get_parent()), 'the popover was not detached');
        }
        prompts.push('tasks');
        activate(ft.contextMenu(abs0('sub')), 'New Kanban Board…');
        pump();
        const path = GLib.build_filenamev([proj, 'sub', 'tasks.md']);
        ok(GLib.file_test(path, GLib.FileTest.EXISTS), 'the board file is not on disk');
        const text = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        ok(isBoard(text), 'the file contents are not a kanban board');
        eq(parseBoard(text).columns.map(c => c.title), ['Plan', 'In Progress', 'Done'], 'board lists');
        ok(childNames(abs0('sub')).includes('tasks.md'), 'the board file is not shown in the tree');
        eq(w.file, path, 'active tab file');
        ok(w.boardMode, 'the board is not shown');
        ok(!w.editor.buffer.get_modified(), 'the new board was marked unsaved');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-board.png`, 'png', [], []);
        }
        while (w.editor !== ed) ok(w.closeTab(), 'closeTab() failed');
    });
    test('New Kanban Board with a conflicting name shows an error without overwriting', () => {
        errors.length = 0;
        prompts.push('a');
        const before = new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([proj, 'a.md']))[1]);
        activate(ft.contextMenu(null), 'New Kanban Board…');
        eq(errors.length, 1, 'conflict error');
        eq(new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([proj, 'a.md']))[1]), before, 'contents of a.md');
    });
    test('New Folder creates a folder at the root and inside a folder', () => {
        prompts.push('new-root');
        activate(ft.contextMenu(null), 'New Folder…');
        ok(waitFor(() => childNames().includes('new-root')), 'the root folder did not appear');
        prompts.push('new-inner');
        activate(ft.contextMenu(abs0('z-empty')), 'New Folder…');
        ok(GLib.file_test(GLib.build_filenamev([proj, 'z-empty', 'new-inner']), GLib.FileTest.IS_DIR), 'the inner folder was not created');
        ok(childNames(abs0('z-empty')).includes('new-inner'), 'the inner folder is not shown');
    });
    test('a conflicting or invalid name shows an error, a cancelled dialog creates nothing', () => {
        errors.length = 0;
        prompts.push('a');
        activate(ft.contextMenu(null), 'New File…');
        eq(errors.length, 1, 'conflict error');
        prompts.push('x/y');
        activate(ft.contextMenu(null), 'New Folder…');
        eq(errors.length, 2, 'invalid name error');
        const before = childNames().length;
        prompts.push(null);
        activate(ft.contextMenu(null), 'New File…');
        eq(childNames().length, before, 'cancelled');
    });

    const abs = (...p: string[]) => GLib.build_filenamev([proj, ...p]);
    test('a row menu adds Rename and Delete; an empty area does not', () => {
        eq(menuLabels(ft.contextMenu(abs0('a.md'))).filter(l => l), ['New File…', 'New Folder…', 'New Kanban Board…', 'New Inbox…', 'New Table…', 'Rename…', 'Delete']);
        eq(menuLabels(ft.contextMenu(null)), ['New File…', 'New Folder…', 'New Kanban Board…', 'New Inbox…', 'New Table…']);
    });
    test('renaming a file and a folder updates the tree and disk', () => {
        write('old.md');
        ok(waitFor(() => childNames().includes('old.md')), 'the test file did not appear');
        prompts.push('new');
        activate(ft.contextMenu(abs0('old.md')), 'Rename…');
        ok(GLib.file_test(abs('new.md'), GLib.FileTest.EXISTS) && !GLib.file_test(abs('old.md'), GLib.FileTest.EXISTS), 'disk');
        ok(waitFor(() => childNames().includes('new.md') && !childNames().includes('old.md')), 'tree');
        prompts.push('renamed-dir');
        activate(ft.contextMenu(abs0('z-empty')), 'Rename…');
        ok(GLib.file_test(abs('renamed-dir'), GLib.FileTest.IS_DIR), 'the folder was renamed');
        ok(ft.rename(abs('renamed-dir')) === null, 'a cancelled dialog changes nothing');
        prompts.push('z-empty');
        activate(ft.contextMenu(abs0('renamed-dir')), 'Rename…');
        ok(GLib.file_test(abs('z-empty'), GLib.FileTest.IS_DIR), 'back');
    });
    test('renaming is refused on a conflict; an open file follows the new name', () => {
        errors.length = 0;
        prompts.push('a.md');
        activate(ft.contextMenu(abs0('new.md')), 'Rename…');
        eq(errors.length, 1, 'conflict error');
        ok(w.load(abs('new.md')), 'load');
        prompts.push('open');
        ft.rename(abs('new.md'));
        eq(w.file, abs('open.md'), 'document path');
    });
    test('delete asks for confirmation; cancelling does not delete', () => {
        confirms.push(false);
        ok(!ft.remove(abs('open.md')), 'cancelled');
        ok(GLib.file_test(abs('open.md'), GLib.FileTest.EXISTS), 'the file vanished although cancelled');
    });
    test('delete moves the file to the trash and detaches the open document', () => {
        errors.length = 0;
        confirms.push(true);
        const done = ft.remove(abs('open.md'));
        if (!done) { eq(errors.length, 1, 'failed without an error'); return; }  // an environment without a Trash
        ok(!GLib.file_test(abs('open.md'), GLib.FileTest.EXISTS), 'the file still exists');
        ok(!childNames().includes('open.md'), 'the row still exists');
        eq(w.file, null, 'the open document was detached');
        ok(buf.get_modified(), 'the contents must be marked unsaved');
        buf.set_modified(false);
    });
    test('move a file into a folder', () => {
        errors.length = 0;
        ok(ft.moveTo(abs('Notes.markdown'), abs('z-empty')), 'moveTo failed');
        ok(GLib.file_test(abs('z-empty', 'Notes.markdown'), GLib.FileTest.EXISTS), 'the file has not moved');
        ok(!childNames().includes('Notes.markdown'), 'the old row still exists');
        ok(childNames(abs0('z-empty')).includes('Notes.markdown'), 'the new row is missing');
        eq(errors, [], 'errors');
    });
    test('move a file out of a folder to the root', () => {
        ok(ft.moveTo(abs('z-empty', 'Notes.markdown'), proj), 'moveTo failed');
        ok(childNames().includes('Notes.markdown'), 'the row did not appear at the root');
        ok(!childNames(abs0('z-empty')).includes('Notes.markdown'), 'the old row still exists');
    });
    test('move a folder into another folder and back out', () => {
        ok(ft.moveTo(abs('new-root'), abs('sub')), 'moveTo failed');
        ok(GLib.file_test(abs('sub', 'new-root'), GLib.FileTest.IS_DIR), 'the folder has not moved');
        ok(childNames(abs0('sub')).includes('new-root'), 'the row did not appear in the target folder');
        ok(ft.moveTo(abs('sub', 'new-root'), proj), 'moveTo out failed');
        ok(childNames().includes('new-root'), 'the row did not return to the root');
    });
    test('a folder cannot be moved into itself or its descendants, a name conflict is refused', () => {
        errors.length = 0;
        ok(!ft.moveTo(abs('sub'), abs('sub', 'inner')), 'moving into a descendant should fail');
        eq(errors.length, 1, 'error');
        ok(GLib.file_test(abs('sub', 'inner'), GLib.FileTest.IS_DIR), 'the folder vanished');
        write('z-empty/a.md');
        ok(!ft.moveTo(abs('a.md'), abs('z-empty')), 'a conflict should fail');
        ok(GLib.file_test(abs('a.md'), GLib.FileTest.EXISTS), 'the source vanished');
    });
    test('moving a file that is open updates the document path', () => {
        ok(w.load(abs('sub', 'c.md')), 'load');
        ok(ft.moveTo(abs('sub', 'c.md'), proj), 'moveTo');
        eq(w.file, abs('c.md'), 'document path');
        ok(!buf.get_modified(), 'the document must not change');
        ok(ft.moveTo(abs('sub'), abs('z-empty')), 'move the parent folder');
        ok(w.load(abs('z-empty', 'sub', 'inner', 'd.md')), 'load d.md');
        ok(ft.moveTo(abs('z-empty', 'sub'), proj), 'move it back');
        eq(w.file, abs('sub', 'inner', 'd.md'), 'document path after the parent folder moved');
    });
    test('files dropped from outside are copied in; a name clash gets a number; other types are skipped', () => {
        errors.length = 0;
        const outside = GLib.build_filenamev([tmp, 'outside']);
        GLib.mkdir_with_parents(GLib.build_filenamev([outside, 'pics']), 0o755);
        const img = GLib.build_filenamev([outside, 'photo.png']);
        GLib.file_set_contents(img, 'png');
        GLib.file_set_contents(GLib.build_filenamev([outside, 'pics', 'p.md']), '# P');
        const pdf = GLib.build_filenamev([outside, 'doc.pdf']);
        GLib.file_set_contents(pdf, 'pdf');
        ok(ft.copyInto([img, GLib.build_filenamev([outside, 'pics']), pdf], abs('z-empty')), 'copyInto failed');
        ok(GLib.file_test(img, GLib.FileTest.EXISTS), 'the source must stay');
        ok(childNames(abs0('z-empty')).includes('photo.png'), 'the image row is missing');
        ok(GLib.file_test(abs('z-empty', 'pics', 'p.md'), GLib.FileTest.EXISTS), 'the folder contents were not copied');
        ok(!GLib.file_test(abs('z-empty', 'doc.pdf'), GLib.FileTest.EXISTS), 'the pdf must be skipped');
        eq(errors.length, 1, 'one message about the skipped file');
        ok(ft.copyInto([img], abs('z-empty')), 'second copy');
        ok(childNames(abs0('z-empty')).includes('photo (2).png'), 'the clash did not get a number');
    });
    buf.set_modified(false);
    w.file = null;
    ft.onOpenFile = openBefore;

    test('the Search panel finds a note, opens the hit with the match selected, and plans the replacement', () => {
        w.showSearch(); pump();
        eq(w.sidebar.page, 'search', 'page');
        ok(w.sidebar.railButtons.get('search')!.active, 'the rail icon did not follow');
        const panel = w.searchPanel;
        panel.entry.text = '# C'; panel.run();
        eq(panel.store.get_n_items(), 2, 'a file row and a hit row');
        ok(panel.summary.label.includes('1 result in 1 file'), `summary: ${panel.summary.label}`);
        panel.list.emit('activate', 1); pump();
        ok(w.file?.endsWith('/c.md') === true, `file: ${w.file}`);
        const [has, s, e] = w.editor.buffer.get_selection_bounds();
        ok(has && w.editor.buffer.get_text(s, e, false) === '# C', 'the match is not selected');
        ok(!panel.filterRow.reveal_child, 'the filters start folded');
        panel.filterButton.active = true;
        ok(panel.filterRow.reveal_child, 'the ··· button did not open the filters');
        panel.entry.text = '#'; panel.excludeEntry.text = 'sub'; panel.run();
        ok(panel.filterButton.has_css_class('accent'), 'the button does not show an active filter');
        const filesShown = () => Array.from({ length: panel.store.get_n_items() }, (_i, n) => panel.store.get_item(n) as unknown as { kind: string; file: string })
            .filter(r => r.kind === 'file').map(r => r.file);
        ok(filesShown().length > 0 && filesShown().every(f => !f.startsWith('sub/')), `excluded folder shown: ${filesShown()}`);
        panel.excludeEntry.text = ''; panel.includeEntry.text = 'sub/**'; panel.run();
        ok(filesShown().length > 0 && filesShown().every(f => f.startsWith('sub/')), `included folder only: ${filesShown()}`);
        ok(panel.summary.label.includes('1 filter'), `summary: ${panel.summary.label}`);
        panel.includeEntry.text = ''; panel.filterButton.active = false;
        ok(!panel.filterButton.has_css_class('accent'), 'the mark stays after the filters are cleared');
        panel.entry.text = '# C'; panel.run();
        panel.replaceEntry.text = '# Z';
        const [change] = panel.plan();
        eq(change.after, '# Z', 'planned change');
        panel.regexButton.active = true; panel.entry.text = '('; panel.run();
        ok(panel.entry.has_css_class('error'), 'an invalid regular expression is not marked');
        panel.regexButton.active = false; panel.entry.text = ''; panel.run();
        eq(panel.store.get_n_items(), 0, 'rows after clearing');
        w.editor.buffer.set_modified(false);
    });
    test('the rail switches the sidebar page and the choice is remembered', () => {
        w.sidebar.railButtons.get('history')!.active = true; pump();
        eq([w.sidebar.page, w.settings.sidebarPage], ['history', 'history'], 'history');
        w.sidebar.railButtons.get('files')!.active = true; pump();
        eq([w.sidebar.page, w.settings.sidebarPage], ['files', 'files'], 'files');
    });
    test('closing the folder empties the tree', () => {
        ft.setRoot(null);
        eq(childNames(), [], 'rows');
    });
    buf.set_modified(false);
    w.file = null;
}
