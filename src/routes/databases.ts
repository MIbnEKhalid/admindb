import type { Router, Request, Response, NextFunction } from 'express';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DbManager, DatabaseEntry } from '../db/manager';
import type { Logger } from '../logger';
import { errorMessage, isPathWithinRoot } from '../util';

interface DatabasesContext {
  manager: DbManager;
  logger: Logger;
  basePath: string;
  /** Read-only mode: database create/delete are disabled. */
  readonly?: boolean;
  /**
   * Show the filesystem file-browser (default `true`). When `false` — e.g. the
   * server was started with specific database files — browsing is disabled.
   */
  allowBrowse?: boolean;
  /**
   * Restrict the file-browser to this folder (absolute). When set, the browser
   * cannot navigate above it and only databases inside it can be opened.
   */
  browseRoot?: string;
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
        allowBrowse,
        browseRoot,
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

  // ---- Filesystem browser (open an existing database file) ----------------

  interface FsEntry {
    name: string;
    path: string;
    isDir: boolean;
    isDb: boolean;
    size: number;
  }

  function listDirectory(abs: string): FsEntry[] {
    const entries: FsEntry[] = [];
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      const full = path.join(abs, name);
      let isDir = false;
      let size = 0;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = isDir ? 0 : st.size;
      } catch {
        continue; // unreadable entries are skipped
      }
      if (!isDir && !manager.isDbFile(name)) continue;
      entries.push({ name, path: full, isDir, isDb: !isDir, size });
    }
    entries.sort((a, b) =>
      a.isDir === b.isDir
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : a.isDir
          ? -1
          : 1,
    );
    return entries;
  }

  // List subfolders and SQLite database files under a path.
  router.get(
    '/api/fs/list',
    wrap(async (req, res) => {
      if (!allowBrowse) {
        return res
          .status(403)
          .json({ success: false, error: 'File browsing is disabled — this server was started with specific database files.' });
      }
      const raw = String(req.query.path ?? '').trim();
      const base = raw ? path.resolve(raw) : manager.directory;
      if (browseRoot && !isPathWithinRoot(browseRoot, base)) {
        return res.status(403).json({ success: false, error: `Path is outside the allowed folder: ${browseRoot}` });
      }
      if (!existsSync(base)) {
        return res.status(404).json({ success: false, error: `Path does not exist: ${base}` });
      }
      if (!statSync(base).isDirectory()) {
        return res.status(400).json({ success: false, error: `Not a directory: ${base}` });
      }
      let entries: FsEntry[];
      try {
        entries = listDirectory(base);
      } catch (err) {
        return res.status(400).json({ success: false, error: `Could not list "${base}": ${errorMessage(err)}` });
      }
      const parent = path.dirname(base) === base ? null : path.dirname(base);
      // Never allow the browser to navigate above the browse root.
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
    }),
  );

  // Open an existing database file and register it with the manager.
  router.post(
    '/api/databases/open',
    wrap(async (req, res) => {
      if (!allowBrowse) {
        return res
          .status(403)
          .json({ success: false, error: 'File browsing is disabled — this server was started with specific database files.' });
      }
      const p = String(req.body?.path ?? '').trim();
      if (!p) return res.status(400).json({ success: false, error: 'Database path is required.' });
      const abs = path.resolve(p);
      if (browseRoot && !isPathWithinRoot(browseRoot, abs)) {
        return res.status(403).json({ success: false, error: `Cannot open a database outside the allowed folder: ${browseRoot}` });
      }
      let id: string;
      try {
        id = manager.openFile(p);
      } catch (err) {
        return res.status(400).json({ success: false, error: errorMessage(err) });
      }
      res.json({ success: true, data: { id, message: `Opened "${id}".` } });
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
