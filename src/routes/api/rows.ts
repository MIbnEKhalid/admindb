import type { Router, Request, Response } from 'express';
import { parseFilters } from '../../utils/common';
import { type ApiContext, ok, fail, wrap, requireTable } from './helpers';
import { RowsService, buildFields, buildUpdateFields, pkWhere, resolvePkRows, computeBulkImpact, MAX_BULK_ROWS } from '../../modules/rows/index';
import type { WhereClause } from '../../db/database';

export function registerRowRoutes(router: Router, ctx: ApiContext): void {
  // ---- Rows --------------------------------------------------------------

  router.get('/api/tables/:db/:table/rows', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const page = Number.parseInt(String(req.query.page ?? '1'), 10);
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
    const orderDir = req.query.orderDir === 'desc' ? 'desc' : 'asc';
    const filters = parseFilters(req.query.f);

    try {
      const data = await RowsService.getPaginatedRows(db, req.params.table, {
        page,
        limit,
        orderBy,
        orderDir,
        filters,
      });
      ok(res, data);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to load rows.');
    }
  }));

  router.get('/api/tables/:db/:table/rows/count', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const filters = parseFilters(req.query.f);
    try {
      const count = await RowsService.getRowCount(db, req.params.table, filters);
      ok(res, { count });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to count rows.');
    }
  }));

  router.get('/api/tables/:db/:table/row/:id', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    try {
      const row = await RowsService.getRow(db, req.params.table, where);
      if (!row) return fail(res, 'Row not found.', 404);
      ok(res, row);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to load row.');
    }
  }));

  router.get('/api/tables/:db/:table/row/:id/blob/:column', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    try {
      const blobResult = await RowsService.getBlob(db, req.params.table, where, req.params.column);
      if (!blobResult) {
        return fail(res, 'Column value is NULL.', 404);
      }

      const { buffer, mimeInfo } = blobResult;
      res.setHeader('Content-Type', mimeInfo.mime);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'no-cache');

      if (req.query.download === '1' || req.query.download === 'true') {
        const filename = `${req.params.table}_${req.params.column}_${req.params.id}.${mimeInfo.ext}`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }

      res.end(buffer);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to load row.');
    }
  }));

  router.get('/api/tables/:db/:table/row/:id/blob/:column/meta', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    try {
      const meta = await RowsService.getBlobMeta(db, req.params.table, where, req.params.column);
      if (!meta) return fail(res, 'Row not found.', 404);
      ok(res, meta);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to load row.');
    }
  }));

  router.put('/api/tables/:db/:table/row/:id/blob/:column', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    const colName = req.params.column;
    if (req.body?.data === undefined) {
      return fail(res, 'Payload data is required.');
    }

    try {
      const size = await RowsService.updateBlob(
        db,
        req.params.table,
        where,
        colName,
        req.body.data,
        req.body.format,
      );
      ok(res, { message: `Updated BLOB in column "${colName}".`, size });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to update BLOB.');
    }
  }));

  router.post('/api/tables/:db/:table/rows/generate', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const fields = buildFields(info, req.body?.values ?? req.body ?? {});
    try {
      ok(res, { sql: RowsService.generateInsertSql(req.params.table, fields) });
    } catch (err) {
      fail(res, (err as Error).message);
    }
  }));

  const generateUpdateHandler = wrap(async (req: Request, res: Response) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const id = req.params.id || (req.query.id ? String(req.query.id) : null);
    if (!id) return fail(res, 'Primary key id is required.');
    const where = pkWhere(info, id);
    if (!where) return fail(res, 'Invalid primary key.', 400);
    const nulls = Array.isArray(req.body?.nulls) ? (req.body.nulls as string[]) : [];
    const fields = buildUpdateFields(info, req.body?.values ?? req.body ?? {}, nulls);
    try {
      ok(res, { sql: RowsService.generateUpdateSql(req.params.table, fields, where) });
    } catch (err) {
      fail(res, (err as Error).message);
    }
  });

  router.put('/api/tables/:db/:table/row/:id/generate', generateUpdateHandler);
  router.post('/api/tables/:db/:table/row/:id/generate', generateUpdateHandler);
  router.put('/api/tables/:db/:table/rows/generate', generateUpdateHandler);

  router.post('/api/tables/:db/:table/rows', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const isBatch = Array.isArray(req.body?.rows);
    const rowList: Record<string, unknown>[] = isBatch
      ? (req.body.rows as Record<string, unknown>[])
      : [req.body?.values ?? req.body ?? {}];

    if (!rowList.length) return fail(res, 'No rows provided.');

    const fieldsList = rowList.map((row) => buildFields(info, row));
    try {
      if (!isBatch) {
        const id = await RowsService.insertRow(db, req.params.table, fieldsList[0]);
        return ok(res, { message: 'Row inserted.', id }, 201);
      }

      const inserted = await RowsService.insertRows(db, req.params.table, fieldsList);
      ok(res, { message: `${inserted} row(s) inserted.`, inserted }, 201);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to insert row(s).');
    }
  }));

  const updateSingleRowHandler = wrap(async (req: Request, res: Response) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const id = req.params.id || (req.query.id ? String(req.query.id) : null);
    if (!id) return fail(res, 'Primary key id is required.');
    const where = pkWhere(info, id);
    if (!where) return fail(res, 'Invalid primary key.');
    const nulls = Array.isArray(req.body?.nulls) ? (req.body.nulls as string[]) : [];
    const fields = buildUpdateFields(info, req.body?.values ?? req.body ?? {}, nulls);

    try {
      await RowsService.updateRow(db, req.params.table, fields, where);
      ok(res, { message: 'Row updated.' });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to update row.');
    }
  });

  const bulkUpdateHandler = wrap(async (req: Request, res: Response) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    if (Array.isArray(req.body?.updates)) {
      const updates = req.body.updates as { id?: string; values?: Record<string, unknown>; nulls?: string[] }[];
      if (!updates.length) return fail(res, 'No updates provided.');
      if (updates.length > MAX_BULK_ROWS) return fail(res, `Cannot update more than ${MAX_BULK_ROWS} rows at once.`);

      const rowUpdates: { fields: WhereClause[]; where: WhereClause[] }[] = [];
      for (const u of updates) {
        if (!u.id) return fail(res, 'Every update requires an id.');
        const where = pkWhere(info, String(u.id));
        if (!where) return fail(res, `Invalid primary key: "${u.id}".`);
        const nulls = Array.isArray(u.nulls) ? u.nulls.map(String) : [];
        const fields = buildUpdateFields(info, u.values ?? {}, nulls);
        if (fields.length) rowUpdates.push({ fields, where });
      }

      try {
        const updated = await RowsService.updateRows(db, req.params.table, rowUpdates);
        return ok(res, { message: updated ? `${updated} row(s) updated.` : 'No changes to apply.', updated });
      } catch (err) {
        return fail(res, (err as Error).message ?? 'Failed to update rows.');
      }
    }

    return updateSingleRowHandler(req, res);
  });

  router.put('/api/tables/:db/:table/row/:id', updateSingleRowHandler);
  router.put('/api/tables/:db/:table/rows', bulkUpdateHandler);
  router.post('/api/tables/:db/:table/rows/bulk-update', bulkUpdateHandler);

  const deleteSingleRowHandler = wrap(async (req: Request, res: Response) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const id = req.params.id || (req.query.id ? String(req.query.id) : null);
    if (!id) return fail(res, 'Primary key id is required.');
    const where = pkWhere(info, id);
    if (!where) return fail(res, 'Invalid primary key.');

    try {
      await RowsService.deleteRow(db, req.params.table, where);
      ok(res, { message: 'Row deleted.' });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to delete row.');
    }
  });

  router.delete('/api/tables/:db/:table/row/:id', deleteSingleRowHandler);
  router.delete('/api/tables/:db/:table/rows', deleteSingleRowHandler);

  // ---- Row references ----------------------------------------------------

  router.get('/api/tables/:db/:table/rows/:id/references', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    try {
      const references = await RowsService.getRowReferences(db, req.params.table, info, where);
      ok(res, { references });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'Row not found.') return fail(res, msg, 404);
      fail(res, msg ?? 'Failed to fetch references.');
    }
  }));

  // ---- Bulk row operations -----------------------------------------------

  router.post('/api/tables/:db/:table/rows/bulk-delete', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return fail(res, 'No row IDs provided.');
    if (ids.length > MAX_BULK_ROWS) return fail(res, `Cannot delete more than ${MAX_BULK_ROWS} rows at once.`);

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return fail(res, 'Invalid or unresolvable row IDs.');

    try {
      const deleted = await RowsService.deleteRows(db, req.params.table, wheres);
      ok(res, { message: `${deleted} row(s) deleted.`, deleted });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to delete rows.');
    }
  }));

  router.post('/api/tables/:db/:table/rows/bulk-impact', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return ok(res, { references: [], total: 0 });

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return ok(res, { references: [], total: 0 });

    ok(res, await computeBulkImpact(db, info, wheres));
  }));

  router.post('/api/tables/:db/:table/rows/bulk-export', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return fail(res, 'No row IDs provided.');
    if (ids.length > MAX_BULK_ROWS) return fail(res, `Cannot export more than ${MAX_BULK_ROWS} rows at once.`);

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return fail(res, 'Invalid or unresolvable row IDs.');

    const format = String(req.body?.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    try {
      const exp = await RowsService.exportBulkRows(db, req.params.table, info, wheres, format);
      res.setHeader('Content-Type', exp.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
      res.send(exp.data);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to load rows.');
    }
  }));
}
