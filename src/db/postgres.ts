import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { Logger } from '../utils/logger';
import { quoteIdentifier, type ColumnDef, type IndexDef } from '../sql/generator';
import { errorMessage } from '../utils/common';
import type {
  ColumnDetail,
  ColumnInfo,
  DatabaseDialect,
  ForeignKeyInfo,
  IDatabase,
  IndexInfo,
  MutationResult,
  PostgresOptions,
  QueryOptions,
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
import { buildFilterClause, convertPlaceholdersToPostgres } from './filters';

export class PostgresDatabase implements IDatabase {
  private pool: Pool;
  private logger: Logger;
  readonly path: string;
  readonly isReadOnly: boolean;
  readonly dialect: DatabaseDialect = 'postgres';
  readonly schema: string;

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

    const poolConfig: PoolConfig = {
      connectionString: opts.connectionString,
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: opts.user,
      password: opts.password,
      ssl: opts.ssl,
      max: opts.max ?? 10,
    };

    this.path = opts.connectionString
      ? this.sanitizeConnectionString(opts.connectionString)
      : `${opts.user || 'postgres'}@${opts.host || 'localhost'}:${opts.port || 5432}/${opts.database || 'postgres'}`;

    this.pool = new Pool(poolConfig);

    this.pool.on('error', (err) => {
      this.logger.error(`Unexpected PostgreSQL client error: ${errorMessage(err)}`);
    });

    if (!this.isReadOnly) {
      this.initSchema().catch((err) => {
        this.logger.warn(`Failed to initialize Postgres schema: ${errorMessage(err)}`);
      });
    }

    this.logger.info(`Initialized PostgreSQL pool for ${this.path}${this.isReadOnly ? ' (read-only)' : ''}`);
  }

  private sanitizeConnectionString(conn: string): string {
    try {
      const url = new URL(conn);
      if (url.password) url.password = '****';
      return url.toString();
    } catch {
      return conn.replace(/:([^@]+)@/, ':****@');
    }
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
      const data = await fn();
      return { success: true, data };
    } catch (err) {
      const msg = errorMessage(err);
      this.logger.error(msg);
      return { success: false, error: msg };
    }
  }

  /** Run a callback inside an atomic transaction on a dedicated client. */
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<Result<T>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await fn(client);
      await client.query('COMMIT');
      return { success: true, data: res };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      const msg = errorMessage(err);
      this.logger.error(msg);
      return { success: false, error: msg };
    } finally {
      client.release();
    }
  }

  private async initSchema(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        sql TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    await this.pool.query(sql);
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
      } else if (ch === ';' && !inString) {
        // Only count if there are non-whitespace characters following
        const rest = s.slice(i + 1).trim();
        if (rest.length > 0) count++;
      }
    }
    return count > 0;
  }

  async all(sql: string, params: SQLInputValue[] = []): Promise<Result<unknown[]>> {
    return this.tryRun(async () => {
      const pgSql = convertPlaceholdersToPostgres(sql);
      const res = await this.pool.query(pgSql, params as unknown[]);
      return res.rows;
    });
  }

  async run(sql: string, params: SQLInputValue[] = []): Promise<Result<MutationResult>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const pgSql = convertPlaceholdersToPostgres(sql);
      const res = await this.pool.query(pgSql, params as unknown[]);
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: null,
      };
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
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const res = await this.pool.query(sql);
      const changes = Array.isArray(res)
        ? res.reduce((acc, r) => acc + (r.rowCount ?? 0), 0)
        : res.rowCount ?? undefined;
      return { changes };
    });
  }

  async listTables(): Promise<Result<TableListItem[]>> {
    return this.tryRun(async () => {
      const res = await this.pool.query<{ name: string }>(
        `SELECT table_name AS name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name;`,
        [this.schema],
      );
      return res.rows.map((r) => ({ name: r.name }));
    });
  }

  async getTableInfo(table: string): Promise<Result<TableInfoData>> {
    return this.tryRun(async () => {
      // 1. Columns
      const colRes = await this.pool.query<{
        cid: number;
        name: string;
        type: string;
        udt_name: string;
        notnull: number;
        dflt_value: string | null;
      }>(
        `SELECT
           ordinal_position AS cid,
           column_name AS name,
           data_type AS type,
           udt_name,
           CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
           column_default AS dflt_value
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position;`,
        [this.schema, table],
      );

      // 2. Primary Keys
      const pkRes = await this.pool.query<{ column_name: string }>(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2
         ORDER BY kcu.ordinal_position;`,
        [this.schema, table],
      );
      const primaryKey = pkRes.rows.map((r) => r.column_name);

      // 3. Foreign Keys
      const fkRes = await this.pool.query<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string | null;
        on_update: string;
        on_delete: string;
      }>(
        `SELECT
           row_number() OVER () AS id,
           kcu.position_in_unique_constraint AS seq,
           ccu.table_name AS table,
           kcu.column_name AS "from",
           ccu.column_name AS "to",
           rc.update_rule AS on_update,
           rc.delete_rule AS on_delete
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints AS rc
           ON rc.constraint_name = tc.constraint_name
           AND rc.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2;`,
        [this.schema, table],
      );

      // 4. Indexes
      const idxRes = await this.pool.query<{
        name: string;
        unique: boolean;
        sql: string | null;
        columns: string[];
      }>(
        `SELECT
           i.relname AS name,
           ix.indisunique AS unique,
           pg_get_indexdef(ix.indexrelid) AS sql,
           ARRAY(
             SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
             FROM generate_subscripts(ix.indkey, 1) as k
             ORDER BY k
           ) AS columns
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = $1 AND t.relname = $2;`,
        [this.schema, table],
      );

      const columns: ColumnInfo[] = colRes.rows.map((c) => {
        const isPk = primaryKey.includes(c.name);
        const displayType = c.type === 'USER-DEFINED' ? c.udt_name : c.type;
        return {
          cid: c.cid,
          name: c.name,
          type: displayType.toUpperCase(),
          notnull: c.notnull,
          dflt_value: c.dflt_value,
          pk: isPk ? primaryKey.indexOf(c.name) + 1 : 0,
        };
      });

      const indexes: IndexInfo[] = idxRes.rows.map((ix) => ({
        name: ix.name,
        unique: Boolean(ix.unique),
        partial: 0,
        origin: 'c',
        columns: Array.isArray(ix.columns) ? ix.columns : [],
        sql: ix.sql,
      }));

      // Approximate DDL for display
      const colDefs = columns.map((c) => {
        let def = `  ${quoteIdentifier(c.name)} ${c.type}`;
        if (c.notnull) def += ' NOT NULL';
        if (c.dflt_value) def += ` DEFAULT ${c.dflt_value}`;
        return def;
      });
      if (primaryKey.length) {
        colDefs.push(`  PRIMARY KEY (${primaryKey.map(quoteIdentifier).join(', ')})`);
      }
      const synthesizedSql = `CREATE TABLE ${quoteIdentifier(table)} (\n${colDefs.join(',\n')}\n);`;

      return {
        table,
        columns,
        foreignKeys: fkRes.rows.map((f) => ({
          id: Number(f.id),
          seq: Number(f.seq ?? 1),
          table: f.table,
          from: f.from,
          to: f.to,
          on_update: f.on_update,
          on_delete: f.on_delete,
        })),
        primaryKey,
        indexes,
        sql: synthesizedSql,
      };
    });
  }

  async getRowCount(table: string, filters?: RowFilters): Promise<Result<number>> {
    return this.tryRun(async () => {
      const infoR = await this.getTableInfo(table);
      const cols = infoR.success && infoR.data ? infoR.data.columns.map((c) => c.name) : [];
      const { where, params } = buildFilterClause(filters, cols);
      const pgWhere = convertPlaceholdersToPostgres(where);
      const sql = `SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}${pgWhere}`;
      const res = await this.pool.query<{ c: string | number }>(sql, params as unknown[]);
      return Number(res.rows[0]?.c ?? 0);
    });
  }

  async getRows(table: string, opts: QueryOptions = {}): Promise<Result<Record<string, unknown>[]>> {
    return this.tryRun(async () => {
      const infoR = await this.getTableInfo(table);
      const cols = infoR.success && infoR.data ? infoR.data.columns : [];
      const colNames = cols.map((c) => c.name);
      const orderCol = opts.orderBy || infoR.data?.primaryKey?.[0] || colNames[0];
      const orderDir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
      const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
      const page = opts.page && opts.page > 0 ? opts.page : 1;
      const offset = (page - 1) * limit;
      const { where, params } = buildFilterClause(opts.filters, colNames);

      const nextParamIdx = params.length + 1;
      let sql = `SELECT * FROM ${quoteIdentifier(table)}${convertPlaceholdersToPostgres(where)}`;
      if (orderCol) {
        sql += ` ORDER BY ${quoteIdentifier(orderCol)} ${orderDir}`;
      }
      sql += ` LIMIT $${nextParamIdx} OFFSET $${nextParamIdx + 1}`;
      const allParams = [...params, limit, offset];

      const res = await this.pool.query(sql, allParams as unknown[]);
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
      return {
        changes: res.rowCount ?? 1,
        lastInsertRowid: null,
      };
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
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: null,
      };
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
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: null,
      };
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

  async listSavedQueries(): Promise<Result<SavedQuery[]>> {
    return this.tryRun(async () => {
      const res = await this.pool.query<SavedQuery>(
        `SELECT id, name, sql, created_at FROM ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} ORDER BY name`,
      );
      return res.rows;
    });
  }

  async saveQuery(name: string, sql: string): Promise<Result<MutationResult>> {
    return this.tryRun(async () => {
      const res = await this.pool.query(
        `INSERT INTO ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} (name, sql) VALUES ($1, $2) RETURNING id`,
        [name, sql],
      );
      return {
        changes: res.rowCount ?? 1,
        lastInsertRowid: Number(res.rows[0]?.id ?? null),
      };
    });
  }

  async deleteSavedQuery(id: string | number): Promise<Result<MutationResult>> {
    return this.tryRun(async () => {
      const res = await this.pool.query(
        `DELETE FROM ${quoteIdentifier(INTERNAL_TABLES.savedQueries)} WHERE id = $1`,
        [Number(id)],
      );
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid: null,
      };
    });
  }

  async getSchema(table: string): Promise<Result<SchemaInfo>> {
    return this.tryRun(async () => {
      const infoR = await this.getTableInfo(table);
      if (!infoR.success || !infoR.data) throw new Error(infoR.error || `Table ${table} not found.`);
      const { columns, foreignKeys, indexes, primaryKey } = infoR.data;

      // Find references in other tables that point to this table
      const refRes = await this.pool.query<{ table: string; from: string; to: string }>(
        `SELECT
           tc.table_name AS table,
           kcu.column_name AS "from",
           ccu.column_name AS "to"
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND ccu.table_name = $2;`,
        [this.schema, table],
      );

      const references = refRes.rows;

      const columnDetails: ColumnDetail[] = columns.map((col) => {
        const isPk = primaryKey.includes(col.name);
        const fk = foreignKeys.find((f) => f.from === col.name) ?? null;
        const matchingIndexes = indexes.filter((i) => i.columns.includes(col.name));
        const unique = matchingIndexes.some((i) => i.unique && i.columns.length === 1 && i.columns[0] === col.name);
        const indexed = matchingIndexes.length > 0;
        const referencedBy = references
          .filter((r) => r.to === col.name)
          .map((r) => ({ table: r.table, from: r.from }));

        const dropBlockers: string[] = [];
        if (isPk && primaryKey.length === 1) dropBlockers.push('Primary key');
        if (referencedBy.length > 0) {
          dropBlockers.push(`Referenced by ${referencedBy.map((r) => `${r.table}.${r.from}`).join(', ')}`);
        }

        return {
          ...col,
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
        columns: columnDetails,
        foreignKeys,
        indexes,
        references,
      };
    });
  }

  async getReferencingTables(table: string): Promise<Result<ReferencingTableInfo[]>> {
    return this.tryRun(async () => {
      const refRes = await this.pool.query<{ table: string; from: string; to: string }>(
        `SELECT
           tc.table_name AS table,
           kcu.column_name AS "from",
           ccu.column_name AS "to"
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND ccu.table_name = $2;`,
        [this.schema, table],
      );

      const byTable = new Map<string, { from: string; to: string }[]>();
      for (const r of refRes.rows) {
        if (!byTable.has(r.table)) byTable.set(r.table, []);
        byTable.get(r.table)!.push({ from: r.from, to: r.to });
      }

      const results: ReferencingTableInfo[] = [];
      for (const [tbl, refs] of byTable.entries()) {
        try {
          const countRes = await this.pool.query<{ c: string | number }>(
            `SELECT COUNT(*) AS c FROM ${quoteIdentifier(tbl)} WHERE ${refs.map((r) => `${quoteIdentifier(r.from)} IS NOT NULL`).join(' OR ')}`,
          );
          results.push({
            table: tbl,
            refs,
            refCount: Number(countRes.rows[0]?.c ?? 0),
          });
        } catch {
          results.push({ table: tbl, refs, refCount: 0 });
        }
      }

      return results;
    });
  }

  async renameTable(oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(`ALTER TABLE ${quoteIdentifier(oldName)} RENAME TO ${quoteIdentifier(newName)};`);
      return { changes: 1 };
    });
  }

  async addColumn(table: string, col: ColumnDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      let sql = `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(col.name)} ${col.type}`;
      if (col.notNull) sql += ' NOT NULL';
      if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== '') {
        sql += ` DEFAULT ${col.defaultValue}`;
      }
      if (col.foreignKey) {
        sql += ` REFERENCES ${quoteIdentifier(col.foreignKey.table)} (${quoteIdentifier(col.foreignKey.column)})`;
      }
      await this.pool.query(sql);

      if (col.unique) {
        const idxName = `idx_${table}_${col.name}_unique`;
        await this.pool.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(idxName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(col.name)});`,
        );
      }

      return { changes: 1 };
    });
  }

  async modifyColumn(table: string, oldColName: string, newColDef: ColumnDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const newName = String(newColDef.name || oldColName).trim();

      // Rename column first if name changed
      if (oldColName !== newName) {
        await this.pool.query(
          `ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(oldColName)} TO ${quoteIdentifier(newName)};`,
        );
      }

      const colToModify = newName;

      // Alter Type if provided
      if (newColDef.type) {
        await this.pool.query(
          `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} TYPE ${newColDef.type} USING ${quoteIdentifier(colToModify)}::${newColDef.type};`,
        );
      }

      // Alter NOT NULL
      if (newColDef.notNull !== undefined) {
        const action = newColDef.notNull ? 'SET NOT NULL' : 'DROP NOT NULL';
        await this.pool.query(
          `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} ${action};`,
        );
      }

      // Alter DEFAULT
      if (newColDef.defaultValue !== undefined) {
        if (newColDef.defaultValue === null || newColDef.defaultValue === '') {
          await this.pool.query(
            `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} DROP DEFAULT;`,
          );
        } else {
          await this.pool.query(
            `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} SET DEFAULT ${newColDef.defaultValue};`,
          );
        }
      }

      // Handle unique index
      if (newColDef.unique !== undefined) {
        const idxName = `idx_${table}_${colToModify}_unique`;
        if (newColDef.unique) {
          await this.pool.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(idxName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(colToModify)});`,
          );
        } else {
          await this.pool.query(`DROP INDEX IF EXISTS ${quoteIdentifier(idxName)};`);
        }
      }

      return { changes: 1 };
    });
  }

  async renameColumn(table: string, oldName: string, newName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(
        `ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)};`,
      );
      return { changes: 1 };
    });
  }

  async dropColumn(table: string, column: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(
        `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)} CASCADE;`,
      );
      return { changes: 1 };
    });
  }

  async dropTable(table: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(`DROP TABLE ${quoteIdentifier(table)} CASCADE;`);
      return { changes: 1 };
    });
  }

  async createIndex(table: string, index: IndexDef): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      const unique = index.unique ? 'UNIQUE ' : '';
      const cols = index.columns.map(quoteIdentifier).join(', ');
      const name = index.name || `idx_${table}_${index.columns.join('_')}`;
      await this.pool.query(
        `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${quoteIdentifier(table)} (${cols});`,
      );
      return { changes: 1 };
    });
  }

  async dropIndex(indexName: string): Promise<Result<{ changes?: number }>> {
    if (this.isReadOnly) return this.readonlyBlocked();
    return this.tryRun(async () => {
      await this.pool.query(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)} CASCADE;`);
      return { changes: 1 };
    });
  }
}
