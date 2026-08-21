import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../src/db/database';
import { PostgresDatabase } from '../src/db/postgres';
import type { IDatabase } from '../src/db/types';
import { createLogger } from '../src/utils/logger';

export const PG_TEST_URL =
  process.env.TEST_POSTGRES_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/postgres';

let isPgLiveCache: boolean | null = null;

export async function isPostgresAvailable(): Promise<boolean> {
  if (isPgLiveCache !== null) return isPgLiveCache;
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
    isPgLiveCache = true;
  } catch {
    isPgLiveCache = false;
  }
  return isPgLiveCache;
}

export interface TestDbInstance {
  dialect: 'sqlite' | 'postgres';
  db: IDatabase;
  cleanup: () => Promise<void> | void;
}

export function openSqliteTestDb(): TestDbInstance {
  const root = mkdtempSync(path.join(tmpdir(), 'admindb-test-sqlite-'));
  const db = new SqliteDatabase(path.join(root, 'test.db'), createLogger('error'));
  return {
    dialect: 'sqlite',
    db,
    cleanup: () => {
      db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function openPostgresTestDb(): Promise<TestDbInstance | null> {
  const available = await isPostgresAvailable();
  if (!available) return null;
  const db = new PostgresDatabase(PG_TEST_URL, createLogger('error'));
  return {
    dialect: 'postgres',
    db,
    cleanup: async () => {
      await db.close();
    },
  };
}
