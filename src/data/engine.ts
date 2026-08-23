import type { ColumnInfo, ForeignKeyInfo, IDatabase, TableInfoData, WhereClause } from '../db/index';
import { quoteIdentifier, sqlValue } from '../sql/generator';
import {
  SKIP,
  type ColumnGeneratorConfig,
  type ColumnPlan,
  type GenerateResult,
} from './types';
import { findInMap, parseChecks, type OrderingConstraint } from './detector';
import { generateOne } from './strategies';

/** Distinct non-null values of a foreign key's referenced column. */
async function sampleFkValues(db: IDatabase, fk: ForeignKeyInfo | null): Promise<unknown[]> {
  if (!fk) return [];
  try {
    const ref = await db.getTableInfo(fk.table);
    if (!ref.success || !ref.data || !ref.data.columns.length) return [];
    const refCol = fk.to || ref.data.primaryKey[0] || ref.data.columns[0].name;
    if (!refCol) return [];
    const r = await db.all(
      `SELECT DISTINCT ${quoteIdentifier(refCol)} AS v FROM ${quoteIdentifier(fk.table)} WHERE ${quoteIdentifier(refCol)} IS NOT NULL LIMIT 1000`,
    );
    return ((r.data ?? []) as { v?: unknown }[]).map((row) => row.v).filter((v) => v != null);
  } catch {
    return [];
  }
}


function stringifyKey(v: unknown): string {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `buf:${Buffer.from(v).toString('hex')}`;
  return `${typeof v}:${String(v)}`;
}


function orderedValue(value: unknown, base: unknown, dir: 'after' | 'before', orEqual: boolean): unknown {
  const v = value;
  const b = base;
  if (typeof v === 'string' && typeof b === 'string') {
    const tv = Date.parse(v);
    const tb = Date.parse(b);
    if (Number.isFinite(tv) && Number.isFinite(tb)) {
      if (dir === 'after') {
        if (orEqual ? tv < tb : tv <= tb) return new Date(tb + 1000).toISOString();
      } else if (orEqual ? tv > tb : tv >= tb) {
        return new Date(tb - 1000).toISOString();
      }
      return v;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && /^\d{4}-\d{2}-\d{2}$/.test(b)) {
      const dv = Date.parse(`${v}T00:00:00Z`);
      const db = Date.parse(`${b}T00:00:00Z`);
      if (dir === 'after') {
        if (orEqual ? dv < db : dv <= db) return new Date(db + 86400_000).toISOString().slice(0, 10);
      } else if (orEqual ? dv > db : dv >= db) {
        return new Date(db - 86400_000).toISOString().slice(0, 10);
      }
      return v;
    }
  }
  if (typeof v === 'number' && typeof b === 'number') {
    if (dir === 'after') return orEqual ? Math.max(v, b) : Math.max(v, b + 1);
    return orEqual ? Math.min(v, b) : Math.min(v, b - 1);
  }
  return v;
}

