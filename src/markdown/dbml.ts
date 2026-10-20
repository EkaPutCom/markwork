// DBML (dbdiagram.io schema language) to Mermaid ER diagram converter.
//
// The diagram is drawn by Mermaid (see electron/renderer/lib/diagrams.ts), so here there is only
// DBML parsing and rewriting as `erDiagram`. Supported: Table
// (alias, column settings pk/unique/not null/note/ref, indexes, Note), Ref (single line
// and block, relations > < - <>), and Enum/TableGroup/Project which are skipped.
//
// Syntax errors are thrown as a DbmlError containing the line number.

export class DbmlError extends Error {
    constructor(message: string, readonly line: number) {
        super(`${message} (line ${line})`);
    }
}

type Kind = 'word' | 'str' | 'punct' | 'expr';
interface Token { kind: Kind; text: string; line: number }

// ---------- Tokenizer ----------

function tokenize(src: string): Token[] {
    const lexer = new Lexer(src);
    while (lexer.next()) { /* until the end of the source */ }
    return lexer.tokens;
}

// One pass over the source; each method reads one kind of token at the current position, or returns false.
class Lexer {
    readonly tokens: Token[] = [];
    private line = 1;
    private i = 0;

    constructor(private readonly src: string) {}

    // Read the next token (or skip whitespace or a comment). false = the end of the source.
    next(): boolean {
        if (this.i >= this.src.length) return false;
        if (this.space() || this.comment() || this.blockText() || this.quoted() || this.punct()) return true;
        this.word();
        return true;
    }

    private push(kind: Kind, text: string, line = this.line): void {
        this.tokens.push({ kind, text, line });
    }

    // Count the newlines in src[from, to) and move to `to`.
    private skipTo(from: number, to: number): void {
        for (let k = from; k < to; k++) if (this.src[k] === '\n') this.line++;
        this.i = to;
    }

    private space(): boolean {
        const c = this.src[this.i];
        if (c === '\n') { this.line++; this.i++; return true; }
        if (!/\s/.test(c)) return false;
        this.i++;
        return true;
    }

    private comment(): boolean {
        const { src, i } = this;
        if (src.startsWith('//', i)) {
            const end = src.indexOf('\n', i);
            this.i = end < 0 ? src.length : end;
            return true;
        }
        if (!src.startsWith('/*', i)) return false;
        const end = src.indexOf('*/', i + 2);
        if (end < 0) throw new DbmlError('Unclosed /* comment', this.line);
        this.skipTo(i, end + 2);
        return true;
    }

    // '''text''' may span lines; the token gets the line it starts on.
    private blockText(): boolean {
        const { src, i } = this;
        if (!src.startsWith("'''", i)) return false;
        const end = src.indexOf("'''", i + 3);
        if (end < 0) throw new DbmlError("Unclosed ''' text", this.line);
        this.push('str', src.slice(i + 3, end));
        this.skipTo(i, end + 3);
        return true;
    }

    // "name" is an identifier; 'text' is a string; `expression` is an expression. A backslash escapes one character.
    private quoted(): boolean {
        const { src } = this;
        const c = src[this.i];
        if (c !== "'" && c !== '"' && c !== '`') return false;
        let j = this.i + 1, text = '';
        while (j < src.length && src[j] !== c && src[j] !== '\n') {
            if (src[j] === '\\' && j + 1 < src.length) j++;
            text += src[j++];
        }
        if (src[j] !== c) throw new DbmlError('Unclosed quote', this.line);
        this.push(c === '"' ? 'word' : c === "'" ? 'str' : 'expr', text);
        this.i = j + 1;
        return true;
    }

    private punct(): boolean {
        if (this.src.startsWith('<>', this.i)) { this.push('punct', '<>'); this.i += 2; return true; }
        const c = this.src[this.i];
        if (!/[{}[\](),:.<>\-]/.test(c)) return false;
        this.push('punct', c);
        this.i++;
        return true;
    }

    private word(): void {
        const m = /^[^\s{}[\](),:.<>'"`\-/]+/.exec(this.src.slice(this.i));
        if (!m) throw new DbmlError(`Unrecognized character: ${this.src[this.i]}`, this.line);
        this.push('word', m[0]);
        this.i += m[0].length;
    }
}

// ---------- Model ----------

interface Column { name: string; type: string; pk: boolean; unique: boolean; fk: boolean; note: string }
interface Table { name: string; alias: string | null; columns: Column[] }
interface Relation { from: string; fromCol: string; op: string; to: string; toCol: string }

export interface Schema { tables: Table[]; relations: Relation[] }

// ---------- Parser ----------

class Parser {
    private p = 0;
    readonly schema: Schema = { tables: [], relations: [] };

    constructor(private readonly t: Token[]) {}

