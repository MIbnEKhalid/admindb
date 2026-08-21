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


