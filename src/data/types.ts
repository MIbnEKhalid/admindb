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
  | 'database_aware'
  | 'relational';

export type GeneratorStrategyId =
  // Control / Custom
  | 'skip'
  | 'null'
  | 'fixed'
  | 'list'
  | 'pattern'
  | 'template'
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
  | 'orderStatus'
  | 'product'
  | 'productCategory'
  | 'department'
  | 'paymentMethod'
  | 'transactionType'
  | 'techSkill'
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
  | 'percentage'
  // Date & Time
  | 'date'
  | 'datetime'
  | 'time'
  | 'timestampUnix'
  | 'relativeDate'
  // System, Crypto & Tech
  | 'bool'
  | 'bytes'
  | 'json'
  | 'hash'
  | 'token'
  | 'uuid'
  | 'color'
  | 'mac'
  // Database-aware & Relational
  | 'fk'
  | 'sampleExisting'
  | 'sequentialFk';

/** Per-column generator settings. */
export interface ColumnPlan {
  strategy: GeneratorStrategyId;
  /** `fixed` / `list` and string options. */
  value?: string;
  /** `list` — random value picked from this set. */
  values?: string[];
  /** `template` — e.g. "{{first_name}}.{{last_name}}@example.com" */
  template?: string;
  /** `int` / `decimal` / `latitude` / `longitude` range bounds. */
  min?: number;
  max?: number;
  /** `decimal` — decimal precision digits. */
  precision?: number;
  /** `date` / `datetime` / `timestampUnix` bounds (ISO strings). */
  from?: string;
  to?: string;
  /** `words` / `bytes` / `hash` / `token` / `sentence` — length bounds. */
  minLen?: number;
  maxLen?: number;
  /** `json` — object keys to include. */
  jsonKeys?: string[];
  /** `json` — per-key allowed values. */
  jsonValues?: Record<string, string[]>;
  /** Percentage chance (0 to 100) to generate NULL for nullable columns. */
  nullPct?: number;
  /** Optional string prefix. */
  prefix?: string;
  /** Optional string suffix. */
  suffix?: string;
  /** Sequence start (for `sequence` strategy). */
  start?: number;
  /** Sequence step increment. */
  step?: number;
  /** Custom pattern template with tokens (for `pattern` strategy e.g. INV-####). */
  pattern?: string;
  /** Format variation (e.g. 'hex' | 'name' for color, 'sec' | 'ms' for unix timestamp). */
  format?: string;
  /** Enforce uniqueness during generation for this column. */
  unique?: boolean;
  /** For foreign keys / sampleExisting: referenced table and column. */
  refTable?: string;
  refColumn?: string;
}

/** A strategy choice offered to the UI for a column. */
export interface StrategyDescriptor {
  id: GeneratorStrategyId;
  label: string;
  category: StrategyCategory;
  description?: string;
}

/** Everything the Seed UI needs to render one column's controls. */
export interface ColumnGeneratorConfig {
  name: string;
  type: string;
  pk: boolean;
  notnull: boolean;
  hasDefault: boolean;
  unique: boolean;
  fk: ForeignKeyInfo | null;
  strategies: StrategyDescriptor[];
  defaultPlan: ColumnPlan;
}

/** Table generation mode in an ER / multi-table plan. */
export type TableGenerationMode =
  | 'generate'
  | 'use_existing'
  | 'generate_if_empty'
  | 'skip';

/** Cardinality distribution model. */
export type CardinalityDistribution = 'uniform' | 'fixed' | 'normal' | 'weighted';

/** Relationship cardinality configuration between parent and child table. */
export interface RelationshipConfig {
  parentTable: string;
  parentColumn: string;
  childTable: string;
  childColumn: string;
  /** Minimum children per parent (e.g. 1) */
  minPerParent?: number;
  /** Maximum children per parent (e.g. 5) */
  maxPerParent?: number;
  /** Distribution algorithm */
  distribution?: CardinalityDistribution;
  /** If many-to-many junction table, enforce unique composite pairs */
  uniquePairs?: boolean;
  /** Allow null foreign key (optional relationship) */
  nullable?: boolean;
  /** Chance (0-100) of orphan / null parent reference */
  nullChance?: number;
}

