import type { Request, Response, NextFunction } from 'express';
import type { DatabaseContext } from './context';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/common';

import type { DbManager } from '../db/manager';

export type RequestParams = Record<string, string>;

export interface RouteContext {
  getContext: (req: Request<any>) => DatabaseContext;
  getNamedContext?: (id: string, readonlyOverride?: boolean) => DatabaseContext;
  manager?: DbManager;
  logger: Logger;
}

export const ok = (res: Response, data: unknown, status = 200): Response =>
  res.status(status).json({ success: true, data });

export const fail = (res: Response, error: string, status = 400, details?: Record<string, unknown> | null): Response =>
  res.status(status).json({ success: false, error, ...(details ? { details } : {}) });

export const notFound = (res: Response, message: string): void => {
  res.status(404).render('pages/error', { title: 'Not found', status: 404, error: message });
};

export const wrap = <P = RequestParams>(fn: (req: Request<P>, res: Response, next?: NextFunction) => unknown) =>
  async (req: Request<P>, res: Response, next?: NextFunction): Promise<void> => {
    try {
      await fn(req, res, next);
    } catch (err) {
      fail(res, errorMessage(err), 500);
    }
  };

export function initPageLocals(
  res: Response,
  dbOrCtx: { dialect: string | { name: string }; path: string; isReadOnly: boolean },
  dbId: string,
  allNames: string[],
): { tables: string[] } {
  const dialectName = typeof dbOrCtx.dialect === 'string' ? dbOrCtx.dialect : dbOrCtx.dialect.name;
  const isPostgres = dialectName === 'postgres';
  const isSqlite = dialectName === 'sqlite';

  res.locals.dbId = dbId;
  res.locals.dbPath = dbOrCtx.path;
  res.locals.tables = allNames;
  res.locals.dialect = dialectName;
  res.locals.isPostgres = isPostgres;
  res.locals.isSqlite = isSqlite;
  res.locals.dialectName = isPostgres ? 'PostgreSQL' : 'SQLite';
  res.locals.readonly = dbOrCtx.isReadOnly;
  res.locals.databasesMode = false;
  return { tables: allNames };
}
