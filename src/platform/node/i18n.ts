// Interface translations on Node: the compiled gettext catalogs (<locale>/<lang>/LC_MESSAGES/
// markwork.mo), read by this module, so a core running on Node speaks the user's language too. The language comes from
// the environment the way gettext picks it (LANGUAGE, then LC_ALL, LC_MESSAGES, LANG); without a catalog for it, the
// source text is shown.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Translations } from '../index';

export const GETTEXT_DOMAIN = 'markwork';

// One catalog: msgid (with "context\u0004" in front for a context) → its translations (more than one for a plural).
export interface Catalog {
    messages: Map<string, string[]>;
    plural: (n: number) => number;   // which translation a count takes
}

// Reads a .mo file (either byte order). Throws on anything that is not one.
export function parseMo(data: Uint8Array): Catalog {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = view.getUint32(0, true);
    const little = magic === 0x950412de;
    if (!little && magic !== 0xde120495) throw new Error('not a gettext catalog');
    const word = (at: number) => view.getUint32(at, little);
    const count = word(8), originals = word(12), translations = word(16);
    const decoder = new TextDecoder();
    const text = (table: number, i: number) => {
        const length = word(table + i * 8), offset = word(table + i * 8 + 4);
        return decoder.decode(data.subarray(offset, offset + length));
    };
    const messages = new Map<string, string[]>();
    let header = '';
    for (let i = 0; i < count; i++) {
        const id = text(originals, i).split('\0')[0];
        const strings = text(translations, i).split('\0');
        if (id === '') header = strings[0];
        else messages.set(id, strings);
    }
    return { messages, plural: pluralRule(header) };
}

// The Plural-Forms rule of a catalog's header ("nplurals=2; plural=(n != 1);"); English's when there is none.
export function pluralRule(header: string): (n: number) => number {
    const rule = /plural\s*=\s*([^;\n]+)/.exec(header)?.[1];
    if (!rule) return n => n === 1 ? 0 : 1;
    return compilePlural(rule);
}

// What each binary operator of a plural rule computes; integer arithmetic, as in C.
const OPERATORS: Record<string, (a: number, b: number) => number> = {
    '||': (a, b) => +(a || b), '&&': (a, b) => +(a && b), '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b),
    '<': (a, b) => +(a < b), '>': (a, b) => +(a > b), '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b),
    '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b,
    '/': (a, b) => b ? Math.trunc(a / b) : 0, '%': (a, b) => b ? a % b : 0,
};

// The C expression of a plural rule: n, numbers, ! % * / + - < > <= >= == != && || ?: and parentheses. Parsed here,
// never handed to eval, since a catalog is data.
function compilePlural(source: string): (n: number) => number {
    const tokens = source.match(/\d+|n|&&|\|\||[=!<>]=|[-+*/%<>!?:()]/g) ?? [];
    let at = 0;
    const peek = () => tokens[at], next = () => tokens[at++];
    type Node = (n: number) => number;
    // The binary operators by precedence, loosest first.
    const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    const apply = (op: string, a: number, b: number): number => OPERATORS[op](a, b);
    const binary = (level: number): Node => {
        if (level === LEVELS.length) return unary();
        let left = binary(level + 1);
        while (LEVELS[level].includes(peek())) {
            const op = next(), l = left, r = binary(level + 1);
            left = n => apply(op, l(n), r(n));
        }
        return left;
    };
    const unary = (): Node => {
        const token = next();
        if (token === '!') { const inner = unary(); return n => +!inner(n); }
        if (token === '-') { const inner = unary(); return n => -inner(n); }
        if (token === '(') { const inner = ternary(); next(); return inner; }
        if (token === 'n') return n => n;
        const value = Number(token);
        if (Number.isNaN(value)) throw new Error(`a plural rule that cannot be read: ${source}`);
        return () => value;
    };
    const ternary = (): Node => {
        const test = binary(0);
        if (peek() !== '?') return test;
        next();
        const yes = ternary();
        next();   // ':'
        const no = ternary();
        return n => test(n) ? yes(n) : no(n);
    };
    return ternary();
}

// Translations from a catalog; a message it does not have stays the source text.
export function catalogTranslations(catalog: Catalog | null): Translations {
    const find = (id: string) => catalog?.messages.get(id);
    return {
        text: text => find(text)?.[0] || text,
        plural: (one, many, n) => {
            const found = find(one);
            const chosen = found?.[catalog!.plural(n)];
            return chosen || (n === 1 ? one : many);
        },
        context: (context, text) => find(`${context}\u0004${text}`)?.[0] || text,
    };
}

// The languages to look for, in order, as gettext reads them from the environment: "id_ID.UTF-8" is tried as id_ID,
// then id. C and POSIX mean no translation.
export function languages(env: (name: string) => string | undefined): string[] {
    const list = env('LANGUAGE') || env('LC_ALL') || env('LC_MESSAGES') || env('LANG') || '';
    const names = list.split(':').map(l => l.replace(/[.@].*$/, '')).filter(l => l && l !== 'C' && l !== 'POSIX');
    return [...new Set(names.flatMap(l => l.includes('_') ? [l, l.split('_')[0]] : [l]))];
}

// The locale folder: installed, <prefix>/share/locale (the bundle is in <prefix>/share/markwork); from dist-node/,
// <repo>/locale, which usually does not exist.
function localeDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    if (dir.endsWith('/chunks')) dir = dirname(dir);
    return join(dirname(dir), 'locale');
}

// The catalog for the user's language, or null.
export function userCatalog(dir = localeDir(), env: (name: string) => string | undefined = name => process.env[name]): Catalog | null {
    for (const lang of languages(env)) {
        try {
            return parseMo(readFileSync(join(dir, lang, 'LC_MESSAGES', `${GETTEXT_DOMAIN}.mo`)));
        } catch {
            // not there, or not a catalog: the next language
        }
    }
    return null;
}
