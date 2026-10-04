import type { DatabaseContext } from '../../core/context';
import type {
  SearchOptions,
  SearchResponse,
  SearchItem,
  SearchMetadataIndex,
  TableSummary,
  ColumnSummary,
  IndexSummary,
  ForeignKeySummary,
  CommandItem,
  SearchCategory,
} from './search.types';
import { quoteIdentifier } from '../../sql/generator';

export class SearchService {
  /**
   * Generates standard built-in commands for the database context.
   */
  static getCommands(dbId: string, basePath = '', isReadOnly = false): CommandItem[] {
    const encDb = encodeURIComponent(dbId);
    const commands: CommandItem[] = [
      {
        id: 'cmd-query',
        title: 'New SQL Query',
        description: 'Open the SQL query editor to run queries and scripts',
        icon: 'query',
        url: `${basePath}/query/${encDb}`,
        keywords: ['sql', 'query', 'editor', 'execute', 'run', 'select', 'terminal'],
      },
      {
        id: 'cmd-erd',
        title: 'Entity Relationship Diagram',
        description: 'Visualize database tables, relationships, and schema graph',
        icon: 'diagram',
        url: `${basePath}/erd/${encDb}`,
        keywords: ['erd', 'diagram', 'graph', 'schema', 'relations', 'visualize', 'foreign keys'],
      },
      {
        id: 'cmd-seed',
        title: 'Seed Data Generator',
        description: 'Generate relational mock and seed data with intelligent heuristics',
        icon: 'seed',
        url: `${basePath}/seed/${encDb}`,
        keywords: ['seed', 'mock', 'fake data', 'generator', 'faker', 'synthetic data'],
      },
      {
        id: 'cmd-diff',
        title: 'Diff & Replicate Database',
        description: 'Compare schemas, generate migration patches, or clone data',
        icon: 'diff',
        url: `${basePath}/diff/${encDb}`,
        keywords: ['diff', 'sync', 'replicate', 'migrate', 'migration', 'patch', 'clone', 'compare'],
      },
      {
        id: 'cmd-info',
        title: 'Database Info & Settings',
        description: 'View database pragma, engine configuration, and metadata',
        icon: 'settings',
        url: `${basePath}/info/${encDb}`,
        keywords: ['info', 'settings', 'config', 'pragma', 'driver', 'version', 'database info'],
      },
      {
        id: 'cmd-export',
        title: 'Export Database (SQL Dump)',
        description: 'Download full database schema and data as an SQL script',
        icon: 'export',
        url: `${basePath}/export/${encDb}`,
        keywords: ['export', 'dump', 'backup', 'download', 'sql dump', 'save'],
      },
      {
        id: 'cmd-home',
        title: 'Database Dashboard',
        description: 'Overview of all tables, total rows, and statistics',
        icon: 'home',
        url: `${basePath}/home/${encDb}`,
        keywords: ['home', 'dashboard', 'overview', 'tables', 'stats'],
      },
    ];

    if (!isReadOnly) {
      commands.push({
        id: 'cmd-designer',
        title: 'Create New Table',
        description: 'Design and create a new database table with custom columns and keys',
        icon: 'plus',
        url: `${basePath}/designer/${encDb}`,
        keywords: ['create table', 'designer', 'new table', 'add table', 'schema designer'],
      });
    }

    return commands;
  }

  /**
   * Introspects and builds a full lightweight metadata index for the given database.
   */
  static async getMetadataIndex(ctx: DatabaseContext, basePath = ''): Promise<SearchMetadataIndex> {
    const listRes = await ctx.db.listTables();
    const tableItems = listRes.success && listRes.data ? listRes.data : [];

    const tables: TableSummary[] = [];
    const columns: ColumnSummary[] = [];
    const indexes: IndexSummary[] = [];
    const foreignKeys: ForeignKeySummary[] = [];

    await Promise.all(
      tableItems.map(async (t) => {
        const tableName = t.name;
        try {
          const infoRes = await ctx.db.getTableInfo(tableName);
          if (!infoRes.success || !infoRes.data) return;
          const info = infoRes.data;

          tables.push({
            name: tableName,
            columnsCount: info.columns.length,
            primaryKey: info.primaryKey || [],
          });

          // Index columns
          for (const col of info.columns) {
            const fk = (info.foreignKeys || []).find((f) => f.from === col.name);
            columns.push({
              table: tableName,
              name: col.name,
              type: col.type || 'TEXT',
              isPk: Boolean(col.pk),
              isFk: Boolean(fk),
              fkTarget: fk ? `${fk.table}.${fk.to || 'id'}` : null,
              notnull: Boolean(col.notnull),
              dflt_value: col.dflt_value,
            });
          }

          // Index indexes
          for (const idx of info.indexes || []) {
            indexes.push({
              table: tableName,
              name: idx.name,
              unique: Boolean(idx.unique),
              columns: idx.columns || [],
            });
          }

          // Index foreign keys
          for (const fk of info.foreignKeys || []) {
            foreignKeys.push({
              fromTable: tableName,
              fromColumn: fk.from,
              toTable: fk.table,
              toColumn: fk.to || null,
              onUpdate: fk.on_update || 'NO ACTION',
              onDelete: fk.on_delete || 'NO ACTION',
            });
          }
        } catch {
          // ignore failures for individual tables
        }
      }),
    );

    const commands = this.getCommands(ctx.name, basePath, ctx.isReadOnly || ctx.db.isReadOnly);

    return {
      tables,
      columns,
      indexes,
      foreignKeys,
      commands,
    };
  }

