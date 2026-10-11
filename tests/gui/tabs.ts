// GUI tests: Multiple documents (tabs) in one window.

import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import type { GuiContext } from './context.js';

export function tabTests(c: GuiContext): void {
    const { w, ed, pump } = c;

    section('Document tabs');
    const dir = GLib.build_filenamev([tmp, 'tab']);
    GLib.mkdir_with_parents(dir, 0o755);
    const path = (name: string) => GLib.build_filenamev([dir, name]);
    const put = (name: string, text: string) => { GLib.file_set_contents(path(name), text); return path(name); };
    const ch1 = put('chapter-1.md', '# Chapter One\n\nRaka was twenty years old.\n');
    const ch2 = put('chapter-2.md', '# Chapter Two\n\n## Section\n\nThe contents of chapter two.\n');
    const board = put('board.md', '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Card\n');
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const tabsShown = () => w.tabBar.widget.tabs_revealed;

    // Start from one empty document without a file.
    w.file = null;
    c.setText('');

    test('one document: the tab bar is hidden', () => {
        eq(w.documentCount, 1, 'number of documents');
        ok(!tabsShown(), 'the tab bar is shown for one document');
    });
    test('opening a file in an empty document reuses that tab', () => {
        w.openFile(ch1); settle();
        eq(w.documentCount, 1, 'number of documents');
        ok(w.editor === ed, 'the editor changed');
        eq(w.file, ch1, 'file');
    });
    test('opening a second file opens a new tab and the first document stays intact', () => {
        w.openFile(ch2); settle();
        eq(w.documentCount, 2, 'number of documents');
        ok(tabsShown(), 'the tab bar is hidden');
        ok(w.editor !== ed, 'the editor did not change');
        eq(w.file, ch2, 'active file');
        eq(w.editor.getText().startsWith('# Chapter Two'), true, 'active tab contents');
        eq(ed.getText().startsWith('# Chapter One'), true, 'first tab contents');
        eq(w.win.get_title(), 'chapter-2.md — Nyerat', 'window title');
    });
    test('the outline and the word count follow the active tab', () => {
        eq(w.outline.count, 2, 'chapter 2 headings');
        w.switchTab(-1); settle();
        eq(w.file, ch1, 'file after switching');
        eq(w.outline.count, 1, 'chapter 1 headings');
        ok(w.statusBar.right.label.includes('words'), `status: ${w.statusBar.right.label}`);
    });
    test('a long file in a new tab opens from the start, not scrolled to the middle', () => {
        // The editor of a new tab has no size yet when its contents are replaced; a pending scroll must not
        // use that empty geometry (GTK 4 then scrolls to the middle/end of the document).
        const long = put('long.md',  Array.from({ length: 300 }, (_, i) => `Paragraph ${i}`).join('\n\n'));
        w.openFile(long); settle();
        const vadj = w.editor.view.get_vadjustment()!;
        ok(vadj.get_upper() > vadj.get_page_size() * 2, 'the document is not long enough to scroll');
        eq(vadj.get_value(), 0, 'scroll position');
        w.closeTab(); settle();
    });
    test('opening a file that is already open only switches tabs', () => {
        w.openFile(ch2); settle();
        eq(w.documentCount, 2, 'number of documents');
        eq(w.file, ch2, 'active file');
    });
    test('undo is separate for each tab', () => {
        const second = w.editor;
        w.switchTab(-1); settle();
        ok(w.editor === ed, 'not the first tab');
        ed.buffer.insert_at_cursor('YYY', -1); pump();
        w.switchTab(1); settle();
        second.buffer.place_cursor(second.buffer.get_end_iter());
        second.buffer.insert_at_cursor('ZZZ', -1); pump();
        second.buffer.undo(); pump();
        ok(!second.getText().includes('ZZZ'), 'undo of the second tab failed');
        ok(ed.getText().includes('YYY'), 'undo of the second tab changed the first tab');
        w.switchTab(-1); settle();
        ed.buffer.undo(); pump();
        ok(!ed.getText().includes('YYY'), 'undo of the first tab failed');
        ed.buffer.set_modified(false);
        second.buffer.set_modified(false);
        w.switchTab(1); settle();
    });
    test('the unsaved mark appears per tab', () => {
        const second = w.editor;
        second.buffer.insert_at_cursor('x', -1); pump();
        ok(w.win.get_title()!.startsWith('• '), `title: ${w.win.get_title()}`);
        w.switchTab(-1); settle();
        ok(!w.win.get_title()!.startsWith('• '), `title of the other tab: ${w.win.get_title()}`);
        second.buffer.undo(); second.buffer.set_modified(false); pump();
    });
    test('search follows the active editor', () => {
        w.switchTab(1); settle();
        ok(w.findBar.buffer === w.editor.buffer, 'the search buffer did not change');
        w.switchTab(-1); settle();
        ok(w.findBar.buffer === ed.buffer, 'the search buffer did not return');
    });
    test('the view mode and theme are inherited by a new tab', () => {
        w.setOption('focus', true);
        w.openFile(board); settle();
        eq(w.documentCount, 3, 'number of documents');
        ok(w.editor.modes.focus, 'focus mode did not carry over');
        w.setOption('focus', false);
        ok(!w.editor.modes.focus && !ed.modes.focus, 'focus mode was not turned off in all tabs');
    });
    test('the kanban board and text alternate between tabs', () => {
        ok(w.boardMode, 'the board is not shown');
        w.switchTab(-1); settle();
        ok(!w.boardMode, 'the board is still shown in the text tab');
        w.switchTab(1); settle();
        ok(w.boardMode, 'the board did not return');
    });
    test('closing the active tab moves to its neighbor', () => {
        const kanban = w.editor;
        ok(w.closeTab(), 'closeTab() failed'); settle();
        eq(w.documentCount, 2, 'number of documents');
        ok(w.editor !== kanban, 'the closed tab is still active');
        eq(w.file, ch2, 'active file');
        ok(!w.boardMode, 'the board is still shown');
    });
    test('closing a tab with changes saves it first when autosave is on', () => {
        w.setOption('autosave', true);
        w.editor.buffer.insert_at_cursor('!', -1); pump();
        ok(w.closeTab(), 'closeTab() failed'); settle();
        ok(readTextFile(ch2).includes('!'), 'the change was not saved');
        eq(w.documentCount, 1, 'number of documents');
        ok(w.editor === ed, 'the original editor is not active');
        ok(!tabsShown(), 'the tab bar is still shown for one document');
        w.setOption('autosave', false);
    });
    test('closing the last tab empties its document', () => {
        ok(w.closeTab(), 'closeTab() failed');
        eq(w.documentCount, 1, 'number of documents');
        eq(w.file, null, 'file');
        eq(w.editor.getText(), '', 'contents');
    });
    test('the assistant reads the contents of an unsaved tab', () => {
        w.openFolder(dir, false);
        w.openFile(ch1); settle();
        w.openFile(ch2); settle();
        w.editor.buffer.insert_at_cursor('NOT-SAVED ', -1); pump();
        w.switchTab(-1); settle();
        eq(w.file, ch1, 'active file');
        w.setOption('autosave', false);
        const other = w.chat.host.files().find(f => f.name === 'chapter-2.md');
        ok(other?.text.includes('NOT-SAVED'), 'the assistant read the version on disk');
        // Clean up: close the second tab without saving.
        w.switchTab(1); settle();
        w.editor.buffer.undo(); w.editor.buffer.set_modified(false); pump();
        ok(w.closeTab(), 'closeTab() failed');
        ok(w.closeTab(), 'the last closeTab() failed');
    });

    // ---------- Tab restoration ----------
    section('Tab restoration');
    const ch3 = put('chapter-3.md', '# Chapter Three\n\nSecond line.\n\nThird line targeted by the cursor.\n');
    const settingsFor = (extra: Partial<AppSettings>): AppSettings => AppSettings.inMemory({ welcomed: true, home: false, dark: false, autosave: false, ...extra });
    // The second window re-registers the app actions; destroy it and then restore the actions to the main test window.
    const closeWindow = (win: MainWindow) => {
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };
    const opened = (win: MainWindow) => {
        const files: (string | null)[] = [];
        for (let i = 0; i < win.documentCount; i++) { win.switchTab(1); files.push(win.file); }
        return files;
    };

    test('closing the window records the tabs with files, their order, the active tab, and its cursor', () => {
        const s = settingsFor({});
        const w2 = new MainWindow(c.app, s, null); settle();
        w2.openFile(ch1); settle();
        w2.newDocument(); settle();
        w2.editor.buffer.insert_at_cursor('without a file', -1);
        w2.editor.buffer.set_modified(false);   // a document without a file: not recorded, no dialog
        w2.openFile(ch3); settle();
        w2.editor.restoreCursor(20); settle();
        w2.openFile(ch2); settle();
        w2.switchTab(-1); settle();   // chapter-3 is active (tab order: chapter-1, empty, chapter-3, chapter-2)
        ok(w2.onClose(), 'onClose() refused to close');
        eq(s.tabs.map(t => t.file), [ch1, ch3, ch2], 'recorded tabs');
        eq(s.activeTab, 1, 'active tab');
        eq(s.tabs[1].cursor, 20, 'cursor of chapter-3');
        closeWindow(w2);
    });
    test('opening without arguments restores the tabs, the active tab, and the cursor', () => {
        const s = settingsFor({ tabs: [{ file: ch1, cursor: 0 }, { file: ch3, cursor: 20 }, { file: ch2, cursor: 3 }], activeTab: 1 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.documentCount, 3, 'number of tabs');
        eq(w2.file, ch3, 'active tab');
        eq(w2.editor.cursorOffset, 20, 'cursor of the active tab');
        ok(!w2.editor.buffer.get_modified(), 'the restored document was marked as modified');
        eq(opened(w2), [ch2, ch1, ch3], 'tab order');   // starting from the tab after chapter-3
        closeWindow(w2);
    });
    test('a missing file is skipped and not recreated', () => {
        const missing = path('missing.md');
        const s = settingsFor({ tabs: [{ file: missing,  cursor: 0 }, { file: ch2, cursor: 0 }], activeTab: 0 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.documentCount, 1, 'number of tabs');
        eq(w2.file, ch2, 'the active tab falls back to the existing tab');
        ok(!GLib.file_test(missing,  GLib.FileTest.EXISTS), 'the missing file was recreated');
        ok(w2.lastToast.includes('not found'), `status: ${w2.lastToast}`);
        closeWindow(w2);
    });
    test('a cursor outside the document is clamped to the end', () => {
        const s = settingsFor({ tabs: [{ file: ch1, cursor: 99999 }], activeTab: 0 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.editor.cursorOffset, w2.editor.buffer.get_char_count(), 'cursor');
        closeWindow(w2);
    });
    test('a file from an argument does not restore the last tabs', () => {
        const s = settingsFor({ tabs: [{ file: ch1, cursor: 0 }, { file: ch2, cursor: 0 }], activeTab: 0 });
        const w2 = new MainWindow(c.app, s, ch3); settle();
        eq(w2.documentCount, 1, 'number of tabs');
        eq(w2.file, ch3, 'file');
        closeWindow(w2);
    });
    test('a tab without a file and an active index outside the list are ignored', () => {
        const s = settingsFor({ tabs: [{ file: '', cursor: 0 }, { file: path('missing-2.md'), cursor: 0 }], activeTab: 5 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.documentCount, 1, 'number of tabs');
        eq(w2.file, null, 'file');
        closeWindow(w2);
    });

    w.file = null;
    c.setText('');
}
