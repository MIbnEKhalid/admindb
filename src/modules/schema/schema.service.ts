import type { ReferencingTableInfo, SchemaInfo } from '../../db/index';
import type { DatabaseContext } from '../../core/context';
import type { ColumnDef, IndexDef } from '../../sql/generator';

export class SchemaService {
  static async getSchema(ctx: DatabaseContext, table: string): Promise<SchemaInfo> {
    const r = await ctx.db.getSchema(table);
    if (!r.success || !r.data) throw new Error(r.error ?? 'Failed to load schema.');
    return r.data;
  }

  static async getReferencingTables(ctx: DatabaseContext, table: string): Promise<ReferencingTableInfo[]> {
    const r = await ctx.db.getReferencingTables(table);
    if (!r.success || !r.data) throw new Error(r.error ?? 'Failed to get referencing tables.');
    return r.data;
  }

  static async addColumn(ctx: DatabaseContext, table: string, col: ColumnDef): Promise<void> {
    if (!col?.name) throw new Error('Column name is required.');
    const r = await ctx.db.addColumn(table, col);
    if (!r.success) throw new Error(r.error ?? 'Failed to add column.');
  }

  static async modifyColumn(ctx: DatabaseContext, table: string, colName: string, col: ColumnDef): Promise<void> {
    if (!col) throw new Error('Column definition is required.');
    const r = await ctx.db.modifyColumn(table, colName, col);
    if (!r.success) throw new Error(r.error ?? 'Failed to modify column.');
  }

  static async renameColumn(ctx: DatabaseContext, table: string, colName: string, newName: string): Promise<void> {
    const trimmed = String(newName ?? '').trim();
    if (!trimmed) throw new Error('New column name is required.');
    const r = await ctx.db.renameColumn(table, colName, trimmed);
    if (!r.success) throw new Error(r.error ?? 'Failed to rename column.');
  }

  static async dropColumn(ctx: DatabaseContext, table: string, colName: string): Promise<void> {
    const r = await ctx.db.dropColumn(table, colName);
    if (!r.success) throw new Error(r.error ?? 'Failed to drop column.');
  }

  static async createIndex(ctx: DatabaseContext, table: string, def: IndexDef): Promise<void> {
    if (!def || !Array.isArray(def.columns) || def.columns.length === 0) {
      throw new Error('At least one column is required for an index.');
    }
    const r = await ctx.db.createIndex(table, def);
    if (!r.success) throw new Error(r.error ?? 'Failed to create index.');
  }

  static async dropIndex(ctx: DatabaseContext, indexName: string): Promise<void> {
    const r = await ctx.db.dropIndex(indexName);
    if (!r.success) throw new Error(r.error ?? 'Failed to drop index.');
  }
}

