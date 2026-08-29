import type { TableInfoData } from '../db/index';
import { buildColumnConfigs } from './detector';
import type { ColumnGeneratorConfig, ErChainScope, RelationshipConfig } from './types';

export interface SchemaNode {
  name: string;
  info: TableInfoData;
  columns: ColumnGeneratorConfig[];
  parents: { table: string; from: string; to: string; notnull: boolean }[];
  children: { table: string; from: string; to: string; notnull: boolean }[];
  hasSelfRef: boolean;
  isJunction: boolean;
  depth: number;
}

export interface SchemaGraph {
  nodes: Map<string, SchemaNode>;
  relationships: RelationshipConfig[];
}

/**
 * Detects if a table is a Many-to-Many junction table.
 */
export function isJunctionTable(info: TableInfoData): boolean {
  if (info.foreignKeys.length < 2) return false;

  const fkColumns = new Set(info.foreignKeys.map((fk) => fk.from.toLowerCase()));
  if (fkColumns.size < 2) return false;

  const pk = info.primaryKey.map((k) => k.toLowerCase());
  if (pk.length >= 2 && pk.every((k) => fkColumns.has(k))) return true;

  for (const ix of info.indexes ?? []) {
    if (ix.unique && ix.columns.length >= 2) {
      if (ix.columns.map((c) => c.toLowerCase()).every((c) => fkColumns.has(c))) {
        return true;
      }
    }
  }

  if (info.columns.length <= 5 && info.foreignKeys.length >= 2) {
    const nonFkCols = info.columns.filter(
      (c) =>
        !fkColumns.has(c.name.toLowerCase()) &&
        !c.pk &&
        !['created_at', 'updated_at', 'createdat', 'updatedat'].includes(c.name.toLowerCase()),
    );
    if (nonFkCols.length <= 1) return true;
  }

  return false;
}

/**
 * Builds the Schema Graph across all provided database tables.
 */
export function buildSchemaGraph(tables: TableInfoData[]): SchemaGraph {
  const nodes = new Map<string, SchemaNode>();
  const relationships: RelationshipConfig[] = [];

  for (const info of tables) {
    const columns = buildColumnConfigs(info);
    const colMap = new Map(info.columns.map((c) => [c.name, c]));
    const parents: { table: string; from: string; to: string; notnull: boolean }[] = [];
    let hasSelfRef = false;

    for (const fk of info.foreignKeys) {
      const toCol = fk.to || (tables.find((t) => t.table === fk.table)?.primaryKey[0] ?? 'id');
      if (fk.table === info.table) hasSelfRef = true;
      const c = colMap.get(fk.from);
      const notnull = Boolean(c?.notnull || (c?.pk ?? 0) > 0);
      parents.push({ table: fk.table, from: fk.from, to: toCol, notnull });

      relationships.push({
        parentTable: fk.table,
        parentColumn: toCol,
        childTable: info.table,
        childColumn: fk.from,
        minPerParent: notnull ? 1 : 0,
        maxPerParent: 5,
        distribution: 'uniform',
        nullable: !notnull,
      });
    }

    nodes.set(info.table, {
      name: info.table,
      info,
      columns,
      parents,
      children: [],
      hasSelfRef,
      isJunction: isJunctionTable(info),
      depth: 0,
    });
  }

  // Populate reverse relationships (children)
  for (const node of nodes.values()) {
    for (const p of node.parents) {
      if (p.table !== node.name && nodes.has(p.table)) {
        nodes.get(p.table)!.children.push({
          table: node.name,
          from: p.from,
          to: p.to,
          notnull: p.notnull,
        });
      }
    }
  }

  return { nodes, relationships };
}

/**
 * Resolves the connected subset of tables based on the root table and scope.
 */
export function resolveScopeTables(
  graph: SchemaGraph,
  rootTable: string,
  scope: ErChainScope = 'chain',
): SchemaNode[] {
  if (scope === 'all') return Array.from(graph.nodes.values());

  const root = graph.nodes.get(rootTable);
  if (!root) return [];
  if (scope === 'single') return [root];

  const selected = new Set<string>([rootTable]);
  const queue = [rootTable];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const node = graph.nodes.get(curr);
    if (!node) continue;

    if (scope === 'ancestors' || scope === 'chain') {
      for (const p of node.parents) {
        if (p.table !== curr && graph.nodes.has(p.table) && !selected.has(p.table)) {
          selected.add(p.table);
          queue.push(p.table);
        }
      }
    }
    if (scope === 'descendants' || scope === 'chain') {
      for (const c of node.children) {
        if (c.table !== curr && graph.nodes.has(c.table) && !selected.has(c.table)) {
          selected.add(c.table);
          queue.push(c.table);
        }
      }
    }
  }

  return Array.from(selected).map((name) => graph.nodes.get(name)!);
}

/**
 * Topologically sorts table nodes with cycle detection and priority weighting.
 */
export function sortTopologically(nodes: SchemaNode[]): {
  sorted: SchemaNode[];
  cycleDetected: boolean;
  cycleTables: string[];
} {
  const activeNames = new Set(nodes.map((n) => n.name));
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));

  const totalInDegree = new Map<string, number>();
  const hardInDegree = new Map<string, number>();
  const allForwardEdges = new Map<string, Set<string>>();
  const hardForwardEdges = new Map<string, Set<string>>();

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
        if (p.notnull && !hardForwardEdges.get(p.table)!.has(n.name)) {
          hardForwardEdges.get(p.table)!.add(n.name);
          hardInDegree.set(n.name, (hardInDegree.get(n.name) ?? 0) + 1);
        }
      }
    }
  }

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

  while (sortedNames.length < nodes.length) {
    while (queue.length > 0) {
      const curr = queue.shift()!;
      sortedNames.push(curr);
      const currDepth = depths.get(curr) ?? 0;

      for (const child of allForwardEdges.get(curr) ?? []) {
        const newTotalDeg = (totalInDegree.get(child) ?? 1) - 1;
        totalInDegree.set(child, newTotalDeg);
        if (hardForwardEdges.get(curr)?.has(child)) {
          hardInDegree.set(child, (hardInDegree.get(child) ?? 1) - 1);
        }
        depths.set(child, Math.max(depths.get(child) ?? 0, currDepth + 1));
        if (newTotalDeg === 0 && !visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }

    if (sortedNames.length < nodes.length) {
      cycleDetected = true;
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
