import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteTestDb } from './harness';
import { categorizeType, mapColumnToDialect, convertValueForDialect, generateCreateTableForDialect, normalizeTableInfo } from '../src/core/transfer/dialect-mapper';
import { sortTablesTopologically, sortTablesForDeletion } from '../src/core/transfer/topological-sort';
import { maskRowData } from '../src/core/transfer/masking';
import { compareSchemas } from '../src/core/diff/schema-differ';
import { compareTableData } from '../src/core/diff/data-differ';
import { generateSchemaPatch } from '../src/core/diff/patch-generator';
import { executeSync } from '../src/core/transfer/sync-engine';
import { DbManager } from '../src/db/manager';
import { createRouter } from '../src/app';

test('Dialect Mapper: Type Categorization & Cross-Engine Mapping', () => {
  assert.equal(categorizeType('INTEGER'), 'integer');
  assert.equal(categorizeType('BIGSERIAL'), 'integer');
  assert.equal(categorizeType('VARCHAR(255)'), 'text');
  assert.equal(categorizeType('BOOLEAN'), 'boolean');
  assert.equal(categorizeType('BYTEA'), 'blob');
  assert.equal(categorizeType('TIMESTAMP WITH TIME ZONE'), 'datetime');
  assert.equal(categorizeType('JSONB'), 'json');

  // SQLite to Postgres
  assert.equal(
    mapColumnToDialect({ name: 'id', type: 'INTEGER', genericType: 'integer', primaryKey: true, autoIncrement: true, notNull: true, defaultValue: null, unique: true, foreignKey: null }, 'postgres'),
    'SERIAL',
  );
  assert.equal(
    mapColumnToDialect({ name: 'active', type: 'INTEGER', genericType: 'boolean', primaryKey: false, autoIncrement: false, notNull: false, defaultValue: null, unique: false, foreignKey: null }, 'postgres'),
    'BOOLEAN',
  );

  // Postgres to SQLite
  assert.equal(
    mapColumnToDialect({ name: 'id', type: 'SERIAL', genericType: 'integer', primaryKey: true, autoIncrement: true, notNull: true, defaultValue: null, unique: true, foreignKey: null }, 'sqlite'),
    'INTEGER PRIMARY KEY AUTOINCREMENT',
  );
  assert.equal(
    mapColumnToDialect({ name: 'payload', type: 'JSONB', genericType: 'json', primaryKey: false, autoIncrement: false, notNull: false, defaultValue: null, unique: false, foreignKey: null }, 'sqlite'),
    'TEXT',
  );

  // Value Conversions
  assert.equal(convertValueForDialect(1, 'boolean', 'postgres'), true);
  assert.equal(convertValueForDialect(0, 'boolean', 'postgres'), false);
  assert.equal(convertValueForDialect(true, 'boolean', 'sqlite'), 1);
  assert.equal(convertValueForDialect(false, 'boolean', 'sqlite'), 0);
  assert.equal(convertValueForDialect({ a: 1 }, 'json', 'sqlite'), '{"a":1}');
});

test('Topological Sorter: Resolves foreign key insertion and deletion order', () => {
  const deps = [
    { name: 'order_items', foreignKeys: [{ id: 1, seq: 0, table: 'orders', from: 'order_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE' }] },
    { name: 'orders', foreignKeys: [{ id: 2, seq: 0, table: 'users', from: 'user_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE' }] },
    { name: 'users', foreignKeys: [] },
  ];

  const insertOrder = sortTablesTopologically(deps);
  assert.deepEqual(insertOrder, ['users', 'orders', 'order_items']);

  const deleteOrder = sortTablesForDeletion(deps);
  assert.deepEqual(deleteOrder, ['order_items', 'orders', 'users']);
});

test('Masking Engine: Anonymizes PII fields for Prod -> Test copying', () => {
  const row = {
    id: 42,
    username: 'alice_super',
    email: 'alice@company.com',
    password_hash: '$2b$12$secretrealproductionhash',
    phone_number: '+1234567890',
    bio: 'Software engineer',
  };

  const masked = maskRowData(row, undefined, 1);
  assert.equal(masked.id, 42);
  assert.equal(masked.email, 'user1@masked.test');
  assert.equal(masked.phone_number, '+15550000001');
  assert.equal(masked.username, 'Test User 1');
  assert.ok(String(masked.password_hash).includes('maskedpwdhash'));
  assert.equal(masked.bio, 'Software engineer'); // Non-PII retained

  // Row 2 must produce different values for tokens/passwords to prevent UNIQUE constraint failures
  const row2 = { ...row, TokenHash: 'token_abc123' };
  const masked2 = maskRowData(row2, undefined, 2);
  assert.notEqual(masked.password_hash, masked2.password_hash);
  assert.notEqual(masked2.TokenHash, maskRowData(row2, undefined, 1).TokenHash);
});

