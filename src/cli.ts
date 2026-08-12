#!/usr/bin/env node
import express from 'express';
import { createRouter } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { DbManager } from './db/manager';

/**
 * Standalone CLI / server entry point. Run `npm start` (or `npx dbadmin`).
 * Configure via PORT, HOST, DB_PATH, DB_DIR, DB_FILES, BASE_PATH and LOG_LEVEL
 * env vars. Set DB_DIR and/or DB_FILES to enable multi-database mode.
 *
 * SECURITY: this server exposes full, unauthenticated database access. It must
 * NOT be exposed to the public internet — protect it yourself (bind to
 * localhost, put it behind an authenticated reverse proxy, a VPN, etc.).
 */
const config = loadConfig();
const logger = createLogger(config.logLevel, 'dbadmin');
const app = express();
app.disable('x-powered-by');

const multiDb = Boolean(config.dbDir || (config.dbFiles && config.dbFiles.length > 0));
const router = multiDb
  ? createRouter({
      manager: new DbManager({ dir: config.dbDir, files: config.dbFiles, readonly: config.readonly }, logger),
      basePath: config.basePath,
      logger,
      readonly: config.readonly,
    })
  : createRouter({ dbPath: config.dbPath, basePath: config.basePath, logger, readonly: config.readonly });
app.use(config.basePath || '/', router);

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}${config.basePath}/`;
  logger.info(`DBAdmin listening on ${url}`);
  if (multiDb) {
    const sources = [config.dbDir ? `dir:${config.dbDir}` : null, config.dbFiles?.length ? `files:[${config.dbFiles.join(', ')}]` : null]
      .filter(Boolean)
      .join(' · ');
    logger.info(`Multi-database mode — ${sources}`);
  } else {
    logger.info(`Database file: ${config.dbPath}`);
  }
  if (config.readonly) {
    logger.info('Read-only mode enabled — all writes are disabled.');
  }
  if (config.host === '0.0.0.0') {
    logger.warn('Listening on 0.0.0.0 — this admin tool has NO authentication. Do not expose it to untrusted networks.');
  }
});

const shutdown = (signal: string): void => {
  logger.info(`Received ${signal}, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
