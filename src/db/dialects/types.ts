import type { Result } from '../../core/result';
import type { ColumnDef, IndexDef } from '../../sql/generator';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ReferencingTableInfo, SchemaInfo, TableInfoData, TableListItem } from '../types';

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

export interface ISchemaIntrospector {
  listTables(driver: any): Promise<Result<TableListItem[]>>;
  getTableInfo(driver: any, table: string): Promise<Result<TableInfoData>>;
  getSchema(driver: any, table: string): Promise<Result<SchemaInfo>>;
  getReferencingTables(driver: any, table: string): Promise<Result<ReferencingTableInfo[]>>;
  getCreateStatement(driver: any, table: string): Promise<Result<string | null>>;
  getColumnCountMap?(driver: any): Promise<Result<Record<string, number>>>;
}

export interface IDdlGenerator {
  createTable(table: string, columns: ColumnDef[]): string;
  renameTable(oldName: string, newName: string): string;
  dropTable(table: string, options?: { cascade?: boolean }): string;
  addColumn(table: string, column: ColumnDef): string;
  modifyColumn(driver: any, table: string, oldCol: string, newCol: ColumnDef): Promise<Result<{ changes?: number }>>;
  renameColumn(table: string, oldName: string, newName: string): string;
  dropColumn(table: string, column: string): string;
  createIndex(table: string, index: IndexDef): string;
  dropIndex(indexName: string): string;
}

export interface IDialect {
  readonly name: 'sqlite' | 'postgres';
  readonly introspector: ISchemaIntrospector;
  readonly ddl: IDdlGenerator;
  readonly capabilities: DialectCapabilities;
  quoteIdentifier(identifier: string): string;
  mapType(type: string): { sqlType: string; defaultAuto?: string };
  getDesignerTypes(): readonly string[];
}
