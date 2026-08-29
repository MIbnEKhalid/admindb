import type { IDatabase } from './types';
import { generateInsert } from '../sql/generator';

export interface DumpResult {
  success: boolean;
  data?: string;
  error?: string;
}

/**
 * Produce a downloadable SQL dump: for every table emit its CREATE statement
 * followed by one INSERT statement per row.
 */
export async function generateSqlDump(db: IDatabase): Promise<DumpResult> {
  const out = [db.dialect === 'sqlite' ? 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;' : 'BEGIN;'];
  const tables = await db.listTables();
  if (!tables.success) return { success: false, error: tables.error ?? 'Failed to list tables.' };

  for (const { name } of tables.data ?? []) {
    const create = await db.getCreateStatement(name);
    if (create.success && create.data) out.push(create.data.trim());

    const [info, rows] = await Promise.all([db.getTableInfo(name), db.getAllRows(name)]);
    if (info.success && rows.success) {
      const cols = info.data?.columns ?? [];
      for (const row of rows.data ?? []) {
        const fields = cols.map((c) => ({ column: c.name, value: (row as Record<string, unknown>)[c.name] }));
        out.push(generateInsert(name, fields));
      }
    }
    out.push('');
  }

  out.push('COMMIT;');
  return { success: true, data: out.join('\n') };
}

/**
 * Produce a SQL dump of only the database schema (DDL), without any row data.
 */
export async function generateSchemaDump(db: IDatabase): Promise<DumpResult> {
  const out: string[] = [];

  if (db.dialect === 'sqlite') {
    const allSchemas = await db.all(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_saved_queries'`);
    if (!allSchemas.success || !allSchemas.data) {
      return { success: false, error: allSchemas.error ?? 'Failed to read sqlite_master.' };
    }
    for (const row of allSchemas.data) {
      const stmt = String((row as Record<string, unknown>).sql).trim();
      out.push(stmt.endsWith(';') ? stmt : `${stmt};`, '');
    }
    return { success: true, data: out.join('\n').trim() };
  }

  const tables = await db.listTables();
  if (!tables.success) return { success: false, error: tables.error ?? 'Failed to list tables.' };

  for (const { name } of tables.data ?? []) {
    const info = await db.getTableInfo(name);
    if (!info.success || !info.data) continue;

    if (info.data.sql) out.push(info.data.sql.trim());

    for (const fk of info.data.foreignKeys ?? []) {
      if (fk.from && fk.to && fk.table) {
        let action = '';
        if (fk.on_delete && fk.on_delete !== 'NO ACTION') action += ` ON DELETE ${fk.on_delete}`;
        if (fk.on_update && fk.on_update !== 'NO ACTION') action += ` ON UPDATE ${fk.on_update}`;
        out.push(`ALTER TABLE "${name}" ADD FOREIGN KEY ("${fk.from}") REFERENCES "${fk.table}" ("${fk.to}")${action};`);
      }
    }

    for (const idx of info.data.indexes ?? []) {
      if (idx.sql) out.push(idx.sql.trim().endsWith(';') ? idx.sql.trim() : `${idx.sql.trim()};`);
    }
    out.push('');
  }

  return { success: true, data: out.join('\n').trim() };
}
