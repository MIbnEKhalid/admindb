import { quoteIdentifier } from '../../../sql/generator';
import type { DialectCapabilities, IDialect } from '../types';
import { SQLITE_CAPABILITIES } from '../types';
import { SqliteDdlGenerator } from './ddl';
import { SqliteIntrospector } from './introspector';
import { mapSqliteColumnType, SQLITE_DESIGNER_TYPES } from './types';

export class SqliteDialect implements IDialect {
  readonly name = 'sqlite' as const;
  readonly capabilities: DialectCapabilities = SQLITE_CAPABILITIES;
  readonly introspector = new SqliteIntrospector();
  readonly ddl = new SqliteDdlGenerator();

  quoteIdentifier(identifier: string): string {
    return quoteIdentifier(identifier);
  }

  mapType(type: string) {
    return mapSqliteColumnType(type);
  }

  getDesignerTypes(): readonly string[] {
    return SQLITE_DESIGNER_TYPES;
  }
}

export const sqliteDialect = new SqliteDialect();
