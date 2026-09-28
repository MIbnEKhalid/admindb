import type { IDatabase } from '../../db/index';
import { classifySql } from '../../sql/classifier';
import { analyzeSqlError, type SqlErrorDetails } from '../../sql/error-analyzer';
import { normalizeRow } from '../../utils/common';
import { toCsv, toJson } from '../../utils/csv';

export type QueryExecutionResult =
  | { kind: 'script'; message: string }
  | { kind: 'select'; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: 'write'; changes: number | null; message: string };

export class QueryExecutionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: SqlErrorDetails | Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'QueryExecutionError';
  }
}

export class QueryService {
  static async execute(db: IDatabase, rawSql: string): Promise<QueryExecutionResult> {
    const trimmed = String(rawSql ?? '').trim();
    if (!trimmed) {
      throw new QueryExecutionError('SQL query is required.', 400);
    }

    const { kind } = classifySql(trimmed);

    if (db.hasMultipleStatements(trimmed)) {
      if (db.isReadOnly) {
        throw new QueryExecutionError('Database is open in read-only mode — write statements are disabled.', 403);
      }
      const r = await db.execResult(trimmed);
      if (!r.success) {
        const details = await analyzeSqlError(trimmed, r.error ?? 'Script execution failed.', db);
        throw new QueryExecutionError(r.error ?? 'Query failed.', 400, details as unknown as Record<string, unknown>);
      }
      return { kind: 'script', message: 'Script executed successfully.' };
    }

    if (kind === 'select' || kind === 'read' || kind === 'count') {
      const r = await db.all(trimmed);
      if (!r.success) {
        const details = await analyzeSqlError(trimmed, r.error ?? 'Query execution failed.', db);
        throw new QueryExecutionError(r.error ?? 'Query failed.', 400, details as unknown as Record<string, unknown>);
      }
      const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
      return { kind: 'select', columns: rows.length ? Object.keys(rows[0]) : [], rows };
    }

    if (db.isReadOnly) {
      throw new QueryExecutionError('Database is open in read-only mode — write statements are disabled.', 403);
    }

    const r = await db.runWrite(trimmed);
    if (!r.success) {
      const details = await analyzeSqlError(trimmed, r.error ?? 'Statement execution failed.', db);
      throw new QueryExecutionError(r.error ?? 'Query failed.', 400, details as unknown as Record<string, unknown>);
    }

    const changes = r.data?.changes as number | undefined;
    return {
      kind: 'write',
      changes: changes ?? null,
      message: changes != null ? `${changes} row(s) affected.` : 'Statement executed successfully.',
    };
  }

  static async listSavedQueries(db: IDatabase) {
    const r = await db.listSavedQueries();
    if (!r.success) {
      throw new QueryExecutionError(r.error ?? 'Failed to load queries.', 500);
    }
    return r.data;
  }

  static async saveQuery(db: IDatabase, name: string, sql: string) {
    const trimmedName = String(name ?? '').trim();
    const trimmedSql = String(sql ?? '').trim();
    if (!trimmedName) throw new QueryExecutionError('Query name is required.', 400);
    if (!trimmedSql) throw new QueryExecutionError('Query SQL is required.', 400);

    const r = await db.saveQuery(trimmedName, trimmedSql);
    if (!r.success) throw new QueryExecutionError(r.error ?? 'Failed to save query.', 400);
    return { message: 'Query saved.' };
  }

  static async deleteSavedQuery(db: IDatabase, id: string) {
    const r = await db.deleteSavedQuery(id);
    if (!r.success) throw new QueryExecutionError(r.error ?? 'Failed to delete query.', 400);
    return { message: 'Query deleted.' };
  }

  static async exportQuery(db: IDatabase, sql: string, format: 'csv' | 'json') {
    const trimmed = String(sql ?? '').trim();
    if (!trimmed) throw new QueryExecutionError('SQL query is required.', 400);

    const r = await db.all(trimmed);
    if (!r.success) throw new QueryExecutionError(r.error ?? 'Query failed.', 400);

    const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = rows.length ? Object.keys(rows[0]) : [];

    if (format === 'json') {
      return { data: toJson(rows), contentType: 'application/json; charset=utf-8', filename: 'query_results.json' };
    }
    return { data: toCsv(rows, columns), contentType: 'text/csv; charset=utf-8', filename: 'query_results.csv' };
  }
}
