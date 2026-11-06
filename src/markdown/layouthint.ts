// Fields a layout needs but the document may lack: calendar and timeline
// need a date field, chart a select field. Switching offers to add it.

import type { FieldDef } from './fields';
import { boardSchema, declaredFields, withSchema, type Board } from './kanban';
import type { Layout } from './layout';
import { dateField } from './calendar';
import { groupField } from './chart';

const DUE: FieldDef = {
    key: 'due',
    type: 'date',
    multiple: false,
    options: [],
};
const STATUS: FieldDef = {
    key: 'status',
    type: 'select',
    multiple: false,
    options: ['todo', 'doing', 'done'],
    colors: {
        todo: 'gray',
        doing: 'blue',
        done: 'green',
    },
    default: 'todo',
};

// The field `layout` lacks from `board`, or null if it has what it needs.
export function missingField(board: Board, layout: Layout): FieldDef | null {
    const schema = boardSchema(board);
    if (
        (layout === 'calendar' || layout === 'timeline') &&
        !dateField(board, schema)
    )
        return DUE;
    if (layout === 'chart' && !groupField(board, schema)) {
        return STATUS;
    }
    return null;
}

// The board with `def` declared in `fields:` (an existing field is kept).
export const withField = (board: Board, def: FieldDef): Board =>
    declaredFields(board).some((f) => f.key === def.key)
        ? board
        : withSchema(board, [...declaredFields(board), def]);
