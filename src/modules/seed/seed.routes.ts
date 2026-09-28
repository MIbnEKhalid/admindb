import type { Router, Request, Response, NextFunction } from 'express';
import { type RouteContext, ok, fail, wrap, notFound, initPageLocals } from '../../core/router';
import { TableService } from '../tables/tables.service';
import { RowsService } from '../rows/rows.service';
import { buildColumnConfigs, MAX_SEED_ROWS, type ErChainScope } from '../../data/index';
import {
  SeedService,
  parseSeedRequest,
  parseChainSeedRequest,
  parseUnifiedGenerationPlan,
} from './seed.service';

export function registerSeedRoutes(router: Router, ctx: RouteContext): void {
  // ---- Page Routes -------------------------------------------------------

  router.get('/seed/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      const { tables: tableNames } = initPageLocals(res, db, dbId, allNames);

      if (tableNames.length === 0) {
        return res.render('pages/seed-select', {
          title: 'Seed Data Generator',
          dbId,
          tables: tableNames,
          seedTables: [],
          hasTables: false,
          dialect: db.dialect.name,
        });
      }

      const tableStats = await Promise.all(
        tableNames.map(async (name) => {
          const [info, rowCount] = await Promise.all([
            TableService.getTableInfo(db, name),
            RowsService.getRowCount(db, name),
          ]);
          const cols = info ? info.columns.length : 0;
          const fks = info ? info.foreignKeys.length : 0;
          return {
            name,
            cols,
            fks,
            rowCount,
          };
        }),
      );

      const defaultTable = req.query.table ? String(req.query.table) : tableStats[0]?.name;
      const defaultMode = req.query.mode === 'chain' ? 'chain' : 'single';

      res.render('pages/seed-select', {
        title: 'Seed Data Generator · Choose Table & Mode',
        dbId,
        tables: tableNames,
        seedTables: tableStats,
        hasTables: true,
        defaultTable,
        defaultMode,
        dialect: db.dialect.name,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/seed/:db/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      const { tables: allTables } = initPageLocals(res, db, dbId, allNames);

      const initialMode = req.query.mode === 'chain' ? 'chain' : 'single';
      const [info, rowCount] = await Promise.all([
        TableService.getTableInfo(db, table),
        RowsService.getRowCount(db, table),
      ]);
      if (!info) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const columns = buildColumnConfigs(info);
      res.locals.currentTable = table;
      res.render('pages/seed', {
        title: `Seed data · ${table}`,
        dbId,
        table,
        allTables,
        mode: initialMode,
        isChainMode: initialMode === 'chain',
        rowCount,
        colCount: info.columns.length,
        maxRows: MAX_SEED_ROWS,
        quickCounts: [10, 50, 100, 500, 1000, MAX_SEED_ROWS],
        seedConfig: { dbId, table, columns, rowCount, maxRows: MAX_SEED_ROWS, mode: initialMode },
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Unified Generation Specification Endpoints -------------------------

  router.post('/api/seed/:db/validate', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    ok(res, await SeedService.validatePlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/preview', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    ok(res, await SeedService.previewPlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/generate', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    ok(res, await SeedService.generatePlan(db, parseUnifiedGenerationPlan(req.body)));
  }));

  router.post('/api/seed/:db/execute', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const plan = parseUnifiedGenerationPlan(req.body);
    const truncate = Boolean(req.body?.truncate || plan.options?.truncateAll);
    const result = await SeedService.executePlan(db, plan, truncate);
    ok(res, result, 201);
  }));

  // ---- Single Table Data generator / seeder ---------------------------------

  const getSeedConfigHandler = wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, SeedService.getSingleTableSeedConfig(info));
  });

  router.get('/api/tables/:db/:table/seed/config', getSeedConfigHandler);
  router.get('/api/tables/:db/:table/seed/plan', getSeedConfigHandler);

  router.post('/api/tables/:db/:table/seed/generate', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan } = parseSeedRequest(req.body);
    ok(res, await SeedService.generateSingleTable(db, info, count, plan));
  }));

  router.post('/api/tables/:db/:table/seed/preview', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { count, plan } = parseSeedRequest(req.body);
    ok(res, await SeedService.previewSingleTable(db, info, count, plan));
  }));

  router.post('/api/tables/:db/:table/seed', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const rawScope = String(req.query.scope ?? 'chain');
    const scope: ErChainScope =
      rawScope === 'ancestors' || rawScope === 'descendants' || rawScope === 'all' || rawScope === 'single'
        ? rawScope
        : 'chain';
    ok(res, await SeedService.getChainConfig(db, req.params.table, scope));
  }));

  router.post('/api/tables/:db/:table/seed/chain/preview', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, modes, seed } = parseChainSeedRequest(req.body);
    ok(res, await SeedService.previewChain(db, req.params.table, scope, counts, plans, modes, seed));
  }));

  router.post('/api/tables/:db/:table/seed/chain/generate', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, modes, seed } = parseChainSeedRequest(req.body);
    ok(res, await SeedService.generateChain(db, req.params.table, scope, counts, plans, modes, seed));
  }));

  router.post('/api/tables/:db/:table/seed/chain', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, truncate, modes, seed } = parseChainSeedRequest(req.body);
    const result = await SeedService.executeChain(db, req.params.table, scope, counts, plans, truncate, modes, seed);
    ok(res, result, 201);
  }));

  router.get('/api/seed/:db/chain', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const rawRoot = String(req.query.table ?? '');
    const rawScope = String(req.query.scope ?? (rawRoot ? 'chain' : 'all'));
    const scope: ErChainScope =
      rawScope === 'ancestors' || rawScope === 'descendants' || rawScope === 'all' || rawScope === 'single'
        ? rawScope
        : 'all';
    const rootTable = rawRoot || (await db.db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    ok(res, await SeedService.getChainConfig(db, rootTable, scope));
  }));

  router.post('/api/seed/:db/chain', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const { scope, counts, plans, truncate, modes, seed } = parseChainSeedRequest(req.body);
    const rawRoot = String(req.body?.rootTable ?? '');
    const rootTable = rawRoot || (await db.db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    const result = await SeedService.executeChain(db, rootTable, scope, counts, plans, truncate, modes, seed);
    ok(res, result, 201);
  }));
}
