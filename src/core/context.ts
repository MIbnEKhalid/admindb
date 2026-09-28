import type { Logger } from '../utils/logger';
import type { IDatabase } from '../db/types';
import type { IDialect, DialectCapabilities } from '../db/dialects/types';

export interface DatabaseContext {
  /** Stable database identifier (slug or connection name) */
  readonly id: string;
  /** Display name of the database */
  readonly name: string;
  /** Sanitized path or connection URI */
  readonly path: string;
  /** Database instance providing driver execution and legacy IDatabase interface */
  readonly db: IDatabase;
  /** Engine-specific dialect (introspection + DDL) */
  readonly dialect: IDialect;
  /** Static capabilities of this database engine */
  readonly capabilities: DialectCapabilities;
  /** Effective read-only status for this database */
  readonly isReadOnly: boolean;
  /** Scoped logger */
  readonly logger: Logger;
}
