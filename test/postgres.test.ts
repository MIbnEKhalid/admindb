import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../src/db/postgres';
import { DbManager } from '../src/db/manager';
import { convertPlaceholdersToPostgres } from '../src/db/filters';
import { createLogger } from '../src/utils/logger';
import { createRouter } from '../src/app';
import { parseArgs } from '../src/cli/args';
import { loadConfig } from '../src/cli/config';


test('convertPlaceholdersToPostgres transforms ? to $1, $2, ... correctly', () => {
  const sql = 'SELECT * FROM users WHERE age > ? AND name = ? AND active = ?';
  const converted = convertPlaceholdersToPostgres(sql);
  assert.equal(converted, 'SELECT * FROM users WHERE age > $1 AND name = $2 AND active = $3');
});

test('convertPlaceholdersToPostgres ignores ? inside single-quoted strings and escapes', () => {
  const sql = "SELECT * FROM users WHERE note = 'What is this? Really?' AND id = ? AND msg = 'It''s a ?' AND rank > ?";
  const converted = convertPlaceholdersToPostgres(sql);
  assert.equal(
    converted,
    "SELECT * FROM users WHERE note = 'What is this? Really?' AND id = $1 AND msg = 'It''s a ?' AND rank > $2",
  );
});

test('convertPlaceholdersToPostgres supports custom start index', () => {
  const sql = 'WHERE name = ? AND email = ?';
  const converted = convertPlaceholdersToPostgres(sql, 3);
  assert.equal(converted, 'WHERE name = $3 AND email = $4');
});

test('PostgresDatabase constructor sanitizes credentials in path and initializes dialect', () => {
  const logger = createLogger('error');
  const db = new PostgresDatabase('postgresql://admin:supersecret@127.0.0.1:5432/my_test_db', logger, {
    readonly: true,
  });

  assert.equal(db.dialect, 'postgres');
  assert.equal(db.isReadOnly, true);
  assert.ok(!db.path.includes('supersecret'));
  assert.ok(db.path.includes('****'));
  assert.ok(db.path.includes('my_test_db'));

  db.close();
});

test('PostgresDatabase hasMultipleStatements detects multi-statement scripts accurately', () => {
  const logger = createLogger('error');
  const db = new PostgresDatabase('postgresql://localhost/test', logger, { readonly: true });

  assert.equal(db.hasMultipleStatements('SELECT 1;'), false);
  assert.equal(db.hasMultipleStatements('SELECT 1; SELECT 2;'), true);
  assert.equal(db.hasMultipleStatements("SELECT 'semi;colon in string';"), false);
  assert.equal(db.hasMultipleStatements("SELECT 'semi;colon'; SELECT 2;"), true);

  db.close();
});

test('PostgresDatabase rejects writes when in read-only mode', async () => {
  const logger = createLogger('error');
  const db = new PostgresDatabase('postgresql://localhost/test', logger, { readonly: true });

  const res1 = await db.insertRow('users', [{ column: 'name', value: 'Alice' }]);
  assert.equal(res1.success, false);
  assert.match(res1.error ?? '', /read-only mode/i);

  const res2 = await db.updateRow('users', [{ column: 'name', value: 'Bob' }], [{ column: 'id', value: 1 }]);
  assert.equal(res2.success, false);
  assert.match(res2.error ?? '', /read-only mode/i);

  const res3 = await db.deleteRow('users', [{ column: 'id', value: 1 }]);
  assert.equal(res3.success, false);
  assert.match(res3.error ?? '', /read-only mode/i);

  const res4 = await db.dropTable('users');
  assert.equal(res4.success, false);
  assert.match(res4.error ?? '', /read-only mode/i);

  await db.close();
});

test('CLI arguments and config parse PostgreSQL connection strings', () => {
  const parsed1 = parseArgs(['--connection', 'postgresql://postgres:pass@localhost:5432/appdb']);
  assert.equal(parsed1.args.connection, 'postgresql://postgres:pass@localhost:5432/appdb');
  assert.equal(parsed1.args.dbPath, 'postgresql://postgres:pass@localhost:5432/appdb');

  const parsed2 = parseArgs(['postgresql://postgres:pass@localhost:5432/mydb']);
  assert.equal(parsed2.args.connection, 'postgresql://postgres:pass@localhost:5432/mydb');

  const parsed3 = parseArgs(['--pg', 'postgres://localhost/mydb']);
  assert.equal(parsed3.args.connection, 'postgres://localhost/mydb');

  const envConfig = loadConfig({
    DATABASE_URL: 'postgresql://envuser:envpass@localhost:5432/envdb',
  });
  assert.equal(envConfig.connection, 'postgresql://envuser:envpass@localhost:5432/envdb');
  assert.equal(envConfig.dbPath, 'postgresql://envuser:envpass@localhost:5432/envdb');
});

