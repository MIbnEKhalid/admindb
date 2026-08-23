import { type ApiContext, ok, fail } from './helpers';
import type { Router } from 'express';

export function registerErdRoutes(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  /**
   * GET /api/erd
   * Returns the full schema graph: tables with columns + foreign-key edges.
   * Used by the ER diagram page to render the interactive canvas without
   * needing to make N+1 individual API requests.
   */
  router.get('/api/erd', async (_req, res) => {
    try {
      const tablesResult = await db.listTables();
      if (!tablesResult.success || !tablesResult.data) {
        return fail(res, tablesResult.error ?? 'Failed to list tables.', 500);
      }

      const tableNames = (tablesResult.data as { name: string }[]).map((t) => t.name);

      const tableDetails = await Promise.all(
        tableNames.map(async (name) => {
          const infoResult = await db.getTableInfo(name);
          if (!infoResult.success || !infoResult.data) {
            return {
              name,
              columns: [],
              foreignKeys: [],
              primaryKey: [] as string[],
            };
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

      ok(res, { tables: tableDetails });
    } catch (err) {
      fail(res, (err as Error).message ?? 'Unknown error.', 500);
    }
  });
}
