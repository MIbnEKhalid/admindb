import type { Request, Response } from 'express';
import type { IDatabase, TableInfoData } from '../../db/index';
import type { Logger } from '../../utils/logger';
import type { DatabaseContext } from '../../core/context';
import { errorMessage } from '../../utils/common';

export interface ApiContext {
  getDb: (req: Request) => IDatabase;
  getContext?: (req: Request) => DatabaseContext;
  logger: Logger;
}

export const ok = (res: Response, data: unknown, status = 200): Response =>
  res.status(status).json({ success: true, data });

export const fail = (res: Response, error: string, status = 400, details?: Record<string, unknown> | null): Response =>
  res.status(status).json({ success: false, error, ...(details ? { details } : {}) });

export const wrap = (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, errorMessage(err), 500);
    }
  };

export async function requireTable(db: IDatabase, table: string): Promise<TableInfoData | null> {
  const info = await db.getTableInfo(table);
  return info.success && info.data?.columns?.length ? info.data : null;
}
