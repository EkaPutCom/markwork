// User settings with typed properties, on top of a SettingsStore (platform/index.ts). The app's store is a JSON file
// checked against the keys of settingskeys.ts (platform/node/settings.ts).
//
// Other code writes `settings.autosave = true`; every write is saved immediately, there is no save(). Code that reacts to a
// change listens with onChanged().

import type { RecentFile } from '../markdown/home';
import type { SettingValue, SettingsStore } from '../platform/index';

// File-backed tabs that were open when the last window was closed, restored on the next launch.
export interface SavedTab {
    file: string;
    cursor: number;          // cursor position (code points)
}

export type SidebarPage = 'files' | 'search' | 'history' | 'collab';

// Between a folder and a project name in the keys of the project maps (a character no folder or project name has).
const SCOPE_SEPARATOR = '\u001f';
const SCOPED_KEYS = ['projects', 'project-options', 'machine-projects'] as const;

export class AppSettings {
    constructor(readonly store: SettingsStore) {}

    // listener gets the changed key; keys = only those. Returns a function that stops listening.
    onChanged(keys: readonly string[] | null, listener: (key: string) => void): () => void {
        return this.store.onChanged(key => { if (!keys || keys.includes(key)) listener(key); });
    }

    private bool(key: string): boolean { return this.store.get(key) as boolean; }
    private str(key: string): string { return this.store.get(key) as string; }
    private num(key: string): number { return this.store.get(key) as number; }
    private map(key: string): Record<string, string> { return { ...this.store.get(key) as Record<string, string> }; }
    private set(key: string, value: SettingValue): void { this.store.set(key, value); }

    // null = follow the system theme.
    get dark(): boolean | null {
        const scheme = this.str('color-scheme');
        return scheme === 'system' ? null : scheme === 'dark';
    }
    set dark(value: boolean | null) { this.set('color-scheme', value === null ? 'system' : value ? 'dark' : 'light'); }

    get sidebar(): boolean { return this.bool('sidebar'); }
    set sidebar(value: boolean) { this.set('sidebar', value); }
    get timelineOpen(): boolean { return this.bool('timeline-open'); }
    set timelineOpen(value: boolean) { this.set('timeline-open', value); }
    get sidebarPage(): SidebarPage { return this.str('sidebar-page') as SidebarPage; }
    set sidebarPage(value: SidebarPage) { this.set('sidebar-page', value); }

    // Collaboration: how often to ask the forge for pull requests, and whether a new one raises a desktop notification.
    get forgePollSeconds(): number { return this.num('forge-poll-seconds'); }
    set forgePollSeconds(value: number) { this.set('forge-poll-seconds', value); }
    get forgeNotify(): boolean { return this.bool('forge-notify'); }
    set forgeNotify(value: boolean) { this.set('forge-notify', value); }
    get chat(): boolean { return this.bool('chat'); }
    set chat(value: boolean) { this.set('chat', value); }
    get chatModel(): string { return this.str('chat-model'); }
    set chatModel(value: string) { this.set('chat-model', value); }
    get chatThinking(): boolean { return this.bool('chat-thinking'); }
    set chatThinking(value: boolean) { this.set('chat-thinking', value); }
    get chatSave(): boolean { return this.bool('chat-save'); }
    set chatSave(value: boolean) { this.set('chat-save', value); }
    get typewriter(): boolean { return this.bool('typewriter'); }
    set typewriter(value: boolean) { this.set('typewriter', value); }
    get visual(): boolean { return this.bool('visual'); }
    set visual(value: boolean) { this.set('visual', value); }
    get focus(): boolean { return this.bool('focus'); }
    set focus(value: boolean) { this.set('focus', value); }
    get autosave(): boolean { return this.bool('autosave'); }
    set autosave(value: boolean) { this.set('autosave', value); }
    get home(): boolean { return this.bool('home'); }
    set home(value: boolean) { this.set('home', value); }
    get welcomed(): boolean { return this.bool('welcomed'); }
    set welcomed(value: boolean) { this.set('welcomed', value); }
    get width(): number { return this.num('width'); }
    set width(value: number) { this.set('width', Math.round(value)); }
    get height(): number { return this.num('height'); }
    set height(value: number) { this.set('height', Math.round(value)); }
    get activeTab(): number { return this.num('active-tab'); }
    set activeTab(value: number) { this.set('active-tab', value); }