    private get cur(): Token | undefined { return this.t[this.p]; }
    private get line(): number { return (this.cur ?? this.t[this.t.length - 1])?.line ?? 1; }
    private is(text: string): boolean { const c = this.cur; return !!c && c.kind !== 'str' && c.text.toLowerCase() === text; }
    private punct(text: string): boolean { const c = this.cur; return !!c && c.kind === 'punct' && c.text === text; }

    private expect(text: string): void {
        if (!this.punct(text)) throw new DbmlError(`Expected "${text}", found ${this.cur ? `"${this.cur.text}"` : 'end of code'}`, this.line);
        this.p++;
    }

    private word(what: string): string {
        const c = this.cur;
        if (!c || c.kind === 'punct' || c.kind === 'str') throw new DbmlError(`Expected ${what}`, this.line);
        this.p++;
        return c.text;
    }

    parse(): Schema {
        while (this.cur) {
            const kw = this.word('keyword').toLowerCase();
            if (kw === 'table') this.table();
            else if (kw === 'ref') this.ref();
            else if (kw === 'enum' || kw === 'tablegroup' || kw === 'project' || kw === 'tablepartial') this.skipBlock();
            else if (kw === 'note') this.skipNote();
            else throw new DbmlError(`Unrecognized: ${kw}`, this.t[this.p - 1].line);
        }
        return this.schema;
    }

    // Skip to "{" and then its whole contents (nested curly braces).
    private skipBlock(): void {
        while (this.cur && !this.punct('{')) this.p++;
        this.expect('{');
        for (let depth = 1; depth > 0; this.p++) {
            if (!this.cur) throw new DbmlError('Block not closed with "}"', this.line);
            if (this.punct('{')) depth++;
            else if (this.punct('}')) depth--;
        }
    }

    // Note: 'text'   or   Note { 'text' }   or   Note name { 'text' }
    private skipNote(): string {
        if (this.punct(':')) {
            this.p++;
            return this.str();
        }
        if (!this.punct('{')) this.word('note name');   // Note name { ... } at the top level
        this.expect('{');
        const text = this.str();
        this.expect('}');
        return text;
    }

    private str(): string {
        const c = this.cur;
        if (!c || c.kind !== 'str') throw new DbmlError('Expected quoted text', this.line);
        this.p++;
        return c.text;
    }

    // schema.table.column → ['schema.table', 'column']; a trailing "(a, b)" means a composite column.
    private endpoint(): [string, string] {
        const parts = [this.word('table name')];
        let col = '';
        while (this.punct('.')) {
            this.p++;
            if (this.punct('(')) { col = this.columnList(); break; }
            parts.push(this.word('column name'));
        }
        if (!col) col = parts.length > 1 ? parts.pop()! : '';
        return [parts.join('.'), col];
    }

    private columnList(): string {
        this.expect('(');
        const names = [this.word('column name')];
        while (this.punct(',')) { this.p++; names.push(this.word('column name')); }
        this.expect(')');
        return names.join(', ');
    }

    private operator(): string {
        const c = this.cur;
        if (c && c.kind === 'punct' && ['>', '<', '-', '<>'].includes(c.text)) { this.p++; return c.text; }
        throw new DbmlError('Expected a relation type (>, <, - or <>)', this.line);
    }

    // Ref: a.x > b.y   or   Ref name: ...   or   Ref { ... }
    private ref(): void {
        if (!this.punct(':') && !this.punct('{')) this.word('ref name');
        if (this.punct(':')) {
            this.p++;
            this.relation();
            return;
        }
        this.expect('{');
        while (!this.punct('}')) {
            if (!this.cur) throw new DbmlError('Ref block not closed with "}"', this.line);
            this.relation();
        }
        this.p++;
    }

    private relation(): void {
        // A composite column on the left side is written "a.(x, y)" and handled by endpoint().
        const [from, fromCol] = this.endpoint();
        const op = this.operator();
        const [to, toCol] = this.endpoint();
        this.addRelation({ from, fromCol, op, to, toCol });
        // Relation settings ([delete: cascade]) do not change the diagram.
        if (this.punct('[')) this.settings();
    }

    private addRelation(r: Relation): void {
        this.schema.relations.push(r);
    }

    // The contents of [ ... ] are split at top-level commas; each item is a run of tokens.
    private settings(): Token[][] {
        this.expect('[');
        const items: Token[][] = [[]];
        for (let depth = 0; ; this.p++) {
            const c = this.cur;
            if (!c) throw new DbmlError('Setting "[" not closed with "]"', this.line);
            if (c.kind === 'punct') {
                if (c.text === '(' || c.text === '[') depth++;
                else if (c.text === ')' || (c.text === ']' && depth > 0)) depth--;
                else if (c.text === ']') break;
                else if (c.text === ',' && depth === 0) { items.push([]); continue; }
            }
            items[items.length - 1].push(c);
        }
        this.p++;
        return items.filter(i => i.length);
    }

