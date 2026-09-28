import type { IDatabase, TableInfoData } from '../../db/index';
import type { DatabaseContext } from '../../core/context';
import { generateCreateTable, quoteIdentifier, type ColumnDef } from '../../sql/generator';
import { generateSchemaDump, generateSqlDump } from '../../db/export';

export interface FkOption { value: unknown; label: string; }
export interface BulkOperationResult { succeeded: string[]; failed: { table: string; error: string }[]; message: string; }

export interface TableHomeStat {
  name: string;
  count: number;
  cols: number;
}

export interface HomeSummaryData {
  stats: TableHomeStat[];
  counts: Record<string, number>;
  cols: Record<string, number>;
  totalRows: number;
  savedQueriesCount: number;
}

export interface DatabaseInfoResult {
  settings: Record<string, unknown>;
  tables: string[];
  dialect: string;
  dbPath: string;
}

export class TableService {
  static async listTables(ctx: DatabaseContext) {
    const r = await ctx.db.listTables();
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to list tables.');
    }
    return r.data ?? [];
  }

  static async getTableInfo(ctx: DatabaseContext, table: string): Promise<TableInfoData | null> {
    const info = await ctx.db.getTableInfo(table);
    if (!info.success || !info.data?.columns?.length) {
      return null;
    }
    return info.data;
  }

  static async requireTable(ctx: DatabaseContext, table: string): Promise<TableInfoData> {
    const info = await TableService.getTableInfo(ctx, table);
    if (!info) {
      throw new Error(`Table "${table}" does not exist.`);
    }
    return info;
  }

  static async getFkOptions(ctx: DatabaseContext, table: string, info?: TableInfoData): Promise<Record<string, FkOption[]>> {
    const tableInfo = info ?? (await TableService.requireTable(ctx, table));
    const options: Record<string, FkOption[]> = {};

    for (const fk of tableInfo.foreignKeys) {
      try {
        const refInfo = await TableService.getTableInfo(ctx, fk.table);
        if (!refInfo) continue;
        const refCol = fk.to || refInfo.primaryKey[0] || refInfo.columns[0]?.name;
        const pk = refInfo.primaryKey[0] ?? refInfo.columns[0]?.name;
        const labelCol = refInfo.columns.find((c) => /name|title|label|username|email/i.test(c.name))?.name ?? pk;
        const rows = await ctx.db.getRows(fk.table, { limit: 100, orderBy: labelCol });
        if (rows.success && rows.data) {
          options[fk.from] = rows.data.map((r) => ({
            value: r[refCol],
            label: r[labelCol] != null ? `${r[labelCol]} (${r[refCol]})` : String(r[refCol]),
          }));
        }
      } catch {
        // Ignore errors fetching options for optional FK targets
      }
    }
    return options;
  }

  static async getTableDdl(ctx: DatabaseContext, table: string): Promise<string | null> {
    const r = await ctx.db.getCreateStatement(table);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to fetch DDL.');
    }
    return r.data ?? null;
  }

  static async renameTable(ctx: DatabaseContext, table: string, newName: string): Promise<void> {
    const trimmed = String(newName ?? '').trim();
    if (!trimmed) throw new Error('New table name is required.');
    const r = await ctx.db.renameTable(table, trimmed);
    if (!r.success) throw new Error(r.error ?? 'Failed to rename table.');
  }

  static async dropTable(ctx: DatabaseContext, table: string): Promise<void> {
    const r = await ctx.db.dropTable(table);
    if (!r.success) throw new Error(r.error ?? 'Failed to drop table.');
  }

  static async bulkDropTables(
    ctx: DatabaseContext,
    tables: string[],
    force = false,
  ): Promise<{ dropped: string[]; failed: { table: string; error: string }[] }> {
    if (tables.length === 0) throw new Error('No tables specified.');

    const dropped: string[] = [];
    const failed: { table: string; error: string }[] = [];
    const { db, dialect } = ctx;

    if (force && dialect.ddl.setForeignKeys) {
      await db.run(dialect.ddl.setForeignKeys(false));
    }

    for (const table of tables) {
      try {
        const dropSql = dialect.ddl.dropTable(table, { cascade: force, ifExists: force });
        const r = await db.run(dropSql);
        if (!r.success) throw new Error(r.error ?? 'Failed to drop table.');
        dropped.push(table);
      } catch (err) {
        failed.push({ table, error: (err as Error).message });
      }
    }

    if (force && dialect.ddl.setForeignKeys) {
      await db.run(dialect.ddl.setForeignKeys(true));
    }

    return { dropped, failed };
  }

  static async bulkTruncateTables(
    ctx: DatabaseContext,
    tables: string[],
    force = false,
  ): Promise<{ cleared: string[]; failed: { table: string; error: string }[] }> {
    if (tables.length === 0) throw new Error('No tables specified.');

    const cleared: string[] = [];
    const failed: { table: string; error: string }[] = [];
    const { db, dialect } = ctx;

    if (force && dialect.ddl.setForeignKeys) {
      await db.run(dialect.ddl.setForeignKeys(false));
    }

    for (const table of tables) {
      try {
        const truncateSql = dialect.ddl.truncateTable(table, { cascade: force, restartIdentity: force });
        const r = await db.run(truncateSql);
        if (!r.success) throw new Error(r.error ?? 'Failed to clear table.');
        cleared.push(table);
      } catch (err) {
        failed.push({ table, error: (err as Error).message });
      }
    }

    if (force && dialect.ddl.setForeignKeys) {
      await db.run(dialect.ddl.setForeignKeys(true));
    }

    return { cleared, failed };
  }

  static async getIncomingForeignKeyCounts(
    ctx: DatabaseContext,
    rawRows: Record<string, unknown>[],
    refColumns: { table: string; from: string; to: string }[],
  ): Promise<Map<string, Map<string, number>>> {
    const { db } = ctx;
    const countEntries = await Promise.all(
      refColumns.map(async (col) => {
        const values = rawRows
          .map((r) => r[col.to])
          .filter((v): v is string | number => v !== null && v !== undefined);
        if (!values.length) return [col.table, new Map<string, number>()] as const;
        const placeholders = values.map(() => '?').join(', ');
        const cR = await db.all(
          `SELECT ${quoteIdentifier(col.from)} AS fk, COUNT(*) AS c FROM ${quoteIdentifier(col.table)} WHERE ${quoteIdentifier(col.from)} IN (${placeholders}) GROUP BY ${quoteIdentifier(col.from)}`,
          values,
        );
        const map = new Map<string, number>();
        for (const row of (cR.data ?? []) as Record<string, unknown>[]) {
          map.set(String(row.fk), Number(row.c));
        }
        return [col.table, map] as const;
      }),
    );
    return new Map(countEntries);
  }

  static async getDatabaseInfo(ctx: DatabaseContext): Promise<DatabaseInfoResult> {
    const all = await ctx.db.listTables();
    const tables = (all.data ?? []).map((t) => t.name);
    const settingsRes = await ctx.db.getSettings();
    return {
      settings: settingsRes.success && settingsRes.data ? settingsRes.data : {},
      tables,
      dialect: ctx.dialect.name,
      dbPath: ctx.path,
    };
  }

  static async getSchemaDump(ctx: DatabaseContext): Promise<string> {
    const dump = await generateSchemaDump(ctx.db);
    if (!dump.success || !dump.data) {
      throw new Error(dump.error ?? 'Failed to generate schema dump.');
    }
    return dump.data;
  }

  static async getSqlDump(ctx: DatabaseContext): Promise<string> {
    const dump = await generateSqlDump(ctx.db);
    if (!dump.success || !dump.data) {
      throw new Error(dump.error ?? 'Failed to generate SQL dump.');
    }
    return dump.data;
  }

  static async getHomeStats(ctx: DatabaseContext, tableNames: string[]): Promise<HomeSummaryData> {
    const { db, dialect } = ctx;
    let colCountsMap: Record<string, number> = {};

    if (dialect.introspector.getColumnCountMap) {
      const colCountRes = await dialect.introspector.getColumnCountMap(db);
      if (colCountRes.success && colCountRes.data) {
        colCountsMap = colCountRes.data;
      }
    }

    const stats = await Promise.all(tableNames.map(async (name) => {
      const countR = await db.getRowCount(name);
      const cols = colCountsMap[name] !== undefined
        ? colCountsMap[name]
        : (await db.getTableInfo(name)).data?.columns.length ?? 0;
      return {
        name,
        count: countR.success ? (countR.data as number) : 0,
        cols,
      };
    }));

    const counts: Record<string, number> = {};
    const cols: Record<string, number> = {};
    let totalRows = 0;
    for (const s of stats) {
      counts[s.name] = s.count;
      cols[s.name] = s.cols;
      totalRows += s.count;
    }

    return {
      stats,
      counts,
      cols,
      totalRows,
      savedQueriesCount: 0,
    };
  }

  static generateCreateTableSql(name: string, columns: ColumnDef[]): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('Table name is required.');
    if (!Array.isArray(columns) || columns.length === 0) throw new Error('At least one column is required.');
    return generateCreateTable(trimmed, columns);
  }

  static async createTable(ctx: DatabaseContext, name: string, columns: ColumnDef[]): Promise<void> {
    const sql = TableService.generateCreateTableSql(name, columns);
    const r = await ctx.db.execResult(sql);
    if (!r.success) throw new Error(r.error ?? 'Failed to create table.');
  }
}


