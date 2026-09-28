import type { Router, Request, Response } from 'express';
import { parseFilters } from '../../utils/common';
import { type ApiContext, ok, fail, wrap, requireTable } from './helpers';
import { RowsService } from '../../modules/rows/index';
import { QueryService } from '../../modules/query/index';

export function registerImportExportRoutes(router: Router, ctx: ApiContext): void {
  router.get('/api/tables/:db/:table/export', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const format = String(req.query.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const filters = parseFilters(req.query.f);

    try {
      const exp = await RowsService.exportTable(db, req.params.table, info, { filters, format });
      res.setHeader('Content-Type', exp.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
      res.send(exp.data);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to export table.');
    }
  }));

  const importCsvHandler = wrap(async (req: Request, res: Response) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const csvText = typeof req.body === 'string' ? req.body : String(req.body?.csv ?? '');
    try {
      const inserted = await RowsService.importCsv(db, req.params.table, info, csvText);
      ok(res, { message: `${inserted} row(s) imported.`, inserted });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to import CSV.');
    }
  });

  router.post('/api/tables/:db/:table/import', importCsvHandler);
  router.post('/api/tables/:db/:table/rows/import', importCsvHandler);
  router.post('/api/tables/:db/:table/import/csv', importCsvHandler);

  router.post('/api/query/:db/export', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const sql = String(req.body?.sql ?? '').trim();
    const format = String(req.body?.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    if (!sql) return fail(res, 'SQL query is required.');

    try {
      const exp = await QueryService.exportQuery(db, sql, format);
      res.setHeader('Content-Type', exp.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
      res.send(exp.data);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Query failed.', 400);
    }
  }));
}
