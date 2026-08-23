import type { Router, Request, Response, NextFunction } from 'express';
import { type ApiContext } from './helpers';
import { registerTableRoutes } from './tables';
import { registerRowRoutes } from './rows';
import { registerImportExportRoutes } from './import-export';
import { registerSeedRoutes } from './seed';
import { registerQueryRoutes } from './query';
import { registerErdRoutes } from './erd';
import { generateSchemaDump } from '../../db/export';

export { type ApiContext } from './helpers';

export function registerApi(router: Router, ctx: ApiContext): void {
  const { db } = ctx;

  // In read-only mode every mutating request is rejected (GET, the generate-only
  // preview endpoints and the query runner stay available; the query runner
  // rejects write statements itself).
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!db.isReadOnly || req.method === 'GET') return next();
    const p = req.path;
    if (
      p.endsWith('/generate') ||
      p.endsWith('/preview') ||
      p.endsWith('/api/query/export') ||
      p.endsWith('/api/query') ||
      p.endsWith('/rows/bulk-impact') ||
      p.endsWith('/rows/bulk-export')
    ) {
      return next();
    }
    return res.status(403).json({
      success: false,
      error: 'Database is open in read-only mode — write operations are disabled.',
    });
  });

  registerTableRoutes(router, ctx);
  registerRowRoutes(router, ctx);
  registerImportExportRoutes(router, ctx);
  registerSeedRoutes(router, ctx);
  registerQueryRoutes(router, ctx);
  registerErdRoutes(router, ctx);

  router.get('/api/info/ddl', async (_req: Request, res: Response) => {
    try {
      const dump = await generateSchemaDump(db);
      if (!dump.success) {
        return res.status(500).json({ success: false, error: dump.error });
      }
      res.json({ success: true, data: dump.data });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
