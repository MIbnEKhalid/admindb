import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { Logger } from '../utils/logger';
import { quoteIdentifier, type ColumnDef, type IndexDef } from '../sql/generator';
import { errorMessage, sanitizeConnectionString } from '../utils/common';
import type { DatabaseDialect, IDatabase, MutationResult, PostgresOptions, QueryOptions, ReferencingTableInfo, Result, RowFilters, SchemaInfo, SQLInputValue, TableInfoData, TableListItem, WhereClause } from './types';
import { buildFilterClause, convertPlaceholdersToPostgres } from './filters';
import { getDialect } from './dialects/index';
import type { IDialect } from './dialects/types';

export class PostgresDatabase implements IDatabase {
  private pool: Pool;
  private logger: Logger;
  readonly path: string;
  readonly isReadOnly: boolean;
  readonly dialect: DatabaseDialect = 'postgres';
  readonly schema: string;
  readonly dialectInstance: IDialect;

  constructor(
    connection: string | PostgresOptions,
    logger: Logger,
    options: PostgresOptions = {},
  ) {
    this.logger = logger;
    const opts: PostgresOptions = typeof connection === 'string'
      ? { connectionString: connection, ...options }
      : { ...connection, ...options };

    this.isReadOnly = Boolean(opts.readonly);
    this.schema = opts.schema || 'public';
    this.dialectInstance = getDialect('postgres', this.schema);

    let sslConfig = opts.ssl;
    if (opts.connectionString) {
      try {
        const u = new URL(opts.connectionString);
        const sslMode = (u.searchParams.get('sslmode') || u.searchParams.get('ssl') || '').toLowerCase();
        const host = u.hostname.toLowerCase();
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';

        if (sslMode === 'disable') {
          sslConfig = false;
        } else if (sslConfig === undefined && (sslMode === 'require' || sslMode === 'prefer' || sslMode === 'no-verify' || !isLocal)) {
          sslConfig = { rejectUnauthorized: false };
        }
      } catch {}
    } else if (opts.host && sslConfig === undefined) {
      const host = opts.host.toLowerCase();
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
      if (!isLocal) sslConfig = { rejectUnauthorized: false };
    }

    const poolConfig: PoolConfig = {
      connectionString: opts.connectionString,
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: opts.user,
      password: opts.password,
      ssl: sslConfig,
      max: opts.max ?? 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
    };

    this.path = opts.connectionString
      ? sanitizeConnectionString(opts.connectionString)
      : `${opts.user || 'postgres'}@${opts.host || 'localhost'}:${opts.port || 5432}/${opts.database || 'postgres'}`;

    this.pool = new Pool(poolConfig);
    this.pool.on('error', (err) => {
      this.logger.error(`Unexpected PostgreSQL client error: ${errorMessage(err)}`);
    });

    this.logger.info(`Initialized PostgreSQL pool for ${this.path}${this.isReadOnly ? ' (read-only)' : ''}`);
  }

