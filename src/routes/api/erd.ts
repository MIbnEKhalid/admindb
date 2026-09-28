import { type ApiContext, ok, fail } from './helpers';
import type { Router } from 'express';

export function registerErdRoutes(router: Router, ctx: ApiContext): void {
  router.get('/api/erd/:db', async (req, res) => {
    try {
      const db = ctx.getDb(req);
      const tablesResult = await db.listTables();
      if (!tablesResult.success || !tablesResult.data) {
        return fail(res, tablesResult.error ?? 'Failed to list tables.', 500);
      }

      const tableNames = (tablesResult.data as { name: string }[]).map((t) => t.name);

      const tables = await Promise.all(
        tableNames.map(async (name) => {
          const infoResult = await db.getTableInfo(name);
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

      ok(res, { tables });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Unknown error.', 500);
    }
  });
}
