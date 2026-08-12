import type { Router, Request, Response } from 'express';
import type { SqliteDatabase, TableInfoData } from '../db/database';
import type { Logger } from '../logger';
import {
  generateCreateTable,
  generateInsert,
  generateUpdate,
  generateAddColumn,
  generateRenameTable,
  generateRenameColumn,
  generateDropColumn,
  generateDropTable,
  generateCreateIndex,
  generateDropIndex,
  generateCreateView,
  generateDropView,
  generateCreateTrigger,
  generateDropTrigger,
  type ColumnDef,
  type IndexDef,
  type TriggerDef,
} from '../sql/generator';
import { classifySql } from '../sql/classifier';
import { toCsv, toJson, parseCsv } from '../csv';
import { coerceFormValue, decodePk, errorMessage, normalizeRow, parseFilters } from '../util';

interface ApiContext {
  db: SqliteDatabase;
  logger: Logger;
}

function ok(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

function fail(res: Response, error: string, status = 400): Response {
  return res.status(status).json({ success: false, error });
}

function wrap(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, errorMessage(err), 500);
    }
  };
}

async function requireTable(db: SqliteDatabase, table: string): Promise<TableInfoData | null> {
  const info = await db.getTableInfo(table);
  if (!info.success || !info.data || info.data.columns.length === 0) return null;
  return info.data;
}

function buildFields(
  info: TableInfoData,
  values: Record<string, unknown>,
  opts: { excludePk?: boolean } = {},
): { column: string; value: unknown }[] {
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  const pkSet = new Set(info.primaryKey);
  const fields: { column: string; value: unknown }[] = [];
  for (const [col, raw] of Object.entries(values ?? {})) {
    if (!typeMap.has(col)) continue;
    if (opts.excludePk && pkSet.has(col)) continue;
    const val = coerceFormValue(raw, typeMap.get(col)!);
    if (val === null) continue; // empty input = "not set"
    fields.push({ column: col, value: val });
  }
  return fields;
}

function pkWhere(info: TableInfoData, encodedId: string): { column: string; value: unknown }[] | null {
  if (!info.primaryKey.length) return null;
  const vals = decodePk(encodedId);
  if (vals.length !== info.primaryKey.length) return null;
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  return info.primaryKey.map((col, i) => ({ column: col, value: coerceFormValue(vals[i], typeMap.get(col)!) }));
}

