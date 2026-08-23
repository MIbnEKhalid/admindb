import { randomBytes } from 'node:crypto';
import type { ColumnInfo, ForeignKeyInfo } from '../db/index';
import { coerceFormValue } from '../utils/common';
import {
  CITIES,
  COMPANIES,
  COUNTRIES,
  COUNTRY_CODES,
  CURRENCIES,
  DOMAINS,
  FIRST_NAMES,
  HEX_COLORS,
  JOB_TITLES,
  LAST_NAMES,
  LOREM_WORDS,
  NAMED_COLORS,
  STATUSES,
  US_STATES,
} from './datasets';
import {
  SKIP,
  type ColumnPlan,
  type GeneratorStrategyId,
  type StrategyCategory,
  type StrategyDescriptor,
} from './types';

// ---- Random helpers -------------------------------------------------------

export const randInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;
export const randFloat = (min: number, max: number): number => Math.random() * (max - min) + min;
export const pick = <T>(arr: T[]): T => arr[randInt(0, arr.length - 1)];

export const makeSlug = (): string => `${pick(LOREM_WORDS)}-${pick(LOREM_WORDS)}-${randInt(100, 999)}`;
export const makeEmail = (idx?: number): string =>
  `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}${idx != null ? idx + 1 : ''}${randInt(10, 9999)}@${pick(DOMAINS)}`;
export const makeUsername = (idx?: number): string =>
  `${pick(FIRST_NAMES).toLowerCase()}${pick(LAST_NAMES).toLowerCase()}${idx != null ? idx + 1 : ''}${randInt(10, 9999)}`;
