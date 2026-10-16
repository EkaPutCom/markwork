// The SettingsStore on GJS: GSettings with the app's schema. The GTK frontend also binds widgets and actions straight to
// it (gsettingsOf), which is why this store keeps its Gio.Settings in view.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { APP_ID } from '../../config.js';
import { AppSettings, type SettingOverrides } from '../../settings.js';
import type { SettingValue, SettingsStore } from '../index.js';

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

export class GSettingsStore implements SettingsStore {
    readonly gsettings: Gio.Settings;
    private readonly types = new Map<string, string>();

    // backend: tests use Gio.memory_settings_backend_new() so the user's dconf is not touched.
    constructor(backend?: Gio.SettingsBackend) {
        const schema = loadSchema();
        this.gsettings = new Gio.Settings({ settings_schema: schema, ...(backend && { backend }) });
        for (const key of schema.list_keys()) this.types.set(key, schema.get_key(key).get_value_type().dup_string());
    }

    get(key: string): SettingValue {
        return this.gsettings.get_value(key).deepUnpack() as SettingValue;
    }

    set(key: string, value: SettingValue): void {
        const type = this.types.get(key);
        if (!type) throw new Error(`no setting ${key} in ${APP_ID}`);
        this.gsettings.set_value(key, new GLib.Variant(type, value));
    }

    onChanged(listener: (key: string) => void): () => void {
        const id = this.gsettings.connect('changed', (_settings, key: string) => listener(key));
        return () => this.gsettings.disconnect(id);
    }
}

export const systemSettings = (): AppSettings => new AppSettings(new GSettingsStore());

// In-memory settings with the schema's defaults, plus `overrides`; for tests, bench, and screenshots.
export const inMemorySettings = (overrides: SettingOverrides = {}): AppSettings =>
    Object.assign(new AppSettings(new GSettingsStore(Gio.memory_settings_backend_new())), overrides);

// The GSettings behind settings, for GTK bindings (Gio.Settings.bind, create_action). Only the GTK frontend calls this.
export function gsettingsOf(settings: AppSettings): Gio.Settings {
    if (!(settings.store instanceof GSettingsStore)) throw new Error('these settings are not stored in GSettings');
    return settings.store.gsettings;
}
