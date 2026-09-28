import type { IDatabase, TableInfoData } from '../../db/index';
import { generateCreateTable, quoteIdentifier, type ColumnDef } from '../../sql/generator';

export interface FkOption { value: unknown; label: string; }
export interface BulkOperationResult { succeeded: string[]; failed: { table: string; error: string }[]; message: string; }

export class TableService {
  static async listTables(db: IDatabase) {
    const r = await db.listTables();
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to list tables.');
    }
    return r.data ?? [];
  }

  static async getTableInfo(db: IDatabase, table: string): Promise<TableInfoData | null> {
    const info = await db.getTableInfo(table);
    if (!info.success || !info.data?.columns?.length) {
      return null;
    }
    return info.data;
  }

  static async requireTable(db: IDatabase, table: string): Promise<TableInfoData> {
    const info = await TableService.getTableInfo(db, table);
    if (!info) {
      throw new Error(`Table "${table}" does not exist.`);
    }
    return info;
  }

  static async getFkOptions(db: IDatabase, table: string, info?: TableInfoData): Promise<Record<string, FkOption[]>> {
    const tableInfo = info ?? (await TableService.requireTable(db, table));
    const options: Record<string, FkOption[]> = {};

    for (const fk of tableInfo.foreignKeys) {
      try {
        const refInfo = await TableService.getTableInfo(db, fk.table);
        if (!refInfo) continue;
        const refCol = fk.to || refInfo.primaryKey[0] || refInfo.columns[0]?.name;
        const pk = refInfo.primaryKey[0] ?? refInfo.columns[0]?.name;
        const labelCol = refInfo.columns.find((c) => /name|title|label|username|email/i.test(c.name))?.name ?? pk;
        const rows = await db.getRows(fk.table, { limit: 100, orderBy: labelCol });
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

  static async getTableDdl(db: IDatabase, table: string): Promise<string | null> {
    const r = await db.getCreateStatement(table);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to fetch DDL.');
    }
    return r.data ?? null;
  }

  static async renameTable(db: IDatabase, table: string, newName: string): Promise<void> {
    const trimmed = String(newName ?? '').trim();
    if (!trimmed) throw new Error('New table name is required.');
    const r = await db.renameTable(table, trimmed);
    if (!r.success) throw new Error(r.error ?? 'Failed to rename table.');
  }

  static async dropTable(db: IDatabase, table: string): Promise<void> {
    const r = await db.dropTable(table);
    if (!r.success) throw new Error(r.error ?? 'Failed to drop table.');
  }

  static async bulkDropTables(
    db: IDatabase,
    tables: string[],
    force = false,
  ): Promise<{ dropped: string[]; failed: { table: string; error: string }[] }> {
    if (tables.length === 0) throw new Error('No tables specified.');

    const dropped: string[] = [];
    const failed: { table: string; error: string }[] = [];
    const dialect = db.dialect;

    if (force && dialect === 'sqlite') await db.run('PRAGMA foreign_keys = OFF');

    for (const table of tables) {
      try {
        const r = force && dialect === 'postgres'
          ? await db.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)} CASCADE`)
          : await db.dropTable(table);
        if (!r.success) throw new Error(r.error ?? 'Failed to drop table.');
        dropped.push(table);
      } catch (err) {
        failed.push({ table, error: (err as Error).message });
      }
    }

    if (force && dialect === 'sqlite') await db.run('PRAGMA foreign_keys = ON');

    return { dropped, failed };
  }

  static async bulkTruncateTables(
    db: IDatabase,
    tables: string[],
    force = false,
  ): Promise<{ cleared: string[]; failed: { table: string; error: string }[] }> {
    if (tables.length === 0) throw new Error('No tables specified.');

    const cleared: string[] = [];
    const failed: { table: string; error: string }[] = [];
    const dialect = db.dialect;

    if (force && dialect === 'sqlite') await db.run('PRAGMA foreign_keys = OFF');

    for (const table of tables) {
      try {
        const r = force && dialect === 'postgres'
          ? await db.run(`TRUNCATE ${quoteIdentifier(table)} RESTART IDENTITY CASCADE`)
          : await db.run(`DELETE FROM ${quoteIdentifier(table)}`);
        if (!r.success) throw new Error(r.error ?? 'Failed to clear table.');
        cleared.push(table);
      } catch (err) {
        failed.push({ table, error: (err as Error).message });
      }
    }

    if (force && dialect === 'sqlite') await db.run('PRAGMA foreign_keys = ON');

    return { cleared, failed };
  }

  static generateCreateTableSql(name: string, columns: ColumnDef[]): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('Table name is required.');
    if (!Array.isArray(columns) || columns.length === 0) throw new Error('At least one column is required.');
    return generateCreateTable(trimmed, columns);
  }

  static async createTable(db: IDatabase, name: string, columns: ColumnDef[]): Promise<void> {
    const sql = TableService.generateCreateTableSql(name, columns);
    const r = await db.execResult(sql);
    if (!r.success) throw new Error(r.error ?? 'Failed to create table.');
  }
}
