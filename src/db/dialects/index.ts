export * from './types';
export * from './sqlite/dialect';
export * from './sqlite/types';
export * from './sqlite/introspector';
export * from './sqlite/ddl';
export * from './postgres/dialect';
export * from './postgres/types';
export * from './postgres/introspector';
export * from './postgres/ddl';

import { sqliteDialect, SqliteDialect } from './sqlite/dialect';
import { postgresDialect, PostgresDialect } from './postgres/dialect';
import type { IDialect } from './types';

export function getDialect(name: 'sqlite' | 'postgres', schema?: string): IDialect {
  if (name === 'postgres') {
    return schema && schema !== 'public' ? new PostgresDialect(schema) : postgresDialect;
  }
  return sqliteDialect;
}
