import type { FilterCondition, FilterValue } from '../utils/common';
import type { ColumnDef, IndexDef } from '../sql/generator';

/** Structured filter types are shared with the API layer. */
export type { FilterCondition, FilterValue } from '../utils/common';

export type DatabaseDialect = 'sqlite' | 'postgres';

/** SQL bind value accepted by database drivers. */
export type SQLInputValue = null | number | bigint | string | boolean | Uint8Array | Buffer | Date;

export interface Result<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MutationResult {
  changes?: number;
  lastInsertRowid?: number | null;
}

export interface TableListItem {
  name: string;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

export interface TableInfoData {
  table: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: string[];
  /** Indexes (including UNIQUE / JSON-expression indexes) — used by the data generator. */
  indexes: IndexInfo[];
  /** The table's `CREATE TABLE` statement (used to parse CHECK constraints). */
  sql: string | null;
}

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
  created_at: string;
}

export interface WhereClause {
  column: string;
  value: unknown;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  partial: number;
  /** Index origin: 'c' = explicit CREATE INDEX, 'pk'/'u' = automatic (primary key / unique). */
  origin: string;
  columns: string[];
  /** The `CREATE INDEX` statement, when available. */
  sql?: string | null;
}

export interface RowFilters {
  [column: string]: FilterValue;
}

export interface ColumnDetail extends ColumnInfo {
  unique: boolean;
  indexed: boolean;
  /** Foreign keys in OTHER tables whose referenced column is this column. */
  referencedBy: { table: string; from: string }[];
  /** The foreign key this column participates in (as the child), if any. */
  fk: ForeignKeyInfo | null;
  canDrop: boolean;
  dropBlockers: string[];
}

export interface SchemaInfo {
  table: string;
  columns: ColumnDetail[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  /** Foreign keys in other tables that reference this table. */
  references: { table: string; from: string; to: string }[];
}

export interface ReferencingTableInfo {
  table: string;
  /** FK columns in `table` that point at this table (`from` → `to`). */
  refs: { from: string; to: string }[];
  /** Rows in `table` whose FK column(s) actually reference this table. */
  refCount: number;
}

export interface DbOpenOptions {
  /** Open the database read-only: every write is rejected. */
  readonly?: boolean;
}

export interface PostgresOptions extends DbOpenOptions {
  /** PostgreSQL connection string / URI. */
  connectionString?: string;
  /** PostgreSQL connection pool config. */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | object;
  max?: number;
  schema?: string;
}

export interface QueryOptions {
  page?: number;
  limit?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: RowFilters;
}

export const INTERNAL_TABLES = {
  savedQueries: '_saved_queries',
} as const;

/**
 * Common interface implemented by both SQLite and PostgreSQL database adapters.
 */
export interface IDatabase {
  readonly path: string;
  readonly isReadOnly: boolean;
  readonly dialect: DatabaseDialect;

  close(): Promise<void> | void;

  all(sql: string, params?: SQLInputValue[]): Promise<Result<unknown[]>>;
  run(sql: string, params?: SQLInputValue[]): Promise<Result<MutationResult>>;
  execResult(sql: string): Promise<Result<{ changes?: number }>>;
  hasMultipleStatements(sql: string): boolean;
  runWrite(sql: string): Promise<Result<{ changes?: number }>>;

  listTables(): Promise<Result<TableListItem[]>>;
  getTableInfo(table: string): Promise<Result<TableInfoData>>;
  getRowCount(table: string, filters?: RowFilters): Promise<Result<number>>;
  getRows(table: string, opts?: QueryOptions): Promise<Result<Record<string, unknown>[]>>;
  getAllRows(table: string): Promise<Result<Record<string, unknown>[]>>;
  getRow(table: string, where: WhereClause[]): Promise<Result<Record<string, unknown> | null>>;
  insertRow(table: string, fields: WhereClause[]): Promise<Result<MutationResult>>;
  insertRows(table: string, rows: WhereClause[][]): Promise<Result<{ inserted: number; skipped: number }>>;
  updateRow(table: string, fields: WhereClause[], where: WhereClause[]): Promise<Result<MutationResult>>;
  updateRows(table: string, rows: { fields: WhereClause[]; where: WhereClause[] }[]): Promise<Result<{ updated: number }>>;
  deleteRow(table: string, where: WhereClause[]): Promise<Result<MutationResult>>;
  deleteRows(table: string, rows: WhereClause[][]): Promise<Result<{ deleted: number }>>;
  getRowsByPks(table: string, pks: WhereClause[][]): Promise<Result<Record<string, unknown>[]>>;
  getRowsByFk(table: string, column: string, value: unknown, limit?: number): Promise<Result<{ rows: Record<string, unknown>[]; total: number }>>;
  getCreateStatement(table: string): Promise<Result<string | null>>;

  listSavedQueries(): Promise<Result<SavedQuery[]>>;
  saveQuery(name: string, sql: string): Promise<Result<MutationResult>>;
  deleteSavedQuery(id: string | number): Promise<Result<MutationResult>>;

  getSchema(table: string): Promise<Result<SchemaInfo>>;
  getReferencingTables(table: string): Promise<Result<ReferencingTableInfo[]>>;

  renameTable(oldName: string, newName: string): Promise<Result<{ changes?: number }>>;
  addColumn(table: string, col: ColumnDef): Promise<Result<{ changes?: number }>>;
  modifyColumn(table: string, oldColName: string, newColDef: ColumnDef): Promise<Result<{ changes?: number }>>;
  renameColumn(table: string, oldName: string, newName: string): Promise<Result<{ changes?: number }>>;
  dropColumn(table: string, column: string): Promise<Result<{ changes?: number }>>;
  dropTable(table: string): Promise<Result<{ changes?: number }>>;
  createIndex(table: string, index: IndexDef): Promise<Result<{ changes?: number }>>;
  dropIndex(indexName: string): Promise<Result<{ changes?: number }>>;
}

