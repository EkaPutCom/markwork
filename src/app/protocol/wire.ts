// One end of the connection: ids, replies, and the order of messages (docs/design/protocol.md, 4.2 and 4.3). It knows
// nothing of documents or views; it carries objects to `post` and hands what arrives to its handlers. It also carries
// `ask.cancel` (section 7) both ways: a request it sent can be withdrawn, and a request it is answering can be withdrawn
// by the other side, in which case its answer is not sent.

import { Cancellable } from '../../base/cancel.js';
import type { CancelSignal } from '../../platform/index.js';
import { CANCELLED, RequestError, isReply, isRequest, type Message, type Reply, type Wire } from './messages.js';

// cancel fires when the other side withdraws the request (the dialog it opened should close); the answer is then dropped.
export type Handler = (params: Record<string, unknown>, cancel: CancelSignal) =>
    Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export class Connection implements Wire {
    private nextId = 1;
    private readonly waiting = new Map<string, (reply: Reply) => void>();
    private readonly handlers = new Map<string, Handler>();
    // Answers a request no handler of its own is for (a frontend's generic question dialog); without one it is unknown_op.
    private fallback: ((op: string) => Handler | null) | null = null;
    // The requests of the other side that are being answered, by id.
    private readonly answering = new Map<string, Cancellable>();
    private noticeHandler: (ev: string, payload: Record<string, unknown>) => void = () => {};

    // prefix: "f" for the frontend and "c" for the core, so an id is unique per sender.
    constructor(private readonly post: (message: Message) => void, private readonly prefix: string) {}

    notify(ev: string, payload: Record<string, unknown> = {}): void {
        this.post({ ...payload, ev });
    }

    request(op: string, payload: Record<string, unknown> = {}, cancel?: CancelSignal): Promise<Reply> {
        const id = `${this.prefix}${this.nextId++}`;
        return new Promise(resolve => {
            if (cancel?.cancelled) { resolve(CANCELLED); return; }
            const stop = cancel?.onCancel(() => {
                if (!this.waiting.delete(id)) return;
                this.notify('ask.cancel', { ask: id });
                resolve(CANCELLED);
            });
            this.waiting.set(id, reply => { stop?.(); resolve(reply); });
            this.post({ ...payload, id, op });
        });
    }

    on(op: string, handler: Handler): void {
        this.handlers.set(op, handler);
    }

    // which gives the handler for an op that has none of its own, or null when it does not take that op either.
    onOther(which: (op: string) => Handler | null): void {
        this.fallback = which;
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
            // A withdrawn request that is already answered is not one of `answering`: nothing happens (section 7).
            if (ev === 'ask.cancel') this.answering.get(String(payload.ask))?.cancel();
            else this.noticeHandler(ev, payload);
        }
    }

    private async answer(message: Extract<Message, { id: string }>): Promise<void> {
        const { id, op, ...params } = message;
        const handler = this.handlers.get(op) ?? this.fallback?.(op);
        if (!handler) {
            this.post({ re: id, ok: false, error: { code: 'unknown_op', message: `no such request: ${op}` } });
            return;
        }
        const cancel = new Cancellable();
        this.answering.set(id, cancel);
        let reply: Message;
        try {
            reply = { ...(await handler(params, cancel) ?? {}), re: id, ok: true };
        } catch (e) {
            if (e instanceof RequestError) reply = { ...e.extra, re: id, ok: false, error: { code: e.code, message: e.message } };
            else reply = { re: id, ok: false, error: { code: 'error', message: e instanceof Error ? e.message : String(e) } };
        }
        this.answering.delete(id);
        if (!cancel.cancelled) this.post(reply);
    }
}
