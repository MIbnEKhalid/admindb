import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../db/database';
import { createLogger } from '../logger';

function openDb(): { db: SqliteDatabase; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-db-test-'));
  const db = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  return { db, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('getRows filters rows with exact, comparison and substring operators', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)',
    );
    await db.insertRows('users', [
      [{ column: 'name', value: 'alice' }, { column: 'age', value: 30 }],
      [{ column: 'name', value: 'bob' }, { column: 'age', value: 40 }],
      [{ column: 'name', value: 'carl' }, { column: 'age', value: 50 }],
    ]);

    const exact = await db.getRows('users', { filters: { name: '=bob' } });
    assert.equal((exact.data ?? []).length, 1);
    assert.equal((exact.data as Record<string, unknown>[])[0].name, 'bob');

    const gt = await db.getRows('users', { filters: { age: '>35' } });
    assert.equal((gt.data ?? []).length, 2);

    const contains = await db.getRows('users', { filters: { name: 'a' } });
    assert.equal((contains.data ?? []).length, 2); // alice + carl

    const prefix = await db.getRows('users', { filters: { name: 'bo*' } });
    assert.equal((prefix.data ?? []).length, 1);
    assert.equal((prefix.data as Record<string, unknown>[])[0].name, 'bob');

    const count = await db.getRowCount('users', { age: '>=40' });
    assert.equal(count.data, 2);
  } finally {
    cleanup();
  }
});

test('insertRows inserts many rows atomically and reports counts', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE t (a TEXT, b INTEGER)');
    const r = await db.insertRows('t', [
      [{ column: 'a', value: 'x' }, { column: 'b', value: 1 }],
      [{ column: 'a', value: 'y' }, { column: 'b', value: 2 }],
    ]);
    assert.equal(r.success, true);
    assert.equal(r.data?.inserted, 2);
    const all = await db.getAllRows('t');
    assert.equal((all.data ?? []).length, 2);
  } finally {
    cleanup();
  }
});

test('insertRows rolls back when a row fails', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE t (a TEXT NOT NULL)');
    const r = await db.insertRows('t', [
      [{ column: 'a', value: 'ok' }],
      [{ column: 'a', value: null }], // violates NOT NULL
    ]);
    assert.equal(r.success, false);
    const all = await db.getAllRows('t');
    assert.equal((all.data ?? []).length, 0); // rolled back
  } finally {
    cleanup();
  }
});

test('createIndex / dropIndex work and getSchema reports origin', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, city TEXT)');
    const created = await db.createIndex('users', { columns: ['city'] });
    assert.equal(created.success, true);

    const schema = await db.getSchema('users');
    const cities = schema.data?.indexes.find((ix) => ix.name === 'idx_users_city');
    assert.ok(cities, 'expected idx_users_city to exist');
    assert.equal(cities.origin, 'c');
    assert.deepEqual(cities.columns, ['city']);

    const dropped = await db.dropIndex('idx_users_city');
    assert.equal(dropped.success, true);
    const after = await db.getSchema('users');
    assert.equal(after.data?.indexes.find((ix) => ix.name === 'idx_users_city'), undefined);

    // The automatic UNIQUE index (origin 'u') is kept and is not origin 'c'.
    const auto = after.data?.indexes.find((ix) => ix.origin !== 'c');
    assert.ok(auto, 'expected an automatic index for the UNIQUE column');
    assert.equal(auto.origin, 'u');
    assert.deepEqual(auto.columns, ['email']);
  } finally {
    cleanup();
  }
});

