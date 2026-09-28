/**
 * Core result and primitive value types used across admindb.
 */

export type SQLInputValue = null | number | bigint | string | boolean | Uint8Array | Buffer | Date;

export interface Result<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MutationResult {
  changes?: number;
  lastInsertRowid?: number | null;
}

export function okResult<T>(data?: T): Result<T> {
  return { success: true, ...(data !== undefined ? { data } : {}) };
}

export function errResult<T = never>(error: string): Result<T> {
  return { success: false, error };
}
