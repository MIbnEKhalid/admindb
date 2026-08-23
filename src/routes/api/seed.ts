import type { Router } from 'express';
import { quoteIdentifier } from '../../sql/generator';
import {
  buildColumnConfigs,
  buildSeedInsertSql,
  generateRows,
  getErChainConfig,
  generateChainRows,
  executeChainInsert,
  MAX_SEED_ROWS,
  type ErChainScope,
} from '../../data/index';
import {
  type ApiContext,
  ok,
  fail,
  wrap,
  requireTable,
  parseSeedRequest,
  parseChainSeedRequest,
} from './helpers';

export function registerSeedRoutes(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  // ---- Single Table Data generator / seeder ---------------------------------

  // Per-column generator config (strategies + detected defaults) for the "Seed data" page
  router.get('/api/tables/:table/seed/config', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, { table: req.params.table, columns: buildColumnConfigs(info), maxRows: MAX_SEED_ROWS });
  }));

  // Legacy alias for seed config
  router.get('/api/tables/:table/seed/plan', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, { table: req.params.table, columns: buildColumnConfigs(info), maxRows: MAX_SEED_ROWS });
  }));

  // Preview: generate the rows and return the INSERT statements without executing them
  router.post('/api/tables/:table/seed/generate', wrap(async (req, res) => {
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

  // Interactive grid preview
  router.post('/api/tables/:table/seed/preview', wrap(async (req, res) => {
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

  // Insert the generated rows inside a single transaction
  router.post('/api/tables/:table/seed', wrap(async (req, res) => {
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

  // ---- Advanced ER Chain Relational Seeder ---------------------------------

  // GET /api/tables/:table/seed/chain: Resolve ER chain graph & topological execution nodes
  router.get('/api/tables/:table/seed/chain', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const rawScope = String(req.query.scope ?? 'chain');
    const scope: ErChainScope =
      rawScope === 'ancestors' || rawScope === 'descendants' || rawScope === 'all' || rawScope === 'single'
        ? rawScope
        : 'chain';
    const config = await getErChainConfig(db, req.params.table, scope);
    ok(res, config);
  }));

  // POST /api/tables/:table/seed/chain/preview: Generate multi-table grid preview rows with FK propagation
  router.post('/api/tables/:table/seed/chain/preview', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans } = parseChainSeedRequest(req.body);
    const config = await getErChainConfig(db, req.params.table, scope);

    // Limit preview counts
    const previewCounts: Record<string, number> = {};
    for (const t of config.tables) {
      previewCounts[t.name] = Math.min(50, counts[t.name] ?? t.suggestedCount ?? 10);
    }

    const gen = await generateChainRows(db, config, plans, previewCounts);
    ok(res, gen);
  }));

  // POST /api/tables/:table/seed/chain/generate: Generate complete SQL script for the chain
  router.post('/api/tables/:table/seed/chain/generate', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans } = parseChainSeedRequest(req.body);
    const config = await getErChainConfig(db, req.params.table, scope);
    const gen = await generateChainRows(db, config, plans, counts);
    ok(res, gen);
  }));

  // POST /api/tables/:table/seed/chain: Execute atomic multi-table seeding with reverse-topological truncate
  router.post('/api/tables/:table/seed/chain', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const { scope, counts, plans, truncate } = parseChainSeedRequest(req.body);
    const config = await getErChainConfig(db, req.params.table, scope);
    const gen = await generateChainRows(db, config, plans, counts, truncate);
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

  // Global ER Chain Seed endpoints (for seeding from ER diagram or global DB tools)
  router.get('/api/seed/chain', wrap(async (req, res) => {
    const rawRoot = String(req.query.table ?? '');
    const rawScope = String(req.query.scope ?? (rawRoot ? 'chain' : 'all'));
    const scope: ErChainScope =
      rawScope === 'ancestors' || rawScope === 'descendants' || rawScope === 'all' || rawScope === 'single'
        ? rawScope
        : 'all';
    const rootTable = rawRoot || (await db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    const config = await getErChainConfig(db, rootTable, scope);
    ok(res, config);
  }));

  router.post('/api/seed/chain', wrap(async (req, res) => {
    const { scope, counts, plans, truncate } = parseChainSeedRequest(req.body);
    const rawRoot = String(req.body?.rootTable ?? '');
    const rootTable = rawRoot || (await db.listTables()).data?.[0]?.name || '';
    if (!rootTable) return fail(res, 'No tables found in database.', 404);
    const config = await getErChainConfig(db, rootTable, scope);
    const gen = await generateChainRows(db, config, plans, counts, truncate);
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

