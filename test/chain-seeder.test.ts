import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { SqliteDatabase } from '../src/db/database';
import { createLogger } from '../src/utils/logger';
import { createRouter } from '../src/app';
import { buildErGraph, resolveErChain, topologicalSort, getErChainConfig, generateChainRows, executeChainInsert, buildChainInsertSql } from '../src/data/index';

function openDb(seedSql?: string): { db: SqliteDatabase; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-chain-test-'));
  const db = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  if (seedSql) db.execResult(seedSql);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function startApp(seedSql?: string): Promise<{ baseUrl: string; db: SqliteDatabase; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-chain-app-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const logger = createLogger('error');
    const db = new SqliteDatabase(dbPath, logger);
    if (seedSql) db.execResult(seedSql);

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

test('ER Chain: Topological sort and graph resolution', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );

    CREATE TABLE teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_name TEXT NOT NULL
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      title TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      assignee_id INTEGER REFERENCES users(id),
      description TEXT NOT NULL
    );

    CREATE TABLE task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      author_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL
    );
  `);

  try {
    const listRes = await db.listTables();
    const tableNames = (listRes.data ?? []).map((t) => t.name).filter((n) => !n.startsWith('sqlite_') && n !== '_saved_queries');
    const tables = [];
    for (const name of tableNames) {
      const info = await db.getTableInfo(name);
      if (info.success && info.data) tables.push(info.data);
    }

    const graph = buildErGraph(tables);

    // 1. Ancestors of task_comments
    const ancestors = resolveErChain(graph, 'task_comments', 'ancestors');
    const ancestorNames = ancestors.map((n) => n.name);
    assert.ok(ancestorNames.includes('task_comments'));
    assert.ok(ancestorNames.includes('tasks'));
    assert.ok(ancestorNames.includes('projects'));
    assert.ok(ancestorNames.includes('teams'));
    assert.ok(ancestorNames.includes('users'));

    // 2. Topological sort ordering
    const { sorted, cycleDetected } = topologicalSort(ancestors);
    assert.equal(cycleDetected, false);

    const sortNames = sorted.map((s) => s.name);
    // teams must be before projects
    assert.ok(sortNames.indexOf('teams') < sortNames.indexOf('projects'));
    // projects must be before tasks
    assert.ok(sortNames.indexOf('projects') < sortNames.indexOf('tasks'));
    // users must be before tasks and task_comments
    assert.ok(sortNames.indexOf('users') < sortNames.indexOf('tasks'));
    assert.ok(sortNames.indexOf('tasks') < sortNames.indexOf('task_comments'));
  } finally {
    cleanup();
  }
});

test('ER Chain: Self-referencing table hierarchy and cycles', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES categories(id),
      name TEXT NOT NULL
    );

    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      title TEXT NOT NULL,
      price REAL NOT NULL
    );
  `);

  try {
    const config = await getErChainConfig(db, 'products', 'chain');
    assert.equal(config.tables.length, 2);
    assert.equal(config.tables[0].name, 'categories');
    assert.equal(config.tables[1].name, 'products');
    assert.equal(config.tables[0].hasSelfRef, true);

    const gen = await generateChainRows(db, config, {}, { categories: 5, products: 10 });
    assert.equal(gen.tableResults['categories'].rows.length, 5);
    assert.equal(gen.tableResults['products'].rows.length, 10);

    // Verify insertion into SQLite with foreign keys enforced
    const insertRes = await executeChainInsert(db, gen, false);
    assert.equal(insertRes.inserted['categories'], 5);
    assert.equal(insertRes.inserted['products'], 10);
    assert.equal(insertRes.totalInserted, 15);

    // Verify reverse truncate
    const truncRes = await executeChainInsert(db, gen, true);
    assert.equal(truncRes.totalInserted, 15);
  } finally {
    cleanup();
  }
});

