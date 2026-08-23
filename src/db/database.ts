import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger';
import {
  quoteIdentifier,
  generateAddColumn,
  generateRenameTable,
  generateRenameColumn,
  generateDropColumn,
  generateDropTable,
  generateCreateIndex,
  generateDropIndex,
  type ColumnDef,
  type IndexDef,
} from '../sql/generator';
import { errorMessage } from '../utils/common';
import type {
  ColumnInfo,
  DatabaseDialect,
  DbOpenOptions,
  IDatabase,
  MutationResult,
  ReferencingTableInfo,
  Result,
  RowFilters,
  SavedQuery,
  SchemaInfo,
  SQLInputValue,
  TableInfoData,
  TableListItem,
  WhereClause,
} from './types';
import { INTERNAL_TABLES } from './types';
import { buildFilterClause } from './filters';
import { getSchemaSync, getTableInfoSync, listTablesSync, getReferencingTablesSync } from './introspection';
import { modifyTableStructureSync } from './migrations';

export * from './types';
export * from './filters';

/**
 * Promise-style wrapper around the better-sqlite3 driver.
 * Every call returns a consistent `{ success, data?, error? }` shape and
 * performs one-time, idempotent schema initialization.
 */
export class SqliteDatabase implements IDatabase {
  private db: Database.Database;
  private logger: Logger;
  readonly path: string;
  readonly isReadOnly: boolean;
  readonly dialect: DatabaseDialect = 'sqlite';