test('Schema Differ & Patch Generator: Identifies changes and produces Git-like diff & SQL patch', async () => {
  const db1 = openSqliteTestDb();
  const db2 = openSqliteTestDb();

  try {
    // DB 1: Source (e.g. prod)
    await db1.db.execResult(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, FOREIGN KEY (user_id) REFERENCES users(id));
      CREATE INDEX idx_orders_user ON orders (user_id);
    `);

    // DB 2: Target (e.g. test) - missing orders, users has extra old_col and missing email
    await db2.db.execResult(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, old_col TEXT);
      CREATE TABLE legacy_log (id INTEGER PRIMARY KEY, msg TEXT);
    `);

    const diff = await compareSchemas(db1.db, 'prod_db', db2.db, 'test_db');

    assert.equal(diff.stats.addedTables, 1); // orders added
    assert.equal(diff.stats.removedTables, 1); // legacy_log removed
    assert.equal(diff.stats.modifiedTables, 1); // users modified

    // Check Git unified diff content
    assert.ok(diff.unifiedDiff.includes('diff --git a/test_db/schema.sql b/prod_db/schema.sql'));
    assert.ok(diff.unifiedDiff.includes('@@ table: orders (ADDED) @@'));
    assert.ok(diff.unifiedDiff.includes('+ CREATE TABLE orders'));
    assert.ok(diff.unifiedDiff.includes('@@ table: legacy_log (REMOVED) @@'));
    assert.ok(diff.unifiedDiff.includes('- DROP TABLE legacy_log'));
    assert.ok(diff.unifiedDiff.includes('+   column: email'));
    assert.ok(diff.unifiedDiff.includes('-   column: old_col'));

    // Check SQL Patch Generation
    const patch = generateSchemaPatch(diff, 'sqlite');
    assert.ok(patch.upSql.includes('CREATE TABLE `orders`'));
    assert.ok(patch.upSql.includes('DROP TABLE IF EXISTS `legacy_log`'));
    assert.ok(patch.upSql.includes('ADD COLUMN `email`'));
    assert.ok(patch.downSql.includes('DROP TABLE IF EXISTS `orders`'));
  } finally {
    db1.cleanup();
    db2.cleanup();
  }
});

test('Data Differ: Row comparison identifies added, removed, and modified records with unified diff', async () => {
  const db1 = openSqliteTestDb();
  const db2 = openSqliteTestDb();

  try {
    await db1.db.execResult(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);`);
    await db2.db.execResult(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);`);

    // DB 1 (Source)
    await db1.db.insertRow('products', [{ column: 'id', value: 1 }, { column: 'name', value: 'Widget A' }, { column: 'price', value: 19.99 }]);
    await db1.db.insertRow('products', [{ column: 'id', value: 2 }, { column: 'name', value: 'Widget B' }, { column: 'price', value: 29.99 }]); // modified in tgt
    await db1.db.insertRow('products', [{ column: 'id', value: 3 }, { column: 'name', value: 'Widget C' }, { column: 'price', value: 39.99 }]); // added in src

    // DB 2 (Target)
    await db2.db.insertRow('products', [{ column: 'id', value: 1 }, { column: 'name', value: 'Widget A' }, { column: 'price', value: 19.99 }]); // identical
    await db2.db.insertRow('products', [{ column: 'id', value: 2 }, { column: 'name', value: 'Widget B' }, { column: 'price', value: 24.99 }]); // price changed
    await db2.db.insertRow('products', [{ column: 'id', value: 4 }, { column: 'name', value: 'Old Item' }, { column: 'price', value: 5.00 }]); // deleted from src

    const dataDiff = await compareTableData(db1.db, db2.db, 'products');

    assert.equal(dataDiff.identicalCount, 1);
    assert.equal(dataDiff.addedCount, 1); // ID 3
    assert.equal(dataDiff.removedCount, 1); // ID 4
    assert.equal(dataDiff.modifiedCount, 1); // ID 2

    assert.ok(dataDiff.unifiedDiff.includes('+ [PK: 3]'));
    assert.ok(dataDiff.unifiedDiff.includes('- [PK: 4]'));
    assert.ok(dataDiff.unifiedDiff.includes('~ [PK: 2] price: 24.99 -> 29.99'));
  } finally {
    db1.cleanup();
    db2.cleanup();
  }
});

