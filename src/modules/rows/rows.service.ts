import type { IDatabase, TableInfoData, WhereClause, RowFilters, SQLInputValue } from '../../db/index';
import type { DatabaseContext } from '../../core/context';
import { coerceFormValue, decodePk, normalizeRow } from '../../utils/common';
import { toCsv, toJson, parseCsv } from '../../utils/csv';
import { createCsvStream, createJsonStream, parseCsvStreamBatched } from '../../utils/stream';
import { generateInsert, generateUpdate, quoteIdentifier } from '../../sql/generator';
import { resolveBlobBuffer, parseBlobPayload, getBlobMetadata, sniffBlobMime } from './blob.helper';

export const MAX_BULK_ROWS = 1000;

export interface CursorPaginationOptions {
  cursor?: string | null;
  limit?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: RowFilters;
}

export interface CursorPaginatedResult {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface BulkImpactResult {
  references: { table: string; from: string; to: string; count: number }[];
  total: number;
}


export interface RowReferenceResult {
  table: string;
  from: string;
  to: string;
  value?: unknown;
  columns?: string[];
  rows: Record<string, unknown>[];
  count?: number;
  total: number;
}

export function buildFields(
  info: TableInfoData,
  values: Record<string, unknown>,
  opts: { excludePk?: boolean } = {},
): { column: string; value: unknown }[] {
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  const pkSet = new Set(info.primaryKey);
  const fields: { column: string; value: unknown }[] = [];
  for (const [col, raw] of Object.entries(values ?? {})) {
    if (!typeMap.has(col) || (opts.excludePk && pkSet.has(col))) continue;
    const val = coerceFormValue(raw, typeMap.get(col)!);
    if (val !== null) fields.push({ column: col, value: val });
  }
  return fields;
}

export function buildUpdateFields(
  info: TableInfoData,
  values: Record<string, unknown>,
  nulls: string[],
): { column: string; value: unknown }[] {
  const fields = buildFields(info, values, { excludePk: true });
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  const pkSet = new Set(info.primaryKey);
  for (const col of nulls) {
    if (!pkSet.has(col) && typeMap.has(col) && !fields.some((f) => f.column === col)) {
      fields.push({ column: col, value: null });
    }
  }
  return fields;
}

export function pkWhere(info: TableInfoData, encodedId: string): WhereClause[] | null {
  const vals = decodePk(encodedId);
  if (!info.primaryKey.length) {
    if (vals.length === 1 && vals[0] !== '') {
      const num = Number(vals[0]);
      return [{ column: '_rowid_', value: Number.isFinite(num) ? num : vals[0] }];
    }
    return null;
  }
  if (vals.length !== info.primaryKey.length) return null;
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  return info.primaryKey.map((col, i) => ({ column: col, value: coerceFormValue(vals[i], typeMap.get(col)!) }));
}

export function resolvePkRows(info: TableInfoData, ids: unknown): WhereClause[][] | null {
  const list = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
  const out: WhereClause[][] = [];
  for (const id of list) {
    const where = pkWhere(info, String(id));
    if (where) out.push(where);
  }
  return out.length ? out : null;
}

export async function computeBulkImpact(
  ctx: DatabaseContext,
  info: TableInfoData,
  wheres: WhereClause[][],
): Promise<BulkImpactResult> {
  const { db } = ctx;
  const [rowsR, refInfoR] = await Promise.all([
    db.getRowsByPks(info.table, wheres),
    db.getReferencingTables(info.table),
  ]);

  const rows = (rowsR.data ?? []) as Record<string, unknown>[];
  const referencing = refInfoR.data ?? [];
  if (!rows.length || !referencing.length) return { references: [], total: 0 };

  const queries = referencing.flatMap((item: { table: string; refs: { from: string; to: string }[] }) =>
    item.refs.map(async (ref: { from: string; to: string }) => {
      const targetCol = ref.to || info.primaryKey[0];
      if (!targetCol) return null;
      const values = Array.from(new Set(rows.map((r) => r[targetCol]).filter((v) => v != null)));
      if (!values.length) return null;

      try {
        const placeholders = values.map(() => '?').join(', ');
        const sql = `SELECT COUNT(*) AS c FROM ${quoteIdentifier(item.table)} WHERE ${quoteIdentifier(ref.from)} IN (${placeholders})`;
        const countR = await db.all(sql, values as SQLInputValue[]);
        const count = countR.success && countR.data?.[0] ? Number((countR.data[0] as { c?: number }).c ?? 0) : 0;
        return count > 0 ? { table: item.table, from: ref.from, to: targetCol, count } : null;
      } catch {
        return null;
      }
    }),
  );

  const results = (await Promise.all(queries)).filter((r): r is { table: string; from: string; to: string; count: number } => r !== null);
  const total = results.reduce((acc: number, r: { count: number }) => acc + r.count, 0);
  return { references: results, total };
}

export function encodeCursor(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

export class RowsService {
  static async getPaginatedRows(
    ctx: DatabaseContext,
    table: string,
    options: {
      page?: number;
      limit?: number;
      orderBy?: string;
      orderDir?: 'asc' | 'desc';
      filters?: RowFilters;
    } = {},
  ) {
    const { db } = ctx;
    const page = options.page ?? 1;
    const limit = options.limit ?? 50;
    const [rowsR, totalR] = await Promise.all([
      db.getRows(table, { ...options, page, limit }),
      db.getRowCount(table, options.filters),
    ]);

    if (!rowsR.success) {
      throw new Error(rowsR.error ?? 'Failed to load rows.');
    }

    const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const total = totalR.success && typeof totalR.data === 'number' ? totalR.data : rows.length;
    return {
      rows,
      total,
      page,
      limit,
    };
  }

  static async getCursorPaginatedRows(
    ctx: DatabaseContext,
    table: string,
    options: CursorPaginationOptions = {},
  ): Promise<CursorPaginatedResult> {
    const { db } = ctx;
    const limit = Math.max(1, Math.min(500, options.limit ?? 50));
    const orderDir = options.orderDir === 'desc' ? 'desc' : 'asc';
    const info = await db.getTableInfo(table);
    const tableInfo = info.data;
    const pkCol = tableInfo?.primaryKey[0] ?? '_rowid_';
    const orderBy = options.orderBy ?? pkCol;

    const filters: RowFilters = { ...(options.filters ?? {}) };
    const decodedCursor = options.cursor ? decodeCursor(options.cursor) : null;

    if (decodedCursor && decodedCursor[orderBy] !== undefined) {
      const cursorVal = decodedCursor[orderBy];
      const op = orderDir === 'asc' ? 'gt' : 'lt';
      filters[orderBy] = { op, value: String(cursorVal) };
    }

    const rowsR = await db.getRows(table, {
      filters,
      orderBy,
      orderDir,
      limit: limit + 1,
    });

    if (!rowsR.success) {
      throw new Error(rowsR.error ?? 'Failed to load cursor-paginated rows.');
    }

    const rawRows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const hasMore = rawRows.length > limit;
    const rows = hasMore ? rawRows.slice(0, limit) : rawRows;

    let nextCursor: string | null = null;
    let prevCursor: string | null = null;

    if (rows.length > 0) {
      const firstRow = rows[0];
      const lastRow = rows[rows.length - 1];
      if (hasMore) {
        nextCursor = encodeCursor({ [orderBy]: lastRow[orderBy], [pkCol]: lastRow[pkCol] });
      }
      if (options.cursor) {
        prevCursor = encodeCursor({ [orderBy]: firstRow[orderBy], [pkCol]: firstRow[pkCol] });
      }
    }

    return {
      rows,
      nextCursor,
      prevCursor,
      hasMore,
      limit,
    };
  }

  static async getRowCount(ctx: DatabaseContext, table: string, filters?: RowFilters): Promise<number> {
    const r = await ctx.db.getRowCount(table, filters);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to count rows.');
    }
    return r.data ?? 0;
  }

  static async getRow(ctx: DatabaseContext, table: string, where: WhereClause[]) {
    const r = await ctx.db.getRow(table, where);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to load row.');
    }
    return r.data ? normalizeRow(r.data) : null;
  }