    private table(): void {
        const parts = [this.word('table name')];
        while (this.punct('.')) { this.p++; parts.push(this.word('table name')); }
        const table: Table = { name: parts.join('.'), alias: null, columns: [] };
        if (this.is('as')) { this.p++; table.alias = this.word('alias'); }
        if (this.punct('[')) this.settings();
        this.expect('{');
        while (!this.punct('}')) {
            if (!this.cur) throw new DbmlError(`Table ${table.name} not closed with "}"`, this.line);
            if (this.is('note') && this.t[this.p + 1] && ['{', ':'].includes(this.t[this.p + 1].text)) { this.p++; this.skipNote(); }
            else if (this.is('indexes') && this.t[this.p + 1]?.text === '{') { this.p++; this.skipBlock(); }
            else this.column(table);
        }
        this.p++;
        this.schema.tables.push(table);
    }

    private column(table: Table): void {
        const name = this.word('column name');
        const type = this.type();
        const col: Column = { name, type, pk: false, unique: false, fk: false, note: '' };
        table.columns.push(col);
        // Column settings are only read if "[" is still on the same line as its type.
        while (this.punct('[') && this.cur!.line === this.t[this.p - 1].line) {
            for (const item of this.settings()) this.columnSetting(table, col, item);
        }
    }

    // varchar(255), decimal(10,2), schema.type, int[] (empty square brackets attached).
    private type(): string {
        let type = this.word('column type');
        while (this.punct('.')) { this.p++; type += `.${this.word('column type')}`; }
        if (this.punct('(')) {
            let depth = 0, args = '';
            do {
                const c = this.cur;
                if (!c) throw new DbmlError('Parenthesis in column type not closed', this.line);
                if (c.text === '(' && c.kind === 'punct') depth++;
                else if (c.text === ')' && c.kind === 'punct') depth--;
                args += c.text;
                this.p++;
            } while (depth > 0);
            type += args;
        }
        while (this.punct('[') && this.t[this.p + 1]?.text === ']') { this.p += 2; type += '[]'; }
        return type;
    }

    private columnSetting(table: Table, col: Column, item: Token[]): void {
        const head = item[0].text.toLowerCase();
        if (item[0].kind === 'punct') return;
        if (head === 'pk' || (head === 'primary' && item[1]?.text.toLowerCase() === 'key')) col.pk = true;
        else if (head === 'unique') col.unique = true;
        else if (head === 'note' && item[2]?.kind === 'str') col.note = item[2].text;
        else if (head === 'ref' && item[1]?.text === ':') {
            const sub = new Parser(item.slice(2));
            const op = sub.operator();
            const [to, toCol] = sub.endpoint();
            this.addRelation({ from: table.name, fromCol: col.name, op, to, toCol });
        }
    }
}

export function parseDbml(src: string): Schema {
    return new Parser(tokenize(src)).parse();
}

// ---------- Rewriting as Mermaid ----------

const CARDINALITY: Record<string, string> = {
    '>': '}o--||',    // many to one
    '<': '||--o{',    // one to many
    '-': '||--||',
    '<>': '}o--o{',
};

const quote = (s: string): string => `"${s.replace(/"/g, "'")}"`;
// Attribute and type names in Mermaid must not contain spaces or commas.
const ident = (s: string): string => s.replace(/[^\w\-[\]()]/g, '_') || '_';

export function dbmlToMermaid(src: string): string {
    const schema = parseDbml(src);
    const alias = new Map<string, string>();
    for (const t of schema.tables) if (t.alias) alias.set(t.alias, t.name);
    const resolve = (name: string): string => alias.get(name) ?? name;
    markForeignKeys(schema, resolve);
    return [
        'erDiagram',
        ...schema.tables.flatMap(tableLines),
        ...schema.relations.map(r => `    ${quote(resolve(r.from))} ${CARDINALITY[r.op]} ${quote(resolve(r.to))} : ${quote((r.op === '<' ? r.toCol : r.fromCol) || ' ')}`),
    ].join('\n');
}

// A column on the "many" side of a relation is a foreign key.
function markForeignKeys(schema: Schema, resolve: (name: string) => string): void {
    const byName = new Map(schema.tables.map(t => [t.name, t]));
    const mark = (table: string, col: string): void => {
        const c = byName.get(resolve(table))?.columns.find(c => c.name === col);
        if (c) c.fk = true;
    };
    for (const r of schema.relations) {
        if (r.op === '>') mark(r.from, r.fromCol);
        else if (r.op === '<') mark(r.to, r.toCol);
    }
}

// One entity block: a line per column with its type, name, keys, and note.
function tableLines(t: Table): string[] {
    const column = (c: Column): string => {
        const keys = [c.pk ? 'PK' : '', c.fk ? 'FK' : '', c.unique && !c.pk ? 'UK' : ''].filter(Boolean).join(', ');
        return `        ${ident(c.type)} ${ident(c.name)}${keys ? ` ${keys}` : ''}${c.note ? ` ${quote(c.note.replace(/\s+/g, ' '))}` : ''}`;
    };
    return [`    ${quote(t.name)} {`, ...t.columns.map(column), '    }'];
}
