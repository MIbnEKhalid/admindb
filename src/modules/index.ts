import type { Router, Request, Response, NextFunction } from 'express';
import type { RouteContext } from '../core/router';
import { registerTableRoutes } from './tables/tables.routes';
import { registerRowRoutes } from './rows/rows.routes';
import { registerSchemaRoutes } from './schema/schema.routes';
import { registerQueryRoutes } from './query/query.routes';
import { registerSeedRoutes } from './seed/seed.routes';
import { registerErdRoutes } from './erd/erd.routes';
import { registerSyncRoutes } from './sync/sync.routes';

export * from './databases/index';
export * from './tables/index';
export * from './rows/index';
export * from './query/index';
export * from './schema/index';
export * from './seed/index';
export * from './erd/index';
export * from './sync/index';

export function registerModules(router: Router, ctx: RouteContext): void {
  // In read-only mode every mutating request is rejected (GET, the generate-only
  // preview endpoints and the query runner stay available; the query runner
  // rejects write statements itself).
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') return next();
    const p = req.path;
    if (
      p.endsWith('/generate') ||
      p.endsWith('/preview') ||
      p.includes('/api/query/') ||
      p.endsWith('/rows/bulk-impact') ||
      p.endsWith('/rows/bulk-export') ||
      p.startsWith('/api/sync/')
    ) {
      return next();
    }
    try {
      const dbCtx = ctx.getContext(req);
      if (dbCtx && (dbCtx.isReadOnly || dbCtx.db.isReadOnly)) {
        return res.status(403).json({
          success: false,
          error: 'Database is open in read-only mode — write operations are disabled.',
        });
      }
    } catch {
      // If db cannot be resolved, let specific route handler return 404
    }
    return next();
  });

  registerTableRoutes(router, ctx);
  registerRowRoutes(router, ctx);
  registerSchemaRoutes(router, ctx);
  registerQueryRoutes(router, ctx);
  registerSeedRoutes(router, ctx);
  registerErdRoutes(router, ctx);
  registerSyncRoutes(router, ctx);
}
