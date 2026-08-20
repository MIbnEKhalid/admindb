#!/usr/bin/env node
import express from 'express';
import path from 'node:path';
import { createRouter } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { DbManager } from './db/manager';
import { parseArgs, helpText, versionText } from './args';
import { DEFAULT_PASSWORD_HASH } from './auth';

/**
 * Standalone CLI / server entry point. Run `npm start` (or `npx admindb`).
 *
 * Everything can be set with CLI flags (see `--help`) or environment variables
 * (PORT, HOST, DB_PATH, DB_DIR, DB_FILES, BASE_PATH, READONLY, LOG_LEVEL); flags
 * win over the environment.
 *
 * By default the server runs in "manager" mode: the landing page lets you
 * browse the filesystem and open any SQLite database file, or create new ones.
 * `--open <file>` (or a file path / DB_PATH) opens a single database directly.
 *
 * SECURITY: this server exposes full, unauthenticated database AND filesystem
 * access. It must NOT be exposed to the public internet — protect it yourself
 * (bind to localhost, put it behind an authenticated reverse proxy, a VPN,
 * etc.).
 */
const env = loadConfig();
const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(parsed.error);
  console.error();
  console.error(helpText());
  process.exit(1);
}
const args = parsed.args;
if (args.help) {
  console.log(helpText());
  process.exit(0);
}
if (args.version) {
  console.log(versionText());
  process.exit(0);
}

// Merge CLI flags over environment variables.
const authEnabled = args.auth !== undefined ? args.auth : env.auth;
const authUsername = args.authUsername ?? env.authUsername ?? 'admin';
const authPassword = args.authPassword ?? env.authPassword;
const authSecret = args.authSecret ?? env.authSecret;

const config = {
  host: args.host ?? env.host,
  port: args.port ?? env.port,
  dbPath: args.dbPath ?? env.dbPath,
  dbDir: args.dbDir ?? env.dbDir,
  dbFiles: args.dbFiles ?? env.dbFiles,
  basePath: (args.basePath ?? env.basePath).replace(/\/+$/, ''),
  logLevel: args.logLevel ?? env.logLevel,
  readonly: args.readonly || env.readonly,
  auth: authEnabled
    ? {
        enabled: true,
        username: authUsername,
        password: authPassword,
        secret: authSecret,
      }
    : false,
};

const logger = createLogger(config.logLevel, 'admindb');
const app = express();
app.disable('x-powered-by');

// Mode selection:
//  - A specific single file was requested (`--open`, a file path argument, or
//    DB_PATH) and no folder/files were configured → single-database mode.
//  - Otherwise → manager mode with a landing page where you can browse the
//    filesystem and open database files, or create new ones.
const hasDir = Boolean(config.dbDir);
const hasFiles = Boolean(config.dbFiles && config.dbFiles.length > 0);
const explicitFile = args.dbPath ?? (process.env.DB_PATH ? process.env.DB_PATH : undefined);
const singleFileOnly = Boolean(explicitFile) && !hasDir && !hasFiles;
const useManager = !singleFileOnly;

const managerFiles = [...(config.dbFiles ?? [])];
if (useManager && explicitFile) managerFiles.push(explicitFile);

// File-browser policy for manager mode:
//  - a folder was requested → browsing is allowed but limited to that folder;
//  - specific files were requested (no folder) → browsing is disabled entirely;
//  - nothing requested → browsing is allowed (free); the folder defaults to the
//    current directory so new/created databases land there.
const managerDir = hasDir ? config.dbDir : hasFiles || explicitFile ? undefined : process.cwd();
const allowBrowse = useManager && (hasDir || (!hasFiles && !explicitFile));
const browseRoot = hasDir ? path.resolve(config.dbDir!) : undefined;

const router = useManager
  ? createRouter({
      manager: new DbManager(
        { dir: managerDir, files: managerFiles, readonly: config.readonly },
        logger,
      ),
      basePath: config.basePath,
      logger,
      readonly: config.readonly,
      allowBrowse,
      browseRoot,
      auth: config.auth,
    })
  : createRouter({
      dbPath: explicitFile,
      basePath: config.basePath,
      logger,
      readonly: config.readonly,
      auth: config.auth,
    });
app.use(config.basePath || '/', router);

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}${config.basePath}/`;
  logger.info(`AdminDB listening on ${url}`);
  if (authEnabled) {
    logger.info(`Authentication enabled — User: ${authUsername}`);
    if (authUsername === 'admin' && (!authPassword || authPassword === 'admin' || authPassword === DEFAULT_PASSWORD_HASH)) {
      logger.warn('Default password in use (admin). Generate a secure hash with "npm run generatehash" and set ADMINDB_PASSWORD or -P <hash>.');
    }
  } else {
    logger.warn('Authentication is DISABLED (--no-auth). Anyone with network access can view and modify databases.');
  }
  if (useManager) {
    const sources = [
      managerDir ? `dir:${managerDir}` : null,
      managerFiles.length ? `files:[${managerFiles.join(', ')}]` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    logger.info(`Manager mode — ${sources}`);
    if (!allowBrowse) {
      logger.info('File browsing disabled — only the configured database files are listed.');
    } else if (browseRoot) {
      logger.info(`File browsing is limited to: ${browseRoot}`);
    } else {
      logger.info('Open the URL above in your browser to browse and open database files.');
    }
  } else {
    logger.info(`Database file: ${explicitFile}`);
  }
  if (config.readonly) {
    logger.info('Read-only mode enabled — all writes are disabled.');
  }
});

const shutdown = (signal: string): void => {
  logger.info(`Received ${signal}, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
