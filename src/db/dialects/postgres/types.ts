export const POSTGRES_DESIGNER_TYPES = [
  'TEXT',
  'VARCHAR(255)',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'SERIAL',
  'BIGSERIAL',
  'REAL',
  'DECIMAL(10,2)',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TIME',
  'INTERVAL',
  'JSON',
  'JSONB',
  'UUID',
  'BYTEA',
  'INET',
] as const;

import type { MappedType } from '../types';
export type { MappedType };

export function mapPostgresColumnType(type: string): MappedType {
  const t = String(type ?? '').trim().toUpperCase();
  if (!t) return { sqlType: 'TEXT' };

  switch (t) {
    case 'INT':
    case 'INTEGER':
      return { sqlType: 'INTEGER' };
    case 'BIGINT':
    case 'SMALLINT':
    case 'SERIAL':
    case 'BIGSERIAL':
    case 'SMALLSERIAL':
      return { sqlType: t };
    case 'TEXT':
    case 'VARCHAR':
    case 'CHAR':
    case 'CITEXT':
      return { sqlType: 'TEXT' };
    case 'REAL':
    case 'FLOAT':
    case 'DOUBLE PRECISION':
    case 'DECIMAL':
    case 'NUMERIC':
    case 'MONEY':
      return { sqlType: 'NUMERIC' };
    case 'BYTEA':
    case 'BLOB':
      return { sqlType: 'BYTEA' };
    case 'BOOLEAN':
    case 'BOOL':
      return { sqlType: 'BOOLEAN' };
    case 'DATE':
      return { sqlType: 'DATE', defaultAuto: 'CURRENT_DATE' };
    case 'DATETIME':
    case 'TIMESTAMP':
      return { sqlType: 'TIMESTAMP' };
    case 'TIMESTAMPTZ':
      return { sqlType: 'TIMESTAMPTZ', defaultAuto: 'CURRENT_TIMESTAMP' };
    case 'TIME':
    case 'TIMETZ':
    case 'INTERVAL':
    case 'JSON':
    case 'JSONB':
    case 'UUID':
    case 'INET':
    case 'CIDR':
    case 'MACADDR':
      return { sqlType: t };
    default:
      if (/^[A-Za-z0-9_(),\s\[\]]+$/.test(t)) return { sqlType: t };
      return { sqlType: 'TEXT' };
  }
}
