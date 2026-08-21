import type { Router, Request, Response } from 'express';
import type { SqliteDatabase, SQLInputValue, TableInfoData, WhereClause } from '../db/database';
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
  quoteIdentifier,
  type ColumnDef,
  type IndexDef,
} from '../sql/generator';
import { classifySql } from '../sql/classifier';
import { toCsv, toJson, parseCsv } from '../csv';
import { coerceFormValue, decodePk, errorMessage, normalizeCell, normalizeRow, parseFilters } from '../util';
import {
  buildColumnConfigs,
  buildSeedInsertSql,
  generateRows,
  sanitizeColumnPlan,
  MAX_SEED_ROWS,
  type ColumnPlan,
} from '../data/generator';

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

/**
 * Build the SET fields for an UPDATE from form values plus an explicit list of
 * columns to null out (the "clear to NULL" affordance of inline editing).
 */
function buildUpdateFields(
  info: TableInfoData,
  values: Record<string, unknown>,
  nulls: string[],
): { column: string; value: unknown }[] {
  const fields = buildFields(info, values, { excludePk: true });
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  const pkSet = new Set(info.primaryKey);
  for (const col of nulls) {
    if (pkSet.has(col) || !typeMap.has(col)) continue;
    if (fields.some((f) => f.column === col)) continue;
    fields.push({ column: col, value: null });
  }
  return fields;
}

function pkWhere(info: TableInfoData, encodedId: string): { column: string; value: unknown }[] | null {
  const vals = decodePk(encodedId);
  if (!info.primaryKey.length) {
    if (vals.length === 1 && vals[0] !== '') {
      const num = Number(vals[0]);
      return [{ column: '_rowid_', value: Number.isFinite(num) ? num : vals[0] }];
    }
    return null;
  }
  if (vals.length !== info.primaryKey.length) return null;
  const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
  return info.primaryKey.map((col, i) => ({ column: col, value: coerceFormValue(vals[i], typeMap.get(col)!) }));
}

/** Hard cap on how many rows can be selected for a bulk operation at once. */
const MAX_BULK_ROWS = 1000;

/**
 * Parse and clamp the seed request body `{ count, plan, truncate }` into a safe row count,
 * truncate flag, and a per-column plan map (each plan sanitized against known keys).
 * Per-column strategy validity is enforced later by `generateRows` against the table config.
 */
function parseSeedRequest(body: unknown): { count: number; plan: Record<string, ColumnPlan>; truncate: boolean } {
  const b = (body ?? {}) as { count?: unknown; plan?: unknown; truncate?: unknown };
  const count = Math.max(1, Math.min(MAX_SEED_ROWS, Number.parseInt(String(b.count ?? '10'), 10) || 10));
  const truncate = Boolean(b.truncate);
  const plan: Record<string, ColumnPlan> = {};
  if (b.plan && typeof b.plan === 'object') {
    for (const [k, v] of Object.entries(b.plan as Record<string, unknown>)) {
      const p = sanitizeColumnPlan(v);
      if (p) plan[k] = p;
    }
  }
  return { count, plan, truncate };
}

/**
 * Turn a list of encoded primary-key ids (from the grid's row checkboxes) into
 * the WHERE clauses needed to address each row. Returns null when the table has
 * no usable primary key or when none of the ids resolve.
 */
function resolvePkRows(info: TableInfoData, ids: unknown): WhereClause[][] | null {
  const list = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
  const out: WhereClause[][] = [];
  for (const id of list) {
    const where = pkWhere(info, String(id));
    if (where) out.push(where);
  }
  return out.length ? out : null;
}

/**
 * How many rows in OTHER tables reference any of the selected rows (via foreign
 * keys pointing at the selected table). Used to warn before a bulk delete —
 * those rows may be cascaded away or orphaned depending on the FK action.
 */
