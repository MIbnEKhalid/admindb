import type { Result } from '../../core/result';
import type { ColumnDef, IndexDef } from '../../sql/generator';
import type { DatabaseDialect, MutationResult, ReferencingTableInfo, SchemaInfo, SQLInputValue, TableInfoData, TableListItem } from '../types';

export interface MappedType {
  sqlType: string;
  defaultAuto?: string;
}

export interface DialectCapabilities {
  supportsCascadeDrop: boolean;
  supportsNativeAlterColumn: boolean;
  supportsRegexFilter: boolean;
  supportsJsonb: boolean;
}

export const SQLITE_CAPABILITIES: DialectCapabilities = {
  supportsCascadeDrop: false,
  supportsNativeAlterColumn: false,
  supportsRegexFilter: false,
  supportsJsonb: false,
};

export const POSTGRES_CAPABILITIES: DialectCapabilities = {
  supportsCascadeDrop: true,
  supportsNativeAlterColumn: true,
  supportsRegexFilter: true,
  supportsJsonb: true,
};

/**
 * Low-level database execution driver interface.
 * Implemented by database engines to execute SQL statements and manage connections.
 */
export interface IDatabaseDriver {
  readonly dialect: DatabaseDialect;
  readonly isReadOnly: boolean;
  readonly path: string;
  all<T = unknown>(sql: string, params?: SQLInputValue[]): Promise<Result<T[]>>;
  run(sql: string, params?: SQLInputValue[]): Promise<Result<MutationResult>>;
  execResult(sql: string): Promise<Result<{ changes?: number }>>;
  close(): Promise<void> | void;
}

/**
 * Schema introspection interface for inspecting tables, columns, foreign keys, and indexes.
 */
export interface ISchemaIntrospector<D = unknown> {
  listTables(driver: D): Promise<Result<TableListItem[]>>;
  getTableInfo(driver: D, table: string): Promise<Result<TableInfoData>>;
  getSchema(driver: D, table: string): Promise<Result<SchemaInfo>>;
  getReferencingTables(driver: D, table: string): Promise<Result<ReferencingTableInfo[]>>;
  getCreateStatement(driver: D, table: string): Promise<Result<string | null>>;
  getColumnCountMap?(driver: D): Promise<Result<Record<string, number>>>;
}

/**
 * DDL generator and schema modification interface.
 */
export interface IDdlGenerator<D = unknown> {
  createTable(table: string, columns: ColumnDef[]): string;
  renameTable(oldName: string, newName: string): string;
  dropTable(table: string, options?: { cascade?: boolean; ifExists?: boolean }): string;
  truncateTable(table: string, options?: { cascade?: boolean; restartIdentity?: boolean }): string;
  setForeignKeys?(enabled: boolean): string;
  addColumn(table: string, column: ColumnDef): string;
  modifyColumn(driver: D, table: string, oldCol: string, newCol: ColumnDef): Promise<Result<{ changes?: number }>>;
  renameColumn(table: string, oldName: string, newName: string): string;
  dropColumn(table: string, column: string): string;
  createIndex(table: string, index: IndexDef): string;
  dropIndex(indexName: string): string;
}

/**
 * Dialect definition packaging introspector, DDL generator, type mapping, and engine capabilities.
 */
export interface IDialect<D = unknown> {
  readonly name: DatabaseDialect;
  readonly introspector: ISchemaIntrospector<D>;
  readonly ddl: IDdlGenerator<D>;
  readonly capabilities: DialectCapabilities;
  quoteIdentifier(identifier: string): string;
  mapType(type: string): { sqlType: string; defaultAuto?: string };
  getDesignerTypes(): readonly string[];
}

