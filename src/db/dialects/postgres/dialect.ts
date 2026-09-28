import { quoteIdentifier } from '../../../sql/generator';
import type { DialectCapabilities, IDialect } from '../types';
import { POSTGRES_CAPABILITIES } from '../types';
import { PostgresDdlGenerator } from './ddl';
import { PostgresIntrospector } from './introspector';
import { mapPostgresColumnType, POSTGRES_DESIGNER_TYPES } from './types';

export class PostgresDialect implements IDialect {
  readonly name = 'postgres' as const;
  readonly capabilities: DialectCapabilities = POSTGRES_CAPABILITIES;
  readonly introspector: PostgresIntrospector;
  readonly ddl = new PostgresDdlGenerator();

  constructor(schema = 'public') {
    this.introspector = new PostgresIntrospector(schema);
  }

  quoteIdentifier(identifier: string): string {
    return quoteIdentifier(identifier);
  }

  mapType(type: string) {
    return mapPostgresColumnType(type);
  }

  getDesignerTypes(): readonly string[] {
    return POSTGRES_DESIGNER_TYPES;
  }
}

export const postgresDialect = new PostgresDialect();
