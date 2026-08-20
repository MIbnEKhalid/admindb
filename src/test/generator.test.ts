import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCreateTable,
  generateInsert,
  generateUpdate,
  generateAddColumn,
  generateRenameTable,
  generateRenameColumn,
  generateDropColumn,
  generateDropTable,
  generateCreateIndex,
  generateDropIndex,
  renderColumnDef,
  quoteIdentifier,
  sqlValue,
  mapColumnType,
} from '../sql/generator';

test('quoteIdentifier quotes and escapes double quotes', () => {
  assert.equal(quoteIdentifier('user name'), '"user name"');
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
});

test('sqlValue formats values safely', () => {
  assert.equal(sqlValue("O'Reilly"), "'O''Reilly'");
  assert.equal(sqlValue(0), '0');
  assert.equal(sqlValue(null), 'NULL');
  assert.equal(sqlValue(undefined), 'NULL');
  assert.equal(sqlValue(true), '1');
  assert.equal(sqlValue(false), '0');
  assert.equal(sqlValue(42), '42');
  assert.equal(sqlValue(3.14), '3.14');
});

test('mapColumnType maps designer and standard SQL types', () => {
  assert.equal(mapColumnType('INTEGER').sqlType, 'INTEGER');
  assert.equal(mapColumnType('TEXT').sqlType, 'TEXT');
  assert.equal(mapColumnType('REAL').sqlType, 'REAL');
  assert.equal(mapColumnType('BLOB').sqlType, 'BLOB');
  assert.equal(mapColumnType('BOOLEAN').sqlType, 'INTEGER');
  assert.equal(mapColumnType('DATE').sqlType, 'DATETIME');
  assert.equal(mapColumnType('DATE').defaultAuto, 'CURRENT_TIMESTAMP');
  assert.equal(mapColumnType('datetime').sqlType, 'DATETIME');
  assert.equal(mapColumnType('VARCHAR(255)').sqlType, 'VARCHAR(255)');
  assert.equal(mapColumnType('BIGINT').sqlType, 'INTEGER');
  assert.equal(mapColumnType('DECIMAL(10,2)').sqlType, 'DECIMAL(10,2)');
});

test('mapColumnType rejects unsupported types', () => {
  assert.throws(() => mapColumnType('INVALID; DROP TABLE'), /Unsupported column type/);
  assert.throws(() => mapColumnType("TEXT'--"), /Unsupported column type/);
});

test('generateCreateTable produces a valid CREATE TABLE', () => {
  const sql = generateCreateTable('users', [
    { name: 'id', type: 'INTEGER', primaryKey: true },
    { name: 'name', type: 'TEXT', notNull: true },
    { name: 'balance', type: 'REAL', defaultValue: '0' },
    { name: 'active', type: 'BOOLEAN', defaultValue: '1' },
  ]);
  assert.equal(
    sql,
    'CREATE TABLE "users" (\n' +
      '  "id" INTEGER PRIMARY KEY,\n' +
      '  "name" TEXT NOT NULL,\n' +
      '  "balance" REAL DEFAULT 0,\n' +
      '  "active" INTEGER DEFAULT 1\n' +
      ');',
  );
});

test('generateCreateTable adds a foreign key reference', () => {
  const sql = generateCreateTable('orders', [
    { name: 'id', type: 'INTEGER', primaryKey: true },
    { name: 'user_id', type: 'INTEGER', foreignKey: { table: 'users', column: 'id' } },
  ]);
  assert.ok(sql.includes('REFERENCES "users"("id")'));
});

test('generateCreateTable maps DATE to datetime with a current-timestamp default', () => {
  const sql = generateCreateTable('events', [{ name: 'occurred_at', type: 'DATE' }]);
  assert.ok(sql.includes('"occurred_at" DATETIME DEFAULT CURRENT_TIMESTAMP'));
});

test('generateCreateTable keeps a user-supplied default over the DATE auto default', () => {
  const sql = generateCreateTable('events', [{ name: 'occurred_at', type: 'DATE', defaultValue: '0' }]);
  assert.ok(sql.includes('DEFAULT 0'));
  assert.ok(!sql.includes('DEFAULT 0 DEFAULT'));
});

test('generateCreateTable rejects more than one primary key', () => {
  assert.throws(
    () =>
      generateCreateTable('t', [
        { name: 'a', type: 'INTEGER', primaryKey: true },
        { name: 'b', type: 'INTEGER', primaryKey: true },
      ]),
    /primary key/i,
  );
});

test('generateCreateTable rejects empty table name and empty columns', () => {
  assert.throws(() => generateCreateTable('', [{ name: 'a', type: 'TEXT' }]), /Table name/);
  assert.throws(() => generateCreateTable('t', []), /column/i);
});

