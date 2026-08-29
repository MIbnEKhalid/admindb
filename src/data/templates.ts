import type { RandomSource } from './prng';
import { makeSlug, makeUuid } from './registry';
import type { ColumnPlan } from './types';

/**
 * Extracts referenced column names from a template string.
 * Example: "{{first_name}} {{last_name}} {{year}}" -> ["first_name", "last_name"]
 */
export function extractTemplateDependencies(template: string): string[] {
  if (!template) return [];
  const deps: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_]+)(?:\s*:[^}]+)?\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const name = m[1].trim();
    if (!['sequence', 'random', 'year', 'uuid', 'slug', 'now', 'date'].includes(name.toLowerCase())) {
      if (!deps.includes(name)) deps.push(name);
    }
  }
  return deps;
}

/**
 * Evaluates a template expression using currently generated row values and PRNG.
 */
export function evaluateTemplate(
  template: string,
  rowValues: Record<string, unknown>,
  prng: RandomSource,
  rowIndex = 0,
): string {
  if (!template) return '';

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)(?::([^}]+))?\s*\}\}/g, (_, token: string, argsStr?: string) => {
    const t = token.trim();
    const args = argsStr ? argsStr.split(/[:,]/).map((s) => s.trim()).filter(Boolean) : [];

    switch (t.toLowerCase()) {
      case 'year':
        return String(new Date().getFullYear());
      case 'uuid':
        return makeUuid(prng);
      case 'slug':
        return makeSlug(prng);
      case 'now':
        return new Date().toISOString();
      case 'date':
        return new Date().toISOString().slice(0, 10);
      case 'sequence': {
        const start = args[0] ? Number.parseInt(args[0], 10) : 1;
        const step = args[1] ? Number.parseInt(args[1], 10) : 1;
        const s = Number.isFinite(start) ? start : 1;
        const st = Number.isFinite(step) ? step : 1;
        return String(s + rowIndex * st);
      }
      case 'random': {
        const min = args[0] ? Number.parseInt(args[0], 10) : 1;
        const max = args[1] ? Number.parseInt(args[1], 10) : 100;
        const lo = Number.isFinite(min) ? min : 1;
        const hi = Number.isFinite(max) ? max : 100;
        return String(prng.int(lo, hi));
      }
    }

    let rawVal: unknown = rowValues[t];
    if (rawVal === undefined) {
      const lower = t.toLowerCase();
      for (const [k, v] of Object.entries(rowValues)) {
        if (k.toLowerCase() === lower) {
          rawVal = v;
          break;
        }
      }
    }

    if (rawVal != null) {
      let str = String(rawVal);
      if (template.includes('@') && template.indexOf(`{{${token}`) < template.indexOf('@')) {
        str = str
          .toLowerCase()
          .trim()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '.')
          .replace(/^\.+|\.+$/g, '');
      }
      return str;
    }

    return '';
  });
}

/**
 * Topologically orders column plans within a table based on template dependencies.
 */
export function orderColumnDependencies(
  columnNames: string[],
  plans: Record<string, ColumnPlan>,
): {
  orderedColumns: string[];
  hasCycle: boolean;
  cycleColumns: string[];
} {
  const colSet = new Set(columnNames);
  const inDegree = new Map<string, number>();
  const graph = new Map<string, Set<string>>();

  for (const col of columnNames) {
    inDegree.set(col, 0);
    graph.set(col, new Set());
  }

  const nameColumns = columnNames.filter((c) =>
    ['first_name', 'last_name', 'full_name', 'fullname', 'name', 'customer_name'].includes(c.toLowerCase()),
  );

  for (const col of columnNames) {
    const plan = plans[col];
    if (plan?.strategy === 'template' && plan.template) {
      const deps = extractTemplateDependencies(plan.template).filter((d) => colSet.has(d) && d !== col);
      for (const dep of deps) {
        graph.get(dep)?.add(col);
        inDegree.set(col, (inDegree.get(col) ?? 0) + 1);
      }
    } else if (plan?.strategy === 'email' || plan?.strategy === 'username') {
      for (const nameCol of nameColumns) {
        if (nameCol !== col && !graph.get(nameCol)?.has(col)) {
          graph.get(nameCol)?.add(col);
          inDegree.set(col, (inDegree.get(col) ?? 0) + 1);
        }
      }
    }
  }

  const queue: string[] = [];
  for (const [col, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(col);
  }

  const orderedColumns: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    orderedColumns.push(curr);

    for (const dependent of graph.get(curr) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  const hasCycle = orderedColumns.length < columnNames.length;
  const cycleColumns: string[] = [];
  if (hasCycle) {
    for (const col of columnNames) {
      if (!orderedColumns.includes(col)) cycleColumns.push(col);
    }
    for (const col of cycleColumns) orderedColumns.push(col);
  }

  return { orderedColumns, hasCycle, cycleColumns };
}
