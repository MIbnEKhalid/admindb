import type { IDatabase } from '../../db/types';
import type { DbManager, DatabaseEntry } from '../../db/manager';
import { compareSchemas, type SchemaDiffResult } from '../../core/diff/schema-differ';
import { compareTableData, type TableDataDiffResult } from '../../core/diff/data-differ';
import { generateSchemaPatch, type GeneratedPatch } from '../../core/diff/patch-generator';
import { executeSync, type SyncOptions, type SyncResult } from '../../core/transfer/sync-engine';
import type { SupportedDialect } from '../../core/transfer/dialect-mapper';

export class SyncService {
  /**
   * Returns list of available databases for comparison & sync.
   */
  static listAvailableDatabases(manager?: DbManager, defaultDb?: { id: string; name: string; dialect: string; path: string; readonly: boolean }): DatabaseEntry[] {
    if (manager) {
      return manager.list();
    }
    if (defaultDb) {
      return [
        {
          id: defaultDb.id,
          name: defaultDb.name,
          path: defaultDb.path,
          dialect: defaultDb.dialect === 'postgres' ? 'postgres' : 'sqlite',
          size: 0,
          modified: '',
          readonly: defaultDb.readonly,
        },
      ];
    }
    return [];
  }

  /**
   * Compare schema between two databases.
   */
  static async diffSchema(
    sourceDb: IDatabase,
    sourceDbId: string,
    targetDb: IDatabase,
    targetDbId: string,
  ): Promise<SchemaDiffResult> {
    return compareSchemas(sourceDb, sourceDbId, targetDb, targetDbId);
  }

  /**
   * Compare row data between source and target for a specific table.
   */
  static async diffTableData(
    sourceDb: IDatabase,
    targetDb: IDatabase,
    table: string,
    limit = 200,
  ): Promise<TableDataDiffResult> {
    return compareTableData(sourceDb, targetDb, table, limit);
  }

  /**
   * Generate UP/DOWN SQL migration scripts from schema diff.
   */
  static generatePatch(diff: SchemaDiffResult, targetDialect: SupportedDialect): GeneratedPatch {
    return generateSchemaPatch(diff, targetDialect);
  }

  /**
   * Execute or preview database replication.
   */
  static async replicate(
    sourceDb: IDatabase,
    sourceDbId: string,
    targetDb: IDatabase,
    targetDbId: string,
    options: SyncOptions,
  ): Promise<SyncResult> {
    return executeSync(sourceDb, sourceDbId, targetDb, targetDbId, options);
  }
}
