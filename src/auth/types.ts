export interface AuthConfig {
  /**
   * Whether authentication is enabled.
   * Set to `false` to disable protection entirely (e.g. for development or custom upstream auth).
   * Defaults to `true`.
   */
  enabled?: boolean;
  /** Admin username. Defaults to `process.env.ADMINDB_USERNAME` or `'admin'`. */
  username?: string;
  /**
   * Admin password or password hash (e.g. `scrypt:<salt>:<hash>`).
   * Generate a hash using `npm run generatehash`.
   * Defaults to `process.env.ADMINDB_PASSWORD` or the hardcoded default hash for `'admin'`.
   */
  password?: string;
  /** Secret key used to sign session cookies. Defaults to `process.env.ADMINDB_SECRET` or auto-generated. */
  secret?: string;
  /** Session expiration time in milliseconds. Defaults to 7 days (604800000 ms). */
  sessionDurationMs?: number;
}

export interface ResolvedAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
  secret: string;
  sessionDurationMs: number;
  isDefaultPassword: boolean;
}

export const DEFAULT_USERNAME = 'admin';

/**
 * Hardcoded default scrypt hash for password 'admin' (salt: d9f2e64b8a1c3d5e7f0a2b4c6e801357, keyLen: 64).
 */
export const DEFAULT_PASSWORD_HASH =
  'scrypt:d9f2e64b8a1c3d5e7f0a2b4c6e801357:cb3032b16f29c8d44f75c779f070c61c846b17eb333d07596ceb8470fc1b4c06cc720c08796ebc86937dab28a3ef580ced38a71c940fd4a169fd2e9cb9fa40e2';

export const DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE_NAME = 'admindb_session';
