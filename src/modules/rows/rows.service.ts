import type { IDatabase, TableInfoData, WhereClause, RowFilters, SQLInputValue } from '../../db/index';
import { coerceFormValue, decodePk, normalizeRow } from '../../utils/common';
import { toCsv, toJson, parseCsv } from '../../utils/csv';
import { generateInsert, generateUpdate, quoteIdentifier } from '../../sql/generator';
import { resolveBlobBuffer, parseBlobPayload, getBlobMetadata, sniffBlobMime } from './blob.helper';

export const MAX_BULK_ROWS = 1000;

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
  db: IDatabase,
  info: TableInfoData,
  wheres: WhereClause[][],
): Promise<BulkImpactResult> {
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

export class RowsService {
  static async getPaginatedRows(
    db: IDatabase,
    table: string,
    options: {
      page?: number;
      limit?: number;
      orderBy?: string;
      orderDir?: 'asc' | 'desc';
      filters?: RowFilters;
    } = {},
  ) {
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
    return {
      rows,
      total: totalR.success ? totalR.data : rows.length,
      page,
      limit,
    };
  }

  static async getRowCount(db: IDatabase, table: string, filters?: RowFilters) {
    const r = await db.getRowCount(table, filters);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to count rows.');
    }
    return r.data;
  }

  static async getRow(db: IDatabase, table: string, where: WhereClause[]) {
    const r = await db.getRow(table, where);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to load row.');
    }
    return r.data ? normalizeRow(r.data) : null;
  }

  static async getBlob(db: IDatabase, table: string, where: WhereClause[], column: string) {
    const r = await db.getRow(table, where);
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

  static async getBlobMeta(db: IDatabase, table: string, where: WhereClause[], column: string) {
    const r = await db.getRow(table, where);
    if (!r.success) {
      throw new Error(r.error ?? 'Failed to load row.');
    }
    if (!r.data) return null;

    const rawVal = r.data[column];
    return getBlobMetadata(rawVal);
  }

  static async updateBlob(
    db: IDatabase,
    table: string,
    where: WhereClause[],
    column: string,
    data: unknown,
    format?: string,
  ): Promise<number> {
    const buf = parseBlobPayload(data, format);
    const updateRes = await db.updateRow(table, [{ column, value: buf }], where);
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
    db: IDatabase,
    table: string,
    fields: { column: string; value: unknown }[],
  ) {
    if (!fields.length) throw new Error('No valid column values provided.');
    const r = await db.insertRow(table, fields);
    if (!r.success) throw new Error(r.error ?? 'Failed to insert row.');
    return r.data?.lastInsertRowid;
  }

  static async insertRows(
    db: IDatabase,
    table: string,
    fieldsList: { column: string; value: unknown }[][],
  ) {
    if (!fieldsList.length) throw new Error('No rows provided.');
    const r = await db.insertRows(table, fieldsList);
    if (!r.success) throw new Error(r.error ?? 'Failed to insert rows.');
    return r.data?.inserted ?? 0;
  }

  static async updateRow(
    db: IDatabase,
    table: string,
    fields: { column: string; value: unknown }[],
    where: WhereClause[],
  ) {
    if (!fields.length) throw new Error('No fields to update.');
    const r = await db.updateRow(table, fields, where);
    if (!r.success) throw new Error(r.error ?? 'Failed to update row.');
  }

  static async updateRows(
    db: IDatabase,
    table: string,
    rowUpdates: { fields: WhereClause[]; where: WhereClause[] }[],
  ) {
    if (!rowUpdates.length) return 0;
    const r = await db.updateRows(table, rowUpdates);
    if (!r.success) throw new Error(r.error ?? 'Failed to update rows.');
    return r.data?.updated ?? 0;
  }

  static async deleteRow(db: IDatabase, table: string, where: WhereClause[]) {
    const r = await db.deleteRow(table, where);
    if (!r.success) throw new Error(r.error ?? 'Failed to delete row.');
  }

  static async deleteRows(db: IDatabase, table: string, wheres: WhereClause[][]) {
    const r = await db.deleteRows(table, wheres);
    if (!r.success) throw new Error(r.error ?? 'Failed to delete rows.');
    return r.data?.deleted ?? 0;
  }

  static async getRowReferences(
    db: IDatabase,
    table: string,
    info: TableInfoData,
    where: WhereClause[],
  ): Promise<RowReferenceResult[]> {
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
    db: IDatabase,
    table: string,
    info: TableInfoData,
    options: { filters?: RowFilters; limit?: number; format: 'csv' | 'json' },
  ) {
    const r = await db.getRows(table, { limit: options.limit ?? 1_000_000, filters: options.filters });
    if (!r.success) throw new Error(r.error ?? 'Failed to export table.');
    const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);

    if (options.format === 'json') {
      return { data: toJson(rows), contentType: 'application/json; charset=utf-8', filename: `${table}.json` };
    }
    return { data: toCsv(rows, columns), contentType: 'text/csv; charset=utf-8', filename: `${table}.csv` };
  }

  static async exportBulkRows(
    db: IDatabase,
    table: string,
    info: TableInfoData,
    wheres: WhereClause[][],
    format: 'csv' | 'json',
  ) {
    const rowsR = await db.getRowsByPks(table, wheres);
    if (!rowsR.success) throw new Error(rowsR.error ?? 'Failed to load rows.');

    const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);

    if (format === 'json') {
      return { data: toJson(rows), contentType: 'application/json; charset=utf-8', filename: `${table}_selected.json` };
    }
    return { data: toCsv(rows, columns), contentType: 'text/csv; charset=utf-8', filename: `${table}_selected.csv` };
  }

  static async importCsv(
    db: IDatabase,
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

    const r = await db.insertRows(table, rows);
    if (!r.success) throw new Error(r.error ?? 'Failed to import CSV.');
    return r.data?.inserted ?? 0;
  }
}
