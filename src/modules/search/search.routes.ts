import type { Router, Request, Response } from 'express';
import { type RouteContext, ok, fail, wrap } from '../../core/router';
import { SearchService } from './search.service';

export function registerSearchRoutes(router: Router, ctx: RouteContext): void {
  // ---- Global Search API -------------------------------------------------

  router.get('/api/search/:db', wrap(async (req: Request, res: Response) => {
    const db = ctx.getContext(req);
    const query = String(req.query.q ?? '');
    const type = req.query.type ? String(req.query.type) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const includeRows = req.query.includeRows !== 'false';
    const basePath = String(res.locals.basePath ?? '');

    try {
      const results = await SearchService.search(db, query, {
        type,
        limit,
        includeRows,
        basePath,
      });
      ok(res, results);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to execute global search.', 500);
    }
  }));

  // ---- Metadata Index API (for zero-latency client search) -----------------

  router.get('/api/search/:db/metadata', wrap(async (req: Request, res: Response) => {
    const db = ctx.getContext(req);
    const basePath = String(res.locals.basePath ?? '');

    try {
      const index = await SearchService.getMetadataIndex(db, basePath);
      ok(res, index);
    } catch (err) {
      fail(res, (err as Error).message ?? 'Failed to fetch search metadata.', 500);
    }
  }));
}
