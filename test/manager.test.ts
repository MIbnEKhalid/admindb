import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DbManager } from '../src/db/manager';
import { SqliteDatabase } from '../src/db/database';
import { createLogger } from '../src/utils/logger';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'admindb-test-'));
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
    assert.equal(await mgr.countTables('app.db'), 0);

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
    assert.equal(await mgr.countTables('sales.sqlite'), 0);
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
    assert.equal(await mgr.countTables('shared__2.db'), 0);
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

test('DbManager supports per-database readonly selection and mode toggling', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    mgr = new DbManager({ dir: path.join(root, 'data') }, logger);
    const id1 = mgr.create('writable_db');
    assert.equal(mgr.isDbReadOnly(id1), false);
    const db1 = mgr.open(id1);
    assert.equal(db1.isReadOnly, false);

    // Toggle to readonly
    mgr.setReadonly(id1, true);
    assert.equal(mgr.isDbReadOnly(id1), true);
    const db1Ro = mgr.open(id1);
    assert.equal(db1Ro.isReadOnly, true);

    // Register a file directly as readonly
    const ext = path.join(root, 'readonly_ext.db');
    new SqliteDatabase(ext, logger).close();
    const id2 = mgr.openFile(ext, true);
    assert.equal(mgr.isDbReadOnly(id2), true);
    const db2 = mgr.open(id2);
    assert.equal(db2.isReadOnly, true);

    // Register a postgres connection as readonly
    const id3 = mgr.addConnection('ro_pg', 'postgresql://localhost/ro_db', true);
    assert.equal(mgr.isDbReadOnly(id3), true);
    const db3 = mgr.open(id3);
    assert.equal(db3.isReadOnly, true);

    const list = mgr.list();
    const map = new Map(list.map((e) => [e.id, e.readonly]));
    assert.equal(map.get(id1), true);
    assert.equal(map.get(id2), true);
    assert.equal(map.get(id3), true);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('DbManager LRU connection pooling respects maxOpenDbs and evicts least-recently used', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    const dir = path.join(root, 'data');
    mgr = new DbManager({ dir, maxOpenDbs: 3 }, logger);

    const dbs = ['db1', 'db2', 'db3', 'db4', 'db5'].map((name) => mgr!.create(name));
    assert.equal(mgr.list().length, 5);

    // Open db1, db2, db3
    mgr.open('db1.db');
    mgr.open('db2.db');
    mgr.open('db3.db');

    let stats = mgr.getPoolStats();
    assert.equal(stats.openConnections, 3);
    assert.deepEqual(stats.lruOrder, ['db1.db', 'db2.db', 'db3.db']);

    // Access db1 again (moves it to the end of LRU)
    mgr.open('db1.db');
    stats = mgr.getPoolStats();
    assert.deepEqual(stats.lruOrder, ['db2.db', 'db3.db', 'db1.db']);

    // Open db4 -> should evict db2.db (the least recently used)
    mgr.open('db4.db');
    stats = mgr.getPoolStats();
    assert.equal(stats.openConnections, 3);
    assert.equal(mgr.get('db2.db'), undefined);
    assert.deepEqual(stats.lruOrder, ['db3.db', 'db1.db', 'db4.db']);

    // Open db5 -> should evict db3.db
    mgr.open('db5.db');
    stats = mgr.getPoolStats();
    assert.equal(stats.openConnections, 3);
    assert.equal(mgr.get('db3.db'), undefined);
    assert.deepEqual(stats.lruOrder, ['db1.db', 'db4.db', 'db5.db']);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('DbManager pruneIdle closes idle connections older than threshold', async () => {
  const root = tempRoot();
  const logger = createLogger('error');
  let mgr: DbManager | undefined;
  try {
    const dir = path.join(root, 'data');
    mgr = new DbManager({ dir, idleTimeoutMs: 100 }, logger);
    mgr.create('test1');
    mgr.create('test2');

    mgr.open('test1.db');
    mgr.open('test2.db');
    assert.equal(mgr.getPoolStats().openConnections, 2);

    // Wait 120ms
    await new Promise((resolve) => setTimeout(resolve, 120));

    const pruned = mgr.pruneIdle();
    assert.equal(pruned, 2);
    assert.equal(mgr.getPoolStats().openConnections, 0);
  } finally {
    try {
      mgr?.closeAll();
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  }
});


