import type { Router, Request, Response, NextFunction } from 'express';
import type { IDatabase, TableInfoData } from '../db/index';
import type { Logger } from '../utils/logger';
import type { DatabaseContext } from '../core/context';
import { generateSqlDump } from '../db/export';
import { quoteIdentifier } from '../sql/generator';
import { decodePk, encodePk, normalizeCell, parseFilters, filtersToQS, formatBytes } from '../utils/common';
import { resolveBlobBuffer, sniffBlobMime } from '../modules/rows/index';
import { isJsonString } from '../utils/datatype';
import { buildColumnConfigs, MAX_SEED_ROWS } from '../data/index';

export interface PageContext {
  getDb: (req: Request) => IDatabase;
  getContext?: (req: Request) => DatabaseContext;
  logger: Logger;
}

interface DisplayCell {
  name: string;
  value: unknown;
  isNull: boolean;
  display: string;
  type?: string;
  isBlob?: boolean;
  isJson?: boolean;
  isImage?: boolean;
  isUrl?: boolean;
  isColor?: boolean;
  blobSize?: string;
  blobMime?: string;
  blobExt?: string;
  blobUrl?: string;
}

interface DisplayRow {
  cells: DisplayCell[];
  pkEncoded: string | null;
}

function buildDisplayRows(rawRows: Record<string, unknown>[], info: TableInfoData, dbId?: string, table?: string, basePath = ''): DisplayRow[] {
  const pkCols = info.primaryKey.length ? info.primaryKey : ['_rowid_'];
  return rawRows.map((row) => {
    const pkEncoded = encodePk(pkCols.map((c) => row[c]));
    return {
      cells: info.columns.map((c) => {
        const raw = row[c.name];
        const v = normalizeCell(raw);
        const isNull = v == null;
        const typeUpper = (c.type || '').toUpperCase();
        const isBlob = typeUpper.includes('BLOB') || typeUpper.includes('BYTEA') || Buffer.isBuffer(raw) || raw instanceof Uint8Array || (typeof v === 'string' && (/^0x[0-9a-f]{8,}$/i.test(v) || /^\\x[0-9a-f]{8,}$/i.test(v)));
        let isJson = false;
        let isImage = false;
        let isUrl = false;
        let isColor = false;
        let isAudio = false;
        let isVideo = false;
        let isPdf = false;
        let blobSize = '';
        let blobMime = '';
        let blobExt = '';
        let blobUrl = '';

        if (!isNull) {
          const str = String(v);
          if (isBlob) {
            const buf = resolveBlobBuffer(raw ?? v);
            const mimeInfo = sniffBlobMime(buf);
            blobSize = formatBytes(buf.length);
            blobMime = mimeInfo.mime;
            blobExt = mimeInfo.ext;
            isImage = mimeInfo.isImage;
            isAudio = mimeInfo.isAudio;
            isVideo = mimeInfo.isVideo;
            isPdf = mimeInfo.isPdf;
            if (table && pkEncoded && dbId) {
              blobUrl = `${basePath}/api/tables/${encodeURIComponent(dbId)}/${encodeURIComponent(table)}/row/${encodeURIComponent(pkEncoded)}/blob/${encodeURIComponent(c.name)}`;
            }
          } else if (isJsonString(v) || typeUpper.includes('JSON')) {
            isJson = isJsonString(v);
          } else {
            if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(str)) isUrl = true;
            else if (/^#(?:[0-9a-fA-F]{3}){1,2}$|^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/i.test(str)) isColor = true;
          }
        }

        return {
          name: c.name,
          value: v,
          isNull,
          display: isNull ? '' : String(v),
          type: c.type,
          isBlob,
          isJson,
          isImage,
          isAudio,
          isVideo,
          isPdf,
          isUrl,
          isColor,
          blobSize,
          blobMime,
          blobExt,
          blobUrl,
        };
      }),
      pkEncoded,
    };
  });
}

