import type { Router, Request, Response } from 'express';
import { parseFilters, normalizeRow } from '../../utils/common';
import { sniffMimeType, analyzeBlob } from '../../utils/datatype';
import { toCsv, toJson } from '../../utils/csv';
import { generateInsert, generateUpdate } from '../../sql/generator';
import {
  type ApiContext,
  ok,
  fail,
  wrap,
  requireTable,
  buildFields,
  buildUpdateFields,
  pkWhere,
  resolvePkRows,
  computeBulkImpact,
  MAX_BULK_ROWS,
} from './helpers';
import type { WhereClause } from '../../db/database';

export function registerRowRoutes(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  // ---- Rows --------------------------------------------------------------

  router.get('/api/tables/:table/rows', wrap(async (req, res) => {
    const page = Number.parseInt(String(req.query.page ?? '1'), 10);
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
    const orderDir = req.query.orderDir === 'desc' ? 'desc' : 'asc';
    const filters = parseFilters(req.query.f);

    const [rowsR, totalR] = await Promise.all([
      db.getRows(req.params.table, { page, limit, orderBy, orderDir, filters }),
      db.getRowCount(req.params.table, filters),
    ]);
    if (!rowsR.success) return fail(res, rowsR.error ?? 'Failed to load rows.');
    const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    ok(res, {
      rows,
      total: totalR.success ? totalR.data : rows.length,
      page,
      limit,
    });
  }));

  router.get('/api/tables/:table/rows/count', wrap(async (req, res) => {
    const filters = parseFilters(req.query.f);
    const r = await db.getRowCount(req.params.table, filters);
    if (!r.success) return fail(res, r.error ?? 'Failed to count rows.');
    ok(res, { count: r.data });
  }));

  // Fetch single row
  router.get('/api/tables/:table/row/:id', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);
    const r = await db.getRow(req.params.table, where);
    if (!r.success) return fail(res, r.error ?? 'Failed to load row.');
    if (!r.data) return fail(res, 'Row not found.', 404);
    ok(res, normalizeRow(r.data));
  }));

  // Serve raw BLOB binary data with auto-detected Content-Type and download support
  router.get('/api/tables/:table/row/:id/blob/:column', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    const r = await db.getRow(req.params.table, where);
    if (!r.success) return fail(res, r.error ?? 'Failed to load row.');
    if (!r.data) return fail(res, 'Row not found.', 404);

    const colName = req.params.column;
    const rawVal = r.data[colName];
    if (rawVal === null || rawVal === undefined) {
      return fail(res, 'Column value is NULL.', 404);
    }

    let buf: Buffer;
    if (Buffer.isBuffer(rawVal) || rawVal instanceof Uint8Array) {
      buf = Buffer.isBuffer(rawVal) ? rawVal : Buffer.from(rawVal);
    } else if (typeof rawVal === 'string' && (/^0x[0-9a-f]*$/i.test(rawVal))) {
      buf = Buffer.from(rawVal.slice(2), 'hex');
    } else {
      buf = Buffer.from(String(rawVal), 'utf8');
    }

    const mimeInfo = sniffMimeType(buf);

    res.setHeader('Content-Type', mimeInfo.mime);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-cache');

    if (req.query.download === '1' || req.query.download === 'true') {
      const filename = `${req.params.table}_${colName}_${req.params.id}.${mimeInfo.ext}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    res.end(buf);
  }));

  // Return BLOB metadata and formatted hex dump
  router.get('/api/tables/:table/row/:id/blob/:column/meta', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    const r = await db.getRow(req.params.table, where);
    if (!r.success) return fail(res, r.error ?? 'Failed to load row.');
    if (!r.data) return fail(res, 'Row not found.', 404);

    const colName = req.params.column;
    const rawVal = r.data[colName];
    if (rawVal === null || rawVal === undefined) {
      return ok(res, { isNull: true, size: 0, sizeFormatted: '0 B' });
    }

    const meta = analyzeBlob(rawVal as Uint8Array | Buffer | string);
    ok(res, { isNull: false, ...meta });
  }));

  // Update BLOB binary value directly (accepts Base64 or Hex payload)
  router.put('/api/tables/:table/row/:id/blob/:column', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    const colName = req.params.column;
    let buf: Buffer;

    if (req.body?.data !== undefined) {
      const format = req.body.format || 'base64';
      if (format === 'base64') {
        // Strip data:image/...;base64, prefix if present
        const base64Str = String(req.body.data).replace(/^data:[^;]+;base64,/, '');
        buf = Buffer.from(base64Str, 'base64');
      } else if (format === 'hex') {
        const hexStr = String(req.body.data).replace(/^0x/i, '');
        buf = Buffer.from(hexStr, 'hex');
      } else {
        buf = Buffer.from(String(req.body.data), 'utf8');
      }
    } else {
      return fail(res, 'Payload data is required.');
    }

    const updateRes = await db.updateRow(req.params.table, [{ column: colName, value: buf }], where);
    if (!updateRes.success) return fail(res, updateRes.error ?? 'Failed to update BLOB.');
    ok(res, { message: `Updated BLOB in column "${colName}".`, size: buf.length });
  }));

  // Preview generated INSERT SQL without executing
  router.post('/api/tables/:table/rows/generate', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const fields = buildFields(info, req.body?.values ?? req.body ?? {});
    if (!fields.length) return fail(res, 'No valid column values provided.');
    const sql = generateInsert(req.params.table, fields);
    ok(res, { sql });
  }));

  // Preview generated UPDATE SQL without executing
  const generateUpdateHandler = wrap(async (req: Request, res: Response) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const id = req.params.id || (req.query.id ? String(req.query.id) : null);
    if (!id) return fail(res, 'Primary key id is required.');
    const where = pkWhere(info, id);
    if (!where) return fail(res, 'Invalid primary key.', 400);
    const nulls = Array.isArray(req.body?.nulls) ? (req.body.nulls as string[]) : [];
    const fields = buildUpdateFields(info, req.body?.values ?? req.body ?? {}, nulls);
    if (!fields.length) return fail(res, 'No fields to update.');
    const sql = generateUpdate(req.params.table, fields, where);
    ok(res, { sql });
  });

  router.put('/api/tables/:table/row/:id/generate', generateUpdateHandler);
  router.post('/api/tables/:table/row/:id/generate', generateUpdateHandler);
  router.put('/api/tables/:table/rows/generate', generateUpdateHandler);

  router.post('/api/tables/:table/rows', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const isBatch = Array.isArray(req.body?.rows);
    const rowList: Record<string, unknown>[] = isBatch
      ? (req.body.rows as Record<string, unknown>[])
      : [req.body?.values ?? req.body ?? {}];

    if (!rowList.length) return fail(res, 'No rows provided.');

    const fieldsList = rowList.map((row) => buildFields(info, row));
    if (!isBatch) {
      const fields = fieldsList[0];
      if (!fields.length) return fail(res, 'No valid column values provided.');
      const r = await db.insertRow(req.params.table, fields);
      if (!r.success) return fail(res, r.error ?? 'Failed to insert row.');
      return ok(res, { message: 'Row inserted.', id: r.data?.lastInsertRowid }, 201);
    }

    const r = await db.insertRows(req.params.table, fieldsList);
    if (!r.success) return fail(res, r.error ?? 'Failed to insert rows.');
    ok(res, { message: `${r.data?.inserted ?? 0} row(s) inserted.`, inserted: r.data?.inserted }, 201);
  }));

  const updateSingleRowHandler = wrap(async (req: Request, res: Response) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const id = req.params.id || (req.query.id ? String(req.query.id) : null);
    if (!id) return fail(res, 'Primary key id is required.');
    const where = pkWhere(info, id);
    if (!where) return fail(res, 'Invalid primary key.');
    const nulls = Array.isArray(req.body?.nulls) ? (req.body.nulls as string[]) : [];
    const fields = buildUpdateFields(info, req.body?.values ?? req.body ?? {}, nulls);
    if (!fields.length) return fail(res, 'No fields to update.');
    const r = await db.updateRow(req.params.table, fields, where);
    if (!r.success) return fail(res, r.error ?? 'Failed to update row.');
    ok(res, { message: 'Row updated.' });
  });

  const bulkUpdateHandler = wrap(async (req: Request, res: Response) => {
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

      if (!rowUpdates.length) return ok(res, { message: 'No changes to apply.', updated: 0 });
      const r = await db.updateRows(req.params.table, rowUpdates);
      if (!r.success) return fail(res, r.error ?? 'Failed to update rows.');
      return ok(res, { message: `${r.data?.updated ?? 0} row(s) updated.`, updated: r.data?.updated });
    }

    return updateSingleRowHandler(req, res);
  });

  router.put('/api/tables/:table/row/:id', updateSingleRowHandler);
  router.put('/api/tables/:table/rows', bulkUpdateHandler);
  router.post('/api/tables/:table/rows/bulk-update', bulkUpdateHandler);

  const deleteSingleRowHandler = wrap(async (req: Request, res: Response) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const id = req.params.id || (req.query.id ? String(req.query.id) : null);
    if (!id) return fail(res, 'Primary key id is required.');
    const where = pkWhere(info, id);
    if (!where) return fail(res, 'Invalid primary key.');
    const r = await db.deleteRow(req.params.table, where);
    if (!r.success) return fail(res, r.error ?? 'Failed to delete row.');
    ok(res, { message: 'Row deleted.' });
  });

  router.delete('/api/tables/:table/row/:id', deleteSingleRowHandler);
  router.delete('/api/tables/:table/rows', deleteSingleRowHandler);

  // ---- Row references ----------------------------------------------------

  router.get('/api/tables/:table/rows/:id/references', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);

    const rowR = await db.getRow(req.params.table, where);
    if (!rowR.success || !rowR.data) return fail(res, 'Row not found.', 404);

    const refInfoR = await db.getReferencingTables(req.params.table);
    const referencing = refInfoR.data ?? [];
    const results: { table: string; from: string; to: string; value?: unknown; columns?: string[]; rows: Record<string, unknown>[]; count?: number; total: number }[] = [];

    for (const item of referencing) {
      for (const ref of item.refs) {
        const targetCol = ref.to || info.primaryKey[0];
        if (!targetCol) continue;
        const val = rowR.data[targetCol];
        if (val == null) continue;
        const fkR = await db.getRowsByFk(item.table, ref.from, val);
        if (fkR.success && fkR.data) {
          const rows = fkR.data.rows.map(normalizeRow);
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          results.push({
            table: item.table,
            from: ref.from,
            to: targetCol,
            value: val,
            columns,
            rows,
            count: fkR.data.total,
            total: fkR.data.total,
          });
        }
      }
    }
    ok(res, { references: results });
  }));

  // ---- Bulk row operations -----------------------------------------------

  router.post('/api/tables/:table/rows/bulk-delete', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return fail(res, 'No row IDs provided.');
    if (ids.length > MAX_BULK_ROWS) return fail(res, `Cannot delete more than ${MAX_BULK_ROWS} rows at once.`);

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return fail(res, 'Invalid or unresolvable row IDs.');

    const r = await db.deleteRows(req.params.table, wheres);
    if (!r.success) return fail(res, r.error ?? 'Failed to delete rows.');
    ok(res, { message: `${r.data?.deleted ?? 0} row(s) deleted.`, deleted: r.data?.deleted });
  }));

  router.post('/api/tables/:table/rows/bulk-impact', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return ok(res, { references: [], total: 0 });

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return ok(res, { references: [], total: 0 });

    const impact = await computeBulkImpact(db, info, wheres);
    ok(res, impact);
  }));

  router.post('/api/tables/:table/rows/bulk-export', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const ids = (req.body?.ids ?? []) as unknown[];
    if (!Array.isArray(ids) || !ids.length) return fail(res, 'No row IDs provided.');
    if (ids.length > MAX_BULK_ROWS) return fail(res, `Cannot export more than ${MAX_BULK_ROWS} rows at once.`);

    const wheres = resolvePkRows(info, ids);
    if (!wheres) return fail(res, 'Invalid or unresolvable row IDs.');

    const format = String(req.body?.format ?? 'csv').toLowerCase();
    const rowsR = await db.getRowsByPks(req.params.table, wheres);
    if (!rowsR.success) return fail(res, rowsR.error ?? 'Failed to load rows.');

    const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}_selected.json"`);
      return res.send(toJson(rows));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}_selected.csv"`);
    res.send(toCsv(rows, columns));
  }));
}
