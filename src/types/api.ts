/**
 * AdminDB — Strongly typed API request and response interfaces.
 *
 * Every REST API endpoint returns a standardized envelope:
 * `{ success: true, data: T }` on success, or `{ success: false, error: string }` on failure.
 */

import type { ColumnInfo, ForeignKeyInfo, IndexInfo, SavedQuery, SchemaInfo, TableInfoData, TableListItem, WhereClause, RowFilters,} from '../db/database';
import type { DatabaseEntry } from '../db/manager';
import type { ColumnDef, IndexDef } from '../sql/generator';
import type { ColumnGeneratorConfig, ColumnPlan, GeneratorStrategyId, StrategyDescriptor, StrategyCategory,} from '../data/index';

// Re-export common domain types for convenience
export type { ColumnInfo, ForeignKeyInfo, IndexInfo, SavedQuery, SchemaInfo, TableInfoData, TableListItem, WhereClause, RowFilters, ColumnDef, IndexDef, ColumnGeneratorConfig, ColumnPlan, GeneratorStrategyId, StrategyDescriptor, StrategyCategory };

// ============================================================================
// Standard Envelope
// ============================================================================

/** Successful API response container. */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

/** Error API response container. */
export interface ApiErrorResponse<T = unknown> {
  success: false;
  error: string;
  data?: T;
}

/** Discriminated union of all API responses. */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse<T>;

// ============================================================================
// Tables & Rows
// ============================================================================

/** GET /api/tables */
export type ListTablesResponseData = TableListItem[];
export type ListTablesResponse = ApiResponse<ListTablesResponseData>;

/** GET /api/tables/:table/info */
export type TableInfoResponseData = TableInfoData;
export type TableInfoResponse = ApiResponse<TableInfoResponseData>;

/** GET /api/tables/:table/fk-options */
export type FkOptionsResponseData = Record<string, { value: unknown; label: string }[]>;
export type FkOptionsResponse = ApiResponse<FkOptionsResponseData>;

/** GET /api/tables/:table/rows */
export interface GetRowsResponseData {
  rows: Record<string, unknown>[];
  count: number;
  page: number;
  limit: number;
  filters: RowFilters;
}
export type GetRowsResponse = ApiResponse<GetRowsResponseData>;

/** GET /api/tables/:table/row/:id */
export type GetRowResponseData = Record<string, unknown>;
export type GetRowResponse = ApiResponse<GetRowResponseData>;

/** GET /api/tables/:table/rows/:id/references */
export interface RowReferenceGroup {
  table: string;
  from: string;
  to: string;
  value: unknown;
  count: number;
  columns: string[];
  rows: Record<string, unknown>[];
}
export interface GetRowReferencesResponseData {
  references: RowReferenceGroup[];
}
export type GetRowReferencesResponse = ApiResponse<GetRowReferencesResponseData>;

/** POST /api/tables/:table/rows */
export interface InsertRowRequestBody {
  values: Record<string, unknown>;
}
export interface InsertRowResponseData {
  message: string;
  rowId?: number | bigint;
  sql: string;
}
export type InsertRowResponse = ApiResponse<InsertRowResponseData>;

/** POST /api/tables/:table/rows/generate */
export interface GenerateInsertRequestBody {
  values: Record<string, unknown>;
}
export interface GenerateInsertResponseData {
  sql: string;
}
export type GenerateInsertResponse = ApiResponse<GenerateInsertResponseData>;

/** POST /api/tables/:table/rows/import */
export interface ImportCsvRequestBody {
  csv: string;
}
export interface ImportCsvResponseData {
  message: string;
  inserted?: number;
  skipped?: number;
}
export type ImportCsvResponse = ApiResponse<ImportCsvResponseData>;

/** PUT /api/tables/:table/row/:id */
export interface UpdateRowRequestBody {
  values: Record<string, unknown>;
  nulls?: string[];
}
export interface UpdateRowResponseData {
  message: string;
  sql: string;
}
export type UpdateRowResponse = ApiResponse<UpdateRowResponseData>;

/** PUT /api/tables/:table/row/:id/generate */
export interface GenerateUpdateRequestBody {
  values: Record<string, unknown>;
  nulls?: string[];
}
export interface GenerateUpdateResponseData {
  sql: string;
}
export type GenerateUpdateResponse = ApiResponse<GenerateUpdateResponseData>;

/** DELETE /api/tables/:table/row/:id */
export interface DeleteRowResponseData {
  message: string;
}
export type DeleteRowResponse = ApiResponse<DeleteRowResponseData>;

