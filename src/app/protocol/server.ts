// The core's end of the protocol: builds the AppSession over a ProtocolFrontend and answers what the frontend sends
// (docs/design/protocol.md, sections 4.5 to 6). One server serves one window. The requests and notices it answers are
// in handlers/, one file per controller; this file only puts them together.

import type { AppSettings } from '../../base/settings.js';
import { onDiskChange } from '../../base/files.js';
import { platform } from '../../platform/index.js';
import { AppSession } from '../session.js';
import { ProtocolFrontend } from './frontend.js';
import type { Message } from './messages.js';
import type { ProtocolEditor } from './replica.js';
import { Connection } from './wire.js';
import type { HandlerContext } from './handlers/context.js';
import { commandHandlers } from './handlers/commands.js';
import { documentHandlers } from './handlers/documents.js';
import { notesHandlers } from './handlers/notes.js';
import { homeHandlers } from './handlers/home.js';
import { preferencesHandlers } from './handlers/preferences.js';
import { outlineHandlers } from './handlers/outline.js';
import { searchHandlers } from './handlers/search.js';
import { treeHandlers } from './handlers/tree.js';
import { sessionHandlers } from './handlers/session.js';
import { chatHandlers } from './handlers/chat.js';
import { historyHandlers } from './handlers/history.js';
import { collabHandlers } from './handlers/collab.js';
import { harnessHandlers } from './handlers/harness.js';
import { programsHandlers } from './handlers/programs.js';

export { PROTOCOL_VERSION } from './handlers/session.js';

export interface ServerOptions {
    // The setting keys of the schema: sent in `hello`, and the only ones the frontend may write. Without them no setting
    // is sent, and any key the store accepts may be written (tests).
    settingKeys?: readonly string[];
}

export class ProtocolServer {
    readonly wire: Connection;
    readonly frontend: ProtocolFrontend;
    readonly session: AppSession<ProtocolEditor>;
    private filesTimer: (() => void) | null = null;
    private readonly stops: (() => void)[] = [];
    private readonly notices = new Map<string, (payload: Record<string, unknown>) => void>();

    constructor(settings: AppSettings, post: (message: Message) => void, options: ServerOptions = {}) {
        this.wire = new Connection(post, 'c');
        this.frontend = new ProtocolFrontend(settings, this.wire);
        this.session = new AppSession(this.frontend);
        this.frontend.edited = id => this.session.edited(id);
        this.frontend.headingsChanged = id => this.session.headingsChanged(id);
        this.frontend.folderOpened = () => this.sendFiles();

        const context: HandlerContext = {
            wire: this.wire, session: this.session, frontend: this.frontend,
            settingKeys: options.settingKeys ?? [],
            notice: (ev, listener) => { this.notices.set(ev, listener); },
            sendFiles: () => this.sendFiles(),
            onDispose: stop => { this.stops.push(stop); },
        };
        for (const handlers of [sessionHandlers, documentHandlers, notesHandlers, outlineHandlers, searchHandlers, treeHandlers, homeHandlers, programsHandlers, preferencesHandlers, chatHandlers, historyHandlers, collabHandlers, harnessHandlers, commandHandlers]) handlers(context);
        this.wire.onNotice((ev, payload) => this.notices.get(ev)?.(payload));
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
