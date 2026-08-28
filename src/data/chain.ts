import type { ColumnInfo, ForeignKeyInfo, IDatabase, TableInfoData, WhereClause } from '../db/index';
import { quoteIdentifier, sqlValue } from '../sql/generator';
import {
  SKIP,
  type ColumnGeneratorConfig,
  type ColumnPlan,
  type ErChainConfig,
  type ErChainResult,
  type ErChainScope,
  type ErChainTableNode,
} from './types';
import { buildColumnConfigs, findInMap, parseChecks, type OrderingConstraint } from './detector';
import { fallbackPlanFor, generateOne } from './strategies';

export interface ErGraphNode {
  name: string;
  info: TableInfoData;
  columns: ColumnGeneratorConfig[];
  parents: { table: string; from: string; to: string; notnull: boolean }[];
  children: { table: string; from: string; to: string; notnull: boolean }[];
  hasSelfRef: boolean;
  depth: number;
}

/** Distinct non-null values of a foreign key's referenced column from DB. */
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
 * Build an in-memory ER dependency graph for all tables.
 */
export function buildErGraph(tables: TableInfoData[]): Map<string, ErGraphNode> {
  const graph = new Map<string, ErGraphNode>();

  for (const info of tables) {
    const columns = buildColumnConfigs(info);
    const colMap = new Map(info.columns.map((c) => [c.name, c]));
    const parents: { table: string; from: string; to: string; notnull: boolean }[] = [];
    let hasSelfRef = false;

    for (const fk of info.foreignKeys) {
      const toCol = fk.to || (tables.find((t) => t.table === fk.table)?.primaryKey[0] ?? 'id');
      if (fk.table === info.table) {
        hasSelfRef = true;
      }
      const c = colMap.get(fk.from);
      const notnull = Boolean(c?.notnull || (c?.pk ?? 0) > 0);
      parents.push({ table: fk.table, from: fk.from, to: toCol, notnull });
    }

    graph.set(info.table, {
      name: info.table,
      info,
      columns,
      parents,
      children: [],
      hasSelfRef,
      depth: 0,
    });
  }

  // Populate children (reverse FKs)
  for (const node of graph.values()) {
    for (const p of node.parents) {
      if (p.table !== node.name && graph.has(p.table)) {
        graph.get(p.table)!.children.push({ table: node.name, from: p.from, to: p.to, notnull: p.notnull });
      }
    }
  }

  return graph;
}

/**
 * Resolve the subset of tables connected to `rootTable` based on the specified scope.
 */
export function resolveErChain(
  graph: Map<string, ErGraphNode>,
  rootTable: string,
  scope: ErChainScope = 'chain',
): ErGraphNode[] {
  if (scope === 'all') {
    return Array.from(graph.values());
  }

  const root = graph.get(rootTable);
  if (!root) return [];
  if (scope === 'single') {
    return [root];
  }

  const selected = new Set<string>();

  if (scope === 'ancestors') {
    // Only upstream parent tables (recursively)
    const queue = [rootTable];
    selected.add(rootTable);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = graph.get(current);
      if (!node) continue;
      for (const p of node.parents) {
        if (p.table !== current && graph.has(p.table) && !selected.has(p.table)) {
          selected.add(p.table);
          queue.push(p.table);
        }
      }
    }
  } else if (scope === 'descendants') {
    // Only downstream child tables (recursively)
    const queue = [rootTable];
    selected.add(rootTable);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = graph.get(current);
      if (!node) continue;
      for (const c of node.children) {
        if (c.table !== current && graph.has(c.table) && !selected.has(c.table)) {
          selected.add(c.table);
          queue.push(c.table);
        }
      }
    }
  } else {
    // scope === 'chain' (Full connected component: parents, children, and siblings)
    const queue = [rootTable];
    selected.add(rootTable);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = graph.get(current);
      if (!node) continue;

      for (const p of node.parents) {
        if (p.table !== current && graph.has(p.table) && !selected.has(p.table)) {
          selected.add(p.table);
          queue.push(p.table);
        }
      }
      for (const c of node.children) {
        if (c.table !== current && graph.has(c.table) && !selected.has(c.table)) {
          selected.add(c.table);
          queue.push(c.table);
        }
      }
    }
  }

  return Array.from(selected).map((name) => graph.get(name)!);
}

