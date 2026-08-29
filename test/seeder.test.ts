import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../src/db/database';
import { createLogger } from '../src/utils/logger';
import { generateOne, generateSampleValue, detectPlan, buildColumnConfigs, generateRows, buildSeedInsertSql, sanitizeColumnPlan, formatPattern, SKIP } from '../src/data/index';

function openDb(): { db: SqliteDatabase; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-seeder-test-'));
  const db = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('formatPattern correctly generates strings from template tokens', () => {
  const p1 = formatPattern('INV-2026-####');
  assert.match(p1, /^INV-2026-\d{4}$/);

  const p2 = formatPattern('SKU-???-##');
  assert.match(p2, /^SKU-[A-Z]{3}-\d{2}$/);

  const p3 = formatPattern('code-aaaa');
  assert.match(p3, /^code-[a-z]{4}$/);
});

test('generateOne generates valid values for all new strategies', () => {
  const textCol = { cid: 0, name: 'val', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 };
  const intCol = { cid: 0, name: 'val', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 };

  // Company
  const company = generateOne(textCol, { strategy: 'company' });
  assert.equal(typeof company, 'string');
  assert.ok((company as string).length > 2);

  // Job title
  const job = generateOne(textCol, { strategy: 'job' });
  assert.equal(typeof job, 'string');
  assert.ok((job as string).length > 2);

  // Avatar URL
  const avatar = generateOne(textCol, { strategy: 'avatar' });
  assert.ok((avatar as string).startsWith('https://api.dicebear.com/'));

  // Color
  const hexColor = generateOne(textCol, { strategy: 'color', format: 'hex' });
  assert.match(hexColor as string, /^#[0-9a-fA-F]{6}$/);

  const namedColor = generateOne(textCol, { strategy: 'color', format: 'name' });
  assert.equal(typeof namedColor, 'string');

  // Currency
  const currency = generateOne(textCol, { strategy: 'currency' });
  assert.match(currency as string, /^[A-Z]{3}$/);

  // Country code
  const countryCode = generateOne(textCol, { strategy: 'countryCode' });
  assert.match(countryCode as string, /^[A-Z]{2}$/);

  // Status
  const status = generateOne(textCol, { strategy: 'status' });
  assert.equal(typeof status, 'string');

  // MAC address
  const mac = generateOne(textCol, { strategy: 'mac' });
  assert.match(mac as string, /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/);

  // Credit card
  const cc = generateOne(textCol, { strategy: 'creditCard' });
  assert.match(cc as string, /^4532-\d{4}-\d{4}-\d{4}$/);

  // Slug
  const slug = generateOne(textCol, { strategy: 'slug' });
  assert.match(slug as string, /^[a-z0-9]+-[a-z0-9]+-\d+$/);

  // Sequence
  const seq0 = generateOne(intCol, { strategy: 'sequence', start: 100, step: 5 }, undefined, 0);
  const seq1 = generateOne(intCol, { strategy: 'sequence', start: 100, step: 5 }, undefined, 1);
  const seq2 = generateOne(intCol, { strategy: 'sequence', start: 100, step: 5 }, undefined, 2);
  assert.equal(seq0, 100);
  assert.equal(seq1, 105);
  assert.equal(seq2, 110);

  // Pattern
  const pat = generateOne(textCol, { strategy: 'pattern', pattern: 'ORDER-####' });
  assert.match(pat as string, /^ORDER-\d{4}$/);

  // Unix timestamp
  const tsSec = generateOne(intCol, { strategy: 'timestampUnix', format: 'sec' });
  assert.equal(typeof tsSec, 'number');
  assert.ok((tsSec as number) > 1000000000);
});

test('generateOne applies prefix and suffix to text values', () => {
  const col = { cid: 0, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 };
  const val = generateOne(col, { strategy: 'fixed', value: 'item', prefix: 'REF-', suffix: '-2026' });
  assert.equal(val, 'REF-item-2026');
});

test('generateOne handles nullPct for nullable columns', () => {
  const col = { cid: 0, name: 'bio', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 };
  const valAlwaysNull = generateOne(col, { strategy: 'words', nullPct: 100 });
  assert.equal(valAlwaysNull, null);

  const valNeverNull = generateOne(col, { strategy: 'fixed', value: 'hello', nullPct: 0 });
  assert.equal(valNeverNull, 'hello');
});

test('detectPlan heuristics intelligently pick new strategies', () => {
  // Company
  const pComp = detectPlan({ cid: 0, name: 'company_name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pComp.strategy, 'company');

  // Job title
  const pJob = detectPlan({ cid: 0, name: 'job_title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pJob.strategy, 'job');

  // Avatar
  const pAvatar = detectPlan({ cid: 0, name: 'avatar_url', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pAvatar.strategy, 'avatar');

  // Currency
  const pCurr = detectPlan({ cid: 0, name: 'currency_code', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pCurr.strategy, 'currency');

  // Country code
  const pCc = detectPlan({ cid: 0, name: 'country_code', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pCc.strategy, 'countryCode');

  // Slug
  const pSlug = detectPlan({ cid: 0, name: 'slug', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pSlug.strategy, 'slug');

  // MAC
  const pMac = detectPlan({ cid: 0, name: 'mac_address', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pMac.strategy, 'mac');

  // Latitude
  const pLat = detectPlan({ cid: 0, name: 'latitude', type: 'REAL', notnull: 1, dflt_value: null, pk: 0 }, null);
  assert.equal(pLat.strategy, 'latitude');
});

test('sanitizeColumnPlan sanitizes all extended properties', () => {
  const raw = {
    strategy: 'sequence',
    start: '100',
    step: '5',
    nullPct: '25',
    prefix: 'PRE-',
    suffix: '-POST',
    pattern: 'INV-####',
    format: 'hex',
  };
  const plan = sanitizeColumnPlan(raw);
  assert.ok(plan);
  assert.equal(plan?.strategy, 'sequence');
  assert.equal(plan?.start, 100);
  assert.equal(plan?.step, 5);
  assert.equal(plan?.nullPct, 25);
  assert.equal(plan?.prefix, 'PRE-');
  assert.equal(plan?.suffix, '-POST');
  assert.equal(plan?.pattern, 'INV-####');
  assert.equal(plan?.format, 'hex');
});

test('generateRows generates and inserts valid rows with preview rows', async () => {
  const { db, cleanup } = openDb();
  try {
    await db.execResult(`
      CREATE TABLE test_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        company TEXT,
        job TEXT,
        status TEXT,
        score INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const tableInfo = await db.getTableInfo('test_users');
    assert.ok(tableInfo.success && tableInfo.data);

    const configs = buildColumnConfigs(tableInfo.data);
    const gen = await generateRows(db, tableInfo.data, configs, 10);

    assert.equal(gen.rows.length, 10);
    assert.ok(gen.previewRows.length > 0);
    assert.equal(gen.previewRows.length, 10);

    // Verify structured preview row keys
    assert.ok('name' in gen.previewRows[0]);
    assert.ok('email' in gen.previewRows[0]);

    // Build SQL and verify statements
    const sql = buildSeedInsertSql('test_users', gen.rows);
    assert.ok(sql.includes('INSERT INTO "test_users"'));

    // Insert rows into SQLite database and verify
    const insertRes = await db.insertRows('test_users', gen.rows);
    assert.ok(insertRes.success);
    assert.equal(insertRes.data?.inserted, 10);

    const checkRows = await db.getRows('test_users');
    assert.equal((checkRows.data as unknown[]).length, 10);
  } finally {
    cleanup();
  }
});
