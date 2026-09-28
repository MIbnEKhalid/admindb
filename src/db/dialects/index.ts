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

export interface DialectAdapter<D = unknown> {
  readonly id: string;
  readonly name: string;
  getDialect(schema?: string): IDialect<D>;
}

export class DialectRegistry {
  private static adapters = new Map<string, DialectAdapter>();

  static register(adapter: DialectAdapter): void {
    this.adapters.set(adapter.id.toLowerCase(), adapter);
  }

  static get(name: string): DialectAdapter | undefined {
    return this.adapters.get(name.toLowerCase());
  }

  static list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

// Register default built-in dialects
DialectRegistry.register({
  id: 'sqlite',
  name: 'SQLite',
  getDialect: () => sqliteDialect,
});

DialectRegistry.register({
  id: 'postgres',
  name: 'PostgreSQL',
  getDialect: (schema?: string) => (schema && schema !== 'public' ? new PostgresDialect(schema) : postgresDialect),
});

export function getDialect(name: 'sqlite' | 'postgres' | string, schema?: string): IDialect {
  const adapter = DialectRegistry.get(name);
  if (adapter) return adapter.getDialect(schema);
  return sqliteDialect;
}