export function registerApi(router: Router, ctx: ApiContext): void {
  const { db, logger } = ctx;

  // In read-only mode every mutating request is rejected (GET, the generate-only
  // preview endpoints and the query runner stay available; the query runner
  // rejects write statements itself).
  router.use((req: Request, res: Response, next: import('express').NextFunction) => {
    if (!db.isReadOnly || req.method === 'GET') return next();
    const p = req.path;
    if (p.endsWith('/generate') || p.endsWith('/api/query/export') || p.endsWith('/api/query')) return next();
    return res.status(403).json({ success: false, error: 'Database is open in read-only mode — write operations are disabled.' });
  });

  // ---- Tables ------------------------------------------------------------

  router.get(
    '/api/tables',
    wrap(async (_req, res) => {
      const r = await db.listTables();
      if (!r.success) return fail(res, r.error ?? 'Failed to list tables.', 500);
      ok(res, r.data);
    }),
  );

  router.get(
    '/api/tables/:table/info',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      ok(res, info);
    }),
  );

  router.get(
    '/api/tables/:table/fk-options',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const options: Record<string, { value: unknown; label: string }[]> = {};
      for (const fk of info.foreignKeys) {
        try {
          const refInfo = await requireTable(db, fk.table);
          if (!refInfo) continue;
          const pk = refInfo.primaryKey[0] ?? refInfo.columns[0]?.name;
          const labelCols = refInfo.columns.filter((c) => c.name !== pk).slice(0, 2).map((c) => c.name);
          const rowsR = await db.getAllRows(fk.table);
          const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).slice(0, 500);
          options[fk.from] = rows.map((row) => ({
            value: row[pk],
            label: labelCols.length ? labelCols.map((c) => String(row[c] ?? '')).join(' · ') : String(row[pk] ?? ''),
          }));
        } catch (err) {
          logger.warn(`fk-options for ${fk.from}: ${errorMessage(err)}`);
        }
      }
      ok(res, options);
    }),
  );

  router.get(
    '/api/tables/:table/rows',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.max(1, Math.min(1000, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
      const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
      const orderDir = String(req.query.orderDir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      const filters = parseFilters(req.query.f);
      const rowsR = await db.getRows(req.params.table, { page, limit, orderBy, orderDir, filters });
      if (!rowsR.success) return fail(res, rowsR.error ?? 'Failed to load rows.', 500);
      const countR = await db.getRowCount(req.params.table, filters);
      ok(res, {
        rows: ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow),
        count: countR.success ? countR.data : 0,
        page,
        limit,
        filters,
      });
    }),
  );

  // ---- Export / import ---------------------------------------------------

  router.get(
    '/api/tables/:table/export',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const format = String(req.query.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
      const rowsR = await db.getAllRows(req.params.table);
      if (!rowsR.success) return fail(res, rowsR.error ?? 'Export failed.', 500);
      const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
      const columns = info.columns.map((c) => c.name);
      const body = format === 'json' ? toJson(rows) : toCsv(rows, columns);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}-${stamp}.${format}"`);
      res.send(body);
    }),
  );

  router.post(
    '/api/tables/:table/rows/import',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const csvText = String(req.body?.csv ?? '');
      if (!csvText.trim()) return fail(res, 'CSV content is required.');
      const rows = parseCsv(csvText);
      if (rows.length < 2) return fail(res, 'CSV must include a header row and at least one data row.');
      const headers = rows[0].map((h) => String(h).trim());
      if (!headers.length) return fail(res, 'CSV header is empty.');
      const colSet = new Set(info.columns.map((c) => c.name));
      const unknown = headers.filter((h) => !colSet.has(h));
      if (unknown.length) return fail(res, `Unknown column(s) in CSV header: ${unknown.join(', ')}.`);
      if (new Set(headers).size !== headers.length) return fail(res, 'Duplicate column(s) in CSV header.');
      const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
      const dataRows = rows
        .slice(1)
        .filter((r) => r.length !== 1 || r[0] !== '')
        .map((r) => {
          const fields: { column: string; value: unknown }[] = [];
          headers.forEach((h, i) => {
            const val = coerceFormValue(r[i], typeMap.get(h)!);
            if (val !== null) fields.push({ column: h, value: val });
          });
          return fields;
        });
      if (!dataRows.length) return fail(res, 'No data rows to import.');
      const result = await db.insertRows(req.params.table, dataRows);
      if (!result.success) return fail(res, result.error ?? 'Import failed.', 400);
      ok(
        res,
        {
          message: `Imported ${result.data?.inserted} row(s).`,
          inserted: result.data?.inserted,
          skipped: result.data?.skipped,
        },
        201,
      );
    }),
  );

  router.post(
    '/api/query/export',
    wrap(async (req, res) => {
      const sql = String(req.body?.sql ?? '').trim();
      if (!sql) return fail(res, 'SQL is required.');
      const format = String(req.body?.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
      const r = await db.all(sql);
      if (!r.success) return fail(res, r.error ?? 'Query failed.', 400);
      const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      const body = format === 'json' ? toJson(rows) : toCsv(rows, columns);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="query-${stamp}.${format}"`);
      res.send(body);
    }),
  );

  router.get(
    '/api/tables/:table/row/:id',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const where = pkWhere(info, req.params.id);
      if (!where) return fail(res, 'Invalid primary key.', 400);
      const r = await db.getRow(req.params.table, where);
      if (!r.success) return fail(res, r.error ?? 'Failed to load row.', 500);
      if (!r.data) return fail(res, 'Row not found.', 404);
      ok(res, normalizeRow(r.data as Record<string, unknown>));
    }),
  );

  // ---- Row CRUD (run + generate variants) -------------------------------

  router.post(
    '/api/tables/:table/rows',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const values = (req.body?.values ?? {}) as Record<string, unknown>;
      const fields = buildFields(info, values);
      if (!fields.length) return fail(res, 'No values provided.');
      const sql = generateInsert(req.params.table, fields);
      const r = await db.insertRow(req.params.table, fields);
      if (!r.success) return fail(res, r.error ?? 'Insert failed.', 400);
      ok(res, { message: 'Row inserted.', rowId: r.data?.lastInsertRowid, sql }, 201);
    }),
  );

  router.post(
    '/api/tables/:table/rows/generate',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const values = (req.body?.values ?? {}) as Record<string, unknown>;
      const fields = buildFields(info, values);
      if (!fields.length) return fail(res, 'No values provided.');
      ok(res, { sql: generateInsert(req.params.table, fields) });
    }),
  );

  router.put(
    '/api/tables/:table/row/:id',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const where = pkWhere(info, req.params.id);
      if (!where) return fail(res, 'Invalid primary key.', 400);
      const values = (req.body?.values ?? {}) as Record<string, unknown>;
      const fields = buildFields(info, values, { excludePk: true });
      if (!fields.length) return fail(res, 'No fields to update.');
      const sql = generateUpdate(req.params.table, fields, where);
      const r = await db.updateRow(req.params.table, fields, where);
      if (!r.success) return fail(res, r.error ?? 'Update failed.', 400);
      ok(res, { message: 'Row updated.', sql });
    }),
  );

  router.put(
    '/api/tables/:table/row/:id/generate',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const where = pkWhere(info, req.params.id);
      if (!where) return fail(res, 'Invalid primary key.', 400);
      const values = (req.body?.values ?? {}) as Record<string, unknown>;
      const fields = buildFields(info, values, { excludePk: true });
      if (!fields.length) return fail(res, 'No fields to update.');
      ok(res, { sql: generateUpdate(req.params.table, fields, where) });
    }),
  );

  router.delete(
    '/api/tables/:table/row/:id',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const where = pkWhere(info, req.params.id);
      if (!where) return fail(res, 'Invalid primary key.', 400);
      const r = await db.deleteRow(req.params.table, where);
      if (!r.success) return fail(res, r.error ?? 'Delete failed.', 400);
      ok(res, { message: 'Row deleted.' });
    }),
  );

  // ---- Create table (run + generate) ------------------------------------

  router.post(
    '/api/tables',
    wrap(async (req, res) => {
      const { name, columns } = req.body ?? {};
      if (!Array.isArray(columns)) return fail(res, 'Columns must be an array.');
      let sql: string;
      try {
        sql = generateCreateTable(name, columns);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.execResult(sql);
      if (!r.success) return fail(res, r.error ?? 'Create table failed.', 400);
      ok(res, { message: `Table "${name}" created.`, sql }, 201);
    }),
  );

  router.post(
    '/api/tables/generate',
    wrap(async (req, res) => {
      const { name, columns } = req.body ?? {};
      if (!Array.isArray(columns)) return fail(res, 'Columns must be an array.');
      try {
        ok(res, { sql: generateCreateTable(name, columns) });
      } catch (err) {
        fail(res, errorMessage(err));
      }
    }),
  );

  // ---- Schema editing ----------------------------------------------------

  router.get(
    '/api/tables/:table/schema',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const r = await db.getSchema(req.params.table);
      if (!r.success) return fail(res, r.error ?? 'Failed to load schema.', 500);
      ok(res, r.data);
    }),
  );

  router.post(
    '/api/tables/:table/rename',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      if (req.params.table.startsWith('_')) return fail(res, 'Internal tables cannot be renamed.');
      const name = String(req.body?.name ?? '').trim();
      let sql: string;
      try {
        sql = generateRenameTable(req.params.table, name);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.renameTable(req.params.table, name);
      if (!r.success) return fail(res, r.error ?? 'Rename failed.', 400);
      ok(res, { message: `Table renamed to "${name}".`, sql, table: name });
    }),
  );

  router.post(
    '/api/tables/:table/columns',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const col = (req.body?.column ?? null) as unknown;
      if (!col || typeof col !== 'object') return fail(res, 'Column definition is required.');
      let sql: string;
      try {
        sql = generateAddColumn(req.params.table, col as ColumnDef);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.addColumn(req.params.table, col as ColumnDef);
      if (!r.success) return fail(res, r.error ?? 'Failed to add column.', 400);
      ok(res, { message: `Column "${String((col as ColumnDef).name)}" added.`, sql }, 201);
    }),
  );

  router.put(
    '/api/tables/:table/columns/:column',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const newName = String(req.body?.name ?? '').trim();
      let sql: string;
      try {
        sql = generateRenameColumn(req.params.table, req.params.column, newName);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.renameColumn(req.params.table, req.params.column, newName);
      if (!r.success) return fail(res, r.error ?? 'Failed to rename column.', 400);
      ok(res, { message: `Column renamed to "${newName}".`, sql });
    }),
  );

  router.delete(
    '/api/tables/:table/columns/:column',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      // Safety: refuse drops that would break constraints or relationships.
      const schema = await db.getSchema(req.params.table);
      if (schema.success) {
        const col = schema.data?.columns.find((c) => c.name === req.params.column);
        if (col && !col.canDrop) {
          return fail(res, `Cannot drop column "${col.name}": ${col.dropBlockers.join('; ')}.`, 400);
        }
      }
      let sql: string;
      try {
        sql = generateDropColumn(req.params.table, req.params.column);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.dropColumn(req.params.table, req.params.column);
      if (!r.success) return fail(res, r.error ?? 'Failed to drop column.', 400);
      ok(res, { message: `Column "${req.params.column}" dropped.`, sql });
    }),
  );

  router.delete(
    '/api/tables/:table',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      if (req.params.table.startsWith('_')) return fail(res, 'Internal tables cannot be dropped.');
      const schema = await db.getSchema(req.params.table);
      if (schema.success && schema.data && schema.data.references.length > 0) {
        return fail(
          res,
          `Cannot drop "${req.params.table}": it is referenced by foreign keys in ${schema.data.references.map((r) => `"${r.table}"`).join(', ')}.`,
          400,
        );
      }
      let sql: string;
      try {
        sql = generateDropTable(req.params.table);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.dropTable(req.params.table);
      if (!r.success) return fail(res, r.error ?? 'Failed to drop table.', 400);
      ok(res, { message: `Table "${req.params.table}" dropped.`, sql });
    }),
  );

  // ---- Index management --------------------------------------------------

  router.post(
    '/api/tables/:table/indexes',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const { name, columns, unique } = (req.body ?? {}) as { name?: string; columns?: string[]; unique?: boolean };
      const index: IndexDef = { name, columns: Array.isArray(columns) ? columns : [], unique: !!unique };
      let sql: string;
      try {
        sql = generateCreateIndex(req.params.table, index);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.createIndex(req.params.table, index);
      if (!r.success) return fail(res, r.error ?? 'Failed to create index.', 400);
      ok(res, { message: `Index created.`, sql }, 201);
    }),
  );

  router.delete(
    '/api/tables/:table/indexes/:index',
    wrap(async (req, res) => {
      const info = await requireTable(db, req.params.table);
      if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      const schema = await db.getSchema(req.params.table);
      const ix = schema.success
        ? schema.data?.indexes.find((i) => i.name === req.params.index)
        : undefined;
      if (ix && ix.origin !== 'c') {
        return fail(
          res,
          `Cannot drop "${ix.name}": it is an automatic ${ix.origin === 'pk' ? 'primary-key' : 'unique'} index.`,
          400,
        );
      }
      let sql: string;
      try {
        sql = generateDropIndex(req.params.index);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.dropIndex(req.params.index);
      if (!r.success) return fail(res, r.error ?? 'Failed to drop index.', 400);
      ok(res, { message: `Index "${req.params.index}" dropped.`, sql });
    }),
  );

  // ---- Views & triggers --------------------------------------------------

  router.get(
    '/api/views',
    wrap(async (_req, res) => {
      const r = await db.listViews();
      if (!r.success) return fail(res, r.error ?? 'Failed to list views.', 500);
      ok(res, r.data);
    }),
  );

  router.get(
    '/api/views/:name/rows',
    wrap(async (req, res) => {
      const r = await db.getViewRows(req.params.name);
      if (!r.success) return fail(res, r.error ?? 'Failed to read view.', 400);
      ok(res, { rows: ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow) });
    }),
  );

  router.post(
    '/api/views/generate',
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      const sql = String(req.body?.sql ?? '').trim();
      try {
        ok(res, { sql: generateCreateView(name, sql) });
      } catch (err) {
        fail(res, errorMessage(err));
      }
    }),
  );

  router.post(
    '/api/views',
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      const sql = String(req.body?.sql ?? '').trim();
      let genSql: string;
      try {
        genSql = generateCreateView(name, sql);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.createView(name, sql);
      if (!r.success) return fail(res, r.error ?? 'Failed to create view.', 400);
      ok(res, { message: `View "${name}" created.`, sql: genSql }, 201);
    }),
  );

  router.delete(
    '/api/views/:name',
    wrap(async (req, res) => {
      let genSql: string;
      try {
        genSql = generateDropView(req.params.name);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.dropView(req.params.name);
      if (!r.success) return fail(res, r.error ?? 'Failed to drop view.', 400);
      ok(res, { message: `View "${req.params.name}" dropped.`, sql: genSql });
    }),
  );

  router.get(
    '/api/triggers',
    wrap(async (_req, res) => {
      const r = await db.listTriggers();
      if (!r.success) return fail(res, r.error ?? 'Failed to list triggers.', 500);
      ok(res, r.data);
    }),
  );

  router.post(
    '/api/triggers/generate',
    wrap(async (req, res) => {
      try {
        ok(res, { sql: generateCreateTrigger((req.body ?? {}) as TriggerDef) });
      } catch (err) {
        fail(res, errorMessage(err));
      }
    }),
  );

  router.post(
    '/api/triggers',
    wrap(async (req, res) => {
      const def = (req.body ?? {}) as TriggerDef;
      let genSql: string;
      try {
        genSql = generateCreateTrigger(def);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.createTrigger(def);
      if (!r.success) return fail(res, r.error ?? 'Failed to create trigger.', 400);
      ok(res, { message: `Trigger "${def.name}" created.`, sql: genSql }, 201);
    }),
  );

  router.delete(
    '/api/triggers/:name',
    wrap(async (req, res) => {
      let genSql: string;
      try {
        genSql = generateDropTrigger(req.params.name);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.dropTrigger(req.params.name);
      if (!r.success) return fail(res, r.error ?? 'Failed to drop trigger.', 400);
      ok(res, { message: `Trigger "${req.params.name}" dropped.`, sql: genSql });
    }),
  );

  // ---- Query runner ------------------------------------------------------

  router.post(
    '/api/query',
    wrap(async (req, res) => {
      const sql = String(req.body?.sql ?? '').trim();
      if (!sql) return fail(res, 'SQL is required.');
      const { kind } = classifySql(sql);

      if (kind === 'count') {
        const r = await db.all(sql);
        if (!r.success) return fail(res, r.error ?? 'Query failed.', 400);
        const rows = (r.data ?? []) as Record<string, unknown>[];
        const first = rows[0];
        const val = first ? Object.values(first)[0] : 0;
        ok(res, { kind: 'count', count: Number(val ?? 0), message: `Total: ${val ?? 0}` });
        return;
      }

      if (kind === 'select' || kind === 'read') {
        const r = await db.all(sql);
        if (!r.success) return fail(res, r.error ?? 'Query failed.', 400);
        const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
        const columns = rows.length ? Object.keys(rows[0]) : [];
        ok(res, { kind: 'select', columns, rows });
        return;
      }

      // write
      if (db.isReadOnly) {
        return fail(res, 'Database is open in read-only mode — write statements are disabled.', 403);
      }
      const r = await db.runWrite(sql);
      if (!r.success) return fail(res, r.error ?? 'Query failed.', 400);
      const changes = r.data?.changes as number | undefined;
      ok(res, {
        kind: 'write',
        changes: changes ?? null,
        message: changes != null ? `${changes} row(s) affected.` : 'Statement executed successfully.',
      });
    }),
  );

  // ---- Saved queries -----------------------------------------------------

  router.get(
    '/api/queries',
    wrap(async (_req, res) => {
      const r = await db.listSavedQueries();
      if (!r.success) return fail(res, r.error ?? 'Failed to load queries.', 500);
      ok(res, r.data);
    }),
  );

  router.post(
    '/api/queries',
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      const sql = String(req.body?.sql ?? '').trim();
      if (!name) return fail(res, 'Query name is required.');
      if (!sql) return fail(res, 'Query SQL is required.');
      const r = await db.saveQuery(name, sql);
      if (!r.success) return fail(res, r.error ?? 'Failed to save query.', 400);
      ok(res, { message: 'Query saved.' }, 201);
    }),
  );

  router.delete(
    '/api/queries/:id',
    wrap(async (req, res) => {
      const r = await db.deleteSavedQuery(req.params.id);
      if (!r.success) return fail(res, r.error ?? 'Failed to delete query.', 400);
      ok(res, { message: 'Query deleted.' });
    }),
  );
}
