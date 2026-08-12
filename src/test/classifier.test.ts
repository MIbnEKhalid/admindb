import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySql } from '../sql/classifier';

test('classifies SELECT statements as select', () => {
  assert.equal(classifySql('SELECT * FROM users').kind, 'select');
  assert.equal(classifySql('  select id, name from users;').kind, 'select');
  assert.equal(classifySql('WITH c AS (SELECT 1) SELECT * FROM c').kind, 'select');
});

test('classifies pure count queries as count', () => {
  assert.equal(classifySql('SELECT count(*) FROM users').kind, 'count');
  assert.equal(classifySql('select COUNT(id) from orders').kind, 'count');
});

test('does not classify grouped or unioned selects as count', () => {
  assert.equal(classifySql('SELECT type, count(*) FROM items GROUP BY type').kind, 'select');
  assert.equal(classifySql('SELECT count(*) FROM a UNION SELECT count(*) FROM b').kind, 'select');
});

test('classifies write statements as write', () => {
  const writes = [
    'INSERT INTO t (a) VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'CREATE TABLE t (a TEXT)',
    'ALTER TABLE t ADD COLUMN b TEXT',
    'DROP TABLE t',
    'REPLACE INTO t (a) VALUES (1)',
  ];
  for (const sql of writes) {
    assert.equal(classifySql(sql).kind, 'write', sql);
  }
});

test('classifies PRAGMA and EXPLAIN as read', () => {
  assert.equal(classifySql('PRAGMA table_info(users)').kind, 'read');
  assert.equal(classifySql('EXPLAIN QUERY PLAN SELECT * FROM t').kind, 'read');
});

test('ignores leading comments and whitespace', () => {
  assert.equal(classifySql('-- hello\nSELECT * FROM t').kind, 'select');
  assert.equal(classifySql('/* block */\n INSERT INTO t (a) VALUES (1)').kind, 'write');
});