export const makePhone = (): string => `+1 (${randInt(200, 999)}) ${randInt(200, 999)}-${String(randInt(0, 9999)).padStart(4, '0')}`;
export const makeAddress = (): string => `${randInt(10, 9999)} ${pick(LOREM_WORDS)} ${pick(['St', 'Ave', 'Rd', 'Blvd', 'Ln', 'Dr'])}, ${pick(CITIES)}`;
export const makeIp = (): string => `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;

export function makeMacAddress(): string {
  const b = () => randInt(0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `${b()}:${b()}:${b()}:${b()}:${b()}:${b()}`;
}

export const makeCreditCard = (): string => `4532-${randInt(1000, 9999)}-${randInt(1000, 9999)}-${randInt(1000, 9999)}`;
export const makeAvatar = (seedVal?: string): string => `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seedVal || makeUsername())}`;
export const makeColor = (format = 'hex'): string => (format === 'name' ? pick(NAMED_COLORS) : pick(HEX_COLORS));

export function makeUuid(): string {
  const h = (n: number) => randInt(0, 0xffffffff).toString(16).padStart(n, '0');
  return `${h(8)}-${h(4).slice(0, 4)}-4${h(3).slice(0, 3)}-${['8', '9', 'a', 'b'][randInt(0, 3)]}${h(3).slice(0, 3)}-${h(12).slice(0, 12)}`;
}

export function makeWords(minLen: number, maxLen: number): string {
  const n = randInt(minLen, maxLen);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(pick(LOREM_WORDS));
  return parts.join(' ');
}

export function makeSentences(minLen: number, maxLen: number): string {
  const n = randInt(minLen, maxLen);
  const sentences: string[] = [];
  for (let i = 0; i < n; i++) {
    const words = makeWords(6, 14).split(' ');
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    sentences.push(words.join(' ') + '.');
  }
  return sentences.join(' ');
}

export const makeParagraph = (): string => makeSentences(3, 5);

export function formatPattern(pattern: string): string {
  if (!pattern) return '';
  const now = new Date();
  const year = String(now.getFullYear());
  const s = pattern
    .replace(/\{YYYY\}/g, year)
    .replace(/\{YY\}/g, year.slice(-2))
    .replace(/\{MM\}/g, String(randInt(1, 12)).padStart(2, '0'))
    .replace(/\{DD\}/g, String(randInt(1, 28)).padStart(2, '0'));

  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  let res = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '#') res += randInt(0, 9);
    else if (ch === 'A' || ch === '?') res += upper[randInt(0, 25)];
    else if (ch === 'a') res += lower[randInt(0, 25)];
    else res += ch;
  }
  return res;
}

export function randomDate(from?: string, to?: string, kind: 'date' | 'datetime' = 'date'): string {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const d = new Date(randInt(Number.isFinite(lo) ? lo : now - 730 * 86400_000, Number.isFinite(hi) ? hi : now));
  if (kind === 'datetime') return d.toISOString();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const randomTime = (): string =>
  `${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}`;

export function randomUnixTimestamp(format = 'sec', from?: string, to?: string): number {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const t = randInt(Number.isFinite(lo) ? lo : now - 730 * 86400_000, Number.isFinite(hi) ? hi : now);
  return format === 'ms' ? t : Math.floor(t / 1000);
}

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function randomAlnum(minLen: number, maxLen: number): string {
  const len = randInt(minLen, maxLen);
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[randInt(0, ALNUM.length - 1)];
  return s;
}

const JSON_ROLES = ['admin', 'editor', 'viewer', 'billing', 'member', 'owner', 'guest'];
const JSON_APPS = ['dashboard', 'api', 'mobile', 'cli', 'webhook', 'cron', 'importer'];

function jsonValueForKey(key: string): unknown {
  const lk = key.toLowerCase();
  if (lk.includes('role')) return pick(JSON_ROLES);
  if (lk.includes('app')) return [pick(JSON_APPS)];
  const roll = Math.random();
  if (roll < 0.45) return pick(['alpha', 'beta', 'stable', 'draft', 'on', 'off', 'default', 'custom']);
  if (roll < 0.6) return randInt(0, 1000);
  if (roll < 0.75) return Math.random() < 0.5;
  if (roll < 0.9) return null;
  return makeUuid();
}

export function makeJsonObject(keys?: string[], jsonValues?: Record<string, string[]>): string {
  const k = (keys && keys.length ? keys : ['scope', 'enabled', 'flags']).slice(0, 16);
  const obj: Record<string, unknown> = {};
  for (const key of k) {
    const allowed = jsonValues ? jsonValues[key] : undefined;
    obj[key] = allowed && allowed.length ? pick(allowed) : jsonValueForKey(key);
  }
  return JSON.stringify(obj);
}

export function isTextishType(type: string): boolean {
  const t = (type || '').toUpperCase();
  return t === 'TEXT' || t === '' || t.includes('JSON') || t.includes('CHAR') || t.includes('CLOB') || t.includes('VARCHAR');
}

/** Registry of strategy descriptors and their supported type categories. */
const STRATEGY_METADATA: [GeneratorStrategyId, string, StrategyCategory, 'all' | 'text' | 'numeric' | 'blob'][] = [
  ['skip', 'Skip (DB default or NULL applies)', 'custom_control', 'all'],
  ['null', 'Set NULL explicitly', 'custom_control', 'all'],
  ['fixed', 'Fixed constant value', 'custom_control', 'all'],
  ['list', 'Random item from custom list', 'custom_control', 'all'],
  ['pattern', 'Custom pattern template (e.g. INV-####)', 'custom_control', 'all'],
  ['fullname', 'Full name (e.g. John Smith)', 'identity', 'text'],
  ['first', 'First name', 'identity', 'text'],
  ['last', 'Last name / Surname', 'identity', 'text'],
  ['username', 'Username handle', 'identity', 'text'],
  ['job', 'Job title / Profession', 'identity', 'text'],
  ['email', 'Email address', 'contact_web', 'text'],
  ['phone', 'Phone number', 'contact_web', 'text'],
  ['url', 'Website URL', 'contact_web', 'text'],
  ['domain', 'Domain name', 'contact_web', 'text'],
  ['ip', 'IPv4 address', 'contact_web', 'text'],
  ['avatar', 'Avatar image URL', 'contact_web', 'text'],
  ['company', 'Company / Organization name', 'commerce', 'text'],
  ['currency', 'Currency code (USD, EUR...)', 'commerce', 'text'],
  ['status', 'Status badge (active, pending...)', 'commerce', 'text'],
  ['creditCard', 'Masked test credit card', 'commerce', 'text'],
  ['address', 'Street address', 'location', 'text'],
  ['city', 'City name', 'location', 'text'],
  ['state', 'State / Province', 'location', 'text'],
  ['country', 'Country name', 'location', 'text'],
  ['countryCode', 'Country code (ISO-2 e.g. US)', 'location', 'text'],
  ['postal', 'Postal / Zip code', 'location', 'text'],
  ['latitude', 'Latitude (-90 to 90)', 'location', 'all'],
  ['longitude', 'Longitude (-180 to 180)', 'location', 'all'],
  ['int', 'Random integer in range', 'numeric', 'numeric'],
  ['decimal', 'Random decimal / price', 'numeric', 'numeric'],
  ['sequence', 'Sequential numbering (1, 2, 3...)', 'numeric', 'numeric'],
  ['date', 'Random date (YYYY-MM-DD)', 'datetime', 'all'],
  ['datetime', 'Random datetime (ISO-8601)', 'datetime', 'all'],
  ['time', 'Random time (HH:MM:SS)', 'datetime', 'all'],
  ['timestampUnix', 'Unix timestamp (epoch)', 'datetime', 'all'],
  ['words', 'Short words / Tags', 'system_crypto', 'text'],
  ['sentence', 'Sentences', 'system_crypto', 'text'],
  ['paragraph', 'Paragraph (multi-sentence text)', 'system_crypto', 'text'],
  ['slug', 'URL slug (e.g. tech-news-402)', 'system_crypto', 'text'],
  ['bool', 'Boolean flag (1/0 or true/false)', 'system_crypto', 'all'],
  ['bytes', 'Random hex bytes (BLOB)', 'system_crypto', 'blob'],
  ['uuid', 'UUID v4', 'system_crypto', 'text'],
  ['token', 'Short alphanumeric token', 'system_crypto', 'text'],
  ['hash', 'Hexadecimal hash (MD5/SHA)', 'system_crypto', 'text'],
  ['json', 'Valid JSON object', 'system_crypto', 'text'],
  ['color', 'Color (Hex code or name)', 'system_crypto', 'text'],
  ['mac', 'MAC network address', 'system_crypto', 'text'],
];

export function strategiesFor(col: ColumnInfo, fk: ForeignKeyInfo | null): StrategyDescriptor[] {
  const type = (col.type || '').toUpperCase();
  const isText = isTextishType(type);
  const isNum = type.startsWith('INTEGER') || type === 'REAL' || type.includes('DECIMAL') || type.includes('NUMERIC') || isText;
  const isBlob = type === 'BLOB' || isText;

  const out: StrategyDescriptor[] = [];
  if (fk) {
    out.push({ id: 'fk', label: `Foreign Key: Sample from ${fk.table}${fk.to ? `.${fk.to}` : ''}`, category: 'relational' });
  }

  for (const [id, label, category, target] of STRATEGY_METADATA) {
    if (target === 'all' || (target === 'text' && isText) || (target === 'numeric' && isNum) || (target === 'blob' && isBlob)) {
      out.push({ id, label, category });
    }
  }
  return out;
}

export function fallbackPlanFor(col: ColumnInfo): ColumnPlan {
  const type = (col.type || '').toUpperCase();
  if (type === 'BOOLEAN' || type === 'BOOL') return { strategy: 'bool' };
  if (type === 'UUID') return { strategy: 'uuid' };
  if (type === 'JSON' || type === 'JSONB') return { strategy: 'json' };
  if (type.startsWith('INT') || type === 'BIGINT' || type === 'SMALLINT' || type === 'SERIAL' || type === 'BIGSERIAL') return { strategy: 'int', min: 1, max: 1000 };
  if (type === 'REAL' || type.includes('DECIMAL') || type === 'NUMERIC' || type.includes('FLOAT') || type.includes('DOUBLE')) return { strategy: 'decimal', min: 1, max: 1000, precision: 2 };
  if (type === 'DATE') return { strategy: 'date', from: '2020-01-01', to: '2026-12-31' };
  if (type.includes('TIMESTAMP') || type === 'DATETIME') return { strategy: 'datetime', from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' };
  if (type === 'TIME') return { strategy: 'time' };
  if (type === 'BLOB' || type === 'BYTEA') return { strategy: 'bytes', minLen: 8, maxLen: 32 };
  if (type === 'INET') return { strategy: 'ip' };
  return { strategy: 'words', minLen: 1, maxLen: 4 };
}


/** Dispatch table for simple strategy generators. */
const BASIC_STRATEGIES: Record<string, (p: ColumnPlan, rowIndex: number) => unknown> = {
  first: () => pick(FIRST_NAMES),
  last: () => pick(LAST_NAMES),
  fullname: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  email: (_, idx) => makeEmail(idx),
  username: (_, idx) => makeUsername(idx),
  job: () => pick(JOB_TITLES),
  company: () => pick(COMPANIES),
  currency: () => pick(CURRENCIES),
  status: () => pick(STATUSES),
  creditCard: () => makeCreditCard(),
  avatar: () => makeAvatar(),
  color: (p) => makeColor(p.format),
  phone: () => makePhone(),
  city: () => pick(CITIES),
  state: () => pick(US_STATES),
  country: () => pick(COUNTRIES),
  countryCode: () => pick(COUNTRY_CODES),
  postal: () => String(randInt(10000, 99999)),
  address: () => makeAddress(),
  url: () => `https://www.${pick(DOMAINS)}/${makeSlug()}`,
  domain: () => pick(DOMAINS),
  ip: () => makeIp(),
  mac: () => makeMacAddress(),
  uuid: () => makeUuid(),
  slug: () => makeSlug(),
  paragraph: () => makeParagraph(),
  time: () => randomTime(),
  bool: () => pick(['1', '0']),
  json: (p) => makeJsonObject(p.jsonKeys, p.jsonValues),
  words: (p) => makeWords(p.minLen ?? 1, p.maxLen ?? 4),
  sentence: (p) => makeSentences(p.minLen ?? 1, p.maxLen ?? 2),
  date: (p) => randomDate(p.from, p.to, 'date'),
  datetime: (p) => randomDate(p.from, p.to, 'datetime'),
  timestampUnix: (p) => randomUnixTimestamp(p.format, p.from, p.to),
  latitude: (p) => Number(randFloat(p.min ?? -90, p.max ?? 90).toFixed(6)),
  longitude: (p) => Number(randFloat(p.min ?? -180, p.max ?? 180).toFixed(6)),
  sequence: (p, idx) => (p.start ?? 1) + idx * (p.step ?? 1),
  int: (p) => randInt(p.min ?? 1, Math.max(p.min ?? 1, p.max ?? 1000)),
  decimal: (p) => randFloat(p.min ?? 1, Math.max(p.min ?? 1, p.max ?? 1000)).toFixed(Math.max(0, Math.min(10, p.precision ?? 2))),
  pattern: (p) => formatPattern(p.pattern || 'INV-2026-####'),
  fixed: (p) => p.value ?? '',
  token: (p) => randomAlnum(Math.max(2, p.minLen ?? 6), Math.max(2, p.maxLen ?? 12)),
  hash: (p) => {
    const len = randInt(Math.max(8, p.minLen ?? 32), Math.max(8, p.maxLen ?? 64));
    return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
  },
};

