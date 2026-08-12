import type { Router, Request, Response, NextFunction } from 'express';
import type { SqliteDatabase, TableInfoData } from '../db/database';
import type { Logger } from '../logger';
import { generateSqlDump } from '../db/export';
import { decodePk, encodePk, normalizeCell, parseFilters, filtersToQS } from '../util';

interface PageContext {
  db: SqliteDatabase;
  logger: Logger;
}

interface DisplayCell {
  name: string;
  value: unknown;
  isNull: boolean;
  display: string;
}

interface DisplayRow {
  cells: DisplayCell[];
  pkEncoded: string | null;
}

function buildDisplayRows(rawRows: Record<string, unknown>[], info: TableInfoData): DisplayRow[] {
  const pkCols = info.primaryKey;
  return rawRows.map((row) => ({
    cells: info.columns.map((c) => {
      const v = normalizeCell(row[c.name]);
      return { name: c.name, value: v, isNull: v === null || v === undefined, display: v == null ? '' : String(v) };
    }),
    pkEncoded: pkCols.length ? encodePk(pkCols.map((c) => row[c])) : null,
  }));
}

export function registerPages(router: Router, ctx: PageContext): void {
  const { db } = ctx;

  const notFound = (res: Response, message: string): void => {
    res.status(404).render('pages/error', { title: 'Not found', status: 404, error: message });
  };

  // Home / browse overview.
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tables = await db.listTables();
      const allNames = (tables.data ?? []).map((t) => t.name);
      const names = allNames.filter((n) => !n.startsWith('_'));
      const internalNames = allNames.filter((n) => n.startsWith('_'));
      const counts: Record<string, number> = {};
      const cols: Record<string, number> = {};
      let totalRows = 0;
      for (const name of names) {
        const c = await db.getRowCount(name);
        counts[name] = c.success ? (c.data as number) : 0;
        totalRows += counts[name];
        const info = await db.getTableInfo(name);
        cols[name] = info.success ? (info.data?.columns.length ?? 0) : 0;
      }
      const saved = await db.listSavedQueries();
      res.render('pages/home', {
        title: 'Home',
        tables: names,
        counts,
        cols,
        totalRows,
        savedQueries: saved.success ? (saved.data?.length ?? 0) : 0,
        internalCount: internalNames.length,
        dbPath: db.path,
      });
    } catch (err) {
      next(err);
    }
  });

  // Browse a table's rows.
  router.get('/tables/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }

      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const pageSize = Math.max(1, Number.parseInt(String(req.query.size ?? '50'), 10) || 50);
      const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
      const orderDir = String(req.query.orderDir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      const filters = parseFilters(req.query.f);
      const filterQS = filtersToQS(filters);

      const countR = await db.getRowCount(table, filters);
      const rowsR = await db.getRows(table, { page, limit: pageSize, orderBy, orderDir, filters });
      const count = countR.success ? (countR.data as number) : 0;
      const rows = buildDisplayRows((rowsR.data ?? []) as Record<string, unknown>[], info.data);
      const pages = Math.max(1, Math.ceil(count / pageSize));
      const basePath = String(res.locals.basePath ?? '');
      const sizes = [25, 50, 100, 250];
      const colHeaders = info.data.columns.map((c) => {
        const active = c.name === orderBy;
        const nextDir = active ? (orderDir === 'asc' ? 'desc' : 'asc') : 'asc';
        const qs = `page=1&size=${pageSize}&orderBy=${encodeURIComponent(c.name)}&orderDir=${nextDir}`;
        return {
          name: c.name,
          pk: c.pk,
          type: c.type,
          active,
          dir: active ? orderDir : null,
          href: `${basePath}/tables/${encodeURIComponent(table)}?${qs}${filterQS ? '&' + filterQS : ''}`,
        };
      });

      res.locals.currentTable = table;
      res.render('pages/table', {
        title: table,
        table,
        info: info.data,
        rows,
        count,
        page,
        pageSize,
        pages,
        pkCols: info.data.primaryKey,
        colNames: info.data.columns.map((c) => c.name),
        colHeaders,
        orderBy: orderBy ?? '',
        orderDir,
        sizes,
        filters,
        filterQS,
        firstRow: count === 0 ? 0 : (page - 1) * pageSize + 1,
        lastRow: Math.min(page * pageSize, count),
      });
    } catch (err) {
      next(err);
    }
  });

  // Table schema editor.
  router.get('/tables/:table/schema', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const schema = await db.getSchema(table);
      if (!schema.success || !schema.data) {
        return notFound(res, schema.error ?? 'Failed to load schema.');
      }
      res.locals.currentTable = table;
      res.render('pages/schema', {
        title: `Schema · ${table}`,
        table,
        schema: schema.data,
        isInternal: table.startsWith('_'),
        config: { table, isInternal: table.startsWith('_') },
      });
    } catch (err) {
      next(err);
    }
  });

  // Insert form (dynamic form is built client-side from API metadata).
  router.get('/tables/:table/rows/new', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.data.primaryKey;
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `New row · ${table}`,
        table,
        mode: 'insert',
        pk: null,
        pkColumns,
        infoSummary: `${info.data.columns.length} column(s)` + (pkColumns.length ? ` · PK: ${pkColumns.join(', ')}` : ''),
        config: { table, mode: 'insert', pk: null, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  // Edit form.
  router.get('/tables/:table/rows/:id/edit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.data.primaryKey;
      if (!pkColumns.length) {
        return notFound(res, `Table "${table}" has no primary key, so rows cannot be edited from the UI.`);
      }
      const pk = decodePk(req.params.id);
      if (pk.length !== pkColumns.length) {
        return notFound(res, 'Invalid primary key.');
      }
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `Edit row · ${table}`,
        table,
        mode: 'edit',
        pk,
        pkColumns,
        infoSummary: `${info.data.columns.length} column(s) · PK: ${pkColumns.join(', ')}`,
        config: { table, mode: 'edit', pk, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  // Table designer.
  router.get('/designer', (_req: Request, res: Response) => {
    res.render('pages/designer', { title: 'New table' });
  });

  // Query editor.
  router.get('/query', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const queries = await db.listSavedQueries();
      res.render('pages/query', { title: 'Query editor', savedQueries: queries.success ? queries.data : [] });
    } catch (err) {
      next(err);
    }
  });

  // Views list + create.
  router.get('/views', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const views = await db.listViews();
      res.render('pages/views', {
        title: 'Views',
        views: views.success ? views.data : [],
        config: {},
      });
    } catch (err) {
      next(err);
    }
  });

  // Triggers list + create.
  router.get('/triggers', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [triggers, tables] = await Promise.all([db.listTriggers(), db.listTables()]);
      res.render('pages/triggers', {
        title: 'Triggers',
        triggers: triggers.success ? triggers.data : [],
        tables: (tables.data ?? []).map((t) => t.name).filter((n) => !n.startsWith('_')),
        config: {},
      });
    } catch (err) {
      next(err);
    }
  });

  // Export: downloadable SQL dump.
  router.get('/export', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const dump = await generateSqlDump(db);
      if (!dump.success || !dump.data) throw new Error(dump.error ?? 'Failed to generate dump.');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/sql; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dbadmin-${stamp}.sql"`);
      res.send(dump.data);
    } catch (err) {
      next(err);
    }
  });
}
