import type { Router } from 'express';
import { quoteIdentifier } from '../../sql/generator';
import { buildColumnConfigs, buildSeedInsertSql, generateRows, getErChainConfig, generateChainRows, executeChainInsert, MAX_SEED_ROWS, SeedEngine, validateGenerationPlan, type ErChainScope } from '../../data/index';
import { type ApiContext, ok, fail, wrap, requireTable, parseSeedRequest, parseChainSeedRequest, parseUnifiedGenerationPlan } from './helpers';

export function registerSeedRoutes(router: Router, ctx: ApiContext): void {
  // ---- Unified Generation Specification Endpoints -------------------------

  router.post('/api/seed/:db/validate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    ok(res, await validateGenerationPlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/preview', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    ok(res, await SeedEngine.executePlan(db, parseUnifiedGenerationPlan(req.body), { previewLimit: 50 }));
  }));

  router.post('/api/seed/:db/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    ok(res, await SeedEngine.executePlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/execute', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const plan = parseUnifiedGenerationPlan(req.body);
    const truncate = Boolean(req.body?.truncate || plan.options?.truncateAll);
    const gen = await SeedEngine.executePlan(db, plan, { truncateAll: truncate });
    const exec = await executeChainInsert(db, gen, truncate);
    ok(
      res,
      {
        message: `${truncate ? 'Cleared tables and seeded' : 'Seeded'} ${exec.totalInserted} row(s) across ${Object.keys(exec.inserted).length} table(s) in ${exec.elapsedMs}ms.`,
        inserted: exec.inserted,
        totalInserted: exec.totalInserted,
        elapsedMs: exec.elapsedMs,
        warnings: exec.warnings,
      },
      201,
    );
  }));

  // ---- Single Table Data generator / seeder ---------------------------------

  const getSeedConfigHandler = wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, { table: req.params.table, columns: buildColumnConfigs(info), maxRows: MAX_SEED_ROWS });
  });

  router.get('/api/tables/:db/:table/seed/config', getSeedConfigHandler);
  router.get('/api/tables/:db/:table/seed/plan', getSeedConfigHandler);

  router.post('/api/tables/:db/:table/seed/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan } = parseSeedRequest(req.body);
    const configs = buildColumnConfigs(info);
    const gen = await generateRows(db, info, configs, count, plan);
    ok(res, {
      table: req.params.table,
      count: gen.rows.length,
      sql: buildSeedInsertSql(req.params.table, gen.rows),
      previewRows: gen.previewRows,
      warnings: gen.warnings,
    });
  }));

  router.post('/api/tables/:db/:table/seed/preview', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan } = parseSeedRequest(req.body);
    const configs = buildColumnConfigs(info);
    const gen = await generateRows(db, info, configs, Math.min(50, count), plan);
    ok(res, {
      table: req.params.table,
      previewRows: gen.previewRows,
      warnings: gen.warnings,
    });
  }));

  router.post('/api/tables/:db/:table/seed', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan, truncate } = parseSeedRequest(req.body);
    const configs = buildColumnConfigs(info);
    const t0 = Date.now();

    if (truncate) {
      const clearRes = await db.run(`DELETE FROM ${quoteIdentifier(req.params.table)}`);
      if (!clearRes.success) {
        return fail(res, clearRes.error ?? 'Failed to clear table before seeding.', 400);
      }
    }

    const gen = await generateRows(db, info, configs, count, plan, truncate);
    const result = await db.insertRows(req.params.table, gen.rows);
    if (!result.success) return fail(res, result.error ?? 'Seed failed.', 400);
    const elapsedMs = Date.now() - t0;
    ok(
      res,
      {
        message: `${truncate ? 'Cleared table and inserted' : 'Inserted'} ${result.data?.inserted ?? 0} row(s) in ${elapsedMs}ms.`,
        inserted: result.data?.inserted ?? 0,
        skipped: result.data?.skipped ?? 0,
        warnings: gen.warnings,
        elapsedMs,
      },
      201,
    );
  }));

  // ---- Advanced ER Chain Relational Seeder ----------------------------------

  router.get('/api/tables/:db/:table/seed/chain', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const rawScope = String(req.query.scope ?? 'chain');
    const scope: ErChainScope =
      rawScope === 'ancestors' || rawScope === 'descendants' || rawScope === 'all' || rawScope === 'single'
        ? rawScope
        : 'chain';
    ok(res, await getErChainConfig(db, req.params.table, scope));
  }));

  router.post('/api/tables/:db/:table/seed/chain/preview', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, modes, seed } = parseChainSeedRequest(req.body);
    const config = await getErChainConfig(db, req.params.table, scope);

    const previewCounts: Record<string, number> = {};
    for (const t of config.tables) {
      previewCounts[t.name] = Math.min(50, counts[t.name] ?? t.suggestedCount ?? 10);
    }

    ok(res, await generateChainRows(db, config, plans, previewCounts, false, modes, seed));
  }));

  router.post('/api/tables/:db/:table/seed/chain/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, modes, seed } = parseChainSeedRequest(req.body);
    const config = await getErChainConfig(db, req.params.table, scope);
    ok(res, await generateChainRows(db, config, plans, counts, false, modes, seed));
  }));

  router.post('/api/tables/:db/:table/seed/chain', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, truncate, modes, seed } = parseChainSeedRequest(req.body);
    const config = await getErChainConfig(db, req.params.table, scope);
    const gen = await generateChainRows(db, config, plans, counts, truncate, modes, seed);
    const exec = await executeChainInsert(db, gen, truncate);
    ok(
      res,
      {
        message: `${truncate ? 'Cleared tables in reverse order and seeded' : 'Seeded'} ${exec.totalInserted} row(s) across ${Object.keys(exec.inserted).length} table(s) in ${exec.elapsedMs}ms.`,
        inserted: exec.inserted,
        totalInserted: exec.totalInserted,
        elapsedMs: exec.elapsedMs,
        warnings: exec.warnings,
      },
      201,
    );
  }));

  router.get('/api/seed/:db/chain', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const rawRoot = String(req.query.table ?? '');
    const rawScope = String(req.query.scope ?? (rawRoot ? 'chain' : 'all'));
    const scope: ErChainScope =
      rawScope === 'ancestors' || rawScope === 'descendants' || rawScope === 'all' || rawScope === 'single'
        ? rawScope
        : 'all';
    const rootTable = rawRoot || (await db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    ok(res, await getErChainConfig(db, rootTable, scope));
  }));

  router.post('/api/seed/:db/chain', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const { scope, counts, plans, truncate, modes, seed } = parseChainSeedRequest(req.body);
    const rawRoot = String(req.body?.rootTable ?? '');
    const rootTable = rawRoot || (await db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    const config = await getErChainConfig(db, rootTable, scope);
    const gen = await generateChainRows(db, config, plans, counts, truncate, modes, seed);
    const exec = await executeChainInsert(db, gen, truncate);
    ok(
      res,
      {
        message: `${truncate ? 'Cleared tables in reverse order and seeded' : 'Seeded'} ${exec.totalInserted} row(s) across ${Object.keys(exec.inserted).length} table(s) in ${exec.elapsedMs}ms.`,
        inserted: exec.inserted,
        totalInserted: exec.totalInserted,
        elapsedMs: exec.elapsedMs,
        warnings: exec.warnings,
      },
      201,
    );
  }));
}
