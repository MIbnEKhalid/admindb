import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../db/database';
import { createLogger } from '../logger';
import { parseFilters, filtersToQS } from '../util';

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

test('hasMultipleStatements detects scripts vs single statements', () => {
  const { db, cleanup } = openDb();
  try {
    // Single statements, including ones with semicolons inside literals/identifiers.
    assert.equal(db.hasMultipleStatements('SELECT 1'), false);
    assert.equal(db.hasMultipleStatements("INSERT INTO t VALUES ('a;b')"), false);
    assert.equal(db.hasMultipleStatements('SELECT "x;y" FROM t'), false);
    assert.equal(db.hasMultipleStatements('PRAGMA foreign_keys = ON;'), false);
    assert.equal(db.hasMultipleStatements('  -- comment\nSELECT 1'), false);
    assert.equal(db.hasMultipleStatements(''), false);

    // Scripts of several statements.
    assert.equal(db.hasMultipleStatements('PRAGMA foreign_keys = ON;\nCREATE TABLE t (a TEXT);'), true);
    assert.equal(db.hasMultipleStatements('CREATE TABLE a (x TEXT); CREATE TABLE b (y TEXT);'), true);
    assert.equal(db.hasMultipleStatements('SELECT 1; SELECT 2;'), true);
  } finally {
    cleanup();
  }
});

test('multi-statement schema scripts run via exec (PRAGMA + CREATE TABLE + indexes)', async () => {
  const { db, cleanup } = openDb();
  try {
    const script = [
      'PRAGMA foreign_keys = ON;',
      '',
      'CREATE TABLE IF NOT EXISTS "Users" (',
      '    id INTEGER PRIMARY KEY AUTOINCREMENT,',
      '    "UserName" TEXT UNIQUE,',
      '    "Active" INTEGER DEFAULT 0',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_users_active ON "Users" ("Active");',
      'CREATE INDEX IF NOT EXISTS idx_users_username ON "Users" ("UserName");',
    ].join('\n');

    assert.equal(db.hasMultipleStatements(script), true);
    const r = await db.execResult(script);
    assert.equal(r.success, true, r.error ?? '');

    const tables = await db.listTables();
    assert.equal((tables.data ?? []).some((t) => t.name === 'Users'), true);
    const schema = await db.getSchema('Users');
    const names = (schema.data?.indexes ?? []).map((ix) => ix.name);
    assert.ok(names.includes('idx_users_active'));
    assert.ok(names.includes('idx_users_username'));
  } finally {
    cleanup();
  }
});

test('getReferencingTables lists tables whose FKs point at this table', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
    );
    await db.execResult(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))',
    );
    await db.execResult(
      'CREATE TABLE payments (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), amount REAL)',
    );
    await db.insertRows('users', [
      [{ column: 'name', value: 'alice' }],
      [{ column: 'name', value: 'bob' }],
    ]);
    // One order references user 1; another has no FK value.
    await db.insertRows('orders', [
      [{ column: 'user_id', value: 1 }],
      [{ column: 'user_id', value: null }],
    ]);
    await db.insertRows('payments', [[{ column: 'user_id', value: 2 }, { column: 'amount', value: 9.99 }]]);

    const refs = await db.getReferencingTables('users');
    assert.equal(refs.success, true);
    const data = refs.data ?? [];
    assert.deepEqual(data.map((r) => r.table), ['orders', 'payments']);

    const orders = data.find((r) => r.table === 'orders');
    assert.deepEqual(orders?.refs, [{ from: 'user_id', to: 'id' }]);
    assert.equal(orders?.refCount, 1); // only the row with a non-null FK

    const payments = data.find((r) => r.table === 'payments');
    assert.equal(payments?.refCount, 1);

    // Rows by FK: orders has exactly one row referencing user id 1.
    const byFk = await db.getRowsByFk('orders', 'user_id', 1, 10);
    assert.equal(byFk.success, true);
    assert.equal(byFk.data?.total, 1);
    assert.equal((byFk.data?.rows ?? []).length, 1);
    assert.equal(byFk.data?.rows[0].user_id, 1);

    const noneFk = await db.getRowsByFk('orders', 'user_id', 999, 10);
    assert.equal(noneFk.data?.total, 0);
    assert.equal((noneFk.data?.rows ?? []).length, 0);

    // Nothing references orders.
    const none = await db.getReferencingTables('orders');
    assert.deepEqual(none.data ?? [], []);
  } finally {
    cleanup();
  }
});

