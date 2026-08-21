/**
 * Pure SQL generators. Kept completely free of any I/O so they are easy to
 * unit-test. Both the "run" and the "generate" (get-query) variants of every
 * mutating operation share these functions.
 */

export const SQLITE_DESIGNER_TYPES = [
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'NUMERIC',
  'VARCHAR(255)',
  'JSON',
] as const;

export const POSTGRES_DESIGNER_TYPES = [
  'TEXT',
  'VARCHAR(255)',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'SERIAL',
  'BIGSERIAL',
  'REAL',
  'DECIMAL(10,2)',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TIME',
  'INTERVAL',
  'JSON',
  'JSONB',
  'UUID',
  'BYTEA',
  'INET',
] as const;

export const DESIGNER_TYPES = [
  'TEXT',
  'VARCHAR(255)',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'SERIAL',
  'BIGSERIAL',
  'REAL',
  'DECIMAL(10,2)',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TIME',
  'INTERVAL',
  'JSON',
  'JSONB',
  'UUID',
  'BYTEA',
  'BLOB',
  'INET',
] as const;

export function getDesignerTypes(dialect: 'sqlite' | 'postgres' = 'sqlite'): readonly string[] {
  return dialect === 'postgres' ? POSTGRES_DESIGNER_TYPES : SQLITE_DESIGNER_TYPES;
}

export type DesignerColumnType = (typeof DESIGNER_TYPES)[number];

export interface ColumnDef {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  /** Raw SQL expression used after DEFAULT (e.g. `0`, `'x'`, `CURRENT_TIMESTAMP`). */
  defaultValue?: string | null;
  foreignKey?: { table: string; column: string } | null;
}

export interface FieldValue {
  column: string;
  value: unknown;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Quote an SQL identifier (table/column name), escaping embedded double quotes. */
export function quoteIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/** Escape a string for use inside a single-quoted SQL literal. */
export function escapeString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Render a JS value as a safe SQL literal. */
export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (value instanceof Date) return escapeString(value.toISOString());
  return escapeString(String(value));
}

export interface MappedType {
  sqlType: string;
  /** Auto default applied when the user provides none (used for DATE). */
  defaultAuto?: string;
}

/**
 * Map a designer-friendly or custom SQL type to a real database column type.
 * DATE-style types map to a datetime column with a current-timestamp default.
 */
export function mapColumnType(type: string): MappedType {
  const t = String(type ?? '').trim().toUpperCase();
  if (!t) return { sqlType: 'TEXT' };
  switch (t) {
    case 'INTEGER':
    case 'INT':
    case 'TINYINT':
      return { sqlType: 'INTEGER' };
    case 'BIGINT':
    case 'SMALLINT':
    case 'SERIAL':
    case 'BIGSERIAL':
    case 'SMALLSERIAL':
      return { sqlType: t };

    case 'TEXT':
    case 'VARCHAR':
    case 'CHAR':
    case 'CLOB':
    case 'STRING':
    case 'CITEXT':
      return { sqlType: 'TEXT' };
    case 'REAL':
    case 'FLOAT':
    case 'DOUBLE':
    case 'DECIMAL':
    case 'NUMERIC':
    case 'NUMBER':
    case 'MONEY':
      return { sqlType: 'REAL' };
    case 'BLOB':
    case 'BINARY':
    case 'VARBINARY':
      return { sqlType: 'BLOB' };
    case 'BYTEA':
      return { sqlType: 'BYTEA' };
    case 'BOOLEAN':
    case 'BOOL':
      return { sqlType: 'INTEGER' };
    case 'DATE':
      return { sqlType: 'DATETIME', defaultAuto: 'CURRENT_TIMESTAMP' };
    case 'DATETIME':
      return { sqlType: 'DATETIME' };
    case 'TIMESTAMP':
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP WITHOUT TIME ZONE':
    case 'TIMESTAMP WITH TIME ZONE':
      return { sqlType: t };
    case 'TIME':
    case 'TIMETZ':
    case 'TIME WITHOUT TIME ZONE':
    case 'TIME WITH TIME ZONE':
      return { sqlType: t };
    case 'INTERVAL':
    case 'JSON':
    case 'JSONB':
    case 'UUID':
    case 'INET':
    case 'CIDR':
    case 'MACADDR':
    case 'SERIAL':
    case 'BIGSERIAL':
    case 'SMALLSERIAL':
      return { sqlType: t };
    default:
      if (/^[A-Za-z0-9_(),\s\[\]]+$/.test(t)) {
        return { sqlType: t };
      }
      throw new Error(`Unsupported column type: "${type}". Supported types include: ${DESIGNER_TYPES.join(', ')} or standard SQL types.`);
  }
}


