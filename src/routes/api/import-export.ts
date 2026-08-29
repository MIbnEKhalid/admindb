import type { Router, Request, Response } from 'express';
import { parseFilters, normalizeRow, coerceFormValue } from '../../utils/common';
import { toCsv, toJson, parseCsv } from '../../utils/csv';
import { type ApiContext, ok, fail, wrap, requireTable } from './helpers';

export function registerImportExportRoutes(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  router.get('/api/tables/:table/export', wrap(async (req, res) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const format = String(req.query.format ?? 'csv').toLowerCase();
    const filters = parseFilters(req.query.f);
    const r = await db.getRows(req.params.table, { limit: 1_000_000, filters });
    if (!r.success) return fail(res, r.error ?? 'Failed to export table.');
    const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = info.columns.map((c) => c.name);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}.json"`);
      return res.send(toJson(rows));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}.csv"`);
    res.send(toCsv(rows, columns));
  }));

  const importCsvHandler = wrap(async (req: Request, res: Response) => {
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);

    const csvText = typeof req.body === 'string' ? req.body : String(req.body?.csv ?? '');
    if (!csvText.trim()) return fail(res, 'No CSV data provided.');

    const parsed = parseCsv(csvText);
    if (!parsed.length) return fail(res, 'CSV file is empty.');

    const header = parsed[0].map((h) => h.trim());
    const typeMap = new Map(info.columns.map((c) => [c.name, c.type]));
    const validCols = header.filter((h) => typeMap.has(h));
    if (!validCols.length) {
      return fail(res, 'None of the CSV columns match columns in this table.');
    }

    const rows = parsed.slice(1).map((line) => {
      const fields: { column: string; value: unknown }[] = [];
      for (let i = 0; i < header.length; i++) {
        const col = header[i];
        if (!typeMap.has(col)) continue;
        fields.push({ column: col, value: coerceFormValue(line[i] ?? '', typeMap.get(col)!) });
      }
      return fields;
    });

    const r = await db.insertRows(req.params.table, rows);
    if (!r.success) return fail(res, r.error ?? 'Failed to import CSV.');
    ok(res, { message: `${r.data?.inserted ?? 0} row(s) imported.`, inserted: r.data?.inserted });
  });

  router.post('/api/tables/:table/import', importCsvHandler);
  router.post('/api/tables/:table/rows/import', importCsvHandler);
  router.post('/api/tables/:table/import/csv', importCsvHandler);

  router.post('/api/query/export', wrap(async (req, res) => {
    const sql = String(req.body?.sql ?? '').trim();
    const format = String(req.body?.format ?? 'csv').toLowerCase();
    if (!sql) return fail(res, 'SQL query is required.');

    const r = await db.all(sql);
    if (!r.success) return fail(res, r.error ?? 'Query failed.', 400);

    const rows = ((r.data ?? []) as Record<string, unknown>[]).map(normalizeRow);
    const columns = rows.length ? Object.keys(rows[0]) : [];

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="query_results.json"');
      return res.send(toJson(rows));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="query_results.csv"');
    res.send(toCsv(rows, columns));
  }));
}
