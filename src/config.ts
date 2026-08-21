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
  const portRaw = env.ADMINDB_PORT ?? env.PORT ?? '3000';
  const port = Number.parseInt(portRaw, 10);
  const authDisabled =
    ['0', 'false', 'no', 'off'].includes(String(env.ADMINDB_AUTH ?? '').trim().toLowerCase()) ||
    ['1', 'true', 'yes'].includes(String(env.ADMINDB_NO_AUTH ?? env.ADMINDB_DISABLE_AUTH ?? '').trim().toLowerCase());

  const dbDirRaw = env.ADMINDB_DB_DIR ?? env.ADMINDB_DIR ?? env.DB_DIR;
  const dbFilesRaw = env.ADMINDB_DB_FILES ?? env.DB_FILES;
  const dbPathRaw = env.ADMINDB_DB_PATH ?? env.ADMINDB_PATH ?? env.DB_PATH;
  const basePathRaw = env.ADMINDB_BASE_PATH ?? env.BASE_PATH ?? '';
  const logLevelRaw = env.ADMINDB_LOG_LEVEL ?? env.LOG_LEVEL ?? 'info';
  const readonlyRaw = env.ADMINDB_READONLY ?? env.READONLY ?? '';

  return {
    host: env.ADMINDB_HOST ?? env.HOST ?? '0.0.0.0',
    port: Number.isFinite(port) ? port : 3000,
    dbPath: dbPathRaw ? String(dbPathRaw) : 'admindb.db',
    dbDir: dbDirRaw ? String(dbDirRaw) : undefined,
    dbFiles: dbFilesRaw
      ? String(dbFilesRaw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    basePath: String(basePathRaw).replace(/\/+$/, ''),
    logLevel: (logLevelRaw as LogLevel),
    readonly: ['1', 'true', 'yes', 'on'].includes(String(readonlyRaw).trim().toLowerCase()),
    auth: !authDisabled,
    authUsername: (env.ADMINDB_USERNAME ?? env.ADMINDB_USER) ? String(env.ADMINDB_USERNAME ?? env.ADMINDB_USER).trim() : undefined,
    authPassword: (env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS) ? String(env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS).trim() : undefined,
    authSecret: (env.ADMINDB_SECRET ?? env.SESSION_SECRET) ? String(env.ADMINDB_SECRET ?? env.SESSION_SECRET).trim() : undefined,
  };
}
