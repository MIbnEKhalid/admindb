import { quoteIdentifier, type ColumnDef, type IndexDef } from '../../../sql/generator';
import type { IDdlGenerator } from '../types';
import type { Result } from '../../types';

export class PostgresDdlGenerator implements IDdlGenerator {
  createTable(table: string, columns: ColumnDef[]): string {
    const colDefs: string[] = [];
    const pks: string[] = [];

    for (const c of columns) {
      let def = `${quoteIdentifier(c.name)} ${c.type}`;
      if (c.primaryKey) pks.push(quoteIdentifier(c.name));
      if (c.notNull) def += ' NOT NULL';
      if (c.defaultValue !== undefined && c.defaultValue !== null && c.defaultValue !== '') {
        def += ` DEFAULT ${c.defaultValue}`;
      }
      if (c.unique && !c.primaryKey) def += ' UNIQUE';
      if (c.foreignKey?.table && c.foreignKey.column) {
        def += ` REFERENCES ${quoteIdentifier(c.foreignKey.table)} (${quoteIdentifier(c.foreignKey.column)})`;
      }
      colDefs.push(`  ${def}`);
    }

    if (pks.length) {
      colDefs.push(`  PRIMARY KEY (${pks.join(', ')})`);
    }

    return `CREATE TABLE ${quoteIdentifier(table)} (\n${colDefs.join(',\n')}\n);`;
  }

  renameTable(oldName: string, newName: string): string {
    return `ALTER TABLE ${quoteIdentifier(oldName)} RENAME TO ${quoteIdentifier(newName)};`;
  }

  dropTable(table: string, options?: { cascade?: boolean }): string {
    const cascade = options?.cascade ? ' CASCADE' : '';
    return `DROP TABLE ${quoteIdentifier(table)}${cascade};`;
  }

  addColumn(table: string, col: ColumnDef): string {
    let sql = `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(col.name)} ${col.type}`;
    if (col.notNull) sql += ' NOT NULL';
    if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== '') {
      sql += ` DEFAULT ${col.defaultValue}`;
    }
    if (col.foreignKey) {
      sql += ` REFERENCES ${quoteIdentifier(col.foreignKey.table)} (${quoteIdentifier(col.foreignKey.column)})`;
    }
    return sql + ';';
  }

  renameColumn(table: string, oldName: string, newName: string): string {
    return `ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)};`;
  }

  dropColumn(table: string, column: string): string {
    return `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)} CASCADE;`;
  }

  createIndex(table: string, index: IndexDef): string {
    const unique = index.unique ? 'UNIQUE ' : '';
    const cols = index.columns.map(quoteIdentifier).join(', ');
    const name = index.name || `idx_${table}_${index.columns.join('_')}`;
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${quoteIdentifier(table)} (${cols});`;
  }

  dropIndex(indexName: string): string {
    return `DROP INDEX IF EXISTS ${quoteIdentifier(indexName)} CASCADE;`;
  }

  async modifyColumn(driver: any, table: string, oldCol: string, newCol: ColumnDef): Promise<Result<{ changes?: number }>> {
    try {
      const pool = driver.pool || driver;
      const newName = String(newCol.name || oldCol).trim();

      if (oldCol !== newName) {
        await pool.query(`ALTER TABLE ${quoteIdentifier(table)} RENAME COLUMN ${quoteIdentifier(oldCol)} TO ${quoteIdentifier(newName)};`);
      }

      const colToModify = newName;

      if (newCol.type) {
        await pool.query(
          `ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} TYPE ${newCol.type} USING ${quoteIdentifier(colToModify)}::${newCol.type};`,
        );
      }

      if (newCol.notNull !== undefined) {
        const action = newCol.notNull ? 'SET NOT NULL' : 'DROP NOT NULL';
        await pool.query(`ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} ${action};`);
      }

      if (newCol.defaultValue !== undefined) {
        const action = newCol.defaultValue === null || newCol.defaultValue === '' ? 'DROP DEFAULT' : `SET DEFAULT ${newCol.defaultValue}`;
        await pool.query(`ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN ${quoteIdentifier(colToModify)} ${action};`);
      }

      if (newCol.unique !== undefined) {
        const idxName = `idx_${table}_${colToModify}_unique`;
        if (newCol.unique) {
          await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(idxName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(colToModify)});`);
        } else {
          await pool.query(`DROP INDEX IF EXISTS ${quoteIdentifier(idxName)};`);
        }
      }

      return { success: true, data: { changes: 1 } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
