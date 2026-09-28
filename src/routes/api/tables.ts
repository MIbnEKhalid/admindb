import type { Router, Request, Response } from 'express';
import { generateCreateTable, quoteIdentifier, type ColumnDef, type IndexDef } from '../../sql/generator';
import { type ApiContext, ok, fail, wrap, requireTable } from './helpers';

export function registerTableRoutes(router: Router, ctx: ApiContext): void {
  // ---- Tables ------------------------------------------------------------

  router.get('/api/tables/:db', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const r = await db.listTables();
    if (!r.success) return fail(res, r.error ?? 'Failed to list tables.', 500);
    ok(res, r.data);
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
    const options: Record<string, { value: unknown; label: string }[]> = {};
    for (const fk of info.foreignKeys) {
      try {
        const refInfo = await requireTable(db, fk.table);
        if (!refInfo) continue;
        const refCol = fk.to || refInfo.primaryKey[0] || refInfo.columns[0]?.name;
        const pk = refInfo.primaryKey[0] ?? refInfo.columns[0]?.name;
        const labelCol = refInfo.columns.find((c) => /name|title|label|username|email/i.test(c.name))?.name ?? pk;
        const rows = await db.getRows(fk.table, { limit: 100, orderBy: labelCol });
        if (rows.success && rows.data) {
          options[fk.from] = rows.data.map((r) => ({
            value: r[refCol],
            label: r[labelCol] != null ? `${r[labelCol]} (${r[refCol]})` : String(r[refCol]),
          }));
        }
      } catch {}
    }
    ok(res, options);
  }));

  router.get('/api/tables/:db/:table/ddl', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const r = await db.getCreateStatement(req.params.table);
    if (!r.success) return fail(res, r.error ?? 'Failed to fetch DDL.', 500);
    if (!r.data) return fail(res, `Table "${req.params.table}" does not exist.`, 404);
    ok(res, { sql: r.data });
  }));

  router.post('/api/tables/:db/:table/rename', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const newName = String(req.body?.name ?? '').trim();
    if (!newName) return fail(res, 'New table name is required.');
    const r = await db.renameTable(req.params.table, newName);
    if (!r.success) return fail(res, r.error ?? 'Failed to rename table.');
    ok(res, { message: `Table renamed to "${newName}".`, name: newName });
  }));

  router.delete('/api/tables/:db/:table', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const r = await db.dropTable(req.params.table);
    if (!r.success) return fail(res, r.error ?? 'Failed to drop table.');
    ok(res, { message: `Table "${req.params.table}" dropped.` });
  }));

  // ---- Bulk Table Operations -----------------------------------------------

  router.post('/api/tables/:db/bulk-drop', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const tables: string[] = Array.isArray(req.body?.tables)
      ? (req.body.tables as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];
    const force = Boolean(req.body?.force);
    if (tables.length === 0) return fail(res, 'No tables specified.');

    const dropped: string[] = [];
    const failed: { table: string; error: string }[] = [];

    if (force && db.dialect === 'sqlite') await db.run('PRAGMA foreign_keys = OFF');

    for (const table of tables) {
      try {
        const r = force && db.dialect === 'postgres'
          ? await db.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)} CASCADE`)
          : await db.dropTable(table);
        if (!r.success) throw new Error(r.error ?? 'Failed to drop table.');
        dropped.push(table);
      } catch (err) {
        failed.push({ table, error: (err as Error).message });
      }
    }

    if (force && db.dialect === 'sqlite') await db.run('PRAGMA foreign_keys = ON');

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

    const cleared: string[] = [];
    const failed: { table: string; error: string }[] = [];

    if (force && db.dialect === 'sqlite') await db.run('PRAGMA foreign_keys = OFF');

    for (const table of tables) {
      try {
        const r = force && db.dialect === 'postgres'
          ? await db.run(`TRUNCATE ${quoteIdentifier(table)} RESTART IDENTITY CASCADE`)
          : await db.run(`DELETE FROM ${quoteIdentifier(table)}`);
        if (!r.success) throw new Error(r.error ?? 'Failed to clear table.');
        cleared.push(table);
      } catch (err) {
        failed.push({ table, error: (err as Error).message });
      }
    }

    if (force && db.dialect === 'sqlite') await db.run('PRAGMA foreign_keys = ON');

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
      ok(res, { sql: generateCreateTable(name, columns) });
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
    let sql: string;
    try {
      sql = generateCreateTable(name, columns);
    } catch (err) {
      return fail(res, (err as Error).message);
    }
    const r = await db.execResult(sql);
    if (!r.success) return fail(res, r.error ?? 'Failed to create table.');
    ok(res, { message: `Table "${name}" created.`, name }, 201);
  });

  router.post('/api/tables/:db', createTableHandler);
  router.post('/api/tables/:db/create', createTableHandler);

  // ---- Columns -----------------------------------------------------------

  router.post('/api/tables/:db/:table/columns', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const col = req.body as ColumnDef;
    if (!col?.name) return fail(res, 'Column name is required.');
    const r = await db.addColumn(req.params.table, col);
    if (!r.success) return fail(res, r.error ?? 'Failed to add column.');
    ok(res, { message: `Column "${col.name}" added.` }, 201);
  }));

  router.put('/api/tables/:db/:table/columns/:column', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const col = req.body as ColumnDef;
    if (!col) return fail(res, 'Column definition is required.');
    const r = await db.modifyColumn(req.params.table, req.params.column, col);
    if (!r.success) return fail(res, r.error ?? 'Failed to modify column.');
    ok(res, { message: `Column "${req.params.column}" updated.` });
  }));

  router.post('/api/tables/:db/:table/columns/:column/rename', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const newName = String(req.body?.name ?? '').trim();
    if (!newName) return fail(res, 'New column name is required.');
    const r = await db.renameColumn(req.params.table, req.params.column, newName);
    if (!r.success) return fail(res, r.error ?? 'Failed to rename column.');
    ok(res, { message: `Column renamed to "${newName}".`, name: newName });
  }));

  router.delete('/api/tables/:db/:table/columns/:column', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const r = await db.dropColumn(req.params.table, req.params.column);
    if (!r.success) return fail(res, r.error ?? 'Failed to drop column.');
    ok(res, { message: `Column "${req.params.column}" dropped.` });
  }));

  // ---- Indexes -----------------------------------------------------------

  router.post('/api/tables/:db/:table/indexes', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const def = req.body as IndexDef;
    if (!def || !Array.isArray(def.columns) || def.columns.length === 0) {
      return fail(res, 'At least one column is required for an index.');
    }
    const r = await db.createIndex(req.params.table, def);
    if (!r.success) return fail(res, r.error ?? 'Failed to create index.');
    ok(res, { message: 'Index created.' }, 201);
  }));

  router.delete('/api/tables/:db/:table/indexes/:index', wrap(async (req, res) => {
    const db = ctx.getDb(req);
    const r = await db.dropIndex(req.params.index);
    if (!r.success) return fail(res, r.error ?? 'Failed to drop index.');
    ok(res, { message: `Index "${req.params.index}" dropped.` });
  }));
}
