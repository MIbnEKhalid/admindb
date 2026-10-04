import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteTestDb } from './harness';
import { SearchService } from '../src/modules/search/search.service';
import { createRouter } from '../src/app';
import type { DatabaseContext } from '../src/core/context';
import { sqliteDialect } from '../src/db/dialects/index';
import { createLogger } from '../src/utils/logger';

test('SearchService: metadata index and multi-target search', async (t) => {
  const { db, cleanup } = openSqliteTestDb();

  // Setup test schema
  await db.runWrite(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.runWrite(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_number TEXT NOT NULL,
      total REAL NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await db.runWrite(`
    CREATE INDEX idx_orders_order_number ON orders(order_number);
  `);

  await db.runWrite(`
    INSERT INTO users (name, email) VALUES ('Alice Johnson', 'alice@example.com'), ('Bob Smith', 'bob@test.org');
    INSERT INTO orders (user_id, order_number, total) VALUES (1, 'ORD-2026-99', 149.99);
  `);

  const ctx: DatabaseContext = {
    id: 'test.db',
    name: 'test.db',
    path: db.path,
    db,
    dialect: sqliteDialect,
    capabilities: sqliteDialect.capabilities,
    isReadOnly: false,
    logger: createLogger('error'),
  };

  await t.test('getMetadataIndex retrieves tables, columns, indexes, FKs, and commands', async () => {
    const index = await SearchService.getMetadataIndex(ctx);
    assert.equal(index.tables.length, 2);
    assert.ok(index.tables.some((t) => t.name === 'users'));
    assert.ok(index.tables.some((t) => t.name === 'orders'));

    // Columns
    assert.ok(index.columns.some((c) => c.table === 'users' && c.name === 'email' && c.type.toUpperCase() === 'TEXT'));
    assert.ok(index.columns.some((c) => c.table === 'orders' && c.name === 'user_id' && c.isFk));

    // Indexes
    assert.ok(index.indexes.some((i) => i.name === 'idx_orders_order_number'));

    // Foreign Keys
    assert.ok(index.foreignKeys.some((fk) => fk.fromTable === 'orders' && fk.fromColumn === 'user_id' && fk.toTable === 'users'));

    // Commands
    assert.ok(index.commands.some((c) => c.id === 'cmd-query'));
    assert.ok(index.commands.some((c) => c.id === 'cmd-erd'));
  });

  await t.test('search tables by name and prefix', async () => {
    const res = await SearchService.search(ctx, 'user');
    assert.ok(res.results.length > 0);
    const tableMatch = res.results.find((r) => r.category === 'table' && r.title === 'users');
    assert.ok(tableMatch, 'Should find users table');
    assert.ok(tableMatch.actions && tableMatch.actions.length >= 2);
  });

  await t.test('search columns across all tables', async () => {
    const res = await SearchService.search(ctx, 'email', { type: 'columns' });
    assert.ok(res.results.length > 0);
    assert.ok(res.results.every((r) => r.category === 'column'));
    const colMatch = res.results.find((r) => r.title === 'email');
    assert.ok(colMatch);
    assert.equal(colMatch.metadata?.table, 'users');
  });

  await t.test('search indexes by name and column', async () => {
    const res = await SearchService.search(ctx, 'order_number', { type: 'indexes' });
    assert.ok(res.results.length > 0);
    const idxMatch = res.results.find((r) => r.category === 'index');
    assert.ok(idxMatch);
    assert.equal(idxMatch.title, 'idx_orders_order_number');
  });

  await t.test('search foreign key relationships', async () => {
    const res = await SearchService.search(ctx, 'orders.user_id', { type: 'relations' });
    assert.ok(res.results.length > 0);
    const fkMatch = res.results.find((r) => r.category === 'relation');
    assert.ok(fkMatch);
    assert.ok(fkMatch.title.includes('orders.user_id'));
  });

  await t.test('search commands by keywords', async () => {
    const res = await SearchService.search(ctx, 'diagram', { type: 'commands' });
    assert.ok(res.results.length > 0);
    const cmdMatch = res.results.find((r) => r.id === 'cmd-erd');
    assert.ok(cmdMatch);
  });

  await t.test('deep row search finds matching text contents', async () => {
    const res = await SearchService.search(ctx, 'alice@example.com');
    const rowMatch = res.results.find((r) => r.category === 'row');
    assert.ok(rowMatch, 'Should find row containing alice@example.com');
    assert.ok(rowMatch.title.includes('users'));
  });

  await t.test('empty query returns helpful suggestions', async () => {
    const res = await SearchService.search(ctx, '');
    assert.ok(res.results.length > 0);
    assert.ok(res.results.some((r) => r.category === 'table'));
    assert.ok(res.results.some((r) => r.category === 'command'));
  });

  cleanup();
});

test('HTTP API: /api/search/:db endpoints', async (t) => {
  const { db, cleanup } = openSqliteTestDb();

  await db.runWrite(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      title TEXT NOT NULL,
      price REAL NOT NULL
    );
    INSERT INTO products (sku, title, price) VALUES ('PROD-101', 'Wireless Mouse', 29.99);
  `);

  const app = createRouter({
    db,
    dbId: 'store.db',
    auth: false,
  });

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test('GET /api/search/:db returns 200 with search results', async () => {
    const res = await fetch(`${baseUrl}/api/search/store.db?q=Mouse`);
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.results.length > 0);
    assert.ok(json.data.results.some((r: any) => r.title.includes('Mouse') || r.title === 'products'));
  });

  await t.test('GET /api/search/:db/metadata returns 200 with full schema index', async () => {
    const res = await fetch(`${baseUrl}/api/search/store.db/metadata`);
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.tables.some((t: any) => t.name === 'products'));
    assert.ok(json.data.columns.some((c: any) => c.name === 'sku'));
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup();
});
