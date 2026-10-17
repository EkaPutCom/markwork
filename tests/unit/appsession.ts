// The command registry and the application session without GTK: the same list runs on GJS and on Node.

import { AppSettings } from '../../src/settings.js';
import type { SettingValue } from '../../src/platform/index.js';
import { COMMANDS, COMMAND_LABELS, commandEnabled, commandIds, type CommandHost, type EditCommands } from '../../src/app/commands.js';
import { AppSession, type AppFrontend, type FrontendHost } from '../../src/app/session.js';
import type { TextEditor } from '../../src/app/document.js';
import { addCard } from '../../src/markdown/kanban.js';
import { section, test, eq, ok, tmp, disk, pause } from '../framework.js';

// A settings store in memory; the keys the application layer reads at startup have a value, any other reads as empty.
export function memorySettings(): AppSettings {
    const values = new Map<string, SettingValue>([['tabs', []], ['recent-files', []], ['projects', {}], ['machines', {}], ['project-options', {}], ['machine-projects', {}]]);
    const listeners = new Set<(key: string) => void>();
    return new AppSettings({
        get: key => values.get(key) ?? '',
        set: (key, value) => { values.set(key, value); for (const l of listeners) l(key); },
        onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    });
}

export class FakeEditor implements TextEditor {
    text = '';
    modified = false;
    readonly headings = [];
    readonly cursorOffset = 0;
    readonly cursorLine = 0;
    readonly selection = '';
    getText(): string { return this.text; }
    setText(text: string): void { this.text = text; this.modified = false; }
    replaceText(text: string): void { this.text = text; this.modified = true; }
    insertAtCursor(text: string): void { this.text += text; this.modified = true; }
    update(edit: (text: string) => string | null): void { const next = edit(this.text); if (next !== null) this.replaceText(next); }
    isModified(): boolean { return this.modified; }
    setModified(modified: boolean): void { this.modified = modified; }
    jumpToLine(): void {}
    setMode(): void {}
    restoreCursor(): void {}
}

// An editor whose writes land one turn later, the way they will over the app protocol: there the core's replica only
// changes once the frontend has applied a write (docs/design/protocol.md, 5.4 and 5.5). Reading the text while a write
// is still on its way throws, so a controller that reads back its own write in the same turn fails here, on Node, long
// before a second frontend exists. Opening a file (setText) is not a write the frontend can refuse, so it lands at once.
export class LaggingEditor extends FakeEditor {
    private pending: string | null = null;
    private readonly waiting: ((text: string) => string | null)[] = [];
    override getText(): string {
        if (this.pending !== null) throw new Error('read the text while a write to it had not landed (docs/design/protocol.md 5.5)');
        return this.text;
    }
    // A whole text computed while a write is on its way would undo that write; update() is the way to follow one.
    override replaceText(text: string): void {
        if (this.pending !== null) throw new Error('wrote a whole text before the previous write had landed; use update() (docs/design/protocol.md 5.5)');
        this.pending = text;
        setTimeout(() => this.land(), 0);
    }
    override insertAtCursor(text: string): void { this.update(t => t + text); }
    // Marking the document saved after writing it (a discard that took the file again) arrives after that write, as messages
    // keep their order (4.3), so it waits behind it instead of being undone when the write lands.
    override setModified(modified: boolean): void {
        if (this.pending === null) { this.modified = modified; return; }
        this.waiting.push(() => { this.modified = modified; return null; });
    }
    // Runs at once when nothing is on its way, otherwise after the write lands, against the text it left.
    override update(edit: (text: string) => string | null): void {
        if (this.pending !== null) { this.waiting.push(edit); return; }
        const next = edit(this.text);
        if (next !== null) this.replaceText(next);
    }
    private land(): void {
        this.text = this.pending!;
        this.pending = null;
        this.modified = true;
        while (this.pending === null && this.waiting.length) this.update(this.waiting.shift()!);
    }
}

// Any member the test does not care about does nothing.
export const quiet = <T extends object>(members: Partial<T>): T => new Proxy(members, { get: (target, key) => key in target ? (target as never)[key] : () => undefined }) as T;

// extra: host members a test sets itself (the work folder, the Assistant panel); root also answers for the documents.
export function fakeFrontend(settings: AppSettings, toasts: string[], makeEditor: () => FakeEditor = () => new FakeEditor(),
                             extra: Partial<FrontendHost<FakeEditor>> = {}): AppFrontend<FakeEditor> {
    return {
        host: quiet<FrontendHost<FakeEditor>>({
            screen: quiet<FrontendHost<FakeEditor>['screen']>({ page: () => 'doc-1' }),
            settings,
            chatPanel: quiet<FrontendHost<FakeEditor>['chatPanel']>({}),
            board: quiet({}), inbox: quiet({}), table: quiet({}), layouts: quiet({}),
            collabPanel: quiet({}), pullView: quiet({}), reviewView: quiet({}), logs: quiet({}),
            root: () => null,
            toast: message => { toasts.push(message); },
            ...extra,
        }),
        documents: quiet<AppFrontend<FakeEditor>['documents']>({
            settings,
            dialogs: quiet({}),
            createEditor: makeEditor,
            root: extra.root ?? (() => null),
            toast: message => { toasts.push(message); },
            tabOrder: () => [1],
        }),
        dialogs: quiet<AppFrontend<FakeEditor>['dialogs']>({}),
    };
}

