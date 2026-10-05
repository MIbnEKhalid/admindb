import type { Router, Request, Response, NextFunction } from 'express';
import { decodePk, parseFilters, filtersToQS } from '../../utils/common';
import { type RouteContext, type RequestParams, ok, fail, wrap, notFound, initPageLocals } from '../../core/router';
import { TableService } from '../tables/tables.service';
import { SchemaService } from '../schema/schema.service';
import { RowsService, buildDisplayRows, buildFields, buildUpdateFields, pkWhere, resolvePkRows, computeBulkImpact, MAX_BULK_ROWS } from './index';
import type { WhereClause } from '../../db/types';

export function registerRowRoutes(router: Router, ctx: RouteContext): void {
  // ---- Page Routes -------------------------------------------------------

  router.get('/tables/:db/:table', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const info = await TableService.getTableInfo(db, table);
      if (!info) {
        return notFound(res, `Table "${table}" does not exist.`);
      }

      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const pageSize = Math.max(1, Number.parseInt(String(req.query.size ?? '50'), 10) || 50);
      const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
      const orderDir = String(req.query.orderDir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      const filters = parseFilters(req.query.f);
      const filterQS = filtersToQS(filters);

      const [count, paginated, refs] = await Promise.all([
        RowsService.getRowCount(db, table, filters),
        RowsService.getPaginatedRows(db, table, { page, limit: pageSize, orderBy, orderDir, filters }),
        SchemaService.getReferencingTables(db, table),
      ]);

      const rawRows = paginated.rows;
      const pages = Math.max(1, Math.ceil(count / pageSize));
      const basePath = String(res.locals.basePath ?? '');
      const sizes = [25, 50, 100, 250];

      const colHeaders = info.columns.map((c) => {
        const active = c.name === orderBy;
        const nextDir = active ? (orderDir === 'asc' ? 'desc' : 'asc') : 'asc';
        const qs = `page=1&size=${pageSize}&orderBy=${encodeURIComponent(c.name)}&orderDir=${nextDir}`;
        return {
          name: c.name,
          pk: c.pk,
          type: c.type,
          active,
          dir: active ? orderDir : null,
          href: `${basePath}/tables/${encodeURIComponent(dbId)}/${encodeURIComponent(table)}?${qs}${filterQS ? `&${filterQS}` : ''}`,
        };
      });

      const refColumns = refs
        .filter((r) => !r.table.startsWith('_'))
        .map((rt) => ({ table: rt.table, from: rt.refs[0]?.from ?? '', to: rt.refs[0]?.to ?? '' }));

      const countMap = await TableService.getIncomingForeignKeyCounts(db, rawRows, refColumns);

      const rows = buildDisplayRows(rawRows, info, dbId, table, basePath).map((dr, i) => {
        const raw = rawRows[i];
        const rowRefs = refColumns.map((col) => {
          const v = raw[col.to];
          return {
            table: col.table,
            from: col.from,
            to: col.to,
            value: v == null ? '' : String(v),
            count: v == null ? 0 : (countMap.get(col.table)?.get(String(v)) ?? 0),
          };
        });
        return { ...dr, refs: rowRefs };
      });

      res.locals.currentTable = table;
      res.render('pages/table', {
        title: table,
        dbId,
        table,
        info,
        rows,
        count,
        page,
        pageSize,
        pages,
        pkCols: info.primaryKey,
        colNames: info.columns.map((c) => c.name),
        colHeaders,
        refColumns,
        hasPk: true,
        orderBy: orderBy ?? '',
        orderDir,
        sizes,
        filters,
        filterQS,
        firstRow: count === 0 ? 0 : (page - 1) * pageSize + 1,
        lastRow: Math.min(page * pageSize, count),
        browseConfig: {
          dbId,
          table,
          filters,
          pkCols: info.primaryKey.length ? info.primaryKey : ['_rowid_'],
          hasPk: true,
          readonly: db.isReadOnly,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tables/:db/:table/rows/new', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const info = await TableService.getTableInfo(db, table);
      if (!info) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.primaryKey;
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `New row · ${table}`,
        dbId,
        table,
        mode: 'insert',
        pk: null,
        pkColumns,
        infoSummary: `${info.columns.length} column(s)` + (pkColumns.length ? ` · PK: ${pkColumns.join(', ')}` : ''),
        config: { dbId, table, mode: 'insert', pk: null, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tables/:db/:table/rows/:id/edit', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const info = await TableService.getTableInfo(db, table);
      if (!info) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.primaryKey.length ? info.primaryKey : ['_rowid_'];
      const pk = decodePk(req.params.id);
      if (pk.length !== pkColumns.length) {
        return notFound(res, 'Invalid row identifier.');
      }
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `Edit row · ${table}`,
        dbId,
        table,
        mode: 'edit',
        pk: req.params.id,
        pkColumns,
        infoSummary: `${info.columns.length} column(s)` + (info.primaryKey.length ? ` · PK: ${info.primaryKey.join(', ')}` : ''),
        config: { dbId, table, mode: 'edit', pk: req.params.id, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- API Routes --------------------------------------------------------

  router.get('/api/tables/:db/:table/rows', wrap(async (req, res) => {
    const db = ctx.getContext(req);
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

  router.get('/api/tables/:db/:table/cursor-rows', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
    const orderDir = req.query.orderDir === 'desc' ? 'desc' : 'asc';
    const filters = parseFilters(req.query.f);

    try {
      const data = await RowsService.getCursorPaginatedRows(db, req.params.table, {
        cursor,
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
    const db = ctx.getContext(req);
    const filters = parseFilters(req.query.f);
    try {
      const count = await RowsService.getRowCount(db, req.params.table, filters);
      ok(res, { count });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to count rows.');
    }
  }));

  router.get('/api/tables/:db/:table/row/:id', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const fields = buildFields(info, req.body?.values ?? req.body ?? {});
    try {
      ok(res, { sql: RowsService.generateInsertSql(req.params.table, fields) });
    } catch (err) {
      fail(res, (err as Error).message);
    }
  }));

  const generateUpdateHandler = wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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

  const updateSingleRowHandler = wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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

  const bulkUpdateHandler = wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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

  const deleteSingleRowHandler = wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return ok(res, { references: [], total: 0 });

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return ok(res, { references: [], total: 0 });

    ok(res, await computeBulkImpact(db, info, wheres));
  }));

  router.post('/api/tables/:db/:table/rows/bulk-export', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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

  // ---- Stream Export & Import --------------------------------------------

  router.get('/api/tables/:db/:table/export', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const format = String(req.query.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const filters = parseFilters(req.query.f);

    try {
      const exp = await RowsService.streamExportTable(db, req.params.table, info, { filters, format });
      res.setHeader('Content-Type', exp.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exp.filename}"`);
      exp.stream.pipe(res);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to export table.');
    }
  }));

  const importCsvHandler = wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
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
}