test('structured (type-aware) filter conditions build correct WHERE clauses', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult(
      'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, joined DATE, active BOOLEAN)',
    );
    await db.insertRows('t', [
      [{ column: 'name', value: 'alice' }, { column: 'age', value: 30 }, { column: 'joined', value: '2020-01-01' }, { column: 'active', value: 1 }],
      [{ column: 'name', value: 'bob' }, { column: 'age', value: 40 }, { column: 'joined', value: '2021-06-15' }, { column: 'active', value: 0 }],
      [{ column: 'name', value: 'carl' }, { column: 'age', value: 50 }, { column: 'joined', value: '2022-03-30' }, { column: 'active', value: 1 }],
      [{ column: 'name', value: null }, { column: 'age', value: 25 }, { column: 'joined', value: null }, { column: 'active', value: null }],
    ]);

    // eq / neq
    const eq = await db.getRows('t', { filters: { name: { op: 'eq', value: 'bob' } } });
    assert.equal((eq.data ?? []).length, 1);
    const neq = await db.getRows('t', { filters: { age: { op: 'neq', value: '30' } } });
    assert.equal((neq.data ?? []).length, 3);

    // range: between → >= AND <=
    const between = await db.getRows('t', { filters: { age: { op: 'between', value: '30', max: '50' } } });
    assert.equal((between.data ?? []).length, 3);

    // single-sided range
    const gte = await db.getRows('t', { filters: { age: { op: 'gte', value: '40' } } });
    assert.equal((gte.data ?? []).length, 2);
    const lt = await db.getRows('t', { filters: { age: { op: 'lt', value: '40' } } });
    assert.equal((lt.data ?? []).length, 2); // 25 (null name) + 30

    // null / notnull
    const isNull = await db.getRows('t', { filters: { name: { op: 'null' } } });
    assert.equal((isNull.data ?? []).length, 1);
    const notNull = await db.getRows('t', { filters: { name: { op: 'notnull' } } });
    assert.equal((notNull.data ?? []).length, 3);

    // prefix / like (escaped)
    const prefix = await db.getRows('t', { filters: { name: { op: 'prefix', value: 'al' } } });
    assert.equal((prefix.data ?? []).length, 1);
    const like = await db.getRows('t', { filters: { name: { op: 'like', value: 'ar' } } });
    assert.equal((like.data ?? []).length, 1);

    // multiple conditions on the same column combine with AND
    const multi = await db.getRows('t', {
      filters: { age: [{ op: 'gte', value: '30' }, { op: 'lte', value: '40' }] },
    });
    assert.equal((multi.data ?? []).length, 2);

    // count path uses the same clause builder
    const count = await db.getRowCount('t', { age: { op: 'between', value: '30', max: '50' } });
    assert.equal(count.data, 3);
  } finally {
    cleanup();
  }
});

test('parseFilters / filtersToQS round-trip structured and legacy filters', async () => {
  // Legacy string syntax is preserved unchanged.
  const legacy = parseFilters(JSON.stringify({ name: 'bob', age: '>30' }));
  assert.deepEqual(legacy, { name: 'bob', age: '>30' });
  assert.ok(filtersToQS(legacy).includes('%22name%22%3A%22bob%22'));

  // Structured conditions survive the query-string round trip. filtersToQS
  // returns the full `f=…` query segment; parseFilters receives the decoded
  // JSON payload (as Express exposes req.query.f).
  const structured = parseFilters(
    JSON.stringify({ age: { op: 'between', value: '30', max: '50' }, name: [{ op: 'eq', value: 'a' }], city: { op: 'null' } }),
  );
  assert.deepEqual(structured.age, { op: 'between', value: '30', max: '50' });
  assert.deepEqual(structured.name, [{ op: 'eq', value: 'a' }]);
  assert.deepEqual(structured.city, { op: 'null' });

  const qs = filtersToQS(structured);
  const json = decodeURIComponent(qs.startsWith('f=') ? qs.slice(2) : qs);
  assert.deepEqual(parseFilters(json), structured);
});

test('deleteRows deletes many rows atomically and reports the count', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    await db.insertRows('t', [
      [{ column: 'a', value: 'x' }],
      [{ column: 'a', value: 'y' }],
      [{ column: 'a', value: 'z' }],
    ]);
    const all = await db.getAllRows('t');
    const ids = (all.data ?? []).map((r) => [{ column: 'id', value: r.id }]);

    // Delete the first two rows.
    const r = await db.deleteRows('t', ids.slice(0, 2));
    assert.equal(r.success, true);
    assert.equal(r.data?.deleted, 2);
    const remaining = await db.getAllRows('t');
    assert.equal((remaining.data ?? []).length, 1);
    assert.equal((remaining.data as Record<string, unknown>[])[0].a, 'z');

    // Deleting a row that no longer exists reports 0 changes for it.
    const again = await db.deleteRows('t', ids.slice(0, 2));
    assert.equal(again.success, true);
    assert.equal(again.data?.deleted, 0);
  } finally {
    cleanup();
  }
});

