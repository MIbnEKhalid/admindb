import type Database from 'better-sqlite3';
import { quoteIdentifier, escapeString, type ColumnDef, type IndexDef } from '../../../sql/generator';
import type { IDdlGenerator } from '../types';
import type { ColumnInfo, ForeignKeyInfo, Result } from '../../types';
import { mapSqliteColumnType } from './types';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function validateIdentifier(kind: string, name: string): void {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error(`${label} name is required.`);
  if (!IDENTIFIER_RE.test(trimmed)) {
    throw new Error(`Invalid ${label.toLowerCase()} name: "${trimmed}". Use letters, digits and underscores.`);
  }
}

function formatSqlDefault(raw: string, colType?: string): string {
  const s = String(raw ?? '').trim().replace(/;/g, '');
  if (!s) return '';
  if (/^null$/i.test(s)) return 'NULL';
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(true|false)$/i.test(s)) return s.toUpperCase() === 'TRUE' ? '1' : '0';
  if (/^'.*'$/s.test(s) || /^".*"$/s.test(s) || /^[a-zA-Z_]\w*\s*\(.*\)$/s.test(s)) return s;
  if (/^CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME$/i.test(s)) return s.toUpperCase();
  const t = (colType || '').toUpperCase();
  if (t.includes('TEXT') || t.includes('CHAR') || t.includes('CLOB') || t.includes('VARCHAR') || t.includes('STRING')) {
    return escapeString(s);
  }
  return s;
}

