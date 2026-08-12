import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DbManager } from '../db/manager';
import { SqliteDatabase } from '../db/database';
import { createLogger } from '../logger';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dbadmin-test-'));
}

test('DbManager scans a directory and supports create/list/has/remove', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    mgr = new DbManager({ dir: path.join(root, 'data') }, logger);
    const id = mgr.create('app');
    assert.equal(id, 'app.db');
    assert.ok(mgr.has('app.db'));
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.list()[0].name, 'app.db');
    assert.equal(mgr.list()[0].id, 'app.db');
    assert.ok(existsSync(path.join(root, 'data', 'app.db')));
    assert.ok((await mgr.countTables('app.db')) >= 1); // _saved_queries exists

    mgr.remove('app.db');
    assert.equal(mgr.has('app.db'), false);
    assert.equal(mgr.list().length, 0);
    assert.equal(existsSync(path.join(root, 'data', 'app.db')), false);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('DbManager includes explicit file paths from anywhere', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    // Create a database file OUTSIDE any managed directory.
    const external = path.join(root, 'elsewhere', 'sales.sqlite');
    mkdirSync(path.dirname(external), { recursive: true });
    const db = new SqliteDatabase(external, logger);
    db.close();

    mgr = new DbManager({ files: [external] }, logger);
    const list = mgr.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'sales.sqlite');
    assert.equal(list[0].path, external);
    assert.ok(mgr.has('sales.sqlite'));
    assert.ok((await mgr.countTables('sales.sqlite')) >= 1);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('DbManager combines a dir with explicit files', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    const dir = path.join(root, 'data');
    mkdirSync(dir, { recursive: true });
    new SqliteDatabase(path.join(dir, 'a.db'), logger).close();
    new SqliteDatabase(path.join(dir, 'b.db'), logger).close();
    const external = path.join(root, 'c.db');
    new SqliteDatabase(external, logger).close();

    mgr = new DbManager({ dir, files: [external] }, logger);
    assert.deepEqual(mgr.list().map((e) => e.id).sort(), ['a.db', 'b.db', 'c.db']);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('DbManager dedupes colliding file names across sources', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    const dir = path.join(root, 'data');
    mkdirSync(dir, { recursive: true });
    new SqliteDatabase(path.join(dir, 'shared.db'), logger).close();
    const ext = path.join(root, 'other', 'shared.db');
    mkdirSync(path.dirname(ext), { recursive: true });
    new SqliteDatabase(ext, logger).close();

    mgr = new DbManager({ dir, files: [ext] }, logger);
    const ids = mgr.list().map((e) => e.id).sort();
    assert.deepEqual(ids, ['shared.db', 'shared__2.db']);
    assert.ok(mgr.has('shared__2.db'));
    assert.ok((await mgr.countTables('shared__2.db')) >= 1);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('DbManager read-only mode blocks create/remove and opens read-only dbs', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    // Seed a database with normal (writable) access first.
    const seed = new DbManager({ dir: path.join(root, 'data') }, logger);
    seed.create('app');
    seed.closeAll();

    mgr = new DbManager({ dir: path.join(root, 'data'), readonly: true }, logger);
    assert.equal(mgr.isReadOnly, true);
    const rmgr = mgr;
    assert.throws(() => rmgr.create('other'), /read-only/i);
    assert.throws(() => rmgr.remove('app.db'), /read-only/i);

    const db = rmgr.open('app.db');
    assert.equal(db.isReadOnly, true);
    const w = await db.run('CREATE TABLE x (a TEXT)');
    assert.equal(w.success, false);
    const r = await db.listTables();
    assert.equal(r.success, true);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});
