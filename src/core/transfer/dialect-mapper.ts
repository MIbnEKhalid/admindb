import type { ColumnDef, IndexDef } from '../../sql/generator';
import type { ColumnInfo, ForeignKeyInfo, TableInfoData } from '../../db/types';

export type SupportedDialect = 'sqlite' | 'postgres';

export interface NormalizedColumn {
  name: string;
  type: string;
  genericType: 'integer' | 'text' | 'boolean' | 'real' | 'blob' | 'datetime' | 'json';
  primaryKey: boolean;
  autoIncrement: boolean;
  notNull: boolean;
  defaultValue: string | null;
  unique: boolean;
  foreignKey: { table: string; column: string; onDelete?: string; onUpdate?: string } | null;
}

export interface NormalizedIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface NormalizedTable {
  name: string;
  columns: NormalizedColumn[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: NormalizedIndex[];
}

/**
 * Maps arbitrary database column types to a generic semantic type.
 */
export function categorizeType(rawType: string): NormalizedColumn['genericType'] {
  const t = (rawType || '').toLowerCase().trim();
  if (t.includes('int') || t.includes('serial') || t === 'smallint' || t === 'bigint') return 'integer';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('float') || t.includes('double') || t.includes('real') || t.includes('numeric') || t.includes('decimal')) return 'real';
  if (t.includes('blob') || t.includes('bytea') || t.includes('binary')) return 'blob';
  if (t.includes('date') || t.includes('time')) return 'datetime';
  if (t.includes('json')) return 'json';
  return 'text';
}

/**
 * Converts a generic/normalized column definition into dialect-specific SQL type definition.
 */
export function mapColumnToDialect(col: NormalizedColumn, targetDialect: SupportedDialect): string {
  if (targetDialect === 'postgres') {
    if (col.autoIncrement) {
      return col.type.toLowerCase().includes('big') ? 'BIGSERIAL' : 'SERIAL';
    }
    switch (col.genericType) {
      case 'integer':
        return col.type.toLowerCase().includes('big') ? 'BIGINT' : 'INTEGER';
      case 'boolean':
        return 'BOOLEAN';
      case 'real':
        return 'DOUBLE PRECISION';
      case 'blob':
        return 'BYTEA';
      case 'datetime':
        return 'TIMESTAMP WITH TIME ZONE';
      case 'json':
        return 'JSONB';
      case 'text':
      default:
        return 'TEXT';
    }
  }

  // Target: SQLite
  if (col.primaryKey && col.autoIncrement) {
    return 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }
  switch (col.genericType) {
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return 'INTEGER'; // SQLite stores booleans as 0 or 1
    case 'real':
      return 'REAL';
    case 'blob':
      return 'BLOB';
    case 'datetime':
    case 'json':
    case 'text':
    default:
      return 'TEXT';
  }
}

/**
 * Normalizes TableInfoData from IDatabase into dialect-agnostic NormalizedTable.
 */