async function computeBulkImpact(
  db: SqliteDatabase,
  info: TableInfoData,
  wheres: WhereClause[][],
): Promise<{ references: { table: string; from: string; to: string; count: number }[]; total: number }> {
  const rowsR = await db.getRowsByPks(info.table, wheres);
  const rows = (rowsR.data ?? []) as Record<string, unknown>[];
  const refsR = await db.getReferencingTables(info.table);
  const references: { table: string; from: string; to: string; count: number }[] = [];
  const toColumn = (to: string): string | null => to || info.primaryKey[0] || info.columns[0]?.name || null;

  for (const rt of refsR.data ?? []) {
    if (rt.table.startsWith('_')) continue;
    for (const ref of rt.refs) {
      const col = toColumn(ref.to);
      if (!col) continue;
      // Deduplicate the referenced values (preserving their native type).
      const byStr = new Map<string, unknown>();
      for (const row of rows) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        byStr.set(String(normalizeCell(v)), v);
      }
      if (!byStr.size) continue;
      const values = [...byStr.values()] as SQLInputValue[];
      const placeholders = values.map(() => '?').join(', ');
      const cR = await db.all(
        `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rt.table)} WHERE ${quoteIdentifier(ref.from)} IN (${placeholders})`,
        values,
      );
      const count = Number(((cR.data ?? [])[0] as { c?: number | bigint })?.c ?? 0);
      if (count > 0) references.push({ table: rt.table, from: ref.from, to: ref.to, count });
    }
  }
  return { references, total: references.reduce((n, r) => n + r.count, 0) };
}

