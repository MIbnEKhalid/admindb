/**
 * Tests for the SQL Error Analyzer & Explainer (src/sql/error-analyzer.ts)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSqlError, buildErrorSnippet, offsetToLineCol } from '../src/sql/error-analyzer';

test('SQL Error Analyzer: Line and Column Calculations', async (t) => {
  await t.test('offsetToLineCol converts 1-based char offset to line/col', () => {
    const sql = 'SELECT id\nFROM users\nWHERE age > 20;';
    assert.deepEqual(offsetToLineCol(sql, 1), { line: 1, column: 1 });
    assert.deepEqual(offsetToLineCol(sql, 8), { line: 1, column: 8 });
    // start of line 2
    assert.deepEqual(offsetToLineCol(sql, 11), { line: 2, column: 1 });
    // 'WHERE' on line 3
    assert.deepEqual(offsetToLineCol(sql, 22), { line: 3, column: 1 });
  });

  await t.test('buildErrorSnippet generates 3-line context with pointer', () => {
    const sql = 'SELECT id\nFROM users\nWHERE (age > 20;';
    const snippet = buildErrorSnippet(sql, 3, 7);
    assert.ok(snippet.includes('>  3 | WHERE (age > 20;'), 'should contain error line with > marker');
    assert.ok(snippet.includes('^'), 'should contain ^ pointer');
  });
});

test('SQL Error Analyzer: SQLite syntax error explanations', async (t) => {
  await t.test('explains near "(" syntax error and pinpoints line & column', async () => {
    const sql = 'SELECT * \nFROM (\nWHERE id = 1;';
    const details = await analyzeSqlError(sql, 'near "(": syntax error');

    assert.equal(details.line, 2);
    assert.equal(details.column, 6);
    assert.equal(details.token, '(');
    assert.ok(details.cause, 'should provide a cause');
    assert.ok(details.suggestion, 'should provide a suggestion');
    assert.ok(details.snippet?.includes('>  2 | FROM ('), 'snippet should highlight line 2');
    assert.ok(details.snippet?.includes('^'), 'snippet should include pointer');
  });

  await t.test('explains PostgreSQL DEFAULT gen_random_uuid() syntax error on SQLite', async () => {
    const sql = `CREATE TABLE users (\n  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  username VARCHAR(50) NOT NULL\n);`;
    const details = await analyzeSqlError(sql, 'near "(": syntax error');

    assert.equal(details.line, 2);
    assert.ok(details.cause?.includes('gen_random_uuid'));
    assert.ok(details.suggestion?.includes('randomblob') || details.suggestion?.includes('PostgreSQL'));
  });

  await t.test('explains mismatched parentheses', async () => {
    const sql = 'SELECT id, (name, email \nFROM users;';
    const details = await analyzeSqlError(sql, 'near "FROM": syntax error');

    assert.ok(details.cause?.includes('parenthes') || details.suggestion?.includes('parenthes') || details.cause?.includes('FROM'));
  });

  await t.test('explains trailing comma before FROM clause', async () => {
    const sql = 'SELECT id, name, \nFROM users;';
    const details = await analyzeSqlError(sql, 'near "FROM": syntax error');

    assert.ok(details.cause?.toLowerCase().includes('comma') || details.suggestion?.toLowerCase().includes('comma'));
  });

  await t.test('explains no such table with typo suggestion', async () => {
    const mockDb = {
      listTables: async () => ({
        success: true,
        data: [{ name: 'users' }, { name: 'orders' }, { name: 'products' }],
      }),
    } as never;

    const sql = 'SELECT * FROM usrs WHERE id = 1;';
    const details = await analyzeSqlError(sql, 'no such table: usrs', mockDb);

    assert.equal(details.line, 1);
    assert.equal(details.token, 'usrs');
    assert.ok(details.cause?.includes('usrs'));
    assert.ok(details.suggestion?.includes('users'), 'should suggest closest table "users"');
  });

  await t.test('explains no such column error', async () => {
    const sql = 'SELECT eml FROM users;';
    const details = await analyzeSqlError(sql, 'no such column: eml');

    assert.equal(details.line, 1);
    assert.equal(details.token, 'eml');
    assert.ok(details.cause?.includes('eml'));
    assert.ok(details.suggestion?.includes('eml'));
  });

  await t.test('explains constraint violations', async () => {
    const sql = 'INSERT INTO users (email) VALUES ("test@example.com");';
    const uniqueErr = await analyzeSqlError(sql, 'UNIQUE constraint failed: users.email');
    assert.ok(uniqueErr.cause?.toLowerCase().includes('unique'));
    assert.ok(uniqueErr.suggestion);

    const fkErr = await analyzeSqlError(sql, 'FOREIGN KEY constraint failed');
    assert.ok(fkErr.cause?.includes('Foreign key') || fkErr.cause?.includes('foreign key'));

    const notNullErr = await analyzeSqlError(sql, 'NOT NULL constraint failed: users.name');
    assert.ok(notNullErr.cause?.includes('NOT NULL'));
  });

  await t.test('explains table already exists error and locates CREATE TABLE line', async () => {
    const sql = `-- Script header\nPRAGMA foreign_keys = ON;\n\nCREATE TABLE entities (\n  id INTEGER PRIMARY KEY\n);`;
    const details = await analyzeSqlError(sql, 'table entities already exists');

    assert.equal(details.line, 4);
    assert.equal(details.token, 'entities');
    assert.ok(details.cause?.includes('entities'));
    assert.ok(details.suggestion?.includes('IF NOT EXISTS') || details.suggestion?.includes('DROP TABLE'));
  });

  await t.test('explains non-deterministic functions in generated columns', async () => {
    const sql = `CREATE TABLE employments (\n  id INTEGER PRIMARY KEY,\n  is_active BOOLEAN GENERATED ALWAYS AS (end_date > CURRENT_DATE) VIRTUAL\n);`;
    const details = await analyzeSqlError(sql, 'non-deterministic functions prohibited in generated columns');

    assert.equal(details.line, 3);
    assert.ok(details.cause?.includes('CURRENT_DATE') || details.cause?.includes('non-deterministic'));
    assert.ok(details.suggestion?.includes('CURRENT_DATE') || details.suggestion?.includes('GENERATED ALWAYS AS'));
  });

  await t.test('ignores tokens inside SQL comments and locates actual statement', async () => {
    const sql = `-- TEAMS (6 teams with managers)\n-- More comments about teams\n\nINSERT INTO teams (name) VALUES ('Engineering');`;
    const details = await analyzeSqlError(sql, 'near "teams": syntax error');

    assert.equal(details.line, 4);
    assert.equal(details.column, 13);
    assert.equal(details.token, 'teams');
  });

  await t.test('explains incomplete input (unclosed quotes / parentheses)', async () => {
    const sql = "SELECT * FROM users WHERE name = 'Alice";
    const details = await analyzeSqlError(sql, 'incomplete input');

    assert.ok(details.cause?.includes('quote') || details.cause?.includes('incomplete'));
    assert.ok(details.suggestion?.includes('quote') || details.suggestion?.includes('closing'));
  });
});

test('SQL Error Analyzer: PostgreSQL syntax error handling', async (t) => {
  await t.test('uses error.position from PostgreSQL driver when available', async () => {
    const sql = 'SELECT id, name\nFROM users\nWHERE (age > 20;';
    const pgErr = {
      message: 'syntax error at end of input',
      position: '38', // 1-based character position
    };
    const details = await analyzeSqlError(sql, pgErr);

    assert.equal(details.line, 3);
    assert.ok(details.snippet);
    assert.ok(details.cause);
  });
});