export function generateOne(
  col: ColumnInfo,
  p: ColumnPlan,
  fkPool?: unknown[],
  rowIndex = 0,
): unknown {
  const type = (col.type || '').toUpperCase();

  if (!col.pk && !col.notnull && p.nullPct && p.nullPct > 0) {
    if (Math.random() * 100 < p.nullPct) return null;
  }

  if (p.strategy === 'skip') return SKIP;
  if (p.strategy === 'null') return null;
  if (p.strategy === 'list') {
    const vals = (p.values ?? []).filter((v) => String(v).trim() !== '');
    if (!vals.length) return SKIP;
    return coerceFormValue(String(pick(vals)), type || 'TEXT');
  }
  if (p.strategy === 'fk') {
    return fkPool && fkPool.length ? fkPool[randInt(0, fkPool.length - 1)] : null;
  }
  if (p.strategy === 'bytes') {
    const len = randInt(Math.max(0, p.minLen ?? 8), Math.max(1, p.maxLen ?? 32));
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = randInt(0, 255);
    return coerceFormValue(`0x${buf.toString('hex')}`, type || 'BLOB');
  }

  const gen = BASIC_STRATEGIES[p.strategy];
  if (!gen) return SKIP;

  let rawVal = gen(p, rowIndex);
  if (rawVal != null && (p.prefix || p.suffix) && typeof rawVal === 'string') {
    rawVal = `${p.prefix || ''}${rawVal}${p.suffix || ''}`;
  }

  return coerceFormValue(String(rawVal), type || 'TEXT');
}

export function generateSampleValue(col: ColumnInfo, plan: ColumnPlan, fkPool?: unknown[]): unknown {
  const v = generateOne(col, plan, fkPool || ['[FK sample]'], 0);
  if (v === SKIP) return '(omitted / default)';
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `0x${Buffer.from(v).toString('hex').slice(0, 16)}...`;
  return v;
}
