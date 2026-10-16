// Cancelling work that is in flight (a model request, a proposal waiting for review, a commit message being written).
// Plain TypeScript, so the core needs no Gio.Cancellable; the GJS platform links one to it where GIO does the work.

import type { CancelSignal } from './platform/index.js';

export class Cancellable implements CancelSignal {
    private listeners = new Set<() => void>();
    private done = false;

    get cancelled(): boolean { return this.done; }

    // Cancels once: later calls do nothing. Listeners run right away, in the order they were added.
    cancel(): void {
        if (this.done) return;
        this.done = true;
        const listeners = [...this.listeners];
        this.listeners.clear();
        for (const listener of listeners) listener();
    }

    // Runs listener once when cancelled, or at once when it already is (like Gio.Cancellable.connect). Returns a function
    // that removes it; that is safe to call from inside the listener.
    onCancel(listener: () => void): () => void {
        if (this.done) {
            listener();
            return () => {};
        }
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
}
