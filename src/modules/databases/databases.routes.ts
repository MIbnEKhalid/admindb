import type { Router, Request, Response, NextFunction } from 'express';
import path from 'node:path';
import type { DbManager } from '../../db/manager';
import type { Logger } from '../../utils/logger';
import { errorMessage } from '../../utils/common';
import { DatabasesService, type DatabaseRow, type FsEntry } from './databases.service';

export type { DatabaseRow, FsEntry };

export interface DatabasesRoutesContext {
  manager: DbManager;
  logger: Logger;
  basePath: string;
  readonly?: boolean;
  allowBrowse?: boolean;
  browseRoot?: string;
  invalidate?: (id: string) => void;
}

export function registerDatabasesRoutes(router: Router, ctx: DatabasesRoutesContext): void {
  const { manager } = ctx;
  const allowBrowse = ctx.allowBrowse ?? true;
  const browseRoot = ctx.browseRoot ? path.resolve(ctx.browseRoot) : undefined;

  const wrap =
    (fn: (req: Request, res: Response) => unknown) =>
      async (req: Request, res: Response): Promise<void> => {
        try {
          await fn(req, res);
        } catch (err) {
          res.status(500).json({ success: false, error: errorMessage(err) });
        }
      };

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.databasesMode = true;
      res.render('pages/databases', {
        title: 'Databases',
        databasesMode: true,
        databases: await DatabasesService.getDatabaseRows(manager),
        dbDir: manager.directory,
        readonly: Boolean(ctx.readonly),
        allowBrowse,
        browseRoot,
        config: { basePath: ctx.basePath },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/databases', wrap(async (_req, res) => {
    res.json({ success: true, data: await DatabasesService.getDatabaseRows(manager) });
  }));

  router.get('/api/fs/list', wrap(async (req, res) => {
    if (!allowBrowse) {
      return res.status(403).json({
        success: false,
        error: 'File browsing is disabled — this server was started with specific database files.',
      });
    }
    const raw = String(req.query.path ?? '').trim();
    const base = raw ? path.resolve(raw) : manager.directory;

    try {
      const data = DatabasesService.listDirectory(base, manager, browseRoot);
      res.json({ success: true, data });
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes('outside the allowed folder')) return res.status(403).json({ success: false, error: msg });
      if (msg.includes('does not exist')) return res.status(404).json({ success: false, error: msg });
      return res.status(400).json({ success: false, error: msg });
    }
  }));

  router.post('/api/databases/open', wrap(async (req, res) => {
    if (!allowBrowse) {
      return res.status(403).json({
        success: false,
        error: 'File browsing is disabled — this server was started with specific database files.',
      });
    }
    const p = String(req.body?.path ?? '').trim();
    const isRo = req.body?.readonly !== undefined ? Boolean(req.body.readonly) : undefined;
    try {
      const id = DatabasesService.openDatabaseFile(manager, p, isRo, browseRoot);
      res.json({ success: true, data: { id, message: `Opened "${id}".` } });
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes('outside the allowed folder')) return res.status(403).json({ success: false, error: msg });
      return res.status(400).json({ success: false, error: msg });
    }
  }));

  router.post('/api/databases/connect-postgres', wrap(async (req, res) => {
    if (ctx.readonly) return res.status(403).json({ success: false, error: 'Read-only mode — adding connections is disabled.' });
    const name = String(req.body?.name ?? '').trim();
    const connectionString = String(req.body?.connectionString ?? req.body?.connection ?? '').trim();
    const isRo = Boolean(req.body?.readonly);
    try {
      const id = await DatabasesService.connectPostgres(manager, name, connectionString, isRo);
      res.status(201).json({ success: true, data: { id, message: `Connected to PostgreSQL database "${id}".` } });
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) });
    }
  }));

  router.post('/api/databases/:id/mode', wrap(async (req, res) => {
    if (ctx.readonly && req.body?.readonly === false) {
      return res.status(403).json({ success: false, error: 'Server is in global read-only mode.' });
    }
    const id = String(req.params.id);
    const targetRo = Boolean(req.body?.readonly);
    try {
      DatabasesService.setDatabaseMode(manager, id, targetRo, ctx.invalidate);
      res.json({
        success: true,
        data: {
          id,
          readonly: targetRo,
          message: `Database "${id}" mode set to ${targetRo ? 'Read-only' : 'Writable'}.`,
        },
      });
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes('does not exist')) return res.status(404).json({ success: false, error: msg });
      res.status(400).json({ success: false, error: msg });
    }
  }));

  router.post('/api/databases', wrap(async (req, res) => {
    if (ctx.readonly) return res.status(403).json({ success: false, error: 'Read-only mode — creating databases is disabled.' });
    const name = String(req.body?.name ?? '').trim();
    try {
      const id = DatabasesService.createDatabase(manager, name);
      res.status(201).json({ success: true, data: { id, message: `Database "${id}" created.` } });
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) });
    }
  }));

  router.delete('/api/databases/:id', wrap(async (req, res) => {
    if (ctx.readonly) return res.status(403).json({ success: false, error: 'Read-only mode — deleting databases is disabled.' });
    const id = String(req.params.id);
    try {
      DatabasesService.removeDatabase(manager, id, ctx.invalidate);
      res.json({ success: true, data: { message: `Database "${id}" removed.` } });
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes('does not exist')) return res.status(404).json({ success: false, error: msg });
      res.status(400).json({ success: false, error: msg });
    }
  }));
}