/** GET /api/tables/:table/row/:id/blob/:column/meta */
export interface BlobMetaResponseData {
  isNull: boolean;
  mime?: string;
  ext?: string;
  isImage?: boolean;
  isText?: boolean;
  isPdf?: boolean;
  isAudio?: boolean;
  isVideo?: boolean;
  size: number;
  sizeFormatted: string;
  hexDump?: {
    lines: { offset: string; hex: string; ascii: string }[];
    totalBytes: number;
    truncated: boolean;
  };
  textPreview?: string | null;
}
export type BlobMetaResponse = ApiResponse<BlobMetaResponseData>;

/** PUT /api/tables/:table/row/:id/blob/:column */
export interface UpdateBlobRequestBody {
  data: string;
  format?: 'base64' | 'hex' | 'text';
}
export interface UpdateBlobResponseData {
  message: string;
  size: number;
}
export type UpdateBlobResponse = ApiResponse<UpdateBlobResponseData>;

/** GET /api/tables/:table/ddl */
export interface TableDdlResponseData {
  table: string;
  ddl: string;
}
export type TableDdlResponse = ApiResponse<TableDdlResponseData>;

// ============================================================================
// Bulk Operations
// ============================================================================

/** POST /api/tables/:table/rows/bulk-impact */
export interface BulkImpactRequestBody {
  ids: (string | number)[];
}
export interface BulkImpactReference {
  table: string;
  from: string;
  to: string;
  count: number;
}
export interface BulkImpactResponseData {
  selected: number;
  references: BulkImpactReference[];
  total: number;
}
export type BulkImpactResponse = ApiResponse<BulkImpactResponseData>;

/** POST /api/tables/:table/rows/bulk-delete */
export interface BulkDeleteRequestBody {
  ids: (string | number)[];
  confirmImpact?: boolean;
}
export interface BulkDeleteResponseData {
  message: string;
  deleted: number;
}
export type BulkDeleteResponse = ApiResponse<BulkDeleteResponseData>;

/** POST /api/tables/:table/rows/bulk-export */
export interface BulkExportRequestBody {
  ids: (string | number)[];
  format?: 'csv' | 'json';
}
export interface BulkExportResponseData {
  format: string;
  filename: string;
  content: string;
  rowCount: number;
}
export type BulkExportResponse = ApiResponse<BulkExportResponseData>;

/** POST /api/tables/:table/rows/bulk-update */
export interface BulkUpdateItem {
  id: string | number;
  values?: Record<string, unknown>;
  nulls?: string[];
}
export interface BulkUpdateRequestBody {
  updates: BulkUpdateItem[];
}
export interface BulkUpdateResponseData {
  message: string;
  updated: number;
}
export type BulkUpdateResponse = ApiResponse<BulkUpdateResponseData>;

// ============================================================================
// Seed Data Generation
// ============================================================================

/** GET /api/tables/:table/seed/config */
export interface SeedConfigResponseData {
  table: string;
  columns: ColumnGeneratorConfig[];
  maxRows: number;
}
export type SeedConfigResponse = ApiResponse<SeedConfigResponseData>;

/** POST /api/tables/:table/seed/generate */
export interface SeedGenerateRequestBody {
  count?: number;
  plan?: Record<string, ColumnPlan>;
}
export interface SeedGenerateResponseData {
  table: string;
  count: number;
  sql: string;
  previewRows?: Record<string, unknown>[];
  warnings: string[];
}
export type SeedGenerateResponse = ApiResponse<SeedGenerateResponseData>;

/** POST /api/tables/:table/seed */
export interface SeedInsertRequestBody {
  count?: number;
  plan?: Record<string, ColumnPlan>;
  truncate?: boolean;
}
export interface SeedInsertResponseData {
  message: string;
  inserted: number;
  skipped: number;
  warnings: string[];
  elapsedMs?: number;
}
export type SeedInsertResponse = ApiResponse<SeedInsertResponseData>;

// ============================================================================
// Schema & Table Management
// ============================================================================

/** POST /api/tables */
export interface CreateTableRequestBody {
  name: string;
  columns: ColumnDef[];
}
export interface CreateTableResponseData {
  message: string;
  sql: string;
}
export type CreateTableResponse = ApiResponse<CreateTableResponseData>;

/** POST /api/tables/generate */
export interface GenerateCreateTableRequestBody {
  name: string;
  columns: ColumnDef[];
}
export interface GenerateCreateTableResponseData {
  sql: string;
}
export type GenerateCreateTableResponse = ApiResponse<GenerateCreateTableResponseData>;

/** GET /api/tables/:table/schema */
export type GetSchemaResponseData = SchemaInfo;
export type GetSchemaResponse = ApiResponse<GetSchemaResponseData>;

