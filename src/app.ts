import express from 'express';
import path from 'node:path';
import { engine } from 'express-handlebars';
import { SqliteDatabase } from './db/database';
import { PostgresDatabase } from './db/postgres';
import type { IDatabase, PostgresOptions } from './db/types';
import { DbManager } from './db/manager';
import { createLogger, type Logger, type LogLevel } from './utils/logger';
import { registerPages } from './routes/pages';
import { registerApi } from './routes/api/index';
import { registerDatabasesRoutes } from './routes/databases';
import { getPackageVersion } from './cli/args';
import { errorMessage, isPostgresConnectionString } from './utils/common';
import { renderIcon, ICONS } from './utils/icons';
import { isServerlessEnvironment } from './serverless';
import { resolveAuthConfig, createAuthMiddleware, registerAuthRoutes, type AuthConfig } from './auth';

const APP_VERSION = getPackageVersion();

export interface AppOptions {
  dbPath?: string;
  connection?: string;
  pgOptions?: PostgresOptions;
  basePath?: string;
  logger?: Logger;
  logLevel?: LogLevel;
  db?: IDatabase;
  manager?: DbManager;
  readonly?: boolean;
  serverless?: boolean;
  auth?: boolean | AuthConfig;
  allowBrowse?: boolean;
  browseRoot?: string;
  databasesUrl?: string;
  dbId?: string;
}

export function createRouter(options: AppOptions = {}): express.Express {
  return options.manager ? createManagerApp(options) : createSingleDbApp(options);
}

function setupViewEngine(app: express.Express, _logger: Logger): void {
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
        json: (v: unknown) => (JSON.stringify(v ?? null) ?? 'null').replace(/</g, '\\u003c'),
        add: (a: unknown, b: unknown) => Number(a) + Number(b),
        sub: (a: unknown, b: unknown) => Number(a) - Number(b),
        gt: (a: unknown, b: unknown) => Number(a) > Number(b),
        lt: (a: unknown, b: unknown) => Number(a) < Number(b),
        join: (arr: unknown, sep: string) => (Array.isArray(arr) ? arr.join(String(sep ?? ',')) : String(arr ?? '')),
        icon: (name: unknown, options?: any) => {
          const customClass = (options && options.hash && options.hash.class) || undefined;
          return renderIcon(String(name ?? ''), customClass);
        },
      },
    }),
  );
  app.set('view engine', 'hbs');
  app.set('views', path.join(__dirname, 'views'));
}

function addErrorHandlers(app: express.Express, logger: Logger): void {
  app.use((req: express.Request, res: express.Response) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ success: false, error: 'Not found.' });
    }
    res.status(404).render('pages/error', { title: 'Not found', status: 404, error: 'The page you requested does not exist.' });
  });

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', err);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ success: false, error: errorMessage(err) });
    }
    res.status(500).render('pages/error', { title: 'Error', status: 500, error: errorMessage(err) });
  });
}

function createSingleDbApp(options: AppOptions): express.Express {
  const isServerless = options.serverless !== undefined ? options.serverless : isServerlessEnvironment();
  const rawTarget = options.connection || options.dbPath || '';
  const isPg =
    Boolean(options.pgOptions) ||
    isPostgresConnectionString(rawTarget) ||
    options.db?.dialect === 'postgres';

  const readonly = options.readonly !== undefined
    ? Boolean(options.readonly)
    : (isServerless && !isPg);

  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const logger = options.logger ?? createLogger(options.logLevel ?? 'info', 'admindb');

  let db: IDatabase;
  if (options.db) {
    db = options.db;
  } else if (isPg) {
    db = new PostgresDatabase(options.pgOptions || rawTarget, logger, { readonly });
  } else {
    db = new SqliteDatabase(options.dbPath ?? 'admindb.db', logger, { readonly });
  }

  const databasesUrl = options.databasesUrl;
  const authConfig = resolveAuthConfig(options.auth);

  const router = express();
  router.disable('x-powered-by');

  router.use(express.static(path.join(__dirname, 'public')));
  setupViewEngine(router, logger);
  router.use(express.json({ limit: '10mb' }));
  router.use(express.urlencoded({ extended: false }));

  registerAuthRoutes(router, authConfig, basePath, logger);
  router.use(createAuthMiddleware(authConfig, basePath, logger));

  router.use(async (req, res, next) => {
    try {
      res.locals.basePath = basePath;
      res.locals.currentPath = req.path;
      res.locals.currentTable = null;
      res.locals.dbPath = db.path;
      res.locals.dbId = options.dbId ?? (db.dialect === 'postgres' ? 'PostgreSQL' : (path.basename(db.path) || 'SQLite'));
      res.locals.dialect = db.dialect;
      res.locals.isPostgres = db.dialect === 'postgres';
      res.locals.isSqlite = db.dialect === 'sqlite';
      res.locals.dialectName = db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite';
      res.locals.databasesUrl = databasesUrl ?? null;
      res.locals.databasesMode = false;
      res.locals.readonly = db.isReadOnly;
      res.locals.serverless = isServerless;
      res.locals.version = APP_VERSION;
      res.locals.authEnabled = authConfig.enabled;
      res.locals.isDefaultPassword = authConfig.isDefaultPassword;
      res.locals.icons = ICONS;
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

function createManagerApp(options: AppOptions): express.Express {
  const isServerless = options.serverless !== undefined ? options.serverless : isServerlessEnvironment();
  const readonly = isServerless || Boolean(options.readonly);
  const manager = options.manager!;
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const logger = options.logger ?? createLogger(options.logLevel ?? 'info', 'admindb');
  const authConfig = resolveAuthConfig(options.auth);

  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, 'public')));
  setupViewEngine(app, logger);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));

  registerAuthRoutes(app, authConfig, basePath, logger);
  app.use(createAuthMiddleware(authConfig, basePath, logger));

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
      res.locals.serverless = isServerless;
      res.locals.version = APP_VERSION;
      res.locals.authEnabled = authConfig.enabled;
      res.locals.isDefaultPassword = authConfig.isDefaultPassword;
      res.locals.icons = ICONS;
      if (!req.path.startsWith('/api/')) {
        res.locals.tables = [];
        res.locals.internalTables = [];
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  const subApps = new Map<string, express.Express>();
  registerDatabasesRoutes(app, {
    manager,
    logger,
    basePath,
    readonly,
    allowBrowse: isServerless ? false : options.allowBrowse,
    browseRoot: options.browseRoot,
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

    const rawRo = req.query.readonly;
    if (rawRo !== undefined) {
      const explicitRo = rawRo === '1' || rawRo === 'true';
      if (!readonly || explicitRo) {
        manager.setReadonly(dbId, explicitRo);
        subApps.delete(dbId);
      }
    }

    let sub = subApps.get(dbId);
    if (!sub) {
      const subBase = `${basePath || ''}/${encodeURIComponent(dbId)}`;
      const effectiveRo = readonly || manager.isDbReadOnly(dbId);
      sub = createSingleDbApp({
        db: manager.open(dbId, effectiveRo),
        basePath: subBase,
        logger,
        logLevel: options.logLevel,
        dbId,
        databasesUrl: `${basePath || ''}/`,
        readonly: effectiveRo,
        serverless: isServerless,
        auth: authConfig,
      });
      subApps.set(dbId, sub);
    }
    return sub(req, res, next);
  });

  addErrorHandlers(app, logger);
  return app;
}
