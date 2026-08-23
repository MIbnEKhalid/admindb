import type { Router } from 'express';
import { classifySql } from '../../sql/classifier';
import { analyzeSqlError } from '../../sql/error-analyzer';
import { normalizeRow } from '../../utils/common';
import { type ApiContext, ok, fail, wrap } from './helpers';

export function registerQueryRoutes(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  // ---- Query runner ------------------------------------------------------

  router.post('/api/query', wrap(async (req, res) => {
    const rawSql = String(req.body?.sql ?? '').trim();
    if (!rawSql) return fail(res, 'SQL query is required.');

    const { kind } = classifySql(rawSql);

    // Multi-statement script detection
    if (db.hasMultipleStatements(rawSql)) {
      if (db.isReadOnly) {
        return fail(res, 'Database is open in read-only mode — write statements are disabled.', 403);
      }
      const r = await db.execResult(rawSql);
      if (!r.success) {
        const details = await analyzeSqlError(rawSql, r.error ?? 'Script execution failed.', db);
        return fail(res, r.error ?? 'Query failed.', 400, details as unknown as Record<string, unknown>);
      }
      return ok(res, {
        kind: 'script',
        message: 'Script executed successfully.',
      });
    }

    if (kind === 'select' || kind === 'read' || kind === 'count') {
      const r = await db.all(rawSql);
      if (!r.success) {
        const details = await analyzeSqlError(rawSql, r.error ?? 'Query execution failed.', db);
        return fail(res, r.error ?? 'Query failed.', 400, details as unknown as Record<string, unknown>);
      }
      const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return ok(res, { kind: 'select', columns, rows });
    }

    // write statement
    if (db.isReadOnly) {
      return fail(res, 'Database is open in read-only mode — write statements are disabled.', 403);
    }
    const r = await db.runWrite(rawSql);
    if (!r.success) {
      const details = await analyzeSqlError(rawSql, r.error ?? 'Statement execution failed.', db);
      return fail(res, r.error ?? 'Query failed.', 400, details as unknown as Record<string, unknown>);
    }
    const changes = r.data?.changes as number | undefined;
    ok(res, {
      kind: 'write',
      changes: changes ?? null,
      message: changes != null ? `${changes} row(s) affected.` : 'Statement executed successfully.',
    });
  }));

  // ---- Saved queries -----------------------------------------------------

  router.get('/api/queries', wrap(async (_req, res) => {
    const r = await db.listSavedQueries();
    if (!r.success) return fail(res, r.error ?? 'Failed to load queries.', 500);
    ok(res, r.data);
  }));

  router.post('/api/queries', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const sql = String(req.body?.sql ?? '').trim();
    if (!name) return fail(res, 'Query name is required.');
    if (!sql) return fail(res, 'Query SQL is required.');
    const r = await db.saveQuery(name, sql);
    if (!r.success) return fail(res, r.error ?? 'Failed to save query.', 400);
    ok(res, { message: 'Query saved.' }, 201);
  }));

  router.delete('/api/queries/:id', wrap(async (req, res) => {
    const r = await db.deleteSavedQuery(req.params.id);
    if (!r.success) return fail(res, r.error ?? 'Failed to delete query.', 400);
    ok(res, { message: 'Query deleted.' });
  }));
}