    // Last folder; null = none.
    get folder(): string | null { return this.str('folder') || null; }
    set folder(value: string | null) { this.set('folder', value ?? ''); }

    get tabs(): SavedTab[] {
        return (this.store.get('tabs') as [string, number][]).map(([file, cursor]) => ({ file, cursor }));
    }
    set tabs(value: SavedTab[]) { this.set('tabs', value.map(t => [t.file, t.cursor] as [string, number])); }

    get recentFiles(): RecentFile[] {
        return (this.store.get('recent-files') as [string, number][]).map(([path, time]) => ({ path, time: Number(time) }));
    }
    set recentFiles(value: RecentFile[]) { this.set('recent-files', value.map(r => [r.path, r.time] as [string, number])); }

    // Projects belong to the work folder: each folder is a world of its own. The three maps below keep every folder's entries in
    // one settings map, under keys that start with the folder and SCOPE_SEPARATOR. Entries without a separator are the
    // ones from before projects were per folder (and what a window without a folder sees).
    workspace: string | null = null;
    get projects(): Record<string, string> { return this.scoped('projects'); }
    set projects(value: Record<string, string>) { this.setScoped('projects', value); }
    get projectOptions(): Record<string, string> { return this.scoped('project-options'); }
    set projectOptions(value: Record<string, string>) { this.setScoped('project-options', value); }
    get machineProjects(): Record<string, string> { return this.scoped('machine-projects'); }
    set machineProjects(value: Record<string, string>) { this.setScoped('machine-projects', value); }

    // The work folder changed. A folder seen for the first time starts with a copy of the projects there were before, so
    // nothing stops working; from then on its projects are its own.
    useWorkspace(root: string | null): void {
        this.workspace = root;
        if (!root) return;
        const marker = root + SCOPE_SEPARATOR;
        const seen = this.map('projects');
        if (marker in seen) return;
        for (const key of SCOPED_KEYS) {
            const all = this.map(key);
            const legacy = Object.entries(all).filter(([k]) => !k.includes(SCOPE_SEPARATOR));
            this.set(key, { ...all, ...Object.fromEntries(legacy.map(([k, v]) => [marker + k, v])), ...(key === 'projects' ? { [marker]: '' } : {}) });
        }
    }

    private scope(): string { return this.workspace ? this.workspace + SCOPE_SEPARATOR : ''; }

    private scoped(key: string): Record<string, string> {
        const prefix = this.scope();
        return Object.fromEntries(Object.entries(this.map(key)).flatMap(([k, v]) =>
            (prefix ? k.startsWith(prefix) : !k.includes(SCOPE_SEPARATOR)) && k !== prefix ? [[k.slice(prefix.length), v]] : []));
    }

    private setScoped(key: string, value: Record<string, string>): void {
        const prefix = this.scope();
        const others = Object.entries(this.map(key)).filter(([k]) => (prefix ? !k.startsWith(prefix) : k.includes(SCOPE_SEPARATOR)) || k === prefix);
        this.set(key, { ...Object.fromEntries(others), ...Object.fromEntries(Object.entries(value).map(([k, v]) => [prefix + k, v])) });
    }

    // Where harnesses run: '' = children of this window, 'local' = the markworkd daemon on this computer, otherwise
    // the name of an SSH machine in `machines`.
    get harnessMachine(): string { return this.str('harness-machine'); }
    set harnessMachine(value: string) { this.set('harness-machine', value); }
    get machines(): Record<string, string> { return this.map('machines'); }
    set machines(value: Record<string, string>) { this.set('machines', value); }
    get daemonCommand(): string { return this.str('daemon-command'); }
    set daemonCommand(value: string) { this.set('daemon-command', value); }
    get setupHidden(): string { return this.str('setup-hidden'); }
    set setupHidden(value: string) { this.set('setup-hidden', value); }
}

// The properties a test or a screenshot may preset.
export type SettingOverrides = Partial<Omit<AppSettings, 'store' | 'onChanged'>>;