  static async getBlob(ctx: DatabaseContext, table: string, where: WhereClause[], column: string) {
    const r = await ctx.db.getRow(table, where);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to load row.');
    }
    if (!r.data) return null;

    const rawVal = r.data[column];
    if (rawVal === null || rawVal === undefined) return null;

    const buf = resolveBlobBuffer(rawVal);
    const mimeInfo = sniffBlobMime(buf);
    return { buffer: buf, mimeInfo };
  }

  static async getBlobMeta(ctx: DatabaseContext, table: string, where: WhereClause[], column: string) {
    const r = await ctx.db.getRow(table, where);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to load row.');
    }
    if (!r.data) return null;

    const rawVal = r.data[column];
    return getBlobMetadata(rawVal);
  }

  static async updateBlob(
    ctx: DatabaseContext,
    table: string,
    where: WhereClause[],
    column: string,
    data: unknown,
    format?: string,
  ): Promise<number> {
    const buf = parseBlobPayload(data, format);
    const updateRes = await ctx.db.updateRow(table, [{ column, value: buf }], where);
    if (!updateRes.success) {
      throw new Error(updateRes.error ?? 'Failed to update BLOB.');
    }
    return buf.length;
  }

  static generateInsertSql(table: string, fields: { column: string; value: unknown }[]): string {
    if (!fields.length) throw new Error('No valid column values provided.');
    return generateInsert(table, fields);
  }

  static generateUpdateSql(
    table: string,
    fields: { column: string; value: unknown }[],
    where: WhereClause[],
  ): string {
    if (!fields.length) throw new Error('No fields to update.');
    return generateUpdate(table, fields, where);
  }

  static async insertRow(
    ctx: DatabaseContext,
    table: string,
    fields: { column: string; value: unknown }[],
  ) {
    if (!fields.length) throw new Error('No valid column values provided.');
    const r = await ctx.db.insertRow(table, fields);
    if (!r.success) throw new Error(r.error ?? 'Failed to insert row.');
    return r.data?.lastInsertRowid;
  }

  static async insertRows(
    ctx: DatabaseContext,
    table: string,
    fieldsList: { column: string; value: unknown }[][],
  ) {
    if (!fieldsList.length) throw new Error('No rows provided.');
    const r = await ctx.db.insertRows(table, fieldsList);
    if (!r.success) throw new Error(r.error ?? 'Failed to insert rows.');
    return r.data?.inserted ?? 0;
  }

  static async updateRow(
    ctx: DatabaseContext,
    table: string,
    fields: { column: string; value: unknown }[],
    where: WhereClause[],
  ) {
    if (!fields.length) throw new Error('No fields to update.');
    const r = await ctx.db.updateRow(table, fields, where);
    if (!r.success) throw new Error(r.error ?? 'Failed to update row.');
  }

  static async updateRows(
    ctx: DatabaseContext,
    table: string,
    rowUpdates: { fields: WhereClause[]; where: WhereClause[] }[],
  ) {
    if (!rowUpdates.length) return 0;
    const r = await ctx.db.updateRows(table, rowUpdates);
    if (!r.success) throw new Error(r.error ?? 'Failed to update rows.');
    return r.data?.updated ?? 0;
  }

  static async deleteRow(ctx: DatabaseContext, table: string, where: WhereClause[]) {
    const r = await ctx.db.deleteRow(table, where);
    if (!r.success) throw new Error(r.error ?? 'Failed to delete row.');
  }

  static async deleteRows(ctx: DatabaseContext, table: string, wheres: WhereClause[][]) {
    const r = await ctx.db.deleteRows(table, wheres);
    if (!r.success) throw new Error(r.error ?? 'Failed to delete rows.');
    return r.data?.deleted ?? 0;
  }

  static async getRowReferences(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    where: WhereClause[],
  ): Promise<RowReferenceResult[]> {
    const { db } = ctx;
    const rowR = await db.getRow(table, where);
    if (!rowR.success || !rowR.data) {
      throw new Error('Row not found.');
    }

    const refInfoR = await db.getReferencingTables(table);
    const referencing = refInfoR.data ?? [];
    const results: RowReferenceResult[] = [];

    for (const item of referencing) {
      for (const ref of item.refs) {
        const targetCol = ref.to || info.primaryKey[0];
        if (!targetCol) continue;
        const val = rowR.data[targetCol];
        if (val == null) continue;
        const fkR = await db.getRowsByFk(item.table, ref.from, val);
        if (fkR.success && fkR.data) {
          const rows = fkR.data.rows.map(normalizeRow);
          results.push({
            table: item.table,
            from: ref.from,
            to: targetCol,
            value: val,
            columns: rows.length > 0 ? Object.keys(rows[0]) : [],
            rows,
            count: fkR.data.total,
            total: fkR.data.total,
          });
        }
      }
    }
    return results;
  }

  static async exportTable(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    options: { filters?: RowFilters; limit?: number; format: 'csv' | 'json' },
  ) {
    const r = await ctx.db.getRows(table, { limit: options.limit ?? 1_000_000, filters: options.filters });
    if (!r.success) throw new Error(r.error ?? 'Failed to export table.');
    const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);

    if (options.format === 'json') {
      return { data: toJson(rows), contentType: 'application/json; charset=utf-8', filename: `${table}.json` };
    }
    return { data: toCsv(rows, columns), contentType: 'text/csv; charset=utf-8', filename: `${table}.csv` };
  }

  static async streamExportTable(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    options: { filters?: RowFilters; format: 'csv' | 'json'; chunkSize?: number },
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> {
    const chunkSize = Math.max(10, options.chunkSize ?? 500);
    const columns = info.columns.map((c) => c.name);
    const transform = options.format === 'json' ? createJsonStream() : createCsvStream(columns);

    (async () => {
      let page = 1;
      let hasMore = true;
      try {
        while (hasMore) {
          const r = await ctx.db.getRows(table, { limit: chunkSize, page, filters: options.filters });
          if (!r.success) {
            transform.destroy(new Error(r.error ?? 'Failed to stream rows.'));
            return;
          }
          const rows = (r.data ?? []) as Record<string, unknown>[];
          if (rows.length === 0) {
            hasMore = false;
            break;
          }
          for (const row of rows) {
            transform.write(normalizeRow(row));
          }
          if (rows.length < chunkSize) {
            hasMore = false;
          } else {
            page++;
          }
        }
        transform.end();
      } catch (err) {
        transform.destroy(err as Error);
      }
    })();

    const contentType = options.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';
    const filename = `${table}.${options.format}`;
    return { stream: transform, contentType, filename };
  }

  static async exportBulkRows(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    wheres: WhereClause[][],
    format: 'csv' | 'json',
  ) {
    const rowsR = await ctx.db.getRowsByPks(table, wheres);
    if (!rowsR.success) throw new Error(rowsR.error ?? 'Failed to load rows.');

    const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);

    if (format === 'json') {
      return { data: toJson(rows), contentType: 'application/json; charset=utf-8', filename: `${table}_selected.json` };
    }
    return { data: toCsv(rows, columns), contentType: 'text/csv; charset=utf-8', filename: `${table}_selected.csv` };
  }

  static async importCsv(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    csvText: string,
  ): Promise<number> {
    if (!csvText.trim()) throw new Error('No CSV data provided.');

    const parsed = parseCsv(csvText);
    if (!parsed.length) throw new Error('CSV file is empty.');

    const header = parsed[0].map((h) => h.trim());
    const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
    const validCols = header.filter((h) => typeMap.has(h));
    if (!validCols.length) {
      throw new Error('None of the CSV columns match columns in this table.');
    }

    const rows = parsed.slice(1).map((line) => {
      const fields: { column: string; value: unknown }[] = [];
      for (let i = 0; i < header.length; i++) {
        const col = header[i];
        if (!typeMap.has(col)) continue;
        fields.push({ column: col, value: coerceFormValue(line[i] ?? '', typeMap.get(col)!) });
      }
      return fields;
    });

    const r = await ctx.db.insertRows(table, rows);
    if (!r.success) throw new Error(r.error ?? 'Failed to import CSV.');
    return r.data?.inserted ?? 0;
  }

  static async streamImportCsv(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    csvStream: AsyncIterable<string | Buffer>,
    batchSize = 500,
  ): Promise<number> {
    const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
    let header: string[] | null = null;
    let totalInserted = 0;

    await parseCsvStreamBatched(
      csvStream,
      async (batch) => {
        let dataRows = batch;
        if (!header) {
          if (batch.length === 0) return;
          header = batch[0].map((h) => h.trim());
          dataRows = batch.slice(1);
        }
        if (dataRows.length === 0) return;

        const validColIndices = header
          .map((col, idx) => (typeMap.has(col) ? idx : -1))
          .filter((idx) => idx !== -1);

        if (!validColIndices.length) {
          throw new Error('None of the CSV columns match columns in this table.');
        }

        const rowsToInsert = dataRows.map((line) => {
          const fields: { column: string; value: unknown }[] = [];
          for (const i of validColIndices) {
            const col = header![i];
            fields.push({ column: col, value: coerceFormValue(line[i] ?? '', typeMap.get(col)!) });
          }
          return fields;
        });

        const r = await ctx.db.insertRows(table, rowsToInsert);
        if (!r.success) throw new Error(r.error ?? 'Failed to import CSV batch.');
        totalInserted += r.data?.inserted ?? rowsToInsert.length;
      },
      batchSize,
    );

    return totalInserted;
  }
}

