import type { Request, Response } from 'express';
import type { SqliteDatabase, TableInfoData, WhereClause, SQLInputValue } from '../../db/database';
import type { Logger } from '../../utils/logger';
import { coerceFormValue, decodePk, errorMessage } from '../../utils/common';
import { sanitizeColumnPlan, MAX_SEED_ROWS, type ColumnPlan } from '../../data/index';
import { quoteIdentifier } from '../../sql/generator';

export interface ApiContext {
  db: SqliteDatabase;
  logger: Logger;
}

export function ok(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

export function fail(res: Response, error: string, status = 400): Response {
  return res.status(status).json({ success: false, error });
}

export function wrap(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, errorMessage(err), 500);
    }
  };
}

export async function requireTable(db: SqliteDatabase, table: string): Promise<TableInfoData | null> {
  const info = await db.getTableInfo(table);
  if (!info.success || !info.data || info.data.columns.length === 0) return null;
  return info.data;
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

export function pkWhere(info: TableInfoData, encodedId: string): { column: string; value: unknown }[] | null {
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

export const MAX_BULK_ROWS = 1000;

export function parseSeedRequest(body: unknown): { count: number; plan: Record<string, ColumnPlan>; truncate: boolean } {
  const b = (body ?? {}) as { count?: unknown; plan?: unknown; truncate?: unknown };
  const count = Math.max(1, Math.min(MAX_SEED_ROWS, Number.parseInt(String(b.count ?? '10'), 10) || 10));
  const truncate = Boolean(b.truncate);
  const plan: Record<string, ColumnPlan> = {};
  if (b.plan && typeof b.plan === 'object') {
    for (const [k, v] of Object.entries(b.plan as Record<string, unknown>)) {
      const p = sanitizeColumnPlan(v);
      if (p) plan[k] = p;
    }
  }
  return { count, plan, truncate };
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
  db: SqliteDatabase,
  info: TableInfoData,
  wheres: WhereClause[][],
): Promise<{ references: { table: string; from: string; to: string; count: number }[]; total: number }> {
  const [rowsR, refInfoR] = await Promise.all([
    db.getRowsByPks(info.table, wheres),
    db.getReferencingTables(info.table),
  ]);

  const rows = (rowsR.data ?? []) as Record<string, unknown>[];
  const referencing = refInfoR.data ?? [];
  if (!rows.length || !referencing.length) return { references: [], total: 0 };

  const queries = referencing.flatMap((item) =>
    item.refs.map(async (ref) => {
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
  const total = results.reduce((acc, r) => acc + r.count, 0);
  return { references: results, total };
}
