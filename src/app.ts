import express from 'express';
import path from 'node:path';
import { engine } from 'express-handlebars';
import { SqliteDatabase } from './db/database';
import { PostgresDatabase } from './db/postgres';
import type { IDatabase, PostgresOptions } from './db/types';
import { DbManager } from './db/manager';
import { createLogger, type Logger, type LogLevel } from './utils/logger';
import { registerModules, registerDatabasesRoutes } from './modules/index';
import { getPackageVersion } from './cli/args';
import { errorMessage, isPostgresConnectionString } from './utils/common';
import { renderIcon, ICONS } from './utils/icons';
import { isServerlessEnvironment } from './serverless';
import { resolveAuthConfig, createAuthMiddleware, registerAuthRoutes, type AuthConfig } from './auth';
import { getDialect } from './db/dialects/index';
import type { DatabaseContext } from './core/context';
import type { IDialect } from './db/dialects/types';

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
  const isServerless = options.serverless !== undefined ? options.serverless : isServerlessEnvironment();
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const logger = options.logger ?? createLogger(options.logLevel ?? 'info', 'admindb');
  const authConfig = resolveAuthConfig(options.auth);

  const envTarget =
    process.env.ADMINDB_CONNECTION ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PG_CONNECTION ||
    '';
  const rawTarget = options.connection || options.dbPath || (isPostgresConnectionString(envTarget) ? envTarget : '');
  const isPg =
    Boolean(options.pgOptions) ||
    isPostgresConnectionString(rawTarget) ||
    options.db?.dialect === 'postgres';

  const explicitReadonly = options.readonly !== undefined ? Boolean(options.readonly) : undefined;
  const globalReadonly =
    explicitReadonly !== undefined
      ? explicitReadonly
      : options.manager
      ? options.manager.isReadOnly
      : isServerless
      ? !isPg
      : false;

  const manager = options.manager;
  let singleDb: IDatabase | undefined;
  let defaultDbId = options.dbId;

  if (!manager) {
    if (options.db) {
      singleDb = options.db;
      if (options.readonly !== undefined && singleDb.isReadOnly !== Boolean(options.readonly)) {
        try {
          Object.defineProperty(singleDb, 'isReadOnly', { value: Boolean(options.readonly), configurable: true });
        } catch {}
      }
    } else if (isPg) {
      singleDb = new PostgresDatabase(options.pgOptions || rawTarget, logger, { readonly: globalReadonly });
    } else {
      singleDb = new SqliteDatabase(options.dbPath ?? 'admindb.db', logger, { readonly: globalReadonly });
    }
    if (!defaultDbId && singleDb) {
      defaultDbId = singleDb.dialect === 'postgres' ? 'PostgreSQL' : (path.basename(singleDb.path) || 'SQLite');
    }
  }

  // Resolve the IDialect for single-database mode
  let singleDialect: IDialect | undefined;
  if (singleDb) {
    const pgSchema = (singleDb as any).schema || 'public';
    singleDialect = getDialect(singleDb.dialect, singleDb.dialect === 'postgres' ? pgSchema : undefined);
  }

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
      res.locals.dbPath = manager ? manager.directory : singleDb?.path;
      res.locals.dbId = defaultDbId ?? null;
      res.locals.databasesUrl = manager ? `${basePath}/` : (options.databasesUrl ?? null);
      res.locals.databasesMode = false;
      res.locals.readonly = globalReadonly;
      res.locals.serverless = isServerless;
      res.locals.version = APP_VERSION;
      res.locals.authEnabled = authConfig.enabled;
      res.locals.isDefaultPassword = authConfig.isDefaultPassword;
      res.locals.icons = ICONS;
      res.locals.tables = [];
      next();
    } catch (err) {
      next(err);
    }
  });

  if (manager) {
    registerDatabasesRoutes(app, {
      manager,
      logger,
      basePath,
      readonly: globalReadonly,
      allowBrowse: isServerless ? false : options.allowBrowse,
      browseRoot: options.browseRoot,
    });
  } else {
    app.get('/', (_req, res) => {
      res.redirect(302, `${basePath}/home/${encodeURIComponent(defaultDbId!)}`);
    });
  }

  const getContext = (req: express.Request): DatabaseContext => {
    if (manager) {
      const dbId = String(req.params.db || req.params.dbId || req.params.id || '');
      if (!manager.has(dbId)) {
        const err = new Error(`Database "${dbId}" does not exist.`);
        (err as any).status = 404;
        throw err;
      }
      const rawRo = req.query.readonly;
      if (rawRo !== undefined) {
        const explicitRo = rawRo === '1' || rawRo === 'true';
        if (!globalReadonly || explicitRo) {
          manager.setReadonly(dbId, explicitRo);
        }
      }
      const effectiveRo = globalReadonly ? true : manager.isDbReadOnly(dbId);
      return manager.getContext(dbId, effectiveRo);
    }
    return {
      id: defaultDbId!,
      name: defaultDbId!,
      path: singleDb!.path,
      db: singleDb!,
      dialect: singleDialect!,
      capabilities: singleDialect!.capabilities,
      isReadOnly: singleDb!.isReadOnly,
      logger,
    };
  };

  const getNamedContext = (dbId: string, readonlyOverride?: boolean): DatabaseContext => {
    if (manager) {
      if (!manager.has(dbId)) {
        const err = new Error(`Database "${dbId}" does not exist.`);
        (err as any).status = 404;
        throw err;
      }
      const effectiveRo = globalReadonly ? true : manager.isDbReadOnly(dbId);
      return manager.getContext(dbId, readonlyOverride !== undefined ? readonlyOverride : effectiveRo);
    }
    return getContext({ params: { db: defaultDbId } } as any);
  };

  registerModules(app, { getContext, getNamedContext, manager, logger });

  addErrorHandlers(app, logger);
  return app;
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
        encodeUri: (str: unknown) => encodeURIComponent(String(str ?? '')),
        or: (a: unknown, b: unknown) => a || b,
        tableName: (t: unknown) => (typeof t === 'object' && t !== null && 'name' in t ? String((t as any).name ?? '') : String(t ?? '')),
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

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500) {
      logger.error('Unhandled error', err);
    }
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ success: false, error: errorMessage(err) });
    }
    res.status(status).render('pages/error', { title: status === 404 ? 'Not found' : 'Error', status, error: errorMessage(err) });
  });
}
