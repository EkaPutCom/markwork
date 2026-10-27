// The SettingsStore on Node: the keys of base/settingskeys.ts, kept in a JSON file next to the configuration
// (docs/design/protocol.md, section 9.2). The entry point hands the keys in, and a key that is not one of them is refused.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SettingSpec, SettingValue, SettingsStore } from '../index';

const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

// Whether `value` is one the key takes.
export function fits(spec: SettingSpec, value: unknown): boolean {
    switch (spec.type) {
        case 'b': return typeof value === 'boolean';
        case 's': return typeof value === 'string' && (!spec.choices || spec.choices.includes(value));
        case 'i': case 'x': return isInteger(value);
        case 'u': return isInteger(value) && value >= 0;
        case 'a{ss}': return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string');
        default: {
            const tuple = /^a\((s)([ixu])\)$/.exec(spec.type);
            return !!tuple && Array.isArray(value) && value.every(v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && isInteger(v[1]));
        }
    }
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// The settings of one user in a JSON file (null: in memory only, for tests). A value in the file that the key does not
// take (written by hand, or by an older version) reads as the default.
export class JsonSettingsStore implements SettingsStore {
    private readonly values: Record<string, unknown> = {};
    private readonly listeners = new Set<(key: string) => void>();

    constructor(private readonly file: string | null, private readonly specs: Record<string, SettingSpec>) {
        if (!file) return;
        try {
            const read = JSON.parse(readFileSync(file, 'utf8')) as unknown;
            if (read && typeof read === 'object' && !Array.isArray(read)) Object.assign(this.values, read);
        } catch {
            // no file yet, or one that cannot be read: the defaults
        }
    }

    private spec(key: string): SettingSpec {
        const spec = this.specs[key];
        if (!spec) throw new Error(`no setting ${key}`);
        return spec;
    }

    get(key: string): SettingValue {
        const spec = this.spec(key);
        const value = this.values[key];
        return copy(value !== undefined && fits(spec, value) ? value as SettingValue : spec.default);
    }

    set(key: string, value: SettingValue): void {
        if (!fits(this.spec(key), value)) throw new Error(`the setting ${key} does not take ${JSON.stringify(value)}`);
        this.values[key] = copy(value);
        this.save();
        for (const listener of [...this.listeners]) listener(key);
    }

    onChanged(listener: (key: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // Written whole to a file next to it, then moved over it, so a crash never leaves half a file.
    private save(): void {
        if (!this.file) return;
        mkdirSync(dirname(this.file), { recursive: true });
        const next = `${this.file}.new`;
        writeFileSync(next, `${JSON.stringify(this.values, null, 2)}\n`);
        renameSync(next, this.file);
    }
}
