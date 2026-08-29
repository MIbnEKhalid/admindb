import type { Router, Request, Response, NextFunction } from 'express';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DbManager, DatabaseEntry } from '../db/manager';
import type { Logger } from '../utils/logger';
import { errorMessage, isPathWithinRoot, formatBytes, isPostgresConnectionString } from '../utils/common';

interface DatabasesContext {
  manager: DbManager;
  logger: Logger;
  basePath: string;
  readonly?: boolean;
  allowBrowse?: boolean;
  browseRoot?: string;
  invalidate?: (id: string) => void;
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

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isDb: boolean;
  size: number;
}

async function getDatabaseRows(manager: DbManager): Promise<DatabaseRow[]> {
  const entries = manager.list();
  return Promise.all(
    entries.map(async (e) => ({
      ...e,
      isPostgres: e.dialect === 'postgres',
      isSqlite: e.dialect === 'sqlite',
      sizeLabel: e.dialect === 'postgres' ? 'Remote' : formatBytes(e.size),
      modifiedLabel: e.dialect === 'postgres' ? 'Connected' : (e.modified ? formatDate(e.modified) : '—'),
      tables: await manager.countTables(e.id),
    })),
  );
}

export function registerDatabasesRoutes(router: Router, ctx: DatabasesContext): void {
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
      res.render('pages/databases', {
        title: 'Databases',
        databases: await getDatabaseRows(manager),
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
    res.json({ success: true, data: await getDatabaseRows(manager) });
  }));

  const BLOCKED_NAMES = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'System Volume Information',
    '$RECYCLE.BIN',
    '.env',
    '.aws',
    '.ssh',
  ]);

  function listDirectory(abs: string): FsEntry[] {
    const entries: FsEntry[] = [];
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.') || BLOCKED_NAMES.has(name) || name.toLowerCase().startsWith('.env')) continue;
      const full = path.join(abs, name);
      let isDir = false;
      let size = 0;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = isDir ? 0 : st.size;
      } catch {
        continue;
      }
      if (!isDir && !manager.isDbFile(name)) continue;
      if (browseRoot && !isPathWithinRoot(browseRoot, full)) continue;
      entries.push({ name, path: full, isDir, isDb: !isDir, size });
    }
    entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1,
    );
    return entries;
  }

  router.get('/api/fs/list', wrap(async (req, res) => {
    if (!allowBrowse) {
      return res.status(403).json({ success: false, error: 'File browsing is disabled — this server was started with specific database files.' });
    }
    const raw = String(req.query.path ?? '').trim();
    if (raw.includes('\0')) return res.status(400).json({ success: false, error: 'Invalid path.' });

    const base = raw ? path.resolve(raw) : manager.directory;
    if (browseRoot && !isPathWithinRoot(browseRoot, base)) {
      return res.status(403).json({ success: false, error: `Path is outside the allowed folder: ${browseRoot}` });
    }
    if (!existsSync(base)) return res.status(404).json({ success: false, error: `Path does not exist: ${base}` });
    if (!statSync(base).isDirectory()) return res.status(400).json({ success: false, error: `Not a directory: ${base}` });

    let entries: FsEntry[];
    try {
      entries = listDirectory(base);
    } catch (err) {
      return res.status(400).json({ success: false, error: `Could not list "${base}": ${errorMessage(err)}` });
    }
    const parent = path.dirname(base) === base ? null : path.dirname(base);
    const effectiveParent = parent && (!browseRoot || isPathWithinRoot(browseRoot, parent)) ? parent : null;
    res.json({
      success: true,
      data: {
        path: base,
        name: path.basename(base) || base,
        parent: effectiveParent,
        entries,
      },
    });
  }));

  router.post('/api/databases/open', wrap(async (req, res) => {
    if (!allowBrowse) {
      return res.status(403).json({ success: false, error: 'File browsing is disabled — this server was started with specific database files.' });
    }
    const p = String(req.body?.path ?? '').trim();
    if (!p || p.includes('\0')) return res.status(400).json({ success: false, error: 'Valid database path is required.' });
    const abs = path.resolve(p);
    if (browseRoot && !isPathWithinRoot(browseRoot, abs)) {
      return res.status(403).json({ success: false, error: `Cannot open a database outside the allowed folder: ${browseRoot}` });
    }
    const isRo = req.body?.readonly !== undefined ? Boolean(req.body.readonly) : undefined;
    const id = manager.openFile(p, isRo);
    res.json({ success: true, data: { id, message: `Opened "${id}".` } });
  }));

  router.post('/api/databases/connect-postgres', wrap(async (req, res) => {
    if (ctx.readonly) return res.status(403).json({ success: false, error: 'Read-only mode — adding connections is disabled.' });
    const name = String(req.body?.name ?? '').trim();
    const connectionString = String(req.body?.connectionString ?? req.body?.connection ?? '').trim();
    const isRo = Boolean(req.body?.readonly);
    if (!connectionString) {
      return res.status(400).json({ success: false, error: 'PostgreSQL connection string is required (e.g. postgresql://user:password@localhost:5432/dbname).' });
    }
    if (!isPostgresConnectionString(connectionString)) {
      return res.status(400).json({ success: false, error: 'Invalid connection protocol. Connection string must start with postgres:// or postgresql://' });
    }
    let id: string;
    try {
      id = manager.addConnection(name, connectionString, isRo);
      const db = manager.open(id);
      await db.listTables();
    } catch (err) {
      if (id!) manager.remove(id);
      return res.status(400).json({ success: false, error: `Failed to connect to PostgreSQL: ${errorMessage(err)}` });
    }
    res.status(201).json({ success: true, data: { id, message: `Connected to PostgreSQL database "${id}".` } });
  }));

  router.post('/api/databases/:id/mode', wrap(async (req, res) => {
    if (ctx.readonly && req.body?.readonly === false) {
      return res.status(403).json({ success: false, error: 'Server is in global read-only mode.' });
    }
    const id = String(req.params.id);
    if (!manager.has(id)) return res.status(404).json({ success: false, error: `Database "${id}" does not exist.` });
    const targetRo = Boolean(req.body?.readonly);
    manager.setReadonly(id, targetRo);
    if (ctx.invalidate) ctx.invalidate(id);
    res.json({
      success: true,
      data: {
        id,
        readonly: targetRo,
        message: `Database "${id}" mode set to ${targetRo ? 'Read-only' : 'Writable'}.`,
      },
    });
  }));

  router.post('/api/databases', wrap(async (req, res) => {
    if (ctx.readonly) return res.status(403).json({ success: false, error: 'Read-only mode — creating databases is disabled.' });
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Database name is required.' });
    const id = manager.create(name);
    res.status(201).json({ success: true, data: { id, message: `Database "${id}" created.` } });
  }));

  router.delete('/api/databases/:id', wrap(async (req, res) => {
    if (ctx.readonly) return res.status(403).json({ success: false, error: 'Read-only mode — deleting databases is disabled.' });
    const id = String(req.params.id);
    if (!manager.has(id)) return res.status(404).json({ success: false, error: `Database "${id}" does not exist.` });
    if (ctx.invalidate) ctx.invalidate(id);
    manager.remove(id);
    res.json({ success: true, data: { message: `Database "${id}" removed.` } });
  }));
}
