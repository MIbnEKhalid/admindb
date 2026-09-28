import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRouter } from '../src/app';
import { SqliteDatabase } from '../src/db/database';
import { DbManager } from '../src/db/manager';
import { createLogger } from '../src/utils/logger';

interface TestContext {
  baseUrl: string;
  db: SqliteDatabase;
  close: () => Promise<void>;
}

function startSingleDbApp(): Promise<TestContext> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-smoke-single-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const logger = createLogger('error');
    const db = new SqliteDatabase(dbPath, logger);

    // Seed initial schema and data
    db.execResult(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        role TEXT DEFAULT 'member',
        avatar BLOB
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        title TEXT NOT NULL,
        content TEXT
      );
      INSERT INTO users (name, email, role) VALUES ('Alice', 'alice@example.com', 'admin');
      INSERT INTO posts (user_id, title, content) VALUES (1, 'Hello World', 'First post content');
    `);

    const app = createRouter({ db, auth: false });
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      resolve({
        baseUrl,
        db,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              db.close();
              try {
                rmSync(tmpDir, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
              res();
            });
          }),
      });
    });
  });
}

function startManagerApp(): Promise<TestContext> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-smoke-mgr-'));
    const logger = createLogger('error');
    const manager = new DbManager({ dir: tmpDir }, logger);
    const dbId = manager.create('demo.db');
    const db = manager.open(dbId);

    const app = createRouter({ manager, auth: false });
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      resolve({
        baseUrl,
        db,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              manager.closeAll();
              try {
                rmSync(tmpDir, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
              res();
            });
          }),
      });
    });
  });
}

test('Smoke Tests: Single Database API Endpoints', async (t) => {
  const { baseUrl, close } = await startSingleDbApp();

  await t.test('GET /api/tables lists tables with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { name: string }[] };
    assert.equal(json.success, true);
    assert.ok(json.data.some((t) => t.name === 'users'));
    assert.ok(json.data.some((t) => t.name === 'posts'));
  });

  await t.test('POST /api/tables/generate previews CREATE TABLE SQL with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'products',
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'title', type: 'TEXT', notNull: true },
          { name: 'price', type: 'REAL', defaultValue: '0.0' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { sql: string } };
    assert.equal(json.success, true);
    assert.match(json.data.sql, /CREATE TABLE "products"/i);
  });

  await t.test('POST /api/tables creates a new table with 201 Created', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'products',
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'title', type: 'TEXT', notNull: true },
          { name: 'price', type: 'REAL', defaultValue: '0.0' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean; data: { name: string } };
    assert.equal(json.success, true);
    assert.equal(json.data.name, 'products');
  });

  await t.test('GET /api/tables/:table/info returns table metadata with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/info`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { table: string; columns: unknown[] } };
    assert.equal(json.success, true);
    assert.equal(json.data.table, 'users');
    assert.ok(json.data.columns.length >= 3);
  });

  await t.test('GET /api/tables/:table/fk-options returns foreign key lookups with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/posts/fk-options`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: Record<string, { value: unknown; label: string }[]> };
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data.user_id));
    assert.ok(json.data.user_id.some((opt) => opt.value === 1));
  });

  await t.test('GET /api/tables/:table/ddl returns table DDL with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/ddl`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { sql: string } };
    assert.equal(json.success, true);
    assert.match(json.data.sql, /CREATE TABLE users/i);
  });

  await t.test('POST /api/tables/:table/columns adds a new column with 201 Created', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/columns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bio', type: 'TEXT' }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('PUT /api/tables/:table/columns/:column modifies a column with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/columns/bio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'biography', type: 'TEXT' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('POST /api/tables/:table/indexes creates index with 201 Created', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/indexes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'idx_users_email', columns: ['email'], unique: true }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('DELETE /api/tables/:table/indexes/:index drops index with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/indexes/idx_users_email`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('POST /api/tables/:table/rows/generate previews INSERT SQL with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { name: 'Bob', email: 'bob@example.com' } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { sql: string } };
    assert.equal(json.success, true);
    assert.match(json.data.sql, /INSERT INTO "users"/i);
  });

  await t.test('POST /api/tables/:table/rows inserts a new row with 201 Created', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { name: 'Bob', email: 'bob@example.com' } }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean; data: { id: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.id, 2);
  });

  await t.test('GET /api/tables/:table/rows returns paginated rows with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows?page=1&limit=10`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { rows: Record<string, unknown>[]; total: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.total, 2);
    assert.equal(json.data.rows.length, 2);
  });

  await t.test('GET /api/tables/:table/rows/count returns count with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/count`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { count: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.count, 2);
  });

  await t.test('GET /api/tables/:table/row/:id returns a single row with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/1`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { id: number; name: string } };
    assert.equal(json.success, true);
    assert.equal(json.data.name, 'Alice');
  });

  await t.test('PUT /api/tables/:table/row/:id/generate previews UPDATE SQL with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/1/generate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { role: 'superadmin' } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { sql: string } };
    assert.equal(json.success, true);
    assert.match(json.data.sql, /UPDATE "users" SET "role" = 'superadmin'/i);
  });

  await t.test('PUT /api/tables/:table/row/:id updates a single row with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { role: 'superadmin' } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('PUT /api/tables/:table/row/:id/blob/:column updates BLOB data with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/1/blob/avatar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: '0x89504e470d0a1a0a0000000d49484452', format: 'hex' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { size: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.size, 16);
  });

  await t.test('GET /api/tables/:table/row/:id/blob/:column/meta returns BLOB metadata with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/1/blob/avatar/meta`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { mime: string; isImage: boolean; size: number; hexDump: { lines: unknown[] } } };
    assert.equal(json.success, true);
    assert.equal(json.data.mime, 'image/png');
    assert.equal(json.data.isImage, true);
    assert.equal(json.data.size, 16);
    assert.ok(json.data.hexDump.lines.length > 0);
  });

  await t.test('GET /api/tables/:table/row/:id/blob/:column streams binary data with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/1/blob/avatar`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 16);
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
  });

  await t.test('POST /api/tables/:table/rows/bulk-update applies batch updates with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/bulk-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{ id: '2', values: { role: 'moderator' } }],
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { updated: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.updated, 1);
  });

  await t.test('POST /api/tables/:table/rows/bulk-impact computes foreign key references with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/bulk-impact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['1'] }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { total: number; references: unknown[] } };
    assert.equal(json.success, true);
    assert.equal(json.data.total, 1);
  });

  await t.test('POST /api/tables/:table/rows/bulk-export exports selected rows with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/bulk-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['1', '2'], format: 'csv' }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Alice/);
    assert.match(text, /Bob/);
  });

  await t.test('GET /api/tables/:table/rows/:id/references returns referencing foreign rows with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/1/references`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { references: { table: string; total: number }[] } };
    assert.equal(json.success, true);
    assert.ok(json.data.references.some((r) => r.table === 'posts' && r.total >= 1));
  });

  await t.test('GET /api/tables/:table/export exports full CSV with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/export?format=csv`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Alice/);
  });

  await t.test('GET /api/tables/:table/export exports full JSON with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/export?format=json`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { name: string }[];
    assert.ok(Array.isArray(data));
    assert.ok(data.some((u) => u.name === 'Alice'));
  });

  await t.test('POST /api/tables/:table/import imports CSV rows with 200 OK', async () => {
    const csv = 'name,email,role\nCharlie,charlie@example.com,member\nDana,dana@example.com,member';
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { inserted: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.inserted, 2);
  });

  await t.test('POST /api/query executes SQL queries with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/query/test.db`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT COUNT(*) AS total FROM users' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { rows: { total: number }[] } };
    assert.equal(json.success, true);
    assert.equal(json.data.rows[0].total, 4);
  });

  await t.test('GET /api/tables/:table/seed/plan detects intelligent seed plan with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/seed/plan`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { columns: unknown[] } };
    assert.equal(json.success, true);
    assert.ok(json.data.columns.length >= 3);
  });

  await t.test('POST /api/tables/:table/seed/generate previews seed SQL generation with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/seed/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 3, plan: { name: { strategy: 'fullname' } } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { sql: string; previewRows: unknown[] } };
    assert.equal(json.success, true);
    assert.match(json.data.sql, /INSERT INTO "users"/i);
    assert.equal(json.data.previewRows.length, 3);
  });

  await t.test('POST /api/tables/:table/seed/preview previews seed grid rows with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/seed/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 3, plan: { name: { strategy: 'fullname' } } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { previewRows: unknown[] } };
    assert.equal(json.success, true);
    assert.equal(json.data.previewRows.length, 3);
  });

  await t.test('POST /api/tables/:table/seed executes seeding with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 5, plan: { name: { strategy: 'fullname' } } }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean; data: { inserted: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.inserted, 5);
  });

  await t.test('DELETE /api/tables/:table/row/:id deletes a single row with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/row/2`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('POST /api/tables/:table/rows/bulk-delete bulk deletes rows with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/test.db/users/rows/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['3', '4'] }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { deleted: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.deleted, 2);
  });

  await t.test('GET /tables/:db/:table renders HTML with correct row edit links', async () => {
    const res = await fetch(`${baseUrl}/tables/test.db/users`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('/tables/test.db/users/rows/1/edit'));
    assert.ok(!html.includes('/tables/test.db//rows/1/edit'));
  });

  await t.test('GET /seed/:db/:table renders seed page with 200 OK and sidebar seed link', async () => {
    const res = await fetch(`${baseUrl}/seed/test.db/users`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Seed data'));
    assert.ok(html.includes('users'));
    assert.ok(html.includes('Seed generator'));
    assert.ok(html.includes('href="/seed/test.db"'));
  });

  await t.test('GET /seed/:db/:table?mode=chain sets ER chain mode as active', async () => {
    const res = await fetch(`${baseUrl}/seed/test.db/users?mode=chain`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="btn-select-chain" class="seed-mode-btn active"'));
    assert.ok(html.includes('"mode":"chain"'));
  });

  await t.test('GET /seed/:db renders table and mode selection page with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/seed/test.db`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Choose Target Table'));
    assert.ok(html.includes('Choose Generation Mode'));
    assert.ok(html.includes('Single Table Seeder'));
    assert.ok(html.includes('Relational ER Chain Seeder'));
    assert.ok(html.includes('users'));
    assert.ok(html.includes('posts'));
  });

  await close();
});