test('read-only databases reject all writes and still allow reads', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-ro-test-'));
  const writable = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  try {
    await writable.execResult('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    await writable.insertRows('t', [[{ column: 'a', value: 'x' }]]);
    writable.close();

    const ro = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'), { readonly: true });
    try {
      assert.equal(ro.isReadOnly, true);
      // Reads keep working.
      const all = await ro.getAllRows('t');
      assert.equal(all.success, true);
      assert.equal((all.data ?? []).length, 1);
      // Every write path is blocked with a clear error.
      const r1 = await ro.run('INSERT INTO t (a) VALUES (?)', ['y']);
      assert.equal(r1.success, false);
      assert.match(r1.error ?? '', /read-only/i);
      const r2 = await ro.execResult('CREATE TABLE other (x TEXT)');
      assert.equal(r2.success, false);
      const r3 = await ro.runWrite('DELETE FROM t');
      assert.equal(r3.success, false);
      const r4 = await ro.insertRows('t', [[{ column: 'a', value: 'z' }]]);
      assert.equal(r4.success, false);
      const r5 = await ro.createIndex('t', { columns: ['a'] });
      assert.equal(r5.success, false);
      const r6 = await ro.dropTable('t');
      assert.equal(r6.success, false);
    } finally {
      ro.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('views: create, list, preview rows, drop', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    await db.insertRows('users', [
      [{ column: 'name', value: 'alice' }, { column: 'age', value: 30 }],
      [{ column: 'name', value: 'bob' }, { column: 'age', value: 40 }],
    ]);

    const created = await db.createView('adults', 'SELECT id, name FROM users WHERE age >= 18');
    assert.equal(created.success, true);

    const views = await db.listViews();
    assert.equal(views.success, true);
    assert.equal((views.data ?? []).length, 1);
    assert.equal((views.data as { name: string; sql: string | null }[])[0].name, 'adults');
    assert.match((views.data as { sql: string | null }[])[0].sql ?? '', /CREATE VIEW "adults"/);

    const rows = await db.getViewRows('adults');
    assert.equal(rows.success, true);
    assert.equal((rows.data ?? []).length, 2);

    const dropped = await db.dropView('adults');
    assert.equal(dropped.success, true);
    const after = await db.listViews();
    assert.equal((after.data ?? []).length, 0);
  } finally {
    cleanup();
  }
});

test('triggers: create, list, drop', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    await db.execResult('CREATE TABLE audit (id INTEGER PRIMARY KEY, msg TEXT)');

    const created = await db.createTrigger({
      name: 'audit_inserts',
      table: 'users',
      timing: 'AFTER',
      event: 'INSERT',
      body: "INSERT INTO audit (msg) VALUES ('row inserted');",
    });
    assert.equal(created.success, true);

    const triggers = await db.listTriggers();
    assert.equal(triggers.success, true);
    assert.equal((triggers.data ?? []).length, 1);
    const info = (triggers.data as { name: string; table: string; sql: string | null }[])[0];
    assert.equal(info.name, 'audit_inserts');
    assert.equal(info.table, 'users');
    assert.match(info.sql ?? '', /CREATE TRIGGER "audit_inserts"/);

    // The trigger actually fires.
    await db.insertRows('users', [[{ column: 'name', value: 'x' }]]);
    const audit = await db.getAllRows('audit');
    assert.equal((audit.data ?? []).length, 1);

    const dropped = await db.dropTrigger('audit_inserts');
    assert.equal(dropped.success, true);
    const after = await db.listTriggers();
    assert.equal((after.data ?? []).length, 0);
  } finally {
    cleanup();
  }
});

test('read-only databases reject view/trigger creation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-rovt-test-'));
  const writable = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  try {
    await writable.execResult('CREATE TABLE t (a TEXT)');
    writable.close();

    const ro = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'), { readonly: true });
    try {
      const v = await ro.createView('v', 'SELECT 1');
      assert.equal(v.success, false);
      assert.match(v.error ?? '', /read-only/i);
      const t = await ro.createTrigger({ name: 'tr', table: 't', timing: 'BEFORE', event: 'INSERT', body: 'SELECT 1;' });
      assert.equal(t.success, false);
      // Reads still work.
      const views = await ro.listViews();
      assert.equal(views.success, true);
    } finally {
      ro.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
