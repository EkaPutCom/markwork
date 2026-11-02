// Native shell writes bypass editor locks. Detect changes, preserve dirty buffers, and gate saves until explicit resolution.
import { flushWrites, insideName, readTextFile } from '../base/files';
import { platform } from '../platform/index';
import type { Doc, DocumentHost, TextEditor } from './document';

interface Observed { path: string; root: string; disk: string | null; conflict: boolean; target: string | null }

export class FolderDiskController<E extends TextEditor> {
    private readonly roots = new Set<string>();
    private readonly observed = new Map<number, Observed>();
    private readonly watches = new Map<string, () => void>();
    private refreshStop: (() => void) | null = null;
    constructor(private readonly host: DocumentHost<E>, private readonly changed: () => void) {}

    start(root: string): void { this.roots.add(root); this.refresh(root); }
    private read(path: string): string | null {
        try { return readTextFile(path); } catch { return null; }
    }
    observe(doc: Doc<E>): void {
        const path = doc.file;
        const root = path && [...this.roots].find(item => insideName(item, path) !== null);
        if (!path || !root) return;
        let observed = this.observed.get(doc.id);
        if (!observed || !platform().paths.same(observed.path, path)) {
            observed = { path, root, disk: this.read(path), conflict: false, target: null };
            this.observed.set(doc.id, observed);
            this.watch(platform().paths.dirname(path));
        }
        if (observed.target !== null && doc.editor.getText() === observed.target) {
            observed.target = null;
            doc.editor.setModified(false);
        }
        this.check(doc, observed);
    }

    private watch(dir: string): void {
        if (this.watches.has(dir)) return;
        try {
            this.watches.set(dir, platform().fs.watchDir(dir, () => {
                this.refreshStop?.();
                this.refreshStop = platform().scheduler.idleAfter(80, () => { for (const root of this.roots) this.refresh(root); });
            }));
        } catch { /* Tool completion also refreshes when a directory cannot be monitored. */ }
    }

    refresh(root: string): void {
        for (const doc of this.host.docs()) if (doc.file && insideName(root, doc.file) !== null) this.observe(doc);
        this.changed();
    }

    private check(doc: Doc<E>, observed: Observed): void {
        if (observed.target !== null) return;
        const disk = this.read(observed.path);
        if (disk === observed.disk) return;
        if (disk === doc.editor.getText()) { observed.disk = disk; return; }
        if (doc.editor.isModified() || disk === null) { this.conflict(observed, disk); return; }
        const before = doc.editor.getText();
        observed.target = disk;
        doc.editor.update(current => {
            if (current !== before || doc.editor.isModified()) { observed.target = null; this.conflict(observed, disk); return null; }
            observed.disk = disk;
            return disk;
        });
    }

    private conflict(observed: Observed, disk: string | null): void {
        if (!observed.conflict) this.host.toast('A file changed on disk while you were editing. Your draft is preserved. Resolve the conflict from the agent Sessions panel before saving.');
        observed.conflict = true;
        observed.disk = disk;
        this.changed();
    }

    canSave(doc: Doc<E>): boolean {
        const observed = this.observed.get(doc.id);
        if (!observed || !doc.file || !platform().paths.same(observed.path, doc.file)) return true;
        this.check(doc, observed);
        return !observed.conflict && observed.target === null;
    }

    conflicts(root: string): { path: string; name: string }[] {
        const open = new Set(this.host.docs().map(doc => doc.id));
        return [...this.observed].filter(([id, item]) => open.has(id) && item.root === root && item.conflict).map(([, item]) => ({ path: item.path, name: insideName(root, item.path) || item.path }));
    }

    resolve(path: string, choice: 'reload' | 'keep'): void {
        const doc = this.host.docs().find(item => item.file && platform().paths.same(item.file, path));
        const observed = doc && this.observed.get(doc.id);
        if (!doc || !observed?.conflict) throw Error('This conflict is no longer available');
        flushWrites(path);
        const disk = this.read(path);
        if (disk !== observed.disk) { observed.disk = disk; this.changed(); throw Error('The file changed again. Review the conflict before resolving it.'); }
        if (choice === 'keep') { observed.conflict = false; this.changed(); return; }
        if (disk === null) throw Error('The file was removed or cannot be read. Keep your draft and save it to another file.');
        const before = doc.editor.getText();
        observed.target = disk;
        doc.editor.update(current => {
            if (current !== before) { observed.target = null; this.changed(); return null; }
            observed.conflict = false;
            this.changed();
            return disk;
        });
    }

    dispose(): void {
        this.refreshStop?.();
        for (const stop of this.watches.values()) stop();
        this.watches.clear(); this.observed.clear(); this.roots.clear();
    }
}