function fitStringLength(val: unknown, len?: { min?: number; max?: number; exact?: number }): unknown {
  if (!len || typeof val !== 'string') return val;
  let v = val;
  if (len.exact != null) {
    if (v.length > len.exact) v = v.slice(0, len.exact);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    while (v.length < len.exact) {
      v += chars[Math.floor(Math.random() * chars.length)];
    }
    return v;
  }
  if (len.max != null && v.length > len.max) {
    v = v.slice(0, len.max);
  }
  if (len.min != null && v.length < len.min) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    while (v.length < len.min) {
      v += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return v;
}

function applyOrdering(fields: WhereClause[], ordering: Map<string, OrderingConstraint>): void {
  if (!ordering.size) return;
  const byCol = new Map(fields.map((f) => [f.column, f]));
  for (const f of fields) {
    const rel = ordering.get(f.column);
    if (!rel) continue;
    if (rel.after && f.value != null) {
      const other = byCol.get(rel.after.column);
      if (other && other.value != null) f.value = orderedValue(f.value, other.value, 'after', rel.after.orEqual);
    }
    if (rel.before && f.value != null) {
      const other = byCol.get(rel.before.column);
      if (other && other.value != null) f.value = orderedValue(f.value, other.value, 'before', rel.before.orEqual);
    }
  }
}

/**
 * Generate `count` rows for a table with structured previews.
 */
export async function generateRows(
  db: IDatabase,
  info: TableInfoData,
  configs: ColumnGeneratorConfig[],
  count: number,
  plan: Record<string, ColumnPlan> = {},
  truncate = false
): Promise<GenerateResult> {

  const fkByColumn = new Map<string, ForeignKeyInfo>();
  for (const fk of info.foreignKeys) fkByColumn.set(fk.from, fk);

  const uniqueCols = new Set<string>();
  for (const cfg of configs) if (cfg.unique) uniqueCols.add(cfg.name);

  const checkInfo = parseChecks(info.sql ?? null);

  const warnings: string[] = [];
  const prepared: { col: ColumnInfo; plan: ColumnPlan }[] = [];
  const fkPools = new Map<string, unknown[]>();
  const fkOmit = new Set<string>();

  for (const col of info.columns) {
    const cfg = configs.find((c) => c.name === col.name);
    const raw = plan[col.name];
    const p = raw && raw.strategy ? raw : (cfg?.defaultPlan ?? { strategy: 'skip' });

    if (p.strategy === 'list' && (!p.values || !p.values.length)) {
      const allowed = findInMap(checkInfo.columnAllowed, col.name);
      if (allowed && allowed.length) {
        p.values = [...allowed];
      }
    }

    if (!cfg || !cfg.strategies.some((s) => s.id === p.strategy)) {
      throw new Error(`Unsupported generator strategy "${p.strategy}" for column "${col.name}".`);
    }

    if (p.strategy === 'list' && !(p.values ?? []).some((v) => String(v).trim() !== '')) {
      warnings.push(`Column "${col.name}": the list is empty, so it will be skipped (DB default applies).`);
    }
    if ((p.strategy === 'skip' || p.strategy === 'null') && !col.pk && col.notnull && col.dflt_value == null) {
      warnings.push(`Column "${col.name}" is NOT NULL without a default — "${p.strategy}" rows may fail to insert.`);
    }
    if (p.strategy === 'fk') {
      const pool = await sampleFkValues(db, fkByColumn.get(col.name) ?? null);
      fkPools.set(col.name, pool);
      const refTable = fkByColumn.get(col.name)?.table ?? '?';
      if (!pool.length) {
        if (col.notnull && !col.pk) {
          fkOmit.add(col.name);
          warnings.push(
            `Column "${col.name}" is a NOT NULL foreign key to "${refTable}", which has no rows. It is omitted from generated rows — seed "${refTable}" first so the insert can reference real values.`,
          );
        } else {
          warnings.push(`Column "${col.name}": "${refTable}" is empty, so NULL will be inserted.`);
        }
      }
    }

    prepared.push({ col, plan: p });
  }

  const rows: WhereClause[][] = [];
  const previewRows: Record<string, unknown>[] = [];
  const uniqueSeen = new Map<string, Set<string>>();

  if (!truncate) {
    for (const col of uniqueCols) {
      try {
        const existing = await db.all(`SELECT ${quoteIdentifier(col)} AS v FROM ${quoteIdentifier(info.table)} WHERE ${quoteIdentifier(col)} IS NOT NULL LIMIT 10000`);
        const seen = new Set<string>();
        for (const r of (existing.data ?? []) as {v?: unknown}[]) {
          if (r.v != null) seen.add(stringifyKey(r.v));
        }
        uniqueSeen.set(col, seen);
      } catch { /* ignore */ }
    }
  }

  for (let i = 0; i < count; i++) {
    const fields: WhereClause[] = [];
    const previewRow: Record<string, unknown> = {};
    let rowValid = true;
    let attempt = 0;

    while (attempt < 100 && rowValid) {
      fields.length = 0;
      let allColsValid = true;

      for (const { col, plan: p } of prepared) {
        if (p.strategy === 'fk' && fkOmit.has(col.name)) {
          previewRow[col.name] = null;
          continue;
        }
        
        let v = generateOne(col, p, fkPools.get(col.name), i + attempt * count);
        if (v === SKIP) {
          previewRow[col.name] = '(default)';
          continue;
        }

        if (uniqueCols.has(col.name)) {
          const seen = uniqueSeen.get(col.name) ?? new Set<string>();
          let singleAtt = 0;
          while (seen.has(stringifyKey(v)) && singleAtt < 100) {
            v = generateOne(col, p, fkPools.get(col.name), i + attempt * count + singleAtt * 100);
            singleAtt += 1;
          }
          if (seen.has(stringifyKey(v))) {
            allColsValid = false;
            break;
          }
        }

        v = fitStringLength(v, findInMap(checkInfo.columnLength, col.name));
        fields.push({ column: col.name, value: v });
        previewRow[col.name] = v;
      }

      if (allColsValid) {
        break; // Successfully generated all columns
      }
      attempt += 1;
    }

    if (attempt >= 100) {
      warnings.push(`Stopped generating rows early at row ${i} because unique generator exhausted possible values without collision.`);
      break;
    }

    // Register generated unique values
    for (const f of fields) {
      if (uniqueCols.has(f.column)) {
        const seen = uniqueSeen.get(f.column) ?? new Set<string>();
        seen.add(stringifyKey(f.value));
        uniqueSeen.set(f.column, seen);
      }
    }

    // Honor CHECK ordering constraints
    applyOrdering(fields, checkInfo.ordering);
    for (const f of fields) {
      previewRow[f.column] = f.value;
    }

    rows.push(fields);
    if (previewRows.length < 50) {
      previewRows.push(previewRow);
    }
  }

  return { rows, previewRows, warnings };
}

/**
 * Render generated rows as a sequence of INSERT statements for preview.
 */
export function buildSeedInsertSql(table: string, rows: WhereClause[][]): string {
  return rows
    .map((fields) => {
      const cols = fields.map((f) => quoteIdentifier(f.column));
      const vals = fields.map((f) => sqlValue(f.value));
      return `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
    })
    .join('\n');
}
