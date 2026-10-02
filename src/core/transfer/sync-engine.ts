import type { IDatabase, TableInfoData } from '../../db/types';
import {
  convertValueForDialect,
  generateCreateTableForDialect,
  normalizeTableInfo,
  type NormalizedTable,
  type SupportedDialect,
} from './dialect-mapper';
import { sortTablesTopologically, sortTablesForDeletion, type TableDependency } from './topological-sort';
import { maskRowData, type MaskingRule } from './masking';

export type SyncMode = 'full' | 'schema_only' | 'data_only_replace' | 'data_only_upsert';

export interface SyncOptions {
  tables?: string[];
  mode?: SyncMode;
  maskData?: boolean;
  maskRules?: MaskingRule[];
  batchSize?: number;
  dryRun?: boolean;
}

export interface SyncTableProgress {
  table: string;
  rowsCopied: number;
  totalRows: number;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  error?: string;
}

export interface SyncResult {
  success: boolean;
  dryRun: boolean;
  sourceDbId: string;
  targetDbId: string;
  mode: SyncMode;
  tablesProcessed: SyncTableProgress[];
  totalRowsTransferred: number;
  executionTimeMs: number;
  error?: string;
  summary: string;
}

/**
 * Executes or previews database replication / synchronization between two databases.
 */