export async function appSessionTests(): Promise<void> {
    section('Command registry (no GTK)');
    await test('ids are unique, keys are well formed, and the palette order is kept', () => {
        eq(new Set(COMMANDS.map(c => c.id)).size, COMMANDS.length, 'duplicate command id');
        for (const c of COMMANDS) for (const key of c.keys) ok(/^((Ctrl|Alt|Shift)\+)*(\S|[A-Z][A-Za-z0-9]+)$/.test(key), `${c.id}: ${key}`);
        eq(Object.keys(COMMAND_LABELS).slice(0, 3), ['new', 'open', 'open-folder']);
        eq(Object.keys(COMMAND_LABELS).at(-1), 'command-palette');
        ok(!('heading1' in COMMAND_LABELS) && !('layout' in COMMAND_LABELS), 'unlabeled commands stay out of the palette');
    });

    await test('a command is enabled by what the view shows', () => {
        const bold = COMMANDS.find(c => c.id === 'bold')!;
        const save = COMMANDS.find(c => c.id === 'save')!;
        const fields = COMMANDS.find(c => c.id === 'fields-edit')!;
        eq([bold, save, fields].map(c => commandEnabled(c, { home: false, structured: false })), [true, true, false], 'text');
        eq([bold, save, fields].map(c => commandEnabled(c, { home: false, structured: true })), [false, true, true], 'board');
        eq([bold, save, fields].map(c => commandEnabled(c, { home: true, structured: false })), [false, false, false], 'home');
        ok(commandIds('text').includes('heading3') && commandIds('document').includes('layout'), 'scopes');
    });

    await test('a command acts only through the host', () => {
        const calls: string[] = [];
        const edit = quiet<EditCommands>({
            wrap: marker => { calls.push(`wrap ${marker}`); },
            heading: level => { calls.push(`heading ${level}`); },
            table: op => { calls.push(`table ${op}`); },
        });
        const host = quiet<CommandHost>({ edit, switchTab: step => { calls.push(`tab ${step}`); }, setOption: (key, on) => { calls.push(`${key} ${on}`); } });
        const run = (id: string, arg?: boolean | string) => COMMANDS.find(c => c.id === id)!.run(host, arg);
        run('bold'); run('strike'); run('heading2'); run('table-align-center'); run('prev-tab'); run('dark', true); run('source', false);
        eq(calls, ['wrap **', 'wrap ~~', 'heading 2', 'table align-center', 'tab -1', 'dark true', 'source false']);
    });

    section('Application session (no GTK)');
    await test('the session builds the controllers on a frontend and opens a file', () => {
        const toasts: string[] = [];
        const settings = memorySettings();
        const session = new AppSession(fakeFrontend(settings, toasts));
        session.start();
        eq(session.documents.all.length, 1, 'the first document');
        const dir = disk.join(tmp, 'appsession');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'note.md');
        disk.write(file, '# Note\n');
        ok(session.host.openInTab(file), 'openInTab');
        eq(session.documents.active.file, file);
        eq((session.documents.active.editor as FakeEditor).text, '# Note\n');
        eq(session.host.active(), session.documents.active, 'the host answers from the document controller');
        eq(session.host.docs().length, 1, 'the empty first tab was reused');
        ok(session.harness && session.journal && session.collab && session.pulls && session.contribute && session.review && session.homePage, 'controllers');
        session.dispose();
    });

    await test('writes to an open board land even when the editor applies them a turn later', async () => {
        const session = new AppSession(fakeFrontend(memorySettings(), [], () => new LaggingEditor()));
        session.start();
        const dir = disk.join(tmp, 'appsession-lag');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'board.md');
        disk.write(file, '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n');
        ok(session.host.openInTab(file), 'openInTab');
        // Two harness runs that end in the same turn, each moving its own card.
        eq(session.host.updateBoardFile(file, b => addCard(b, 0, 'Two')), null, 'first');
        eq(session.host.updateBoardFile(file, b => addCard(b, 0, 'Three')), null, 'second');
        await pause(5);
        const text = session.documents.active.editor.getText();
        ok(text.includes('- [ ] Two') && text.includes('- [ ] Three'), text);
        session.dispose();
    });
}