test('Smoke Tests: Manager Mode API Endpoints', async (t) => {
  const { baseUrl, close } = await startManagerApp();

  await t.test('GET /api/databases lists registered databases with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/databases`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { id: string }[] };
    assert.equal(json.success, true);
    assert.ok(json.data.some((d) => d.id === 'demo.db'));
  });

  await t.test('GET /api/fs/list browses filesystem directories with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/fs/list`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { entries: { name: string }[] } };
    assert.equal(json.success, true);
    assert.ok(json.data.entries.some((e) => e.name === 'demo.db'));
  });

  await t.test('POST /api/databases creates a new managed database with 201 Created', async () => {
    const res = await fetch(`${baseUrl}/api/databases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sales.db' }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean; data: { id: string } };
    assert.equal(json.success, true);
    assert.equal(json.data.id, 'sales.db');
  });

  await t.test('DELETE /api/databases/:id removes a database with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/databases/sales.db`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await close();
});

import { isPostgresAvailable, PG_TEST_URL } from './harness';
import { PostgresDatabase } from '../src/db/postgres';

async function startPostgresDbApp(): Promise<TestContext | null> {
  const isLive = await isPostgresAvailable();
  if (!isLive) return null;
  const logger = createLogger('error');
  const db = new PostgresDatabase(PG_TEST_URL, logger);

  // Setup PostgreSQL schema
  await db.execResult(`
    DROP TABLE IF EXISTS _admindb_smoke_posts CASCADE;
    DROP TABLE IF EXISTS _admindb_smoke_users CASCADE;
    CREATE TABLE _admindb_smoke_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100),
      role VARCHAR(50) DEFAULT 'member'
    );
    CREATE TABLE _admindb_smoke_posts (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES _admindb_smoke_users(id),
      title VARCHAR(150) NOT NULL,
      content TEXT
    );
    INSERT INTO _admindb_smoke_users (name, email, role) VALUES ('Alice', 'alice@example.com', 'admin');
    INSERT INTO _admindb_smoke_posts (user_id, title, content) VALUES (1, 'Hello PostgreSQL', 'First post content');
  `);

  const app = createRouter({ db, auth: false });
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        db: db as unknown as SqliteDatabase,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          try {
            await db.execResult(`
              DROP TABLE IF EXISTS _admindb_smoke_posts CASCADE;
              DROP TABLE IF EXISTS _admindb_smoke_users CASCADE;
            `);
            await db.close();
          } catch {}
        },
      });
    });
  });
}

