import type { ColumnInfo, ForeignKeyInfo, IDatabase, TableInfoData, WhereClause } from '../db/index';
import { quoteIdentifier, sqlValue } from '../sql/generator';
import { buildColumnConfigs, findInMap, parseChecks, type OrderingConstraint } from './detector';
import { createPrng, type RandomSource } from './prng';
import { generateColumnValue, GeneratorRegistry } from './registry';
import { buildSchemaGraph, resolveScopeTables, sortTopologically } from './schema-graph';
import { evaluateTemplate, orderColumnDependencies } from './templates';
import { SKIP, MAX_SEED_ROWS, type ColumnGeneratorConfig, type ColumnPlan, type ErChainResult, type GenerateResult, type GenerationOptions, type GenerationPlan, type TableGenerationSpec } from './types';
import { validateGenerationPlan } from './validator';

/** Stringifies a value for unique set indexing. */
const stringifyKey = (v: unknown): string =>
  v instanceof Uint8Array || Buffer.isBuffer(v) ? `buf:${Buffer.from(v).toString('hex')}` : `${typeof v}:${String(v)}`;

/** Handles CHECK ordering constraints (e.g. end_date >= start_date). */
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

/** Constrains string length to CHECK requirements. */
function fitStringLength(val: unknown, len?: { min?: number; max?: number; exact?: number }): unknown {
  if (!len || typeof val !== 'string') return val;
  let v = val;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (len.exact != null) {
    if (v.length > len.exact) v = v.slice(0, len.exact);
    while (v.length < len.exact) v += chars[Math.floor(Math.random() * chars.length)];
    return v;
  }
  if (len.max != null && v.length > len.max) v = v.slice(0, len.max);
  if (len.min != null && v.length < len.min) {
    while (v.length < len.min) v += chars[Math.floor(Math.random() * chars.length)];
  }
  return v;
}

/** Applies CHECK ordering constraints across fields in a generated row. */
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

/** Samples distinct non-null values for a table column from database. */
async function sampleColumnValues(db: IDatabase, table: string, column: string, limit = 1000): Promise<unknown[]> {
  try {
    const r = await db.all(
      `SELECT DISTINCT ${quoteIdentifier(column)} AS v FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL LIMIT ${limit}`,
    );
    return ((r.data ?? []) as { v?: unknown }[]).map((row) => row.v).filter((v) => v != null);
  } catch {
    return [];
  }
}

/**
 * Core Unified Seed Engine.
 * Executes a declarative GenerationPlan against a database with full relational context.
 */
