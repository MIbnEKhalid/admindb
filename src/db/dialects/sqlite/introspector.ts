import type Database from 'better-sqlite3';
import { quoteIdentifier } from '../../../sql/generator';
import type { ISchemaIntrospector } from '../types';
import type { ColumnDetail, ColumnInfo, ForeignKeyInfo, IndexInfo, ReferencingTableInfo, Result, SchemaInfo, TableInfoData, TableListItem } from '../../types';

export class SqliteIntrospector implements ISchemaIntrospector {
  private getNativeDb(driver: unknown): Database.Database {
    if (driver && typeof driver === 'object' && 'db' in driver) {
      return (driver as { db: Database.Database }).db;
    }
    return driver as Database.Database;
  }

  async listTables(driver: unknown): Promise<Result<TableListItem[]>> {
    try {
      const db = this.getNativeDb(driver);
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      return { success: true, data: rows.map((r) => ({ name: r.name })) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private getTableNames(db: Database.Database): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  private getIncomingFks(db: Database.Database, targetTable: string): { table: string; from: string; to: string }[] {
    const refs: { table: string; from: string; to: string }[] = [];
    for (const t of this.getTableNames(db)) {
      if (t === targetTable) continue;
      try {
        const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(t)})`).all() as ForeignKeyInfo[];
        for (const fk of fks) {
          if (fk.table === targetTable) refs.push({ table: t, from: fk.from, to: fk.to ?? '' });
        }
      } catch {}
    }
    return refs;
  }

  async getTableInfo(driver: unknown, table: string): Promise<Result<TableInfoData>> {
    try {
      const db = this.getNativeDb(driver);
      const cols = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
      const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as ForeignKeyInfo[];
      const primaryKey = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

      const indexRows = db
        .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
        .all() as { seq: number; name: string; unique: number; origin: string; partial: number }[];

      const indexes: IndexInfo[] = indexRows.map((ix) => {
        const ixCols = (
          db.prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`).all() as { seqno: number; cid: number; name: string }[]
        )
          .map((c) => c.name)
          .filter((n): n is string => Boolean(n));
        const sqlRow = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(ix.name) as { sql?: string | null } | undefined;
        return {
          name: ix.name,
          unique: Boolean(ix.unique),
          partial: ix.partial,
          origin: ix.origin,
          columns: ixCols,
          sql: sqlRow?.sql ?? null,
        };
      });

      const ddlRow = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql?: string | null } | undefined;

      return {
        success: true,
        data: {
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
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getSchema(driver: unknown, table: string): Promise<Result<SchemaInfo>> {
    try {
      const db = this.getNativeDb(driver);
      const infoRes = await this.getTableInfo(driver, table);
      if (!infoRes.success || !infoRes.data || infoRes.data.columns.length === 0) {
        return { success: false, error: `Table "${table}" does not exist.` };
      }
      const info = infoRes.data;
      const { foreignKeys, indexes } = info;
      const uniqueCols = new Set<string>();
      const indexedCols = new Set<string>();
      for (const ix of indexes) {
        const cols = Array.isArray(ix.columns) ? ix.columns.filter(Boolean) : [];
        if (ix.unique) cols.forEach((c) => uniqueCols.add(c));
        if (ix.origin === 'c') cols.forEach((c) => indexedCols.add(c));
      }

      const refs = this.getIncomingFks(db, table);
      const refsByTo = new Map<string, { table: string; from: string }[]>();
      for (const r of refs) {
        const arr = refsByTo.get(r.to) ?? [];
        arr.push({ table: r.table, from: r.from });
        refsByTo.set(r.to, arr);
      }

      const fkByFrom = new Map(foreignKeys.map((fk) => [fk.from, fk]));

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
        success: true,
        data: {
          table,
          columns,
          foreignKeys,
          indexes,
          references: refs,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getReferencingTables(driver: unknown, table: string): Promise<Result<ReferencingTableInfo[]>> {
    try {
      const db = this.getNativeDb(driver);
      const refs = this.getIncomingFks(db, table);
      const byTable = new Map<string, { from: string; to: string }[]>();
      for (const r of refs) {
        const arr = byTable.get(r.table) ?? [];
        arr.push({ from: r.from, to: r.to });
        byTable.set(r.table, arr);
      }

      const result: ReferencingTableInfo[] = [];
      for (const [t, tRefs] of byTable) {
        let refCount = 0;
        try {
          const conds = tRefs.map((r) => `${quoteIdentifier(r.from)} IS NOT NULL`);
          const row = db
            .prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(t)} WHERE ${conds.join(' OR ')}`)
            .get() as { c: number | bigint };
          refCount = Number(row.c);
        } catch {}
        result.push({ table: t, refs: tRefs, refCount });
      }
      result.sort((a, b) => a.table.localeCompare(b.table));
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getCreateStatement(driver: unknown, table: string): Promise<Result<string | null>> {
    try {
      const db = this.getNativeDb(driver);
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql?: string | null } | undefined;
      return { success: true, data: row?.sql ?? null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
