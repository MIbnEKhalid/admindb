import type { IDatabase, TableInfoData } from '../../db/types';
import { normalizeTableInfo, type NormalizedColumn, type NormalizedTable, type SupportedDialect } from '../transfer/dialect-mapper';

export interface ColumnDiff {
  name: string;
  action: 'added' | 'removed' | 'modified';
  sourceCol?: NormalizedColumn;
  targetCol?: NormalizedColumn;
  changes?: string[];
}

export interface TableDiff {
  name: string;
  action: 'added' | 'removed' | 'modified' | 'unchanged';
  sourceTable?: NormalizedTable;
  targetTable?: NormalizedTable;
  columnDiffs: ColumnDiff[];
  pkChanged: boolean;
  indexesAdded: string[];
  indexesRemoved: string[];
  fksAdded: string[];
  fksRemoved: string[];
}

export interface SchemaDiffResult {
  sourceDbId: string;
  targetDbId: string;
  sourceDialect: SupportedDialect;
  targetDialect: SupportedDialect;
  tables: TableDiff[];
  stats: {
    addedTables: number;
    removedTables: number;
    modifiedTables: number;
    identicalTables: number;
    totalColumnsChanged: number;
  };
  unifiedDiff: string;
}

/**
 * Compare two database schemas and produce structured diff and git-like unified diff string.
 */
export async function compareSchemas(
  sourceDb: IDatabase,
  sourceDbId: string,
  targetDb: IDatabase,
  targetDbId: string,
): Promise<SchemaDiffResult> {
  const [sourceTableListRes, targetTableListRes] = await Promise.all([
    sourceDb.listTables(),
    targetDb.listTables(),
  ]);

  if (!sourceTableListRes.success) throw new Error(sourceTableListRes.error || 'Failed to list source tables');
  if (!targetTableListRes.success) throw new Error(targetTableListRes.error || 'Failed to list target tables');

  const sourceTableNames = (sourceTableListRes.data || []).map((t) => t.name).filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_admindb_'));
  const targetTableNames = (targetTableListRes.data || []).map((t) => t.name).filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_admindb_'));

  const [sourceInfos, targetInfos] = await Promise.all([
    Promise.all(sourceTableNames.map(async (name) => (await sourceDb.getTableInfo(name)).data!)),
    Promise.all(targetTableNames.map(async (name) => (await targetDb.getTableInfo(name)).data!)),
  ]);

  const sourceDialect: SupportedDialect = sourceDb.dialect === 'postgres' ? 'postgres' : 'sqlite';
  const targetDialect: SupportedDialect = targetDb.dialect === 'postgres' ? 'postgres' : 'sqlite';

  const sourceMap = new Map<string, NormalizedTable>();
  for (const info of sourceInfos) {
    if (info) sourceMap.set(info.table, normalizeTableInfo(info, sourceDialect));
  }

  const targetMap = new Map<string, NormalizedTable>();
  for (const info of targetInfos) {
    if (info) targetMap.set(info.table, normalizeTableInfo(info, targetDialect));
  }

  const allNames = Array.from(new Set([...sourceTableNames, ...targetTableNames])).sort();
  const tableDiffs: TableDiff[] = [];

  let addedTables = 0;
  let removedTables = 0;
  let modifiedTables = 0;
  let identicalTables = 0;
  let totalColumnsChanged = 0;

  for (const name of allNames) {
    const src = sourceMap.get(name);
    const tgt = targetMap.get(name);

    if (src && !tgt) {
      addedTables++;
      tableDiffs.push({
        name,
        action: 'added',
        sourceTable: src,
        columnDiffs: src.columns.map((c) => ({ name: c.name, action: 'added', sourceCol: c })),
        pkChanged: true,
        indexesAdded: src.indexes.map((i) => i.name),
        indexesRemoved: [],
        fksAdded: src.foreignKeys.map((f) => `${f.from} -> ${f.table}.${f.to}`),
        fksRemoved: [],
      });
      continue;
    }

    if (!src && tgt) {
      removedTables++;
      tableDiffs.push({
        name,
        action: 'removed',
        targetTable: tgt,
        columnDiffs: tgt.columns.map((c) => ({ name: c.name, action: 'removed', targetCol: c })),
        pkChanged: true,
        indexesAdded: [],
        indexesRemoved: tgt.indexes.map((i) => i.name),
        fksAdded: [],
        fksRemoved: tgt.foreignKeys.map((f) => `${f.from} -> ${f.table}.${f.to}`),
      });
      continue;
    }

    if (src && tgt) {
      const colDiffs: ColumnDiff[] = [];
      const srcColMap = new Map(src.columns.map((c) => [c.name, c]));
      const tgtColMap = new Map(tgt.columns.map((c) => [c.name, c]));
      const colNames = Array.from(new Set([...srcColMap.keys(), ...tgtColMap.keys()]));

      for (const colName of colNames) {
        const sc = srcColMap.get(colName);
        const tc = tgtColMap.get(colName);

        if (sc && !tc) {
          colDiffs.push({ name: colName, action: 'added', sourceCol: sc });
          totalColumnsChanged++;
        } else if (!sc && tc) {
          colDiffs.push({ name: colName, action: 'removed', targetCol: tc });
          totalColumnsChanged++;
        } else if (sc && tc) {
          const changes: string[] = [];
          if (sc.genericType !== tc.genericType) {
            changes.push(`Type: target "${tc.type}" (${tc.genericType}) -> source "${sc.type}" (${sc.genericType})`);
          }
          if (sc.notNull !== tc.notNull) {
            changes.push(`NotNull: target ${tc.notNull} -> source ${sc.notNull}`);
          }
          if (sc.primaryKey !== tc.primaryKey) {
            changes.push(`PK: target ${tc.primaryKey} -> source ${sc.primaryKey}`);
          }
          if (sc.defaultValue !== tc.defaultValue) {
            changes.push(`Default: target "${tc.defaultValue}" -> source "${sc.defaultValue}"`);
          }
          if (changes.length > 0) {
            colDiffs.push({ name: colName, action: 'modified', sourceCol: sc, targetCol: tc, changes });
            totalColumnsChanged++;
          }
        }
      }

      const pkChanged = JSON.stringify(src.primaryKeys.sort()) !== JSON.stringify(tgt.primaryKeys.sort());

      const srcIdxNames = new Set(src.indexes.map((i) => i.name));
      const tgtIdxNames = new Set(tgt.indexes.map((i) => i.name));
      const indexesAdded = src.indexes.filter((i) => !tgtIdxNames.has(i.name)).map((i) => i.name);
      const indexesRemoved = tgt.indexes.filter((i) => !srcIdxNames.has(i.name)).map((i) => i.name);

      const srcFkDefs = src.foreignKeys.map((f) => `${f.from} -> ${f.table}.${f.to}`);
      const tgtFkDefs = tgt.foreignKeys.map((f) => `${f.from} -> ${f.table}.${f.to}`);
      const fksAdded = srcFkDefs.filter((f) => !tgtFkDefs.includes(f));
      const fksRemoved = tgtFkDefs.filter((f) => !srcFkDefs.includes(f));

      const isModified =
        colDiffs.length > 0 ||
        pkChanged ||
        indexesAdded.length > 0 ||
        indexesRemoved.length > 0 ||
        fksAdded.length > 0 ||
        fksRemoved.length > 0;

      if (isModified) {
        modifiedTables++;
        tableDiffs.push({
          name,
          action: 'modified',
          sourceTable: src,
          targetTable: tgt,
          columnDiffs: colDiffs,
          pkChanged,
          indexesAdded,
          indexesRemoved,
          fksAdded,
          fksRemoved,
        });
      } else {
        identicalTables++;
        tableDiffs.push({
          name,
          action: 'unchanged',
          sourceTable: src,
          targetTable: tgt,
          columnDiffs: [],
          pkChanged: false,
          indexesAdded: [],
          indexesRemoved: [],
          fksAdded: [],
          fksRemoved: [],
        });
      }
    }
  }

  const unifiedDiff = generateGitUnifiedDiff(sourceDbId, targetDbId, tableDiffs);

  return {
    sourceDbId,
    targetDbId,
    sourceDialect,
    targetDialect,
    tables: tableDiffs,
    stats: {
      addedTables,
      removedTables,
      modifiedTables,
      identicalTables,
      totalColumnsChanged,
    },
    unifiedDiff,
  };
}

