import type { ForeignKeyInfo, WhereClause } from '../db/database';

/** Hard cap on how many rows a single seed run may generate. */
export const MAX_SEED_ROWS = 5000;

export type StrategyCategory =
  | 'identity'
  | 'contact_web'
  | 'commerce'
  | 'location'
  | 'numeric'
  | 'datetime'
  | 'system_crypto'
  | 'custom_control'
  | 'relational';

export type GeneratorStrategyId =
  // Control / Custom
  | 'skip'
  | 'null'
  | 'fixed'
  | 'list'
  | 'pattern'
  // Identity & People
  | 'first'
  | 'last'
  | 'fullname'
  | 'username'
  | 'job'
  // Contact & Web
  | 'email'
  | 'phone'
  | 'url'
  | 'domain'
  | 'ip'
  | 'avatar'
  // Commerce & Business
  | 'company'
  | 'currency'
  | 'status'
  | 'creditCard'
  // Location
  | 'city'
  | 'country'
  | 'state'
  | 'postal'
  | 'address'
  | 'countryCode'
  | 'latitude'
  | 'longitude'
  // Text & Content
  | 'words'
  | 'sentence'
  | 'paragraph'
  | 'slug'
  // Numbers & Math
  | 'int'
  | 'decimal'
  | 'sequence'
  // Date & Time
  | 'date'
  | 'datetime'
  | 'time'
  | 'timestampUnix'
  // System, Crypto & Tech
  | 'bool'
  | 'bytes'
  | 'json'
  | 'hash'
  | 'token'
  | 'uuid'
  | 'color'
  | 'mac'
  // Relational
  | 'fk';

/** Per-column generator settings. Which options are meaningful depends on `strategy`. */
export interface ColumnPlan {
  strategy: GeneratorStrategyId;
  /** `fixed` / `list` and the string-ish options. */
  value?: string;
  /** `list` — random value picked from this set. */
  values?: string[];
  /** `int` / `decimal` / `latitude` / `longitude` range. */
  min?: number;
  max?: number;
  /** `decimal` — digits after the decimal point. */
  precision?: number;
  /** `date` / `datetime` / `timestampUnix` bounds (ISO strings). */
  from?: string;
  to?: string;
  /** `words` / `bytes` / `hash` / `token` / `sentence` — length bounds. */
  minLen?: number;
  maxLen?: number;
  /** `json` — object keys to include (comma-separated in the UI). */
  jsonKeys?: string[];
  /** `json` — per-key allowed values, derived from CHECK constraints. */
  jsonValues?: Record<string, string[]>;
  /** Percentage chance (0 to 100) to generate NULL for nullable columns. */
  nullPct?: number;
  /** Optional string prefix to prepend to generated string/text values. */
  prefix?: string;
  /** Optional string suffix to append to generated string/text values. */
  suffix?: string;
  /** Sequence start (for `sequence` strategy). */
  start?: number;
  /** Sequence step increment (for `sequence` strategy). */
  step?: number;
  /** Custom pattern template with tokens (for `pattern` strategy). */
  pattern?: string;
  /** Format variation (e.g. 'hex' | 'name' for color, 'sec' | 'ms' for unix timestamp). */
  format?: string;
}

/** A strategy choice offered to the UI for a column. */
export interface StrategyDescriptor {
  id: GeneratorStrategyId;
  label: string;
  category: StrategyCategory;
  description?: string;
}

/** Everything the "Seed data" page needs to render one column's controls. */
export interface ColumnGeneratorConfig {
  name: string;
  type: string;
  pk: boolean;
  notnull: boolean;
  hasDefault: boolean;
  /** True when a single-column UNIQUE index enforces uniqueness on this column. */
  unique: boolean;
  /** The foreign key this column participates in (as the child), if any. */
  fk: ForeignKeyInfo | null;
  strategies: StrategyDescriptor[];
  defaultPlan: ColumnPlan;
}

export interface GenerateResult {
  /** One entry per generated row: the columns/values to bind (skipped columns are absent). */
  rows: WhereClause[][];
  /** Structured row records for interactive UI table preview. */
  previewRows: Record<string, unknown>[];
  /** Non-fatal notes surfaced to the user (e.g. a NOT NULL column being skipped). */
  warnings: string[];
}

/** Sentinel returned by value generation when the column should be omitted from the row. */
export const SKIP = Symbol('skip');
