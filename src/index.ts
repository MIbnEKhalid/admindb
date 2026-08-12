/**
 * AdminDB — public library entry point.
 *
 * ```ts
 * import { createRouter, DbManager, createLogger } from 'admindb';
 * const app = express();
 * app.use('/admin', createRouter({ dbPath: './my.db', basePath: '/admin' }));
 * ```
 *
 * For the standalone CLI/server run `npm start` or `npx admindb` — see
 * `src/cli.ts`.
 */
export { createRouter, type AppOptions } from './app';
export { createLogger, type Logger, type LogLevel } from './logger';
export {
  SqliteDatabase,
  type Result,
  type TableInfoData,
  type ColumnInfo,
  type ForeignKeyInfo,
  type WhereClause,
} from './db/database';
export { DbManager, type DbManagerOptions, type DatabaseEntry } from './db/manager';
