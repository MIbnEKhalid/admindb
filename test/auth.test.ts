import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRouter, SqliteDatabase, createSessionToken, verifySessionToken, parseCookies, hashPassword, verifyPassword, resolveAuthConfig, getOrCreatePersistentSecret, SESSION_COOKIE_NAME } from '../src/index';
import { resetPersistentSecretCache } from '../src/auth/config';
import { createLogger } from '../src/utils/logger';

test('Auth: parseCookies handles standard, URL-encoded and quoted cookies', () => {
  const parsed = parseCookies(
    'admindb_session="abc.123.xyz"; other=foo%20bar; blank=; theme=dark'
  );
  assert.equal(parsed.admindb_session, 'abc.123.xyz');
  assert.equal(parsed.other, 'foo bar');
  assert.equal(parsed.blank, '');
  assert.equal(parsed.theme, 'dark');
  assert.equal(parseCookies(undefined).admindb_session, undefined);
});

test('Auth: hashPassword and verifyPassword verify passwords securely', () => {
  const hash = hashPassword('my-secret-pass');
  assert.match(hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(verifyPassword('my-secret-pass', hash), true);
  assert.equal(verifyPassword('wrong-pass', hash), false);
  assert.equal(verifyPassword('plain-pass', 'plain-pass'), true);
  assert.equal(verifyPassword('other-pass', 'plain-pass'), false);
});

test('Auth: createSessionToken and verifySessionToken handle validity, tampering and expiration', () => {
  const secret = 'test-secret-key-1234567890123456';
  const token = createSessionToken('alice', secret, 60000);

  // Valid verification
  assert.equal(verifySessionToken(token, secret, 'alice'), 'alice');
  assert.equal(verifySessionToken(token, secret), 'alice');

  // Wrong user
  assert.equal(verifySessionToken(token, secret, 'bob'), null);

  // Wrong secret (simulating old behavior where secret changed on restart)
  assert.equal(verifySessionToken(token, 'different-secret-key-999999999'), null);

  // Tampered payload
  const parts = token.split('.');
  const tamperedToken = `dGFtcGVyZWQ.${parts[1]}.${parts[2]}`;
  assert.equal(verifySessionToken(tamperedToken, secret), null);

  // Expired token
  const expiredToken = createSessionToken('alice', secret, -1000);
  assert.equal(verifySessionToken(expiredToken, secret), null);
});

test('Auth: persistent secret survives process restart simulation', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-secret-test-'));
  const customSecretFile = path.join(tmpDir, '.admindb-secret');

  try {
    const env = { ADMINDB_SECRET_FILE: customSecretFile } as NodeJS.ProcessEnv;

    // First run (Process 1): secret is generated and persisted to file
    resetPersistentSecretCache();
    const secret1 = getOrCreatePersistentSecret(env);
    assert.ok(secret1 && secret1.length >= 32);
    assert.equal(existsSync(customSecretFile), true);
    assert.equal(readFileSync(customSecretFile, 'utf8').trim(), secret1);

    // Issue a session token in Process 1
    const token = createSessionToken('admin', secret1, 3600000);

    // Simulate process restart (Process 2): in-memory cache is wiped, new process starts
    resetPersistentSecretCache();
    const secret2 = getOrCreatePersistentSecret(env);

    // The secret must be identical across restarts
    assert.equal(secret2, secret1);

    // The token issued in Process 1 must successfully verify in Process 2
    const authenticatedUser = verifySessionToken(token, secret2, 'admin');
    assert.equal(authenticatedUser, 'admin');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    resetPersistentSecretCache();
  }
});

test('Auth: environment variables ADMINDB_SECRET and SESSION_SECRET override persistent file', () => {
  const explicitSecret = 'explicit-custom-secret-from-env-12345';
  resetPersistentSecretCache();

  const resolved = resolveAuthConfig(true, {
    ADMINDB_SECRET: explicitSecret,
  } as NodeJS.ProcessEnv);

  assert.equal(resolved.secret, explicitSecret);
  resetPersistentSecretCache();
});

test('Auth: HTTP session cookies remain valid across simulated server restart', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'admindb-e2e-auth-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const secretFile = path.join(tmpDir, '.admindb-secret');
  const env = { ADMINDB_SECRET_FILE: secretFile } as NodeJS.ProcessEnv;
  const logger = createLogger('error');

  let server1: Server | null = null;
  let server2: Server | null = null;
  let db1: SqliteDatabase | null = null;
  let db2: SqliteDatabase | null = null;

  try {
    // 1. Start Server Instance 1
    resetPersistentSecretCache();
    db1 = new SqliteDatabase(dbPath, logger);
    db1.execResult('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);');

    const authConfig1 = resolveAuthConfig(
      { enabled: true, username: 'admin', password: 'admin' },
      env
    );
    const app1 = createRouter({ db: db1, auth: authConfig1 });

    const server1Port = await new Promise<number>((res) => {
      server1 = app1.listen(0, '127.0.0.1', () => {
        const addr = server1!.address();
        res(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    // 2. Perform login request on Server 1
    const loginRes = await fetch(`http://127.0.0.1:${server1Port}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });

    assert.equal(loginRes.status, 200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    assert.ok(setCookieHeader, 'Set-Cookie header must be present');
    assert.match(setCookieHeader, new RegExp(`${SESSION_COOKIE_NAME}=`));

    // Extract cookie value
    const cookies = parseCookies(setCookieHeader);
    const sessionToken = cookies[SESSION_COOKIE_NAME];
    assert.ok(sessionToken);

    // Verify authorized access on Server 1
    const apiRes1 = await fetch(`http://127.0.0.1:${server1Port}/api/tables/test.db`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });
    assert.equal(apiRes1.status, 200);

    // 3. Stop Server 1 (simulating process restart)
    await new Promise<void>((res) => {
      server1?.close(() => {
        db1?.close();
        res();
      });
    });

    // 4. Start Server Instance 2 (after restart) with same database and secret file
    resetPersistentSecretCache();
    db2 = new SqliteDatabase(dbPath, logger);
    const authConfig2 = resolveAuthConfig(
      { enabled: true, username: 'admin', password: 'admin' },
      env
    );
    const app2 = createRouter({ db: db2, auth: authConfig2 });

    const server2Port = await new Promise<number>((res) => {
      server2 = app2.listen(0, '127.0.0.1', () => {
        const addr = server2!.address();
        res(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    // 5. Use the cookie received from Server 1 on Server 2
    const apiRes2 = await fetch(`http://127.0.0.1:${server2Port}/api/tables/test.db`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });

    // The session must still be valid and authorized (200 OK, not 401 Unauthorized)
    assert.equal(
      apiRes2.status,
      200,
      'Session cookie from before restart must remain valid after restart'
    );
    const body = (await apiRes2.json()) as { success: boolean; data: unknown[] };
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
  } finally {
    if (server1?.listening) server1.close();
    if (server2?.listening) server2.close();
    db1?.close();
    db2?.close();
    rmSync(tmpDir, { recursive: true, force: true });
    resetPersistentSecretCache();
  }
});