  /**
   * Computes a relevance match score between a target string and a search query.
   */
  private static calculateScore(target: string, query: string): number {
    if (!target || !query) return 0;
    const t = target.toLowerCase();
    const q = query.toLowerCase();

    if (t === q) return 100;
    if (t.startsWith(q)) return 85;
    if (t.includes(`_${q}`) || t.includes(`-${q}`) || t.includes(`.${q}`) || t.includes(` ${q}`)) return 75;
    if (t.includes(q)) return 50;

    // Fuzzy character matching
    let qIdx = 0;
    for (let i = 0; i < t.length && qIdx < q.length; i++) {
      if (t[i] === q[qIdx]) qIdx++;
    }
    if (qIdx === q.length) return 25;

    return 0;
  }

  /**
   * Searches tables, columns, indexes, foreign keys, commands, and row data.
   */
  static async search(ctx: DatabaseContext, rawQuery: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const q = String(rawQuery ?? '').trim();
    const basePath = options.basePath ?? '';
    const type = options.type ? options.type.toLowerCase() : 'all';
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    const includeRows = options.includeRows !== false;
    const encDb = encodeURIComponent(ctx.name);

    const metadata = await this.getMetadataIndex(ctx, basePath);
    const results: SearchItem[] = [];

    const shouldSearch = (category: SearchCategory): boolean => {
      if (type === 'all') return true;
      if (type === 'tables' || type === 'table') return category === 'table';
      if (type === 'columns' || type === 'column') return category === 'column';
      if (type === 'indexes' || type === 'index') return category === 'index';
      if (type === 'relations' || type === 'relation' || type === 'foreignkeys') return category === 'relation';
      if (type === 'commands' || type === 'command') return category === 'command';
      if (type === 'rows' || type === 'row' || type === 'data') return category === 'row';
      return false;
    };

    // 1. Search Tables
    if (shouldSearch('table')) {
      for (const table of metadata.tables) {
        const score = q ? this.calculateScore(table.name, q) : 50;
        if (score > 0 || !q) {
          const encTable = encodeURIComponent(table.name);
          results.push({
            id: `tbl-${table.name}`,
            category: 'table',
            title: table.name,
            subtitle: `Table · ${table.columnsCount} columns${table.primaryKey.length ? ` · PK (${table.primaryKey.join(', ')})` : ''}`,
            icon: 'table',
            url: `${basePath}/tables/${encDb}/${encTable}`,
            score: score + 15, // bonus for tables
            badge: 'Table',
            badgeType: 'primary',
            actions: [
              { label: 'Browse', url: `${basePath}/tables/${encDb}/${encTable}`, primary: true },
              { label: 'Schema', url: `${basePath}/schema/${encDb}/${encTable}` },
              { label: 'Query', url: `${basePath}/query/${encDb}?sql=${encodeURIComponent(`SELECT * FROM ${table.name} LIMIT 100;`)}` },
            ],
            metadata: {
              table: table.name,
              columnsCount: table.columnsCount,
              primaryKey: table.primaryKey,
            },
          });
        }
      }
    }

    // 2. Search Columns
    if (shouldSearch('column')) {
      for (const col of metadata.columns) {
        let score = 0;
        if (q) {
          const nameScore = this.calculateScore(col.name, q);
          const fullScore = this.calculateScore(`${col.table}.${col.name}`, q);
          const typeScore = this.calculateScore(col.type, q) > 70 ? 40 : 0;
          score = Math.max(nameScore, fullScore, typeScore);
        } else {
          score = 30;
        }

        if (score > 0 || !q) {
          const encTable = encodeURIComponent(col.table);
          const pkTag = col.isPk ? ' · Primary Key' : '';
          const fkTag = col.isFk ? ` · FK → ${col.fkTarget}` : '';
          const nullTag = col.notnull ? ' · NOT NULL' : '';
          const dfltTag = col.dflt_value ? ` · default ${col.dflt_value}` : '';

          results.push({
            id: `col-${col.table}-${col.name}`,
            category: 'column',
            title: col.name,
            subtitle: `${col.table} · ${col.type}${pkTag}${fkTag}${nullTag}${dfltTag}`,
            icon: 'columns',
            url: `${basePath}/tables/${encDb}/${encTable}`,
            score: score + 10,
            badge: col.isPk ? 'PK' : col.isFk ? 'FK' : col.type,
            badgeType: col.isPk ? 'accent' : col.isFk ? 'info' : 'neutral',
            actions: [
              { label: 'Browse Table', url: `${basePath}/tables/${encDb}/${encTable}`, primary: true },
              { label: 'View Schema', url: `${basePath}/schema/${encDb}/${encTable}` },
            ],
            metadata: {
              table: col.table,
              column: col.name,
              type: col.type,
              isPk: col.isPk,
              isFk: col.isFk,
              fkTarget: col.fkTarget,
            },
          });
        }
      }
    }

    // 3. Search Indexes
    if (shouldSearch('index')) {
      for (const idx of metadata.indexes) {
        let score = 0;
        if (q) {
          const nameScore = this.calculateScore(idx.name, q);
          const colsScore = idx.columns.some((c) => this.calculateScore(c, q) > 60) ? 60 : 0;
          score = Math.max(nameScore, colsScore);
        } else {
          score = 25;
        }

        if (score > 0 || !q) {
          const encTable = encodeURIComponent(idx.table);
          results.push({
            id: `idx-${idx.table}-${idx.name}`,
            category: 'index',
            title: idx.name,
            subtitle: `${idx.table} (${idx.columns.join(', ')}) · ${idx.unique ? 'UNIQUE ' : ''}Index`,
            icon: 'key',
            url: `${basePath}/schema/${encDb}/${encTable}`,
            score,
            badge: idx.unique ? 'Unique Index' : 'Index',
            badgeType: idx.unique ? 'warning' : 'neutral',
            actions: [
              { label: 'View in Schema', url: `${basePath}/schema/${encDb}/${encTable}`, primary: true },
              { label: 'Browse Table', url: `${basePath}/tables/${encDb}/${encTable}` },
            ],
            metadata: {
              table: idx.table,
              index: idx.name,
              unique: idx.unique,
              columns: idx.columns,
            },
          });
        }
      }
    }

    // 4. Search Foreign Keys / Relations
    if (shouldSearch('relation')) {
      for (const fk of metadata.foreignKeys) {
        let score = 0;
        if (q) {
          const fromScore = this.calculateScore(`${fk.fromTable}.${fk.fromColumn}`, q);
          const toScore = this.calculateScore(`${fk.toTable}.${fk.toColumn || 'id'}`, q);
          score = Math.max(fromScore, toScore);
        } else {
          score = 25;
        }

        if (score > 0 || !q) {
          const fromEnc = encodeURIComponent(fk.fromTable);
          results.push({
            id: `fk-${fk.fromTable}-${fk.fromColumn}-${fk.toTable}`,
            category: 'relation',
            title: `${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn || 'id'}`,
            subtitle: `Foreign Key · ON UPDATE ${fk.onUpdate}, ON DELETE ${fk.onDelete}`,
            icon: 'diagram',
            url: `${basePath}/erd/${encDb}`,
            score,
            badge: 'Relation',
            badgeType: 'info',
            actions: [
              { label: 'View ERD', url: `${basePath}/erd/${encDb}`, primary: true },
              { label: `Browse ${fk.fromTable}`, url: `${basePath}/tables/${encDb}/${fromEnc}` },
            ],
            metadata: {
              fromTable: fk.fromTable,
              fromColumn: fk.fromColumn,
              toTable: fk.toTable,
              toColumn: fk.toColumn,
            },
          });
        }
      }
    }

    // 5. Search Commands
    if (shouldSearch('command')) {
      for (const cmd of metadata.commands) {
        let score = 0;
        if (q) {
          const titleScore = this.calculateScore(cmd.title, q);
          const descScore = this.calculateScore(cmd.description, q) > 70 ? 40 : 0;
          const kwScore = cmd.keywords.some((k) => this.calculateScore(k, q) > 70) ? 70 : 0;
          score = Math.max(titleScore, descScore, kwScore);
        } else {
          score = 45; // Commands show nicely when query is empty
        }

        if (score > 0 || !q) {
          results.push({
            id: cmd.id,
            category: 'command',
            title: cmd.title,
            subtitle: cmd.description,
            icon: cmd.icon,
            url: cmd.url,
            score: score + 5,
            badge: 'Command',
            badgeType: 'secondary',
            actions: [{ label: 'Execute', url: cmd.url, primary: true }],
            metadata: {
              keywords: cmd.keywords,
            },
          });
        }
      }
    }

    // 6. Deep Row Search (if query >= 2 characters)
    if (q.length >= 2 && includeRows && shouldSearch('row')) {
      try {
        const rowResults = await this.searchRowData(ctx, q, metadata.tables, metadata.columns, basePath, limit);
        results.push(...rowResults);
      } catch {
        // Deep row search failure should not break metadata search
      }
    }

    // Sort by relevance score descending
    results.sort((a, b) => b.score - a.score);

    // Compute category counts
    const categoryCounts: Record<SearchCategory, number> = {
      table: 0,
      column: 0,
      index: 0,
      relation: 0,
      command: 0,
      row: 0,
    };

    for (const r of results) {
      categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
    }

    const slicedResults = results.slice(0, limit);

    return {
      query: q,
      total: results.length,
      categories: categoryCounts,
      results: slicedResults,
    };
  }