test('deleteRows rolls back the whole batch when one row fails', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
    await db.execResult('CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id) ON DELETE RESTRICT)');
    await db.insertRows('a', [
      [{ column: 'v', value: 'keep' }],
      [{ column: 'v', value: 'blocked' }],
    ]);
    await db.insertRows('b', [[{ column: 'a_id', value: 2 }]]);

    // Deleting a row referenced with ON DELETE RESTRICT fails — the whole batch
    // (including the deletable first row) must roll back.
    const r = await db.deleteRows('a', [
      [{ column: 'id', value: 1 }],
      [{ column: 'id', value: 2 }],
    ]);
    assert.equal(r.success, false);
    const all = await db.getAllRows('a');
    assert.equal((all.data ?? []).length, 2); // nothing was deleted
  } finally {
    cleanup();
  }
});

test('getRowsByPks fetches exactly the requested rows in one query', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    await db.insertRows('t', [
      [{ column: 'a', value: 'x' }],
      [{ column: 'a', value: 'y' }],
      [{ column: 'a', value: 'z' }],
    ]);
    const r = await db.getRowsByPks('t', [
      [{ column: 'id', value: 1 }],
      [{ column: 'id', value: 3 }],
      [{ column: 'id', value: 999 }],
    ]);
    assert.equal(r.success, true);
    const rows = (r.data ?? []) as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.a).sort(), ['x', 'z']);
  } finally {
    cleanup();
  }
});

test('updateRows applies many row updates atomically and rolls back on failure', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, u TEXT UNIQUE)');
    await db.insertRows('t', [
      [{ column: 'a', value: 'x' }, { column: 'b', value: 1 }, { column: 'u', value: 'u1' }],
      [{ column: 'a', value: 'y' }, { column: 'b', value: 2 }, { column: 'u', value: 'u2' }],
      [{ column: 'a', value: 'z' }, { column: 'b', value: 3 }, { column: 'u', value: 'u3' }],
    ]);

    // Update two rows across multiple columns (including an explicit NULL).
    const r = await db.updateRows('t', [
      { fields: [{ column: 'a', value: 'xx' }, { column: 'b', value: 10 }], where: [{ column: 'id', value: 1 }] },
      { fields: [{ column: 'a', value: null }], where: [{ column: 'id', value: 2 }] },
    ]);
    assert.equal(r.success, true);
    assert.equal(r.data?.updated, 2);

    const all = await db.getAllRows('t');
    const rows = (all.data ?? []) as Record<string, unknown>[];
    assert.equal(rows.find((row) => row.id === 1)?.a, 'xx');
    assert.equal(rows.find((row) => row.id === 1)?.b, 10);
    assert.equal(rows.find((row) => row.id === 2)?.a, null);

    // A failing update (UNIQUE violation) rolls back the entire batch.
    const failR = await db.updateRows('t', [
      { fields: [{ column: 'a', value: 'b1' }], where: [{ column: 'id', value: 3 }] },
      { fields: [{ column: 'u', value: 'dup' }], where: [{ column: 'id', value: 1 }] },
      { fields: [{ column: 'u', value: 'dup' }], where: [{ column: 'id', value: 3 }] }, // violates UNIQUE
    ]);
    assert.equal(failR.success, false);
    const after = await db.getAllRows('t');
    const afterRows = (after.data ?? []) as Record<string, unknown>[];
    // Row 3's `a` must NOT have changed — the whole batch rolled back.
    assert.equal(afterRows.find((row) => row.id === 3)?.a, 'z');
  } finally {
    cleanup();
  }
});

test('modifyColumn changes column type and constraints while preserving data and indexes', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, price TEXT, status TEXT DEFAULT "active")');
    await db.execResult('CREATE INDEX idx_items_title ON items (title)');
    await db.insertRows('items', [
      [{ column: 'title', value: 'Book' }, { column: 'price', value: '19.99' }, { column: 'status', value: 'active' }],
      [{ column: 'title', value: 'Pen' }, { column: 'price', value: '2.50' }, { column: 'status', value: 'archived' }],
    ]);

    // Modify price from TEXT to REAL and add NOT NULL constraint
    const modRes = await db.modifyColumn('items', 'price', {
      name: 'price',
      type: 'REAL',
      notNull: true,
      defaultValue: '0.0',
    });
    assert.equal(modRes.success, true);

    const schema = await db.getSchema('items');
    const priceCol = schema.data?.columns.find((c) => c.name === 'price');
    assert.equal(priceCol?.type, 'REAL');
    assert.equal(priceCol?.notnull, 1);

    // Verify data was preserved
    const all = await db.getAllRows('items');
    const rows = (all.data ?? []) as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.title === 'Book')?.price, 19.99);

    // Verify index was preserved
    const idx = schema.data?.indexes.find((i) => i.name === 'idx_items_title');
    assert.ok(idx);
  } finally {
    cleanup();
  }
});

