// One local turn per folder. Changing the selected session never owns or cancels this queue.
interface Task { id: string; root: string; work: () => Promise<void>; resolve(): void; reject(error: unknown): void }
export class FolderTurnQueue {
    private readonly active = new Map<string, string>();
    private readonly waiting: Task[] = [];
    busy(root: string): boolean { return this.active.has(root); }
    run(root: string, id: string, work: () => Promise<void>): Promise<void> {
        if ([...this.active.values()].includes(id) || this.waiting.some(task => task.id === id)) return Promise.reject(Error('This session already has a queued turn'));
        return new Promise((resolve, reject) => {
            const task = { root, id, work, resolve, reject };
            if (this.active.has(root)) this.waiting.push(task);
            else this.start(task);
        });
    }
    private start(task: Task): void {
        this.active.set(task.root, task.id);
        void task.work().then(task.resolve, task.reject).finally(() => {
            this.active.delete(task.root);
            const next = this.waiting.findIndex(item => item.root === task.root);
            if (next >= 0) this.start(this.waiting.splice(next, 1)[0]);
        });
    }
    cancel(id: string): boolean {
        const at = this.waiting.findIndex(task => task.id === id);
        if (at < 0) return false;
        this.waiting.splice(at, 1)[0].resolve();
        return true;
    }
    clear(): void { for (const task of this.waiting.splice(0)) task.resolve(); }
}
