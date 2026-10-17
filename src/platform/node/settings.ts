// The SettingsStore on Node: the same keys as the GSettings schema (data/com.ekaput.Markwork.gschema.xml), kept in a
// JSON file next to the configuration (docs/design/protocol.md, section 9.2). The schema stays the one source of the
// keys, their types, and their defaults: the entry point hands its text to parseSchema() (bundled with `?raw`), and a
// key the schema does not have is refused, as GSettings refuses it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SettingValue, SettingsStore } from '../index.js';

// One key of the schema: its GVariant type ('b', 's', 'i', 'u', 'x', 'a(si)', 'a{ss}', …), its default, and for an enum
// key the values it takes (its type is then 's').
export interface SettingSpec {
    type: string;
    default: SettingValue;
    choices?: string[];
}

const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// The keys of a GSettings schema file, with their defaults.
export function parseSchema(xml: string): Record<string, SettingSpec> {
    const enums = new Map<string, string[]>();
    for (const [, id, body] of xml.matchAll(/<enum\s+id="([^"]+)">([\s\S]*?)<\/enum>/g))
        enums.set(id, [...body.matchAll(/<value\s+nick="([^"]+)"/g)].map(m => m[1]));
    const specs: Record<string, SettingSpec> = {};
    for (const [, attributes, body] of xml.matchAll(/<key\s+([^>]*)>([\s\S]*?)<\/key>/g)) {
        const name = /name="([^"]+)"/.exec(attributes)?.[1];
        const enumId = /enum="([^"]+)"/.exec(attributes)?.[1];
        const type = enumId ? 's' : /type="([^"]+)"/.exec(attributes)?.[1];
        const text = /<default>([\s\S]*?)<\/default>/.exec(body)?.[1];
        if (!name || !type || text === undefined) throw new Error(`a schema key that cannot be read: ${attributes}`);
        specs[name] = { type, default: parseVariant(unescape(text).trim()), ...(enumId && { choices: enums.get(enumId) ?? [] }) };
    }
    return specs;
}

// A GVariant text the schema uses for a default: a boolean, a number, a 'string', and arrays, tuples, and dictionaries
// of those ([('a', 1)], {'k': 'v'}).
export function parseVariant(text: string): SettingValue {
    let at = 0;
    const space = () => { while (/\s/.test(text[at] ?? '')) at++; };
    const value = (): unknown => {
        space();
        const c = text[at];
        if (c === "'" || c === '"') return string(c);
        if (c === '[' || c === '(') return list(c === '[' ? ']' : ')');
        return c === '{' ? dictionary() : word();
    };
    const string = (quote: string): string => {
        let out = '';
        for (at++; at < text.length && text[at] !== quote; at++) out += text[at] === '\\' ? text[++at] : text[at];
        at++;
        return out;
    };
    const dictionary = (): Record<string, unknown> => {
        at++;
        const out: Record<string, unknown> = {};
        for (space(); text[at] !== '}'; space()) {
            const key = String(value());
            space(); at++;   // ':'
            out[key] = value();
            space();
            if (text[at] === ',') at++;
        }
        at++;
        return out;
    };
    const word = (): unknown => {
        const word = /^[^\s,)\]}:]+/.exec(text.slice(at))?.[0] ?? '';
        at += word.length;
        if (word === 'true' || word === 'false') return word === 'true';
        const number = Number(word.replace(/^(int|uint)\d+\s*/, ''));
        if (word === '' || Number.isNaN(number)) throw new Error(`a GVariant text that cannot be read: ${text}`);
        return number;
    };
    const list = (end: string): unknown[] => {
        at++;
        const out: unknown[] = [];
        for (space(); text[at] !== end; space()) {
            out.push(value());
            space();
            if (text[at] === ',') at++;
        }
        at++;
        return out;
    };
    return value() as SettingValue;
}

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
