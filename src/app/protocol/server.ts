// The core's end of the protocol: builds the AppSession over a ProtocolFrontend and answers what the frontend sends
// (docs/design/protocol.md, sections 4.5 to 6). One server serves one window.

import type { AppSettings } from '../../settings.js';
import { insideName, onDiskChange } from '../../files.js';
import { platform } from '../../platform/index.js';
import { AppSession } from '../session.js';
import { COMMANDS, type FrontendCommands } from '../commands.js';
import type { NoteEdit } from '../../markdown/noteedit.js';
import { ProtocolFrontend } from './frontend.js';
import { RequestError, type Change, type Message } from './messages.js';
import type { ProtocolEditor } from './replica.js';
import { unwired } from './unwired.js';
import { Connection } from './wire.js';

export const PROTOCOL_VERSION = 1;

// The editor's own commands never reach the core; session.commands() wants the frontend's half, which has nothing to do here.
const NO_FRONTEND_COMMANDS = unwired<FrontendCommands>({});

const num = (v: unknown, what: string): number => {
    if (typeof v !== 'number') throw new RequestError('bad_request', `${what} must be a number`);
    return v;
};
const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new RequestError('bad_request', `${what} must be a string`);
    return v;
};

export class ProtocolServer {
    readonly wire: Connection;
    readonly frontend: ProtocolFrontend;
    readonly session: AppSession<ProtocolEditor>;
    private filesTimer: (() => void) | null = null;
    private readonly stops: (() => void)[] = [];

    constructor(settings: AppSettings, post: (message: Message) => void) {
        this.wire = new Connection(post, 'c');
        this.frontend = new ProtocolFrontend(settings, this.wire);
        this.session = new AppSession(this.frontend);
        this.frontend.edited = id => this.session.edited(id);
        this.frontend.folderOpened = () => this.sendFiles();
        this.handlers();
        this.stops.push(onDiskChange(() => this.queueFiles()));
    }

    receive(message: Message): void {
        this.wire.receive(message);
    }

    dispose(): void {
        this.filesTimer?.();
        for (const stop of this.stops.splice(0)) stop();
        this.session.dispose();
    }

    private handlers(): void {
        const { wire, session } = this;
        wire.on('hello', p => {
            if (p.proto !== PROTOCOL_VERSION) throw new RequestError('proto', `this core speaks protocol ${PROTOCOL_VERSION}`);
            return { proto: PROTOCOL_VERSION, core: 'markwork' };
        });
        // Open the tabs of the last session, or the path the frontend was started with.
        wire.on('start', p => {
            session.start();
            session.open(typeof p.path === 'string' ? p.path : null);
            this.sendFiles();
        });
        // A folder the user chose in a dialog of the frontend.
        wire.on('open.folder', async p => {
            await session.openFolder(str(p.path, 'path'));
            this.sendFiles();
        });
        // A file of the list the core sent (view.files).
        wire.on('open.file', p => {
            const root = session.files.root;
            const path = root && platform().paths.join(root, str(p.name, 'name'));
            if (!root || !path || insideName(root, path) === null) throw new RequestError('bad_request', 'that file is not in the work folder');
            session.documents.openInTab(path);
        });
        wire.on('tab.select', p => { session.documents.select(num(p.doc, 'doc')); });
        wire.on('tab.close', async p => ({ closed: await session.documents.closeById(num(p.doc, 'doc')) }));
        wire.on('act.notes.edit', p => {
            const edit = p.edit as NoteEdit | undefined;
            if (!edit || typeof edit.kind !== 'string') throw new RequestError('bad_request', 'edit is missing');
            session.host.board.onEdit(edit);
        });
        wire.on('act.token', p => { session.toastActivated(num(p.token, 'token')); });
        // A command of the table (app/commands.ts) that the core carries out; the editor's own (`runs: "editor"`) never get here.
        wire.on('command', async p => {
            const command = COMMANDS.find(c => c.id === p.name && c.runs === 'core');
            if (!command) throw new RequestError('unknown_command', `no such command: ${String(p.name)}`);
            await command.run(session.commands(NO_FRONTEND_COMMANDS), p.arg as boolean | string | undefined);
        });
        wire.onNotice((ev, p) => {
            if (ev === 'doc.edit') this.frontend.editors.get(num(p.doc, 'doc'))?.receiveEdit(num(p.version, 'version'), p.modified === true, p.changes as Change[]);
            else if (ev === 'doc.cursor') this.frontend.editors.get(num(p.doc, 'doc'))?.receiveCursor(num(p.version, 'version'), num(p.offset, 'offset'), (p.selection as [number, number] | null) ?? null);
            else if (ev === 'window.active') session.windowFocused(p.active === true);
        });
    }

    // Files changed (the app's own writes arrive here at once): send the list once the burst is over.
    private queueFiles(): void {
        if (this.filesTimer) return;
        this.filesTimer = platform().scheduler.idleAfter(150, () => { this.filesTimer = null; this.sendFiles(); });
    }

    // The Markdown files of the work folder, for the frontend's list. Sent after the folder opens and after files change.
    sendFiles(): void {
        const root = this.session.files.root;
        if (!root) return;
        this.wire.notify('view.files', { root, files: this.session.workspace.names(root) });
    }
}
