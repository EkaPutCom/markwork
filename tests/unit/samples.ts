// The sample documents in tests/samples must stay valid: the layout is recognized, the schema reads without problems,
// every value fits its field, and the file is already in the form the app writes (so opening and saving changes nothing).

import GLib from 'gi://GLib';
import { readTextFile } from '../../src/files.js';
import { parseSchema, readItem } from '../../src/markdown/fields.js';
import { boardSchema, parseBoard, serializeBoard } from '../../src/markdown/kanban.js';
import { layoutOf, type Layout } from '../../src/markdown/layout.js';
import { ROOT, section, test, eq } from '../framework.js';

const SAMPLES: [string, Layout][] = [['kanban-board.md', 'board'], ['inbox.md', 'list'], ['reading-list.md', 'list'], ['sprint-table.md', 'table'],
    ['calendar.md', 'calendar'], ['timeline.md', 'timeline'], ['gallery.md', 'gallery'], ['chart.md', 'chart'], ['board-by-field.md', 'board']];

export function sampleDocumentTests(): void {
    section('Sample documents');
    for (const [name, layout] of SAMPLES) {
        test(`${name}: layout ${layout}, a schema without problems, values that fit, and a form the app writes unchanged`, () => {
            const text = readTextFile(GLib.build_filenamev([ROOT, 'tests', 'samples', name]));
            eq(layoutOf(text), layout, 'layout');
            eq(parseSchema(text).problems, [], 'schema problems');
            const doc = parseBoard(text);
            const schema = boardSchema(doc);
            const bad = doc.columns.flatMap(c => c.cards).flatMap(card => {
                const item = readItem(card.text, schema);
                return [...Object.entries(item.fields).filter(([, v]) => !v.ok).map(([k]) => `${card.text}: ${k} does not fit`),
                    ...item.unknown.map(u => `${card.text}: ${u.key} is not declared`)];
            });
            eq(bad, [], 'every value fits its declared field');
            eq(serializeBoard(doc), text, 'saved as it is');
        });
    }
}
