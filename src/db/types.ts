import type { FilterCondition, FilterValue } from '../utils/common';

/** Structured filter types are shared with the API layer. */
export type { FilterCondition, FilterValue } from '../utils/common';

/** SQLite-compatible bind value accepted by better-sqlite3 statements. */
export type SQLInputValue = null | number | bigint | string | Uint8Array;

export interface Result<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
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
  /** The `CREATE INDEX` statement from sqlite_master, when available. */
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

export const INTERNAL_TABLES = {
  savedQueries: '_saved_queries',
} as const;
