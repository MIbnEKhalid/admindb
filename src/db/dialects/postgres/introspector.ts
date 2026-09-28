import { quoteIdentifier } from '../../../sql/generator';
import type { ISchemaIntrospector } from '../types';
import type { ColumnDetail, ColumnInfo, ForeignKeyInfo, IndexInfo, ReferencingTableInfo, Result, SchemaInfo, TableInfoData, TableListItem } from '../../types';

interface PgPoolLike {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export class PostgresIntrospector implements ISchemaIntrospector {
  private schema: string;

  constructor(schema = 'public') {
    this.schema = schema;
  }

  private getPool(driver: unknown): PgPoolLike {
    if (driver && typeof driver === 'object' && 'pool' in driver) {
      return (driver as { pool: PgPoolLike }).pool;
    }
    return driver as PgPoolLike;
  }

  async listTables(driver: unknown): Promise<Result<TableListItem[]>> {
    try {
      const pool = this.getPool(driver);
      const res = await pool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name;`,
        [this.schema],
      );
      return { success: true, data: res.rows.map((r: { table_name: string }) => ({ name: r.table_name })) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getColumnCountMap(driver: unknown): Promise<Result<Record<string, number>>> {
    try {
      const pool = this.getPool(driver);
      const colRes = await pool.query<{ table_name: string; cols: number }>(
        `SELECT table_name, count(*)::int AS cols FROM information_schema.columns WHERE table_schema = $1 GROUP BY table_name;`,
        [this.schema],
      );
      const map: Record<string, number> = {};
      for (const row of colRes.rows) {
        if (row && typeof row.table_name === 'string') {
          map[row.table_name] = Number(row.cols ?? 0);
        }
      }
      return { success: true, data: map };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getTableInfo(driver: unknown, table: string): Promise<Result<TableInfoData>> {
    try {
      const pool = this.getPool(driver);
      const colRes = await pool.query<{
        ordinal_position: number;
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position;`,
        [this.schema, table],
      );

      if (!colRes.rows.length) {
        return { success: false, error: `Table "${table}" does not exist.` };
      }

      const pkRes = await pool.query<{ column_name: string }>(
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

      const columns: ColumnInfo[] = colRes.rows.map((r) => {
        const pkIdx = primaryKey.indexOf(r.column_name);
        const colType = r.data_type === 'USER-DEFINED' ? r.udt_name : (r.udt_name || r.data_type).toUpperCase();
        return {
          cid: r.ordinal_position,
          name: r.column_name,
          type: colType,
          notnull: r.is_nullable === 'NO' ? 1 : 0,
          dflt_value: r.column_default,
          pk: pkIdx >= 0 ? pkIdx + 1 : 0,
        };
      });

      const fkRes = await pool.query<{
        id: number;
        table: string;
        from: string;
        to: string | null;
        on_update: string;
        on_delete: string;
      }>(
        `SELECT
           row_number() OVER () AS id,
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
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2;`,
        [this.schema, table],
      );

      const foreignKeys: ForeignKeyInfo[] = fkRes.rows.map((r, idx) => ({
        id: Number(r.id || idx + 1),
        seq: idx,
        table: r.table,
        from: r.from,
        to: r.to,
        on_update: r.on_update,
        on_delete: r.on_delete,
      }));

      const idxRes = await pool.query<{
        indexname: string;
        indisunique: boolean;
        indisprimary: boolean;
        columns: string[];
        indexdef: string;
      }>(
        `SELECT
           i.relname AS indexname,
           ix.indisunique,
           ix.indisprimary,
           array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
           pg_get_indexdef(ix.indexrelid) AS indexdef
         FROM pg_class t
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE n.nspname = $1 AND t.relname = $2
         GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indexrelid;`,
        [this.schema, table],
      );

      const indexes: IndexInfo[] = idxRes.rows.map((r) => ({
        name: r.indexname,
        unique: Boolean(r.indisunique),
        partial: 0,
        origin: r.indisprimary ? 'pk' : r.indisunique ? 'u' : 'c',
        columns: r.columns || [],
        sql: r.indexdef,
      }));

      const ddlCols = columns.map((c) => {
        let def = `  ${quoteIdentifier(c.name)} ${c.type}`;
        if (c.notnull) def += ' NOT NULL';
        if (c.dflt_value) def += ` DEFAULT ${c.dflt_value}`;
        return def;
      });
      if (primaryKey.length) {
        ddlCols.push(`  PRIMARY KEY (${primaryKey.map(quoteIdentifier).join(', ')})`);
      }
      for (const fk of foreignKeys) {
        ddlCols.push(
          `  FOREIGN KEY (${quoteIdentifier(fk.from)}) REFERENCES ${quoteIdentifier(fk.table)}(${quoteIdentifier(fk.to || fk.from)})`,
        );
      }
      const fakeSql = `CREATE TABLE ${quoteIdentifier(table)} (\n${ddlCols.join(',\n')}\n);`;

      return {
        success: true,
        data: {
          table,
          columns,
          foreignKeys,
          primaryKey,
          indexes,
          sql: fakeSql,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getSchema(driver: unknown, table: string): Promise<Result<SchemaInfo>> {
    try {
      const pool = this.getPool(driver);
      const infoR = await this.getTableInfo(driver, table);
      if (!infoR.success || !infoR.data) throw new Error(infoR.error || `Table ${table} not found.`);
      const { columns, foreignKeys, indexes, primaryKey } = infoR.data;

      const refRes = await pool.query<{ table: string; from: string; to: string }>(
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
        success: true,
        data: {
          table,
          columns: columnDetails,
          foreignKeys,
          indexes,
          references,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getReferencingTables(driver: unknown, table: string): Promise<Result<ReferencingTableInfo[]>> {
    try {
      const pool = this.getPool(driver);
      const refRes = await pool.query<{ table: string; from: string; to: string }>(
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
          const countRes = await pool.query<{ c: string | number }>(
            `SELECT COUNT(*) AS c FROM ${quoteIdentifier(tbl)} WHERE ${refs.map((r) => `${quoteIdentifier(r.from)} IS NOT NULL`).join(' OR ')}`,
          );
          results.push({ table: tbl, refs, refCount: Number(countRes.rows[0]?.c ?? 0) });
        } catch {
          results.push({ table: tbl, refs, refCount: 0 });
        }
      }

      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getCreateStatement(driver: unknown, table: string): Promise<Result<string | null>> {
    const info = await this.getTableInfo(driver, table);
    if (!info.success || !info.data) return { success: false, error: info.error };
    return { success: true, data: info.data.sql };
  }
}
