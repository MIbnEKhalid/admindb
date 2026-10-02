import type { IDatabase, TableInfoData } from '../../db/types';

export interface RowValueChange {
  column: string;
  sourceValue: unknown;
  targetValue: unknown;
}

export interface RowDiffItem {
  key: string;
  action: 'added' | 'removed' | 'modified';
  sourceRow?: Record<string, unknown>;
  targetRow?: Record<string, unknown>;
  changes?: RowValueChange[];
}

export interface TableDataDiffResult {
  table: string;
  primaryKeys: string[];
  sourceRowCount: number;
  targetRowCount: number;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  identicalCount: number;
  rows: RowDiffItem[];
  unifiedDiff: string;
}

/**
 * Checks whether two values are semantically equivalent across database engines (SQLite ⇄ PostgreSQL).
 */
export function areValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;

  // 1. Boolean vs Boolean-like (1/0, "true"/"false")
  const isBoolLikeA = typeof a === 'boolean' || a === 0 || a === 1 || a === '0' || a === '1' || a === 'true' || a === 'false';
  const isBoolLikeB = typeof b === 'boolean' || b === 0 || b === 1 || b === '0' || b === '1' || b === 'true' || b === 'false';
  if ((typeof a === 'boolean' || typeof b === 'boolean') && isBoolLikeA && isBoolLikeB) {
    const boolA = a === true || a === 1 || a === '1' || a === 'true';
    const boolB = b === true || b === 1 || b === '1' || b === 'true';
    return boolA === boolB;
  }

  // 2. Numbers / BigInt / Numeric Strings
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 0.000001;
  }
  if ((typeof a === 'number' || typeof a === 'bigint') && typeof b === 'string') {
    if (b.trim() !== '' && !isNaN(Number(b)) && Number(a) === Number(b)) return true;
  }
  if ((typeof b === 'number' || typeof b === 'bigint') && typeof a === 'string') {
    if (a.trim() !== '' && !isNaN(Number(a)) && Number(a) === Number(b)) return true;
  }

  // 3. Dates & Timestamps
  const isDateA = a instanceof Date;
  const isDateB = b instanceof Date;
  if (isDateA || isDateB) {
    const timeA = isDateA ? (a as Date).getTime() : new Date(String(a)).getTime();
    const timeB = isDateB ? (b as Date).getTime() : new Date(String(b)).getTime();
    if (!isNaN(timeA) && !isNaN(timeB)) return timeA === timeB;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.length >= 10 && b.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) {
      const timeA = new Date(a).getTime();
      const timeB = new Date(b).getTime();
      if (!isNaN(timeA) && !isNaN(timeB)) return timeA === timeB;
    }
  }

  // 4. JSON Objects & Arrays / Buffers
  if (typeof a === 'object' || typeof b === 'object') {
    if (Buffer.isBuffer(a) || a instanceof Uint8Array || Buffer.isBuffer(b) || b instanceof Uint8Array) {
      const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a as Uint8Array);
      const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b as Uint8Array);
      return bufA.equals(bufB);
    }
    try {
      const strA = typeof a === 'string' ? a : JSON.stringify(a);
      const strB = typeof b === 'string' ? b : JSON.stringify(b);
      return JSON.stringify(JSON.parse(strA)) === JSON.stringify(JSON.parse(strB));
    } catch {
      // Fall through to string comparison
    }
  }

  return String(a).trim() === String(b).trim();
}

/**
 * Compares row data between source table and target table.
 */
