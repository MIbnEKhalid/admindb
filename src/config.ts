import type { LogLevel } from './logger';

export interface Config {
  host: string;
  port: number;
  /** Single-database file (used when no multi-db sources are configured). */
  dbPath: string;
  /** Directory of managed database files (multi-db mode source 1). */
  dbDir?: string;
  /** Explicit database file locations (multi-db mode source 2). */
  dbFiles?: string[];
  basePath: string;
  logLevel: LogLevel;
  /** Open the database read-only (writes disabled). */
  readonly: boolean;
  /** Whether authentication is enabled (default: true). */
  auth: boolean;
  /** Custom admin username (default: 'admin'). */
  authUsername?: string;
  /** Custom admin password (default: 'admin'). */
  authPassword?: string;
  /** Custom secret for signing session cookies. */
  authSecret?: string;
}

/** Load configuration from environment variables with sensible defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  const authDisabled =
    ['0', 'false', 'no', 'off'].includes(String(env.ADMINDB_AUTH ?? '').trim().toLowerCase()) ||
    ['1', 'true', 'yes'].includes(String(env.ADMINDB_NO_AUTH ?? env.ADMINDB_DISABLE_AUTH ?? '').trim().toLowerCase());

  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number.isFinite(port) ? port : 3000,
    dbPath: env.DB_PATH ?? 'admindb.db',
    dbDir: env.DB_DIR ? String(env.DB_DIR) : undefined,
    dbFiles: env.DB_FILES
      ? String(env.DB_FILES)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    basePath: (env.BASE_PATH ?? '').replace(/\/+$/, ''),
    logLevel: ((env.LOG_LEVEL as LogLevel) ?? 'info'),
    readonly: ['1', 'true', 'yes', 'on'].includes(String(env.READONLY ?? '').trim().toLowerCase()),
    auth: !authDisabled,
    authUsername: env.ADMINDB_USERNAME ? String(env.ADMINDB_USERNAME).trim() : undefined,
    authPassword: env.ADMINDB_PASSWORD ? String(env.ADMINDB_PASSWORD).trim() : undefined,
    authSecret: env.ADMINDB_SECRET ? String(env.ADMINDB_SECRET).trim() : undefined,
  };
}