export function registerApi(router: Router, ctx: ApiContext): void {
  const { db, logger } = ctx;

  // In read-only mode every mutating request is rejected (GET, the generate-only
  // preview endpoints and the query runner stay available; the query runner
  // rejects write statements itself).
  router.use((req: Request, res: Response, next: import('express').NextFunction) => {
    if (!db.isReadOnly || req.method === 'GET') return next();
    const p = req.path;
    if (
      p.endsWith('/generate') ||
      p.endsWith('/api/query/export') ||
      p.endsWith('/api/query') ||
      p.endsWith('/rows/bulk-impact') ||
      p.endsWith('/rows/bulk-export')
    ) {
      return next();
    }
    return res.status(403).json({ success: false, error: 'Database is open in read-only mode — write operations are disabled.' });
  });

  // ---- Tables ------------------------------------------------------------

  router.get('/api/tables', wrap(async (_req, res) => {
    const r = await db.listTables();
    if (!r.success) return fail(res, r.error ?? 'Failed to list tables.', 500);
    ok(res, r.data);
  }),
  );

  router.get('/api/tables/:table/info', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, info);
  }),
  );

  router.get('/api/tables/:table/fk-options', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const options: Record<string, { value: unknown; label: string }[]> = {};
    for (const fk of info.foreignKeys) {
      try {
        const refInfo = await requireTable(db, fk.table);
        if (!refInfo) continue;
        // The FK may reference a non-PK unique column (e.g. Users.UserName),
        // so the option value must be the referenced column's value, not the
        // referenced table's primary key.
        const refCol = fk.to || refInfo.primaryKey[0] || refInfo.columns[0]?.name;
        const pk = refInfo.primaryKey[0] ?? refInfo.columns[0]?.name;
        const labelCols = refInfo.columns.filter((c) => c.name !== pk).slice(0, 2).map((c) => c.name);
        const rowsR = await db.getAllRows(fk.table);
        const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).slice(0, 500);
        options[fk.from] = rows.map((row) => ({
          value: row[refCol],
          label: labelCols.length ? labelCols.map((c) => String(row[c] ?? '')).join(' · ') : String(row[refCol] ?? ''),
        }));
      } catch (err) {
        logger.warn(`fk-options for ${fk.from}: ${errorMessage(err)}`);
      }
    }
    ok(res, options);
  }),
  );

  router.get('/api/tables/:table/rows', wrap(async (req, res) => {
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

  // Related rows: rows in other tables whose foreign keys point at this row.
  router.get('/api/tables/:table/rows/:id/references', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    if (!info.primaryKey.length) return fail(res, `Table "${req.params.table}" has no primary key, so related rows cannot be resolved.`, 400);
    const pk = decodePk(req.params.id);
    if (pk.length !== info.primaryKey.length) return fail(res, 'Invalid row id.', 400);
    const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
    const where = info.primaryKey.map((col, i) => ({ column: col, value: coerceFormValue(pk[i], typeMap.get(col)!) }));
    const rowR = await db.getRow(req.params.table, where);
    if (!rowR.success || !rowR.data) return fail(res, 'Row not found.', 404);
    const row = rowR.data as Record<string, unknown>;

    const refsR = await db.getReferencingTables(req.params.table);
    if (!refsR.success) return fail(res, refsR.error ?? 'Failed to load references.', 500);

    const references: {
      table: string;
      from: string;
      to: string;
      value: unknown;
      count: number;
      columns: string[];
      rows: Record<string, unknown>[];
    }[] = [];
    for (const rt of refsR.data ?? []) {
      if (rt.table.startsWith('_')) continue;
      const refInfo = await requireTable(db, rt.table);
      if (!refInfo) continue;
      for (const ref of rt.refs) {
        const value = row[ref.to];
        if (value === null || value === undefined) continue;
        const r = await db.getRowsByFk(rt.table, ref.from, value, 50);
        if (!r.success) continue;
        references.push({
          table: rt.table,
          from: ref.from,
          to: ref.to,
          value: normalizeCell(value),
          count: r.data!.total,
          columns: refInfo.columns.map((c) => c.name),
          rows: r.data!.rows.map(normalizeRow),
        });
      }
    }
    ok(res, { references });
  }),
  );

  // ---- Export / import ---------------------------------------------------

  router.get('/api/tables/:table/export', wrap(async (req, res) => {
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

  router.post('/api/tables/:table/rows/import', wrap(async (req, res) => {
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

  router.post('/api/query/export', wrap(async (req, res) => {
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

  router.get('/api/tables/:table/row/:id', wrap(async (req, res) => {
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

  router.post('/api/tables/:table/rows', wrap(async (req, res) => {
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

  router.post('/api/tables/:table/rows/generate', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const values = (req.body?.values ?? {}) as Record<string, unknown>;
    const fields = buildFields(info, values);
    if (!fields.length) return fail(res, 'No values provided.');
    ok(res, { sql: generateInsert(req.params.table, fields) });
  }),
  );

  router.put('/api/tables/:table/row/:id', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);
    const values = (req.body?.values ?? {}) as Record<string, unknown>;
    const nulls = Array.isArray(req.body?.nulls) ? (req.body.nulls as unknown[]).map(String) : [];
    const fields = buildUpdateFields(info, values, nulls);
    if (!fields.length) return fail(res, 'No fields to update.');
    const sql = generateUpdate(req.params.table, fields, where);
    const r = await db.updateRow(req.params.table, fields, where);
    if (!r.success) return fail(res, r.error ?? 'Update failed.', 400);
    ok(res, { message: 'Row updated.', sql });
  }),
  );

  router.put('/api/tables/:table/row/:id/generate', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);
    const values = (req.body?.values ?? {}) as Record<string, unknown>;
    const nulls = Array.isArray(req.body?.nulls) ? (req.body.nulls as unknown[]).map(String) : [];
    const fields = buildUpdateFields(info, values, nulls);
    if (!fields.length) return fail(res, 'No fields to update.');
    ok(res, { sql: generateUpdate(req.params.table, fields, where) });
  }),
  );

  router.delete('/api/tables/:table/row/:id', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const where = pkWhere(info, req.params.id);
    if (!where) return fail(res, 'Invalid primary key.', 400);
    const r = await db.deleteRow(req.params.table, where);
    if (!r.success) return fail(res, r.error ?? 'Delete failed.', 400);
    ok(res, { message: 'Row deleted.' });
  }),
  );

  // ---- Bulk row operations -----------------------------------------------

  /**
   * FK-impact preview: how many rows in other tables reference the selected
   * rows. Shown to the user before a bulk delete so cascades/orphaning are
   * understood up front.
   */
  router.post('/api/tables/:table/rows/bulk-impact', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const wheres = resolvePkRows(info, (req.body ?? {}).ids);
    if (!wheres || !wheres.length) return fail(res, 'No valid rows selected.', 400);
    if (wheres.length > MAX_BULK_ROWS) return fail(res, `Select at most ${MAX_BULK_ROWS} rows at a time.`, 400);
    const impact = await computeBulkImpact(db, info, wheres);
    ok(res, { selected: wheres.length, references: impact.references, total: impact.total });
  }),
  );

  /**
   * Bulk delete the selected rows inside a single transaction. When other
   * tables reference them, the client must acknowledge the impact
   * (`confirmImpact: true`) — this is the safety net behind the UI warning.
   */
  router.post('/api/tables/:table/rows/bulk-delete', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const body = (req.body ?? {}) as { ids?: unknown; confirmImpact?: unknown };
    const wheres = resolvePkRows(info, body.ids);
    if (!wheres || !wheres.length) return fail(res, 'No valid rows selected.', 400);
    if (wheres.length > MAX_BULK_ROWS) return fail(res, `Select at most ${MAX_BULK_ROWS} rows at a time.`, 400);
    const impact = await computeBulkImpact(db, info, wheres);
    if (impact.total > 0 && body.confirmImpact !== true) {
      return res.status(409).json({
        success: false,
        error: 'These rows are referenced by other tables. Confirm the impact before deleting.',
        data: { references: impact.references, total: impact.total },
      });
    }
    const r = await db.deleteRows(req.params.table, wheres);
    if (!r.success) return fail(res, r.error ?? 'Bulk delete failed.', 400);
    ok(res, { message: `Deleted ${r.data?.deleted ?? 0} row(s).`, deleted: r.data?.deleted ?? 0 });
  }),
  );

  /**
   * Export only the selected rows (CSV or JSON). The content is returned in the
   * JSON envelope so the client can trigger a download without a full page reload.
   */
  router.post('/api/tables/:table/rows/bulk-export', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const body = (req.body ?? {}) as { ids?: unknown; format?: unknown };
    const wheres = resolvePkRows(info, body.ids);
    if (!wheres || !wheres.length) return fail(res, 'No valid rows selected.', 400);
    if (wheres.length > MAX_BULK_ROWS) return fail(res, `Select at most ${MAX_BULK_ROWS} rows at a time.`, 400);
    const format = String(body.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const rowsR = await db.getRowsByPks(req.params.table, wheres);
    if (!rowsR.success) return fail(res, rowsR.error ?? 'Export failed.', 500);
    const rows = ((rowsR.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);
    const content = format === 'json' ? toJson(rows) : toCsv(rows, columns);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    ok(res, {
      format,
      filename: `${req.params.table}-selected-${stamp}.${format}`,
      content,
      rowCount: rows.length,
    });
  }),
  );

  /**
   * Apply staged inline-grid edits: update many cells across many rows inside a
   * single transaction. Each entry is `{ id, values?, nulls? }` where `id` is
   * the encoded primary key. This is the "Apply" step of the Neon-style
   * spreadsheet editing flow (edits are buffered client-side until this runs).
   */
  router.post('/api/tables/:table/rows/bulk-update', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const updates = Array.isArray(req.body?.updates) ? (req.body.updates as unknown[]) : [];
    if (!updates.length) return fail(res, 'No changes to apply.', 400);
    if (updates.length > MAX_BULK_ROWS) return fail(res, `Select at most ${MAX_BULK_ROWS} rows at a time.`, 400);

    const rows: { fields: { column: string; value: unknown }[]; where: WhereClause[] }[] = [];
    for (const u of updates) {
      const entry = (u ?? {}) as { id?: unknown; values?: unknown; nulls?: unknown };
      const where = pkWhere(info, String(entry.id ?? ''));
      if (!where) continue;
      const fields = buildUpdateFields(
        info,
        (entry.values ?? {}) as Record<string, unknown>,
        Array.isArray(entry.nulls) ? (entry.nulls as unknown[]).map(String) : [],
      );
      if (fields.length) rows.push({ fields, where });
    }
    if (!rows.length) return fail(res, 'No fields to update.', 400);

    const r = await db.updateRows(req.params.table, rows);
    if (!r.success) return fail(res, r.error ?? 'Update failed.', 400);
    ok(res, {
      message: `Applied ${r.data?.updated ?? 0} row change(s).`,
      updated: r.data?.updated ?? 0,
    });
  }),
  );

  // ---- Data generator / seeder ------------------------------------------

  // Per-column generator config (strategies + detected defaults) for the
  // "Seed data" page.
  router.get('/api/tables/:table/seed/config', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, { table: req.params.table, columns: buildColumnConfigs(info), maxRows: MAX_SEED_ROWS });
  }),
  );

  // Preview: generate the rows and return the INSERT statements without
  // executing them (the "/generate" suffix keeps it available in read-only).
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
  }),
  );

  // Insert the generated rows inside a single transaction.
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
  }),
  );

  // ---- Create table (run + generate) ------------------------------------

  router.post('/api/tables', wrap(async (req, res) => {
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

  router.post('/api/tables/generate', wrap(async (req, res) => {
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

  router.get('/api/tables/:table/schema', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const r = await db.getSchema(req.params.table);
    if (!r.success) return fail(res, r.error ?? 'Failed to load schema.', 500);
    ok(res, r.data);
  }),
  );

  router.post('/api/tables/:table/rename', wrap(async (req, res) => {
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

  router.post('/api/tables/:table/columns', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const col = (req.body?.column ?? req.body ?? null) as unknown;
    if (!col || typeof col !== 'object') return fail(res, 'Column definition is required.');
    const colDef = col as ColumnDef;
    let sql: string | undefined;
    try {
      sql = generateAddColumn(req.params.table, { ...colDef, unique: false });
    } catch {
      /* ignore preview sql error if table recreation is needed */
    }
    const r = await db.addColumn(req.params.table, colDef);
    if (!r.success) return fail(res, r.error ?? 'Failed to add column.', 400);
    ok(res, { message: `Column "${String(colDef.name)}" added.`, sql }, 201);
  }),
  );

  router.put('/api/tables/:table/columns/:column', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const oldCol = req.params.column;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const col = (body.column ?? body) as ColumnDef;
    const newName = String(col.name ?? body.name ?? oldCol).trim();

    // If only renaming and no type/constraint modifications were passed:
    const isOnlyRename = col.type === undefined && col.notNull === undefined && col.unique === undefined && col.primaryKey === undefined && col.defaultValue === undefined && col.foreignKey === undefined;

    if (isOnlyRename && newName !== oldCol) {
      let sql: string;
      try {
        sql = generateRenameColumn(req.params.table, oldCol, newName);
      } catch (err) {
        return fail(res, errorMessage(err));
      }
      const r = await db.renameColumn(req.params.table, oldCol, newName);
      if (!r.success) return fail(res, r.error ?? 'Failed to rename column.', 400);
      return ok(res, { message: `Column renamed to "${newName}".`, sql });
    }

    const colDef: ColumnDef = {
      name: newName,
      type: col.type || 'TEXT',
      notNull: !!col.notNull,
      unique: !!col.unique,
      primaryKey: !!col.primaryKey,
      defaultValue: col.defaultValue !== undefined ? (!String(col.defaultValue ?? '').trim() ? null : String(col.defaultValue).trim()) : undefined,
      foreignKey: col.foreignKey || null,
    };

    const r = await db.modifyColumn(req.params.table, oldCol, colDef);
    if (!r.success) return fail(res, r.error ?? 'Failed to modify column.', 400);
    ok(res, { message: `Column "${oldCol}" updated.`, column: colDef });
  }),
  );

  router.delete('/api/tables/:table/columns/:column', wrap(async (req, res) => {
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

  router.delete('/api/tables/:table', wrap(async (req, res) => {
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

  router.post('/api/tables/:table/indexes', wrap(async (req, res) => {
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

  router.delete('/api/tables/:table/indexes/:index', wrap(async (req, res) => {
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

  // ---- Query runner ------------------------------------------------------

  router.post('/api/query', wrap(async (req, res) => {
    const sql = String(req.body?.sql ?? '').trim();
    if (!sql) return fail(res, 'SQL is required.');

    // Scripts (more than one statement, e.g. a schema/migration script) cannot
    // be represented as a single prepared statement, so run them via `exec`.
    if (db.hasMultipleStatements(sql)) {
      if (db.isReadOnly) {
        return fail(res, 'Database is open in read-only mode — write statements are disabled.', 403);
      }
      const r = await db.execResult(sql);
      if (!r.success) return fail(res, r.error ?? 'Query failed.', 400);
      ok(res, { kind: 'write', changes: null, message: 'Statement(s) executed successfully.' });
      return;
    }

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

  router.get('/api/queries', wrap(async (_req, res) => {
    const r = await db.listSavedQueries();
    if (!r.success) return fail(res, r.error ?? 'Failed to load queries.', 500);
    ok(res, r.data);
  }),
  );

  router.post('/api/queries', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const sql = String(req.body?.sql ?? '').trim();
    if (!name) return fail(res, 'Query name is required.');
    if (!sql) return fail(res, 'Query SQL is required.');
    const r = await db.saveQuery(name, sql);
    if (!r.success) return fail(res, r.error ?? 'Failed to save query.', 400);
    ok(res, { message: 'Query saved.' }, 201);
  }),
  );

  router.delete('/api/queries/:id', wrap(async (req, res) => {
    const r = await db.deleteSavedQuery(req.params.id);
    if (!r.success) return fail(res, r.error ?? 'Failed to delete query.', 400);
    ok(res, { message: 'Query deleted.' });
  }),
  );
}
