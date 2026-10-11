// What a layout needs that a document may not have yet: a calendar and a timeline need a date field and a chart a select
// field. Switching to such a layout offers to add it. Pure TypeScript without GTK.

import type { FieldDef } from './fields.js';
import { boardSchema, declaredFields, withSchema, type Board } from './kanban.js';
import type { Layout } from './layout.js';
import { dateField } from './calendar.js';
import { groupField } from './chart.js';

const DUE: FieldDef = { key: 'due', type: 'date', multiple: false, options: [] };
const STATUS: FieldDef = {
    key: 'status', type: 'select', multiple: false,
    options: ['todo', 'doing', 'done'], colors: { todo: 'gray', doing: 'blue', done: 'green' }, default: 'todo',
};

// The field `layout` lacks in `board`, or null if it has what it needs.
export function missingField(board: Board, layout: Layout): FieldDef | null {
    const schema = boardSchema(board);
    if ((layout === 'calendar' || layout === 'timeline') && !dateField(board, schema)) return DUE;
    if (layout === 'chart' && !groupField(board, schema)) return STATUS;
    return null;
}

// The board with `def` declared in its `fields:` block (a field of that name is kept as it is).
export const withField = (board: Board, def: FieldDef): Board =>
    declaredFields(board).some(f => f.key === def.key) ? board : withSchema(board, [...declaredFields(board), def]);
