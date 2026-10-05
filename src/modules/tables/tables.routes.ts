import type { Router, Request, Response, NextFunction } from 'express';
import type { ColumnDef } from '../../sql/generator';
import { type RouteContext, type RequestParams, ok, fail, wrap, initPageLocals } from '../../core/router';
import { TableService } from './tables.service';

export function registerTableRoutes(router: Router, ctx: RouteContext): void {
  // ---- Page Routes -------------------------------------------------------

  router.get('/home/:db', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      const { tables: names } = initPageLocals(res, db, dbId, allNames);

      const homeData = await TableService.getHomeStats(db, names);

      res.render('pages/home', {
        title: 'Home',
        dbId,
        tables: names,
        counts: homeData.counts,
        cols: homeData.cols,
        totalRows: homeData.totalRows,
        dbPath: db.path,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/info/:db', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const dbInfo = await TableService.getDatabaseInfo(db);
      initPageLocals(res, db, dbId, dbInfo.tables);

      res.render('pages/info', {
        title: 'Database Info',
        dbId,
        settings: dbInfo.settings,
        dialect: dbInfo.dialect,
        dbPath: dbInfo.dbPath,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/export/:db', async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const data = await TableService.getSqlDump(db);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/sql; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(dbId)}-${stamp}.sql"`);
      res.send(data);
    } catch (err) {
      next(err);
    }
  });

  // ---- API Routes --------------------------------------------------------

  router.get('/api/tables/:db', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    try {
      const tables = await TableService.listTables(db);
      ok(res, tables);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to list tables.', 500);
    }
  }));

  router.get('/api/tables/:db/:table/info', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, info);
  }));

  router.get('/api/tables/:db/:table/fk-options', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const info = await TableService.getTableInfo(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const options = await TableService.getFkOptions(db, req.params.table, info);
    ok(res, options);
  }));

  router.get('/api/tables/:db/:table/ddl', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    try {
      const ddl = await TableService.getTableDdl(db, req.params.table);
      if (!ddl) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      ok(res, { sql: ddl });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to fetch DDL.', 500);
    }
  }));

  router.get('/api/info/:db/ddl', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    try {
      const dump = await TableService.getSchemaDump(db);
      ok(res, dump);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to export schema DDL.', 500);
    }
  }));

  router.post('/api/tables/:db/:table/rename', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const newName = String(req.body?.name ?? '').trim();
    if (!newName) return fail(res, 'New table name is required.');
    try {
      await TableService.renameTable(db, req.params.table, newName);
      ok(res, { message: `Table renamed to "${newName}".`, name: newName });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to rename table.');
    }
  }));

  router.delete('/api/tables/:db/:table', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    try {
      await TableService.dropTable(db, req.params.table);
      ok(res, { message: `Table "${req.params.table}" dropped.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to drop table.');
    }
  }));

  // ---- Bulk Table Operations ---------------------------------------------

  router.post('/api/tables/:db/bulk-drop', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const tables: string[] = Array.isArray(req.body?.tables)
      ? (req.body.tables as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];
    const force = Boolean(req.body?.force);
    if (tables.length === 0) return fail(res, 'No tables specified.');

    const { dropped, failed } = await TableService.bulkDropTables(db, tables, force);
    ok(res, {
      dropped,
      failed,
      message: `Dropped ${dropped.length} table(s)${failed.length ? `, ${failed.length} failed` : ''}.`,
    });
  }));

  router.post('/api/tables/:db/bulk-truncate', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const tables: string[] = Array.isArray(req.body?.tables)
      ? (req.body.tables as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];
    const force = Boolean(req.body?.force);
    if (tables.length === 0) return fail(res, 'No tables specified.');

    const { cleared, failed } = await TableService.bulkTruncateTables(db, tables, force);
    ok(res, {
      cleared,
      failed,
      message: `Cleared ${cleared.length} table(s)${failed.length ? `, ${failed.length} failed` : ''}.`,
    });
  }));

  router.post('/api/tables/:db/generate', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const columns = (req.body?.columns ?? []) as ColumnDef[];
    if (!name) return fail(res, 'Table name is required.');
    if (!Array.isArray(columns) || columns.length === 0) return fail(res, 'At least one column is required.');
    try {
      ok(res, { sql: TableService.generateCreateTableSql(name, columns) });
    } catch (err) {
      fail(res, (err as Error).message);
    }
  }));

  const createTableHandler = wrap(async (req: Request, res: Response) => {
    const db = ctx.getContext(req);
    const name = String(req.body?.name ?? '').trim();
    const columns = (req.body?.columns ?? []) as ColumnDef[];
    if (!name) return fail(res, 'Table name is required.');
    if (!Array.isArray(columns) || columns.length === 0) return fail(res, 'At least one column is required.');
    try {
      await TableService.createTable(db, name, columns);
      ok(res, { message: `Table "${name}" created.`, name }, 201);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to create table.');
    }
  });

  router.post('/api/tables/:db', createTableHandler);
  router.post('/api/tables/:db/create', createTableHandler);
}