/** Table specification inside a GenerationPlan. */
export interface TableGenerationSpec {
  mode: TableGenerationMode;
  rows?: number;
  columns: Record<string, ColumnPlan>;
  /** Optional truncate table before inserting new rows */
  truncate?: boolean;
}

/** Global options for generation. */
export interface GenerationOptions {
  /** Deterministic PRNG seed number (reproducible output) */
  seed?: number | null;
  /** Run execution in a transaction */
  transaction?: boolean;
  /** Rollback on error */
  rollbackOnError?: boolean;
  /** Reverse-topological truncate/clean prior to insert */
  truncateAll?: boolean;
  /** Batch insert size */
  batchSize?: number;
  /** Preview row cap per table */
  previewLimit?: number;
}

/**
 * Unified Declarative Generation Specification.
 * Used identically across Single Table UI, ER Chain UI, APIs, and Profiles.
 */
export interface GenerationPlan {
  name?: string;
  description?: string;
  version?: number;
  rootTable?: string;
  scope?: ErChainScope;
  tables: Record<string, TableGenerationSpec>;
  relationships?: RelationshipConfig[];
  options?: GenerationOptions;
}

/** Pre-flight Validation result. */
export interface ValidationIssue {
  type: 'error' | 'warning' | 'info';
  table?: string;
  column?: string;
  message: string;
  code?: string;
}

export interface ValidationReport {
  valid: boolean;
  canExecute: boolean;
  issues: ValidationIssue[];
  summary: {
    totalTables: number;
    tablesToGenerate: number;
    tablesToUseExisting: number;
    tablesToSkip: number;
    estimatedTotalRows: number;
    cyclesDetected: boolean;
    cycleTables: string[];
    executionOrder: string[];
  };
}

export interface GenerateResult {
  /** One entry per generated row: the columns/values to bind. */
  rows: WhereClause[][];
  /** Structured row records for interactive UI table preview. */
  previewRows: Record<string, unknown>[];
  /** Non-fatal notes surfaced to the user. */
  warnings: string[];
}

/** Scope for resolving ER chain dependencies. */
export type ErChainScope = 'chain' | 'ancestors' | 'descendants' | 'all' | 'single';

/** A node in the ER dependency execution pipeline. */
export interface ErChainTableNode {
  name: string;
  order: number;
  depth: number;
  parents: { table: string; from: string; to: string; notnull?: boolean }[];
  children: { table: string; from: string; to: string; notnull?: boolean }[];
  columns: ColumnGeneratorConfig[];
  suggestedCount: number;
  rowCount: number;
  isRoot: boolean;
  hasSelfRef: boolean;
  isJunction?: boolean;
  mode?: TableGenerationMode;
}

/** Complete ER chain schema and dependency setup payload. */
export interface ErChainConfig {
  rootTable: string;
  scope: ErChainScope;
  tables: ErChainTableNode[];
  cycleDetected: boolean;
  cycleTables?: string[];
  maxTotalRows: number;
  relationships?: RelationshipConfig[];
}

/** Result of generating seed data across an entire ER chain or full plan. */
export interface ErChainResult {
  rootTable?: string;
  scope?: ErChainScope;
  executionOrder: string[];
  tableResults: Record<
    string,
    {
      count: number;
      rows: WhereClause[][];
      previewRows: Record<string, unknown>[];
      warnings: string[];
    }
  >;
  totalRows: number;
  sql: string;
  warnings: string[];
  validation?: ValidationReport;
}

/** Saved Seed Profile structure. */
export interface SeedProfile {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  plan: GenerationPlan;
}

/** Sentinel returned by value generation when the column should be omitted from the row. */
export const SKIP = Symbol('skip');
