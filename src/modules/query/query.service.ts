import type { DatabaseContext } from '../../core/context';
import { classifySql } from '../../sql/classifier';
import { analyzeSqlError, type SqlErrorDetails } from '../../sql/error-analyzer';
import { normalizeRow } from '../../utils/common';
import { toCsv, toJson } from '../../utils/csv';
import { createCsvStream, createJsonStream } from '../../utils/stream';

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
  static async execute(ctx: DatabaseContext, rawSql: string): Promise<QueryExecutionResult> {
    const { db } = ctx;
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

  static async exportQuery(ctx: DatabaseContext, sql: string, format: 'csv' | 'json') {
    const trimmed = String(sql ?? '').trim();
    if (!trimmed) throw new QueryExecutionError('SQL query is required.', 400);

    const r = await ctx.db.all(trimmed);
    if (!r.success) throw new QueryExecutionError(r.error ?? 'Query failed.', 400);

    const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = rows.length ? Object.keys(rows[0]) : [];

    if (format === 'json') {
      return { data: toJson(rows), contentType: 'application/json; charset=utf-8', filename: 'query_results.json' };
    }
    return { data: toCsv(rows, columns), contentType: 'text/csv; charset=utf-8', filename: 'query_results.csv' };
  }

  static async streamExportQuery(
    ctx: DatabaseContext,
    sql: string,
    format: 'csv' | 'json',
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> {
    const result = await QueryService.execute(ctx, sql);
    if (result.kind !== 'select') {
      throw new QueryExecutionError('Query must be a SELECT statement to export.', 400);
    }
    const columns = result.columns;
    const transform = format === 'json' ? createJsonStream() : createCsvStream(columns);

    process.nextTick(() => {
      for (const row of result.rows) {
        transform.write(row);
      }
      transform.end();
    });

    const contentType = format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';
    const filename = `query_results.${format}`;
    return { stream: transform, contentType, filename };
  }
}
