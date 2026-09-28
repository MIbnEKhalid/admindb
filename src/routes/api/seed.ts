import type { Router } from 'express';
import { type ApiContext, ok, fail, wrap, requireTable } from './helpers';
import { SeedService, parseSeedRequest, parseChainSeedRequest, parseUnifiedGenerationPlan } from '../../modules/seed/index';
import type { ErChainScope } from '../../data/index';

export function registerSeedRoutes(router: Router, ctx: ApiContext): void {
  // ---- Unified Generation Specification Endpoints -------------------------

  router.post('/api/seed/:db/validate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    ok(res, await SeedService.validatePlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/preview', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    ok(res, await SeedService.previewPlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    ok(res, await SeedService.generatePlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/execute', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const plan = parseUnifiedGenerationPlan(req.body);
    const truncate = Boolean(req.body?.truncate || plan.options?.truncateAll);
    const result = await SeedService.executePlan(db, plan, truncate);
    ok(res, result, 201);
  }));

  // ---- Single Table Data generator / seeder ---------------------------------

  const getSeedConfigHandler = wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, SeedService.getSingleTableSeedConfig(info));
  });

  router.get('/api/tables/:db/:table/seed/config', getSeedConfigHandler);
  router.get('/api/tables/:db/:table/seed/plan', getSeedConfigHandler);

  router.post('/api/tables/:db/:table/seed/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan } = parseSeedRequest(req.body);
    ok(res, await SeedService.generateSingleTable(db, info, count, plan));
  }));

  router.post('/api/tables/:db/:table/seed/preview', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan } = parseSeedRequest(req.body);
    ok(res, await SeedService.previewSingleTable(db, info, count, plan));
  }));

  router.post('/api/tables/:db/:table/seed', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan, truncate } = parseSeedRequest(req.body);
    try {
      const result = await SeedService.seedSingleTable(db, req.params.table, info, count, plan, truncate);
      ok(res, result, 201);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Seed failed.', 400);
    }
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
    ok(res, await SeedService.getChainConfig(db, req.params.table, scope));
  }));

  router.post('/api/tables/:db/:table/seed/chain/preview', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, modes, seed } = parseChainSeedRequest(req.body);
    ok(res, await SeedService.previewChain(db, req.params.table, scope, counts, plans, modes, seed));
  }));

  router.post('/api/tables/:db/:table/seed/chain/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, modes, seed } = parseChainSeedRequest(req.body);
    ok(res, await SeedService.generateChain(db, req.params.table, scope, counts, plans, modes, seed));
  }));

  router.post('/api/tables/:db/:table/seed/chain', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, truncate, modes, seed } = parseChainSeedRequest(req.body);
    const result = await SeedService.executeChain(db, req.params.table, scope, counts, plans, truncate, modes, seed);
    ok(res, result, 201);
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
    ok(res, await SeedService.getChainConfig(db, rootTable, scope));
  }));

  router.post('/api/seed/:db/chain', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const { scope, counts, plans, truncate, modes, seed } = parseChainSeedRequest(req.body);
    const rawRoot = String(req.body?.rootTable ?? '');
    const rootTable = rawRoot || (await db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    const result = await SeedService.executeChain(db, rootTable, scope, counts, plans, truncate, modes, seed);
    ok(res, result, 201);
  }));
}
