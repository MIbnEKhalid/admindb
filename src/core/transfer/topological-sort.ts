import type { ForeignKeyInfo } from '../../db/types';

export interface TableDependency {
  name: string;
  foreignKeys: ForeignKeyInfo[];
}

/**
 * Sort tables in topological order: parent tables come before dependent child tables.
 * Returns an array of table names in safe insertion order.
 */
export function sortTablesTopologically(tables: TableDependency[]): string[] {
  const tableNames = new Set(tables.map((t) => t.name));
  const adj = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const t of tables) {
    if (!adj.has(t.name)) adj.set(t.name, new Set());
    if (!inDegree.has(t.name)) inDegree.set(t.name, 0);
  }

  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const parent = fk.table;
      // Only consider dependencies within the selected tables set and avoid self-references
      if (parent && tableNames.has(parent) && parent !== t.name) {
        if (!adj.get(parent)!.has(t.name)) {
          adj.get(parent)!.add(t.name);
          inDegree.set(t.name, (inDegree.get(t.name) || 0) + 1);
        }
      }
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(name);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    const children = adj.get(current) || new Set();
    for (const child of children) {
      const newDeg = (inDegree.get(child) || 0) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) {
        queue.push(child);
      }
    }
  }

  // If there are cycle dependencies, append remaining tables
  if (result.length < tables.length) {
    for (const t of tables) {
      if (!result.includes(t.name)) {
        result.push(t.name);
      }
    }
  }

  return result;
}

/**
 * Returns reverse topological order (child tables first, parent tables last) for safe deletion/truncation.
 */
export function sortTablesForDeletion(tables: TableDependency[]): string[] {
  return [...sortTablesTopologically(tables)].reverse();
}
