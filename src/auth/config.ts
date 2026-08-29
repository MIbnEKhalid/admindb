import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PASSWORD_HASH, DEFAULT_SESSION_DURATION_MS, DEFAULT_USERNAME, type AuthConfig, type ResolvedAuthConfig } from './types';

// In-memory cache of resolved secret to avoid repeated disk reads per process
let cachedFallbackSecret: string | null = null;

export const resetPersistentSecretCache = (): void => {
  cachedFallbackSecret = null;
};

/**
 * Returns a persistent secret key for signing session cookies.
 *
 * Priority order:
 * 1. `ADMINDB_SECRET` or `SESSION_SECRET` environment variables.
 * 2. `ADMINDB_SECRET_FILE` path if specified in environment.
 * 3. User home directory `.admindb-secret` (or temp directory if home is not writable).
 * 4. In-memory random fallback if filesystem is completely read-only.
 */
export function getOrCreatePersistentSecret(env: NodeJS.ProcessEnv = process.env): string {
  const envSecret = env.ADMINDB_SECRET ?? env.SESSION_SECRET;
  if (envSecret && String(envSecret).trim()) {
    return String(envSecret).trim();
  }

  const customSecretFile = env.ADMINDB_SECRET_FILE ? String(env.ADMINDB_SECRET_FILE).trim() : undefined;
  if (!customSecretFile && cachedFallbackSecret) return cachedFallbackSecret;

  const candidatePaths: string[] = [];
  if (customSecretFile) {
    candidatePaths.push(path.resolve(customSecretFile));
  } else {
    try {
      const home = os.homedir();
      if (home) candidatePaths.push(path.join(home, '.admindb-secret'));
    } catch {}
    try {
      const tmp = os.tmpdir();
      if (tmp) candidatePaths.push(path.join(tmp, '.admindb-secret'));
    } catch {}
  }

  // 1. Try reading existing secret
  for (const filePath of candidatePaths) {
    try {
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf8').trim();
        if (content.length >= 16) {
          if (!customSecretFile) cachedFallbackSecret = content;
          return content;
        }
      }
    } catch {}
  }

  // 2. Generate new secret and attempt writing
  const newSecret = randomBytes(32).toString('hex');
  for (const filePath of candidatePaths) {
    try {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, newSecret, { encoding: 'utf8', mode: 0o600 });
      if (!customSecretFile) cachedFallbackSecret = newSecret;
      return newSecret;
    } catch {}
  }

  // 3. Fallback to in-memory
  if (!customSecretFile) cachedFallbackSecret = newSecret;
  return newSecret;
}

/**
 * Resolves the authentication options against environment variables.
 */
export function resolveAuthConfig(
  optionsAuth?: boolean | AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAuthConfig {
  const envDisabled =
    ['0', 'false', 'no', 'off'].includes(String(env.ADMINDB_AUTH ?? '').trim().toLowerCase()) ||
    ['1', 'true', 'yes'].includes(String(env.ADMINDB_NO_AUTH ?? env.ADMINDB_DISABLE_AUTH ?? '').trim().toLowerCase());

  let enabled = true;
  let username = String(env.ADMINDB_USERNAME ?? env.ADMINDB_USER ?? DEFAULT_USERNAME).trim();
  let password = String(env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS ?? DEFAULT_PASSWORD_HASH).trim();
  let secret = String(env.ADMINDB_SECRET ?? env.SESSION_SECRET ?? '').trim() || getOrCreatePersistentSecret(env);
  let sessionDurationMs = DEFAULT_SESSION_DURATION_MS;

  if (optionsAuth === false || envDisabled) {
    enabled = false;
  } else if (typeof optionsAuth === 'object' && optionsAuth !== null) {
    if (optionsAuth.enabled === false) enabled = false;
    if (optionsAuth.username !== undefined) username = String(optionsAuth.username).trim();
    if (optionsAuth.password !== undefined) password = String(optionsAuth.password).trim();
    if (optionsAuth.secret !== undefined && String(optionsAuth.secret).trim()) {
      secret = String(optionsAuth.secret).trim();
    }
    if (optionsAuth.sessionDurationMs !== undefined) sessionDurationMs = optionsAuth.sessionDurationMs;
  }

  const isDefaultPassword =
    username === DEFAULT_USERNAME &&
    (password === DEFAULT_PASSWORD_HASH || password === 'admin');

  return {
    enabled,
    username,
    password,
    secret,
    sessionDurationMs,
    isDefaultPassword,
  };
}