  constructor(dbPath: string, logger: Logger, options: DbOpenOptions = {}) {
    this.path = dbPath;
    this.logger = logger;
    this.isReadOnly = !!options.readonly;
    this.db = new Database(dbPath, { readonly: this.isReadOnly });
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.isReadOnly) {
      this.db.exec('PRAGMA query_only = ON;');
    } else {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.initSchema();
    }
    this.logger.info(`Opened SQLite database at ${dbPath}${this.isReadOnly ? ' (read-only)' : ''}`);
  }

  private readonlyBlocked(): Result<never> {
    return { success: false, error: 'Database is open in read-only mode — write operations are disabled.' };
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      this.logger.warn(`Failed to close database: ${errorMessage(err)}`);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} (
        ${quoteIdentifier('id')} INTEGER PRIMARY KEY AUTOINCREMENT,
        ${quoteIdentifier('name')} TEXT NOT NULL UNIQUE,
        ${quoteIdentifier('sql')} TEXT NOT NULL,
        ${quoteIdentifier('created_at')} TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private async tryRun<T>(fn: () => T): Promise<Result<T>> {
    try {
      const data = await Promise.resolve(fn());
      return { success: true, data };
    } catch (err) {
      const msg = errorMessage(err);
      this.logger.error(msg);
      return { success: false, error: msg };
    }
  }

  /** Run an atomic transaction. Reverts on any error and enforces read-only mode. */
  private transaction<T>(fn: () => T): Promise<Result<T>> {
    if (this.isReadOnly) return Promise.resolve(this.readonlyBlocked());
    return this.tryRun(() => {
      this.db.exec('BEGIN');
      try {
        const res = fn();
        this.db.exec('COMMIT');
        return res;
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    });
  }

  private toBind(value: unknown): SQLInputValue {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return value;
    return value as SQLInputValue;
  }

  async all(sql: string, params: SQLInputValue[] = []): Promise<Result<unknown[]>> {
    return this.tryRun(() => this.db.prepare(sql).all(...params) as unknown[]);
  }

  async run(sql: string, params: SQLInputValue[] = []): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      const info = this.db.prepare(sql).run(...params);
      return {
        changes: Number(info.changes),
        lastInsertRowid: info.lastInsertRowid === undefined || info.lastInsertRowid === null ? null : Number(info.lastInsertRowid),
      };
    });
  }

  async execResult(sql: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      this.db.exec(sql);
      return { changes: undefined };
    });
  }

  hasMultipleStatements(sql: string): boolean {
    const s = String(sql ?? '').trim();
    if (!s) return false;
    try {
      this.db.prepare(s);
      return false;
    } catch (err) {
      return /more than one statement/i.test(errorMessage(err));
    }
  }

  async runWrite(sql: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    const trimmed = String(sql).trim().replace(/;+\s*$/, '');
    try {
      const stmt = this.db.prepare(trimmed);
      const info = stmt.run();
      return { success: true, data: { changes: Number(info.changes) } };
    } catch {
      try {
        this.db.exec(String(sql));
        return { success: true, data: { changes: undefined } };
      } catch (err2) {
        const msg = errorMessage(err2);
        this.logger.error(msg);
        return { success: false, error: msg };
      }
    }
  }

  async listTables(): Promise<Result<TableListItem[]>> {
    return this.tryRun(() => listTablesSync(this.db));
  }

  async getTableInfo(table: string): Promise<Result<TableInfoData>> {
    return this.tryRun(() => getTableInfoSync(this.db, table));
  }

  async getRowCount(table: string, filters?: RowFilters): Promise<Result<number>> {
    return this.tryRun(() => {
      const info = this.getTableInfoSync(table);
      const { where, params } = buildFilterClause(filters, info?.columns.map((c) => c.name) ?? []);
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}${where}`)
        .get(...params) as { c: number | bigint };
      return Number(row.c);
    });
  }

  async getRows(
    table: string,
    opts: { page?: number; limit?: number; orderBy?: string; orderDir?: 'asc' | 'desc'; filters?: RowFilters } = {},
  ): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(() => {
      const info = this.getTableInfoSync(table);
      const cols = info?.columns ?? [];
      const orderCol = opts.orderBy || info?.primaryKey?.[0] || cols[0]?.name;
      const orderDir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
      const page = opts.page && opts.page > 0 ? opts.page : 1;
      const offset = (page - 1) * limit;
      const { where, params } = buildFilterClause(opts.filters, cols.map((c) => c.name));

      let sql = `SELECT rowid AS _rowid_, * FROM ${quoteIdentifier(table)}${where}`;
      if (orderCol) sql += ` ORDER BY ${quoteIdentifier(orderCol)} ${orderDir}`;
      sql += ` LIMIT ${limit} OFFSET ${offset}`;

      return this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    });
  }

  async getAllRows(table: string): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(() => this.db.prepare(`SELECT rowid AS _rowid_, * FROM ${quoteIdentifier(table)}`).all() as unknown as Record<string, unknown>[]);
  }

  async getRow(table: string, where: WhereClause[]): Promise<Result<Record<string, unknown> | null>> {
    return this.tryRun(() => {
      const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
      const sql = `SELECT rowid AS _rowid_, * FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')} LIMIT 1`;
      const row = this.db.prepare(sql).get(...where.map((w) => this.toBind(w.value)));
      return row ? (row as Record<string, unknown>) : null;
    });
  }

  async insertRow(table: string, fields: WhereClause[]): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    const cols = fields.map((f) => quoteIdentifier(f.column));
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
    return this.run(sql, fields.map((f) => this.toBind(f.value)));
  }

  /** Insert many rows inside a single atomic transaction. */
  async insertRows(table: string, rows: WhereClause[][]): Promise<Result<{ inserted: number; skipped: number }>> {
    return this.transaction(() => {
      let inserted = 0;
      for (const fields of rows) {
        if (!fields.length) continue;
        const cols = fields.map((f) => quoteIdentifier(f.column));
        const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
        this.db.prepare(sql).run(...fields.map((f) => this.toBind(f.value)));
        inserted += 1;
      }
      return { inserted, skipped: rows.length - inserted };
    });
  }

  async updateRow(table: string, fields: WhereClause[], where: WhereClause[]): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    const sets = fields.map((f) => `${quoteIdentifier(f.column)} = ?`);
    const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
    const sql = `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`;
    return this.run(sql, [...fields.map((f) => this.toBind(f.value)), ...where.map((w) => this.toBind(w.value))]);
  }

  /** Apply many row updates inside a single atomic transaction. */
  async updateRows(
    table: string,
    rows: { fields: WhereClause[]; where: WhereClause[] }[],
  ): Promise<Result<{ updated: number }>> {
    return this.transaction(() => {
      let updated = 0;
      for (const { fields, where } of rows) {
        if (!fields.length || !where.length) continue;
        const sets = fields.map((f) => `${quoteIdentifier(f.column)} = ?`);
        const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
        const sql = `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`;
        const info = this.db.prepare(sql).run(
          ...[...fields.map((f) => this.toBind(f.value)), ...where.map((w) => this.toBind(w.value))],
        );
        updated += Number(info.changes);
      }
      return { updated };
    });
  }

  async deleteRow(table: string, where: WhereClause[]): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
    const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')}`;
    return this.run(sql, where.map((w) => this.toBind(w.value)));
  }

  /** Delete many rows inside a single atomic transaction. */
  async deleteRows(table: string, rows: WhereClause[][]): Promise<Result<{ deleted: number }>> {
    return this.transaction(() => {
      let deleted = 0;
      for (const where of rows) {
        if (!where.length) continue;
        const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
        const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')}`;
        const info = this.db.prepare(sql).run(...where.map((w) => this.toBind(w.value)));
        deleted += Number(info.changes);
      }
      return { deleted };
    });
  }

  async getRowsByPks(table: string, pks: WhereClause[][]): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(() => {
      const groups: string[] = [];
      const params: SQLInputValue[] = [];
      for (const where of pks) {
        if (!where.length) continue;
        groups.push(where.map((w) => `${quoteIdentifier(w.column)} = ?`).join(' AND '));
        params.push(...where.map((w) => this.toBind(w.value)));
      }
      if (!groups.length) return [];
      const sql = `SELECT rowid AS _rowid_, * FROM ${quoteIdentifier(table)} WHERE ${groups.map((g) => `(${g})`).join(' OR ')}`;
      return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    });
  }

  async getCreateStatement(table: string): Promise<Result<string | null>> {
    return this.tryRun(() => {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql?: string | null } | undefined;
      return row?.sql ?? null;
    });
  }

  async listSavedQueries(): Promise<Result<SavedQuery[]>> {
    return this.all(
      `SELECT id, name, sql, created_at FROM ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} ORDER BY name COLLATE NOCASE`,
    ) as Promise<Result<SavedQuery[]>>;
  }

  async saveQuery(name: string, sql: string): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    return this.run(`INSERT INTO ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} (name, sql) VALUES (?, ?)`, [name, sql]);
  }

  async deleteSavedQuery(id: string | number): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    return this.run(`DELETE FROM ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} WHERE id = ?`, [Number(id)]);
  }

  async getSettings(): Promise<Result<Record<string, string>>> {
    return this.tryRun(() => {
      const pragmas = ['journal_mode', 'synchronous', 'foreign_keys', 'page_size', 'encoding', 'auto_vacuum', 'mmap_size', 'temp_store'];
      const settings: Record<string, string> = {};
      for (const p of pragmas) {
        try {
          const row = this.db.prepare(`PRAGMA ${p}`).get() as Record<string, unknown> | undefined;
          if (row && p in row) {
            settings[p] = String(row[p]);
          }
        } catch {
          // ignore unsupported pragmas
        }
      }
      return settings;
    });
  }

  async getSchema(table: string): Promise<Result<SchemaInfo>> {
    return this.tryRun(() => getSchemaSync(this.db, table));
  }

  async getReferencingTables(table: string): Promise<Result<ReferencingTableInfo[]>> {
    return this.tryRun(() => getReferencingTablesSync(this.db, table));
  }

  async getRowsByFk(table: string, column: string, value: unknown, limit = 50): Promise<Result<{ rows: Record<string, unknown>[]; total: number }>> {
    return this.tryRun(() => {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`)
        .get(value) as { c: number | bigint };
      const rows = this.db
        .prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ? LIMIT ${n}`)
        .all(value) as Record<string, unknown>[];
      return { rows, total: Number(countRow.c) };
    });
  }

  async renameTable(oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateRenameTable(oldName, newName));
  }

  async addColumn(table: string, col: ColumnDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      if (col.primaryKey) {
        return modifyTableStructureSync(this.db, table, (existingCols) => [...existingCols, col]);
      }
      try {
        const colCopy = { ...col, unique: false };
        const sql = generateAddColumn(table, colCopy);
        this.db.exec(sql);
        if (col.unique) {
          const idxName = `idx_${table}_${col.name}_unique`;
          this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(idxName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(col.name)});`);
        }
        return { changes: 1 };
      } catch {
        return modifyTableStructureSync(this.db, table, (existingCols) => [...existingCols, col]);
      }
    });
  }

  async modifyColumn(table: string, oldColName: string, newColDef: ColumnDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      const newName = String(newColDef.name || oldColName).trim();
      const rawCols = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
      const existing = rawCols.find((c) => c.name === oldColName);
      if (!existing) throw new Error(`Column "${oldColName}" does not exist in table "${table}".`);

      const fks = this.db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as { from: string; table: string; to: string | null }[];
      const existingFk = fks.find((f) => f.from === oldColName);
      const indexRows = this.db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as { name: string; unique: number }[];

      let existingIsUnique = false;
      for (const ix of indexRows) {
        if (ix.unique) {
          const ixCols = (this.db.prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`).all() as { name: string }[]).map((c) => c.name);
          if (ixCols.length === 1 && ixCols[0] === oldColName) {
            existingIsUnique = true;
            break;
          }
        }
      }

      const typeMatches = !newColDef.type || newColDef.type.toUpperCase() === existing.type.toUpperCase();
      const pkMatches = newColDef.primaryKey === undefined || newColDef.primaryKey === (existing.pk > 0);
      const notNullMatches = newColDef.notNull === undefined || newColDef.notNull === (!!existing.notnull);
      const uniqueMatches = newColDef.unique === undefined || newColDef.unique === existingIsUnique;
      const defaultMatches = newColDef.defaultValue === undefined || String(newColDef.defaultValue ?? '').trim() === String(existing.dflt_value ?? '').trim();
      const fkMatches = newColDef.foreignKey === undefined || (
        (!newColDef.foreignKey && !existingFk) ||
        (newColDef.foreignKey && existingFk && newColDef.foreignKey.table === existingFk.table && newColDef.foreignKey.column === existingFk.to)
      );

      // Fast path: if ONLY the column name changed, use native RENAME COLUMN.
      if (oldColName !== newName && typeMatches && pkMatches && notNullMatches && uniqueMatches && defaultMatches && fkMatches) {
        this.db.exec(generateRenameColumn(table, oldColName, newName));

        const existingIdxNames = new Set(indexRows.map((i) => i.name));
        for (const suffix of ['', '_unique']) {
          const defaultOldIdx = `idx_${table}_${oldColName}${suffix}`;
          if (existingIdxNames.has(defaultOldIdx)) {
            const newIdxName = `idx_${table}_${newName}${suffix}`;
            const uniqueKeyword = suffix === '_unique' ? 'UNIQUE ' : '';
            try {
              this.db.exec(`DROP INDEX ${quoteIdentifier(defaultOldIdx)};`);
              this.db.exec(`CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${quoteIdentifier(newIdxName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(newName)});`);
            } catch { /* ignore */ }
          }
        }
        return { changes: 1 };
      }

      if (oldColName === newName && typeMatches && pkMatches && notNullMatches && uniqueMatches && defaultMatches && fkMatches) {
        return { changes: 0 };
      }

      return modifyTableStructureSync(
        this.db,
        table,
        (cols) => {
          const idx = cols.findIndex((c) => c.name === oldColName);
          if (idx === -1) throw new Error(`Column "${oldColName}" does not exist in table "${table}".`);
          const updated = [...cols];
          updated[idx] = {
            ...updated[idx],
            name: newName,
            type: newColDef.type || updated[idx].type,
            primaryKey: newColDef.primaryKey !== undefined ? newColDef.primaryKey : updated[idx].primaryKey,
            notNull: newColDef.notNull !== undefined ? newColDef.notNull : updated[idx].notNull,
            unique: newColDef.unique !== undefined ? newColDef.unique : updated[idx].unique,
            defaultValue: newColDef.defaultValue !== undefined ? newColDef.defaultValue : updated[idx].defaultValue,
            foreignKey: newColDef.foreignKey !== undefined ? newColDef.foreignKey : updated[idx].foreignKey,
          };
          return updated;
        },
        oldColName,
        newName,
      );
    });
  }

  async renameColumn(table: string, oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      this.db.exec(generateRenameColumn(table, oldName, newName));

      const indexRows = this.db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as { name: string }[];
      const existingIdxNames = new Set(indexRows.map((i) => i.name));

      for (const suffix of ['', '_unique']) {
        const defaultOldIdx = `idx_${table}_${oldName}${suffix}`;
        if (existingIdxNames.has(defaultOldIdx)) {
          const newIdxName = `idx_${table}_${newName}${suffix}`;
          const uniqueKeyword = suffix === '_unique' ? 'UNIQUE ' : '';
          try {
            this.db.exec(`DROP INDEX ${quoteIdentifier(defaultOldIdx)};`);
            this.db.exec(`CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${quoteIdentifier(newIdxName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(newName)});`);
          } catch { /* ignore */ }
        }
      }

      return { changes: 1 };
    });
  }

  async dropColumn(table: string, column: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateDropColumn(table, column));
  }

  async dropTable(table: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateDropTable(table));
  }

  async createIndex(table: string, index: IndexDef): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateCreateIndex(table, index));
  }

  async dropIndex(indexName: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateDropIndex(indexName));
  }

  private getTableInfoSync(table: string): TableInfoData | null {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
      if (!cols.length) return null;
      const primaryKey = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      return { table, columns: cols, foreignKeys: [], primaryKey, indexes: [], sql: null };
    } catch {
      return null;
    }
  }
}
