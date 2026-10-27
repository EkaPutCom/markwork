// What a group of request handlers is given: the connection, the session it serves, and a way to listen to one notice.
// The handlers are split per controller (docs/design/electron-migrasi.md, phase 0), so a feature that gets its messages
// adds one file here and one line to the server, and two features carried over at once do not edit the same lines.

import type { AppSession } from '../../session';
import type { ProtocolFrontend } from '../frontend';
import { RequestError } from '../messages';
import type { ProtocolEditor } from '../replica';
import type { Connection } from '../wire';

export interface HandlerContext {
    readonly wire: Connection;
    readonly session: AppSession<ProtocolEditor>;
    readonly frontend: ProtocolFrontend;
    // The setting keys the frontend may read and write (the schema's); empty = any key the store accepts.
    readonly settingKeys: readonly string[];
    // Listen to a notice from the frontend; one listener per event.
    notice(ev: string, listener: (payload: Record<string, unknown>) => void): void;
    // Send the file list of the work folder (view.files).
    sendFiles(): void;
    // Run when the server is disposed.
    onDispose(stop: () => void): void;
}

export const num = (v: unknown, what: string): number => {
    if (typeof v !== 'number') throw new RequestError('bad_request', `${what} must be a number`);
    return v;
};

export const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new RequestError('bad_request', `${what} must be a string`);
    return v;
};