function initPageLocals(res: Response, db: IDatabase, dbId: string, allNames: string[]): { tables: string[]; internalTables: string[] } {
  const tables = allNames.filter((n) => !n.startsWith('_'));
  const internalTables = allNames.filter((n) => n.startsWith('_'));
  res.locals.dbId = dbId;
  res.locals.dbPath = db.path;
  res.locals.tables = tables;
  res.locals.internalTables = internalTables;
  res.locals.dialect = db.dialect;
  res.locals.isPostgres = db.dialect === 'postgres';
  res.locals.isSqlite = db.dialect === 'sqlite';
  res.locals.dialectName = db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite';
  res.locals.readonly = db.isReadOnly;
  res.locals.databasesMode = false;
  return { tables, internalTables };
}

export function registerPages(router: Router, ctx: PageContext): void {
  const notFound = (res: Response, message: string): void => {
    res.status(404).render('pages/error', { title: 'Not found', status: 404, error: message });
  };

  router.get('/home/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      const { tables: names, internalTables: internalNames } = initPageLocals(res, db, dbId, allNames);

      const colCountsMap: Record<string, number> = {};
      if (db.dialect === 'postgres') {
        const colRes = await db.all(
          `SELECT table_name, count(*)::int AS cols FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name;`,
        );
        if (colRes.success && colRes.data) {
          for (const row of colRes.data as Record<string, unknown>[]) {
            if (row && typeof row.table_name === 'string') {
              colCountsMap[row.table_name] = Number(row.cols ?? 0);
            }
          }
        }
      }

      const [stats, saved] = await Promise.all([
        Promise.all(names.map(async (name) => {
          const countR = await db.getRowCount(name);
          const cols = colCountsMap[name] !== undefined
            ? colCountsMap[name]
            : (await db.getTableInfo(name)).data?.columns.length ?? 0;
          return {
            name,
            count: countR.success ? (countR.data as number) : 0,
            cols,
          };
        })),
        db.listSavedQueries(),
      ]);

      const counts: Record<string, number> = {};
      const cols: Record<string, number> = {};
      let totalRows = 0;
      for (const s of stats) {
        counts[s.name] = s.count;
        cols[s.name] = s.cols;
        totalRows += s.count;
      }

      res.render('pages/home', {
        title: 'Home',
        dbId,
        tables: names,
        counts,
        cols,
        totalRows,
        savedQueries: saved.success ? (saved.data?.length ?? 0) : 0,
        internalCount: internalNames.length,
        dbPath: db.path,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tables/:db/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }

      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const pageSize = Math.max(1, Number.parseInt(String(req.query.size ?? '50'), 10) || 50);
      const orderBy = req.query.orderBy ? String(req.query.orderBy) : undefined;
      const orderDir = String(req.query.orderDir ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      const filters = parseFilters(req.query.f);
      const filterQS = filtersToQS(filters);

      const [countR, rowsR, refsR] = await Promise.all([
        db.getRowCount(table, filters),
        db.getRows(table, { page, limit: pageSize, orderBy, orderDir, filters }),
        db.getReferencingTables(table),
      ]);

      const count = countR.success ? (countR.data as number) : 0;
      const rawRows = (rowsR.data ?? []) as Record<string, unknown>[];
      const pages = Math.max(1, Math.ceil(count / pageSize));
      const basePath = String(res.locals.basePath ?? '');
      const sizes = [25, 50, 100, 250];

      const colHeaders = info.data.columns.map((c) => {
        const active = c.name === orderBy;
        const nextDir = active ? (orderDir === 'asc' ? 'desc' : 'asc') : 'asc';
        const qs = `page=1&size=${pageSize}&orderBy=${encodeURIComponent(c.name)}&orderDir=${nextDir}`;
        return {
          name: c.name,
          pk: c.pk,
          type: c.type,
          active,
          dir: active ? orderDir : null,
          href: `${basePath}/tables/${encodeURIComponent(dbId)}/${encodeURIComponent(table)}?${qs}${filterQS ? `&${filterQS}` : ''}`,
        };
      });

      const refColumns = (refsR.data ?? [])
        .filter((r) => !r.table.startsWith('_'))
        .map((rt) => ({ table: rt.table, from: rt.refs[0]?.from ?? '', to: rt.refs[0]?.to ?? '' }));

      const countEntries = await Promise.all(
        refColumns.map(async (col) => {
          const values = rawRows
            .map((r) => r[col.to])
            .filter((v): v is string | number => v !== null && v !== undefined);
          if (!values.length) return [col.table, new Map<string, number>()] as const;
          const placeholders = values.map(() => '?').join(', ');
          const cR = await db.all(
            `SELECT ${quoteIdentifier(col.from)} AS fk, COUNT(*) AS c FROM ${quoteIdentifier(col.table)} WHERE ${quoteIdentifier(col.from)} IN (${placeholders}) GROUP BY ${quoteIdentifier(col.from)}`,
            values,
          );
          const map = new Map<string, number>();
          for (const row of (cR.data ?? []) as Record<string, unknown>[]) map.set(String(row.fk), Number(row.c));
          return [col.table, map] as const;
        }),
      );
      const countMap = new Map(countEntries);

      const rows = buildDisplayRows(rawRows, info.data, dbId, table, basePath).map((dr, i) => {
        const raw = rawRows[i];
        const refs = refColumns.map((col) => {
          const v = raw[col.to];
          return {
            table: col.table,
            from: col.from,
            to: col.to,
            value: v == null ? '' : String(v),
            count: v == null ? 0 : (countMap.get(col.table)?.get(String(v)) ?? 0),
          };
        });
        return { ...dr, refs };
      });

      res.locals.currentTable = table;
      res.render('pages/table', {
        title: table,
        dbId,
        table,
        info: info.data,
        rows,
        count,
        page,
        pageSize,
        pages,
        pkCols: info.data.primaryKey,
        colNames: info.data.columns.map((c) => c.name),
        colHeaders,
        refColumns,
        hasPk: true,
        orderBy: orderBy ?? '',
        orderDir,
        sizes,
        filters,
        filterQS,
        firstRow: count === 0 ? 0 : (page - 1) * pageSize + 1,
        lastRow: Math.min(page * pageSize, count),
        browseConfig: {
          dbId,
          table,
          filters,
          pkCols: info.data.primaryKey.length ? info.data.primaryKey : ['_rowid_'],
          hasPk: true,
          readonly: db.isReadOnly,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/schema/:db/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const [info, schema] = await Promise.all([db.getTableInfo(table), db.getSchema(table)]);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      if (!schema.success || !schema.data) {
        return notFound(res, schema.error ?? 'Failed to load schema.');
      }
      res.locals.currentTable = table;
      res.render('pages/schema', {
        title: `Schema · ${table}`,
        dbId,
        table,
        schema: schema.data,
        isInternal: table.startsWith('_'),
        dialect: db.dialect,
        isSqlite: db.dialect === 'sqlite',
        isPostgres: db.dialect === 'postgres',
        config: { dbId, table, isInternal: table.startsWith('_'), dialect: db.dialect },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/seed/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      const { tables: tableNames } = initPageLocals(res, db, dbId, allNames);

      if (tableNames.length === 0) {
        return res.render('pages/seed-select', {
          title: 'Seed Data Generator',
          dbId,
          tables: tableNames,
          seedTables: [],
          hasTables: false,
          dialect: db.dialect,
        });
      }

      const tableStats = await Promise.all(
        tableNames.map(async (name) => {
          const [info, countRes] = await Promise.all([db.getTableInfo(name), db.getRowCount(name)]);
          const cols = info.success && info.data ? info.data.columns.length : 0;
          const fks = info.success && info.data ? info.data.foreignKeys.length : 0;
          const rowCount = countRes.success ? (countRes.data as number) : 0;
          return {
            name,
            cols,
            fks,
            rowCount,
          };
        }),
      );

      const defaultTable = req.query.table ? String(req.query.table) : tableStats[0]?.name;
      const defaultMode = req.query.mode === 'chain' ? 'chain' : 'single';

      res.render('pages/seed-select', {
        title: 'Seed Data Generator · Choose Table & Mode',
        dbId,
        tables: tableNames,
        seedTables: tableStats,
        hasTables: true,
        defaultTable,
        defaultMode,
        dialect: db.dialect,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/seed/:db/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      const { tables: allTables } = initPageLocals(res, db, dbId, allNames);

      const initialMode = req.query.mode === 'chain' ? 'chain' : 'single';
      const [info, countRes] = await Promise.all([db.getTableInfo(table), db.getRowCount(table)]);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const rowCount = countRes.success ? (countRes.data as number) : 0;
      const columns = buildColumnConfigs(info.data);
      res.locals.currentTable = table;
      res.render('pages/seed', {
        title: `Seed data · ${table}`,
        dbId,
        table,
        allTables,
        mode: initialMode,
        isChainMode: initialMode === 'chain',
        rowCount,
        colCount: info.data.columns.length,
        maxRows: MAX_SEED_ROWS,
        quickCounts: [10, 50, 100, 500, 1000, MAX_SEED_ROWS],
        seedConfig: { dbId, table, columns, rowCount, maxRows: MAX_SEED_ROWS, mode: initialMode },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tables/:db/:table/rows/new', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.data.primaryKey;
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `New row · ${table}`,
        dbId,
        table,
        mode: 'insert',
        pk: null,
        pkColumns,
        infoSummary: `${info.data.columns.length} column(s)` + (pkColumns.length ? ` · PK: ${pkColumns.join(', ')}` : ''),
        config: { dbId, table, mode: 'insert', pk: null, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tables/:db/:table/rows/:id/edit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const table = req.params.table;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.data.primaryKey.length ? info.data.primaryKey : ['_rowid_'];
      const pk = decodePk(req.params.id);
      if (pk.length !== pkColumns.length) {
        return notFound(res, 'Invalid row identifier.');
      }
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `Edit row · ${table}`,
        dbId,
        table,
        mode: 'edit',
        pk: req.params.id,
        pkColumns,
        infoSummary: `${info.data.columns.length} column(s)` + (info.data.primaryKey.length ? ` · PK: ${info.data.primaryKey.join(', ')}` : ''),
        config: { dbId, table, mode: 'edit', pk: req.params.id, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/erd/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      res.render('pages/erd', { title: 'ER Diagram', dbId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/designer/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      res.render('pages/designer', {
        title: 'New table',
        dbId,
        dialect: db.dialect,
        isSqlite: db.dialect === 'sqlite',
        isPostgres: db.dialect === 'postgres',
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/query/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const queries = await db.listSavedQueries();
      res.render('pages/query', { title: 'Query editor', dbId, savedQueries: queries.success ? queries.data : [] });
    } catch (err) {
      next(err);
    }
  });

  router.get('/export/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      const dump = await generateSqlDump(db);
      if (!dump.success || !dump.data) throw new Error(dump.error ?? 'Failed to generate dump.');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/sql; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(dbId)}-${stamp}.sql"`);
      res.send(dump.data);
    } catch (err) {
      next(err);
    }
  });

  router.get('/info/:db', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = ctx.getDb(req);
      const dbId = req.params.db;
      res.locals.dbId = dbId;
      const all = await db.listTables();
      const allNames = (all.data ?? []).map((t) => t.name);
      initPageLocals(res, db, dbId, allNames);

      const settingsRes = await db.getSettings();
      res.render('pages/info', {
        title: 'Database Info',
        dbId,
        settings: settingsRes.success ? settingsRes.data : {},
        dialect: db.dialect,
        dbPath: db.path,
      });
    } catch (err) {
      next(err);
    }
  });
}