export function renderSqliteColumnDef(col: ColumnDef, opts: { forAddColumn?: boolean } = {}): string {
  const colName = String(col?.name ?? '').trim();
  validateIdentifier('column', colName);
  const mapped = mapSqliteColumnType(col.type);

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
  if (dflt) {
    def += ` DEFAULT ${dflt}`;
  } else if (opts.forAddColumn && col.notNull) {
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

export class SqliteDdlGenerator implements IDdlGenerator {
  createTable(tableName: string, columns: ColumnDef[]): string {
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
      if (col.primaryKey) pkCount++;
      parts.push(renderSqliteColumnDef(col));
    }

    if (pkCount > 1) throw new Error('At most one primary key column is allowed.');
    return `CREATE TABLE ${quoteIdentifier(table)} (\n  ${parts.join(',\n  ')}\n);`;
  }

  renameTable(oldName: string, newName: string): string {
    validateIdentifier('table', oldName);
    validateIdentifier('table', newName);
    return `ALTER TABLE ${quoteIdentifier(oldName)} RENAME TO ${quoteIdentifier(newName)};`;
  }

  dropTable(table: string, _options?: { cascade?: boolean }): string {
    validateIdentifier('table', table);
    return `DROP TABLE ${quoteIdentifier(table)};`;
  }

  addColumn(table: string, col: ColumnDef): string {
    validateIdentifier('table', table);
    return `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${renderSqliteColumnDef(col, { forAddColumn: true })};`;
  }

  renameColumn(table: string, oldName: string, newName: string): string {
    validateIdentifier('table', table);
    validateIdentifier('column', oldName);
    validateIdentifier('column', newName);
    return `ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)};`;
  }

  dropColumn(table: string, column: string): string {
    validateIdentifier('table', table);
    validateIdentifier('column', column);
    return `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)};`;
  }

  createIndex(table: string, index: IndexDef): string {
    const unique = index.unique ? 'UNIQUE ' : '';
    const cols = index.columns.map(quoteIdentifier).join(', ');
    const name = index.name || `idx_${table}_${index.columns.join('_')}`;
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${quoteIdentifier(table)} (${cols});`;
  }

  dropIndex(indexName: string): string {
    return `DROP INDEX IF EXISTS ${quoteIdentifier(indexName)};`;
  }

  async modifyColumn(driver: any, table: string, oldCol: string, newCol: ColumnDef): Promise<Result<{ changes?: number }>> {
    try {
      const db: Database.Database = driver.db || driver;
      const rawCols = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as ColumnInfo[];
      if (!rawCols.length) throw new Error(`Table "${table}" does not exist.`);

      const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as unknown as ForeignKeyInfo[];
      const indexRows = db
        .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
        .all() as unknown as { seq: number; name: string; unique: number; origin: string; partial: number }[];

      const uniqueCols = new Set<string>();
      for (const ix of indexRows) {
        if (ix.unique) {
          const ixCols = (
            db.prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`).all() as unknown as { seqno: number; cid: number; name: string }[]
          ).map((c) => c.name);
          if (ixCols.length === 1) uniqueCols.add(ixCols[0]);
        }
      }

      const userIndexes: { name: string; unique: boolean; columns: string[] }[] = [];
      for (const ix of indexRows) {
        if (ix.origin === 'c') {
          const ixCols = (
            db.prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`).all() as unknown as { seqno: number; cid: number; name: string }[]
          ).map((c) => c.name);
          let ixName = ix.name;
          const renamedNewCol = newCol.name;
          if (oldCol && renamedNewCol) {
            if (ixName === `idx_${table}_${oldCol}`) {
              ixName = `idx_${table}_${renamedNewCol}`;
            } else if (ixName === `idx_${table}_${oldCol}_unique`) {
              ixName = `idx_${table}_${renamedNewCol}_unique`;
            }
          }
          userIndexes.push({
            name: ixName,
            unique: Boolean(ix.unique),
            columns: ixCols.map((c) => (oldCol && renamedNewCol && c === oldCol ? renamedNewCol : c)),
          });
        }
      }

      const currentCols: ColumnDef[] = rawCols.map((c) => {
        const existingFk = fks.find((f) => f.from === c.name);
        return {
          name: c.name,
          type: c.type,
          primaryKey: c.pk > 0,
          notNull: Boolean(c.notnull),
          unique: uniqueCols.has(c.name),
          defaultValue: c.dflt_value,
          foreignKey: existingFk ? { table: existingFk.table, column: existingFk.to ?? '' } : null,
        };
      });

      const newCols = currentCols.map((c) => (c.name === oldCol ? { ...c, ...newCol } : c));
      const tempTable = `_admindb_tmp_${table}_${Date.now()}`;
      const createSql = this.createTable(tempTable, newCols);

      const oldColMap = new Set(rawCols.map((c) => c.name));
      const matchingOldCols: string[] = [];
      const matchingNewCols: string[] = [];

      for (const nc of newCols) {
        const sourceColName = oldCol && newCol.name && nc.name === newCol.name ? oldCol : nc.name;
        if (oldColMap.has(sourceColName)) {
          matchingOldCols.push(quoteIdentifier(sourceColName));
          matchingNewCols.push(quoteIdentifier(nc.name));
        }
      }

      db.exec('PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;');
      try {
        db.exec(createSql);
        if (matchingOldCols.length > 0) {
          db.exec(
            `INSERT INTO ${quoteIdentifier(tempTable)} (${matchingNewCols.join(', ')}) SELECT ${matchingOldCols.join(', ')} FROM ${quoteIdentifier(table)};`,
          );
        }
        db.exec(`DROP TABLE ${quoteIdentifier(table)};`);
        db.exec(`ALTER TABLE ${quoteIdentifier(tempTable)} RENAME TO ${quoteIdentifier(table)};`);

        for (const ix of userIndexes) {
          const uq = ix.unique ? 'UNIQUE ' : '';
          const ixColsStr = ix.columns.map(quoteIdentifier).join(', ');
          try {
            db.exec(`CREATE ${uq}INDEX IF NOT EXISTS ${quoteIdentifier(ix.name)} ON ${quoteIdentifier(table)} (${ixColsStr});`);
          } catch {}
        }

        if (db.prepare('PRAGMA foreign_key_check;').all().length > 0) {
          throw new Error('Foreign key constraint check failed after schema modification.');
        }

        db.exec('COMMIT;');
        return { success: true, data: { changes: 1 } };
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {}
        throw err;
      } finally {
        try {
          db.exec('PRAGMA foreign_keys = ON;');
        } catch {}
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
