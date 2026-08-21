import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../utils/logger';
import { isServerlessEnvironment } from '../serverless';
import { errorMessage } from '../utils/common';

export interface DatabaseConfigFile {
  /** Database connections mapped by name: { "name": "postgresql://...", "name1": "postgresql://..." } */
  connections?: Record<string, string>;
  /** Single database connection string */
  connection?: string;
  /** Port override */
  port?: number;
  /** Host override */
  host?: string;
  /** Base path */
  basePath?: string;
  /** Readonly flag */
  readonly?: boolean;
  /** Serverless flag */
  serverless?: boolean;
  /** Auth options */
  auth?: boolean | { username?: string; password?: string; secret?: string };
  /** Log level */
  logLevel?: LogLevel;
}

export function parseConfigFile(filePath: string): DatabaseConfigFile | null {
  try {
    const absPath = path.resolve(filePath);
    if (!existsSync(absPath)) return null;
    const content = readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const result: DatabaseConfigFile = {};
    const conns: Record<string, string> = {};

    // 1. If parsed has a nested "databases" or "connections" map
    const topDbs = parsed.databases || parsed.connections;
    if (topDbs && typeof topDbs === 'object' && !Array.isArray(topDbs)) {
      for (const [k, v] of Object.entries(topDbs)) {
        if (typeof v === 'string' && v.trim()) conns[k.trim()] = v.trim();
        else if (v && typeof v === 'object' && typeof (v as any).connection === 'string') {
          conns[k.trim()] = (v as any).connection.trim();
        }
      }
    }

    // 2. Direct key-value map of { "name": "postgresql://...", "name1": "postgresql://..." }
    for (const [k, v] of Object.entries(parsed)) {
      if (['databases', 'connections', 'port', 'host', 'basePath', 'readonly', 'serverless', 'auth', 'logLevel', 'username', 'password', 'secret'].includes(k)) {
        continue;
      }
      if (typeof v === 'string' && v.trim()) {
        conns[k.trim()] = v.trim();
      } else if (v && typeof v === 'object' && typeof (v as any).connection === 'string') {
        conns[k.trim()] = (v as any).connection.trim();
      }
    }

    if (typeof parsed.connection === 'string' && parsed.connection.trim()) {
      result.connection = parsed.connection.trim();
    }
    if (typeof parsed.port === 'number') result.port = parsed.port;
    if (typeof parsed.host === 'string') result.host = parsed.host;
    if (typeof parsed.basePath === 'string') result.basePath = parsed.basePath;
    if (typeof parsed.readonly === 'boolean') result.readonly = parsed.readonly;
    if (typeof parsed.serverless === 'boolean') result.serverless = parsed.serverless;
    if (typeof parsed.auth === 'boolean' || (parsed.auth && typeof parsed.auth === 'object')) {
      result.auth = parsed.auth;
    }
    if (typeof parsed.logLevel === 'string') result.logLevel = parsed.logLevel as LogLevel;

    if (Object.keys(conns).length > 0) {
      result.connections = conns;
    }
    return result;
  } catch (err) {
    throw new Error(`Failed to parse configuration file "${filePath}": ${errorMessage(err)}`);
  }
}

export interface Config {
  host: string;
  port: number;
  /** Single-database file or connection string. */
  dbPath: string;
  /** Database connection string (PostgreSQL or SQLite). */
  connection?: string;
  /** Named database connections map. */
  connections?: Record<string, string>;
  /** Directory of managed database files (multi-db mode source 1). */
  dbDir?: string;
  /** Explicit database file locations (multi-db mode source 2). */
  dbFiles?: string[];
  basePath: string;
  logLevel: LogLevel;
  /** Open the database read-only (writes disabled). */
  readonly: boolean;
  /** Serverless environment mode (enforces read-only). */
  serverless: boolean;
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
  const connectionRaw = env.ADMINDB_CONNECTION ?? env.DATABASE_URL ?? env.PG_CONNECTION ?? env.POSTGRES_URL;
  const dbPathRaw = env.ADMINDB_DB_PATH ?? env.ADMINDB_PATH ?? env.DB_PATH ?? connectionRaw;
  const basePathRaw = env.ADMINDB_BASE_PATH ?? env.BASE_PATH ?? '';
  const logLevelRaw = env.ADMINDB_LOG_LEVEL ?? env.LOG_LEVEL ?? 'info';
  const serverlessRaw = env.ADMINDB_SERVERLESS ?? env.SERVERLESS ?? env.IS_SERVERLESS ?? '';
  const serverless =
    ['1', 'true', 'yes', 'on'].includes(String(serverlessRaw).trim().toLowerCase()) ||
    isServerlessEnvironment(env);
  const readonlyRaw = env.ADMINDB_READONLY ?? env.READONLY ?? '';
  const readonly = serverless || ['1', 'true', 'yes', 'on'].includes(String(readonlyRaw).trim().toLowerCase());

  let connections: Record<string, string> | undefined;
  const configJsonRaw = env.ADMINDB_CONFIG_JSON ?? env.ADMINDB_CONNECTIONS;
  if (configJsonRaw) {
    try {
      const parsed = JSON.parse(configJsonRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        connections = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  const configPath = env.ADMINDB_CONFIG;
  if (configPath && existsSync(configPath)) {
    const fileConf = parseConfigFile(configPath);
    if (fileConf?.connections) {
      connections = { ...(connections ?? {}), ...fileConf.connections };
    }
  }

  return {
    host: env.ADMINDB_HOST ?? env.HOST ?? '0.0.0.0',
    port: Number.isFinite(port) ? port : 3000,
    dbPath: dbPathRaw ? String(dbPathRaw) : 'admindb.db',
    connection: connectionRaw ? String(connectionRaw) : undefined,
    connections,
    dbDir: dbDirRaw ? String(dbDirRaw) : undefined,
    dbFiles: dbFilesRaw
      ? String(dbFilesRaw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    basePath: String(basePathRaw).replace(/\/+$/, ''),
    logLevel: logLevelRaw as LogLevel,
    readonly,
    serverless,
    auth: !authDisabled,
    authUsername: (env.ADMINDB_USERNAME ?? env.ADMINDB_USER) ? String(env.ADMINDB_USERNAME ?? env.ADMINDB_USER).trim() : undefined,
    authPassword: (env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS) ? String(env.ADMINDB_PASSWORD ?? env.ADMINDB_PASS).trim() : undefined,
    authSecret: (env.ADMINDB_SECRET ?? env.SESSION_SECRET) ? String(env.ADMINDB_SECRET ?? env.SESSION_SECRET).trim() : undefined,
  };
}