test('supports row identification and bulk operations on tables without primary keys', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE logs (message TEXT, level TEXT)');
    await db.insertRows('logs', [
      [{ column: 'message', value: 'boot' }, { column: 'level', value: 'info' }],
      [{ column: 'message', value: 'warn' }, { column: 'level', value: 'warning' }],
      [{ column: 'message', value: 'crash' }, { column: 'level', value: 'error' }],
    ]);

    const page = await db.getRows('logs', { page: 1, limit: 10 });
    assert.equal(page.success, true);
    const rows = page.data ?? [];
    assert.equal(rows.length, 3);
    assert.ok(rows[0]._rowid_ !== undefined);

    // Bulk update using _rowid_
    const row1Id = rows[0]._rowid_;
    const upRes = await db.updateRows('logs', [
      { fields: [{ column: 'message', value: 'booted successfully' }], where: [{ column: '_rowid_', value: row1Id }] },
    ]);
    assert.equal(upRes.success, true);

    // Bulk delete using _rowid_
    const row2Id = rows[1]._rowid_;
    const delRes = await db.deleteRows('logs', [[{ column: '_rowid_', value: row2Id }]]);
    assert.equal(delRes.success, true);
    assert.equal(delRes.data?.deleted, 1);

    const remaining = await db.getAllRows('logs');
    assert.equal(remaining.data?.length, 2);
  } finally {
    cleanup();
  }
});

test('modifyColumn and renameColumn properly update indexes and preserve table UNIQUE constraints', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult('CREATE TABLE articles (id INTEGER PRIMARY KEY, email TEXT UNIQUE, title TEXT, category TEXT, score INTEGER)');
    await db.execResult('CREATE INDEX idx_articles_title ON articles (title)');
    await db.execResult('CREATE INDEX custom_cat_title ON articles (category, title)');

    // 1. Rename title -> heading via modifyColumn
    const renameRes = await db.modifyColumn('articles', 'title', {
      name: 'heading',
      type: 'TEXT',
      notNull: false,
      unique: false,
      primaryKey: false,
      defaultValue: null,
      foreignKey: null,
    });
    assert.equal(renameRes.success, true);

    let schema = await db.getSchema('articles');
    // Ensure title is renamed to heading
    assert.ok(schema.data?.columns.find((c) => c.name === 'heading'));
    assert.ok(!schema.data?.columns.find((c) => c.name === 'title'));
    // Ensure email is still unique
    const emailCol = schema.data?.columns.find((c) => c.name === 'email');
    assert.equal(emailCol?.unique, true);

    // Ensure default-named index was renamed and updated
    const titleIdx = schema.data?.indexes.find((i) => i.name === 'idx_articles_heading');
    assert.ok(titleIdx, 'idx_articles_heading should exist');
    assert.deepEqual(titleIdx?.columns, ['heading']);

    // Ensure multi-column custom index was updated with new column name
    const customIdx = schema.data?.indexes.find((i) => i.name === 'custom_cat_title');
    assert.ok(customIdx, 'custom_cat_title should exist');
    assert.deepEqual(customIdx?.columns, ['category', 'heading']);

    // 2. Rename email -> email_address (UNIQUE column) + change type to VARCHAR(255)
    const uqRes = await db.modifyColumn('articles', 'email', {
      name: 'email_address',
      type: 'VARCHAR(255)',
      notNull: true,
      unique: true,
      primaryKey: false,
      defaultValue: null,
      foreignKey: null,
    });
    assert.equal(uqRes.success, true);

    schema = await db.getSchema('articles');
    const uqCol = schema.data?.columns.find((c) => c.name === 'email_address');
    assert.equal(uqCol?.unique, true);
    assert.equal(uqCol?.type, 'VARCHAR(255)');
    assert.equal(uqCol?.notnull, 1);

    // All indexes still intact
    assert.ok(schema.data?.indexes.find((i) => i.name === 'idx_articles_heading'));
    assert.ok(schema.data?.indexes.find((i) => i.name === 'custom_cat_title'));
  } finally {
    cleanup();
  }
});

