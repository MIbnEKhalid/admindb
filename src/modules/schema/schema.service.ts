import type { IDatabase } from '../../db/index';
import type { ColumnDef, IndexDef } from '../../sql/generator';

export class SchemaService {
  static async addColumn(db: IDatabase, table: string, col: ColumnDef): Promise<void> {
    if (!col?.name) throw new Error('Column name is required.');
    const r = await db.addColumn(table, col);
    if (!r.success) throw new Error(r.error ?? 'Failed to add column.');
  }

  static async modifyColumn(db: IDatabase, table: string, colName: string, col: ColumnDef): Promise<void> {
    if (!col) throw new Error('Column definition is required.');
    const r = await db.modifyColumn(table, colName, col);
    if (!r.success) throw new Error(r.error ?? 'Failed to modify column.');
  }

  static async renameColumn(db: IDatabase, table: string, colName: string, newName: string): Promise<void> {
    const trimmed = String(newName ?? '').trim();
    if (!trimmed) throw new Error('New column name is required.');
    const r = await db.renameColumn(table, colName, trimmed);
    if (!r.success) throw new Error(r.error ?? 'Failed to rename column.');
  }

  static async dropColumn(db: IDatabase, table: string, colName: string): Promise<void> {
    const r = await db.dropColumn(table, colName);
    if (!r.success) throw new Error(r.error ?? 'Failed to drop column.');
  }

  static async createIndex(db: IDatabase, table: string, def: IndexDef): Promise<void> {
    if (!def || !Array.isArray(def.columns) || def.columns.length === 0) {
      throw new Error('At least one column is required for an index.');
    }
    const r = await db.createIndex(table, def);
    if (!r.success) throw new Error(r.error ?? 'Failed to create index.');
  }

  static async dropIndex(db: IDatabase, indexName: string): Promise<void> {
    const r = await db.dropIndex(indexName);
    if (!r.success) throw new Error(r.error ?? 'Failed to drop index.');
  }
}