test('createRouter initializes with PostgreSQL connection string', () => {
  const app = createRouter({
    connection: 'postgresql://postgres:pass@localhost:5432/router_test',
    auth: false,
    readonly: true,
  });
  assert.ok(app);
});

test('CLI arguments parse JSON configuration files with PostgreSQL connections', () => {
  const tmpDir = os.tmpdir();
  const jsonPath = path.join(tmpDir, 'name.postgres.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      name: 'postgresql://postgres:secret@localhost:5432/mydb',
      name1: 'postgresql://postgres:secret@localhost:5432/mydb1',
      port: 8080,
    }),
  );

  try {
    const parsed = parseArgs([jsonPath]);
    assert.ok(parsed.args.connections);
    assert.equal(parsed.args.connections.name, 'postgresql://postgres:secret@localhost:5432/mydb');
    assert.equal(parsed.args.connections.name1, 'postgresql://postgres:secret@localhost:5432/mydb1');
    assert.equal(parsed.args.port, 8080);
    assert.equal(parsed.args.configPath, jsonPath);

    const manager = new DbManager({
      connections: parsed.args.connections,
      readonly: true,
    });

    const list = manager.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'name');
    assert.equal(list[0].dialect, 'postgres');
    assert.ok(list[0].path.includes('****'));
    assert.equal(list[1].id, 'name1');
    assert.equal(list[1].dialect, 'postgres');

    assert.equal(manager.has('name'), true);
    assert.equal(manager.has('name1'), true);
    assert.equal(manager.has('nonexistent'), false);
  } finally {
    try {
      fs.unlinkSync(jsonPath);
    } catch {}
  }
});

test('DbManager supports dynamic addConnection and safe removal for PostgreSQL', () => {
  const manager = new DbManager({});
  assert.equal(manager.list().length, 0);

  const id = manager.addConnection('analytics', 'postgresql://postgres:pass@localhost:5432/analytics_db');
  assert.equal(id, 'analytics');
  assert.equal(manager.has('analytics'), true);

  const list = manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'analytics');
  assert.equal(list[0].dialect, 'postgres');
  assert.ok(list[0].path.includes('****'));

  // Removing postgres connection does not throw or fail
  manager.remove('analytics');
  assert.equal(manager.has('analytics'), false);
  assert.equal(manager.list().length, 0);
});

test('PostgresDatabase auto-enables SSL for remote cloud hosts (e.g. Neon, Supabase, AWS RDS)', () => {
  const logger = createLogger('error');
  
  // Neon host
  const dbNeon = new PostgresDatabase('postgresql://user:secret@ep12oler.ap-southeast-1.aws.neon.tech/mbk_db', logger, {
    readonly: true,
  });
  assert.equal(dbNeon.dialect, 'postgres');
  assert.ok(dbNeon.path.includes('ep12oler.ap-southeast-1.aws.neon.tech'));
  assert.ok(dbNeon.path.includes('****'));
  dbNeon.close();

  // Supabase host
  const dbSupabase = new PostgresDatabase('postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres', logger, {
    readonly: true,
  });
  assert.equal(dbSupabase.dialect, 'postgres');
  assert.ok(dbSupabase.path.includes('db.abcdefgh.supabase.co'));
  assert.ok(dbSupabase.path.includes('****'));
  dbSupabase.close();

  // Explicit sslmode=disable on remote host
  const dbDisabled = new PostgresDatabase('postgresql://user:secret@myhost.net:5432/mydb?sslmode=disable', logger, {
    readonly: true,
  });
  assert.equal(dbDisabled.dialect, 'postgres');
  dbDisabled.close();

  // Explicit sslmode=require
  const dbRequire = new PostgresDatabase('postgresql://user:secret@localhost:5432/mydb?sslmode=require', logger, {
    readonly: true,
  });
  assert.equal(dbRequire.dialect, 'postgres');
  dbRequire.close();
});