export function normalizeTableInfo(info: TableInfoData, dialect: SupportedDialect): NormalizedTable {
  const uniqueCols = new Set<string>();
  const pks = new Set(info.primaryKey || []);

  for (const idx of info.indexes || []) {
    const cols = Array.isArray(idx.columns) ? idx.columns.filter(Boolean) : [];
    if (idx.unique && cols.length === 1 && !pks.has(cols[0])) {
      uniqueCols.add(cols[0]);
    }
  }

  const columns: NormalizedColumn[] = (info.columns || []).map((col) => {
    const isPk = col.pk > 0 || pks.has(col.name);
    const rawType = (col.type || '').toUpperCase();
    const genericType = categorizeType(rawType);

    const isAutoIncrement =
      (isPk && genericType === 'integer' && dialect === 'sqlite' && Boolean(info.sql?.toLowerCase().includes('autoincrement'))) ||
      rawType.includes('SERIAL') ||
      Boolean(col.dflt_value?.includes('nextval(')) ||
      Boolean(info.sql?.toLowerCase().includes('generated always as identity'));

    const fk = (info.foreignKeys || []).find((f) => f.from === col.name);

    return {
      name: col.name,
      type: col.type,
      genericType,
      primaryKey: isPk,
      autoIncrement: isAutoIncrement,
      notNull: Boolean(col.notnull),
      defaultValue: col.dflt_value,
      unique: uniqueCols.has(col.name),
      foreignKey: fk
        ? {
            table: fk.table,
            column: fk.to || '',
            onDelete: fk.on_delete,
            onUpdate: fk.on_update,
          }
        : null,
    };
  });

  const indexes: NormalizedIndex[] = (info.indexes || [])
    .filter((ix) => !ix.name?.startsWith('sqlite_') && ix.origin !== 'pk' && (!ix.name?.endsWith('_pkey') || !ix.unique))
    .map((ix) => {
      let cols: string[] = [];
      if (Array.isArray(ix.columns)) {
        cols = ix.columns.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
      } else if (typeof ix.columns === 'string') {
        cols = [ix.columns];
      }
      return {
        name: ix.name || `idx_${info.table}_${cols.join('_') || 'col'}`,
        unique: Boolean(ix.unique),
        columns: cols,
      };
    })
    .filter((ix) => ix.columns.length > 0);

  return {
    name: info.table,
    columns,
    primaryKeys: info.primaryKey || [],
    foreignKeys: info.foreignKeys || [],
    indexes,
  };
}

/**
 * Converts a row value from source dialect to target dialect format.
 */
