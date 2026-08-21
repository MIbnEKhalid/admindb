import type { Router } from 'express';
import { quoteIdentifier } from '../../sql/generator';
import {
  buildColumnConfigs,
  buildSeedInsertSql,
  generateRows,
  MAX_SEED_ROWS,
} from '../../data/index';
import { type ApiContext, ok, fail, wrap, requireTable, parseSeedRequest } from './helpers';

export function registerSeedRoutes(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  // ---- Data generator / seeder ------------------------------------------

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

    const gen = await generateRows(db, info, configs, count, plan);
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
}
