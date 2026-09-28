import type { IDatabase, TableInfoData } from '../../db/index';
import type { DatabaseContext } from '../../core/context';
import { quoteIdentifier } from '../../sql/generator';
import { buildColumnConfigs, buildSeedInsertSql, generateRows, getErChainConfig, generateChainRows, executeChainInsert, MAX_SEED_ROWS, SeedEngine, validateGenerationPlan, sanitizeColumnPlan, type ColumnPlan, type ErChainScope, type GenerationPlan, type TableGenerationMode, type TableGenerationSpec, type RelationshipConfig } from '../../data/index';

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
      tables[tableName] = { mode, rows, columns, truncate: Boolean(spec.truncate)};
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

export class SeedService {
  static async validatePlan(ctx: DatabaseContext, plan: GenerationPlan) {
    return validateGenerationPlan(ctx.db, plan);
  }

  static async previewPlan(ctx: DatabaseContext, plan: GenerationPlan) {
    return SeedEngine.executePlan(ctx.db, plan, { previewLimit: 50 });
  }

  static async generatePlan(ctx: DatabaseContext, plan: GenerationPlan) {
    return SeedEngine.executePlan(ctx.db, plan);
  }

  static async executePlan(ctx: DatabaseContext, plan: GenerationPlan, truncate = false) {
    const gen = await SeedEngine.executePlan(ctx.db, plan, { truncateAll: truncate });
    const exec = await executeChainInsert(ctx.db, gen, truncate);
    return {
      message: `${truncate ? 'Cleared tables and seeded' : 'Seeded'} ${exec.totalInserted} row(s) across ${Object.keys(exec.inserted).length} table(s) in ${exec.elapsedMs}ms.`,
      inserted: exec.inserted,
      totalInserted: exec.totalInserted,
      elapsedMs: exec.elapsedMs,
      warnings: exec.warnings,
    };
  }

  static getSingleTableSeedConfig(info: TableInfoData) {
    return { table: info.table, columns: buildColumnConfigs(info), maxRows: MAX_SEED_ROWS };
  }

  static async previewSingleTable(
    ctx: DatabaseContext,
    info: TableInfoData,
    count: number,
    plan: Record<string, ColumnPlan>,
  ) {
    const configs = buildColumnConfigs(info);
    const gen = await generateRows(ctx.db, info, configs, Math.min(50, count), plan);
    return { table: info.table, previewRows: gen.previewRows, warnings: gen.warnings };
  }

  static async generateSingleTable(
    ctx: DatabaseContext,
    info: TableInfoData,
    count: number,
    plan: Record<string, ColumnPlan>,
  ) {
    const configs = buildColumnConfigs(info);
    const gen = await generateRows(ctx.db, info, configs, count, plan);
    return { table: info.table, count: gen.rows.length, sql: buildSeedInsertSql(info.table, gen.rows), previewRows: gen.previewRows, warnings: gen.warnings };
  }

  static async seedSingleTable(
    ctx: DatabaseContext,
    table: string,
    info: TableInfoData,
    count: number,
    plan: Record<string, ColumnPlan>,
    truncate: boolean,
  ) {
    const { db } = ctx;
    const configs = buildColumnConfigs(info);
    const t0 = Date.now();

    if (truncate) {
      const clearRes = await db.run(`DELETE FROM ${quoteIdentifier(table)}`);
      if (!clearRes.success) {
        throw new Error(clearRes.error ?? 'Failed to clear table before seeding.');
      }
    }

    const gen = await generateRows(db, info, configs, count, plan, truncate);
    const result = await db.insertRows(table, gen.rows);
    if (!result.success) throw new Error(result.error ?? 'Seed failed.');
    const elapsedMs = Date.now() - t0;

    return {
      message: `${truncate ? 'Cleared table and inserted' : 'Inserted'} ${result.data?.inserted ?? 0} row(s) in ${elapsedMs}ms.`,
      inserted: result.data?.inserted ?? 0,
      skipped: result.data?.skipped ?? 0,
      warnings: gen.warnings,
      elapsedMs,
    };
  }

  static async getChainConfig(ctx: DatabaseContext, table: string, scope: ErChainScope) {
    return getErChainConfig(ctx.db, table, scope);
  }

  static async previewChain(
    ctx: DatabaseContext,
    table: string,
    scope: ErChainScope,
    counts: Record<string, number>,
    plans: Record<string, Record<string, ColumnPlan>>,
    modes?: Record<string, TableGenerationMode>,
    seed?: number | null,
  ) {
    const config = await getErChainConfig(ctx.db, table, scope);
    const previewCounts: Record<string, number> = {};
    for (const t of config.tables) {
      previewCounts[t.name] = Math.min(50, counts[t.name] ?? t.suggestedCount ?? 10);
    }
    return generateChainRows(ctx.db, config, plans, previewCounts, false, modes, seed);
  }

  static async generateChain(
    ctx: DatabaseContext,
    table: string,
    scope: ErChainScope,
    counts: Record<string, number>,
    plans: Record<string, Record<string, ColumnPlan>>,
    modes?: Record<string, TableGenerationMode>,
    seed?: number | null,
  ) {
    const config = await getErChainConfig(ctx.db, table, scope);
    return generateChainRows(ctx.db, config, plans, counts, false, modes, seed);
  }

  static async executeChain(
    ctx: DatabaseContext,
    table: string,
    scope: ErChainScope,
    counts: Record<string, number>,
    plans: Record<string, Record<string, ColumnPlan>>,
    truncate: boolean,
    modes?: Record<string, TableGenerationMode>,
    seed?: number | null,
  ) {
    const config = await getErChainConfig(ctx.db, table, scope);
    const gen = await generateChainRows(ctx.db, config, plans, counts, truncate, modes, seed);
    const exec = await executeChainInsert(ctx.db, gen, truncate);
    return {
      message: `${truncate ? 'Cleared tables in reverse order and seeded' : 'Seeded'} ${exec.totalInserted} row(s) across ${Object.keys(exec.inserted).length} table(s) in ${exec.elapsedMs}ms.`,
      inserted: exec.inserted,
      totalInserted: exec.totalInserted,
      elapsedMs: exec.elapsedMs,
      warnings: exec.warnings,
    };
  }
}