export async function compareTableData(
  sourceDb: IDatabase,
  targetDb: IDatabase,
  table: string,
  limit = 200,
): Promise<TableDataDiffResult> {
  const [srcInfoRes, tgtInfoRes] = await Promise.all([
    sourceDb.getTableInfo(table),
    targetDb.getTableInfo(table),
  ]);

  const srcInfo: TableInfoData | null = srcInfoRes.success && srcInfoRes.data ? srcInfoRes.data : null;
  const tgtInfo: TableInfoData | null = tgtInfoRes.success && tgtInfoRes.data ? tgtInfoRes.data : null;

  if (!srcInfo && !tgtInfo) {
    throw new Error(`Table "${table}" does not exist in either source or target database.`);
  }

  // Handle case where table exists in source but NOT in target
  if (srcInfo && (!tgtInfo || tgtInfo.columns.length === 0)) {
    const srcCountRes = await sourceDb.getRowCount(table);
    const srcRowCount = srcCountRes.data || 0;
    const srcRowsRes = await sourceDb.getRows(table, { limit });
    const srcRows = srcRowsRes.data || [];

    const pks = srcInfo.primaryKey.length > 0 ? srcInfo.primaryKey : ['id'];
    const rows: RowDiffItem[] = srcRows.map((r, idx) => ({
      key: pks.map((k) => String(r[k] ?? '')).join('::') || `row_${idx + 1}`,
      action: 'added',
      sourceRow: r,
    }));

    const lines = [
      `diff --git a/${table}/data b/${table}/data`,
      `@@ Table: ${table} (MISSING IN TARGET DATABASE) @@`,
      ` Target table "${table}" does not exist. All ${srcRowCount} rows are newly added.`,
    ];
    for (const r of rows.slice(0, 100)) {
      lines.push(`+ [PK: ${r.key}] ${JSON.stringify(r.sourceRow)}`);
    }

    return {
      table,
      primaryKeys: pks,
      sourceRowCount: srcRowCount,
      targetRowCount: 0,
      addedCount: rows.length,
      removedCount: 0,
      modifiedCount: 0,
      identicalCount: 0,
      rows,
      unifiedDiff: lines.join('\n'),
    };
  }

  // Handle case where table exists in target but NOT in source
  if (!srcInfo && tgtInfo) {
    const tgtCountRes = await targetDb.getRowCount(table);
    const tgtRowCount = tgtCountRes.data || 0;
    const tgtRowsRes = await targetDb.getRows(table, { limit });
    const tgtRows = tgtRowsRes.data || [];

    const pks = tgtInfo.primaryKey.length > 0 ? tgtInfo.primaryKey : ['id'];
    const rows: RowDiffItem[] = tgtRows.map((r, idx) => ({
      key: pks.map((k) => String(r[k] ?? '')).join('::') || `row_${idx + 1}`,
      action: 'removed',
      targetRow: r,
    }));

    const lines = [
      `diff --git a/${table}/data b/${table}/data`,
      `@@ Table: ${table} (MISSING IN SOURCE DATABASE) @@`,
      ` Source table "${table}" does not exist. All ${tgtRowCount} target rows would be removed.`,
    ];
    for (const r of rows.slice(0, 100)) {
      lines.push(`- [PK: ${r.key}] ${JSON.stringify(r.targetRow)}`);
    }

    return {
      table,
      primaryKeys: pks,
      sourceRowCount: 0,
      targetRowCount: tgtRowCount,
      addedCount: 0,
      removedCount: rows.length,
      modifiedCount: 0,
      identicalCount: 0,
      rows,
      unifiedDiff: lines.join('\n'),
    };
  }

  // Both tables exist: resolve primary keys or unique identifier columns
  const srcColNames = srcInfo!.columns.map((c) => c.name);
  const tgtColNames = tgtInfo!.columns.map((c) => c.name);

  let pks = srcInfo!.primaryKey.length > 0 ? srcInfo!.primaryKey : tgtInfo!.primaryKey;
  if (!pks || pks.length === 0) {
    const hasId = srcColNames.some((c) => c.toLowerCase() === 'id');
    if (hasId) {
      pks = ['id'];
    } else if (srcColNames.length > 0) {
      pks = srcColNames;
    } else {
      pks = ['row_idx'];
    }
  }

  const orderCol = pks[0] && srcColNames.includes(pks[0]) && tgtColNames.includes(pks[0]) ? pks[0] : undefined;

  const [srcCountRes, tgtCountRes, srcRowsRes, tgtRowsRes] = await Promise.all([
    sourceDb.getRowCount(table),
    targetDb.getRowCount(table),
    sourceDb.getRows(table, { limit, orderBy: orderCol, orderDir: 'asc' }),
    targetDb.getRows(table, { limit, orderBy: orderCol, orderDir: 'asc' }),
  ]);

  const srcRows = srcRowsRes.data || [];
  const tgtRows = tgtRowsRes.data || [];

  const makeKey = (row: Record<string, unknown>, fallbackIdx: number): string => {
    const keyParts = pks.map((k) => {
      const v = row[k];
      return v === null || v === undefined ? '' : String(v);
    });
    const key = keyParts.join('::');
    return key.trim() ? key : `row_${fallbackIdx}`;
  };

  const srcMap = new Map<string, Record<string, unknown>>();
  srcRows.forEach((r, idx) => srcMap.set(makeKey(r, idx + 1), r));

  const tgtMap = new Map<string, Record<string, unknown>>();
  tgtRows.forEach((r, idx) => tgtMap.set(makeKey(r, idx + 1), r));

  const allKeys = Array.from(new Set([...srcMap.keys(), ...tgtMap.keys()]));
  const diffItems: RowDiffItem[] = [];

  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  let identicalCount = 0;

  for (const key of allKeys) {
    const sr = srcMap.get(key);
    const tr = tgtMap.get(key);

    if (sr && !tr) {
      addedCount++;
      diffItems.push({ key, action: 'added', sourceRow: sr });
      continue;
    }

    if (!sr && tr) {
      removedCount++;
      diffItems.push({ key, action: 'removed', targetRow: tr });
      continue;
    }

    if (sr && tr) {
      const changes: RowValueChange[] = [];
      const cols = Array.from(new Set([...Object.keys(sr), ...Object.keys(tr)]));

      for (const col of cols) {
        const sv = sr[col];
        const tv = tr[col];

        if (!areValuesEqual(sv, tv)) {
          changes.push({ column: col, sourceValue: sv, targetValue: tv });
        }
      }

      if (changes.length > 0) {
        modifiedCount++;
        diffItems.push({ key, action: 'modified', sourceRow: sr, targetRow: tr, changes });
      } else {
        identicalCount++;
      }
    }
  }

  // Generate Git-like row diff text
  const lines: string[] = [
    `diff --git a/${table}/data b/${table}/data`,
    `@@ Data Diff for Table: ${table} (Key: ${pks.join(', ')}) @@`,
  ];

  for (const item of diffItems.slice(0, 100)) {
    if (item.action === 'added') {
      lines.push(`+ [PK: ${item.key}] ${JSON.stringify(item.sourceRow)}`);
    } else if (item.action === 'removed') {
      lines.push(`- [PK: ${item.key}] ${JSON.stringify(item.targetRow)}`);
    } else if (item.action === 'modified') {
      const changesStr = (item.changes || [])
        .map((c) => `${c.column}: ${JSON.stringify(c.targetValue)} -> ${JSON.stringify(c.sourceValue)}`)
        .join(', ');
      lines.push(`~ [PK: ${item.key}] ${changesStr}`);
    }
  }

  if (diffItems.length === 0) {
    lines.push(' Rows are identical (up to preview limit).');
  }

  return {
    table,
    primaryKeys: pks,
    sourceRowCount: srcCountRes.data || 0,
    targetRowCount: tgtCountRes.data || 0,
    addedCount,
    removedCount,
    modifiedCount,
    identicalCount,
    rows: diffItems,
    unifiedDiff: lines.join('\n'),
  };
}
