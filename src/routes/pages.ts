import type { Router, Request, Response, NextFunction } from 'express';
import type { IDatabase, TableInfoData } from '../db/index';
import type { Logger } from '../utils/logger';
import { generateSqlDump, generateSchemaDump } from '../db/export';
import { quoteIdentifier } from '../sql/generator';
import { decodePk, encodePk, normalizeCell, parseFilters, filtersToQS, formatBytes } from '../utils/common';
import { sniffMimeType, isJsonString } from '../utils/datatype';
import { buildColumnConfigs, MAX_SEED_ROWS } from '../data/index';

interface PageContext {
  db: IDatabase;
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

function buildDisplayRows(rawRows: Record<string, unknown>[], info: TableInfoData, table?: string, basePath = ''): DisplayRow[] {
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
        let blobSize = '';
        let blobMime = '';
        let blobExt = '';
        let blobUrl = '';

        if (!isNull) {
          const str = String(v);
          if (isBlob) {
            let buf: Buffer;
            if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
              buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            } else if (typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v)) {
              buf = Buffer.from(v.slice(2), 'hex');
            } else if (typeof v === 'string' && /^\\x[0-9a-f]*$/i.test(v)) {
              buf = Buffer.from(v.slice(2), 'hex');
            } else {
              buf = Buffer.from(str, 'utf8');
            }
            const mimeInfo = sniffMimeType(buf);
            blobSize = formatBytes(buf.length);
            blobMime = mimeInfo.mime;
            blobExt = mimeInfo.ext;
            isImage = mimeInfo.isImage;
            if (table && pkEncoded) {
              blobUrl = `${basePath}/api/tables/${encodeURIComponent(table)}/row/${encodeURIComponent(pkEncoded)}/blob/${encodeURIComponent(c.name)}`;
            }
          } else if (isJsonString(v) || typeUpper.includes('JSON')) {
            isJson = isJsonString(v);
          } else {
            if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(str)) {
              isUrl = true;
            } else if (/^#(?:[0-9a-fA-F]{3}){1,2}$|^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/i.test(str)) {
              isColor = true;
            }
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

export function registerPages(router: Router, ctx: PageContext): void {
  const { db } = ctx;

  const notFound = (res: Response, message: string): void => {
    res.status(404).render('pages/error', { title: 'Not found', status: 404, error: message });
  };

  // Home / browse overview.
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const names: string[] = (res.locals.tables as string[]) ?? [];
      const internalNames: string[] = (res.locals.internalTables as string[]) ?? [];

      let colCountsMap: Record<string, number> = {};
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

  // Browse a table's rows.

  router.get('/tables/:table', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
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
          href: `${basePath}/tables/${encodeURIComponent(table)}?${qs}${filterQS ? '&' + filterQS : ''}`,
        };
      });

      const refColumns = (refsR.data ?? [])
        .filter((r) => !r.table.startsWith('_'))
        .map((rt) => {
          const ref = rt.refs[0];
          return { table: rt.table, from: ref?.from ?? '', to: ref?.to ?? '' };
        });

      // Per-row reference counts: parallel query per referencing table.
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

      const rows = buildDisplayRows(rawRows, info.data, table, basePath).map((dr, i) => {
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

  // Table schema editor.
  router.get('/tables/:table/schema', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
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
        table,
        schema: schema.data,
        isInternal: table.startsWith('_'),
        dialect: db.dialect,
        isSqlite: db.dialect === 'sqlite',
        isPostgres: db.dialect === 'postgres',
        config: { table, isInternal: table.startsWith('_'), dialect: db.dialect },
      });
    } catch (err) {
      next(err);
    }
  });

  // Data generator / seeder.
  router.get('/tables/:table/seed', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
      const [info, countRes] = await Promise.all([db.getTableInfo(table), db.getRowCount(table)]);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const rowCount = countRes.success ? countRes.data : 0;
      const columns = buildColumnConfigs(info.data);
      res.locals.currentTable = table;
      res.render('pages/seed', {
        title: `Seed data · ${table}`,
        table,
        rowCount,
        colCount: info.data.columns.length,
        maxRows: MAX_SEED_ROWS,
        quickCounts: [10, 50, 100, 500, 1000, MAX_SEED_ROWS],
        seedConfig: { table, columns, rowCount, maxRows: MAX_SEED_ROWS },
      });
    } catch (err) {
      next(err);
    }
  });

  // Insert form.
  router.get('/tables/:table/rows/new', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
      const info = await db.getTableInfo(table);
      if (!info.success || !info.data || info.data.columns.length === 0) {
        return notFound(res, `Table "${table}" does not exist.`);
      }
      const pkColumns = info.data.primaryKey;
      res.locals.currentTable = table;
      res.render('pages/form', {
        title: `New row · ${table}`,
        table,
        mode: 'insert',
        pk: null,
        pkColumns,
        infoSummary: `${info.data.columns.length} column(s)` + (pkColumns.length ? ` · PK: ${pkColumns.join(', ')}` : ''),
        config: { table, mode: 'insert', pk: null, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  // Edit form.
  router.get('/tables/:table/rows/:id/edit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const table = req.params.table;
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
        table,
        mode: 'edit',
        pk: req.params.id,
        pkColumns,
        infoSummary: `${info.data.columns.length} column(s)` + (info.data.primaryKey.length ? ` · PK: ${info.data.primaryKey.join(', ')}` : ''),
        config: { table, mode: 'edit', pk: req.params.id, pkColumns },
      });
    } catch (err) {
      next(err);
    }
  });

  // ER diagram / relationship visualization.
  router.get('/erd', (_req: Request, res: Response) => {
    res.render('pages/erd', { title: 'ER Diagram' });
  });

  // Table designer.
  router.get('/designer', (_req: Request, res: Response) => {
    res.render('pages/designer', {
      title: 'New table',
      dialect: db.dialect,
      isSqlite: db.dialect === 'sqlite',
      isPostgres: db.dialect === 'postgres',
    });
  });

  // Query editor.
  router.get('/query', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const queries = await db.listSavedQueries();
      res.render('pages/query', { title: 'Query editor', savedQueries: queries.success ? queries.data : [] });
    } catch (err) {
      next(err);
    }
  });

  // Export: downloadable SQL dump.
  router.get('/export', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const dump = await generateSqlDump(db);
      if (!dump.success || !dump.data) throw new Error(dump.error ?? 'Failed to generate dump.');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/sql; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="admindb-${stamp}.sql"`);
      res.send(dump.data);
    } catch (err) {
      next(err);
    }
  });

  // Database Info / Settings page
  router.get('/info', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const settingsRes = await db.getSettings();
      const settings = settingsRes.success ? settingsRes.data : {};
      
      res.render('pages/info', {
        title: 'Database Info',
        settings,
        dialect: db.dialect,
        dbPath: db.path,
      });
    } catch (err) {
      next(err);
    }
  });
}
