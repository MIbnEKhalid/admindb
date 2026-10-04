export type SearchCategory = 'table' | 'column' | 'index' | 'relation' | 'command' | 'row';

export interface SearchAction {
  label: string;
  url: string;
  icon?: string;
  primary?: boolean;
}

export interface SearchItem {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle: string;
  icon: string;
  url: string;
  score: number;
  badge?: string;
  badgeType?: 'primary' | 'secondary' | 'accent' | 'info' | 'success' | 'warning' | 'error' | 'neutral';
  actions?: SearchAction[];
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  total: number;
  categories: Record<SearchCategory, number>;
  results: SearchItem[];
}

export interface SearchOptions {
  query?: string;
  type?: string;
  limit?: number;
  includeRows?: boolean;
  basePath?: string;
}

export interface TableSummary {
  name: string;
  columnsCount: number;
  rowCount?: number;
  primaryKey: string[];
}

export interface ColumnSummary {
  table: string;
  name: string;
  type: string;
  isPk: boolean;
  isFk: boolean;
  fkTarget?: string | null;
  notnull: boolean;
  dflt_value: string | null;
}

export interface IndexSummary {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

export interface ForeignKeySummary {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string | null;
  onUpdate: string;
  onDelete: string;
}

export interface CommandItem {
  id: string;
  title: string;
  description: string;
  icon: string;
  url: string;
  keywords: string[];
  shortcut?: string;
}

export interface SearchMetadataIndex {
  tables: TableSummary[];
  columns: ColumnSummary[];
  indexes: IndexSummary[];
  foreignKeys: ForeignKeySummary[];
  commands: CommandItem[];
}