  private readonlyBlocked(): Result<never> {
    return { success: false, error: 'Database is open in read-only mode — write operations are disabled.' };
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      this.logger.warn(`Failed to close PostgreSQL pool: ${errorMessage(err)}`);
    }
  }

  private async tryRun<T>(fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return { success: true, data: await fn() };
    } catch (err) {
      const msg = errorMessage(err);
      this.logger.error(msg);
      return { success: false, error: msg };
    }
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<Result<T>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await fn(client);
      await client.query('COMMIT');
      return { success: true, data: res };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      const msg = errorMessage(err);
      this.logger.error(msg);
      return { success: false, error: msg };
    } finally {
      client.release();
    }
  }

  hasMultipleStatements(sql: string): boolean {
    const s = String(sql ?? '').trim();
    if (!s) return false;
    let count = 0;
    let inString = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") {
        if (inString && s[i + 1] === "'") {
          i++;
          continue;
        }
        inString = !inString;
      } else if (ch === ';' && !inString && s.slice(i + 1).trim().length > 0) {
        count++;
      }
    }
    return count > 0;
  }

  async all<T = unknown>(sql: string, params: SQLInputValue[] = []): Promise<Result<T[]>> {
    return this.tryRun(async () => {
      const res = await this.pool.query(convertPlaceholdersToPostgres(sql), params as unknown[]);
      return res.rows as T[];
    });
  }

  async run(sql: string, params: SQLInputValue[] = []): Promise<Result<MutationResult>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const res = await this.pool.query(convertPlaceholdersToPostgres(sql), params as unknown[]);
      return { changes: res.rowCount ?? 0, lastInsertRowid: null };
    });
  }

  async execResult(sql: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const res = await this.pool.query(sql);
      const changes = Array.isArray(res)
        ? res.reduce((acc, r) => acc + (r.rowCount ?? 0), 0)
        : res.rowCount ?? undefined;
      return { changes };
    });
  }

  async runWrite(sql: string): Promise<Result<{ changes?: number }>> {
    return this.execResult(sql);
  }

  async listTables(): Promise<Result<TableListItem[]>> {
    return this.dialectInstance.introspector.listTables(this.pool);
  }

  async getTableInfo(table: string): Promise<Result<TableInfoData>> {
    return this.dialectInstance.introspector.getTableInfo(this.pool, table);
  }

  async getRowCount(table: string, filters?: RowFilters): Promise<Result<number>> {
    return this.tryRun(async () => {
      let pgWhere = '';
      let params: unknown[] = [];
      if (filters && Object.keys(filters).length > 0) {
        const { where, params: p } = buildFilterClause(filters, Object.keys(filters));
        pgWhere = convertPlaceholdersToPostgres(where);
        params = p as unknown[];
      }
      const res = await this.pool.query<{ c: string | number }>(
        `SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}${pgWhere}`,
        params,
      );
      return Number(res.rows[0]?.c ?? 0);
    });
  }

  async getRows(table: string, opts: QueryOptions = {}): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(async () => {
      const orderCol = opts.orderBy;
      const orderDir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
      const page = opts.page && opts.page > 0 ? opts.page : 1;
      const offset = (page - 1) * limit;

      let pgWhere = '';
      let filterParams: unknown[] = [];
      if (opts.filters && Object.keys(opts.filters).length > 0) {
        const { where, params } = buildFilterClause(opts.filters, Object.keys(opts.filters));
        pgWhere = convertPlaceholdersToPostgres(where);
        filterParams = params as unknown[];
      }

      const nextParamIdx = filterParams.length + 1;
      let sql = `SELECT * FROM ${quoteIdentifier(table)}${pgWhere}`;
      if (orderCol) sql += ` ORDER BY ${quoteIdentifier(orderCol)} ${orderDir}`;
      sql += ` LIMIT $${nextParamIdx} OFFSET $${nextParamIdx + 1}`;

      const res = await this.pool.query(sql, [...filterParams, limit, offset]);
      return res.rows;
    });
  }

  async getAllRows(table: string): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(async () => {
      const res = await this.pool.query(`SELECT * FROM ${quoteIdentifier(table)}`);
      return res.rows;
    });
  }

  async getRow(table: string, where: WhereClause[]): Promise<Result<Record<string, unknown> | null>> {
    return this.tryRun(async () => {
      const conds = where.map((w, idx) => `${quoteIdentifier(w.column)} = $${idx + 1}`);
      const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')} LIMIT 1`;
      const res = await this.pool.query(sql, where.map((w) => w.value));
      return res.rows[0] ?? null;
    });
  }

  async insertRow(table: string, fields: WhereClause[]): Promise<Result<MutationResult>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const cols = fields.map((f) => quoteIdentifier(f.column));
      const placeholders = fields.map((_, idx) => `$${idx + 1}`);
      const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
      const res = await this.pool.query(sql, fields.map((f) => f.value));
      return { changes: res.rowCount ?? 1, lastInsertRowid: null };
    });
  }

  async insertRows(table: string, rows: WhereClause[][]): Promise<Result<{ inserted: number; skipped: number }>> {
    return this.transaction(async (client) => {
      let inserted = 0;
      for (const fields of rows) {
        if (!fields.length) continue;
        const cols = fields.map((f) => quoteIdentifier(f.column));
        const placeholders = fields.map((_, idx) => `$${idx + 1}`);
        const sql = `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
        await client.query(sql, fields.map((f) => f.value));
        inserted++;
      }
      return { inserted, skipped: rows.length - inserted };
    });
  }

  async updateRow(table: string, fields: WhereClause[], where: WhereClause[]): Promise<Result<MutationResult>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const sets = fields.map((f, idx) => `${quoteIdentifier(f.column)} = $${idx + 1}`);
      const conds = where.map((w, idx) => `${quoteIdentifier(w.column)} = $${fields.length + idx + 1}`);
      const sql = `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`;
      const res = await this.pool.query(sql, [...fields.map((f) => f.value), ...where.map((w) => w.value)]);
      return { changes: res.rowCount ?? 0, lastInsertRowid: null };
    });
  }

  async updateRows(
    table: string,
    rows: { fields: WhereClause[]; where: WhereClause[] }[],
  ): Promise<Result<{ updated: number }>> {
    return this.transaction(async (client) => {
      let updated = 0;
      for (const { fields, where } of rows) {
        if (!fields.length || !where.length) continue;
        const sets = fields.map((f, idx) => `${quoteIdentifier(f.column)} = $${idx + 1}`);
        const conds = where.map((w, idx) => `${quoteIdentifier(w.column)} = $${fields.length + idx + 1}`);
        const sql = `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`;
        const res = await client.query(sql, [...fields.map((f) => f.value), ...where.map((w) => w.value)]);
        updated += res.rowCount ?? 0;
      }
      return { updated };
    });
  }

  async deleteRow(table: string, where: WhereClause[]): Promise<Result<MutationResult>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const conds = where.map((w, idx) => `${quoteIdentifier(w.column)} = $${idx + 1}`);
      const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')}`;
      const res = await this.pool.query(sql, where.map((w) => w.value));
      return { changes: res.rowCount ?? 0, lastInsertRowid: null };
    });
  }

  async deleteRows(table: string, rows: WhereClause[][]): Promise<Result<{ deleted: number }>> {
    return this.transaction(async (client) => {
      let deleted = 0;
      for (const where of rows) {
        if (!where.length) continue;
        const conds = where.map((w, idx) => `${quoteIdentifier(w.column)} = $${idx + 1}`);
        const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${conds.join(' AND ')}`;
        const res = await client.query(sql, where.map((w) => w.value));
        deleted += res.rowCount ?? 0;
      }
      return { deleted };
    });
  }

  async getRowsByPks(table: string, pks: WhereClause[][]): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(async () => {
      const groups: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      for (const where of pks) {
        if (!where.length) continue;
        const conds = where.map((w) => {
          params.push(w.value);
          return `${quoteIdentifier(w.column)} = $${paramIdx++}`;
        });
        groups.push(conds.join(' AND '));
      }

      if (!groups.length) return [];
      const sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${groups.map((g) => `(${g})`).join(' OR ')}`;
      const res = await this.pool.query(sql, params);
      return res.rows;
    });
  }

  async getRowsByFk(
    table: string,
    column: string,
    value: unknown,
    limit = 50,
  ): Promise<Result<{ rows: Record<string, unknown>[]; total: number }>> {
    return this.tryRun(async () => {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      const countRes = await this.pool.query<{ c: string | number }>(
        `SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = $1`,
        [value],
      );
      const rowsRes = await this.pool.query(
        `SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = $1 LIMIT $2`,
        [value, n],
      );
      return { rows: rowsRes.rows, total: Number(countRes.rows[0]?.c ?? 0) };
    });
  }

  async getCreateStatement(table: string): Promise<Result<string | null>> {
    const info = await this.getTableInfo(table);
    if (!info.success || !info.data) return { success: false, error: info.error };
    return { success: true, data: info.data.sql };
  }

  async getSettings(): Promise<Result<Record<string, string>>> {
    return this.tryRun(async () => {
      const keys = ['server_version', 'max_connections', 'port', 'timezone', 'shared_buffers', 'work_mem'];
      const settings: Record<string, string> = {};
      try {
        const res = await this.pool.query(
          `SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])`,
          [keys],
        );
        for (const row of res.rows) settings[row.name] = String(row.setting);
      } catch {
        try {
          const ver = await this.pool.query('SHOW server_version');
          settings['server_version'] = String(ver.rows[0]?.server_version);
        } catch {}
      }
      return settings;
    });
  }

  async getSchema(table: string): Promise<Result<SchemaInfo>> {
    return this.dialectInstance.introspector.getSchema(this.pool, table);
  }

  async getReferencingTables(table: string): Promise<Result<ReferencingTableInfo[]>> {
    return this.dialectInstance.introspector.getReferencingTables(this.pool, table);
  }

  async renameTable(oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.renameTable(oldName, newName));
      return { changes: 1 };
    });
  }

  async addColumn(table: string, col: ColumnDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.addColumn(table, col));
      if (col.unique) {
        await this.pool.query(
          this.dialectInstance.ddl.createIndex(table, {
            name: `idx_${table}_${col.name}_unique`,
            columns: [col.name],
            unique: true,
          }),
        );
      }
      return { changes: 1 };
    });
  }

  async modifyColumn(table: string, oldColName: string, newColDef: ColumnDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.dialectInstance.ddl.modifyColumn(this.pool, table, oldColName, newColDef);
  }

  async renameColumn(table: string, oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.renameColumn(table, oldName, newName));
      return { changes: 1 };
    });
  }

  async dropColumn(table: string, column: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.dropColumn(table, column));
      return { changes: 1 };
    });
  }

  async dropTable(table: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.dropTable(table, { cascade: true }));
      return { changes: 1 };
    });
  }

  async createIndex(table: string, index: IndexDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.createIndex(table, index));
      return { changes: 1 };
    });
  }

  async dropIndex(indexName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(this.dialectInstance.ddl.dropIndex(indexName));
      return { changes: 1 };
    });
  }
}

