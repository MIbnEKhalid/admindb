import type { Router, Request, Response, NextFunction } from 'express';
import { type RouteContext, type RequestParams, ok, fail, wrap, initPageLocals } from '../../core/router';
import { TableService } from '../tables/tables.service';
import { QueryService, QueryExecutionError } from './query.service';

export function registerQueryRoutes(router: Router, ctx: RouteContext): void {
  // ---- Page Routes -------------------------------------------------------

  router.get('/query/:db', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      res.render('pages/query', { title: 'Query editor', dbId });
    } catch (err) {
      next(err);
    }
  });

  // ---- API Routes --------------------------------------------------------

  router.post('/api/query/:db', wrap(async (req, res) => {
    const db = ctx.getContext(req);
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

  router.post('/api/query/:db/export', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const sql = String(req.body?.sql ?? '').trim();
    const format = String(req.body?.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    if (!sql) return fail(res, 'SQL query is required.');

    try {
      const exp = await QueryService.streamExportQuery(db, sql, format);
      res.setHeader('Content-Type', exp.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
      exp.stream.pipe(res);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Query failed.', 400);
    }
  }));
}
