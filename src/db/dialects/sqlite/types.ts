export const SQLITE_DESIGNER_TYPES = [
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'NUMERIC',
  'VARCHAR(255)',
  'JSON',
] as const;

import type { MappedType } from '../types';
export type { MappedType };

export function mapSqliteColumnType(type: string): MappedType {
  const t = String(type ?? '').trim().toUpperCase();
  if (!t) return { sqlType: 'TEXT' };

  switch (t) {
    case 'INTEGER':
    case 'INT':
    case 'TINYINT':
    case 'BIGINT':
    case 'SMALLINT':
    case 'SERIAL':
    case 'BIGSERIAL':
    case 'SMALLSERIAL':
      return { sqlType: 'INTEGER' };
    case 'TEXT':
    case 'VARCHAR':
    case 'CHAR':
    case 'CLOB':
    case 'STRING':
    case 'CITEXT':
      return { sqlType: 'TEXT' };
    case 'REAL':
    case 'FLOAT':
    case 'DOUBLE':
    case 'DECIMAL':
    case 'NUMERIC':
    case 'NUMBER':
    case 'MONEY':
      return { sqlType: 'REAL' };
    case 'BLOB':
    case 'BINARY':
    case 'VARBINARY':
    case 'BYTEA':
      return { sqlType: 'BLOB' };
    case 'BOOLEAN':
    case 'BOOL':
      return { sqlType: 'INTEGER' };
    case 'DATE':
      return { sqlType: 'DATETIME', defaultAuto: 'CURRENT_TIMESTAMP' };
    case 'DATETIME':
    case 'TIMESTAMP':
    case 'TIMESTAMPTZ':
    case 'TIME':
    case 'JSON':
    case 'JSONB':
    case 'UUID':
      return { sqlType: t };
    default:
      if (/^[A-Za-z0-9_(),\s\[\]]+$/.test(t)) return { sqlType: t };
      return { sqlType: 'TEXT' };
  }
}
