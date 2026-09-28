import type { DatabaseContext } from '../../core/context';

export interface ErdColumn {
  name: string;
  type: string;
  pk: number | boolean;
  notnull: number | boolean;
  dflt_value: unknown;
}

export interface ErdForeignKey {
  from: string;
  table: string;
  to: string;
  on_delete: string;
  on_update: string;
}

export interface ErdTable {
  name: string;
  columns: ErdColumn[];
  foreignKeys: ErdForeignKey[];
  primaryKey: string[];
}

export interface ErdGraph {
  tables: ErdTable[];
}

export class ErdService {
  static async getErdGraph(ctx: DatabaseContext): Promise<ErdGraph> {
    const tablesResult = await ctx.db.listTables();
    if (!tablesResult.success || !tablesResult.data) {
      throw new Error(tablesResult.error ?? 'Failed to list tables.');
    }

    const tableNames = (tablesResult.data as { name: string }[]).map((t) => t.name);

    const tables = await Promise.all(
      tableNames.map(async (name) => {
        const infoResult = await ctx.db.getTableInfo(name);
        if (!infoResult.success || !infoResult.data) {
          return { name, columns: [], foreignKeys: [], primaryKey: [] as string[] };
        }
        const { columns, foreignKeys, primaryKey } = infoResult.data;
        return {
          name,
          columns: columns.map((c) => ({
            name: c.name,
            type: c.type,
            pk: c.pk,
            notnull: c.notnull,
            dflt_value: c.dflt_value,
          })),
          foreignKeys: foreignKeys.map((fk) => ({
            from: fk.from,
            table: fk.table,
            to: fk.to ?? '',
            on_delete: fk.on_delete,
            on_update: fk.on_update,
          })),
          primaryKey,
        };
      }),
    );

    return { tables };
  }
}