test('Sync Engine: Full clone replication copies schema, FK order, and rows with masking', async () => {
  const db1 = openSqliteTestDb();
  const db2 = openSqliteTestDb();

  try {
    // Source DB setup
    await db1.db.execResult(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL, FOREIGN KEY (customer_id) REFERENCES customers(id));
    `);

    await db1.db.insertRows('customers', [
      [{ column: 'name', value: 'Alice' }, { column: 'email', value: 'alice@live.com' }],
      [{ column: 'name', value: 'Bob' }, { column: 'email', value: 'bob@live.com' }],
    ]);

    await db1.db.insertRows('orders', [
      [{ column: 'id', value: 101 }, { column: 'customer_id', value: 1 }, { column: 'total', value: 99.5 }],
      [{ column: 'id', value: 102 }, { column: 'customer_id', value: 2 }, { column: 'total', value: 149.0 }],
    ]);

    // 1. Dry run test
    const dryRunRes = await executeSync(db1.db, 'prod_source', db2.db, 'test_target', {
      mode: 'full',
      dryRun: true,
      maskData: true,
    });
    assert.equal(dryRunRes.success, true);
    assert.equal(dryRunRes.dryRun, true);
    assert.equal(dryRunRes.totalRowsTransferred, 4);

    // 2. Full Sync execution
    const syncRes = await executeSync(db1.db, 'prod_source', db2.db, 'test_target', {
      mode: 'full',
      dryRun: false,
      maskData: true,
    });

    assert.equal(syncRes.success, true);
    assert.equal(syncRes.totalRowsTransferred, 4);

    // Verify Target DB now contains tables and masked data
    const tgtTables = await db2.db.listTables();
    const tableNames = (tgtTables.data || []).map((t) => t.name);
    assert.ok(tableNames.includes('customers'));
    assert.ok(tableNames.includes('orders'));

    const tgtCustomers = await db2.db.getAllRows('customers');
    assert.equal(tgtCustomers.data?.length, 2);
    // Verify email was masked
    assert.equal(tgtCustomers.data?.[0].email, 'user1@masked.test');
    assert.equal(tgtCustomers.data?.[1].email, 'user2@masked.test');

    const tgtOrders = await db2.db.getAllRows('orders');
    assert.equal(tgtOrders.data?.length, 2);
    assert.equal(tgtOrders.data?.[0].total, 99.5);
  } finally {
    db1.cleanup();
    db2.cleanup();
  }
});

test('HTTP API Endpoints: /diff and /api/sync/* integration', async () => {
  const db1 = openSqliteTestDb();
  const db2 = openSqliteTestDb();

  try {
    await db1.db.execResult(`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT);`);
    await db1.db.insertRow('items', [{ column: 'id', value: 1 }, { column: 'title', value: 'Item 1' }]);

    await db2.db.execResult(`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT);`);

    const manager = new DbManager({
      files: [db1.db.path, db2.db.path],
    });

    const entries = manager.list();
    assert.ok(entries.length >= 2);
    const id1 = entries[0].id;
    const id2 = entries[1].id;

    const app = createRouter({ manager, auth: false });

    // Helper for requests
    const makeReq = async (method: string, path: string, body?: any) => {
      const { createServer } = await import('node:http');
      return new Promise<{ status: number; body: any }>((resolve, reject) => {
        const server = createServer(app);
        server.listen(0, async () => {
          const port = (server.address() as any).port;
          try {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
              method,
              headers: body ? { 'Content-Type': 'application/json' } : undefined,
              body: body ? JSON.stringify(body) : undefined,
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch {}
            server.close(() => resolve({ status: res.status, body: json || text }));
          } catch (e) {
            server.close(() => reject(e));
          }
        });
      });
    };

    // 1. GET /diff
    const getDiffRes = await makeReq('GET', '/diff');
    assert.equal(getDiffRes.status, 200);
    assert.ok(typeof getDiffRes.body === 'string' && getDiffRes.body.includes('Diff & Replication'));

    // 2. GET /api/sync/databases
    const getDbsRes = await makeReq('GET', '/api/sync/databases');
    assert.equal(getDbsRes.status, 200);
    assert.ok(Array.isArray(getDbsRes.body.data));

    // 3. POST /api/sync/diff/schema
    const schemaDiffRes = await makeReq('POST', '/api/sync/diff/schema', { sourceDbId: id1, targetDbId: id2 });
    assert.equal(schemaDiffRes.status, 200);
    assert.ok(schemaDiffRes.body.data.unifiedDiff !== undefined);

    // 4. POST /api/sync/diff/data
    const dataDiffRes = await makeReq('POST', '/api/sync/diff/data', { sourceDbId: id1, targetDbId: id2, table: 'items' });
    assert.equal(dataDiffRes.status, 200);
    assert.equal(dataDiffRes.body.data.addedCount, 1);

    // 5. POST /api/sync/patch
    const patchRes = await makeReq('POST', '/api/sync/patch', { sourceDbId: id1, targetDbId: id2 });
    assert.equal(patchRes.status, 200);
    assert.ok(patchRes.body.data.upSql !== undefined);

    // 6. POST /api/sync/dry-run
    const dryRunRes = await makeReq('POST', '/api/sync/dry-run', { sourceDbId: id1, targetDbId: id2, mode: 'full' });
    assert.equal(dryRunRes.status, 200);
    assert.equal(dryRunRes.body.data.dryRun, true);

    // 7. POST /api/sync/execute
    const execRes = await makeReq('POST', '/api/sync/execute', { sourceDbId: id1, targetDbId: id2, mode: 'data_only_replace' });
    assert.equal(execRes.status, 200);
    assert.equal(execRes.body.data.success, true);
    assert.equal(execRes.body.data.totalRowsTransferred, 1);
  } finally {
    db1.cleanup();
    db2.cleanup();
  }
});

test('Patch Generator: Handles expression indexes and missing columns array gracefully without throwing', () => {
  const dummyDiff: any = {
    sourceDbId: 'src_db',
    targetDbId: 'tgt_db',
    sourceDialect: 'sqlite',
    targetDialect: 'sqlite',
    tables: [
      {
        name: 'users',
        action: 'added',
        sourceTable: {
          name: 'users',
          columns: [{ name: 'id', type: 'INTEGER', genericType: 'integer', primaryKey: true, notNull: true, unique: false, autoIncrement: false, defaultValue: null }],
          primaryKeys: ['id'],
          foreignKeys: [],
          indexes: [
            { name: 'idx_normal', unique: false, columns: ['id'] },
            { name: 'idx_expr', unique: false, columns: undefined },
            { name: 'idx_null_cols', unique: false, columns: null },
            { name: 'idx_empty', unique: false, columns: [] },
          ],
        },
        columnDiffs: [],
        pkChanged: false,
        indexesAdded: ['idx_normal', 'idx_expr'],
        indexesRemoved: [],
        fksAdded: [],
        fksRemoved: [],
      },
      {
        name: 'posts',
        action: 'modified',
        sourceTable: {
          name: 'posts',
          columns: [],
          primaryKeys: [],
          foreignKeys: [],
          indexes: [
            { name: 'idx_post_title', unique: true, columns: ['title'] },
            { name: 'idx_post_expr', unique: false, columns: undefined },
          ],
        },
        targetTable: {
          name: 'posts',
          columns: [],
          primaryKeys: [],
          foreignKeys: [],
          indexes: [],
        },
        columnDiffs: [],
        pkChanged: false,
        indexesAdded: ['idx_post_title', 'idx_post_expr'],
        indexesRemoved: [],
        fksAdded: [],
        fksRemoved: [],
      },
    ],
    stats: { addedTables: 1, removedTables: 0, modifiedTables: 1, identicalTables: 0, totalColumnsChanged: 0 },
    unifiedDiff: '',
  };

  const patch = generateSchemaPatch(dummyDiff, 'sqlite');
  assert.ok(patch.upSql.includes('CREATE INDEX IF NOT EXISTS `idx_normal` ON `users` (`id`);'));
  assert.ok(patch.upSql.includes('CREATE UNIQUE INDEX IF NOT EXISTS `idx_post_title` ON `posts` (`title`);'));
  assert.ok(!patch.upSql.includes('idx_expr'));
});

test('Dialect Mapper: Converts PostgreSQL default expressions (now(), UUID, casts) into valid SQLite DDL', async () => {
  const normTable: any = {
    name: 'ApiTokenProfiles',
    columns: [
      { name: 'id', type: 'integer', genericType: 'integer', primaryKey: true, autoIncrement: true, notNull: true, defaultValue: "nextval('api_token_profiles_id_seq'::regclass)" },
      { name: 'name', type: 'character varying', genericType: 'text', primaryKey: false, autoIncrement: false, notNull: true, defaultValue: "'default_profile'::character varying" },
      { name: 'is_active', type: 'boolean', genericType: 'boolean', primaryKey: false, autoIncrement: false, notNull: true, defaultValue: 'true' },
      { name: 'uuid', type: 'uuid', genericType: 'text', primaryKey: false, autoIncrement: false, notNull: false, defaultValue: 'gen_random_uuid()' },
      { name: 'created_at', type: 'timestamp with time zone', genericType: 'datetime', primaryKey: false, autoIncrement: false, notNull: true, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamp with time zone', genericType: 'datetime', primaryKey: false, autoIncrement: false, notNull: true, defaultValue: 'CURRENT_TIMESTAMP' },
    ],
    primaryKeys: ['id'],
    foreignKeys: [],
    indexes: [],
  };

  const ddl = generateCreateTableForDialect(normTable, 'sqlite');
  assert.ok(ddl.includes('`name` TEXT NOT NULL DEFAULT \'default_profile\''));
  assert.ok(ddl.includes('`is_active` INTEGER NOT NULL DEFAULT 1'));
  assert.ok(ddl.includes('`created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'));
  assert.ok(ddl.includes('`updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'));
  assert.ok(!ddl.includes('gen_random_uuid()'));
  assert.ok(!ddl.includes('nextval'));

  // Ensure this DDL actually executes without syntax errors in SQLite!
  const db = openSqliteTestDb();
  try {
    const res = await db.db.execResult(ddl);
    assert.equal(res.success, true);
    assert.equal(res.error, undefined);
  } finally {
    db.cleanup();
  }
});

