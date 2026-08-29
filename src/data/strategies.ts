import type { ColumnInfo, ForeignKeyInfo } from '../db/index';
import { createPrng } from './prng';
import { generateColumnValue, GeneratorRegistry, formatPattern as regFormatPattern, isTextishType as regIsTextishType, makeAddress as regMakeAddress, makeAvatar as regMakeAvatar, makeColor as regMakeColor, makeCreditCard as regMakeCreditCard, makeEmail as regMakeEmail, makeIp as regMakeIp, makeJsonObject as regMakeJsonObject, makeMacAddress as regMakeMacAddress, makeParagraph as regMakeParagraph, makePhone as regMakePhone, makeSentences as regMakeSentences, makeSlug as regMakeSlug, makeUsername as regMakeUsername, makeUuid as regMakeUuid, makeWords as regMakeWords, randomAlnum as regRandomAlnum, randomDate as regRandomDate, randomTime as regRandomTime, randomUnixTimestamp as regRandomUnixTimestamp } from './registry';
import { SKIP, type ColumnPlan, type StrategyDescriptor } from './types';

const defaultPrng = createPrng();

// Random helpers for test compatibility
export const randInt = (min: number, max: number): number => defaultPrng.int(min, max);
export const randFloat = (min: number, max: number): number => defaultPrng.float(min, max);
export const pick = <T>(arr: readonly T[]): T => defaultPrng.pick(arr);

export const makeSlug = (): string => regMakeSlug(defaultPrng);
export const makeEmail = (idx?: number): string => regMakeEmail(defaultPrng, idx);
export const makeUsername = (idx?: number): string => regMakeUsername(defaultPrng, idx);
export const makePhone = (): string => regMakePhone(defaultPrng);
export const makeAddress = (): string => regMakeAddress(defaultPrng);
export const makeIp = (): string => regMakeIp(defaultPrng);
export const makeMacAddress = (): string => regMakeMacAddress(defaultPrng);
export const makeCreditCard = (): string => regMakeCreditCard(defaultPrng);
export const makeAvatar = (seedVal?: string): string => regMakeAvatar(defaultPrng, seedVal);
export const makeColor = (format = 'hex'): string => regMakeColor(defaultPrng, format);
export const makeUuid = (): string => regMakeUuid(defaultPrng);
export const makeWords = (minLen: number, maxLen: number): string => regMakeWords(defaultPrng, minLen, maxLen);
export const makeSentences = (minLen: number, maxLen: number): string => regMakeSentences(defaultPrng, minLen, maxLen);
export const makeParagraph = (): string => regMakeParagraph(defaultPrng);
export const formatPattern = (pattern: string): string => regFormatPattern(pattern, defaultPrng);
export const randomDate = (from?: string, to?: string, kind: 'date' | 'datetime' = 'date'): string =>
  regRandomDate(defaultPrng, from, to, kind);
export const randomTime = (): string => regRandomTime(defaultPrng);
export const randomUnixTimestamp = (format = 'sec', from?: string, to?: string): number =>
  regRandomUnixTimestamp(defaultPrng, format, from, to);
export const randomAlnum = (minLen: number, maxLen: number): string => regRandomAlnum(defaultPrng, minLen, maxLen);
export const makeJsonObject = (keys?: string[], jsonValues?: Record<string, string[]>): string =>
  regMakeJsonObject(defaultPrng, keys, jsonValues);
export const isTextishType = regIsTextishType;

/**
 * Returns available strategy choices for a database column.
 */
export function strategiesFor(col: ColumnInfo, fk: ForeignKeyInfo | null): StrategyDescriptor[] {
  return GeneratorRegistry.getDescriptorsFor(col, fk);
}

/**
 * Fallback generator plan for a column when no specific heuristic matches.
 */
export function fallbackPlanFor(col: ColumnInfo): ColumnPlan {
  const type = (col.type || '').toUpperCase();
  if (type === 'BOOLEAN' || type === 'BOOL') return { strategy: 'bool' };
  if (type === 'UUID') return { strategy: 'uuid' };
  if (type === 'JSON' || type === 'JSONB') return { strategy: 'json' };
  if (type.startsWith('INT') || type === 'BIGINT' || type === 'SMALLINT' || type === 'SERIAL' || type === 'BIGSERIAL') {
    return { strategy: 'int', min: 1, max: 1000 };
  }
  if (type === 'REAL' || type.includes('DECIMAL') || type === 'NUMERIC' || type.includes('FLOAT') || type.includes('DOUBLE')) {
    return { strategy: 'decimal', min: 1, max: 1000, precision: 2 };
  }
  if (type === 'DATE') return { strategy: 'date', from: '2020-01-01', to: '2026-12-31' };
  if (type.includes('TIMESTAMP') || type === 'DATETIME') return { strategy: 'datetime', from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' };
  if (type === 'TIME') return { strategy: 'time' };
  if (type === 'BLOB' || type === 'BYTEA') return { strategy: 'bytes', minLen: 8, maxLen: 32 };
  if (type === 'INET') return { strategy: 'ip' };
  return { strategy: 'words', minLen: 1, maxLen: 4 };
}

/**
 * Generate a single value for a column.
 */
export function generateOne(
  col: ColumnInfo,
  plan: ColumnPlan,
  fkPool?: unknown[],
  rowIndex = 0,
): unknown {
  return generateColumnValue(col, plan, defaultPrng, rowIndex, {}, fkPool);
}

/**
 * Generate a formatted sample display string for a column.
 */
export function generateSampleValue(col: ColumnInfo, plan: ColumnPlan, fkPool?: unknown[]): unknown {
  const v = generateOne(col, plan, fkPool || ['[FK sample]'], 0);
  if (v === SKIP) return '(omitted / default)';
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `0x${Buffer.from(v).toString('hex').slice(0, 16)}...`;
  return v;
}
