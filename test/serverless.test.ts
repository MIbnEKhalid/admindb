import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import {
  createRouter,
  SqliteDatabase,
  isServerlessEnvironment,
  createServerlessHandler,
  createLambdaHandler,
} from '../src/index';
import { createLogger } from '../src/utils/logger';

test('Serverless: isServerlessEnvironment detects serverless runtimes', () => {
  // Negative test: standard local environment
  assert.equal(isServerlessEnvironment({} as NodeJS.ProcessEnv), false);
  assert.equal(isServerlessEnvironment({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false);

  // Explicit flags
  assert.equal(isServerlessEnvironment({ ADMINDB_SERVERLESS: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ SERVERLESS: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ IS_SERVERLESS: 'yes' } as NodeJS.ProcessEnv), true);

  // Vercel
  assert.equal(isServerlessEnvironment({ VERCEL: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ VERCEL_ENV: 'production' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ NOW_REGION: 'iad1' } as NodeJS.ProcessEnv), true);

  // AWS Lambda
  assert.equal(isServerlessEnvironment({ AWS_LAMBDA_FUNCTION_NAME: 'admindb-fn' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ LAMBDA_TASK_ROOT: '/var/task' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs20.x' } as NodeJS.ProcessEnv), true);

  // Netlify
  assert.equal(isServerlessEnvironment({ NETLIFY: 'true' } as NodeJS.ProcessEnv), true);

  // Google Cloud Functions / Cloud Run
  assert.equal(isServerlessEnvironment({ FUNCTION_TARGET: 'app' } as NodeJS.ProcessEnv), true);
  assert.equal(isServerlessEnvironment({ K_SERVICE: 'admindb-service' } as NodeJS.ProcessEnv), true);

  // Azure Functions
  assert.equal(isServerlessEnvironment({ FUNCTIONS_WORKER_RUNTIME: 'node' } as NodeJS.ProcessEnv), true);

  // Cloudflare Pages
  assert.equal(isServerlessEnvironment({ CF_PAGES: '1' } as NodeJS.ProcessEnv), true);
});

test('Serverless: createRouter enforces read-only mode and rejects write operations with 403', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-serverless-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const logger = createLogger('error');

  let server: Server | null = null;
  let db: SqliteDatabase | null = null;

  try {
    // 1. Setup sample SQLite database
    const setupDb = new SqliteDatabase(dbPath, logger);
    setupDb.execResult(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT);
      INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com'), ('Bob', 'bob@example.com');
    `);
    setupDb.close();

    // 2. Open in serverless mode (serverless: true)
    db = new SqliteDatabase(dbPath, logger, { readonly: true });
    assert.equal(db.isReadOnly, true);

    const app = createRouter({
      db,
      serverless: true,
      auth: false,
    });

    const port = await new Promise<number>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // 3. GET /api/tables (read route) -> 200 OK
    const getRes = await fetch(`${baseUrl}/api/tables`);
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { success: boolean; data: { name: string }[] };
    assert.equal(getBody.success, true);
    assert.equal(getBody.data.some((t) => t.name === 'users'), true);

    // 4. POST /api/tables/:table/rows (write attempt) -> 403 Forbidden
    const insertRes = await fetch(`${baseUrl}/api/tables/users/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com' }),
    });
    assert.equal(insertRes.status, 403);
    const insertBody = (await insertRes.json()) as { success: boolean; error: string };
    assert.equal(insertBody.success, false);
    assert.match(insertBody.error, /read-only mode/i);

    // 5. DELETE /api/tables/users/row/1 (write attempt) -> 403 Forbidden
    const deleteRes = await fetch(`${baseUrl}/api/tables/users/row/1`, {
      method: 'DELETE',
    });
    assert.equal(deleteRes.status, 403);

    // 6. POST /api/tables (create table attempt) -> 403 Forbidden
    const createTableRes = await fetch(`${baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'products',
        columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }],
      }),
    });
    assert.equal(createTableRes.status, 403);

    // 7. POST /api/query with SELECT (read query) -> 200 OK
    const selectQueryRes = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT id, name FROM users ORDER BY id ASC' }),
    });
    assert.equal(selectQueryRes.status, 200);
    const selectQueryBody = (await selectQueryRes.json()) as { success: boolean; data: { rows: unknown[] } };
    assert.equal(selectQueryBody.success, true);
    assert.equal(selectQueryBody.data.rows.length, 2);

    // 8. POST /api/query with INSERT / UPDATE / DELETE (write query) -> 403 Forbidden
    const writeQueryRes = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: "INSERT INTO users (name) VALUES ('Hacker')" }),
    });
    assert.equal(writeQueryRes.status, 403);
    const writeQueryBody = (await writeQueryRes.json()) as { success: boolean; error: string };
    assert.equal(writeQueryBody.success, false);
    assert.match(writeQueryBody.error, /read-only mode/i);
  } finally {
    if (server?.listening) server.close();
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Serverless: createServerlessHandler handles HTTP requests in serverless read-only mode', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-serverless-http-'));
  const dbPath = path.join(tmpDir, 'serverless-http.db');
  const logger = createLogger('error');
  let db: SqliteDatabase | null = null;
  let server: Server | null = null;

  try {
    const setupDb = new SqliteDatabase(dbPath, logger);
    setupDb.execResult(`
      CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT);
      INSERT INTO notes (content) VALUES ('Serverless Note');
    `);
    setupDb.close();

    db = new SqliteDatabase(dbPath, logger, { readonly: true });
    const handler = createServerlessHandler({
      db,
      serverless: true,
      auth: false,
    });

    server = (await new Promise<Server>((resolve) => {
      const s = require('node:http').createServer(handler);
      s.listen(0, '127.0.0.1', () => resolve(s));
    })) as Server;

    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Read route works
    const getRes = await fetch(`${baseUrl}/api/tables`);
    assert.equal(getRes.status, 200);

    // Write route is blocked with 403
    const postRes = await fetch(`${baseUrl}/api/tables/notes/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Disallowed Write' }),
    });
    assert.equal(postRes.status, 403);
  } finally {
    if (server?.listening) server.close();
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Serverless: createLambdaHandler processes APIGateway events in serverless read-only mode', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-lambda-'));
  const dbPath = path.join(tmpDir, 'lambda.db');
  const logger = createLogger('error');
  let db: SqliteDatabase | null = null;

  try {
    const setupDb = new SqliteDatabase(dbPath, logger);
    setupDb.execResult(`
      CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO articles (title) VALUES ('Serverless Guide');
    `);
    setupDb.close();

    db = new SqliteDatabase(dbPath, logger, { readonly: true });
    const handler = createLambdaHandler({
      db,
      serverless: true,
      auth: false,
    });

    // 1. Test APIGateway v1 GET request
    const getEventV1 = {
      httpMethod: 'GET',
      path: '/api/tables',
      headers: { accept: 'application/json' },
      queryStringParameters: null,
      body: null,
      isBase64Encoded: false,
    };

    const getResV1 = await handler(getEventV1);
    assert.equal(getResV1.statusCode, 200);
    const getBodyV1 = JSON.parse(getResV1.body) as { success: boolean; data: { name: string }[] };
    assert.equal(getBodyV1.success, true);
    assert.equal(getBodyV1.data.some((t) => t.name === 'articles'), true);

    // 2. Test APIGateway v2 GET request
    const getEventV2 = {
      version: '2.0',
      rawPath: '/api/tables/articles/rows',
      rawQueryString: 'limit=10',
      requestContext: {
        http: {
          method: 'GET',
          path: '/api/tables/articles/rows',
        },
      },
      headers: { accept: 'application/json' },
    };

    const getResV2 = await handler(getEventV2);
    assert.equal(getResV2.statusCode, 200);
    const getBodyV2 = JSON.parse(getResV2.body) as { success: boolean; data: { rows: { title: string }[] } };
    assert.equal(getBodyV2.success, true);
    assert.equal(getBodyV2.data.rows[0].title, 'Serverless Guide');

    // 3. Test APIGateway POST write attempt -> 403 Forbidden
    const postWriteEvent = {
      httpMethod: 'POST',
      path: '/api/tables/articles/rows',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ title: 'New Article' }),
      isBase64Encoded: false,
    };

    const writeRes = await handler(postWriteEvent);
    assert.equal(writeRes.statusCode, 403);
    const writeBody = JSON.parse(writeRes.body) as { success: boolean; error: string };
    assert.equal(writeBody.success, false);
    assert.match(writeBody.error, /read-only mode/i);
  } finally {
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