test('ER Chain: Relational value propagation across 5-table chain with FK enforcement', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dept_id INTEGER NOT NULL REFERENCES departments(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );

    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      manager_id INTEGER NOT NULL REFERENCES employees(id),
      contract_value REAL NOT NULL
    );

    CREATE TABLE milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);

  try {
    const config = await getErChainConfig(db, 'milestones', 'chain');
    assert.equal(config.tables.length, 5);

    // Check topological order: departments and clients must be first
    const order = config.tables.map((t) => t.name);
    assert.ok(order.indexOf('departments') < order.indexOf('employees'));
    assert.ok(order.indexOf('employees') < order.indexOf('contracts'));
    assert.ok(order.indexOf('clients') < order.indexOf('contracts'));
    assert.ok(order.indexOf('contracts') < order.indexOf('milestones'));

    // Generate rows with custom counts
    const gen = await generateChainRows(
      db,
      config,
      {},
      {
        departments: 3,
        employees: 6,
        clients: 4,
        contracts: 8,
        milestones: 16,
      },
    );

    assert.equal(gen.tableResults['departments'].rows.length, 3);
    assert.equal(gen.tableResults['employees'].rows.length, 6);
    assert.equal(gen.tableResults['clients'].rows.length, 4);
    assert.equal(gen.tableResults['contracts'].rows.length, 8);
    assert.equal(gen.tableResults['milestones'].rows.length, 16);

    // Verify generated SQL script
    const sql = buildChainInsertSql(gen.executionOrder, gen.tableResults);
    assert.ok(sql.includes('BEGIN TRANSACTION;'));
    assert.ok(sql.includes('INSERT INTO "departments"'));
    assert.ok(sql.includes('INSERT INTO "contracts"'));
    assert.ok(sql.includes('COMMIT;'));

    // Execute atomic insertion
    const result = await executeChainInsert(db, gen, true);
    assert.equal(result.totalInserted, 3 + 6 + 4 + 8 + 16);

    // Verify rows in database
    const depRows = await db.getRows('departments');
    const empRows = await db.getRows('employees');
    const cliRows = await db.getRows('clients');
    const conRows = await db.getRows('contracts');
    const milRows = await db.getRows('milestones');

    assert.equal((depRows.data as unknown[]).length, 3);
    assert.equal((empRows.data as unknown[]).length, 6);
    assert.equal((cliRows.data as unknown[]).length, 4);
    assert.equal((conRows.data as unknown[]).length, 8);
    assert.equal((milRows.data as unknown[]).length, 16);
  } finally {
    cleanup();
  }
});

