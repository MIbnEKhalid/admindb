import type { Request, Response } from 'express';
import type { IDatabase, TableInfoData, WhereClause, SQLInputValue } from '../../db/index';
import type { Logger } from '../../utils/logger';
import { coerceFormValue, decodePk, errorMessage } from '../../utils/common';
import { sanitizeColumnPlan, MAX_SEED_ROWS, type ColumnPlan, type ErChainScope, type GenerationPlan, type TableGenerationMode, type TableGenerationSpec, type RelationshipConfig } from '../../data/index';
import { quoteIdentifier } from '../../sql/generator';

export interface ApiContext {
  getDb: (req: Request) => IDatabase;
  logger: Logger;
}

export const ok = (res: Response, data: unknown, status = 200): Response =>
  res.status(status).json({ success: true, data });

export const fail = (res: Response, error: string, status = 400, details?: Record<string, unknown> | null): Response =>
  res.status(status).json({ success: false, error, ...(details ? { details } : {}) });

export const wrap = (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, errorMessage(err), 500);
    }
  };

export async function requireTable(db: IDatabase, table: string): Promise<TableInfoData | null> {
  const info = await db.getTableInfo(table);
  return info.success && info.data?.columns?.length ? info.data : null;
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

export function parseSeedRequest(body: unknown): { count: number; plan: Record<string, ColumnPlan>; truncate: boolean; seed?: number | null } {
  const b = (body ?? {}) as { count?: unknown; plan?: unknown; truncate?: unknown; seed?: unknown };
  const count = Math.max(1, Math.min(MAX_SEED_ROWS, Number.parseInt(String(b.count ?? '10'), 10) || 10));
  const truncate = Boolean(b.truncate);
  const seed = b.seed != null && b.seed !== '' ? Number(b.seed) : null;
  const plan: Record<string, ColumnPlan> = {};
  if (b.plan && typeof b.plan === 'object') {
    for (const [k, v] of Object.entries(b.plan as Record<string, unknown>)) {
      const p = sanitizeColumnPlan(v);
      if (p) plan[k] = p;
    }
  }
  return { count, plan, truncate, seed };
}

export function parseChainSeedRequest(body: unknown): {
  scope: ErChainScope;
  counts: Record<string, number>;
  plans: Record<string, Record<string, ColumnPlan>>;
  truncate: boolean;
  modes?: Record<string, TableGenerationMode>;
  seed?: number | null;
} {
  const b = (body ?? {}) as {
    scope?: unknown;
    counts?: unknown;
    plans?: unknown;
    truncate?: unknown;
    modes?: unknown;
    seed?: unknown;
  };
  const scope: ErChainScope =
    b.scope === 'ancestors' || b.scope === 'descendants' || b.scope === 'all' || b.scope === 'single'
      ? b.scope
      : 'chain';
  const truncate = Boolean(b.truncate);
  const seed = b.seed != null && b.seed !== '' ? Number(b.seed) : null;
  const counts: Record<string, number> = {};
  if (b.counts && typeof b.counts === 'object') {
    for (const [table, rawN] of Object.entries(b.counts as Record<string, unknown>)) {
      const n = Number.parseInt(String(rawN), 10);
      if (Number.isFinite(n) && n > 0) counts[table] = Math.min(2000, n);
    }
  }
  const modes: Record<string, TableGenerationMode> = {};
  if (b.modes && typeof b.modes === 'object') {
    for (const [table, rawM] of Object.entries(b.modes as Record<string, unknown>)) {
      const m = String(rawM);
      if (m === 'generate' || m === 'use_existing' || m === 'generate_if_empty' || m === 'skip') {
        modes[table] = m;
      }
    }
  }
  const plans: Record<string, Record<string, ColumnPlan>> = {};
  if (b.plans && typeof b.plans === 'object') {
    for (const [table, tablePlans] of Object.entries(b.plans as Record<string, unknown>)) {
      if (tablePlans && typeof tablePlans === 'object') {
        const pMap: Record<string, ColumnPlan> = {};
        for (const [col, v] of Object.entries(tablePlans as Record<string, unknown>)) {
          const p = sanitizeColumnPlan(v);
          if (p) pMap[col] = p;
        }
        plans[table] = pMap;
      }
    }
  }
  return { scope, counts, plans, truncate, modes, seed };
}

export function parseUnifiedGenerationPlan(body: unknown): GenerationPlan {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawPlan = (b.plan && typeof b.plan === 'object' ? b.plan : b) as Record<string, unknown>;

  const tables: Record<string, TableGenerationSpec> = {};
  if (rawPlan.tables && typeof rawPlan.tables === 'object') {
    for (const [tableName, rawSpec] of Object.entries(rawPlan.tables as Record<string, unknown>)) {
      if (!rawSpec || typeof rawSpec !== 'object') continue;
      const spec = rawSpec as Record<string, unknown>;
      const rawMode = String(spec.mode || 'generate');
      const mode: TableGenerationMode =
        rawMode === 'use_existing' || rawMode === 'generate_if_empty' || rawMode === 'skip' ? rawMode : 'generate';
      const rows = Math.max(1, Math.min(MAX_SEED_ROWS, Number.parseInt(String(spec.rows ?? '10'), 10) || 10));
      const columns: Record<string, ColumnPlan> = {};
      if (spec.columns && typeof spec.columns === 'object') {
        for (const [colName, rawColPlan] of Object.entries(spec.columns as Record<string, unknown>)) {
          const sanitized = sanitizeColumnPlan(rawColPlan);
          if (sanitized) columns[colName] = sanitized;
        }
      }
      tables[tableName] = {
        mode,
        rows,
        columns,
        truncate: Boolean(spec.truncate),
      };
    }
  }

  const rawSeed = b.seed !== undefined ? b.seed : (rawPlan.options as Record<string, unknown> | undefined)?.seed;
  const seed = rawSeed != null && rawSeed !== '' ? Number(rawSeed) : null;

  return {
    name: typeof rawPlan.name === 'string' ? rawPlan.name : undefined,
    description: typeof rawPlan.description === 'string' ? rawPlan.description : undefined,
    rootTable: typeof rawPlan.rootTable === 'string' ? rawPlan.rootTable : undefined,
    scope: (rawPlan.scope as ErChainScope) || 'chain',
    tables,
    relationships: Array.isArray(rawPlan.relationships) ? (rawPlan.relationships as RelationshipConfig[]) : undefined,
    options: {
      seed: Number.isFinite(seed) ? seed : null,
      transaction: rawPlan.options ? Boolean((rawPlan.options as Record<string, unknown>).transaction ?? true) : true,
      rollbackOnError: rawPlan.options ? Boolean((rawPlan.options as Record<string, unknown>).rollbackOnError ?? true) : true,
      truncateAll: Boolean(b.truncate || (rawPlan.options as Record<string, unknown> | undefined)?.truncateAll),
      batchSize: Number((rawPlan.options as Record<string, unknown> | undefined)?.batchSize ?? 500) || 500,
    },
  };
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
): Promise<{ references: { table: string; from: string; to: string; count: number }[]; total: number }> {
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
