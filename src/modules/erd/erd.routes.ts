import type { Router, Request, Response, NextFunction } from 'express';
import { type RouteContext, ok, fail, initPageLocals } from '../../core/router';
import { TableService } from '../tables/tables.service';
import { ErdService } from './erd.service';

export function registerErdRoutes(router: Router, ctx: RouteContext): void {
  // ---- Page Routes -------------------------------------------------------

  router.get('/erd/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getContext(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const tablesList = await TableService.listTables(db);
      const allNames = tablesList.map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      res.render('pages/erd', { title: 'ER Diagram', dbId });
    } catch (err) {
      next(err);
    }
  });

  // ---- API Routes --------------------------------------------------------

  router.get('/api/erd/:db', async (req: Request, res: Response) => {
    try {
      const db = ctx.getContext(req);
      const graph = await ErdService.getErdGraph(db);
      ok(res, graph);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Unknown error.', 500);
    }
  });
}
