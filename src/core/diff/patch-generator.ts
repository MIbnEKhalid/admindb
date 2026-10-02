import type { SchemaDiffResult, TableDiff } from './schema-differ';
import { generateCreateTableForDialect, mapColumnToDialect, mapDefaultValueForDialect, type SupportedDialect } from '../transfer/dialect-mapper';

export interface GeneratedPatch {
  upSql: string;
  downSql: string;
}

/**
 * Generates UP (migration) and DOWN (rollback) SQL scripts to sync target schema to source schema.
 */
export function generateSchemaPatch(diff: SchemaDiffResult, targetDialect: SupportedDialect): GeneratedPatch {
  const upLines: string[] = [`-- UP Migration: Align "${diff.targetDbId}" with "${diff.sourceDbId}" (${targetDialect})`];
  const downLines: string[] = [`-- DOWN Rollback: Revert changes on "${diff.targetDbId}"`];

  const q = targetDialect === 'postgres' ? (s: string) => `"${s}"` : (s: string) => `\`${s}\``;

  for (const table of diff.tables) {
    if (table.action === 'unchanged') continue;

    // 1. Table Added in Source -> Needs CREATE in Target
    if (table.action === 'added' && table.sourceTable) {
      const createSql = generateCreateTableForDialect(table.sourceTable, targetDialect);
      upLines.push(`\n-- Create table ${table.name}`);
      upLines.push(createSql);

      // Indexes
      for (const idx of table.sourceTable.indexes || []) {
        if (idx.name?.startsWith('sqlite_')) continue;
        const colsArr = Array.isArray(idx?.columns) ? idx.columns.filter(Boolean) : [];
        if (colsArr.length === 0) continue;
        const uq = idx.unique ? 'UNIQUE ' : '';
        const cols = colsArr.map(q).join(', ');
        upLines.push(`CREATE ${uq}INDEX IF NOT EXISTS ${q(idx.name)} ON ${q(table.name)} (${cols});`);
      }

      downLines.push(`\n-- Revert: Drop created table ${table.name}`);
      downLines.push(`DROP TABLE IF EXISTS ${q(table.name)};`);
      continue;
    }

    // 2. Table Removed in Source -> Needs DROP in Target
    if (table.action === 'removed' && table.targetTable) {
      upLines.push(`\n-- Drop obsolete table ${table.name}`);
      upLines.push(`DROP TABLE IF EXISTS ${q(table.name)};`);

      const recreateSql = generateCreateTableForDialect(table.targetTable, targetDialect);
      downLines.push(`\n-- Revert: Re-create dropped table ${table.name}`);
      downLines.push(recreateSql);
      continue;
    }

    // 3. Table Modified
    if (table.action === 'modified') {
      upLines.push(`\n-- Modify table ${table.name}`);

      for (const col of table.columnDiffs) {
        if (col.action === 'added' && col.sourceCol) {
          const typeStr = mapColumnToDialect(col.sourceCol, targetDialect);
          const notNullStr = col.sourceCol.notNull ? ' NOT NULL' : '';
          const mappedDefault = mapDefaultValueForDialect(col.sourceCol.defaultValue, col.sourceCol.genericType, targetDialect);
          const dfltStr = mappedDefault !== null && mappedDefault !== undefined ? ` DEFAULT ${mappedDefault}` : '';
          upLines.push(`ALTER TABLE ${q(table.name)} ADD COLUMN ${q(col.name)} ${typeStr}${notNullStr}${dfltStr};`);
          downLines.push(`ALTER TABLE ${q(table.name)} DROP COLUMN IF EXISTS ${q(col.name)};`);
        } else if (col.action === 'removed' && col.targetCol) {
          upLines.push(`ALTER TABLE ${q(table.name)} DROP COLUMN IF EXISTS ${q(col.name)};`);
          const typeStr = mapColumnToDialect(col.targetCol, targetDialect);
          downLines.push(`ALTER TABLE ${q(table.name)} ADD COLUMN ${q(col.name)} ${typeStr};`);
        }
      }

      // Indexes added/removed
      for (const idx of table.sourceTable?.indexes || []) {
        if (idx.name?.startsWith('sqlite_')) continue;
        if (table.indexesAdded.includes(idx.name)) {
          const colsArr = Array.isArray(idx?.columns) ? idx.columns.filter(Boolean) : [];
          if (colsArr.length === 0) continue;
          const uq = idx.unique ? 'UNIQUE ' : '';
          const cols = colsArr.map(q).join(', ');
          upLines.push(`CREATE ${uq}INDEX IF NOT EXISTS ${q(idx.name)} ON ${q(table.name)} (${cols});`);
          downLines.push(`DROP INDEX IF EXISTS ${q(idx.name)};`);
        }
      }

      for (const idxName of table.indexesRemoved) {
        upLines.push(`DROP INDEX IF EXISTS ${q(idxName)};`);
      }
    }
  }

  return {
    upSql: upLines.join('\n'),
    downSql: downLines.join('\n'),
  };
}
