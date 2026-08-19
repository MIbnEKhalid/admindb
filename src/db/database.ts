import Database from 'better-sqlite3';
import type { Logger } from '../logger';
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
import { errorMessage, type FilterCondition, type FilterValue } from '../util';

/** Structured filter types are shared with the API layer. */
export type { FilterCondition, FilterValue } from '../util';

/** SQLite-compatible bind value accepted by better-sqlite3 statements. */
export type SQLInputValue = null | number | bigint | string | Uint8Array;

export interface Result<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface TableListItem {
  name: string;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

export interface TableInfoData {
  table: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: string[];
  /** Indexes (including UNIQUE / JSON-expression indexes) — used by the data generator. */
  indexes: IndexInfo[];
  /** The table's `CREATE TABLE` statement (used to parse CHECK constraints). */
  sql: string | null;
}

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
  created_at: string;
}

export interface WhereClause {
  column: string;
  value: unknown;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  partial: number;
  /** Index origin: 'c' = explicit CREATE INDEX, 'pk'/'u' = automatic (primary key / unique). */
  origin: string;
  columns: string[];
  /** The `CREATE INDEX` statement from sqlite_master, when available. */
  sql?: string | null;
}

export interface RowFilters {
  [column: string]: FilterValue;
}

export interface ColumnDetail extends ColumnInfo {
  unique: boolean;
  indexed: boolean;
  /** Foreign keys in OTHER tables whose referenced column is this column. */
  referencedBy: { table: string; from: string }[];
  /** The foreign key this column participates in (as the child), if any. */
  fk: ForeignKeyInfo | null;
  canDrop: boolean;
  dropBlockers: string[];
}