export function convertValueForDialect(
  value: unknown,
  genericType: NormalizedColumn['genericType'],
  targetDialect: SupportedDialect,
): unknown {
  if (value === null || value === undefined) return null;

  if (targetDialect === 'postgres') {
    if (genericType === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
      return Boolean(value);
    }
    if (genericType === 'json') {
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }
    if (genericType === 'blob') {
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return Buffer.from(value);
      return Buffer.from(String(value));
    }
    return value;
  }

  // Target: SQLite
  if (genericType === 'boolean') {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    if (typeof value === 'string') return value === 'true' || value === '1' ? 1 : 0;
    return value ? 1 : 0;
  }
  if (genericType === 'json') {
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  if (genericType === 'datetime') {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (genericType === 'blob') {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
  }

  return value;
}

/**
 * Safely maps or converts a column default value between dialects (e.g. Postgres -> SQLite).
 */
export function mapDefaultValueForDialect(
  defaultValue: string | null | undefined,
  genericType: NormalizedColumn['genericType'],
  targetDialect: SupportedDialect,
): string | null {
  if (defaultValue === null || defaultValue === undefined) return null;
  let def = String(defaultValue).trim();
  if (!def) return null;

  if (targetDialect === 'sqlite') {
    // 1. Strip PostgreSQL type casts like ::character varying, ::text, ::regclass, ::bigint, etc.
    def = def.replace(/::[a-zA-Z0-9_ "]+(\[\])?/g, '').trim();

    // 2. Nextval / sequence calls -> not applicable in SQLite
    if (/nextval\(.*?\)/i.test(def)) {
      return null;
    }

    // 3. PostgreSQL time functions -> SQLite CURRENT_TIMESTAMP
    if (/^(now\(\)|current_timestamp|current_timestamp\(\)|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\)|\('now'.*?\))$/i.test(def)) {
      return 'CURRENT_TIMESTAMP';
    }

    // 4. UUID generation functions or other PG-specific functions not in SQLite standard DDL
    if (/^(gen_random_uuid\(\)|uuid_generate_v\d\(\)|random\(\)|uuid\(\))$/i.test(def)) {
      return null;
    }

    // 5. Booleans: true/false -> 1/0
    if (/^true$/i.test(def)) return '1';
    if (/^false$/i.test(def)) return '0';

    // 6. Strip outer redundant parentheses like ((0)) or ('active')
    while (def.startsWith('(') && def.endsWith(')')) {
      const inner = def.slice(1, -1).trim();
      let depth = 0;
      let okToStrip = true;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') depth++;
        else if (inner[i] === ')') {
          depth--;
          if (depth < 0) { okToStrip = false; break; }
        }
      }
      if (okToStrip && depth === 0) {
        def = inner;
      } else {
        break;
      }
    }

    // Re-check after stripping parens
    if (/^(now\(\)|current_timestamp|current_timestamp\(\)|clock_timestamp\(\)|\('now'.*?\))$/i.test(def)) {
      return 'CURRENT_TIMESTAMP';
    }
    if (/^true$/i.test(def)) return '1';
    if (/^false$/i.test(def)) return '0';
    if (/nextval\(.*?\)/i.test(def)) return null;
    if (/^(gen_random_uuid\(\)|uuid_generate_v\d\(\))$/i.test(def)) return null;

    // 7. If it's still an unquoted function call with () that is not CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME
    if (/^[a-zA-Z0-9_]+\(.*\)$/.test(def) && !/^(current_timestamp|current_date|current_time)$/i.test(def)) {
      return null;
    }

    return def;
  }

  // Target: PostgreSQL
  if (targetDialect === 'postgres') {
    if (genericType === 'boolean') {
      if (def === '1' || def === "'1'") return 'TRUE';
      if (def === '0' || def === "'0'") return 'FALSE';
    }
    // Skip nextval(...) defaults when migrating into PostgreSQL as SERIAL handles sequence creation
    if (/nextval\(.*?\)/i.test(def)) {
      return null;
    }
    return def;
  }

  return def;
}

/**
 * Generates CREATE TABLE SQL statement for the target dialect from a NormalizedTable.
 */
export function generateCreateTableForDialect(table: NormalizedTable, targetDialect: SupportedDialect): string {
  const lines: string[] = [];
  const q = targetDialect === 'postgres' ? (s: string) => `"${s}"` : (s: string) => `\`${s}\``;

  // Single-column autoincrement primary key check for SQLite
  const singleAutoPk =
    targetDialect === 'sqlite' &&
    table.columns.filter((c) => c.primaryKey).length === 1 &&
    table.columns.find((c) => c.primaryKey)?.autoIncrement;

  for (const col of table.columns) {
    let colSql = `${q(col.name)} ${mapColumnToDialect(col, targetDialect)}`;

    const isPgSerial = targetDialect === 'postgres' && col.autoIncrement;

    if (singleAutoPk && col.primaryKey) {
      // Already has INTEGER PRIMARY KEY AUTOINCREMENT from mapColumnToDialect
    } else if (isPgSerial) {
      // PostgreSQL SERIAL / BIGSERIAL already creates NOT NULL and DEFAULT nextval() automatically
      if (col.unique && !col.primaryKey) colSql += ' UNIQUE';
    } else {
      if (col.notNull) colSql += ' NOT NULL';
      if (col.unique && !col.primaryKey) colSql += ' UNIQUE';
      const mappedDefault = mapDefaultValueForDialect(col.defaultValue, col.genericType, targetDialect);
      if (mappedDefault !== null && mappedDefault !== undefined) {
        colSql += ` DEFAULT ${mappedDefault}`;
      }
    }
    lines.push(colSql);
  }

  // Composite or non-autoincrement Primary Key
  if (!singleAutoPk && table.primaryKeys.length > 0) {
    const validPks = table.primaryKeys.filter((pk) => table.columns.some((c) => c.name === pk));
    if (validPks.length > 0) {
      lines.push(`PRIMARY KEY (${validPks.map(q).join(', ')})`);
    }
  }

  // Foreign keys
  if (targetDialect === 'sqlite') {
    for (const fk of table.foreignKeys) {
      if (fk.from && fk.to && fk.table) {
        const targetTable = fk.table.includes('.') ? fk.table.split('.').pop()! : fk.table;
        let fkSql = `FOREIGN KEY (${q(fk.from)}) REFERENCES ${q(targetTable)} (${q(fk.to)})`;
        if (fk.on_delete && fk.on_delete !== 'NO ACTION') fkSql += ` ON DELETE ${fk.on_delete}`;
        if (fk.on_update && fk.on_update !== 'NO ACTION') fkSql += ` ON UPDATE ${fk.on_update}`;
        lines.push(fkSql);
      }
    }
  }

  return `CREATE TABLE ${q(table.name)} (\n  ${lines.join(',\n  ')}\n);`;
}
