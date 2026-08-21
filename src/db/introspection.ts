import type Database from 'better-sqlite3';
import { quoteIdentifier } from '../sql/generator';
import type {
  ColumnDetail,
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  ReferencingTableInfo,
  SchemaInfo,
  TableInfoData,
  TableListItem,
} from './types';

export function listTablesSync(db: Database.Database): TableListItem[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => ({ name: r.name }));
}

/** Get all tables non-internal in the SQLite database. */
function getTableNames(db: Database.Database): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]).map((r) => r.name);
}

/** Discover all foreign keys declared across all other tables pointing to `targetTable`. */
function getIncomingFks(db: Database.Database, targetTable: string): { table: string; from: string; to: string }[] {
  const refs: { table: string; from: string; to: string }[] = [];
  for (const t of getTableNames(db)) {
    if (t === targetTable) continue;
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(t)})`).all() as ForeignKeyInfo[];
      for (const fk of fks) {
        if (fk.table === targetTable) refs.push({ table: t, from: fk.from, to: fk.to ?? '' });
      }
    } catch {
      /* ignore unreadable tables */
    }
  }
  return refs;
}

export function getTableInfoSync(db: Database.Database, table: string): TableInfoData {
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
    const ixCols = (db
      .prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`)
      .all() as { seqno: number; cid: number; name: string }[]).map((c) => c.name);
    const sqlRow = db
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

  const ddlRow = db
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
}

export function getSchemaSync(db: Database.Database, table: string): SchemaInfo {
  const info = getTableInfoSync(db, table);
  if (!info || info.columns.length === 0) throw new Error(`Table "${table}" does not exist.`);

  const foreignKeys = info.foreignKeys;
  const indexes = info.indexes;

  const uniqueCols = new Set<string>();
  const indexedCols = new Set<string>();
  for (const ix of indexes) {
    if (ix.unique) ix.columns.forEach((c) => uniqueCols.add(c));
    if (ix.origin === 'c') ix.columns.forEach((c) => indexedCols.add(c));
  }

  const refs = getIncomingFks(db, table);
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
    table,
    columns,
    foreignKeys,
    indexes,
    references: refs,
  };
}

export function getReferencingTablesSync(db: Database.Database, table: string): ReferencingTableInfo[] {
  const refs = getIncomingFks(db, table);
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
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(t)} WHERE ${conds.join(' OR ')}`).get() as {
        c: number | bigint;
      };
      refCount = Number(row.c);
    } catch {
      /* count is best-effort */
    }
    result.push({ table: t, refs: tRefs, refCount });
  }
  result.sort((a, b) => a.table.localeCompare(b.table));
  return result;
}
