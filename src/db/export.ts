import type { SqliteDatabase } from './database';
import { generateInsert } from '../sql/generator';

export interface DumpResult {
  success: boolean;
  data?: string;
  error?: string;
}

/**
 * Produce a downloadable SQL dump: for every table emit its CREATE statement
 * followed by one INSERT statement per row. BLOB values are exported as
 * X'…' literals so they round-trip as real blobs.
 */
export async function generateSqlDump(db: SqliteDatabase): Promise<DumpResult> {
  const out: string[] = [];
  out.push('PRAGMA foreign_keys=OFF;');
  out.push('BEGIN TRANSACTION;');

  const tables = await db.listTables();
  if (!tables.success) return { success: false, error: tables.error ?? 'Failed to list tables.' };

  for (const t of tables.data ?? []) {
    const name = t.name;

    const create = await db.getCreateStatement(name);
    if (create.success && create.data) {
      out.push(create.data.trim());
    }

    const info = await db.getTableInfo(name);
    const rows = await db.getAllRows(name);
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
