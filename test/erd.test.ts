/**
 * Tests for the GET /api/erd endpoint.
 *
 * The endpoint returns a single JSON payload containing every table's
 * column metadata and foreign-key edges — consumed by the ER diagram page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/utils/logger';
import { createRouter } from '../src/app';
import { SqliteDatabase } from '../src/db/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AppContext {
  baseUrl: string;
  db: SqliteDatabase;
  close: () => Promise<void>;
}

function startApp(seed?: string): Promise<AppContext> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-erd-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const logger = createLogger('error');
    const db = new SqliteDatabase(dbPath, logger);

    if (seed) db.execResult(seed);

    const app = createRouter({ db, auth: false });
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        close: () =>
          new Promise<void>((res) =>
            server.close(() => {
              db.close();
              try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
              res();
            })
          ),
      });
    });
  });
}

type ErdTable = {
  name: string;
  columns: { name: string; type: string; pk: number; notnull: number; dflt_value: unknown }[];
  foreignKeys: { from: string; table: string; to: string; on_delete?: string; on_update?: string }[];
  primaryKey: string[];
};
type ErdResponse = { success: boolean; data: { tables: ErdTable[] }; error?: string };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test('ERD API: GET /api/erd', async (t) => {

  // ── 1. Basic response shape ─────────────────────────────────────────────
  await t.test('returns 200 with { success, data.tables }', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE alpha (id INTEGER PRIMARY KEY);
    `);
    try {
      const res = await fetch(`${baseUrl}/api/erd/test.db`);
      assert.equal(res.status, 200);
      const json = await res.json() as ErdResponse;
      assert.equal(json.success, true);
      assert.ok(Array.isArray(json.data.tables), 'data.tables should be an array');
    } finally { await close(); }
  });

  // ── 2. Empty database ───────────────────────────────────────────────────
  await t.test('returns empty user tables list for a database with no user tables', async () => {
    const { baseUrl, close } = await startApp();
    try {
      const res  = await fetch(`${baseUrl}/api/erd/test.db`);
      const json = await res.json() as ErdResponse;
      assert.equal(json.success, true);
      assert.equal(json.data.tables.length, 0);
    } finally { await close(); }
  });

  // ── 3. Table list correctness ───────────────────────────────────────────
  await t.test('includes all created tables', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE users    (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE orders   (id INTEGER PRIMARY KEY);
    `);
    try {
      const res  = await fetch(`${baseUrl}/api/erd/test.db`);
      const json = await res.json() as ErdResponse;
      const names = json.data.tables.map((t) => t.name);
      assert.ok(names.includes('users'),    'missing users');
      assert.ok(names.includes('products'), 'missing products');
      assert.ok(names.includes('orders'),   'missing orders');
    } finally { await close(); }
  });

  // ── 4. Column metadata ──────────────────────────────────────────────────
  await t.test('each table entry contains columns with name, type, pk, notnull', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE items (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT    NOT NULL,
        price REAL
      );
    `);
    try {
      const res   = await fetch(`${baseUrl}/api/erd/test.db`);
      const json  = await res.json() as ErdResponse;
      const table = json.data.tables.find((t) => t.name === 'items');
      assert.ok(table, 'items table not found');

      const colNames = table!.columns.map((c) => c.name);
      assert.ok(colNames.includes('id'),    'missing id column');
      assert.ok(colNames.includes('label'), 'missing label column');
      assert.ok(colNames.includes('price'), 'missing price column');

      const idCol = table!.columns.find((c) => c.name === 'id')!;
      assert.ok(idCol.pk > 0, 'id.pk should be > 0');

      const labelCol = table!.columns.find((c) => c.name === 'label')!;
      assert.ok(labelCol.notnull, 'label.notnull should be truthy');
    } finally { await close(); }
  });

  // ── 5. primaryKey field ─────────────────────────────────────────────────
  await t.test('primaryKey array is populated for tables with explicit PKs', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT);
    `);
    try {
      const res   = await fetch(`${baseUrl}/api/erd/test.db`);
      const json  = await res.json() as ErdResponse;
      const table = json.data.tables.find((t) => t.name === 'accounts')!;
      assert.ok(Array.isArray(table.primaryKey), 'primaryKey should be an array');
      assert.ok(table.primaryKey.includes('id'), 'primaryKey should contain "id"');
    } finally { await close(); }
  });

  // ── 6. Foreign-key edges ────────────────────────────────────────────────
  await t.test('foreignKeys array contains correct from/table/to fields', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE posts (
        id      INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id)
      );
    `);
    try {
      const res   = await fetch(`${baseUrl}/api/erd/test.db`);
      const json  = await res.json() as ErdResponse;
      const posts = json.data.tables.find((t) => t.name === 'posts')!;
      assert.ok(posts.foreignKeys.length > 0, 'posts should have FK edges');

      const fk = posts.foreignKeys.find((f) => f.from === 'user_id')!;
      assert.ok(fk,           'user_id FK edge not found');
      assert.equal(fk.table,  'users');
      assert.equal(fk.to,     'id');
    } finally { await close(); }
  });

  // ── 7. Multiple FKs on one table ────────────────────────────────────────
  await t.test('tables with multiple FKs expose all edges', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE users    (id INTEGER PRIMARY KEY);
      CREATE TABLE products (id INTEGER PRIMARY KEY);
      CREATE TABLE order_items (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id),
        product_id INTEGER REFERENCES products(id)
      );
    `);
    try {
      const res   = await fetch(`${baseUrl}/api/erd/test.db`);
      const json  = await res.json() as ErdResponse;
      const oi    = json.data.tables.find((t) => t.name === 'order_items')!;
      assert.equal(oi.foreignKeys.length, 2, 'order_items should have 2 FK edges');

      const targets = oi.foreignKeys.map((f) => f.table);
      assert.ok(targets.includes('users'),    'missing FK edge → users');
      assert.ok(targets.includes('products'), 'missing FK edge → products');
    } finally { await close(); }
  });

  // ── 8. Self-referential FK ──────────────────────────────────────────────
  await t.test('self-referential FK (parent_id → same table) is included', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE categories (
        id        INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES categories(id)
      );
    `);
    try {
      const res  = await fetch(`${baseUrl}/api/erd/test.db`);
      const json = await res.json() as ErdResponse;
      const cat  = json.data.tables.find((t) => t.name === 'categories')!;
      const selfFk = cat.foreignKeys.find((f) => f.table === 'categories');
      assert.ok(selfFk, 'self-referential FK should be present');
      assert.equal(selfFk!.from, 'parent_id');
    } finally { await close(); }
  });

  // ── 9. FK on_delete / on_update are forwarded ──────────────────────────
  await t.test('FK on_delete and on_update actions are forwarded in the response', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE sessions (
        id      INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE ON UPDATE SET NULL
      );
    `);
    try {
      const res      = await fetch(`${baseUrl}/api/erd/test.db`);
      const json     = await res.json() as ErdResponse;
      const sessions = json.data.tables.find((t) => t.name === 'sessions')!;
      const fk       = sessions.foreignKeys.find((f) => f.from === 'user_id')!;
      assert.ok(fk.on_delete?.toUpperCase().includes('CASCADE'),  'on_delete should be CASCADE');
      assert.ok(fk.on_update?.toUpperCase().includes('SET NULL'),  'on_update should be SET NULL');
    } finally { await close(); }
  });

  // ── 10. Tables with no FKs have empty foreignKeys array ─────────────────
  await t.test('tables without FK constraints have an empty foreignKeys array', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE standalone (id INTEGER PRIMARY KEY, value TEXT);
    `);
    try {
      const res  = await fetch(`${baseUrl}/api/erd/test.db`);
      const json = await res.json() as ErdResponse;
      const t_   = json.data.tables.find((t) => t.name === 'standalone')!;
      assert.equal(t_.foreignKeys.length, 0);
    } finally { await close(); }
  });

  // ── 11. FK edges reference existing tables ──────────────────────────────
  await t.test('all FK edge target tables exist in the tables array', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books   (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id));
      CREATE TABLE reviews (id INTEGER PRIMARY KEY, book_id   INTEGER REFERENCES books(id));
    `);
    try {
      const res    = await fetch(`${baseUrl}/api/erd/test.db`);
      const json   = await res.json() as ErdResponse;
      const names  = new Set(json.data.tables.map((t) => t.name));
      json.data.tables.forEach((table) => {
        table.foreignKeys.forEach((fk) => {
          assert.ok(names.has(fk.table), `FK target "${fk.table}" not in tables list (from "${table.name}")`);
        });
      });
    } finally { await close(); }
  });

  // ── 12. ERD page route returns HTML ─────────────────────────────────────
  await t.test('GET /erd serves the ER diagram HTML page', async () => {
    const { baseUrl, close } = await startApp(`
      CREATE TABLE demo (id INTEGER PRIMARY KEY);
    `);
    try {
      const res = await fetch(`${baseUrl}/erd/test.db`);
      assert.equal(res.status, 200);
      const ct = res.headers.get('content-type') ?? '';
      assert.ok(ct.includes('text/html'), `Expected text/html, got: ${ct}`);
      const body = await res.text();
      assert.ok(body.includes('erd-svg') || body.includes('ER Diagram'), 'ERD page HTML missing expected markers');
    } finally { await close(); }
  });
});
