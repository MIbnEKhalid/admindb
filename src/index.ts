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
export { createLogger, type Logger, type LogLevel } from './utils/logger';
export { c, supportsColor } from './utils/colors';
export {
  SqliteDatabase,
  type Result,
  type TableInfoData,
  type ColumnInfo,
  type ForeignKeyInfo,
  type WhereClause,
  type IndexInfo,
  type SchemaInfo,
  type ColumnDetail,
  type SavedQuery,
  type RowFilters,
  type FilterCondition,
  type FilterValue,
  type SQLInputValue,
} from './db/index';
export { DbManager, type DbManagerOptions, type DatabaseEntry } from './db/manager';
export {
  type ColumnDef,
  type IndexDef,
} from './sql/generator';
export {
  type ColumnPlan,
  type ColumnGeneratorConfig,
  type GeneratorStrategyId,
  type StrategyDescriptor,
  type GenerateResult,
} from './data/index';

export {
  type AuthConfig,
  type ResolvedAuthConfig,
  createSessionToken,
  verifySessionToken,
  constantTimeCompare,
  hashPassword,
  verifyPassword,
  DEFAULT_USERNAME,
  DEFAULT_PASSWORD_HASH,
  SESSION_COOKIE_NAME,
} from './auth/index';

// Export all published REST API response and request types
export * from './types/api';

