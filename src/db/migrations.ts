import type Database from 'better-sqlite3';
import { generateCreateTable, quoteIdentifier, type ColumnDef } from '../sql/generator';
import type { ColumnInfo, ForeignKeyInfo } from './types';

export function modifyTableStructureSync(
  db: Database.Database,
  table: string,
  transformColumns: (columns: ColumnDef[]) => ColumnDef[],
  renamedOldCol?: string,
  renamedNewCol?: string,
): { changes: number } {
  const rawCols = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as ColumnInfo[];
  if (!rawCols.length) throw new Error(`Table "${table}" does not exist.`);

  const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as unknown as ForeignKeyInfo[];
  const indexRows = db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as unknown as { seq: number; name: string; unique: number; origin: string; partial: number }[];

  // Discover which single columns are UNIQUE across the whole table
  const uniqueCols = new Set<string>();
  for (const ix of indexRows) {
    if (ix.unique) {
      const ixCols = (db.prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`).all() as unknown as { seqno: number; cid: number; name: string }[]).map((c) => c.name);
      if (ixCols.length === 1) uniqueCols.add(ixCols[0]);
    }
  }

  const userIndexes: { name: string; unique: boolean; columns: string[] }[] = [];
  for (const ix of indexRows) {
    if (ix.origin === 'c') {
      const ixCols = (db.prepare(`PRAGMA index_info(${quoteIdentifier(ix.name)})`).all() as unknown as { seqno: number; cid: number; name: string }[]).map((c) => c.name);
      let ixName = ix.name;
      if (renamedOldCol && renamedNewCol) {
        if (ixName === `idx_${table}_${renamedOldCol}`) {
          ixName = `idx_${table}_${renamedNewCol}`;
        } else if (ixName === `idx_${table}_${renamedOldCol}_unique`) {
          ixName = `idx_${table}_${renamedNewCol}_unique`;
        }
      }
      userIndexes.push({
        name: ixName,
        unique: Boolean(ix.unique),
        columns: ixCols.map((c) => (renamedOldCol && renamedNewCol && c === renamedOldCol ? renamedNewCol : c)),
      });
    }
  }

  const currentCols: ColumnDef[] = rawCols.map((c) => {
    const existingFk = fks.find((f) => f.from === c.name);
    return {
      name: c.name,
      type: c.type,
      primaryKey: c.pk > 0,
      notNull: Boolean(c.notnull),
      unique: uniqueCols.has(c.name),
      defaultValue: c.dflt_value,
      foreignKey: existingFk ? { table: existingFk.table, column: existingFk.to ?? '' } : null,
    };
  });

  const newCols = transformColumns(currentCols);
  const tempTable = `_admindb_tmp_${table}_${Date.now()}`;
  const createSql = generateCreateTable(tempTable, newCols);

  const oldColMap = new Set(rawCols.map((c) => c.name));
  const matchingOldCols: string[] = [];
  const matchingNewCols: string[] = [];

  for (const nc of newCols) {
    const sourceColName = renamedOldCol && renamedNewCol && nc.name === renamedNewCol ? renamedOldCol : nc.name;
    if (oldColMap.has(sourceColName)) {
      matchingOldCols.push(quoteIdentifier(sourceColName));
      matchingNewCols.push(quoteIdentifier(nc.name));
    }
  }

  db.exec('PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;');
  try {
    db.exec(createSql);
    if (matchingOldCols.length > 0) {
      db.exec(`INSERT INTO ${quoteIdentifier(tempTable)} (${matchingNewCols.join(', ')}) SELECT ${matchingOldCols.join(', ')} FROM ${quoteIdentifier(table)};`);
    }
    db.exec(`DROP TABLE ${quoteIdentifier(table)};`);
    db.exec(`ALTER TABLE ${quoteIdentifier(tempTable)} RENAME TO ${quoteIdentifier(table)};`);

    for (const ix of userIndexes) {
      const uq = ix.unique ? 'UNIQUE ' : '';
      const ixColsStr = ix.columns.map(quoteIdentifier).join(', ');
      try {
        db.exec(`CREATE ${uq}INDEX IF NOT EXISTS ${quoteIdentifier(ix.name)} ON ${quoteIdentifier(table)} (${ixColsStr});`);
      } catch {}
    }

    if (db.prepare('PRAGMA foreign_key_check;').all().length > 0) {
      throw new Error('Foreign key constraint check failed after schema modification.');
    }

    db.exec('COMMIT;');
    return { changes: 1 };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    try { db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTable)};`); } catch {}
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