/**
 * Topologically sort nodes so that referenced parents come before dependent children.
 * Differentiates required (NOT NULL) foreign keys from optional (nullable) ones to cleanly resolve cycles.
 */
export function topologicalSort(nodes: ErGraphNode[]): {
  sorted: ErGraphNode[];
  cycleDetected: boolean;
  cycleTables: string[];
} {
  const activeNames = new Set(nodes.map((n) => n.name));
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));

  // Track parent dependencies
  const totalInDegree = new Map<string, number>();
  const hardInDegree = new Map<string, number>();
  const allForwardEdges = new Map<string, Set<string>>(); // parent -> set of dependent children
  const hardForwardEdges = new Map<string, Set<string>>(); // parent -> set of hard dependent children

  for (const n of nodes) {
    totalInDegree.set(n.name, 0);
    hardInDegree.set(n.name, 0);
    allForwardEdges.set(n.name, new Set());
    hardForwardEdges.set(n.name, new Set());
  }

  for (const n of nodes) {
    for (const p of n.parents) {
      if (p.table !== n.name && activeNames.has(p.table)) {
        if (!allForwardEdges.get(p.table)!.has(n.name)) {
          allForwardEdges.get(p.table)!.add(n.name);
          totalInDegree.set(n.name, (totalInDegree.get(n.name) ?? 0) + 1);
        }
        if (p.notnull) {
          if (!hardForwardEdges.get(p.table)!.has(n.name)) {
            hardForwardEdges.get(p.table)!.add(n.name);
            hardInDegree.set(n.name, (hardInDegree.get(n.name) ?? 0) + 1);
          }
        }
      }
    }
  }

  // Kahn's algorithm starting with totalInDegree 0 (no unresolved parent dependencies)
  const queue: string[] = [];
  const visited = new Set<string>();

  for (const [name, deg] of totalInDegree.entries()) {
    if (deg === 0) {
      queue.push(name);
      visited.add(name);
    }
  }

  const sortedNames: string[] = [];
  const depths = new Map<string, number>();
  for (const name of queue) depths.set(name, 0);

  let cycleDetected = false;
  const cycleTables: string[] = [];

  while (visited.size < nodes.length) {
    while (queue.length > 0) {
      const curr = queue.shift()!;
      sortedNames.push(curr);
      const currDepth = depths.get(curr) ?? 0;

      for (const child of allForwardEdges.get(curr) ?? []) {
        const newTotalDeg = (totalInDegree.get(child) ?? 1) - 1;
        totalInDegree.set(child, newTotalDeg);
        if (hardForwardEdges.get(curr)?.has(child)) {
          const newHardDeg = (hardInDegree.get(child) ?? 1) - 1;
          hardInDegree.set(child, newHardDeg);
        }
        depths.set(child, Math.max(depths.get(child) ?? 0, currDepth + 1));
        if (newTotalDeg === 0 && !visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }

    if (visited.size < nodes.length) {
      // Unvisited nodes remaining (circular dependency)
      cycleDetected = true;

      // Find the unvisited node with the lowest remaining hard in-degree
      let bestCandidate = '';
      let lowestHardDeg = Infinity;
      let lowestTotalDeg = Infinity;

      for (const n of nodes) {
        if (!visited.has(n.name)) {
          const hDeg = hardInDegree.get(n.name) ?? 0;
          const tDeg = totalInDegree.get(n.name) ?? 0;
          if (hDeg < lowestHardDeg || (hDeg === lowestHardDeg && tDeg < lowestTotalDeg)) {
            lowestHardDeg = hDeg;
            lowestTotalDeg = tDeg;
            bestCandidate = n.name;
          }
        }
      }

      if (bestCandidate) {
        cycleTables.push(bestCandidate);
        visited.add(bestCandidate);
        depths.set(bestCandidate, (depths.get(bestCandidate) ?? 1) + 1);
        queue.push(bestCandidate);
      } else {
        break;
      }
    }
  }

  const sorted = sortedNames.map((name) => {
    const node = { ...nodeMap.get(name)! };
    node.depth = depths.get(name) ?? 0;
    return node;
  });

  return { sorted, cycleDetected, cycleTables };
}


/**
 * Build the full ER chain configuration payload for UI & API.
 */
export async function getErChainConfig(
  db: IDatabase,
  rootTable: string,
  scope: ErChainScope = 'chain',
): Promise<ErChainConfig> {
  const tableListRes = await db.listTables();
  const tableNames = (tableListRes.data ?? [])
    .map((t) => t.name)
    .filter((name) => !name.startsWith('sqlite_') && name !== '_saved_queries');

  const tables: TableInfoData[] = [];
  for (const name of tableNames) {
    const info = await db.getTableInfo(name);
    if (info.success && info.data) tables.push(info.data);
  }

  const graph = buildErGraph(tables);
  const chainNodes = resolveErChain(graph, rootTable, scope);
  const { sorted, cycleDetected, cycleTables } = topologicalSort(chainNodes);

  // Compute row counts for each table
  const tableNodes: ErChainTableNode[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    let rowCount = 0;
    try {
      const countRes = await db.getRowCount(node.name);
      if (countRes.success && typeof countRes.data === 'number') rowCount = countRes.data;
    } catch {
      /* ignore */
    }

    // Heuristic suggested count: root tables ~5, level 1 ~15, level 2 ~30
    let suggestedCount = 10;
    if (node.depth === 0) suggestedCount = 5;
    else if (node.depth === 1) suggestedCount = 15;
    else suggestedCount = 25;

    tableNodes.push({
      name: node.name,
      order: i + 1,
      depth: node.depth,
      parents: node.parents.filter((p) => sorted.some((s) => s.name === p.table)),
      children: node.children.filter((c) => sorted.some((s) => s.name === c.table)),
      columns: node.columns,
      suggestedCount,
      rowCount,
      isRoot: node.name === rootTable,
      hasSelfRef: node.hasSelfRef,
    });
  }

  return {
    rootTable,
    scope,
    tables: tableNodes,
    cycleDetected,
    cycleTables,
    maxTotalRows: 10000,
  };
}

/**
 * Generate rows across an entire ER chain in topological dependency order.
 * Propagates generated parent Primary Keys into child Foreign Keys in memory.
 */
export async function generateChainRows(
  db: IDatabase,
  chainConfig: ErChainConfig,
  customPlans: Record<string, Record<string, ColumnPlan>> = {},
  customCounts: Record<string, number> = {},
  truncate = false
): Promise<ErChainResult> {
  const warnings: string[] = [];
  const executionOrder = chainConfig.tables.map((t) => t.name);

  // In-flight pool of primary key / referenced column values generated per table
  // Key: "tableName.columnName" -> array of generated values
  const relationalPool = new Map<string, unknown[]>();

  const tableResults: ErChainResult['tableResults'] = {};
  let totalRows = 0;

  for (const tableNode of chainConfig.tables) {
    const tableName = tableNode.name;
    const tableInfoRes = await db.getTableInfo(tableName);
    if (!tableInfoRes.success || !tableInfoRes.data) {
      warnings.push(`Could not load table metadata for "${tableName}".`);
      continue;
    }
    const info = tableInfoRes.data;
    let count = Math.max(1, Math.min(2000, customCounts[tableName] ?? tableNode.suggestedCount ?? 10));
    const tablePlan = customPlans[tableName] ?? {};
    const configs = tableNode.columns;

    const fkByColumn = new Map<string, ForeignKeyInfo>();
    for (const fk of info.foreignKeys) fkByColumn.set(fk.from, fk);

    const uniqueCols = new Set<string>();
    for (const cfg of configs) if (cfg.unique) uniqueCols.add(cfg.name);

    const compositeUniques: string[][] = [];
    for (const ix of info.indexes ?? []) {
      if (ix.unique && ix.columns.length === 1 && ix.columns[0]) uniqueCols.add(ix.columns[0]);
      if (ix.unique && ix.columns.length > 1) compositeUniques.push(ix.columns);
    }
    if (info.sql) {
      const uqRe = /UNIQUE\s*\(\s*([^)]+)\s*\)/gi;
      let uqM: RegExpExecArray | null;
      while ((uqM = uqRe.exec(info.sql))) {
        const rawCols = uqM[1].split(',').map((s) => s.trim().replace(/[`"\[\]]/g, ''));
        if (rawCols.length === 1 && rawCols[0]) {
          uniqueCols.add(rawCols[0]);
        } else if (rawCols.length > 1 && !compositeUniques.some((cu) => cu.join(',') === rawCols.join(','))) {
          compositeUniques.push(rawCols);
        }
      }
    }
    if (info.primaryKey && info.primaryKey.length > 1) {
      if (!compositeUniques.some((cu) => cu.join(',') === info.primaryKey.join(','))) {
        compositeUniques.push(info.primaryKey);
      }
    }
    const compositeSeen = new Map<string, Set<string>>();
    for (const cu of compositeUniques) {
      compositeSeen.set(cu.join('::'), new Set());
    }

    const checkInfo = parseChecks(info.sql ?? null);
    const prepared: { col: ColumnInfo; plan: ColumnPlan }[] = [];
    const fkPools = new Map<string, unknown[]>();
    const fkOmit = new Set<string>();

    for (const col of info.columns) {
      const cfg = configs.find((c) => c.name === col.name);
      const raw = tablePlan[col.name];
      const p = raw && raw.strategy ? raw : (cfg?.defaultPlan ?? { strategy: 'skip' });

      if (p.strategy === 'list' && (!p.values || !p.values.length)) {
        const allowed = findInMap(checkInfo.columnAllowed, col.name);
        if (allowed && allowed.length) p.values = [...allowed];
      }

      if (p.strategy === 'fk') {
        const fk = fkByColumn.get(col.name);
        const refTable = fk?.table ?? '';
        let refCol = fk?.to;
        if (!refCol) {
          const refNode = chainConfig.tables.find((t) => t.name.toLowerCase() === refTable.toLowerCase());
          if (refNode) {
            const pkCol = refNode.columns.find((c) => c.pk);
            refCol = pkCol?.name;
          }
        }
        if (!refCol) {
          refCol = 'id';
        }

        const poolKey = `${refTable}.${refCol}`;

        // 1. Check exact key in relationalPool
        let pool = relationalPool.get(poolKey) ?? [];

        // 2. Case-insensitive key match
        if (!pool.length) {
          for (const [k, v] of relationalPool.entries()) {
            if (k.toLowerCase() === poolKey.toLowerCase() && v.length) {
              pool = v;
              break;
            }
          }
        }

        // 3. Fallback: match any column in relationalPool from refTable
        if (!pool.length) {
          for (const [k, v] of relationalPool.entries()) {
            const [tName] = k.split('.');
            if (tName && tName.toLowerCase() === refTable.toLowerCase() && v.length) {
              pool = v;
              break;
            }
          }
        }

        // 4. Sample database if relationalPool is empty
        if (!pool.length) {
          pool = await sampleFkValues(db, fk ?? null);
        }

        fkPools.set(col.name, pool);

        if (!pool.length) {
          if (col.notnull || (col.pk ?? 0) > 0) {
            // If parent table has no pool rows yet, provide fallback ID (1) to satisfy NOT NULL constraints
            pool = [1];
            fkPools.set(col.name, pool);
            warnings.push(
              `Table "${tableName}" Column "${col.name}" is a NOT NULL foreign key to "${refTable}". Fallback ID 1 was used.`,
            );
          } else {
            warnings.push(`Table "${tableName}" Column "${col.name}": "${refTable}" has no rows; NULL will be used.`);
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
          const existing = await db.all(`SELECT ${quoteIdentifier(col)} AS v FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(col)} IS NOT NULL LIMIT 10000`);
          const seen = new Set<string>();
          for (const r of (existing.data ?? []) as {v?: unknown}[]) {
            if (r.v != null) seen.add(stringifyKey(r.v));
          }
          uniqueSeen.set(col, seen);
        } catch { /* ignore */ }
      }
    }

    const tableGeneratedPkVals: Record<string, unknown[]> = {};

    let pkStartOffset = 0;
    for (const col of info.columns) {
      if (col.pk && (col.type || '').toUpperCase().includes('INT')) {
        try {
          const maxRes = await db.all(`SELECT MAX(${quoteIdentifier(col.name)}) AS mx FROM ${quoteIdentifier(tableName)}`);
          const maxVal = ((maxRes.data ?? []) as { mx?: unknown }[])[0]?.mx;
          if (typeof maxVal === 'number' && Number.isFinite(maxVal)) pkStartOffset = maxVal;
        } catch {
          /* ignore */
        }
      }
    }

    const isUniqueCol = (name: string): boolean => {
      const norm = name.toLowerCase().replace(/[`"\[\]]/g, '');
      for (const u of uniqueCols) {
        if (u.toLowerCase().replace(/[`"\[\]]/g, '') === norm) return true;
      }
      return false;
    };

    // 1. If table has a single-column primary key or unique 1-to-1 foreign key, cap row count to available parent rows
    for (const { col, plan: p } of prepared) {
      if (p.strategy === 'fk' && ((info.primaryKey.length === 1 && col.pk) || isUniqueCol(col.name))) {
        const pool = fkPools.get(col.name);
        if (pool && pool.length > 0 && pool.length < count) {
          count = pool.length;
        }
      }
    }

    // 2. If table has composite unique foreign keys (e.g. order_id, product_id in order_items), cap count to available combinations
    if (compositeUniques.length > 0) {
      for (const cu of compositeUniques) {
        const isAllFk = cu.every((colName) => prepared.some((p) => (p.col.name === colName || p.col.name.replace(/[`"\[\]]/g, '') === colName.replace(/[`"\[\]]/g, '')) && p.plan.strategy === 'fk'));
        if (isAllFk) {
          const maxCombos = cu.reduce((acc, colName) => {
            const pool = fkPools.get(colName) ?? [];
            return acc * Math.max(1, pool.length);
          }, 1);
          if (maxCombos > 0 && maxCombos < count) {
            count = maxCombos;
          }
        }
      }
    }

    for (let i = 0; i < count; i++) {
      let fields: WhereClause[] = [];
      let previewRow: Record<string, unknown> = {};
      let rowValid = false;
      let attempt = 0;

      while (!rowValid && attempt < 30) {
        fields = [];
        previewRow = {};

        for (const { col, plan: p } of prepared) {
          if (p.strategy === 'fk' && fkOmit.has(col.name)) {
            previewRow[col.name] = null;
            continue;
          }

          // Special handling for self-referencing hierarchy columns (e.g. parent_id in categories)
          const isSelfFk = fkByColumn.get(col.name)?.table === tableName;
          let pool = fkPools.get(col.name);
          if (isSelfFk) {
            // If first row or with 35% chance, make it a root node (NULL)
            const existingSelfIds = tableGeneratedPkVals[fkByColumn.get(col.name)?.to || info.primaryKey[0] || 'id'] ?? [];
            if (i === 0 || existingSelfIds.length === 0 || (Math.random() < 0.35 && !col.notnull)) {
              pool = [];
            } else {
              pool = existingSelfIds;
            }
          }

          let v = generateOne(col, p, pool, i + attempt * 50);

          // If sequence/int PK and skipped, assign explicit sequential ID for deterministic FK referencing
          if (v === SKIP && col.pk) {
            const isInt = (col.type || '').toUpperCase().includes('INT') || (col.type || '').toUpperCase().includes('SERIAL') || col.type === '' || col.type === 'NUMBER';
            if (isInt) {
              v = pkStartOffset + i + 1;
            }
          }

          // If NOT NULL / PK column ended up with null / SKIP, supply a deterministic fallback value
          if ((col.notnull || (col.pk ?? 0) > 0) && col.dflt_value == null && (v == null || v === SKIP)) {
            if (p.strategy === 'fk') {
              v = (pool && pool.length > 0) ? pool[0] : 1;
            } else if (col.pk) {
              v = pkStartOffset + i + 1;
            } else {
              const fbPlan = fallbackPlanFor(col);
              v = generateOne(col, fbPlan, pool, i + attempt * 50);
              if (v == null || v === SKIP) {
                v = (col.type || '').toUpperCase().includes('INT') ? (i + 1) : `val_${i + 1}`;
              }
            }
          }

          if (v === SKIP) {
            previewRow[col.name] = '(default)';
            continue;
          }

          if (isUniqueCol(col.name)) {
            const seen = uniqueSeen.get(col.name) ?? new Set<string>();
            if (p.strategy === 'fk') {
              const unused = (pool ?? []).filter((x) => !seen.has(stringifyKey(x)));
              if (unused.length > 0) {
                v = unused[0];
              } else {
                rowValid = false;
                break;
              }
            } else {
              let singleAtt = 0;
              while (seen.has(stringifyKey(v)) && singleAtt < 100) {
                v = generateOne(col, p, pool, i + attempt * 50 + singleAtt * 100);
                singleAtt += 1;
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
        }

        applyOrdering(fields, checkInfo.ordering);
        for (const f of fields) {
          previewRow[f.column] = f.value;
        }

        // Validate composite uniqueness
        let compositeCollision = false;
        if (compositeUniques.length > 0) {
          const fieldMap = new Map(fields.map((f) => [f.column, f.value]));
          for (const cu of compositeUniques) {
            const key = cu.join('::');
            const compositeVal = cu.map((colName) => stringifyKey(fieldMap.get(colName))).join('|');
            const seenSet = compositeSeen.get(key) ?? new Set<string>();
            if (seenSet.has(compositeVal)) {
              compositeCollision = true;
              break;
            }
          }
        }

        if (!compositeCollision) {
          rowValid = true;
          // Commit composite seen keys
          if (compositeUniques.length > 0) {
            const fieldMap = new Map(fields.map((f) => [f.column, f.value]));
            for (const cu of compositeUniques) {
              const key = cu.join('::');
              const compositeVal = cu.map((colName) => stringifyKey(fieldMap.get(colName))).join('|');
              const seenSet = compositeSeen.get(key) ?? new Set<string>();
              seenSet.add(compositeVal);
              compositeSeen.set(key, seenSet);
            }
          }
        }

        attempt += 1;
      }

      if (!rowValid) {
        // All unique combinations exhausted for this table; stop generating rows
        break;
      }

      // Record single column unique seen and relational pool for all generated columns
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
      if (previewRows.length < 50) {
        previewRows.push(previewRow);
      }
    }

    tableResults[tableName] = {
      count: rows.length,
      rows,
      previewRows,
      warnings,
    };
    totalRows += rows.length;
  }

  // Build combined multi-table SQL
  const sql = buildChainInsertSql(executionOrder, tableResults);

  return {
    rootTable: chainConfig.rootTable,
    scope: chainConfig.scope,
    executionOrder,
    tableResults,
    totalRows,
    sql,
    warnings,
  };
}

/**
 * Assemble multi-table SQL with headers and transaction wrappers.
 */
export function buildChainInsertSql(
  executionOrder: string[],
  tableResults: ErChainResult['tableResults'],
): string {
  const sqlParts: string[] = ['-- AdminDB ER Chain Seed Script', '-- Order of execution: ' + executionOrder.join(' -> '), 'BEGIN TRANSACTION;\n'];

  for (const table of executionOrder) {
    const res = tableResults[table];
    if (!res || !res.rows.length) continue;

    sqlParts.push(`-- --------------------------------------------------------`);
    sqlParts.push(`-- Table: ${table} (${res.rows.length} rows)`);
    sqlParts.push(`-- --------------------------------------------------------`);

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
 * Execute atomic multi-table seeding inside a single database transaction.
 * Performs reverse-topological deletion if truncate is true.
 */
export async function executeChainInsert(
  db: IDatabase,
  chainResult: ErChainResult,
  truncate = false,
): Promise<{
  inserted: Record<string, number>;
  totalInserted: number;
  elapsedMs: number;
  warnings: string[];
}> {
  const t0 = Date.now();
  const inserted: Record<string, number> = {};
  let totalInserted = 0;

  // If truncate is requested, clear tables in REVERSE topological order (children first, parents last)
  if (truncate) {
    const reverseOrder = [...chainResult.executionOrder].reverse();
    for (const table of reverseOrder) {
      const clearRes = await db.run(`DELETE FROM ${quoteIdentifier(table)}`);
      if (!clearRes.success) {
        throw new Error(`Failed to truncate table "${table}": ${clearRes.error}`);
      }
    }
  }

  // Insert tables in TOPOLOGICAL order (parents first, children last)
  for (const table of chainResult.executionOrder) {
    const res = chainResult.tableResults[table];
    if (!res || !res.rows.length) {
      inserted[table] = 0;
      continue;
    }

    const insertRes = await db.insertRows(table, res.rows);
    if (!insertRes.success) {
      throw new Error(`Failed to insert seed rows into "${table}": ${insertRes.error}`);
    }

    const count = insertRes.data?.inserted ?? res.rows.length;
    inserted[table] = count;
    totalInserted += count;
  }

  const elapsedMs = Date.now() - t0;
  return {
    inserted,
    totalInserted,
    elapsedMs,
    warnings: chainResult.warnings,
  };
}
