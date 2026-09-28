import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLogger } from '../src/utils/logger';
import { SqliteDatabase } from '../src/db/database';
import { createRouter } from '../src/app';
import { RowsService } from '../src/modules/rows/index';
import { createCsvStream, createJsonStream, parseCsvStreamBatched } from '../src/utils/stream';

test('Streaming: createCsvStream emits valid RFC 4180 CSV with header', async () => {
  const stream = createCsvStream(['id', 'name', 'notes']);
  const chunks: string[] = [];

  stream.on('data', (chunk) => chunks.push(chunk.toString()));

  stream.write({ id: 1, name: 'Alice', notes: 'line 1\nline 2' });
  stream.write({ id: 2, name: 'Bob, "The Builder"', notes: 'ok' });
  stream.end();

  await new Promise((res) => stream.on('end', res));

  const output = chunks.join('');
  assert.ok(output.startsWith('id,name,notes\r\n'));
  assert.ok(output.includes('1,Alice,"line 1\nline 2"\r\n'));
  assert.ok(output.includes('2,"Bob, ""The Builder""",ok\r\n'));
});

test('Streaming: createJsonStream emits valid formatted JSON array', async () => {
  const stream = createJsonStream();
  const chunks: string[] = [];

  stream.on('data', (chunk) => chunks.push(chunk.toString()));

  stream.write({ id: 1, title: 'First' });
  stream.write({ id: 2, title: 'Second' });
  stream.end();

  await new Promise((res) => stream.on('end', res));

  const output = chunks.join('');
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'First');
  assert.equal(parsed[1].title, 'Second');
});

test('Streaming: parseCsvStreamBatched parses multiline and batches rows', async () => {
  const csvContent = 'id,name,desc\n1,Alpha,"multi\nline"\n2,Beta,simple\n3,Gamma,extra\n';
  async function* generateChunks() {
    yield csvContent.slice(0, 15);
    yield csvContent.slice(15, 30);
    yield csvContent.slice(30);
  }

  const batches: string[][][] = [];
  const total = await parseCsvStreamBatched(
    generateChunks(),
    async (batch) => {
      batches.push(batch);
    },
    2,
  );

  assert.equal(total, 4); // 1 header + 3 data rows
  assert.equal(batches.length, 2);
  assert.equal(batches[0][0][1], 'name');
  assert.equal(batches[0][1][2], 'multi\nline');
});

test('Cursor Pagination: RowsService.getCursorPaginatedRows traverses pages seamlessly', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-cursor-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const logger = createLogger('error');
  const db = new SqliteDatabase(dbPath, logger);

  try {
    db.execResult(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        val INTEGER NOT NULL
      );
    `);

    for (let i = 1; i <= 25; i++) {
      db.execResult(`INSERT INTO items (name, val) VALUES ('Item ${i}', ${i * 10});`);
    }

    const app = createRouter({ db, auth: false });
    const ctx = (app as any).locals?.context ?? {
      id: 'test',
      name: 'test',
      path: dbPath,
      db,
      dialect: { name: 'sqlite', capabilities: {} },
      capabilities: {},
      isReadOnly: false,
      logger,
    };

    // Page 1: limit 10
    const page1 = await RowsService.getCursorPaginatedRows(ctx, 'items', { limit: 10 });
    assert.equal(page1.rows.length, 10);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor);
    assert.equal(page1.prevCursor, null);
    assert.equal(page1.rows[0].id, 1);
    assert.equal(page1.rows[9].id, 10);

    // Page 2: with nextCursor
    const page2 = await RowsService.getCursorPaginatedRows(ctx, 'items', {
      cursor: page1.nextCursor,
      limit: 10,
    });
    assert.equal(page2.rows.length, 10);
    assert.equal(page2.hasMore, true);
    assert.ok(page2.nextCursor);
    assert.ok(page2.prevCursor);
    assert.equal(page2.rows[0].id, 11);
    assert.equal(page2.rows[9].id, 20);

    // Page 3: with nextCursor (final 5 items)
    const page3 = await RowsService.getCursorPaginatedRows(ctx, 'items', {
      cursor: page2.nextCursor,
      limit: 10,
    });
    assert.equal(page3.rows.length, 5);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.nextCursor, null);
    assert.equal(page3.rows[0].id, 21);
    assert.equal(page3.rows[4].id, 25);
  } finally {
    db.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
