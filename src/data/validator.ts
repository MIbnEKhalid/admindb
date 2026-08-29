import type { IDatabase, TableInfoData } from '../db/index';
import { extractTemplateDependencies, orderColumnDependencies } from './templates';
import type { ColumnPlan, GenerationPlan, ValidationIssue, ValidationReport } from './types';

/**
 * Pre-flight Validator for Generation Plans.
 */
export async function validateGenerationPlan(
  db: IDatabase,
  plan: GenerationPlan,
  tableInfos?: Map<string, TableInfoData>,
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const infos = tableInfos ?? new Map<string, TableInfoData>();

  // 1. Fetch metadata for all tables in plan if not already supplied
  for (const tableName of Object.keys(plan.tables)) {
    if (!infos.has(tableName)) {
      try {
        const res = await db.getTableInfo(tableName);
        if (res.success && res.data?.columns?.length) {
          infos.set(tableName, res.data);
        } else {
          issues.push({
            type: 'error',
            table: tableName,
            message: `Table "${tableName}" does not exist in the database.`,
            code: 'TABLE_NOT_FOUND',
          });
        }
      } catch (err) {
        issues.push({
          type: 'error',
          table: tableName,
          message: `Failed to inspect table "${tableName}": ${err instanceof Error ? err.message : String(err)}`,
          code: 'TABLE_INSPECT_ERROR',
        });
      }
    }
  }

  let estimatedTotalRows = 0;
  let tablesToGenerate = 0;
  let tablesToUseExisting = 0;
  let tablesToSkip = 0;

  // 2. Validate per-table configurations
  for (const [tableName, spec] of Object.entries(plan.tables)) {
    const info = infos.get(tableName);
    if (!info) continue;

    const mode = spec.mode || 'generate';
    const rowCount = Math.max(0, spec.rows ?? 10);

    if (mode === 'generate') {
      tablesToGenerate++;
      estimatedTotalRows += rowCount;
    } else if (mode === 'use_existing') {
      tablesToUseExisting++;
    } else if (mode === 'generate_if_empty') {
      try {
        const cRes = await db.getRowCount(tableName);
        const curCount = cRes.success && typeof cRes.data === 'number' ? cRes.data : 0;
        if (curCount === 0) {
          tablesToGenerate++;
          estimatedTotalRows += rowCount;
        } else {
          tablesToUseExisting++;
        }
      } catch {
        tablesToGenerate++;
        estimatedTotalRows += rowCount;
      }
    } else {
      tablesToSkip++;
    }

    if (mode === 'skip' || mode === 'use_existing') continue;

    const colMap = new Map(info.columns.map((c) => [c.name, c]));
    const fkMap = new Map(info.foreignKeys.map((fk) => [fk.from, fk]));

    const colNames = info.columns.map((c) => c.name);
    const { hasCycle, cycleColumns } = orderColumnDependencies(colNames, spec.columns || {});
    if (hasCycle) {
      issues.push({
        type: 'error',
        table: tableName,
        message: `Circular column template dependency detected in table "${tableName}" between columns: ${cycleColumns.join(', ')}`,
        code: 'TEMPLATE_CYCLE',
      });
    }

    for (const col of info.columns) {
      const p: ColumnPlan = spec.columns[col.name] || { strategy: 'skip' };

      if (p.strategy === 'template' && p.template) {
        for (const dep of extractTemplateDependencies(p.template)) {
          if (!colMap.has(dep)) {
            issues.push({
              type: 'warning',
              table: tableName,
              column: col.name,
              message: `Template in column "${col.name}" references non-existent column "${dep}".`,
              code: 'TEMPLATE_INVALID_REF',
            });
          }
        }
      }

      const isReq = Boolean(col.notnull || (col.pk ?? 0) > 0);
      if (isReq && col.dflt_value == null) {
        if (p.strategy === 'null') {
          issues.push({
            type: 'error',
            table: tableName,
            column: col.name,
            message: `Column "${col.name}" is NOT NULL without a default value, but strategy is set to NULL.`,
            code: 'NOT_NULL_VIOLATION',
          });
        }
        if (p.strategy === 'skip' && !col.pk) {
          issues.push({
            type: 'warning',
            table: tableName,
            column: col.name,
            message: `Column "${col.name}" is NOT NULL without a default value, but strategy is set to Skip (database default).`,
            code: 'NOT_NULL_SKIP',
          });
        }
      }

      const fk = fkMap.get(col.name);
      if (p.strategy === 'fk' && fk) {
        const parentSpec = plan.tables[fk.table];
        if (parentSpec?.mode === 'skip') {
          try {
            const countRes = await db.getRowCount(fk.table);
            const parentRows = countRes.success && typeof countRes.data === 'number' ? countRes.data : 0;
            if (parentRows === 0 && (col.notnull || (col.pk ?? 0) > 0)) {
              issues.push({
                type: 'error',
                table: tableName,
                column: col.name,
                message: `Foreign key "${col.name}" references table "${fk.table}" which is set to "Don't Touch" and is currently empty.`,
                code: 'FK_EMPTY_PARENT',
              });
            }
          } catch {}
        }
      }
    }
  }

  const errors = issues.filter((i) => i.type === 'error');
  const valid = errors.length === 0;

  return {
    valid,
    canExecute: valid,
    issues,
    summary: {
      totalTables: Object.keys(plan.tables).length,
      tablesToGenerate,
      tablesToUseExisting,
      tablesToSkip,
      estimatedTotalRows,
      cyclesDetected: false,
      cycleTables: [],
      executionOrder: Object.keys(plan.tables),
    },
  };
}
