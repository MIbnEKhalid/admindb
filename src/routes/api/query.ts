import type { Router } from 'express';
import { type ApiContext, ok, fail, wrap } from './helpers';
import { QueryService, QueryExecutionError } from '../../modules/query/index';

export function registerQueryRoutes(router: Router, ctx: ApiContext): void {
  // ---- Query runner ------------------------------------------------------

  router.post('/api/query/:db', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const rawSql = String(req.body?.sql ?? '').trim();
    if (!rawSql) return fail(res, 'SQL query is required.');

    try {
      const result = await QueryService.execute(db, rawSql);
      ok(res, result);
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        return fail(res, err.message, err.statusCode, err.details as unknown as Record<string, unknown>);
      }
      fail(res, (err as Error).message ?? 'Query failed.', 500);
    }
  }));

  // ---- Saved queries -----------------------------------------------------

  router.get('/api/queries/:db', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    try {
      const queries = await QueryService.listSavedQueries(db);
      ok(res, queries);
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        return fail(res, err.message, err.statusCode);
      }
      fail(res, (err as Error).message ?? 'Failed to load queries.', 500);
    }
  }));

  router.post('/api/queries/:db', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const name = String(req.body?.name ?? '').trim();
    const sql = String(req.body?.sql ?? '').trim();
    if (!name) return fail(res, 'Query name is required.');
    if (!sql) return fail(res, 'Query SQL is required.');
    try {
      const result = await QueryService.saveQuery(db, name, sql);
      ok(res, result, 201);
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        return fail(res, err.message, err.statusCode);
      }
      fail(res, (err as Error).message ?? 'Failed to save query.', 400);
    }
  }));

  router.delete('/api/queries/:db/:id', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    try {
      const result = await QueryService.deleteSavedQuery(db, req.params.id);
      ok(res, result);
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        return fail(res, err.message, err.statusCode);
      }
      fail(res, (err as Error).message ?? 'Failed to delete query.', 400);
    }
  }));
}
