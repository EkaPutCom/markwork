// User settings in GSettings (schema: data/com.ekaput.Markwork.gschema.xml).
//
// AppSettings only wraps Gio.Settings with typed properties, so other code still
// writes `settings.autosave = true`. Every write is saved immediately; there is no save().
// The preferences dialog binds its widgets to the same `gsettings`, and the window listens to
// "changed::<key>" to apply those changes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { APP_ID } from './config.js';
import type { RecentFile } from './markdown/home.js';

// File-backed tabs that were open when the last window was closed, restored on the next launch.
export interface SavedTab {
    file: string;
    cursor: number;          // cursor position (code points)
}

export type SidebarPage = 'files' | 'outline' | 'history';

// When run from dist/, the compiled schema is next to the bundle (see vite.config.ts).
// When installed (Meson/Flatpak), the schema is in the system schema directory and there is no copy next to the bundle.
function loadSchema(): Gio.SettingsSchema {
    // Shared code is bundled into dist/chunks/, so also look one level above.
    let folder = Gio.File.new_for_uri(import.meta.url).get_parent()!;
    if (!folder.get_child('gschemas.compiled').query_exists(null)) folder = folder.get_parent()!;
    const dir = folder.get_path()!;
    const system = Gio.SettingsSchemaSource.get_default();
    const source = folder.get_child('gschemas.compiled').query_exists(null)
        ? Gio.SettingsSchemaSource.new_from_directory(dir, system, false)
        : system;
    const schema = source?.lookup(APP_ID, true) ?? null;
    if (!schema) throw new Error(`schema ${APP_ID} not found in ${dir} or the system schema directory`);
    return schema;
}

export class AppSettings {
    readonly gsettings: Gio.Settings;

    // backend: tests use Gio.memory_settings_backend_new() so the user's dconf is not touched.
    constructor(backend?: Gio.SettingsBackend) {
        this.gsettings = new Gio.Settings({ settings_schema: loadSchema(), ...(backend && { backend }) });
    }

    // null = follow the system theme.
    get dark(): boolean | null {
        const scheme = this.gsettings.get_string('color-scheme');
        return scheme === 'system' ? null : scheme === 'dark';
    }
    set dark(value: boolean | null) { this.gsettings.set_string('color-scheme', value === null ? 'system' : value ? 'dark' : 'light'); }

    get sidebar(): boolean { return this.gsettings.get_boolean('sidebar'); }
    set sidebar(value: boolean) { this.gsettings.set_boolean('sidebar', value); }
    get sidebarPage(): SidebarPage { return this.gsettings.get_string('sidebar-page') as SidebarPage; }
    set sidebarPage(value: SidebarPage) { this.gsettings.set_string('sidebar-page', value); }
    get chat(): boolean { return this.gsettings.get_boolean('chat'); }
    set chat(value: boolean) { this.gsettings.set_boolean('chat', value); }
    get chatModel(): string { return this.gsettings.get_string('chat-model'); }
    set chatModel(value: string) { this.gsettings.set_string('chat-model', value); }
    get chatThinking(): boolean { return this.gsettings.get_boolean('chat-thinking'); }
    set chatThinking(value: boolean) { this.gsettings.set_boolean('chat-thinking', value); }
    get chatSave(): boolean { return this.gsettings.get_boolean('chat-save'); }
    set chatSave(value: boolean) { this.gsettings.set_boolean('chat-save', value); }
    get typewriter(): boolean { return this.gsettings.get_boolean('typewriter'); }
    set typewriter(value: boolean) { this.gsettings.set_boolean('typewriter', value); }
    get focus(): boolean { return this.gsettings.get_boolean('focus'); }
    set focus(value: boolean) { this.gsettings.set_boolean('focus', value); }
    get autosave(): boolean { return this.gsettings.get_boolean('autosave'); }
    set autosave(value: boolean) { this.gsettings.set_boolean('autosave', value); }
    get home(): boolean { return this.gsettings.get_boolean('home'); }
    set home(value: boolean) { this.gsettings.set_boolean('home', value); }
    get welcomed(): boolean { return this.gsettings.get_boolean('welcomed'); }
    set welcomed(value: boolean) { this.gsettings.set_boolean('welcomed', value); }
    get width(): number { return this.gsettings.get_int('width'); }
    set width(value: number) { this.gsettings.set_int('width', Math.round(value)); }
    get height(): number { return this.gsettings.get_int('height'); }
    set height(value: number) { this.gsettings.set_int('height', Math.round(value)); }
    get activeTab(): number { return this.gsettings.get_int('active-tab'); }
    set activeTab(value: number) { this.gsettings.set_int('active-tab', value); }

    // Last folder; null = none.
    get folder(): string | null { return this.gsettings.get_string('folder') || null; }
    set folder(value: string | null) { this.gsettings.set_string('folder', value ?? ''); }

    get tabs(): SavedTab[] {
        return (this.gsettings.get_value('tabs').deepUnpack() as [string, number][]).map(([file, cursor]) => ({ file, cursor }));
    }
    set tabs(value: SavedTab[]) {
        this.gsettings.set_value('tabs', new GLib.Variant('a(si)', value.map(t => [t.file, t.cursor] as [string, number])));
    }

    get recentFiles(): RecentFile[] {
        return (this.gsettings.get_value('recent-files').deepUnpack() as [string, number][]).map(([path, time]) => ({ path, time: Number(time) }));
    }
    set recentFiles(value: RecentFile[]) {
        this.gsettings.set_value('recent-files', new GLib.Variant('a(sx)', value.map(r => [r.path, r.time] as [string, number])));
    }

    get projects(): Record<string, string> {
        return this.gsettings.get_value('projects').deepUnpack() as Record<string, string>;
    }
    set projects(value: Record<string, string>) {
        this.gsettings.set_value('projects', new GLib.Variant('a{ss}', value));
    }

    // In-memory settings with default values, plus `overrides`; for tests, bench, and screenshots.
    static inMemory(overrides: Partial<Omit<AppSettings, 'gsettings'>> = {}): AppSettings {
        return Object.assign(new AppSettings(Gio.memory_settings_backend_new()), overrides);
    }
}