/** POST /api/tables/:table/rename */
export interface RenameTableRequestBody {
  name: string;
}
export interface RenameTableResponseData {
  message: string;
  sql: string;
  table: string;
}
export type RenameTableResponse = ApiResponse<RenameTableResponseData>;

/** POST /api/tables/:table/columns */
export interface AddColumnRequestBody {
  column: ColumnDef;
}
export interface AddColumnResponseData {
  message: string;
  sql: string;
}
export type AddColumnResponse = ApiResponse<AddColumnResponseData>;

/** PUT /api/tables/:table/columns/:column */
export interface RenameColumnRequestBody {
  name: string;
}
export interface RenameColumnResponseData {
  message: string;
  sql: string;
}
export type RenameColumnResponse = ApiResponse<RenameColumnResponseData>;

/** DELETE /api/tables/:table/columns/:column */
export interface DropColumnResponseData {
  message: string;
  sql: string;
}
export type DropColumnResponse = ApiResponse<DropColumnResponseData>;

/** DELETE /api/tables/:table */
export interface DropTableResponseData {
  message: string;
  sql: string;
}
export type DropTableResponse = ApiResponse<DropTableResponseData>;

/** POST /api/tables/:table/indexes */
export interface CreateIndexRequestBody {
  name?: string;
  columns: string[];
  unique?: boolean;
}
export interface CreateIndexResponseData {
  message: string;
  sql: string;
}
export type CreateIndexResponse = ApiResponse<CreateIndexResponseData>;

/** DELETE /api/tables/:table/indexes/:index */
export interface DropIndexResponseData {
  message: string;
  sql: string;
}
export type DropIndexResponse = ApiResponse<DropIndexResponseData>;

// ============================================================================
// Queries
// ============================================================================

/** POST /api/query request */
export interface ExecuteQueryRequestBody {
  sql: string;
}

/** Result when SQL is classified as COUNT */
export interface QueryCountResult {
  kind: 'count';
  count: number;
  message: string;
}

/** Result when SQL is classified as SELECT / READ */
export interface QuerySelectResult {
  kind: 'select';
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Result when SQL is a write statement (INSERT, UPDATE, DELETE, DDL, Script) */
export interface QueryWriteResult {
  kind: 'write';
  changes: number | null;
  message: string;
}

/** Discriminated union of all query results */
export type ExecuteQueryResponseData = QueryCountResult | QuerySelectResult | QueryWriteResult;
export type ExecuteQueryResponse = ApiResponse<ExecuteQueryResponseData>;

/** POST /api/query/export */
export interface ExportQueryRequestBody {
  sql: string;
  format?: 'csv' | 'json';
}

/** GET /api/queries */
export type ListSavedQueriesResponseData = SavedQuery[];
export type ListSavedQueriesResponse = ApiResponse<ListSavedQueriesResponseData>;

/** POST /api/queries */
export interface SaveQueryRequestBody {
  name: string;
  sql: string;
}
export interface SaveQueryResponseData {
  message: string;
}
export type SaveQueryResponse = ApiResponse<SaveQueryResponseData>;

/** DELETE /api/queries/:id */
export interface DeleteSavedQueryResponseData {
  message: string;
}
export type DeleteSavedQueryResponse = ApiResponse<DeleteSavedQueryResponseData>;

// ============================================================================
// Multi-Database Manager & Filesystem Browser
// ============================================================================

export interface DatabaseRow extends DatabaseEntry {
  sizeLabel: string;
  modifiedLabel: string;
  tables: number;
}

/** GET /api/databases */
export type ListDatabasesResponseData = DatabaseRow[];
export type ListDatabasesResponse = ApiResponse<ListDatabasesResponseData>;

/** POST /api/databases */
export interface CreateDatabaseRequestBody {
  name: string;
}
export interface CreateDatabaseResponseData {
  id: string;
  message: string;
}
export type CreateDatabaseResponse = ApiResponse<CreateDatabaseResponseData>;

/** POST /api/databases/open */
export interface OpenDatabaseRequestBody {
  path: string;
}
export interface OpenDatabaseResponseData {
  id: string;
  message: string;
}
export type OpenDatabaseResponse = ApiResponse<OpenDatabaseResponseData>;

/** DELETE /api/databases/:id */
export interface DeleteDatabaseResponseData {
  message: string;
}
export type DeleteDatabaseResponse = ApiResponse<DeleteDatabaseResponseData>;

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isDb: boolean;
  size: number;
}

/** GET /api/fs/list */
export interface ListFsResponseData {
  path: string;
  name: string;
  parent: string | null;
  entries: FsEntry[];
}
export type ListFsResponse = ApiResponse<ListFsResponseData>;
