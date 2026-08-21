import { quoteIdentifier } from '../sql/generator';
import type { FilterCondition, RowFilters, SQLInputValue } from './types';

/** Escape LIKE wildcards so user filter text is matched literally. */
export function escapeLike(s: string): string {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * Build a parameterized WHERE clause from per-column filters.
 *
 * A filter value is either:
 *   - the legacy string syntax: `=value` exact, `!=value`, `>value`, `>=value`,
 *     `<value`, `<=value`, `value*` prefix, anything else → substring match; or
 *   - a structured `FilterCondition` (or array of them) produced by the
 *     type-aware filter form (FK dropdowns, boolean toggles, date/number ranges).
 */
export function pushFilterCondition(
  conds: string[],
  params: SQLInputValue[],
  quotedCol: string,
  c: FilterCondition,
): void {
  const value = String(c.value ?? '');
  switch (c.op) {
    case 'eq':
      conds.push(`${quotedCol} = ?`);
      params.push(value);
      break;
    case 'neq':
      conds.push(`${quotedCol} != ?`);
      params.push(value);
      break;
    case 'gt':
      conds.push(`${quotedCol} > ?`);
      params.push(value);
      break;
    case 'gte':
      conds.push(`${quotedCol} >= ?`);
      params.push(value);
      break;
    case 'lt':
      conds.push(`${quotedCol} < ?`);
      params.push(value);
      break;
    case 'lte':
      conds.push(`${quotedCol} <= ?`);
      params.push(value);
      break;
    case 'like':
      conds.push(`${quotedCol} LIKE ? ESCAPE '\\'`);
      params.push('%' + escapeLike(value) + '%');
      break;
    case 'prefix':
      conds.push(`${quotedCol} LIKE ? ESCAPE '\\'`);
      params.push(escapeLike(value) + '%');
      break;
    case 'between':
      conds.push(`${quotedCol} >= ?`);
      params.push(value);
      conds.push(`${quotedCol} <= ?`);
      params.push(String(c.max ?? ''));
      break;
    case 'null':
      conds.push(`${quotedCol} IS NULL`);
      break;
    case 'notnull':
      conds.push(`${quotedCol} IS NOT NULL`);
      break;
    default:
      break;
  }
}

export function buildFilterClause(
  filters: RowFilters | undefined,
  availableCols: string[],
): { where: string; params: SQLInputValue[] } {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  const colSet = new Set(availableCols);
  for (const [col, raw] of Object.entries(filters ?? {})) {
    if (!colSet.has(col)) continue;
    const q = quoteIdentifier(col);

    if (Array.isArray(raw)) {
      for (const c of raw) {
        if (c && typeof c === 'object') pushFilterCondition(conds, params, q, c);
      }
      continue;
    }
    if (raw && typeof raw === 'object') {
      pushFilterCondition(conds, params, q, raw as FilterCondition);
      continue;
    }

    // Legacy string syntax.
    const value = String(raw ?? '').trim();
    if (value === '') continue;
    if (value.startsWith('>=')) {
      conds.push(`${q} >= ?`);
      params.push(value.slice(2).trim());
    } else if (value.startsWith('<=')) {
      conds.push(`${q} <= ?`);
      params.push(value.slice(2).trim());
    } else if (value.startsWith('!=')) {
      conds.push(`${q} != ?`);
      params.push(value.slice(2).trim());
    } else if (value.startsWith('=')) {
      conds.push(`${q} = ?`);
      params.push(value.slice(1).trim());
    } else if (value.startsWith('>')) {
      conds.push(`${q} > ?`);
      params.push(value.slice(1).trim());
    } else if (value.startsWith('<')) {
      conds.push(`${q} < ?`);
      params.push(value.slice(1).trim());
    } else if (value.endsWith('*')) {
      conds.push(`${q} LIKE ? ESCAPE '\\'`);
      params.push(escapeLike(value.slice(0, -1)) + '%');
    } else {
      conds.push(`${q} LIKE ? ESCAPE '\\'`);
      params.push('%' + escapeLike(value) + '%');
    }
  }
  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}