export class SeedEngine {
  public static async executePlan(
    db: IDatabase,
    plan: GenerationPlan,
    optionsOverride?: Partial<GenerationOptions>,
  ): Promise<ErChainResult> {
    const options: GenerationOptions = {
      seed: plan.options?.seed ?? null,
      transaction: plan.options?.transaction ?? true,
      rollbackOnError: plan.options?.rollbackOnError ?? true,
      truncateAll: plan.options?.truncateAll ?? false,
      batchSize: plan.options?.batchSize ?? 500,
      previewLimit: plan.options?.previewLimit ?? 50,
      ...optionsOverride,
    };

    const prng = createPrng(options.seed);
    const warnings: string[] = [];

    // 1. Fetch metadata for all tables in plan + related tables
    const tableListRes = await db.listTables();
    const tableNames = (tableListRes.data ?? [])
      .map((t) => t.name)
      .filter((name) => !name.startsWith('sqlite_'));

    const tableInfos = new Map<string, TableInfoData>();
    const allTableData: TableInfoData[] = [];
    for (const name of tableNames) {
      const info = await db.getTableInfo(name);
      if (info.success && info.data) {
        tableInfos.set(name, info.data);
        allTableData.push(info.data);
      }
    }

    // 2. Validate plan
    const validation = await validateGenerationPlan(db, plan, tableInfos);
    for (const issue of validation.issues) {
      if (issue.type === 'warning') warnings.push(`[${issue.table || 'Plan'}] ${issue.message}`);
    }

    // 3. Build schema graph and determine topological execution order
    const graph = buildSchemaGraph(allTableData);

    // If scope is 'chain' or 'ancestors', resolve all connected scope tables into the plan
    if (plan.scope && plan.scope !== 'single' && plan.rootTable) {
      const scopeNodes = resolveScopeTables(graph, plan.rootTable, plan.scope);
      for (const node of scopeNodes) {
        if (!plan.tables[node.name]) {
          const colConfigs = buildColumnConfigs(node.info);
          const columns: Record<string, ColumnPlan> = {};
          colConfigs.forEach((c) => {
            columns[c.name] = c.defaultPlan;
          });
          plan.tables[node.name] = {
            mode: 'generate',
            rows: node.depth === 0 ? 5 : node.depth === 1 ? 15 : 25,
            columns,
            truncate: options.truncateAll,
          };
        }
      }
    }

    // Auto-resolve any missing upstream parent tables that are referenced by foreign keys and have 0 records in DB (only in chain/relational modes)
    if (plan.scope && plan.scope !== 'single') {
      let expanded = true;
      while (expanded) {
        expanded = false;
        const currentPlanTables = Object.keys(plan.tables);
        for (const tName of currentPlanTables) {
          const spec = plan.tables[tName];
          if (spec && spec.mode === 'skip') continue;
          const info = tableInfos.get(tName);
          if (!info) continue;
          for (const fk of info.foreignKeys) {
            if (fk.table && fk.table !== tName && !plan.tables[fk.table] && tableInfos.has(fk.table)) {
              const countRes = await db.getRowCount(fk.table);
              const curCount = countRes.success && typeof countRes.data === 'number' ? countRes.data : 0;
              if (curCount === 0) {
                const pInfo = tableInfos.get(fk.table)!;
                const pColConfigs = buildColumnConfigs(pInfo);
                const pColumns: Record<string, ColumnPlan> = {};
                pColConfigs.forEach((c) => {
                  pColumns[c.name] = c.defaultPlan;
                });
                plan.tables[fk.table] = {
                  mode: 'generate',
                  rows: 10,
                  columns: pColumns,
                  truncate: options.truncateAll,
                };
                expanded = true;
              }
            }
          }
        }
      }
    }

    const planTableNames = Object.keys(plan.tables);
    const planNodes = planTableNames.map((t) => graph.nodes.get(t)).filter((n): n is NonNullable<typeof n> => n != null);
    const { sorted } = sortTopologically(planNodes.length ? planNodes : Array.from(graph.nodes.values()));
    const executionOrder = sorted.map((s) => s.name).filter((name) => plan.tables[name] !== undefined);

    const relationalPool = new Map<string, unknown[]>();
    const tableResults: ErChainResult['tableResults'] = {};
    let totalRows = 0;

    // 4. Generate rows table by table in topological order
    for (const tableName of executionOrder) {
      const spec: TableGenerationSpec = plan.tables[tableName];
      const info = tableInfos.get(tableName);
      if (!info) continue;

      let mode = spec.mode || 'generate';
      if (mode === 'generate_if_empty') {
        try {
          const countRes = await db.getRowCount(tableName);
          const curCount = countRes.success && typeof countRes.data === 'number' ? countRes.data : 0;
          mode = curCount === 0 ? 'generate' : 'use_existing';
        } catch {
          mode = 'generate';
        }
      }

      if (mode === 'skip') {
        tableResults[tableName] = { count: 0, rows: [], previewRows: [], warnings: [] };
        continue;
      }

      const pkColName = info.primaryKey[0] || info.columns[0]?.name || 'id';

      if (mode === 'use_existing') {
        for (const col of info.columns) {
          const pool = await sampleColumnValues(db, tableName, col.name, 1000);
          if (pool.length) relationalPool.set(`${tableName}.${col.name}`, pool);
        }
        tableResults[tableName] = { count: 0, rows: [], previewRows: [], warnings: [] };
        continue;
      }

      let requestedCount = Math.max(1, Math.min(MAX_SEED_ROWS, spec.rows ?? 10));
      const checkInfo = parseChecks(info.sql ?? null);
      const fkByColumn = new Map<string, ForeignKeyInfo>(info.foreignKeys.map((fk) => [fk.from, fk]));

      // Identify single and composite unique constraints
      const uniqueCols = new Set<string>();
      const compositeUniques: string[][] = [];

      for (const col of info.columns) {
        if (spec.columns[col.name]?.unique) uniqueCols.add(col.name);
      }
      for (const ix of info.indexes ?? []) {
        if (ix.unique) {
          if (ix.columns.length === 1 && ix.columns[0]) uniqueCols.add(ix.columns[0]);
          else if (ix.columns.length > 1) compositeUniques.push(ix.columns);
        }
      }
      if (info.primaryKey.length > 1 && !compositeUniques.some((cu) => cu.join(',') === info.primaryKey.join(','))) {
        compositeUniques.push(info.primaryKey);
      }
      if (info.sql) {
        const uqRe = /UNIQUE\s*\(\s*([^)]+)\s*\)/gi;
        let uqM: RegExpExecArray | null;
        while ((uqM = uqRe.exec(info.sql))) {
          const rawCols = uqM[1].split(',').map((s) => s.trim().replace(/[`"\[\]]/g, ''));
          if (rawCols.length === 1 && rawCols[0]) uniqueCols.add(rawCols[0]);
          else if (rawCols.length > 1 && !compositeUniques.some((cu) => cu.join(',') === rawCols.join(','))) {
            compositeUniques.push(rawCols);
          }
        }
      }

      // Prepare foreign key and sample pools
      const fkPools = new Map<string, unknown[]>();
      const samplePools = new Map<string, unknown[]>();
      const fkOmit = new Set<string>();

      for (const col of info.columns) {
        const p = spec.columns[col.name] || { strategy: 'skip' };

        if (p.strategy === 'sampleExisting') {
          const refT = p.refTable || tableName;
          const refC = p.refColumn || col.name;
          samplePools.set(col.name, await sampleColumnValues(db, refT, refC, 1000));
        }

        if (p.strategy === 'fk' || p.strategy === 'sequentialFk') {
          const fk = fkByColumn.get(col.name);
          const refTable = p.refTable || fk?.table || '';
          let refCol = p.refColumn || fk?.to || (refTable ? tableInfos.get(refTable)?.primaryKey[0] : 'id') || 'id';

          const poolKey = `${refTable}.${refCol}`;
          let pool = relationalPool.get(poolKey) ?? [];

          if (!pool.length) {
            for (const [k, v] of relationalPool.entries()) {
              if (k.toLowerCase() === poolKey.toLowerCase() && v.length) {
                pool = v;
                break;
              }
            }
          }
          if (!pool.length) {
            for (const [k, v] of relationalPool.entries()) {
              const [tName] = k.split('.');
              if (tName && tName.toLowerCase() === refTable.toLowerCase() && v.length) {
                pool = v;
                break;
              }
            }
          }

          if (!pool.length && refTable) {
            pool = await sampleColumnValues(db, refTable, refCol, 1000);
          }

          if (!pool.length) {
            const isSelfFk = fkByColumn.get(col.name)?.table === tableName;
            if (isSelfFk) {
              // Self-referencing foreign key (e.g. categories.parent_id -> categories.id or employees.manager_id -> employees.id)
              // Root rows start with NULL, and child rows dynamically reference earlier generated IDs during row generation.
              // No warning needed for self-referencing hierarchy.
            } else if (col.notnull || (col.pk ?? 0) > 0) {
              if (col.dflt_value != null) {
                fkOmit.add(col.name);
              } else {
                pool = [1];
                warnings.push(
                  `Table "${tableName}" Column "${col.name}" is a NOT NULL foreign key to "${refTable}". Parent table had no records; fallback ID 1 was used.`,
                );
              }
            } else {
              warnings.push(`Table "${tableName}" Column "${col.name}": "${refTable}" has no rows; NULL will be used.`);
            }
          }

          fkPools.set(col.name, pool);
        }
      }

      // Preload existing unique values from DB if not truncating
      const uniqueSeen = new Map<string, Set<string>>();
      const compositeSeen = new Map<string, Set<string>>();
      for (const cu of compositeUniques) compositeSeen.set(cu.join('::'), new Set());

      if (!spec.truncate && !options.truncateAll) {
        for (const col of uniqueCols) {
          try {
            const existing = await sampleColumnValues(db, tableName, col, 10000);
            uniqueSeen.set(col, new Set(existing.map(stringifyKey)));
          } catch {}
        }
      }

      let pkStartOffset = 0;
      for (const col of info.columns) {
        if (col.pk && (col.type || '').toUpperCase().includes('INT')) {
          try {
            const maxRes = await db.all(`SELECT MAX(${quoteIdentifier(col.name)}) AS mx FROM ${quoteIdentifier(tableName)}`);
            const maxVal = ((maxRes.data ?? []) as { mx?: unknown }[])[0]?.mx;
            if (typeof maxVal === 'number' && Number.isFinite(maxVal)) pkStartOffset = maxVal;
          } catch {}
        }
      }

      const allColNames = info.columns.map((c) => c.name);
      const { orderedColumns } = orderColumnDependencies(allColNames, spec.columns);
      const colMap = new Map(info.columns.map((c) => [c.name, c]));

      const isUniqueCol = (name: string) => {
        const norm = name.toLowerCase().replace(/[`"\[\]]/g, '');
        for (const u of uniqueCols) {
          if (u.toLowerCase().replace(/[`"\[\]]/g, '') === norm) return true;
        }
        return false;
      };

      for (const colName of orderedColumns) {
        const p = spec.columns[colName];
        const col = colMap.get(colName);
        if (col && p && p.strategy === 'fk' && ((info.primaryKey.length === 1 && col.pk) || isUniqueCol(col.name))) {
          const pool = fkPools.get(col.name);
          if (pool && pool.length > 0 && pool.length < requestedCount) requestedCount = pool.length;
        }
      }

      if (compositeUniques.length > 0) {
        for (const cu of compositeUniques) {
          const isAllFk = cu.every((cName) => {
            const p = spec.columns[cName];
            return p && (p.strategy === 'fk' || p.strategy === 'sequentialFk');
          });
          if (isAllFk) {
            const maxCombos = cu.reduce((acc, cName) => acc * Math.max(1, (fkPools.get(cName) ?? []).length), 1);
            if (maxCombos > 0 && maxCombos < requestedCount) requestedCount = maxCombos;
          }
        }
      }

      const rows: WhereClause[][] = [];
      const previewRows: Record<string, unknown>[] = [];
      const tableGeneratedPkVals: Record<string, unknown[]> = {};

      for (let i = 0; i < requestedCount; i++) {
        let fields: WhereClause[] = [];
        let previewRow: Record<string, unknown> = {};
        let rowValid = false;
        let attempt = 0;

        while (!rowValid && attempt < 35) {
          fields = [];
          previewRow = {};
          const rowValues: Record<string, unknown> = {};

          for (const colName of orderedColumns) {
            const col = colMap.get(colName)!;
            const p = spec.columns[colName] || { strategy: 'skip' };

            if ((p.strategy === 'fk' || p.strategy === 'sequentialFk') && fkOmit.has(col.name)) {
              previewRow[col.name] = null;
              rowValues[col.name] = null;
              continue;
            }

            const isSelfFk = fkByColumn.get(col.name)?.table === tableName;
            let pool = fkPools.get(col.name);
            if (isSelfFk) {
              const selfIds = tableGeneratedPkVals[fkByColumn.get(col.name)?.to || pkColName] ?? [];
              pool = (i === 0 || selfIds.length === 0 || (prng.chance(35) && !col.notnull)) ? [] : selfIds;
            }

            let v: unknown = p.strategy === 'template' && p.template
              ? evaluateTemplate(p.template, rowValues, prng, i + attempt * 50)
              : generateColumnValue(col, p, prng, i + attempt * 50, rowValues, pool, samplePools.get(col.name));

            if (v === SKIP && col.pk) {
              const isInt = (col.type || '').toUpperCase().includes('INT') || (col.type || '').toUpperCase().includes('SERIAL') || col.type === '' || col.type === 'NUMBER';
              if (isInt) v = pkStartOffset + i + 1;
            }

            if ((col.notnull || (col.pk ?? 0) > 0) && col.dflt_value == null && (v == null || v === SKIP)) {
              if (p.strategy === 'fk' || p.strategy === 'sequentialFk') {
                v = pool && pool.length > 0 ? pool[0] : 1;
              } else if (col.pk) {
                v = pkStartOffset + i + 1;
              } else {
                const fbPlan = GeneratorRegistry.get('words') ? { strategy: 'words' as const, minLen: 1, maxLen: 3 } : { strategy: 'skip' as const };
                v = generateColumnValue(col, fbPlan, prng, i + attempt * 50, rowValues);
                if (v == null || v === SKIP) {
                  v = (col.type || '').toUpperCase().includes('INT') ? i + 1 : `val_${i + 1}`;
                }
              }
            }

            if (v === SKIP) {
              previewRow[col.name] = '(default)';
              rowValues[col.name] = null;
              continue;
            }

            if (isUniqueCol(col.name)) {
              const seen = uniqueSeen.get(col.name) ?? new Set<string>();
              if (p.strategy === 'fk' || p.strategy === 'sequentialFk') {
                const unused = (pool ?? []).filter((x) => !seen.has(stringifyKey(x)));
                if (unused.length > 0) {
                  v = unused[0];
                } else {
                  rowValid = false;
                  break;
                }
              } else {
                let singleAtt = 0;
                while (seen.has(stringifyKey(v)) && singleAtt < 50) {
                  v = generateColumnValue(col, p, prng, i + attempt * 50 + singleAtt * 100, rowValues, pool, samplePools.get(col.name));
                  singleAtt++;
                }
                if (seen.has(stringifyKey(v))) {
                  rowValid = false;
                  break;
                }
              }
            }

            v = fitStringLength(v, findInMap(checkInfo.columnLength, col.name));
            fields.push({ column: col.name, value: v });
            previewRow[col.name] = v;
            rowValues[col.name] = v;
          }

          applyOrdering(fields, checkInfo.ordering);
          for (const f of fields) previewRow[f.column] = f.value;

          let compositeCollision = false;
          if (compositeUniques.length > 0) {
            const fieldMap = new Map(fields.map((f) => [f.column, f.value]));
            for (const cu of compositeUniques) {
              const key = cu.join('::');
              const compositeVal = cu.map((cName) => stringifyKey(fieldMap.get(cName))).join('|');
              const seenSet = compositeSeen.get(key) ?? new Set<string>();
              if (seenSet.has(compositeVal)) {
                compositeCollision = true;
                break;
              }
            }
          }

          if (!compositeCollision && fields.length > 0) {
            rowValid = true;
            if (compositeUniques.length > 0) {
              const fieldMap = new Map(fields.map((f) => [f.column, f.value]));
              for (const cu of compositeUniques) {
                const key = cu.join('::');
                const compositeVal = cu.map((cName) => stringifyKey(fieldMap.get(cName))).join('|');
                const seenSet = compositeSeen.get(key) ?? new Set<string>();
                seenSet.add(compositeVal);
                compositeSeen.set(key, seenSet);
              }
            }
          }

          attempt++;
        }

        if (!rowValid) break;

        for (const f of fields) {
          if (isUniqueCol(f.column)) {
            const seen = uniqueSeen.get(f.column) ?? new Set<string>();
            seen.add(stringifyKey(f.value));
            uniqueSeen.set(f.column, seen);
          }

          const poolKey = `${tableName}.${f.column}`;
          const cur = relationalPool.get(poolKey) ?? [];
          cur.push(f.value);
          relationalPool.set(poolKey, cur);

          const selfCur = tableGeneratedPkVals[f.column] ?? [];
          selfCur.push(f.value);
          tableGeneratedPkVals[f.column] = selfCur;
        }

        rows.push(fields);
        if (previewRows.length < (options.previewLimit ?? 50)) {
          previewRows.push(previewRow);
        }
      }

      tableResults[tableName] = {
        count: rows.length,
        rows,
        previewRows,
        warnings: [],
      };
      totalRows += rows.length;
    }

    const sql = buildChainInsertSql(executionOrder, tableResults);

    return {
      rootTable: plan.rootTable,
      scope: plan.scope,
      executionOrder,
      tableResults,
      totalRows,
      sql,
      warnings,
      validation,
    };
  }
}

/**
 * Render generated rows as a sequence of SQL INSERT statements.
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

/**
 * Assemble multi-table SQL script with transaction headers.
 */
export function buildChainInsertSql(
  executionOrder: string[],
  tableResults: ErChainResult['tableResults'],
): string {
  const sqlParts: string[] = [
    '-- AdminDB Relational Seed Script',
    `-- Order of execution: ${executionOrder.join(' -> ')}`,
    'BEGIN TRANSACTION;\n',
  ];

  for (const table of executionOrder) {
    const res = tableResults[table];
    if (!res || !res.rows.length) continue;

    sqlParts.push('-- --------------------------------------------------------');
    sqlParts.push(`-- Table: ${table} (${res.rows.length} rows)`);
    sqlParts.push('-- --------------------------------------------------------');

    for (const fields of res.rows) {
      if (!fields.length) continue;
      const cols = fields.map((f) => quoteIdentifier(f.column)).join(', ');
      const vals = fields.map((f) => sqlValue(f.value)).join(', ');
      sqlParts.push(`INSERT INTO ${quoteIdentifier(table)} (${cols}) VALUES (${vals});`);
    }
    sqlParts.push('');
  }

  sqlParts.push('COMMIT;');
  return sqlParts.join('\n');
}

/**
 * Backward-compatible single-table row generation adapter.
 */
export async function generateRows(
  db: IDatabase,
  info: TableInfoData,
  configs: ColumnGeneratorConfig[],
  count: number,
  plan: Record<string, ColumnPlan> = {},
  truncate = false,
): Promise<GenerateResult> {
  const tableSpec: TableGenerationSpec = {
    mode: 'generate',
    rows: count,
    columns: {},
    truncate,
  };

  for (const col of info.columns) {
    const raw = plan[col.name];
    const cfg = configs.find((c) => c.name === col.name);
    tableSpec.columns[col.name] = raw && raw.strategy ? raw : (cfg?.defaultPlan ?? { strategy: 'skip' });
  }

  const generationPlan: GenerationPlan = {
    rootTable: info.table,
    scope: 'single',
    tables: { [info.table]: tableSpec },
    options: { truncateAll: truncate },
  };

  const res = await SeedEngine.executePlan(db, generationPlan);
  const tableRes = res.tableResults[info.table] || { rows: [], previewRows: [], warnings: [] };

  return {
    rows: tableRes.rows,
    previewRows: tableRes.previewRows,
    warnings: [...res.warnings, ...tableRes.warnings],
  };
}
