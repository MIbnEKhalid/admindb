/**
 * AdminDB — public library entry point.
 *
 * ```ts
 * import { createRouter, DbManager, createLogger } from 'admindb';
 * const app = express();
 * app.use('/admin', createRouter({ dbPath: './my.db', basePath: '/admin' }));
 * ```
 */
export { createRouter, type AppOptions } from './app';
export { createLogger, type Logger, type LogLevel } from './utils/logger';
export { c, supportsColor } from './utils/colors';
export { SqliteDatabase, PostgresDatabase, type IDatabase, type DatabaseDialect, type PostgresOptions, type MutationResult, type QueryOptions, type Result, type TableInfoData, type ColumnInfo, type ForeignKeyInfo, type WhereClause, type IndexInfo, type SchemaInfo, type ColumnDetail, type SavedQuery, type RowFilters, type FilterCondition, type FilterValue, type SQLInputValue } from './db/index';
export { DbManager, type DbManagerOptions, type DatabaseEntry } from './db/manager';
export { type ColumnDef, type IndexDef } from './sql/generator';
export { type ColumnPlan, type ColumnGeneratorConfig, type GeneratorStrategyId, type StrategyDescriptor, type GenerateResult } from './data/index';
export { type AuthConfig, type ResolvedAuthConfig, resolveAuthConfig, getOrCreatePersistentSecret, createSessionToken, verifySessionToken, parseCookies, constantTimeCompare, hashPassword, verifyPassword, DEFAULT_USERNAME, DEFAULT_PASSWORD_HASH, SESSION_COOKIE_NAME } from './auth/index';
export { isServerlessEnvironment, createServerlessHandler, createLambdaHandler, type LambdaProxyResult } from './serverless';
export { sniffMimeType, generateHexDump, analyzeBlob, isJsonString, formatJsonSafely, type MimeAnalysis, type HexDumpLine, type HexDumpResult, type BlobMetadata } from './utils/datatype';

export * from './types/api';
