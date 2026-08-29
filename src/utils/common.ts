import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Check if a given string or target is a PostgreSQL connection string */
export const isPostgresConnectionString = (target: unknown): boolean =>
  typeof target === 'string' && /^(postgres|postgresql):\/\//.test(target);

/** Mask credentials/password in a database connection URI for safe display and logging */
export function sanitizeConnectionString(conn: string): string {
  if (!conn || typeof conn !== 'string') return '';
  try {
    const u = new URL(conn);
    if (u.password) {
      u.password = '****';
      return u.toString();
    }
  } catch {}
  return conn.replace(/:([^:@]+)@/, ':****@');
}

/**
 * True when `p` is equal to `root` or lives inside it (both treated as
 * absolute). Used to sandbox the filesystem file-browser to an allowed folder.
 * Resolves symlinks and rejects null-byte injections.
 */
export function isPathWithinRoot(root: string, p: string): boolean {
  if (!root || !p || typeof root !== 'string' || typeof p !== 'string' || p.includes('\0') || root.includes('\0')) {
    return false;
  }
  const resolveReal = (target: string) => {
    const abs = path.resolve(target);
    try {
      if (existsSync(abs)) return realpathSync(abs);
    } catch {}
    return abs;
  };
  const rel = path.relative(resolveReal(root), resolveReal(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Operators understood by the structured (type-aware) filter conditions. */
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'prefix'
  | 'between'
  | 'null'
  | 'notnull';

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
    } else if (typeof v === 'object') {
      if (Object.keys(v).length) out[k] = v;
    } else if (String(v).trim() !== '') {
      out[k] = String(v).trim();
    }
  }
  return Object.keys(out).length ? `f=${encodeURIComponent(JSON.stringify(out))}` : '';
}

/** Internal tables (kept out of user-facing pickers) start with an underscore. */
export const isInternalTable = (name: string): boolean => name.startsWith('_');

/** Encode primary-key values into a single URL path segment (comma-joined, URL-encoded). */
export const encodePk = (values: unknown[]): string =>
  values.map((v) => encodeURIComponent(v == null ? '' : String(v))).join(',');

/** Decode a primary-key path segment back into individual values. */
export const decodePk = (encoded: string): string[] =>
  String(encoded)
    .split(',')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

/** Normalize a single cell for JSON / display (BLOB → 0x-hex string, undefined → null). */
export function normalizeCell(value: unknown): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return value ?? null;
}

/** Normalize every cell in a row. */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = normalizeCell(v);
  return out;
}

/**
 * Coerce a raw form value into a value suitable for SQLite or Postgres binding.
 * - empty string / null / undefined  → null ("not set")
 * - `0` stays valid
 * - BOOLEAN → 1/0 (SQLite) or boolean (PostgreSQL)
 * - INTEGER/REAL/BIGINT/NUMERIC → number when numeric
 * - BLOB / BYTEA → Buffer (0x-hex, \x-hex, or raw text)
 */
export function coerceFormValue(raw: unknown, columnType: string, dialect: 'sqlite' | 'postgres' = 'sqlite'): unknown {
  if (raw === undefined || raw === null) return null;
  const type = (columnType || '').toUpperCase();

  if (type === 'BOOLEAN' || type === 'BOOL') {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return null;
    const boolVal = s === 'true' || s === '1' || s === 'on' || s === 'yes' || s === 'checked';
    return dialect === 'postgres' ? boolVal : (boolVal ? 1 : 0);
  }

  if (
    type.startsWith('INT') ||
    type === 'REAL' ||
    type === 'NUMERIC' ||
    type.startsWith('DECIMAL') ||
    type === 'FLOAT' ||
    type === 'DOUBLE' ||
    type.startsWith('BIGINT') ||
    type.startsWith('SMALLINT') ||
    type.startsWith('SERIAL')
  ) {
    const s = String(raw).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }

  if (type === 'BLOB' || type === 'BYTEA') {
    const s = String(raw);
    return /^(0x|\\x)[0-9a-f]*$/i.test(s) ? Buffer.from(s.slice(2), 'hex') : Buffer.from(s, 'utf8');
  }

  if (type === 'JSON' || type === 'JSONB') {
    const s = String(raw).trim();
    return s === '' ? null : s;
  }

  if (type.endsWith('[]') || type.startsWith('_') || type.includes('ARRAY')) {
    if (Array.isArray(raw)) return raw;
    const s = String(raw).trim();
    return s === '' ? null : s;
  }

  const s = String(raw);
  return s === '' ? null : s;
}

/** Format byte size to human readable string (e.g. 1.2 MB). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Truncate a string with an ellipsis if it exceeds maxLength. */
export const truncate = (str: string, maxLength: number): string =>
  !str || str.length <= maxLength ? str : `${str.slice(0, maxLength)}…`;
