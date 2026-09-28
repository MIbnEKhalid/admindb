import type { Router, Request, Response, NextFunction } from 'express';
import type { ColumnDef, IndexDef } from '../../sql/generator';
import { type RouteContext, ok, fail, wrap, notFound, initPageLocals } from '../../core/router';
import { TableService } from '../tables/tables.service';
import { SchemaService } from './schema.service';

export function registerSchemaRoutes(router: Router, ctx: RouteContext): void {
  // ---- Page Routes -------------------------------------------------------

  router.get('/schema/:db/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const [info, schema] = await Promise.all([
        TableService.getTableInfo(db, table),
        SchemaService.getSchema(db, table),
      ]);
      if (!info) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      res.locals.currentTable = table;
      res.render('pages/schema', {
        title: `Schema · ${table}`,
        dbId,
        table,
        schema,
        isInternal: table.startsWith('_'),
        dialect: db.dialect.name,
        isSqlite: db.dialect.name === 'sqlite',
        isPostgres: db.dialect.name === 'postgres',
        config: { dbId, table, isInternal: table.startsWith('_'), dialect: db.dialect.name },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/designer/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      res.render('pages/designer', {
        title: 'New table',
        dbId,
        dialect: db.dialect.name,
        isSqlite: db.dialect.name === 'sqlite',
        isPostgres: db.dialect.name === 'postgres',
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/designer/:db/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const [info, schema] = await Promise.all([
        TableService.getTableInfo(db, table),
        SchemaService.getSchema(db, table),
      ]);
      if (!info) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      res.locals.currentTable = table;
      res.render('pages/designer', {
        title: `Edit table · ${table}`,
        dbId,
        table,
        info,
        schema,
        dialect: db.dialect.name,
        isSqlite: db.dialect.name === 'sqlite',
        isPostgres: db.dialect.name === 'postgres',
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- API Routes --------------------------------------------------------

  router.get('/api/tables/:db/:table/schema', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const schema = await SchemaService.getSchema(db, req.params.table);
    ok(res, schema);
  }));

  router.post('/api/tables/:db/:table/columns', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const col = req.body as ColumnDef;
    if (!col?.name) return fail(res, 'Column name is required.');
    try {
      await SchemaService.addColumn(db, req.params.table, col);
      ok(res, { message: `Column "${col.name}" added.` }, 201);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to add column.');
    }
  }));

  router.put('/api/tables/:db/:table/columns/:column', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const col = req.body as ColumnDef;
    if (!col) return fail(res, 'Column definition is required.');
    try {
      await SchemaService.modifyColumn(db, req.params.table, req.params.column, col);
      ok(res, { message: `Column "${req.params.column}" updated.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to modify column.');
    }
  }));

  router.post('/api/tables/:db/:table/columns/:column/rename', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const newName = String(req.body?.name ?? '').trim();
    if (!newName) return fail(res, 'New column name is required.');
    try {
      await SchemaService.renameColumn(db, req.params.table, req.params.column, newName);
      ok(res, { message: `Column renamed to "${newName}".`, name: newName });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to rename column.');
    }
  }));

  router.delete('/api/tables/:db/:table/columns/:column', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    try {
      await SchemaService.dropColumn(db, req.params.table, req.params.column);
      ok(res, { message: `Column "${req.params.column}" dropped.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to drop column.');
    }
  }));

  router.post('/api/tables/:db/:table/indexes', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    const def = req.body as IndexDef;
    if (!def || !Array.isArray(def.columns) || def.columns.length === 0) {
      return fail(res, 'At least one column is required for an index.');
    }
    try {
      await SchemaService.createIndex(db, req.params.table, def);
      ok(res, { message: 'Index created.' }, 201);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to create index.');
    }
  }));

  router.delete('/api/tables/:db/:table/indexes/:index', wrap(async (req, res) => {
    const db = ctx.getContext(req);
    try {
      await SchemaService.dropIndex(db, req.params.index);
      ok(res, { message: `Index "${req.params.index}" dropped.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to drop index.');
    }
  }));
}
