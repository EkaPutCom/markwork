// Asking the frontend (docs/design/protocol.md, section 7): every dialog a controller is given becomes one request, and
// its answer is read here. A refusal, a frontend that does not know the question yet (`unknown_op`), a withdrawn ask, or
// an answer of the wrong shape all count as the dialog's "no": the code that asked goes on as if the user dismissed it.

import type { CancelSignal } from '../../platform/index';
import type { ChooseFileOptions, Prompt, Question } from '../dialogs';
import type { Wire } from './messages';

export class Asks {
    constructor(private readonly wire: Wire) {}

    // read gives the answer from the reply, or undefined when the reply does not hold one.
    async ask<T>(op: string, payload: Record<string, unknown>, read: (reply: Record<string, unknown>) => T | undefined, dismissed: T,
        cancel?: CancelSignal): Promise<T> {
        const reply = await this.wire.request(op, payload, cancel);
        if (!reply.ok) return dismissed;
        return read(reply) ?? dismissed;
    }

    // A yes-or-no question: `{question}`, answered `{answer: true}` for yes.
    question(op: string, question: Question, cancel?: CancelSignal): Promise<boolean> {
        return this.ask(op, { question }, r => r.answer === true, false, cancel);
    }

    // One line of text: `{prompt}`, answered `{text}`; null = dismissed.
    text(op: string, prompt: Prompt, cancel?: CancelSignal): Promise<string | null> {
        return this.ask<string | null>(op, { prompt }, r => typeof r.text === 'string' ? r.text : undefined, null, cancel);
    }

    // One of a fixed set of answers: `{answer}`; anything else is `dismissed`.
    choice<T extends string>(op: string, payload: Record<string, unknown>, answers: readonly T[], dismissed: T): Promise<T> {
        return this.ask(op, payload, r => answers.includes(r.answer as T) ? r.answer as T : undefined, dismissed);
    }

    // The frontend's file chooser: `{path}`; null = cancelled.
    file(options: ChooseFileOptions): Promise<string | null> {
        return this.ask<string | null>('ask.file', { ...options }, r => typeof r.path === 'string' && r.path !== '' ? r.path : undefined, null);
    }
}
