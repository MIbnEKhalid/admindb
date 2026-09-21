import type { IDatabase, TableInfoData } from '../db/index';
import { quoteIdentifier } from '../sql/generator';
import { buildChainInsertSql, SeedEngine } from './engine';
import { buildSchemaGraph, resolveScopeTables, sortTopologically } from './schema-graph';
import type { ColumnPlan, ErChainConfig, ErChainResult, ErChainScope, ErChainTableNode, GenerationPlan, TableGenerationMode, TableGenerationSpec } from './types';

export { buildChainInsertSql };

/**
 * Builds the schema graph (backward-compatible wrapper).
 */
export const buildErGraph = (tables: TableInfoData[]) => buildSchemaGraph(tables).nodes;

/**
 * Resolves the connected table nodes for the given scope (backward-compatible wrapper).
 */
export const resolveErChain = (
  graph: Map<string, any>,
  rootTable: string,
  scope: ErChainScope = 'chain',
) => resolveScopeTables({ nodes: graph, relationships: [] }, rootTable, scope);

/**
 * Topologically sorts table nodes with cycle detection (backward-compatible wrapper).
 */
export const topologicalSort = (nodes: any[]) => sortTopologically(nodes);

/**
 * Builds the full ER chain configuration payload for UI & API.
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

  const graph = buildSchemaGraph(tables);
  const chainNodes = resolveScopeTables(graph, rootTable, scope);
  const { sorted, cycleDetected, cycleTables } = sortTopologically(chainNodes);

  const tableNodes: ErChainTableNode[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    let rowCount = 0;
    try {
      const countRes = await db.getRowCount(node.name);
      if (countRes.success && typeof countRes.data === 'number') rowCount = countRes.data;
    } catch {}

    const suggestedCount = node.depth === 0 ? 5 : node.depth === 1 ? 15 : 25;

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
      isJunction: node.isJunction,
      mode: 'generate',
    });
  }

  return {
    rootTable,
    scope,
    tables: tableNodes,
    cycleDetected,
    cycleTables,
    maxTotalRows: 10000,
    relationships: graph.relationships,
  };
}

/**
 * Generate rows across an entire ER chain in topological dependency order.
 */
export async function generateChainRows(
  db: IDatabase,
  chainConfig: ErChainConfig,
  customPlans: Record<string, Record<string, ColumnPlan>> = {},
  customCounts: Record<string, number> = {},
  truncate = false,
  modes: Record<string, TableGenerationMode> = {},
  seed?: number | null,
): Promise<ErChainResult> {
  const planTables: Record<string, TableGenerationSpec> = {};

  for (const tableNode of chainConfig.tables) {
    const tableName = tableNode.name;
    const mode = modes[tableName] || 'generate';
    const rows = customCounts[tableName] ?? tableNode.suggestedCount ?? 10;
    const columns: Record<string, ColumnPlan> = {};

    for (const col of tableNode.columns) {
      const raw = customPlans[tableName]?.[col.name];
      columns[col.name] = raw && raw.strategy ? raw : col.defaultPlan;
    }

    planTables[tableName] = {
      mode,
      rows,
      columns,
      truncate,
    };
  }

  const generationPlan: GenerationPlan = {
    rootTable: chainConfig.rootTable,
    scope: chainConfig.scope,
    tables: planTables,
    relationships: chainConfig.relationships,
    options: {
      seed: seed ?? null,
      truncateAll: truncate,
    },
  };

  return SeedEngine.executePlan(db, generationPlan);
}

/**
 * Execute atomic multi-table seeding inside a database transaction.
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

  // Truncate in REVERSE topological order (children first, parents last)
  if (truncate) {
    const reverseOrder = [...chainResult.executionOrder].reverse();
    for (const table of reverseOrder) {
      const clearRes = await db.run(`DELETE FROM ${quoteIdentifier(table)}`);
      if (!clearRes.success) {
        throw new Error(`Failed to truncate table "${table}": ${clearRes.error}`);
      }
    }
  }

  // Insert in TOPOLOGICAL order (parents first, children last)
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

  return {
    inserted,
    totalInserted,
    elapsedMs: Date.now() - t0,
    warnings: chainResult.warnings,
  };
}
