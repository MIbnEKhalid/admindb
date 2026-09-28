import type { Router, Request, Response } from 'express';
import type { ColumnDef, IndexDef } from '../../sql/generator';
import { type ApiContext, ok, fail, wrap, requireTable } from './helpers';
import { TableService } from '../../modules/tables/index';
import { SchemaService } from '../../modules/schema/index';

export function registerTableRoutes(router: Router, ctx: ApiContext): void {
  // ---- Tables ------------------------------------------------------------

  router.get('/api/tables/:db', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    try {
      const tables = await TableService.listTables(db);
      ok(res, tables);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to list tables.', 500);
    }
  }));

  router.get('/api/tables/:db/:table/info', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, info);
  }));

  router.get('/api/tables/:db/:table/fk-options', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const info = await requireTable(db, req.params.table);
    if (!info) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    const options = await TableService.getFkOptions(db, req.params.table, info);
    ok(res, options);
  }));

  router.get('/api/tables/:db/:table/ddl', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    try {
      const ddl = await TableService.getTableDdl(db, req.params.table);
      if (!ddl) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
      ok(res, { sql: ddl });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to fetch DDL.', 500);
    }
  }));

  router.post('/api/tables/:db/:table/rename', wrap(async (req, res) => {
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
    try {
      await TableService.dropTable(db, req.params.table);
      ok(res, { message: `Table "${req.params.table}" dropped.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to drop table.');
    }
  }));

  // ---- Bulk Table Operations -----------------------------------------------

  router.post('/api/tables/:db/bulk-drop', wrap(async (req, res) => {
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
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

  // ---- Columns -----------------------------------------------------------

  router.post('/api/tables/:db/:table/columns', wrap(async (req, res) => {
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
    try {
      await SchemaService.dropColumn(db, req.params.table, req.params.column);
      ok(res, { message: `Column "${req.params.column}" dropped.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to drop column.');
    }
  }));

  // ---- Indexes -----------------------------------------------------------

  router.post('/api/tables/:db/:table/indexes', wrap(async (req, res) => {
    const db = ctx.getDb(req);
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
    const db = ctx.getDb(req);
    try {
      await SchemaService.dropIndex(db, req.params.index);
      ok(res, { message: `Index "${req.params.index}" dropped.` });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to drop index.');
    }
  }));
}