function validateIdentifier(kind: string, name: string): void {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error(`${label} name is required.`);
  if (!IDENTIFIER_RE.test(trimmed)) {
    throw new Error(`Invalid ${label.toLowerCase()} name: "${trimmed}". Use letters, digits and underscores.`);
  }
}

export interface RenderOptions {
  /** Constrain DDL to what `ALTER TABLE ADD COLUMN` supports. */
  forAddColumn?: boolean;
}

/** Format a raw user-provided default value safely for SQL DDL. */
export function formatSqlDefault(raw: string, colType?: string): string {
  const s = String(raw ?? '').trim().replace(/;/g, '');
  if (!s) return '';
  if (/^null$/i.test(s)) return 'NULL';
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(true|false)$/i.test(s)) return s.toUpperCase() === 'TRUE' ? '1' : '0';
  if (/^'.*'$/s.test(s) || /^".*"$/s.test(s)) return s;
  if (/^[a-zA-Z_]\w*\s*\(.*\)$/s.test(s)) return s;
  if (/^CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME$/i.test(s)) return s.toUpperCase();
  const t = (colType || '').toUpperCase();
  if (t.includes('TEXT') || t.includes('CHAR') || t.includes('CLOB') || t.includes('VARCHAR') || t.includes('STRING')) {
    return escapeString(s);
  }
  return s;
}

/**
 * Render a single column definition.
 * When `forAddColumn` is set, enforces SQLite's ADD COLUMN restrictions
 * (no PRIMARY KEY / UNIQUE, NOT NULL requires a default, FK requires NULL default).
 */
export function renderColumnDef(col: ColumnDef, opts: RenderOptions = {}): string {
  const colName = String(col?.name ?? '').trim();
  validateIdentifier('column', colName);
  const mapped = mapColumnType(col.type);

  if (opts.forAddColumn) {
    if (col.primaryKey) {
      throw new Error(`Cannot add "${colName}" as PRIMARY KEY: ALTER TABLE ADD COLUMN does not support primary keys.`);
    }
    if (col.unique) {
      throw new Error(`Cannot add "${colName}" with UNIQUE: ALTER TABLE ADD COLUMN does not support UNIQUE constraints.`);
    }
  }

  let def = `${quoteIdentifier(colName)} ${mapped.sqlType}`;
  if (!opts.forAddColumn && col.primaryKey) def += ' PRIMARY KEY';
  if (col.notNull) def += ' NOT NULL';
  if (!opts.forAddColumn && col.unique) def += ' UNIQUE';

  const rawDefault = formatSqlDefault(String(col.defaultValue ?? ''), col.type);
  const dflt = rawDefault || mapped.defaultAuto || '';
  if (dflt) def += ` DEFAULT ${dflt}`;
  else if (opts.forAddColumn && col.notNull) {
    throw new Error(`Cannot add "${colName}" as NOT NULL without a default value.`);
  }

  if (col.foreignKey?.table && col.foreignKey.column) {
    if (opts.forAddColumn && (col.notNull || dflt)) {
      throw new Error(`Cannot add "${colName}" as a foreign key with NOT NULL or a non-NULL default.`);
    }
    def += ` REFERENCES ${quoteIdentifier(col.foreignKey.table)}(${quoteIdentifier(col.foreignKey.column)})`;
  }

  return def;
}

