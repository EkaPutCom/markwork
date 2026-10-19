// One end of the connection: ids, replies, and the order of messages (docs/design/protocol.md, 4.2 and 4.3). It knows
// nothing of documents or views; it carries objects to `post` and hands what arrives to its handlers.

import { RequestError, isReply, isRequest, type Message, type Reply, type Wire } from './messages.js';

type Handler = (params: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export class Connection implements Wire {
    private nextId = 1;
    private readonly waiting = new Map<string, (reply: Reply) => void>();
    private readonly handlers = new Map<string, Handler>();
    private noticeHandler: (ev: string, payload: Record<string, unknown>) => void = () => {};

    // prefix: "f" for the frontend and "c" for the core, so an id is unique per sender.
    constructor(private readonly post: (message: Message) => void, private readonly prefix: string) {}

    notify(ev: string, payload: Record<string, unknown> = {}): void {
        this.post({ ...payload, ev });
    }

    request(op: string, payload: Record<string, unknown> = {}): Promise<Reply> {
        const id = `${this.prefix}${this.nextId++}`;
        return new Promise(resolve => {
            this.waiting.set(id, resolve);
            this.post({ ...payload, id, op });
        });
    }

    on(op: string, handler: Handler): void {
        this.handlers.set(op, handler);
    }

    onNotice(handler: (ev: string, payload: Record<string, unknown>) => void): void {
        this.noticeHandler = handler;
    }

    // Everything that arrives on the connection, in the order it was sent.
    receive(message: Message): void {
        if (isReply(message)) {
            const done = this.waiting.get(message.re);
            this.waiting.delete(message.re);
            done?.(message as Reply);
        } else if (isRequest(message)) {
            void this.answer(message);
        } else {
            const { ev, ...payload } = message;
            this.noticeHandler(ev, payload);
        }
    }

    private async answer(message: Extract<Message, { id: string }>): Promise<void> {
        const { id, op, ...params } = message;
        const handler = this.handlers.get(op);
        if (!handler) {
            this.post({ re: id, ok: false, error: { code: 'unknown_op', message: `no such request: ${op}` } });
            return;
        }
        try {
            this.post({ ...(await handler(params) ?? {}), re: id, ok: true });
        } catch (e) {
            if (e instanceof RequestError) this.post({ ...e.extra, re: id, ok: false, error: { code: e.code, message: e.message } });
            else this.post({ re: id, ok: false, error: { code: 'error', message: e instanceof Error ? e.message : String(e) } });
        }
    }
}
