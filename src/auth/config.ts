import { randomBytes } from 'node:crypto';
import {
  DEFAULT_PASSWORD_HASH,
  DEFAULT_SESSION_DURATION_MS,
  DEFAULT_USERNAME,
  type AuthConfig,
  type ResolvedAuthConfig,
} from './types';

// Stable process-wide fallback secret when no secret is explicitly provided in env
const PROCESS_FALLBACK_SECRET = randomBytes(32).toString('hex');

/**
 * Resolves the authentication options against environment variables.
 */
export function resolveAuthConfig(
  optionsAuth?: boolean | AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAuthConfig {
  // Check if explicitly disabled via options or environment variable
  const envDisabled =
    ['0', 'false', 'no', 'off'].includes(String(env.ADMINDB_AUTH ?? '').trim().toLowerCase()) ||
    ['1', 'true', 'yes'].includes(String(env.ADMINDB_NO_AUTH ?? env.ADMINDB_DISABLE_AUTH ?? '').trim().toLowerCase());

  let enabled = true;
  let username = (env.ADMINDB_USERNAME ?? env.ADMINDB_USER) ? String(env.ADMINDB_USERNAME ?? env.ADMINDB_USER).trim() : DEFAULT_USERNAME;
  let password = (env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS) ? String(env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS).trim() : DEFAULT_PASSWORD_HASH;
  let secret = (env.ADMINDB_SECRET ?? env.SESSION_SECRET) ? String(env.ADMINDB_SECRET ?? env.SESSION_SECRET).trim() : PROCESS_FALLBACK_SECRET;
  let sessionDurationMs = DEFAULT_SESSION_DURATION_MS;

  if (optionsAuth === false || envDisabled) {
    enabled = false;
  } else if (typeof optionsAuth === 'object' && optionsAuth !== null) {
    if (optionsAuth.enabled === false) enabled = false;
    if (optionsAuth.username !== undefined) username = String(optionsAuth.username).trim();
    if (optionsAuth.password !== undefined) password = String(optionsAuth.password).trim();
    if (optionsAuth.secret !== undefined) secret = String(optionsAuth.secret).trim();
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
