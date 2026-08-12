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
}

/** Load configuration from environment variables with sensible defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number.isFinite(port) ? port : 3000,
    dbPath: env.DB_PATH ?? 'dbadmin.db',
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
  };
}