export interface SchemaInfo {
  table: string;
  columns: ColumnDetail[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  /** Foreign keys in other tables that reference this table. */
  references: { table: string; from: string; to: string }[];
}

export interface ReferencingTableInfo {
  table: string;
  /** FK columns in `table` that point at this table (`from` → `to`). */
  refs: { from: string; to: string }[];
  /** Rows in `table` whose FK column(s) actually reference this table. */
  refCount: number;
}

export const INTERNAL_TABLES = {
  savedQueries: '_saved_queries',
} as const;

/** Escape LIKE wildcards so user filter text is matched literally. */
function escapeLike(s: string): string {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * Build a parameterized WHERE clause from per-column filters.
 *
 * A filter value is either:
 *   - the legacy string syntax: `=value` exact, `!=value`, `>value`, `>=value`,
 *     `<value`, `<=value`, `value*` prefix, anything else → substring match; or
 *   - a structured `FilterCondition` (or array of them) produced by the
 *     type-aware filter form (FK dropdowns, boolean toggles, date/number ranges).
 */
function pushFilterCondition(conds: string[], params: SQLInputValue[], quotedCol: string, c: FilterCondition): void {
  const value = String(c.value ?? '');
  switch (c.op) {
    case 'eq':
      conds.push(`${quotedCol} = ?`);
      params.push(value);
      break;
    case 'neq':
      conds.push(`${quotedCol} != ?`);
      params.push(value);
      break;
    case 'gt':
      conds.push(`${quotedCol} > ?`);
      params.push(value);
      break;
    case 'gte':
      conds.push(`${quotedCol} >= ?`);
      params.push(value);
      break;
    case 'lt':
      conds.push(`${quotedCol} < ?`);
      params.push(value);
      break;
    case 'lte':
      conds.push(`${quotedCol} <= ?`);
      params.push(value);
      break;
    case 'like':
      conds.push(`${quotedCol} LIKE ? ESCAPE '\\'`);
      params.push('%' + escapeLike(value) + '%');
      break;
    case 'prefix':
      conds.push(`${quotedCol} LIKE ? ESCAPE '\\'`);
      params.push(escapeLike(value) + '%');
      break;
    case 'between':
      conds.push(`${quotedCol} >= ?`);
      params.push(value);
      conds.push(`${quotedCol} <= ?`);
      params.push(String(c.max ?? ''));
      break;
    case 'null':
      conds.push(`${quotedCol} IS NULL`);
      break;
    case 'notnull':
      conds.push(`${quotedCol} IS NOT NULL`);
      break;
    default:
      break;
  }
}

export function buildFilterClause(
  filters: RowFilters | undefined,
  availableCols: string[],
): { where: string; params: SQLInputValue[] } {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  const colSet = new Set(availableCols);
  for (const [col, raw] of Object.entries(filters ?? {})) {
    if (!colSet.has(col)) continue;
    const q = quoteIdentifier(col);

    if (Array.isArray(raw)) {
      for (const c of raw) {
        if (c && typeof c === 'object') pushFilterCondition(conds, params, q, c);
      }
      continue;
    }
    if (raw && typeof raw === 'object') {
      pushFilterCondition(conds, params, q, raw as FilterCondition);
      continue;
    }

    // Legacy string syntax.
    const value = String(raw ?? '').trim();
    if (value === '') continue;
    if (value.startsWith('>=')) {
      conds.push(`${q} >= ?`);
      params.push(value.slice(2).trim());
    } else if (value.startsWith('<=')) {
      conds.push(`${q} <= ?`);
      params.push(value.slice(2).trim());
    } else if (value.startsWith('!=')) {
      conds.push(`${q} != ?`);
      params.push(value.slice(2).trim());
    } else if (value.startsWith('=')) {
      conds.push(`${q} = ?`);
      params.push(value.slice(1).trim());
    } else if (value.startsWith('>')) {
      conds.push(`${q} > ?`);
      params.push(value.slice(1).trim());
    } else if (value.startsWith('<')) {
      conds.push(`${q} < ?`);
      params.push(value.slice(1).trim());
    } else if (value.endsWith('*')) {
      conds.push(`${q} LIKE ? ESCAPE '\\'`);
      params.push(escapeLike(value.slice(0, -1)) + '%');
    } else {
      conds.push(`${q} LIKE ? ESCAPE '\\'`);
      params.push('%' + escapeLike(value) + '%');
    }
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}

/**
 * Promise-style wrapper around the better-sqlite3 driver.
 * Every call returns a consistent `{ success, data?, error? }` shape and
 * performs one-time, idempotent schema initialization.
 */
export interface DbOpenOptions {
  /** Open the database read-only: every write is rejected. */
  readonly?: boolean;
}

export class SqliteDatabase {
  private db: Database.Database;
  private logger: Logger;
  readonly path: string;
  /** True when this database was opened in read-only mode. */
  readonly isReadOnly: boolean;

  constructor(dbPath: string, logger: Logger, options: DbOpenOptions = {}) {
    this.path = dbPath;
    this.logger = logger;
    this.isReadOnly = !!options.readonly;
    // Opening read-only also refuses to create the file when it does not exist.
    this.db = new Database(dbPath, { readonly: this.isReadOnly });
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.isReadOnly) {
      // Belt-and-suspenders: even a direct write statement fails at the SQLite layer.
      this.db.exec('PRAGMA query_only = ON;');
    } else {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.initSchema();
    }
    this.logger.info(`Opened SQLite database at ${dbPath}${this.isReadOnly ? ' (read-only)' : ''}`);
  }

  /** Standard error returned for every write attempt in read-only mode. */
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

  /**
   * True when `sql` contains more than one statement. Detection is delegated to
   * SQLite itself via `prepare()` (which refuses multi-statement strings), so
   * comments, string literals and quoted identifiers are handled correctly.
   */
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

  /** Run a write statement, reporting row changes when it is a single statement. */
  async runWrite(sql: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    const trimmed = String(sql).trim().replace(/;+\s*$/, '');
    try {
      const stmt = this.db.prepare(trimmed);
      const info = stmt.run();
      return { success: true, data: { changes: Number(info.changes) } };
    } catch (err) {
      // Possibly multiple statements — fall back to exec.
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
    return this.tryRun(() => {
      const rows = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as unknown as { name: string }[];
      return rows.map((r) => ({ name: r.name }));
    });
  }

  async getTableInfo(table: string): Promise<Result<TableInfoData>> {
    return this.tryRun(() => {
      const cols = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as ColumnInfo[];
      const fks = this.db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as unknown as ForeignKeyInfo[];
      const primaryKey = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

      // Indexes — the data generator needs them to detect UNIQUE columns and
      // JSON-expression indexes (which throw "malformed JSON" at insert time
      // if the column is filled with non-JSON text).
      const indexRows = this.db
        .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
        .all() as unknown as { seq: number; name: string; unique: number; origin: string; partial: number }[];
      const indexes: IndexInfo[] = indexRows.map((ix) => {
        const ixCols = (this.db
          .prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`)
          .all() as unknown as { seqno: number; cid: number; name: string }[]).map((c) => c.name);
        const sqlRow = this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(ix.name) as { sql?: string | null } | undefined;
        return {
          name: ix.name,
          unique: !!ix.unique,
          partial: ix.partial,
          origin: ix.origin,
          columns: ixCols,
          sql: sqlRow?.sql ?? null,
        };
      });

      const ddlRow = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql?: string | null } | undefined;

      return {
        table,
        columns: cols.map((c) => ({
          cid: c.cid,
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          dflt_value: c.dflt_value,
          pk: c.pk,
        })),
        foreignKeys: fks.map((f) => ({
          id: f.id,
          seq: f.seq,
          table: f.table,
          from: f.from,
          to: f.to,
          on_update: f.on_update,
          on_delete: f.on_delete,
        })),
        primaryKey,
        indexes,
        sql: ddlRow?.sql ?? null,
      };
    });
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

      let sql = `SELECT * FROM ${quoteIdentifier(table)}${where}`;
      if (orderCol) sql += ` ORDER BY ${quoteIdentifier(orderCol)} ${orderDir}`;
      sql += ` LIMIT ${limit} OFFSET ${offset}`;

      return this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    });
  }

  async getAllRows(table: string): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(() => this.db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as unknown as Record<string, unknown>[]);
  }

  async getRow(table: string, where: WhereClause[]): Promise<Result<Record<string, unknown> | null>> {
    return this.tryRun(() => {
      const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
      const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')} LIMIT 1`;
      const row = this.db.prepare(sql).get(...where.map((w) => this.toBind(w.value)));
      return row ? (row as Record<string, unknown>) : null;
    });
  }

  async insertRow(table: string, fields: WhereClause[]): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    const cols = fields.map((f) => quoteIdentifier(f.column));
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
    return this.run(sql, fields.map((f) => this.toBind(f.value)));
  }

  /** Insert many rows (used by CSV import) inside a single transaction. */
  async insertRows(table: string, rows: WhereClause[][]): Promise<Result<{ inserted: number; skipped: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      this.db.exec('BEGIN');
      try {
        let inserted = 0;
        for (const fields of rows) {
          if (!fields.length) continue;
          const cols = fields.map((f) => quoteIdentifier(f.column));
          const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
          this.db.prepare(sql).run(...fields.map((f) => this.toBind(f.value)));
          inserted += 1;
        }
        this.db.exec('COMMIT');
        return { inserted, skipped: rows.length - inserted };
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  async updateRow(table: string, fields: WhereClause[], where: WhereClause[]): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    const sets = fields.map((f) => `${quoteIdentifier(f.column)} = ?`);
    const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
    const sql = `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`;
    return this.run(sql, [...fields.map((f) => this.toBind(f.value)), ...where.map((w) => this.toBind(w.value))]);
  }

  /**
   * Apply many row updates (each with its own SET fields + primary-key WHERE
   * clause) inside a single transaction. Used by the bulk "apply changes"
   * flow of inline grid editing. Rolls everything back if any row fails.
   */
  async updateRows(
    table: string,
    rows: { fields: WhereClause[]; where: WhereClause[] }[],
  ): Promise<Result<{ updated: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      this.db.exec('BEGIN');
      try {
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
        this.db.exec('COMMIT');
        return { updated };
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  async deleteRow(table: string, where: WhereClause[]): Promise<Result<{ changes: number; lastInsertRowid: number | null }>> {
    const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
    const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')}`;
    return this.run(sql, where.map((w) => this.toBind(w.value)));
  }

  /**
   * Delete many rows (each identified by its primary-key WHERE clause) inside a
   * single transaction. Used by bulk delete.
   */
  async deleteRows(table: string, rows: WhereClause[][]): Promise<Result<{ deleted: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(() => {
      this.db.exec('BEGIN');
      try {
        let deleted = 0;
        for (const where of rows) {
          if (!where.length) continue;
          const conds = where.map((w) => `${quoteIdentifier(w.column)} = ?`);
          const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')}`;
          const info = this.db.prepare(sql).run(...where.map((w) => this.toBind(w.value)));
          deleted += Number(info.changes);
        }
        this.db.exec('COMMIT');
        return { deleted };
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  /**
   * Fetch the rows matching the given primary-key WHERE clauses in one query
   * (`(a = ? AND b = ?) OR …`). Used by bulk export and FK-impact checks.
   */
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
      const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${groups.map((g) => `(${g})`).join(' OR ')}`;
      return this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
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

  // ---- Schema introspection & ALTER -------------------------------------

  /**
   * Detailed schema for a table: columns with constraint info, indexes,
   * foreign keys, and which other tables reference it.
   */
  async getSchema(table: string): Promise<Result<SchemaInfo>> {
    return this.tryRun(() => {
      const info = this.getTableInfoSync(table);
      if (!info || info.columns.length === 0) throw new Error(`Table "${table}" does not exist.`);

      // Foreign keys declared on this table (child FKs).
      const fkRows = this.db
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all() as unknown as ForeignKeyInfo[];
      const foreignKeys: ForeignKeyInfo[] = fkRows.map((f) => ({
        id: f.id,
        seq: f.seq,
        table: f.table,
        from: f.from,
        to: f.to,
        on_update: f.on_update,
        on_delete: f.on_delete,
      }));

      const indexRows = this.db
        .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
        .all() as unknown as { seq: number; name: string; unique: number; origin: string; partial: number }[];

      const indexes: IndexInfo[] = indexRows.map((ix) => {
        const cols = (this.db
          .prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`)
          .all() as unknown as { seqno: number; cid: number; name: string }[]).map((c) => c.name);
        const sqlRow = this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(ix.name) as { sql?: string | null } | undefined;
        return { name: ix.name, unique: !!ix.unique, partial: ix.partial, origin: ix.origin, columns: cols, sql: sqlRow?.sql ?? null };
      });

      const uniqueCols = new Set<string>();
      const indexedCols = new Set<string>();
      const originByName = new Map(indexRows.map((ix) => [ix.name, ix.origin]));
      for (const ix of indexes) {
        if (ix.unique) ix.columns.forEach((c) => uniqueCols.add(c));
        // 'c' = explicit CREATE INDEX; these block DROP COLUMN.
        if (originByName.get(ix.name) === 'c') ix.columns.forEach((c) => indexedCols.add(c));
      }

      // Foreign keys in OTHER tables that point at this table.
      const refs: { table: string; from: string; to: string }[] = [];
      const allTables = (this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as unknown as { name: string }[]).map((r) => r.name);
      for (const t of allTables) {
        if (t === table) continue;
        try {
          const fks = this.db
            .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(t)})`)
            .all() as unknown as ForeignKeyInfo[];
          for (const fk of fks) {
            if (fk.table === table) refs.push({ table: t, from: fk.from, to: fk.to ?? '' });
          }
        } catch {
          /* ignore unreadable tables */
        }
      }

      const refsByTo = new Map<string, { table: string; from: string }[]>();
      for (const r of refs) {
        const arr = refsByTo.get(r.to) ?? [];
        arr.push({ table: r.table, from: r.from });
        refsByTo.set(r.to, arr);
      }

      const fkByFrom = new Map<string, ForeignKeyInfo>();
      for (const fk of foreignKeys) fkByFrom.set(fk.from, fk);

      const columns: ColumnDetail[] = info.columns.map((c) => {
        const unique = c.pk > 0 || uniqueCols.has(c.name);
        const indexed = indexedCols.has(c.name);
        const referencedBy = refsByTo.get(c.name) ?? [];
        const fk = fkByFrom.get(c.name) ?? null;
        const dropBlockers: string[] = [];
        if (c.pk > 0) dropBlockers.push('Is part of the primary key');
        if (unique && c.pk === 0) dropBlockers.push('Has a UNIQUE constraint');
        if (indexed) dropBlockers.push('Is used by an index');
        if (referencedBy.length) dropBlockers.push(`Referenced by a foreign key in "${referencedBy[0].table}"`);
        if (fk) dropBlockers.push('Is part of a foreign key');
        return {
          ...c,
          unique,
          indexed,
          referencedBy,
          fk,
          canDrop: dropBlockers.length === 0,
          dropBlockers,
        };
      });

      return {
        table,
        columns,
        foreignKeys,
        indexes,
        references: refs,
      };
    });
  }

  /**
   * Other tables with foreign keys pointing at `table`, grouped by table, each
   * with the FK column mapping and a count of rows that actually reference it.
   */
  async getReferencingTables(table: string): Promise<Result<ReferencingTableInfo[]>> {
    return this.tryRun(() => {
      const allTables = (this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as unknown as { name: string }[]).map((r) => r.name);

      const byTable = new Map<string, { from: string; to: string }[]>();
      for (const t of allTables) {
        if (t === table) continue;
        try {
          const fks = this.db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(t)})`).all() as unknown as ForeignKeyInfo[];
          for (const fk of fks) {
            if (fk.table === table) {
              const arr = byTable.get(t) ?? [];
              arr.push({ from: fk.from, to: fk.to ?? '' });
              byTable.set(t, arr);
            }
          }
        } catch {
          /* ignore unreadable tables */
        }
      }

      const result: ReferencingTableInfo[] = [];
      for (const [t, refs] of byTable) {
        let refCount = 0;
        try {
          const conds = refs.map((r) => `${quoteIdentifier(r.from)} IS NOT NULL`);
          const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(t)} WHERE ${conds.join(' OR ')}`).get() as {
            c: number | bigint;
          };
          refCount = Number(row.c);
        } catch {
          /* count is best-effort */
        }
        result.push({ table: t, refs, refCount });
      }
      result.sort((a, b) => a.table.localeCompare(b.table));
      return result;
    });
  }

  /**
   * Rows in `table` whose `column` equals `value` — used to show which rows in
   * a referencing table point at a specific row via a foreign key — with the
   * total matching count.
   */
  async getRowsByFk(table: string, column: string, value: unknown, limit = 50): Promise<Result<{ rows: Record<string, unknown>[]; total: number }>> {
    return this.tryRun(() => {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`)
        .get(value) as { c: number | bigint };
      const rows = this.db
        .prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ? LIMIT ${n}`)
        .all(value) as unknown as Record<string, unknown>[];
      return { rows, total: Number(countRow.c) };
    });
  }

  async renameTable(oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateRenameTable(oldName, newName));
  }

  async addColumn(table: string, col: ColumnDef): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateAddColumn(table, col));
  }

  async renameColumn(table: string, oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(generateRenameColumn(table, oldName, newName));
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
      const cols = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as ColumnInfo[];
      if (!cols.length) return null;
      const primaryKey = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      return { table, columns: cols, foreignKeys: [], primaryKey, indexes: [], sql: null };
    } catch {
      return null;
    }
  }
}