test('ER Chain API: End-to-end endpoints /api/tables/:table/seed/chain', async (t) => {
  const { baseUrl, close } = await startApp(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );

    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL REFERENCES authors(id),
      title TEXT NOT NULL,
      isbn TEXT NOT NULL UNIQUE
    );

    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id),
      reviewer TEXT NOT NULL,
      rating INTEGER NOT NULL
    );
  `);

  try {
    // 1. GET /api/tables/reviews/seed/chain
    await t.test('GET /api/tables/:table/seed/chain returns topological chain structure', async () => {
      const res = await fetch(`${baseUrl}/api/tables/reviews/seed/chain?scope=chain`);
      assert.equal(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: { tables: { name: string; order: number }[] } };
      assert.equal(json.success, true);
      assert.equal(json.data.tables.length, 3);
      assert.equal(json.data.tables[0].name, 'authors');
      assert.equal(json.data.tables[1].name, 'books');
      assert.equal(json.data.tables[2].name, 'reviews');
    });

    // 2. POST /api/tables/reviews/seed/chain/generate
    await t.test('POST /api/tables/:table/seed/chain/generate produces multi-table preview and SQL', async () => {
      const res = await fetch(`${baseUrl}/api/tables/reviews/seed/chain/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'chain',
          counts: { authors: 2, books: 4, reviews: 8 },
        }),
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          totalRows: number;
          sql: string;
          tableResults: Record<string, { rows: unknown[]; previewRows: unknown[] }>;
        };
      };
      assert.equal(json.success, true);
      assert.equal(json.data.totalRows, 14);
      assert.ok(json.data.sql.includes('INSERT INTO "authors"'));
      assert.ok(json.data.sql.includes('INSERT INTO "reviews"'));
      assert.equal(json.data.tableResults['authors'].previewRows.length, 2);
      assert.equal(json.data.tableResults['books'].previewRows.length, 4);
      assert.equal(json.data.tableResults['reviews'].previewRows.length, 8);
    });

    // 3. POST /api/tables/reviews/seed/chain (Insert)
    await t.test('POST /api/tables/:table/seed/chain executes atomic relational multi-table seeding', async () => {
      const res = await fetch(`${baseUrl}/api/tables/reviews/seed/chain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'chain',
          counts: { authors: 3, books: 5, reviews: 10 },
          truncate: true,
        }),
      });
      assert.equal(res.status, 201);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          totalInserted: number;
          inserted: Record<string, number>;
        };
      };
      assert.equal(json.success, true);
      assert.equal(json.data.totalInserted, 18);
      assert.equal(json.data.inserted['authors'], 3);
      assert.equal(json.data.inserted['books'], 5);
      assert.equal(json.data.inserted['reviews'], 10);
    });
  } finally {
    await close();
  }
});

test('ER Chain: order_items with composite primary key and NOT NULL foreign keys', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );

    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      price REAL NOT NULL
    );

    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_date TEXT NOT NULL,
      total_amount REAL NOT NULL
    );

    CREATE TABLE order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      PRIMARY KEY (order_id, product_id)
    );
  `);

  try {
    const config = await getErChainConfig(db, 'order_items', 'chain');
    const orderNames = config.tables.map((t) => t.name);

    // Topological order check: customers, products, orders must precede order_items
    assert.ok(orderNames.indexOf('customers') < orderNames.indexOf('orders'));
    assert.ok(orderNames.indexOf('orders') < orderNames.indexOf('order_items'));
    assert.ok(orderNames.indexOf('products') < orderNames.indexOf('order_items'));

    // Generate rows across the entire chain
    const gen = await generateChainRows(
      db,
      config,
      {},
      {
        customers: 3,
        products: 5,
        orders: 5,
        order_items: 10,
      },
    );

    assert.equal(gen.tableResults['customers'].rows.length, 3);
    assert.equal(gen.tableResults['products'].rows.length, 5);
    assert.equal(gen.tableResults['orders'].rows.length, 5);
    assert.equal(gen.tableResults['order_items'].rows.length, 10);

    // Ensure no order_items row has NULL for order_id or product_id
    for (const row of gen.tableResults['order_items'].rows) {
      const orderIdField = row.find((f) => f.column === 'order_id');
      const productIdField = row.find((f) => f.column === 'product_id');
      assert.ok(orderIdField && orderIdField.value != null, 'order_id must not be null');
      assert.ok(productIdField && productIdField.value != null, 'product_id must not be null');
    }

    // Execute atomic insertion into database without any NOT NULL constraint errors
    const insertRes = await executeChainInsert(db, gen, true);
    assert.equal(insertRes.totalInserted, 3 + 5 + 5 + 10);

    // Verify rows in database
    const itemRows = await db.getRows('order_items');
    assert.equal((itemRows.data as unknown[]).length, 10);
  } finally {
    cleanup();
  }
});

test('ER Chain: Parent table with custom PK name (order_id) and shorthand REFERENCES', async () => {
  const { db, cleanup } = openDb(`
    CREATE TABLE orders (
      order_id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_num TEXT NOT NULL UNIQUE
    );

    CREATE TABLE order_items (
      item_id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders,
      qty INTEGER NOT NULL
    );
  `);

  try {
    const config = await getErChainConfig(db, 'order_items', 'chain');
    const orderNames = config.tables.map((t) => t.name);
    assert.ok(orderNames.indexOf('orders') < orderNames.indexOf('order_items'));

    const gen = await generateChainRows(db, config, {}, { orders: 4, order_items: 8 });
    assert.equal(gen.tableResults['orders'].rows.length, 4);
    assert.equal(gen.tableResults['order_items'].rows.length, 8);

    for (const row of gen.tableResults['order_items'].rows) {
      const orderIdField = row.find((f) => f.column === 'order_id');
      assert.ok(orderIdField && orderIdField.value != null, 'order_id must not be null');
    }

    const insertRes = await executeChainInsert(db, gen, true);
    assert.equal(insertRes.totalInserted, 12);
  } finally {
    cleanup();
  }
});

