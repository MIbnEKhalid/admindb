import type { Router } from 'express';
import { type ApiContext, ok, fail } from './helpers';
import { ErdService } from '../../modules/erd/index';

export function registerErdRoutes(router: Router, ctx: ApiContext): void {
  router.get('/api/erd/:db', async (req, res) => {
    try {
      const db = ctx.getDb(req);
      const graph = await ErdService.getErdGraph(db);
      ok(res, graph);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Unknown error.', 500);
    }
  });
}
