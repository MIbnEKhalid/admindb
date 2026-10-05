import type { Router, Request, Response, NextFunction } from 'express';
import { type RouteContext, type RequestParams, ok, fail, wrap, initPageLocals } from '../../core/router';
import { TableService } from '../tables/tables.service';
import { SyncService } from './sync.service';
import type { SupportedDialect } from '../../core/transfer/dialect-mapper';

export function registerSyncRoutes(router: Router, ctx: RouteContext): void {
  const getDb = (dbId: string, readonly = false) => {
    if (ctx.getNamedContext) {
      return ctx.getNamedContext(dbId, readonly);
    }
    return ctx.getContext({ params: { db: dbId } } as any);
  };

  // ---- Page Routes: /diff and /sync ---------------------------------------

  const renderSyncPage = async (req: Request<RequestParams>, res: Response, next: NextFunction) => {
    try {
      const activeDbId = req.params.db || (res.locals.dbId as string) || '';
      let currentCtx = null;
      let allNames: string[] = [];

      try {
        if (activeDbId) {
          currentCtx = getDb(activeDbId);
          const tablesList = await TableService.listTables(currentCtx);
          allNames = tablesList.map((t) => t.name);
          initPageLocals(res, currentCtx, activeDbId, allNames);
        }
      } catch {}

      const databases = SyncService.listAvailableDatabases(
        ctx.manager,
        currentCtx
          ? {
              id: currentCtx.id,
              name: currentCtx.name,
              dialect: currentCtx.dialect.name,
              path: currentCtx.path,
              readonly: currentCtx.isReadOnly,
            }
          : undefined,
      );

      res.render('pages/sync', {
        title: 'Diff & Replication Studio',
        dbId: activeDbId,
        databases,
        tables: allNames,
        isSqlite: currentCtx?.dialect.name === 'sqlite',
        isPostgres: currentCtx?.dialect.name === 'postgres',
        readonly: currentCtx ? currentCtx.isReadOnly : false,
      });
    } catch (err) {
      next(err);
    }
  };

  router.get('/diff', renderSyncPage);
  router.get('/diff/:db', renderSyncPage);
  router.get('/sync', renderSyncPage);
  router.get('/sync/:db', renderSyncPage);

  // ---- API Routes --------------------------------------------------------

  router.get('/api/sync/databases', wrap(async (_req, res) => {
    const databases = SyncService.listAvailableDatabases(ctx.manager);
    ok(res, databases);
  }));

  router.post('/api/sync/diff/schema', wrap(async (req, res) => {
    const { sourceDbId, targetDbId } = req.body || {};
    if (!sourceDbId || !targetDbId) {
      return fail(res, 'Both sourceDbId and targetDbId are required.');
    }
    const srcCtx = getDb(sourceDbId, true);
    const tgtCtx = getDb(targetDbId, true);

    const diff = await SyncService.diffSchema(srcCtx.db, sourceDbId, tgtCtx.db, targetDbId);
    ok(res, diff);
  }));

  router.post('/api/sync/diff/data', wrap(async (req, res) => {
    const { sourceDbId, targetDbId, table, limit } = req.body || {};
    if (!sourceDbId || !targetDbId || !table) {
      return fail(res, 'sourceDbId, targetDbId, and table are required.');
    }
    const srcCtx = getDb(sourceDbId, true);
    const tgtCtx = getDb(targetDbId, true);

    const rowLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 100;
    const diff = await SyncService.diffTableData(srcCtx.db, tgtCtx.db, table, rowLimit);
    ok(res, diff);
  }));

  router.post('/api/sync/patch', wrap(async (req, res) => {
    const { sourceDbId, targetDbId } = req.body || {};
    if (!sourceDbId || !targetDbId) {
      return fail(res, 'Both sourceDbId and targetDbId are required.');
    }
    const srcCtx = getDb(sourceDbId, true);
    const tgtCtx = getDb(targetDbId, true);

    const diff = await SyncService.diffSchema(srcCtx.db, sourceDbId, tgtCtx.db, targetDbId);
    const targetDialect: SupportedDialect = tgtCtx.dialect.name === 'postgres' ? 'postgres' : 'sqlite';
    const patch = SyncService.generatePatch(diff, targetDialect);
    ok(res, patch);
  }));

  router.post('/api/sync/dry-run', wrap(async (req, res) => {
    const { sourceDbId, targetDbId, mode, tables, maskData } = req.body || {};
    if (!sourceDbId || !targetDbId) {
      return fail(res, 'Both sourceDbId and targetDbId are required.');
    }
    const srcCtx = getDb(sourceDbId, true);
    const tgtCtx = getDb(targetDbId, true);

    const result = await SyncService.replicate(srcCtx.db, sourceDbId, tgtCtx.db, targetDbId, {
      mode,
      tables,
      maskData,
      dryRun: true,
    });
    ok(res, result);
  }));

  router.post('/api/sync/execute', wrap(async (req, res) => {
    const { sourceDbId, targetDbId, mode, tables, maskData, confirmTargetName } = req.body || {};
    if (!sourceDbId || !targetDbId) {
      return fail(res, 'Both sourceDbId and targetDbId are required.');
    }
    if (sourceDbId === targetDbId) {
      return fail(res, 'Source and target database cannot be the same.');
    }

    const srcCtx = getDb(sourceDbId, true);
    const tgtCtx = getDb(targetDbId, false);

    if (tgtCtx.isReadOnly) {
      return fail(res, `Target database "${targetDbId}" is in read-only mode and cannot be modified.`);
    }

    // Safety verification check: if target looks like prod or if requested, confirm target name
    const isTargetProd = targetDbId.toLowerCase().includes('prod') || targetDbId.toLowerCase().includes('production');
    if (isTargetProd && confirmTargetName !== targetDbId) {
      return fail(
        res,
        `Target database appears to be PRODUCTION (${targetDbId}). You must type the target database name to confirm.`,
        400,
        { requiresConfirmation: true, targetDbId },
      );
    }

    const result = await SyncService.replicate(srcCtx.db, sourceDbId, tgtCtx.db, targetDbId, {
      mode,
      tables,
      maskData,
      dryRun: false,
    });

    if (!result.success) {
      return fail(res, result.error || 'Replication failed.', 500, { result });
    }

    ok(res, result);
  }));
}
