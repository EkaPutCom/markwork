// Typed field tests (markdown/fields.ts).

import { addOption, applyDefaults, countUses, fieldNameProblem, optionProblem, writeSchema, fieldChips, fieldInputText, findSegments, formatValue, nearestOption, parseSchema, parseValue, readItem, resolveDefault, setField, writeField, type FieldDef } from '../../src/markdown/fields.js';
import { section, test, eq, ok } from '../framework.js';

const DOC = [
    '---', 'layout: board', 'fields:',
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

    test('fieldInputText: normal form when valid, the written text when not, empty when absent', () => {
        eq(['A [prioritas:: TINGGI]', 'A [due:: besok]', 'A [due:: 2026-10-24 9:05]', 'A', 'A [pemilik:: Eka, Rina]'].map((t, i) => fieldInputText(t, [def('prioritas'), def('due'), def('due'), def('due'), def('pemilik')][i])),
            ['tinggi', 'besok', '2026-10-24 09:05', '', 'Eka, Rina']);
    });

    test('fieldChips: schema order, select by option position, invalid marked, unknown last, skipped keys left out', () => {
        const item = readItem('A [progres:: 3/5] [prioritas:: sedang] [due:: besok] [foo:: bar] [terkait:: [[Skema]]]', SCHEMA);
        eq(fieldChips(item, SCHEMA, ['agent']).map(c => [c.text, c.option, c.invalid !== null]),
            [['sedang', 1, false], ['due: besok', null, true], ['progres: 3/5', null, false], ['terkait: Skema', null, false], ['foo: bar', null, false]]);
        eq(fieldChips(item, SCHEMA, ['due', 'foo']).map(c => c.key), ['prioritas', 'progres', 'terkait']);
        eq(fieldChips(readItem('A [prioritas:: urgent]', SCHEMA), SCHEMA)[0].invalid, 'not one of: tinggi, sedang, rendah');
    });

    test('a default after the type: dates take now and today, other types a value of the field; a bad default is reported', () => {
        const { fields, problems } = parseSchema('---\nfields:\n  created: date = now\n  day: date = today\n  status: select(a, b) = a\n  n: number = 3\n  bad: select(a, b) = c\n  worse: number = now\n  who: person[] = Eka, Rina\n---\n');
        eq(fields.map(f => [f.key, f.default]), [['created', 'now'], ['day', 'today'], ['status', 'a'], ['n', '3'], ['who', 'Eka, Rina']]);
        eq(problems.length, 2, 'a default that does not fit is reported, and the field is left out');
        eq(fields.find(f => f.key === 'status')!.options, ['a', 'b'], 'options are not mistaken for the default');
    });

    test('resolveDefault and applyDefaults: now and today in local time, existing fields kept, order of the schema', () => {
        const { fields } = parseSchema('---\nfields:\n  created: date = now\n  day: date = today\n  status: select(a, b) = a\n  free: text\n---\n');
        const now = new Date(2026, 0, 2, 3, 4);
        eq(fields.map(f => resolveDefault(f, now)), ['2026-01-02 03:04', '2026-01-02', 'a', null]);
        eq(applyDefaults('T [status:: b]', fields, now), 'T [status:: b] [created:: 2026-01-02 03:04] [day:: 2026-01-02]');
        eq(applyDefaults('T', [], now), 'T');
    });

    test('addOption keeps the default of the field', () => {
        const doc = '---\nfields:\n  status: select(a, b) = a\n---\n';
        eq(addOption(doc, 'status', 'c'), '---\nfields:\n  status: select(a, b, c) = a\n---\n');
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

    test('fieldNameProblem and optionProblem: empty, not allowed, or taken (ignoring case)', () => {
        eq(['', ' ', '9x', 'a b', 'due', 'Due', 'prioritas', 'p-1'].map(n => fieldNameProblem(n, ['due', 'agent'])), ['empty', 'empty', 'invalid', 'invalid', 'taken', 'taken', null, null]);
        eq(['', 'a,b', 'a(b', 'Tinggi', 'urgent'].map(o => optionProblem(o, ['tinggi', 'sedang'])), ['empty', 'invalid', 'invalid', 'taken', null]);
    });

    test('writeSchema replaces the fields block and nothing else; it makes the block when there is none and removes it when empty', () => {
        const doc = '---\nlayout: board\nfields:\n  a: text\n  b: select(x, y) = x\n\ntitle: after\n---\n\nbody\n';
        const a = parseSchema(doc).fields, b = a[1];
        eq(writeSchema(doc, [b, a[0]]), '---\nlayout: board\nfields:\n  b: select(x, y) = x\n  a: text\n\ntitle: after\n---\n\nbody\n', 'reordered; the lines after the block and the body are untouched');
        eq(writeSchema(doc, [...a, { key: 'c', type: 'date', multiple: false, options: [], default: 'today' }]).split('\n').slice(2, 8), ['fields:', '  a: text', '  b: select(x, y) = x', '  c: date = today', '', 'title: after']);
        eq(writeSchema(doc, []), '---\nlayout: board\n\ntitle: after\n---\n\nbody\n', 'no fields: no block');
        eq(writeSchema('---\nlayout: list\n---\n\n- one\n', a), '---\nlayout: list\nfields:\n  a: text\n  b: select(x, y) = x\n---\n\n- one\n', 'a block is made before the closing line');
        eq(writeSchema('no frontmatter', a), 'no frontmatter');
        eq(parseSchema(writeSchema(doc, a)).fields, a, 'what is written is read back as it was');
    });

    test('countUses: notes with a value for the field, or with that option among their values', () => {
        const texts = ['A [prio:: tinggi]', 'B [prio:: Tinggi]', 'C [prio:: rendah]', 'D', 'E [who:: "Putra, Eka", Rina]'];
        eq([countUses(texts, 'prio'), countUses(texts, 'prio', 'tinggi'), countUses(texts, 'prio', 'sedang'), countUses(texts, 'who', 'Rina'), countUses(texts, 'who', 'Putra, Eka'), countUses([], 'prio')], [3, 2, 0, 1, 1, 0]);
    });

    test('option colors: `text:color` with a known color name; anything else stays part of the option', () => {
        const { fields } = parseSchema('---\nfields:\n  p: select(tinggi:red, sedang:Amber, Q3: rilis, ok:nope, rendah, :red, x:  gray )\n---\n');
        eq(fields[0].options, ['tinggi', 'sedang', 'Q3: rilis', 'ok:nope', 'rendah', ':red', 'x']);
        eq(fields[0].colors, { tinggi: 'red', sedang: 'amber', x: 'gray' }, 'case is ignored, spaces are trimmed');
        eq(parseSchema('---\nfields:\n  p: select(a, b)\n---\n').fields[0].colors, undefined, 'no colors, no property');
    });

    test('option colors are written back, kept when an option is added, and shown on the chip', () => {
        const doc = '---\nfields:\n  p: select(tinggi:red, sedang, rendah:gray) = sedang\n---\n';
        const def = parseSchema(doc).fields[0];
        eq(writeSchema(doc, [def]), doc, 'read and written as it was');
        eq(addOption(doc, 'p', 'urgent'), '---\nfields:\n  p: select(tinggi:red, sedang, rendah:gray, urgent) = sedang\n---\n');
        const chips = fieldChips(readItem('A [p:: Tinggi] [p2:: x]', [def]), [def]);
        eq([chips[0].text, chips[0].color, chips[0].option], ['tinggi', 'red', 0]);
        eq(fieldChips(readItem('A [p:: sedang]', [def]), [def])[0].color, null, 'an option without a color has none, and is colored by its position');
        eq(optionProblem('a:red', []), 'invalid', 'a new option cannot contain a colon');
    });
}