  /**
   * Performs safe row content search across text columns in tables.
   */
  private static async searchRowData(
    ctx: DatabaseContext,
    query: string,
    tables: TableSummary[],
    columns: ColumnSummary[],
    basePath: string,
    limit: number,
  ): Promise<SearchItem[]> {
    const rowResults: SearchItem[] = [];
    const encDb = encodeURIComponent(ctx.name);
    const maxTablesToSearch = 12;
    const maxRowsPerTable = 3;

    // Filter tables and their text-like columns
    const searchableTables = tables.slice(0, maxTablesToSearch);

    for (const table of searchableTables) {
      if (rowResults.length >= limit) break;

      const textCols = columns.filter(
        (c) =>
          c.table === table.name &&
          /(text|char|varchar|nvarchar|string|clob|json|blob)/i.test(c.type || 'TEXT'),
      );

      if (textCols.length === 0) continue;

      const colNames = textCols.map((c) => c.name);
      // Construct WHERE clause searching text columns
      const whereClauses = colNames.map((c) => `${quoteIdentifier(c)} LIKE ?`).join(' OR ');
      const params = colNames.map(() => `%${query}%`);

      const selectSql = `SELECT rowid AS _rowid_, * FROM ${quoteIdentifier(table.name)} WHERE ${whereClauses} LIMIT ${maxRowsPerTable}`;

      try {
        const res = await ctx.db.all<Record<string, unknown>>(selectSql, params as any);
        if (res.success && Array.isArray(res.data)) {
          for (const row of res.data) {
            // Find which column matched
            let matchedCol = colNames[0];
            let matchedVal = '';

            for (const colName of colNames) {
              const val = String(row[colName] ?? '');
              if (val.toLowerCase().includes(query.toLowerCase())) {
                matchedCol = colName;
                matchedVal = val;
                break;
              }
            }

            // Generate representative snippet
            const snippet = matchedVal.length > 80 ? `${matchedVal.slice(0, 80)}…` : matchedVal;
            const rowId = row._rowid_ ?? row.id ?? row[table.primaryKey[0]] ?? '';
            const encTable = encodeURIComponent(table.name);

            rowResults.push({
              id: `row-${table.name}-${rowId}-${matchedCol}`,
              category: 'row',
              title: `${table.name}${rowId ? ` #${rowId}` : ''}: ${matchedCol} = "${snippet}"`,
              subtitle: `Row data match in ${table.name}.${matchedCol}`,
              icon: 'inspect',
              url: `${basePath}/tables/${encDb}/${encTable}`,
              score: 35,
              badge: 'Row Data',
              badgeType: 'neutral',
              actions: [
                { label: 'Browse Table', url: `${basePath}/tables/${encDb}/${encTable}`, primary: true },
              ],
              metadata: {
                table: table.name,
                column: matchedCol,
                value: snippet,
                row,
              },
            });
          }
        }
      } catch {
        // Skip tables that throw (e.g. lack of rowid or permissions)
      }
    }

    return rowResults;
  }
}