/** Build a `CREATE TABLE` statement from structured column definitions. */
export function generateCreateTable(tableName: string, columns: ColumnDef[]): string {
  const table = String(tableName ?? '').trim();
  validateIdentifier('table', table);

  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('At least one column is required.');
  }

  const seen = new Set<string>();
  let pkCount = 0;
  const parts: string[] = [];

  for (const col of columns) {
    const colName = String(col?.name ?? '').trim();
    validateIdentifier('column', colName);
    if (seen.has(colName)) throw new Error(`Duplicate column name: "${colName}".`);
    seen.add(colName);

    if (col.primaryKey) pkCount += 1;
    parts.push(renderColumnDef(col));
  }

  if (pkCount > 1) throw new Error('At most one primary key column is allowed.');

  return `CREATE TABLE ${quoteIdentifier(table)} (\n  ${parts.join(',\n  ')}\n);`;
}

/** Build an `ALTER TABLE … ADD COLUMN` statement. */
export function generateAddColumn(tableName: string, col: ColumnDef): string {
  const table = String(tableName ?? '').trim();
  validateIdentifier('table', table);
  const def = renderColumnDef(col, { forAddColumn: true });
  return `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${def};`;
}

/** Build an `ALTER TABLE … RENAME TO …` statement. */
export function generateRenameTable(tableName: string, newName: string): string {
  validateIdentifier('table', tableName);
  validateIdentifier('table', newName);
  return `ALTER TABLE ${quoteIdentifier(tableName)} RENAME TO ${quoteIdentifier(newName)};`;
}

/** Build an `ALTER TABLE … RENAME COLUMN … TO …` statement. */
export function generateRenameColumn(tableName: string, oldName: string, newName: string): string {
  validateIdentifier('table', tableName);
  validateIdentifier('column', oldName);
  validateIdentifier('column', newName);
  return `ALTER TABLE ${quoteIdentifier(tableName)} RENAME COLUMN ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)};`;
}

/** Build an `ALTER TABLE … DROP COLUMN …` statement. */
export function generateDropColumn(tableName: string, column: string): string {
  validateIdentifier('table', tableName);
  validateIdentifier('column', column);
  return `ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(column)};`;
}

/** Build a `DROP TABLE …` statement. */
export function generateDropTable(tableName: string): string {
  validateIdentifier('table', tableName);
  return `DROP TABLE ${quoteIdentifier(tableName)};`;
}

export interface IndexDef {
  /** Optional explicit index name; a default `idx_<table>_<cols>` is generated when omitted. */
  name?: string;
  columns: string[];
  unique?: boolean;
}

/** Build a `CREATE INDEX` (or `CREATE UNIQUE INDEX`) statement. */
export function generateCreateIndex(tableName: string, index: IndexDef): string {
  validateIdentifier('table', tableName);
  const cols = Array.isArray(index?.columns) ? index.columns : [];
  if (!cols.length) throw new Error('At least one column is required for an index.');
  for (const c of cols) validateIdentifier('column', c);
  const unique = index.unique ? 'UNIQUE ' : '';
  let name = String(index?.name ?? '').trim();
  if (!name) name = `idx_${tableName}_${cols.join('_')}`;
  validateIdentifier('index', name);
  return `CREATE ${unique}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(tableName)} (${cols.map(quoteIdentifier).join(', ')});`;
}

/** Build a `DROP INDEX …` statement. */
export function generateDropIndex(indexName: string): string {
  validateIdentifier('index', indexName);
  return `DROP INDEX ${quoteIdentifier(indexName)};`;
}

/** Build an `INSERT` statement from column/value pairs. */
export function generateInsert(table: string, fields: FieldValue[]): string {
  const cols = fields.map((f) => quoteIdentifier(f.column));
  const vals = fields.map((f) => sqlValue(f.value));
  return `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

/** Build an `UPDATE` statement from SET fields and a WHERE clause. */
export function generateUpdate(table: string, fields: FieldValue[], where: FieldValue[]): string {
  const sets = fields.map((f) => `${quoteIdentifier(f.column)} = ${sqlValue(f.value)}`);
  const conds = where.map((w) => `${quoteIdentifier(w.column)} = ${sqlValue(w.value)}`);
  return `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')};`;
}
