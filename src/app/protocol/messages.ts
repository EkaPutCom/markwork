// The shapes that cross the line between the core and a frontend (docs/design/protocol.md, section 4.2). Plain data only:
// the same objects are posted over a MessagePort, or written as JSON lines for a sidecar.
//
//   request  { id, op, ...params }        answered by a reply
//   reply    { re, ok, ...result }        or { re, ok: false, error: { code, message }, ...extra }
//   notice   { ev, ...payload }           no reply

export interface Change {
    from: number;      // code points from the start of the text, before the change
    to: number;
    insert: string;
}

export interface ProtocolError {
    code: string;
    message: string;
}

export type Message =
    | { id: string; op: string; [field: string]: unknown }
    | { re: string; ok: boolean; error?: ProtocolError; [field: string]: unknown }
    | { ev: string; [field: string]: unknown };

export type Reply = { ok: true; [field: string]: unknown } | { ok: false; error: ProtocolError; [field: string]: unknown };

export const isRequest = (m: Message): m is Extract<Message, { id: string }> => 'id' in m;
export const isReply = (m: Message): m is Extract<Message, { re: string }> => 're' in m;

// A handler refuses a request with a code the other side can act on (conflict, stale, unknown_op, …).
export class RequestError extends Error {
    constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
    }
}

// What the replica and the server need from the connection: send a notice, or send a request and wait for its reply.
export interface Wire {
    notify(ev: string, payload?: Record<string, unknown>): void;
    request(op: string, payload?: Record<string, unknown>): Promise<Reply>;
}
