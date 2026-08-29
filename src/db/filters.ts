import { quoteIdentifier } from '../sql/generator';
import type { FilterCondition, RowFilters, SQLInputValue } from './types';

/** Escape LIKE wildcards so user filter text is matched literally. */
export const escapeLike = (s: string): string => String(s).replace(/[\\%_]/g, '\\$&');

/**
 * Build a parameterized WHERE clause from per-column filters.
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
      params.push(`%${escapeLike(value)}%`);
      break;
    case 'prefix':
      conds.push(`${quotedCol} LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(value)}%`);
      break;
    case 'between':
      conds.push(`${quotedCol} >= ?`, `${quotedCol} <= ?`);
      params.push(value, String(c.max ?? ''));
      break;
    case 'null':
      conds.push(`${quotedCol} IS NULL`);
      break;
    case 'notnull':
      conds.push(`${quotedCol} IS NOT NULL`);
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

    const value = String(raw ?? '').trim();
    if (!value) continue;

    const opMatch = value.match(/^(>=|<=|!=|=|>|<)(.*)$/);
    if (opMatch) {
      const [, op, val] = opMatch;
      conds.push(`${q} ${op} ?`);
      params.push(val.trim());
    } else if (value.endsWith('*')) {
      conds.push(`${q} LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(value.slice(0, -1))}%`);
    } else {
      conds.push(`${q} LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(value)}%`);
    }
  }

  return { where: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}

/**
 * Replace SQLite-style `?` placeholders with PostgreSQL-style `$1, $2, ...`
 * placeholders while safely preserving single-quoted string literals.
 */
export function convertPlaceholdersToPostgres(sql: string, startIdx = 1): string {
  let idx = startIdx;
  let inString = false;
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      inString = !inString;
      result += ch;
    } else if (ch === '?' && !inString) {
      result += `$${idx++}`;
    } else {
      result += ch;
    }
  }
  return result;
}