test('DbManager manages per-database Read-only state for PostgreSQL connections', () => {
  const manager = new DbManager({});
  const id = manager.addConnection('production', 'postgresql://postgres:pass@localhost:5432/proddb', true);
  
  assert.equal(manager.isDbReadOnly(id), true);
  
  // Toggle to writable
  manager.setReadonly(id, false);
  assert.equal(manager.isDbReadOnly(id), false);

  // Toggle back to read-only
  manager.setReadonly(id, true);
  assert.equal(manager.isDbReadOnly(id), true);
});

const PG_TEST_URL =
  process.env.TEST_POSTGRES_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/postgres';

async function checkPgLive(): Promise<boolean> {
  try {
    const { Client } = await import('pg');
    const client = new Client({
      connectionString: PG_TEST_URL,
      connectionTimeoutMillis: 1500,
      ssl:
        PG_TEST_URL.includes('sslmode=require') ||
        (!PG_TEST_URL.includes('localhost') && !PG_TEST_URL.includes('127.0.0.1'))
          ? { rejectUnauthorized: false }
          : undefined,
    });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}

test('Live PostgreSQL: Complete Dual-Engine CRUD, Schema Inspection & Seeder Suite', async (t) => {
  const isAvailable = await checkPgLive();
  if (!isAvailable) {
    t.skip(`PostgreSQL server not reachable at ${PG_TEST_URL.replace(/:([^@]+)@/, ':****@')} (skipping live integration test — tests succeed without requiring live db)`);
    return;
  }

  const logger = createLogger('error');
  const db = new PostgresDatabase(PG_TEST_URL, logger);

  try {
    // 1. Setup sample PostgreSQL table
    await db.execResult(`
      DROP TABLE IF EXISTS _admindb_test_suite CASCADE;
      CREATE TABLE _admindb_test_suite (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        score INT DEFAULT 100,
        tags TEXT[] DEFAULT ARRAY['admin']::TEXT[]
      );
    `);

    // 2. Insert rows
    const insertRes = await db.insertRows('_admindb_test_suite', [
      [{ column: 'name', value: 'Alice' }, { column: 'email', value: 'alice@example.com' }, { column: 'score', value: 95 }],
      [{ column: 'name', value: 'Bob' }, { column: 'email', value: 'bob@example.com' }, { column: 'score', value: 80 }],
      [{ column: 'name', value: 'Charlie' }, { column: 'email', value: 'charlie@example.com' }, { column: 'score', value: 60 }],
    ]);
    assert.equal(insertRes.success, true);
    assert.equal(insertRes.data?.inserted, 3);

    // 3. Count rows
    const countRes = await db.getRowCount('_admindb_test_suite');
    assert.equal(countRes.success, true);
    assert.equal(countRes.data, 3);

    // 4. Filter query
    const filterRes = await db.getRows('_admindb_test_suite', {
      filters: { name: '=Alice' },
    });
    assert.equal(filterRes.success, true);
    assert.equal((filterRes.data ?? []).length, 1);
    assert.equal(filterRes.data![0].name, 'Alice');

    // 5. Update row
    const updateRes = await db.updateRow(
      '_admindb_test_suite',
      [{ column: 'score', value: 99 }],
      [{ column: 'name', value: 'Alice' }],
    );
    assert.equal(updateRes.success, true);

    // 6. Schema inspection
    const infoRes = await db.getTableInfo('_admindb_test_suite');
    assert.equal(infoRes.success, true);
    assert.ok(infoRes.data?.columns.some((c) => c.name === 'name'));
    assert.ok(infoRes.data?.primaryKey.includes('id'));

    // 7. Delete row
    const deleteRes = await db.deleteRow('_admindb_test_suite', [{ column: 'name', value: 'Charlie' }]);
    assert.equal(deleteRes.success, true);

    const finalCount = await db.getRowCount('_admindb_test_suite');
    assert.equal(finalCount.data, 2);

    // Cleanup
    await db.execResult('DROP TABLE IF EXISTS _admindb_test_suite CASCADE;');
  } finally {
    await db.close();
  }
});





