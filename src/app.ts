import express from 'express';
import path from 'node:path';
import { engine } from 'express-handlebars';
import { SqliteDatabase } from './db/database';
import { DbManager } from './db/manager';
import { createLogger, type Logger, type LogLevel } from './logger';
import { registerPages } from './routes/pages';
import { registerApi } from './routes/api';
import { registerDatabasesRoutes } from './routes/databases';
import { errorMessage } from './util';

export interface AppOptions {
  /** Path to the SQLite file (single-db mode). Defaults to `dbadmin.db`. */
  dbPath?: string;
  /** URL prefix used by templates/static assets (e.g. `/admin`). Defaults to `''`. */
  basePath?: string;
  logger?: Logger;
  logLevel?: LogLevel;
  /** Provide an existing database instance (single-db embedding). */
  db?: SqliteDatabase;
  /** Enable multi-database mode with a manager over a directory of `.db` files. */
  manager?: DbManager;
  /** Open the database read-only — all write routes are rejected with 403. */
  readonly?: boolean;
  /** Internal: URL of the databases list (used by per-db apps to link "switch database"). */
  databasesUrl?: string;
  /** Internal: current database id (for locals/display). */
  dbId?: string;
}

/**
 * Build a fully configured, mountable Express app (pages + JSON API + static
 * assets + view engine).
 *
 * - Single database: pass `dbPath` (or `db`). Mount under your own prefix with
 *   `basePath`. This is also the mode used per-database in multi-db mode.
 * - Multiple databases: pass a `manager`. The app then shows a "Databases"
 *   landing page and scopes every database under `/{dbFile}/…` (e.g.
 *   `/{base}/app.db/tables/users`, `/{base}/app.db/api/tables`).
 *
 * An Express app is valid middleware, so `app.use('/admin', createRouter({...}))`
 * works and shares the same port.
 */
export function createRouter(options: AppOptions = {}): express.Express {
  return options.manager ? createManagerApp(options) : createSingleDbApp(options);
}

function setupViewEngine(app: express.Express, logger: Logger): void {
  app.engine(
    'hbs',
    engine({
      extname: '.hbs',
      defaultLayout: 'main',
      layoutsDir: path.join(__dirname, 'views', 'layouts'),
      partialsDir: path.join(__dirname, 'views', 'partials'),
      helpers: {
        eq: (a: unknown, b: unknown) => a === b,
        startsWith: (a: unknown, b: unknown) => String(a ?? '').startsWith(String(b ?? '')),
        isNull: (v: unknown) => v === null || v === undefined,
        truncate: (v: unknown, n: number) => {
          const s = v == null ? '' : String(v);
          return s.length > n ? `${s.slice(0, n)}…` : s;
        },
        json: (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c'),
        add: (a: unknown, b: unknown) => Number(a) + Number(b),
        sub: (a: unknown, b: unknown) => Number(a) - Number(b),
        gt: (a: unknown, b: unknown) => Number(a) > Number(b),
        lt: (a: unknown, b: unknown) => Number(a) < Number(b),
        join: (arr: unknown, sep: string) => (Array.isArray(arr) ? arr.join(String(sep ?? ',')) : String(arr ?? '')),
      },
    }),
  );
  app.set('view engine', 'hbs');
  app.set('views', path.join(__dirname, 'views'));
}

function addErrorHandlers(app: express.Express, logger: Logger): void {
  // 404 handler.
  app.use((req: express.Request, res: express.Response) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ success: false, error: 'Not found.' });
    }
    res.status(404).render('pages/error', { title: 'Not found', status: 404, error: 'The page you requested does not exist.' });
  });

  // Central error handler.
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', err);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ success: false, error: errorMessage(err) });
    }
    res.status(500).render('pages/error', { title: 'Error', status: 500, error: errorMessage(err) });
  });
}

/** Single-database app (also used as the per-database app in multi-db mode). */
function createSingleDbApp(options: AppOptions): express.Express {
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const logger = options.logger ?? createLogger(options.logLevel ?? 'info', 'dbadmin');
  const db = options.db ?? new SqliteDatabase(options.dbPath ?? 'dbadmin.db', logger, { readonly: options.readonly });
  const databasesUrl = options.databasesUrl;

  const router = express();
  router.disable('x-powered-by');

  // Static assets (relative to the mount point, so a prefix "just works").
  router.use(express.static(path.join(__dirname, 'public')));

  setupViewEngine(router, logger);
  router.use(express.json({ limit: '10mb' }));

  // Page locals (skipped for API + static paths).
  router.use(async (req, res, next) => {
    try {
      res.locals.basePath = basePath;
      res.locals.currentPath = req.path;
      res.locals.currentTable = null;
      res.locals.dbPath = db.path;
      res.locals.dbId = options.dbId ?? null;
      res.locals.databasesUrl = databasesUrl ?? null;
      res.locals.databasesMode = false;
      res.locals.readonly = db.isReadOnly;
      if (!req.path.startsWith('/api/')) {
        const all = await db.listTables();
        const names = (all.data ?? []).map((t) => t.name);
        res.locals.tables = names.filter((n) => !n.startsWith('_'));
        res.locals.internalTables = names.filter((n) => n.startsWith('_'));
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  registerPages(router, { db, logger });
  registerApi(router, { db, logger });

  addErrorHandlers(router, logger);
  return router;
}

/** Multi-database app: databases landing page + a per-database sub-app per file. */
function createManagerApp(options: AppOptions): express.Express {
  const manager = options.manager!;
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const logger = options.logger ?? createLogger(options.logLevel ?? 'info', 'dbadmin');
  const readonly = !!options.readonly;

  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, 'public')));
  setupViewEngine(app, logger);
  app.use(express.json({ limit: '10mb' }));

  // Locals for the databases landing page.
  app.use(async (req, res, next) => {
    try {
      res.locals.basePath = basePath;
      res.locals.currentPath = req.path;
      res.locals.currentTable = null;
      res.locals.dbPath = manager.directory;
      res.locals.dbId = null;
      res.locals.databasesUrl = null;
      res.locals.databasesMode = true;
      res.locals.readonly = readonly;
      if (!req.path.startsWith('/api/')) {
        res.locals.tables = [];
        res.locals.internalTables = [];
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  // Per-database dispatch: mount a cached single-db app at /:dbId.
  const subApps = new Map<string, express.Express>();
  registerDatabasesRoutes(app, {
    manager,
    logger,
    basePath,
    readonly,
    invalidate: (id) => subApps.delete(id),
  });
  app.use('/:dbId', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const dbId = String(req.params.dbId);
    if (!manager.has(dbId)) {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, error: `Database "${dbId}" does not exist.` });
      }
      return res.status(404).render('pages/error', {
        title: 'Not found',
        status: 404,
        error: `Database "${dbId}" does not exist.`,
      });
    }
    let sub = subApps.get(dbId);
    if (!sub) {
      const subBase = `${basePath ? basePath : ''}/${encodeURIComponent(dbId)}`;
      sub = createSingleDbApp({
        db: manager.open(dbId),
        basePath: subBase,
        logger,
        logLevel: options.logLevel,
        dbId,
        databasesUrl: `${basePath ? basePath : ''}/`,
        readonly,
      });
      subApps.set(dbId, sub);
    }
    return sub(req, res, next);
  });

  addErrorHandlers(app, logger);
  return app;
}
