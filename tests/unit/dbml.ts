// DBML → Mermaid converter tests.

import { section, test, eq, ok, contains } from '../core/framework.js';
import { dbmlToMermaid, parseDbml, DbmlError } from '../../src/markdown/dbml.js';

const SCHEMA = `// shop
Table users {
  id integer [pk, increment]
  email varchar(255) [unique, not null, note: 'login email']
  created_at timestamp [default: \`now()\`]
  Note: 'user'
  indexes {
    (id, email) [unique]
  }
}

Table orders as O {
  id int [pk]
  user_id int [not null, ref: > users.id]
  total decimal(10,2)
}

Ref: O.user_id > users.id
`;

export function dbmlTests(): void {
    section('DBML → Mermaid');
    test('tables, columns, and their types are read', () => {
        const s = parseDbml(SCHEMA);
        eq(s.tables.map(t => t.name), ['users', 'orders'], 'table names');
        eq(s.tables[0].columns.map(c => [c.name, c.type]), [['id', 'integer'], ['email', 'varchar(255)'], ['created_at', 'timestamp']], 'users columns');
        eq(s.tables[1].alias, 'O', 'alias');
        eq(s.tables[1].columns[2].type, 'decimal(10,2)', 'a type with a comma');
    });
    test('column settings: pk, unique, note', () => {
        const [id, email] = parseDbml(SCHEMA).tables[0].columns;
        eq([id.pk, id.unique], [true, false], 'id');
        eq([email.unique, email.note], [true, 'login email'], 'email');
    });
    test('a one-line ref and a ref inside a column become relations', () => {
        const r = parseDbml(SCHEMA).relations;
        eq(r.map(x => [x.from, x.fromCol, x.op, x.to, x.toCol]),
            [['orders', 'user_id', '>', 'users', 'id'], ['O', 'user_id', '>', 'users', 'id']], 'relations');
    });
    test('Mermaid result: entities, keys, comments, and cardinality', () => {
        const m = dbmlToMermaid(SCHEMA);
        contains(m, 'erDiagram');
        contains(m, '"users" {');
        contains(m, 'integer id PK');
        contains(m, 'varchar(255) email UK "login email"');
        contains(m, 'decimal(10_2) total');
        contains(m, 'int user_id FK');
        contains(m, '"orders" }o--|| "users" : "user_id"');
        contains(m, '"orders" }o--|| "users"');   // alias O is mapped back to orders
        ok(!m.includes('"O"'), 'alias leaked into the result');
    });
    test('relation types: < - <>', () => {
        const m = dbmlToMermaid('Table a { id int }\nTable b {\nid int\na_id int\n}\nRef: a.id < b.a_id\nRef: a.id - b.id\nRef: a.id <> b.id');
        contains(m, '"a" ||--o{ "b" : "a_id"');
        contains(m, '"a" ||--|| "b"');
        contains(m, '"a" }o--o{ "b"');
        contains(m, 'int a_id FK');
    });
    test('a named Ref, a Ref block, schema, and comments', () => {
        const m = dbmlToMermaid('/* x */ Table public.a { id int }\nTable b { a_id int }\nRef fk_b { b.a_id > public.a.id }\nRef { public.a.id < b.a_id [delete: cascade] }');
        contains(m, '"public.a" {');
        contains(m, '"b" }o--|| "public.a" : "a_id"');
        contains(m, '"public.a" ||--o{ "b" : "a_id"');
    });
    test('Enum, TableGroup, Project, and Note are skipped; array types are read', () => {
        const s = parseDbml("Project p { database_type: 'PostgreSQL' }\nEnum st { a\n b [note: 'x'] }\nTable t { tags text[]\n st st [not null] }\nTableGroup g { t }\nNote n { 'notes' }");
        eq(s.tables[0].columns.map(c => c.type), ['text[]', 'st'], 'column types');
    });
    test('names with spaces/quotes and invalid attributes are cleaned up', () => {
        const m = dbmlToMermaid('Table "customer data" { "full name" varchar }');
        contains(m, '"customer data" {');
        contains(m, 'varchar full_name');
    });
    test('invalid code is reported with a line number', () => {
        const fails = (src: string): number => {
            try { parseDbml(src); } catch (e) { return e instanceof DbmlError ? e.line : -1; }
            return 0;
        };
        eq(fails('Table a {\n id int\n'), 2, 'table not closed');
        eq(fails('Table a { id int }\nfoo'), 2, 'unrecognized keyword');
        eq(fails('Table a { id int }\nRef: a.id ? b.id'), 2, 'unrecognized operator');
        eq(fails('Table a { id int [pk }'), 1, 'setting not closed');
    });
}
