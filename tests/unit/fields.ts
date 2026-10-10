// Typed field tests (markdown/fields.ts).

import { addOption, findSegments, formatValue, nearestOption, parseSchema, parseValue, readItem, setField, writeField, type FieldDef } from '../../src/markdown/fields.js';
import { section, test, eq, ok } from '../framework.js';

const DOC = [
    '---', 'kanban: true', 'fields:',
    '  prioritas: select(tinggi, sedang, rendah)', '  due: date', '  progres: progress', '  pemilik: person[]',
    '  halaman: number', '  agent: agent', '  terkait: link[]', 'title: after', '---', '', '## Plan', ''].join('\n');

const { fields: SCHEMA } = parseSchema(DOC);
const def = (key: string): FieldDef => SCHEMA.find(f => f.key === key)!;
const value = (key: string, raw: string) => {
    const p = parseValue(def(key), raw);
    return p.ok ? p.value : `error: ${p.error}`;
};

export function fieldsModelTests(): void {
    section('Typed fields (model)');

    test('parseSchema: reads the fields block, stops at the next key, and reports unreadable lines', () => {
        eq(SCHEMA.map(f => `${f.key}:${f.type}${f.multiple ? '[]' : ''}`),
            ['prioritas:select', 'due:date', 'progres:progress', 'pemilik:person[]', 'halaman:number', 'agent:agent', 'terkait:link[]']);
        eq(def('prioritas').options, ['tinggi', 'sedang', 'rendah']);
        const bad = parseSchema('---\nfields:\n  a: wat\n  b: text(x)\n  a b: text\n  ok: text\n  ok: number\n---\n');
        eq(bad.fields.map(f => f.key), ['ok']);
        eq(bad.problems.length, 4, 'problems');
        eq(parseSchema('# no frontmatter').fields, []);
        eq(parseSchema('---\ntitle: a\n---').fields, []);
    });

    test('parseValue: date, with and without time, rejecting impossible days', () => {
        eq(value('due', '2026-10-24'), { date: '2026-10-24', time: null });
        eq(value('due', '2026-10-24 9:05'), { date: '2026-10-24', time: '09:05' });
        eq(value('due', '2026-02-30'), 'error: no such day');
        eq(value('due', '2026-10-24 25:00'), 'error: no such time');
        eq(value('due', 'besok'), 'error: not a date (YYYY-MM-DD, optionally with HH:MM)');
    });

    test('parseValue: progress as a ratio or a percentage', () => {
        eq(value('progres', '3/5'), { done: 3, total: 5, percent: false });
        eq(value('progres', '60%'), { done: 60, total: 100, percent: true });
        eq(value('progres', '6/5'), 'error: the total must be at least the done count');
        eq(value('progres', '120%'), 'error: more than 100%');
    });

    test('parseValue: number, select (case-insensitive, canonical result), agent, and link', () => {
        eq([value('halaman', '352'), value('halaman', '-1.5'), value('halaman', 'abc'), value('halaman', '')], [352, -1.5, 'error: not a number', 'error: empty']);
        eq([value('prioritas', 'Tinggi'), value('prioritas', 'urgent')], ['tinggi', 'error: not one of: tinggi, sedang, rendah']);
        eq([value('agent', 'PI'), value('agent', '9x')], ['pi', 'error: not an agent name']);
        eq([value('terkait', '[[Skema]]'), value('terkait', 'Skema, [[Satu, dua]]')], [['Skema'], ['Skema', 'Satu, dua']]);
    });

    test('parseValue: several values are split at commas outside quotes and links', () => {
        eq(value('pemilik', 'Eka, Rina'), ['Eka', 'Rina']);
        eq(value('pemilik', '"Putra, Eka", Rina'), ['Putra, Eka', 'Rina']);
        eq(value('pemilik', ' , '), 'error: empty');
    });

    test('formatValue is the inverse of parseValue, and quotes only when it has to', () => {
        for (const [key, raw] of [['due', '2026-10-24 09:00'], ['progres', '3/5'], ['progres', '60%'], ['halaman', '352'],
            ['prioritas', 'sedang'], ['pemilik', 'Eka, Rina'], ['terkait', '[[A]], [[B]]']] as const) {
            const p = parseValue(def(key), raw);
            ok(p.ok, `${key} did not parse`);
            eq(formatValue(def(key), p.value), raw, key);
        }
        eq(formatValue({ key: 't', type: 'text', multiple: false, options: [] }, 'a ] b'), '"a ] b"');
        eq(formatValue(def('pemilik'), ['Putra, Eka', 'Rina']), '"Putra, Eka", Rina');
    });

    test('findSegments: finds fields, nests [[links]], protects quoted brackets, ignores unclosed ones', () => {
        const text = 'Task [a:: 1] and [b:: [[X]]] [c:: "a ] b"] [d:: open [[x]] and [not:: closed';
        eq(findSegments(text).map(s => [s.key, s.raw]), [['a', '1'], ['b', '[[X]]'], ['c', '"a ] b"']]);
        eq(findSegments('see [[Skema]] and [link](x)'), []);
    });

    test('readItem: title, tags, declared fields, invalid values, and unknown keys', () => {
        const item = readItem('Parser #design [prioritas:: Tinggi] [due:: besok] [foo:: bar] #x [due:: 2026-10-24]', SCHEMA);
        eq(item.title, 'Parser');
        eq(item.tags, ['design', 'x']);
        eq(item.fields.prioritas, { ok: true, value: 'tinggi' });
        eq(item.fields.due.ok, false, 'the first occurrence of a key wins, even if it is invalid');
        eq(item.unknown, [{ key: 'foo', raw: 'bar' }]);
        eq(readItem('[due:: 2026-10-24]', SCHEMA).title, '[due:: 2026-10-24]', 'an item that is only fields keeps its text as the title');
    });

    test('writeField changes only its own field and leaves everything else as it was', () => {
        const text = 'Parser   #design [prioritas:: tinggi]  [foo:: bar] [due:: 2026-10-24]';
        eq(writeField(text, def('prioritas'), 'sedang'), 'Parser   #design [prioritas:: sedang]  [foo:: bar] [due:: 2026-10-24]');
        eq(writeField(text, def('progres'), { done: 3, total: 5, percent: false }), `${text} [progres:: 3/5]`, 'a new field goes at the end');
        eq(writeField(text, def('prioritas'), null), 'Parser   #design [foo:: bar] [due:: 2026-10-24]', 'removing leaves a single space');
        eq(writeField('A [due:: 2026-10-24]', def('due'), null), 'A');
        eq(writeField('A', def('due'), null), 'A', 'removing an absent field changes nothing');
        eq(readItem(writeField('A', def('terkait'), ['X', 'Y']), SCHEMA).fields.terkait, { ok: true, value: ['X', 'Y'] }, 'round trip');
    });

    test('setField: empty removes, a valid value is normalized, an invalid one changes nothing', () => {
        const text = 'A [due:: 2026-10-24] [pemilik:: Eka]';
        eq(setField(text, def('due'), '2026-10-25 9:30'), 'A [due:: 2026-10-25 09:30] [pemilik:: Eka]');
        eq(setField(text, def('due'), '  '), 'A [pemilik:: Eka]');
        eq(setField(text, def('due'), 'besok'), text, 'invalid');
        eq(setField('A', def('prioritas'), 'TINGGI'), 'A [prioritas:: tinggi]', 'select is written in its canonical case');
    });

    test('addOption adds an option to the frontmatter line and nothing else', () => {
        const next = addOption(DOC, 'prioritas', 'urgent');
        eq(parseSchema(next).fields.find(f => f.key === 'prioritas')?.options, ['tinggi', 'sedang', 'rendah', 'urgent']);
        eq(next.split('\n').length, DOC.split('\n').length, 'same number of lines');
        eq([addOption(DOC, 'prioritas', 'tinggi'), addOption(DOC, 'due', 'x'), addOption(DOC, 'nope', 'x'), addOption(DOC, 'prioritas', 'a,b')], [DOC, DOC, DOC, DOC]);
    });

    test('nearestOption offers an existing option for a different case or one typo', () => {
        const p = def('prioritas');
        eq([nearestOption(p, 'TINGGI'), nearestOption(p, 'tingi'), nearestOption(p, 'tinggii'), nearestOption(p, 'sedamg'), nearestOption(p, 'urgent'), nearestOption(p, '')],
            ['tinggi', 'tinggi', 'tinggi', 'sedang', null, null]);
    });
}
