/** Small shared helpers used across the server. */

import path from 'node:path';

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * True when `p` is equal to `root` or lives inside it (both treated as
 * absolute). Used to sandbox the filesystem file-browser to an allowed folder.
 */
export function isPathWithinRoot(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Operators understood by the structured (type-aware) filter conditions. */
export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'prefix' | 'between' | 'null' | 'notnull';

/** A single structured filter condition produced by the type-aware filter form. */
export interface FilterCondition {
  op: FilterOp;
  /** Primary operand for scalar operators; lower bound for `between`. */
  value?: string;
  /** Upper bound for `between`. */
  max?: string;
}

/** A filter value: the legacy string syntax or one/more structured conditions. */
export type FilterValue = string | FilterCondition | FilterCondition[];

/** Row filters keyed by column name. */
export interface RowFilters {
  [column: string]: FilterValue;
}

/** Parse the `f` query parameter (URL-encoded JSON object) into row filters. */
export function parseFilters(raw: unknown): RowFilters {
  const out: RowFilters = {};
  const add = (obj: unknown): void => {
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) {
          if (v.length) out[k] = v as FilterCondition[];
        } else if (typeof v === 'object') {
          out[k] = v as FilterCondition;
        } else {
          out[k] = String(v);
        }
      }
    }
  };
  if (typeof raw === 'string' && raw) {
    try {
      add(JSON.parse(raw));
    } catch {
      return {};
    }
  } else {
    add(raw);
  }
  return out;
}

/** Encode filters back into a `f=…` query string (empty when no filters). */
export function filtersToQS(filters: RowFilters | undefined): string {
  const out: RowFilters = {};
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v;
      continue;
    }
    if (typeof v === 'object') {
      if (Object.keys(v).length) out[k] = v;
      continue;
    }
    if (String(v).trim() !== '') out[k] = String(v).trim();
  }
  const keys = Object.keys(out);
  if (!keys.length) return '';
  return 'f=' + encodeURIComponent(JSON.stringify(out));
}

/** Internal tables (kept out of user-facing pickers) start with an underscore. */
export function isInternalTable(name: string): boolean {
  return name.startsWith('_');
}

/** Encode primary-key values into a single URL path segment (comma-joined, URL-encoded). */
export function encodePk(values: unknown[]): string {
  return values.map((v) => encodeURIComponent(v == null ? '' : String(v))).join(',');
}

/** Decode a primary-key path segment back into individual values. */
export function decodePk(encoded: string): string[] {
  return String(encoded)
    .split(',')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** Normalize a single cell for JSON / display (BLOB → 0x-hex string, undefined → null). */
export function normalizeCell(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (value === undefined) return null;
  return value;
}

/** Normalize every cell in a row. */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = normalizeCell(v);
  return out;
}

/**
 * Coerce a raw form value into a value suitable for SQLite binding.
 * - empty string / null / undefined  → null ("not set")
 * - `0` stays valid
 * - BOOLEAN → 1/0
 * - INTEGER/REAL → number when numeric
 * - BLOB → Buffer (0x-hex or raw text)
 */
export function coerceFormValue(raw: unknown, columnType: string): unknown {
  const type = (columnType || '').toUpperCase();
  if (raw === undefined || raw === null) return null;

  if (type === 'BOOLEAN') {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return null;
    return s === 'true' || s === '1' || s === 'on' || s === 'yes' || s === 'checked' ? 1 : 0;
  }

  if (type.startsWith('INTEGER') || type === 'REAL') {
    const s = String(raw).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }

  if (type === 'BLOB') {
    const s = String(raw);
    if (/^0x[0-9a-f]*$/i.test(s)) return Buffer.from(s.slice(2), 'hex');
    return Buffer.from(s, 'utf8');
  }

  const s = String(raw);
  if (s === '') return null;
  return s;
}