/**
 * Format table and column differences into standard git-style unified diff text.
 */
function generateGitUnifiedDiff(sourceDbId: string, targetDbId: string, diffs: TableDiff[]): string {
  const lines: string[] = [
    `diff --git a/${targetDbId}/schema.sql b/${sourceDbId}/schema.sql`,
    `--- a/${targetDbId} (target)`,
    `+++ b/${sourceDbId} (source)`,
  ];

  for (const t of diffs) {
    if (t.action === 'unchanged') continue;

    lines.push(`@@ table: ${t.name} (${t.action.toUpperCase()}) @@`);

    if (t.action === 'added') {
      lines.push(`+ CREATE TABLE ${t.name}`);
      for (const col of t.sourceTable?.columns || []) {
        lines.push(`+   ${col.name}: ${col.type}${col.primaryKey ? ' PRIMARY KEY' : ''}${col.notNull ? ' NOT NULL' : ''}`);
      }
      for (const idx of t.indexesAdded) {
        lines.push(`+   INDEX ${idx}`);
      }
      for (const fk of t.fksAdded) {
        lines.push(`+   FK ${fk}`);
      }
      continue;
    }

    if (t.action === 'removed') {
      lines.push(`- DROP TABLE ${t.name}`);
      for (const col of t.targetTable?.columns || []) {
        lines.push(`-   ${col.name}: ${col.type}`);
      }
      continue;
    }

    // Modified
    for (const c of t.columnDiffs) {
      if (c.action === 'added') {
        lines.push(`+   column: ${c.name} (${c.sourceCol?.type || 'UNKNOWN'})${c.sourceCol?.notNull ? ' NOT NULL' : ''}`);
      } else if (c.action === 'removed') {
        lines.push(`-   column: ${c.name} (${c.targetCol?.type || 'UNKNOWN'})`);
      } else if (c.action === 'modified') {
        lines.push(`~   column: ${c.name} [${c.changes?.join('; ')}]`);
      }
    }

    if (t.pkChanged) {
      lines.push(`~   PK changed: target [${t.targetTable?.primaryKeys.join(', ')}] -> source [${t.sourceTable?.primaryKeys.join(', ')}]`);
    }

    for (const idx of t.indexesAdded) lines.push(`+   INDEX ${idx}`);
    for (const idx of t.indexesRemoved) lines.push(`-   INDEX ${idx}`);
    for (const fk of t.fksAdded) lines.push(`+   FK ${fk}`);
    for (const fk of t.fksRemoved) lines.push(`-   FK ${fk}`);
  }

  if (lines.length === 3) {
    lines.push(' Schemas are identical. No differences found.');
  }

  return lines.join('\n');
}