test('Dialect Mapper: Filters out internal sqlite_autoindex_ entries from normalized indexes', () => {
  const info: any = {
    table: 'ApiTokens',
    columns: [{ name: 'id', type: 'INTEGER', pk: 1, notnull: 1, dflt_value: null }],
    primaryKey: ['id'],
    foreignKeys: [],
    indexes: [
      { name: 'sqlite_autoindex_ApiTokens_1', origin: 'u', unique: true, columns: ['TokenHash'] },
      { name: 'sqlite_autoindex_ApiTokens_2', origin: 'pk', unique: true, columns: ['id'] },
      { name: 'idx_custom_token', origin: 'c', unique: false, columns: ['TokenHash'] },
    ],
  };

  const norm = normalizeTableInfo(info, 'sqlite');
  assert.equal(norm.indexes.length, 1);
  assert.equal(norm.indexes[0].name, 'idx_custom_token');
});

test('Dialect Mapper: Generates valid PostgreSQL DDL for SERIAL/identity columns without multiple defaults', () => {
  const table: any = {
    name: '_saved_queries',
    columns: [
      { name: 'id', type: 'integer', genericType: 'integer', primaryKey: true, autoIncrement: true, notNull: true, defaultValue: "nextval('_saved_queries_id_seq'::regclass)" },
      { name: 'name', type: 'text', genericType: 'text', primaryKey: false, autoIncrement: false, notNull: true, defaultValue: null },
      { name: 'query', type: 'text', genericType: 'text', primaryKey: false, autoIncrement: false, notNull: true, defaultValue: null },
    ],
    primaryKeys: ['id'],
    foreignKeys: [],
    indexes: [],
  };

  const ddl = generateCreateTableForDialect(table, 'postgres');
  assert.ok(ddl.includes('"id" SERIAL'));
  assert.ok(!ddl.includes('SERIAL DEFAULT'));
  assert.ok(!ddl.includes("nextval('_saved_queries_id_seq'::regclass)"));
});




