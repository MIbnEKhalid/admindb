import type { Router, Request, Response, NextFunction } from 'express';
import type { DbManager, DatabaseEntry } from '../db/manager';
import type { Logger } from '../logger';
import { errorMessage } from '../util';

interface DatabasesContext {
  manager: DbManager;
  logger: Logger;
  basePath: string;
  /** Read-only mode: database create/delete are disabled. */
  readonly?: boolean;
  /** Called before a database is deleted so cached per-db apps are dropped. */
  invalidate?: (id: string) => void;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export interface DatabaseRow extends DatabaseEntry {
  sizeLabel: string;
  modifiedLabel: string;
  tables: number;
}

export function registerDatabasesRoutes(router: Router, ctx: DatabasesContext): void {
  const { manager } = ctx;

  const wrap =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        res.status(500).json({ success: false, error: errorMessage(err) });
      }
    };

  // Landing page: list the available databases.
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const entries = manager.list();
      const databases: DatabaseRow[] = await Promise.all(
        entries.map(async (e) => ({
          ...e,
          sizeLabel: formatBytes(e.size),
          modifiedLabel: e.modified ? formatDate(e.modified) : '—',
          tables: await manager.countTables(e.id),
        })),
      );
      res.render('pages/databases', {
        title: 'Databases',
        databases,
        dbDir: manager.directory,
        readonly: !!ctx.readonly,
        config: { basePath: ctx.basePath },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/api/databases',
    wrap(async (_req, res) => {
      const entries = manager.list();
      const data: DatabaseRow[] = await Promise.all(
        entries.map(async (e) => ({
          ...e,
          sizeLabel: formatBytes(e.size),
          modifiedLabel: e.modified ? formatDate(e.modified) : '—',
          tables: await manager.countTables(e.id),
        })),
      );
      res.json({ success: true, data });
    }),
  );

  router.post(
    '/api/databases',
    wrap(async (req, res) => {
      if (ctx.readonly) {
        return res.status(403).json({ success: false, error: 'Read-only mode — creating databases is disabled.' });
      }
      const name = String(req.body?.name ?? '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'Database name is required.' });
      let id: string;
      try {
        id = manager.create(name);
      } catch (err) {
        return res.status(400).json({ success: false, error: errorMessage(err) });
      }
      res.status(201).json({ success: true, data: { id, message: `Database "${id}" created.` } });
    }),
  );

  router.delete(
    '/api/databases/:id',
    wrap(async (req, res) => {
      if (ctx.readonly) {
        return res.status(403).json({ success: false, error: 'Read-only mode — deleting databases is disabled.' });
      }
      const id = String(req.params.id);
      if (!manager.has(id)) {
        return res.status(404).json({ success: false, error: `Database "${id}" does not exist.` });
      }
      if (ctx.invalidate) ctx.invalidate(id);
      manager.remove(id);
      res.json({ success: true, data: { message: `Database "${id}" deleted.` } });
    }),
  );
}