test('Smoke Tests: PostgreSQL API Endpoints', async (t) => {
  const ctx = await startPostgresDbApp();
  if (!ctx) {
    t.skip(`PostgreSQL server not reachable at ${PG_TEST_URL.replace(/:([^@]+)@/, ':****@')} (skipping live PostgreSQL API smoke tests)`);
    return;
  }
  const { baseUrl, close } = ctx;

  await t.test('GET /api/tables lists PostgreSQL tables with 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/tables/PostgreSQL`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { name: string }[] };
    assert.equal(json.success, true);
    assert.ok(json.data.some((tb) => tb.name === '_admindb_smoke_users'));
  });

  await t.test('GET /api/tables/:table/rows returns PostgreSQL paginated rows', async () => {
    const res = await fetch(`${baseUrl}/api/tables/PostgreSQL/_admindb_smoke_users/rows`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { rows: { name: string }[]; total: number } };
    assert.equal(json.success, true);
    assert.equal(json.data.rows.length, 1);
    assert.equal(json.data.rows[0].name, 'Alice');
  });

  await t.test('POST /api/tables/:table/rows inserts into PostgreSQL table', async () => {
    const res = await fetch(`${baseUrl}/api/tables/PostgreSQL/_admindb_smoke_users/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { name: 'Bob', email: 'bob@example.com' } }),
    });
    assert.equal(res.status, 201);
    const json = (await res.json()) as { success: boolean };
    assert.equal(json.success, true);
  });

  await t.test('POST /api/query executes custom PostgreSQL query', async () => {
    const res = await fetch(`${baseUrl}/api/query/PostgreSQL`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT count(*)::int as count FROM _admindb_smoke_users' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { success: boolean; data: { rows: { count: number }[] } };
    assert.equal(json.success, true);
    assert.equal(json.data.rows[0].count, 2);
  });

  await close();
});