test('generateInsert builds an INSERT with escaping', () => {
  const sql = generateInsert('users', [
    { column: 'name', value: "O'Reilly" },
    { column: 'age', value: 0 },
    { column: 'note', value: null },
  ]);
  assert.equal(sql, 'INSERT INTO "users" ("name", "age", "note") VALUES (\'O\'\'Reilly\', 0, NULL);');
});

test('generateUpdate builds an UPDATE with a WHERE clause', () => {
  const sql = generateUpdate('users', [{ column: 'name', value: 'Bob' }], [{ column: 'id', value: 5 }]);
  assert.equal(sql, 'UPDATE "users" SET "name" = \'Bob\' WHERE "id" = 5;');
});

test('generateAddColumn builds an ADD COLUMN statement', () => {
  const sql = generateAddColumn('users', { name: 'nickname', type: 'TEXT', defaultValue: "'anon'" });
  assert.equal(sql, 'ALTER TABLE "users" ADD COLUMN "nickname" TEXT DEFAULT \'anon\';');
});

test('generateAddColumn rejects PRIMARY KEY and UNIQUE', () => {
  assert.throws(() => generateAddColumn('t', { name: 'a', type: 'INTEGER', primaryKey: true }), /primary key/i);
  assert.throws(() => generateAddColumn('t', { name: 'a', type: 'TEXT', unique: true }), /UNIQUE/i);
});

test('generateAddColumn requires a default for NOT NULL', () => {
  assert.throws(() => generateAddColumn('t', { name: 'a', type: 'TEXT', notNull: true }), /NOT NULL/i);
  assert.equal(
    generateAddColumn('t', { name: 'a', type: 'TEXT', notNull: true, defaultValue: "'x'" }),
    "ALTER TABLE \"t\" ADD COLUMN \"a\" TEXT NOT NULL DEFAULT 'x';",
  );
});

test('generateAddColumn rejects foreign key with a non-NULL default', () => {
  assert.throws(
    () => generateAddColumn('orders', { name: 'user_id', type: 'INTEGER', defaultValue: '1', foreignKey: { table: 'users', column: 'id' } }),
    /foreign key/i,
  );
  assert.equal(
    generateAddColumn('orders', { name: 'user_id', type: 'INTEGER', foreignKey: { table: 'users', column: 'id' } }),
    'ALTER TABLE "orders" ADD COLUMN "user_id" INTEGER REFERENCES "users"("id");',
  );
});

test('generateRenameTable / renameColumn / dropColumn / dropTable quote identifiers', () => {
  assert.equal(generateRenameTable('users', 'people'), 'ALTER TABLE "users" RENAME TO "people";');
  assert.equal(generateRenameColumn('users', 'name', 'full_name'), 'ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";');
  assert.equal(generateDropColumn('users', 'age'), 'ALTER TABLE "users" DROP COLUMN "age";');
  assert.equal(generateDropTable('users'), 'DROP TABLE "users";');
  assert.throws(() => generateDropTable('bad name; DROP'), /Invalid table name/);
});

test('renderColumnDef matches CREATE TABLE output for a column', () => {
  assert.equal(
    renderColumnDef({ name: 'balance', type: 'REAL', defaultValue: '0' }),
    '"balance" REAL DEFAULT 0',
  );
  assert.equal(
    renderColumnDef({ name: 'id', type: 'INTEGER', primaryKey: true }),
    '"id" INTEGER PRIMARY KEY',
  );
});

test('generateCreateIndex builds a plain index with an auto name', () => {
  assert.equal(
    generateCreateIndex('users', { columns: ['email'] }),
    'CREATE INDEX "idx_users_email" ON "users" ("email");',
  );
});

test('generateCreateIndex builds a unique multi-column index with an explicit name', () => {
  assert.equal(
    generateCreateIndex('users', { name: 'ix_name_email', columns: ['last_name', 'email'], unique: true }),
    'CREATE UNIQUE INDEX "ix_name_email" ON "users" ("last_name", "email");',
  );
});

test('generateCreateIndex validates names and requires columns', () => {
  assert.throws(() => generateCreateIndex('users', { columns: [] }), /At least one column/);
  assert.throws(() => generateCreateIndex('users', { columns: ['a; DROP'] }), /Invalid column name/);
  assert.throws(() => generateCreateIndex('users', { name: 'bad name', columns: ['a'] }), /Invalid index name/);
  assert.throws(() => generateCreateIndex('', { columns: ['a'] }), /Table name/);
});

test('generateDropIndex quotes the index name', () => {
  assert.equal(generateDropIndex('idx_users_email'), 'DROP INDEX "idx_users_email";');
  assert.throws(() => generateDropIndex('bad; DROP'), /Invalid index name/);
});