export async function executeSync(
  sourceDb: IDatabase,
  sourceDbId: string,
  targetDb: IDatabase,
  targetDbId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const startTime = Date.now();
  const mode = options.mode || 'full';
  const batchSize = Math.max(50, options.batchSize || 500);
  const dryRun = Boolean(options.dryRun);
  const maskData = Boolean(options.maskData);

  const sourceDialect: SupportedDialect = sourceDb.dialect === 'postgres' ? 'postgres' : 'sqlite';
  const targetDialect: SupportedDialect = targetDb.dialect === 'postgres' ? 'postgres' : 'sqlite';

  // 1. Discover tables in source
  const srcTableListRes = await sourceDb.listTables();
  if (!srcTableListRes.success) throw new Error(srcTableListRes.error || 'Failed to list source tables');

  let tablesToSync = (srcTableListRes.data || [])
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_admindb_'));

  if (options.tables && options.tables.length > 0) {
    const selected = new Set(options.tables);
    tablesToSync = tablesToSync.filter((n) => selected.has(n));
  }

  // 2. Load table metadata
  const sourceTableInfos: TableInfoData[] = [];
  for (const name of tablesToSync) {
    const infoRes = await sourceDb.getTableInfo(name);
    if (infoRes.success && infoRes.data) {
      sourceTableInfos.push(infoRes.data);
    }
  }

  // 3. Resolve dependency order
  const deps: TableDependency[] = sourceTableInfos.map((i) => ({
    name: i.table,
    foreignKeys: i.foreignKeys || [],
  }));
  const insertionOrder = sortTablesTopologically(deps);
  const deletionOrder = sortTablesForDeletion(deps);

  const normalizedTables = new Map<string, NormalizedTable>();
  for (const info of sourceTableInfos) {
    normalizedTables.set(info.table, normalizeTableInfo(info, sourceDialect));
  }

  const progressList: SyncTableProgress[] = insertionOrder.map((name) => ({
    table: name,
    rowsCopied: 0,
    totalRows: 0,
    status: 'pending',
  }));

  if (dryRun) {
    let totalEstimatedRows = 0;
    for (const p of progressList) {
      const countRes = await sourceDb.getRowCount(p.table);
      p.totalRows = countRes.data || 0;
      p.rowsCopied = mode === 'schema_only' ? 0 : p.totalRows;
      p.status = 'completed';
      totalEstimatedRows += p.rowsCopied;
    }

    return {
      success: true,
      dryRun: true,
      sourceDbId,
      targetDbId,
      mode,
      tablesProcessed: progressList,
      totalRowsTransferred: totalEstimatedRows,
      executionTimeMs: Date.now() - startTime,
      summary: `Dry Run: Ready to sync ${progressList.length} tables (${totalEstimatedRows} estimated rows) from "${sourceDbId}" to "${targetDbId}".`,
    };
  }

  // Execute Actual Sync
  let totalRowsTransferred = 0;

  // Disable FK constraints on target temporarily if possible
  try {
    if (targetDialect === 'sqlite') {
      await targetDb.execResult('PRAGMA foreign_keys = OFF;');
    } else {
      // Postgres: defer constraints if deferred
      try {
        await targetDb.execResult('SET CONSTRAINTS ALL DEFERRED;');
      } catch {}
    }
  } catch {}

  try {
    // Phase A: Schema setup or Truncation
    if (mode === 'full') {
      // Drop existing tables in reverse topological order, then recreate in forward order
      for (const tableName of deletionOrder) {
        try {
          await targetDb.execResult(
            targetDialect === 'postgres'
              ? `DROP TABLE IF EXISTS "${tableName}" CASCADE;`
              : `DROP TABLE IF EXISTS \`${tableName}\`;`,
          );
        } catch {}
      }

      for (const tableName of insertionOrder) {
        const norm = normalizedTables.get(tableName);
        if (!norm) continue;
        const ddl = generateCreateTableForDialect(norm, targetDialect);
        const createRes = await targetDb.execResult(ddl);
        if (!createRes.success) {
          throw new Error(`Failed to create table "${tableName}": ${createRes.error}`);
        }

        // Create indexes
        for (const idx of norm.indexes || []) {
          if (idx.name?.startsWith('sqlite_')) continue;
          const colsArr = Array.isArray(idx?.columns) ? idx.columns.filter(Boolean) : [];
          if (colsArr.length === 0) continue;
          const uq = idx.unique ? 'UNIQUE ' : '';
          const q = targetDialect === 'postgres' ? (s: string) => `"${s}"` : (s: string) => `\`${s}\``;
          const cols = colsArr.map(q).join(', ');
          try {
            await targetDb.execResult(`CREATE ${uq}INDEX IF NOT EXISTS ${q(idx.name)} ON ${q(tableName)} (${cols});`);
          } catch {}
        }
      }
    } else if (mode === 'schema_only') {
      for (const tableName of insertionOrder) {
        const norm = normalizedTables.get(tableName);
        if (!norm) continue;
        const targetInfo = await targetDb.getTableInfo(tableName);
        if (!targetInfo.success || !targetInfo.data || targetInfo.data.columns.length === 0) {
          const ddl = generateCreateTableForDialect(norm, targetDialect);
          const createRes = await targetDb.execResult(ddl);
          if (!createRes.success) {
            throw new Error(`Failed to create table "${tableName}": ${createRes.error}`);
          }
        }
      }
    } else if (mode === 'data_only_replace') {
      for (const tableName of deletionOrder) {
        try {
          await targetDb.execResult(
            targetDialect === 'postgres' ? `TRUNCATE TABLE "${tableName}" CASCADE;` : `DELETE FROM \`${tableName}\`;`,
          );
        } catch {}
      }
    }

    // Phase B: Data Transfer (Streaming batches)
    if (mode !== 'schema_only') {
      for (const p of progressList) {
        const tableName = p.table;
        p.status = 'in_progress';

        const norm = normalizedTables.get(tableName);
        if (!norm) continue;

        const countRes = await sourceDb.getRowCount(tableName);
        p.totalRows = countRes.data || 0;

        let offset = 0;
        let tableRowsCopied = 0;

        while (offset < p.totalRows || (offset === 0 && p.totalRows === 0)) {
          if (p.totalRows === 0) break;

          const rowsRes = await sourceDb.getRows(tableName, { page: Math.floor(offset / batchSize) + 1, limit: batchSize });
          const rows = rowsRes.data || [];
          if (rows.length === 0) break;

          // Prepare rows for insertion
          const targetRows: { column: string; value: unknown }[][] = [];

          for (let i = 0; i < rows.length; i++) {
            let row = rows[i];
            if (maskData) {
              row = maskRowData(row, options.maskRules, offset + i + 1);
            }

            const fields: { column: string; value: unknown }[] = [];
            for (const col of norm.columns) {
              const rawVal = row[col.name];
              const convertedVal = convertValueForDialect(rawVal, col.genericType, targetDialect);
              fields.push({ column: col.name, value: convertedVal });
            }
            targetRows.push(fields);
          }

          const insertRes = await targetDb.insertRows(tableName, targetRows);
          if (!insertRes.success) {
            throw new Error(`Failed to insert batch into "${tableName}": ${insertRes.error}`);
          }

          tableRowsCopied += targetRows.length;
          offset += rows.length;
        }

        // PostgreSQL Sequence Synchronization
        if (targetDialect === 'postgres') {
          for (const col of norm.columns) {
            if (col.primaryKey && col.autoIncrement) {
              try {
                await targetDb.all(
                  `SELECT setval(pg_get_serial_sequence('"${tableName}"', '${col.name}'), COALESCE(MAX("${col.name}"), 1)) FROM "${tableName}";`,
                );
              } catch {}
            }
          }
        }

        p.rowsCopied = tableRowsCopied;
        totalRowsTransferred += tableRowsCopied;
        p.status = 'completed';
      }
    }
  } catch (err: any) {
    return {
      success: false,
      dryRun: false,
      sourceDbId,
      targetDbId,
      mode,
      tablesProcessed: progressList,
      totalRowsTransferred,
      executionTimeMs: Date.now() - startTime,
      error: err.message || String(err),
      summary: `Sync failed: ${err.message}`,
    };
  } finally {
    // Re-enable FK constraints
    try {
      if (targetDialect === 'sqlite') {
        await targetDb.execResult('PRAGMA foreign_keys = ON;');
      } else {
        try {
          await targetDb.execResult('SET CONSTRAINTS ALL IMMEDIATE;');
        } catch {}
      }
    } catch {}
  }

  return {
    success: true,
    dryRun: false,
    sourceDbId,
    targetDbId,
    mode,
    tablesProcessed: progressList,
    totalRowsTransferred,
    executionTimeMs: Date.now() - startTime,
    summary: `Successfully synchronized ${progressList.length} tables (${totalRowsTransferred} rows) from "${sourceDbId}" to "${targetDbId}".`,
  };
}
