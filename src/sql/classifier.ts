/**
 * Classify incoming SQL as a read (SELECT), a count query, or a write
 * statement, so the query runner can decide how to render/execute it.
 */

export type SqlKind = 'select' | 'count' | 'read' | 'write';

const LEADING_NOISE = /^\s*((\/\*[\s\S]*?\*\/)|(--[^\n]*\n))*\s*/;

/** Extract the first keyword, skipping leading whitespace and comments. */
export function firstKeyword(sql: string): string {
  const cleaned = String(sql).replace(LEADING_NOISE, '').trim();
  const m = cleaned.match(/^([a-zA-Z]+)/);
  return m ? m[1].toUpperCase() : '';
}

export interface Classification {
  kind: SqlKind;
  keyword: string;
}

/**
 * Classify a SQL statement.
 * - SELECT / WITH → `select`, unless it is a pure `count(...)` (no GROUP BY)
 *   in which case it is `count`.
 * - INSERT / UPDATE / DELETE / REPLACE / CREATE / DROP / ALTER → `write`.
 * - Anything else that may still return rows (PRAGMA, EXPLAIN, …) → `read`.
 */
export function classifySql(sql: string): Classification {
  const keyword = firstKeyword(sql);

  if (keyword === 'SELECT' || keyword === 'WITH') {
    const body = String(sql).replace(LEADING_NOISE, '').trim();
    const isCount =
      /^select\b[\s\S]*?\bcount\s*\(/i.test(body) &&
      !/\bgroup\s+by\b/i.test(body) &&
      !/\bunion\b/i.test(body);
    return { kind: isCount ? 'count' : 'select', keyword };
  }

  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER'].includes(keyword)) {
    return { kind: 'write', keyword };
  }

  return { kind: 'read', keyword: keyword || 'UNKNOWN' };
}
