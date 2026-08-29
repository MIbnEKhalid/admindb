import { randomBytes } from 'node:crypto';
import type { ColumnInfo, ForeignKeyInfo } from '../db/index';
import { coerceFormValue } from '../utils/common';
import { CITIES, COMPANIES, COUNTRIES, COUNTRY_CODES, CURRENCIES, DOMAINS, FIRST_NAMES, HEX_COLORS, JOB_TITLES, LAST_NAMES, LOREM_WORDS, NAMED_COLORS, STATUSES, US_STATES } from './datasets';
import type { RandomSource } from './prng';
import { createPrng } from './prng';
import { SKIP, type ColumnPlan, type GeneratorStrategyId, type StrategyCategory, type StrategyDescriptor } from './types';

export interface GeneratorContext {
  rowIndex: number;
  col: ColumnInfo;
  plan: ColumnPlan;
  prng: RandomSource;
  rowValues?: Record<string, unknown>;
  fkPool?: unknown[];
  sampledPool?: unknown[];
}

export type GeneratorFn = (ctx: GeneratorContext) => unknown;

export interface GeneratorDefinition {
  id: GeneratorStrategyId;
  label: string;
  category: StrategyCategory;
  description: string;
  targetTypes: 'all' | 'text' | 'numeric' | 'blob' | 'date';
  generate: GeneratorFn;
}

export function makeSlug(prng: RandomSource): string {
  return `${prng.pick(LOREM_WORDS)}-${prng.pick(LOREM_WORDS)}-${prng.int(100, 999)}`;
}

function cleanHandle(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

export function makeEmail(prng: RandomSource, idx?: number, rowValues?: Record<string, unknown>): string {
  let handle = '';

  if (rowValues) {
    const fn = rowValues.first_name || rowValues.firstname || rowValues.firstName;
    const ln = rowValues.last_name || rowValues.lastname || rowValues.lastName;
    if (fn && ln) {
      handle = `${cleanHandle(String(fn))}.${cleanHandle(String(ln))}`;
    } else {
      const name = rowValues.full_name || rowValues.fullname || rowValues.fullName || rowValues.name || rowValues.customer_name || rowValues.user_name || rowValues.username;
      if (name) {
        handle = cleanHandle(String(name));
      }
    }
  }

  if (!handle) {
    handle = `${cleanHandle(prng.pick(FIRST_NAMES))}.${cleanHandle(prng.pick(LAST_NAMES))}`;
  }

  const suffix = idx != null && idx > 0 ? `${idx}` : '';
  const domain = prng.pick(DOMAINS);
  return `${handle}${suffix ? `.${suffix}` : ''}@${domain}`;
}

export function makeUsername(prng: RandomSource, idx?: number, rowValues?: Record<string, unknown>): string {
  if (rowValues) {
    const fn = rowValues.first_name || rowValues.firstname || rowValues.firstName;
    const ln = rowValues.last_name || rowValues.lastname || rowValues.lastName;
    if (fn && ln) {
      return `${cleanHandle(String(fn))}${cleanHandle(String(ln))}${idx != null && idx > 0 ? idx : ''}`;
    }
    const name = rowValues.full_name || rowValues.fullname || rowValues.name || rowValues.customer_name;
    if (name) {
      return `${cleanHandle(String(name)).replace(/\./g, '')}${idx != null && idx > 0 ? idx : ''}`;
    }
  }
  return `${prng.pick(FIRST_NAMES).toLowerCase()}${prng.pick(LAST_NAMES).toLowerCase()}${idx != null && idx > 0 ? idx : ''}${prng.int(10, 99)}`;
}

export function makePhone(prng: RandomSource): string {
  return `+1 (${prng.int(200, 999)}) ${prng.int(200, 999)}-${String(prng.int(0, 9999)).padStart(4, '0')}`;
}

export function makeAddress(prng: RandomSource): string {
  return `${prng.int(10, 9999)} ${prng.pick(LOREM_WORDS)} ${prng.pick(['St', 'Ave', 'Rd', 'Blvd', 'Ln', 'Dr'])}, ${prng.pick(CITIES)}`;
}

export function makeIp(prng: RandomSource): string {
  return `${prng.int(1, 223)}.${prng.int(0, 255)}.${prng.int(0, 255)}.${prng.int(1, 254)}`;
}

export function makeMacAddress(prng: RandomSource): string {
  const b = () => prng.int(0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `${b()}:${b()}:${b()}:${b()}:${b()}:${b()}`;
}

export function makeCreditCard(prng: RandomSource): string {
  return `4532-${prng.int(1000, 9999)}-${prng.int(1000, 9999)}-${prng.int(1000, 9999)}`;
}

export function makeAvatar(prng: RandomSource, seedVal?: string): string {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seedVal || makeUsername(prng))}`;
}

export function makeColor(prng: RandomSource, format = 'hex'): string {
  return format === 'name' ? prng.pick(NAMED_COLORS) : prng.pick(HEX_COLORS);
}

export function makeUuid(prng: RandomSource): string {
  const h = (n: number) => prng.int(0, 0xffffffff).toString(16).padStart(n, '0');
  return `${h(8)}-${h(4).slice(0, 4)}-4${h(3).slice(0, 3)}-${['8', '9', 'a', 'b'][prng.int(0, 3)]}${h(3).slice(0, 3)}-${h(12).slice(0, 12)}`;
}

export function makeWords(prng: RandomSource, minLen: number, maxLen: number): string {
  const n = prng.int(minLen, maxLen);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(prng.pick(LOREM_WORDS));
  return parts.join(' ');
}

export function makeSentences(prng: RandomSource, minLen: number, maxLen: number): string {
  const n = prng.int(minLen, maxLen);
  const sentences: string[] = [];
  for (let i = 0; i < n; i++) {
    const words = makeWords(prng, 6, 14).split(' ');
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    sentences.push(words.join(' ') + '.');
  }
  return sentences.join(' ');
}

export function makeParagraph(prng: RandomSource): string {
  return makeSentences(prng, 3, 5);
}

export function formatPattern(pattern: string, prng: RandomSource): string {
  if (!pattern) return '';
  const now = new Date();
  const year = String(now.getFullYear());
  const s = pattern
    .replace(/\{YYYY\}/g, year)
    .replace(/\{YY\}/g, year.slice(-2))
    .replace(/\{MM\}/g, String(prng.int(1, 12)).padStart(2, '0'))
    .replace(/\{DD\}/g, String(prng.int(1, 28)).padStart(2, '0'));

  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  let res = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '#') res += prng.int(0, 9);
    else if (ch === 'A' || ch === '?') res += upper[prng.int(0, 25)];
    else if (ch === 'a') res += lower[prng.int(0, 25)];
    else res += ch;
  }
  return res;
}

export function randomDate(prng: RandomSource, from?: string, to?: string, kind: 'date' | 'datetime' = 'date'): string {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const minT = Number.isFinite(lo) ? lo : now - 730 * 86400_000;
  const maxT = Number.isFinite(hi) ? hi : now;
  const d = new Date(prng.int(Math.min(minT, maxT), Math.max(minT, maxT)));
  if (kind === 'datetime') return d.toISOString();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function randomTime(prng: RandomSource): string {
  return `${String(prng.int(0, 23)).padStart(2, '0')}:${String(prng.int(0, 59)).padStart(2, '0')}:${String(prng.int(0, 59)).padStart(2, '0')}`;
}

export function randomUnixTimestamp(prng: RandomSource, format = 'sec', from?: string, to?: string): number {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const minT = Number.isFinite(lo) ? lo : now - 730 * 86400_000;
  const maxT = Number.isFinite(hi) ? hi : now;
  const t = prng.int(Math.min(minT, maxT), Math.max(minT, maxT));
  return format === 'ms' ? t : Math.floor(t / 1000);
}

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function randomAlnum(prng: RandomSource, minLen: number, maxLen: number): string {
  const len = prng.int(minLen, maxLen);
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[prng.int(0, ALNUM.length - 1)];
  return s;
}

const JSON_ROLES = ['admin', 'editor', 'viewer', 'billing', 'member', 'owner', 'guest'];
const JSON_APPS = ['dashboard', 'api', 'mobile', 'cli', 'webhook', 'cron', 'importer'];

function jsonValueForKey(prng: RandomSource, key: string): unknown {
  const lk = key.toLowerCase();
  if (lk.includes('role')) return prng.pick(JSON_ROLES);
  if (lk.includes('app')) return [prng.pick(JSON_APPS)];
  const roll = prng.next();
  if (roll < 0.45) return prng.pick(['alpha', 'beta', 'stable', 'draft', 'on', 'off', 'default', 'custom']);
  if (roll < 0.6) return prng.int(0, 1000);
  if (roll < 0.75) return prng.chance(50);
  if (roll < 0.9) return null;
  return makeUuid(prng);
}

export function makeJsonObject(prng: RandomSource, keys?: string[], jsonValues?: Record<string, string[]>): string {
  const k = (keys && keys.length ? keys : ['scope', 'enabled', 'flags']).slice(0, 16);
  const obj: Record<string, unknown> = {};
  for (const key of k) {
    const allowed = jsonValues ? jsonValues[key] : undefined;
    obj[key] = allowed && allowed.length ? prng.pick(allowed) : jsonValueForKey(prng, key);
  }
  return JSON.stringify(obj);
}

export function isTextishType(type: string): boolean {
  const t = (type || '').toUpperCase();
  return t === 'TEXT' || t === '' || t.includes('JSON') || t.includes('CHAR') || t.includes('CLOB') || t.includes('VARCHAR');
}

/**
 * Generator Registry Class
 */
class GeneratorRegistryClass {
  private registry = new Map<GeneratorStrategyId, GeneratorDefinition>();

  constructor() {
    this.registerDefaults();
  }

  public register(def: GeneratorDefinition): void {
    this.registry.set(def.id, def);
  }

  public get(id: GeneratorStrategyId): GeneratorDefinition | undefined {
    return this.registry.get(id);
  }

  public getAll(): GeneratorDefinition[] {
    return Array.from(this.registry.values());
  }

  public getDescriptorsFor(col: ColumnInfo, fk: ForeignKeyInfo | null): StrategyDescriptor[] {
    const type = (col.type || '').toUpperCase();
    const isText = isTextishType(type);
    const isNum = type.startsWith('INTEGER') || type === 'REAL' || type.includes('DECIMAL') || type.includes('NUMERIC') || isText;
    const isBlob = type === 'BLOB' || type === 'BYTEA' || isText;
    const isDate = type.includes('DATE') || type.includes('TIME') || isText;

    const out: StrategyDescriptor[] = [];

    // FK first if foreign key present
    if (fk) {
      out.push({
        id: 'fk',
        label: `Foreign Key: Sample from ${fk.table}${fk.to ? `.${fk.to}` : ''}`,
        category: 'relational',
        description: `Assigns valid parent IDs from ${fk.table}`,
      });
      out.push({
        id: 'sequentialFk',
        label: `Sequential FK: Ordered match from ${fk.table}`,
        category: 'relational',
        description: `Pairs rows 1-to-1 or evenly across ${fk.table}`,
      });
    }

    for (const def of this.registry.values()) {
      if (def.id === 'fk' || def.id === 'sequentialFk') continue;

      const target = def.targetTypes;
      if (
        target === 'all' ||
        (target === 'text' && isText) ||
        (target === 'numeric' && isNum) ||
        (target === 'blob' && isBlob) ||
        (target === 'date' && isDate)
      ) {
        out.push({
          id: def.id,
          label: def.label,
          category: def.category,
          description: def.description,
        });
      }
    }
    return out;
  }

  private registerDefaults(): void {
    // Control / Custom
    this.register({
      id: 'skip',
      label: 'Database Default / Auto Increment',
      category: 'database_aware',
      description: 'Omit from INSERT to let database default or autoincrement apply',
      targetTypes: 'all',
      generate: () => SKIP,
    });

    this.register({
      id: 'null',
      label: 'NULL',
      category: 'custom_control',
      description: 'Set NULL explicitly',
      targetTypes: 'all',
      generate: () => null,
    });

    this.register({
      id: 'fixed',
      label: 'Fixed Value',
      category: 'custom_control',
      description: 'Static constant value for all rows',
      targetTypes: 'all',
      generate: (ctx) => ctx.plan.value ?? '',
    });

    this.register({
      id: 'list',
      label: 'Custom List / Enum',
      category: 'custom_control',
      description: 'Pick randomly from a list of predefined choices',
      targetTypes: 'all',
      generate: (ctx) => {
        const vals = (ctx.plan.values ?? []).filter((v) => String(v).trim() !== '');
        return vals.length ? ctx.prng.pick(vals) : SKIP;
      },
    });

    this.register({
      id: 'pattern',
      label: 'Pattern Template (e.g. INV-####)',
      category: 'custom_control',
      description: 'Formatted token pattern (#=digit, A=letter, {YYYY}=year)',
      targetTypes: 'all',
      generate: (ctx) => formatPattern(ctx.plan.pattern || 'INV-2026-####', ctx.prng),
    });

    this.register({
      id: 'template',
      label: 'Column Template Expression',
      category: 'custom_control',
      description: 'Compose from other columns: {{first_name}}.{{last_name}}@domain.com',
      targetTypes: 'text',
      generate: (ctx) => ctx.plan.template || '',
    });

    // Identity & People
    this.register({
      id: 'first',
      label: 'First Name',
      category: 'identity',
      description: 'Realistic first names',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(FIRST_NAMES),
    });

    this.register({
      id: 'last',
      label: 'Last Name / Surname',
      category: 'identity',
      description: 'Realistic surnames',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(LAST_NAMES),
    });

    this.register({
      id: 'fullname',
      label: 'Full Name',
      category: 'identity',
      description: 'First and last name combined',
      targetTypes: 'text',
      generate: (ctx) => `${ctx.prng.pick(FIRST_NAMES)} ${ctx.prng.pick(LAST_NAMES)}`,
    });

    this.register({
      id: 'username',
      label: 'Username',
      category: 'identity',
      description: 'User handle or login name',
      targetTypes: 'text',
      generate: (ctx) => makeUsername(ctx.prng, ctx.rowIndex, ctx.rowValues),
    });

    this.register({
      id: 'job',
      label: 'Job Title / Profession',
      category: 'identity',
      description: 'Job titles and professions',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(JOB_TITLES),
    });

    // Contact & Web
    this.register({
      id: 'email',
      label: 'Email Address',
      category: 'contact_web',
      description: 'Realistic email address',
      targetTypes: 'text',
      generate: (ctx) => makeEmail(ctx.prng, ctx.rowIndex, ctx.rowValues),
    });

    this.register({
      id: 'phone',
      label: 'Phone Number',
      category: 'contact_web',
      description: 'Standard phone numbers',
      targetTypes: 'text',
      generate: (ctx) => makePhone(ctx.prng),
    });

    this.register({
      id: 'url',
      label: 'Website URL',
      category: 'contact_web',
      description: 'Valid website URL with slug',
      targetTypes: 'text',
      generate: (ctx) => `https://www.${ctx.prng.pick(DOMAINS)}/${makeSlug(ctx.prng)}`,
    });

    this.register({
      id: 'domain',
      label: 'Domain Name',
      category: 'contact_web',
      description: 'Internet domain name',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(DOMAINS),
    });

    this.register({
      id: 'ip',
      label: 'IPv4 Address',
      category: 'contact_web',
      description: 'IPv4 address',
      targetTypes: 'text',
      generate: (ctx) => makeIp(ctx.prng),
    });

    this.register({
      id: 'avatar',
      label: 'Avatar URL',
      category: 'contact_web',
      description: 'Avatar image URL',
      targetTypes: 'text',
      generate: (ctx) => makeAvatar(ctx.prng),
    });

    // Commerce & Business
    this.register({
      id: 'company',
      label: 'Company Name',
      category: 'commerce',
      description: 'Organization or enterprise name',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(COMPANIES),
    });

    this.register({
      id: 'currency',
      label: 'Currency Code (ISO-3)',
      category: 'commerce',
      description: 'ISO-4217 3-letter currency code (USD, EUR...)',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(CURRENCIES),
    });

    this.register({
      id: 'status',
      label: 'Status (active, pending...)',
      category: 'commerce',
      description: 'Workflow or record status',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(STATUSES),
    });

    this.register({
      id: 'creditCard',
      label: 'Credit Card (Masked Test)',
      category: 'commerce',
      description: 'Formatted masked test payment card',
      targetTypes: 'text',
      generate: (ctx) => makeCreditCard(ctx.prng),
    });

    // Location
    this.register({
      id: 'address',
      label: 'Street Address',
      category: 'location',
      description: 'Street address with city',
      targetTypes: 'text',
      generate: (ctx) => makeAddress(ctx.prng),
    });

    this.register({
      id: 'city',
      label: 'City',
      category: 'location',
      description: 'City name',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(CITIES),
    });

    this.register({
      id: 'state',
      label: 'State / Province',
      category: 'location',
      description: 'State / province name',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(US_STATES),
    });

    this.register({
      id: 'country',
      label: 'Country Name',
      category: 'location',
      description: 'Full country name',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(COUNTRIES),
    });

    this.register({
      id: 'countryCode',
      label: 'Country Code (ISO-2)',
      category: 'location',
      description: '2-letter country code (US, GB, DE...)',
      targetTypes: 'text',
      generate: (ctx) => ctx.prng.pick(COUNTRY_CODES),
    });

    this.register({
      id: 'postal',
      label: 'Postal / Zip Code',
      category: 'location',
      description: '5-digit postal code',
      targetTypes: 'text',
      generate: (ctx) => String(ctx.prng.int(10000, 99999)),
    });

    this.register({
      id: 'latitude',
      label: 'Latitude',
      category: 'location',
      description: 'Geographic latitude (-90 to 90)',
      targetTypes: 'all',
      generate: (ctx) => Number(ctx.prng.float(ctx.plan.min ?? -90, ctx.plan.max ?? 90).toFixed(6)),
    });

    this.register({
      id: 'longitude',
      label: 'Longitude',
      category: 'location',
      description: 'Geographic longitude (-180 to 180)',
      targetTypes: 'all',
      generate: (ctx) => Number(ctx.prng.float(ctx.plan.min ?? -180, ctx.plan.max ?? 180).toFixed(6)),
    });

    // Numbers & Math
    this.register({
      id: 'int',
      label: 'Integer in Range',
      category: 'numeric',
      description: 'Random integer between min and max',
      targetTypes: 'numeric',
      generate: (ctx) => ctx.prng.int(ctx.plan.min ?? 1, Math.max(ctx.plan.min ?? 1, ctx.plan.max ?? 1000)),
    });

    this.register({
      id: 'decimal',
      label: 'Decimal / Price',
      category: 'numeric',
      description: 'Floating point or monetary number with precision',
      targetTypes: 'numeric',
      generate: (ctx) =>
        ctx.prng.float(ctx.plan.min ?? 1, Math.max(ctx.plan.min ?? 1, ctx.plan.max ?? 1000)).toFixed(
          Math.max(0, Math.min(10, ctx.plan.precision ?? 2)),
        ),
    });

    this.register({
      id: 'sequence',
      label: 'Sequence Increment',
      category: 'numeric',
      description: 'Incremental counter: start + (row * step)',
      targetTypes: 'numeric',
      generate: (ctx) => (ctx.plan.start ?? 1) + ctx.rowIndex * (ctx.plan.step ?? 1),
    });

    this.register({
      id: 'percentage',
      label: 'Percentage (0-100)',
      category: 'numeric',
      description: 'Percentage ratio (0 to 100)',
      targetTypes: 'numeric',
      generate: (ctx) => ctx.prng.int(ctx.plan.min ?? 0, ctx.plan.max ?? 100),
    });

    // Date & Time
    this.register({
      id: 'date',
      label: 'Date (YYYY-MM-DD)',
      category: 'datetime',
      description: 'Calendar date in ISO YYYY-MM-DD format',
      targetTypes: 'all',
      generate: (ctx) => randomDate(ctx.prng, ctx.plan.from, ctx.plan.to, 'date'),
    });

    this.register({
      id: 'datetime',
      label: 'Datetime (ISO-8601)',
      category: 'datetime',
      description: 'Full timestamp with time',
      targetTypes: 'all',
      generate: (ctx) => randomDate(ctx.prng, ctx.plan.from, ctx.plan.to, 'datetime'),
    });

    this.register({
      id: 'time',
      label: 'Time (HH:MM:SS)',
      category: 'datetime',
      description: 'Time of day in HH:MM:SS format',
      targetTypes: 'all',
      generate: (ctx) => randomTime(ctx.prng),
    });

    this.register({
      id: 'timestampUnix',
      label: 'Unix Timestamp',
      category: 'datetime',
      description: 'Epoch seconds or milliseconds',
      targetTypes: 'all',
      generate: (ctx) => randomUnixTimestamp(ctx.prng, ctx.plan.format, ctx.plan.from, ctx.plan.to),
    });

    this.register({
      id: 'relativeDate',
      label: 'Recent / Future Date',
      category: 'datetime',
      description: 'Relative date within recent days/months',
      targetTypes: 'all',
      generate: (ctx) => randomDate(ctx.prng, ctx.plan.from, ctx.plan.to, 'datetime'),
    });

    // Text & Content
    this.register({
      id: 'words',
      label: 'Short Words / Tags',
      category: 'system_crypto',
      description: 'Space-delimited keywords or tags',
      targetTypes: 'text',
      generate: (ctx) => makeWords(ctx.prng, ctx.plan.minLen ?? 1, ctx.plan.maxLen ?? 4),
    });

    this.register({
      id: 'sentence',
      label: 'Sentences',
      category: 'system_crypto',
      description: 'Natural reading sentence',
      targetTypes: 'text',
      generate: (ctx) => makeSentences(ctx.prng, ctx.plan.minLen ?? 1, ctx.plan.maxLen ?? 2),
    });

    this.register({
      id: 'paragraph',
      label: 'Paragraph',
      category: 'system_crypto',
      description: 'Multi-sentence prose text block',
      targetTypes: 'text',
      generate: (ctx) => makeParagraph(ctx.prng),
    });

    this.register({
      id: 'slug',
      label: 'URL Slug',
      category: 'system_crypto',
      description: 'Kebab-case URL identifier',
      targetTypes: 'text',
      generate: (ctx) => makeSlug(ctx.prng),
    });

    // System, Crypto & Tech
    this.register({
      id: 'bool',
      label: 'Boolean Flag',
      category: 'system_crypto',
      description: 'Boolean flag 1/0 or true/false',
      targetTypes: 'all',
      generate: (ctx) => (ctx.prng.chance(50) ? '1' : '0'),
    });

    this.register({
      id: 'uuid',
      label: 'UUID v4',
      category: 'system_crypto',
      description: 'Standard RFC-4122 v4 UUID',
      targetTypes: 'text',
      generate: (ctx) => makeUuid(ctx.prng),
    });

    this.register({
      id: 'bytes',
      label: 'Hex Bytes / Binary BLOB',
      category: 'system_crypto',
      description: 'Binary data / BLOB',
      targetTypes: 'blob',
      generate: (ctx) => {
        const len = ctx.prng.int(Math.max(0, ctx.plan.minLen ?? 8), Math.max(1, ctx.plan.maxLen ?? 32));
        const buf = Buffer.alloc(len);
        for (let i = 0; i < len; i++) buf[i] = ctx.prng.int(0, 255);
        return `0x${buf.toString('hex')}`;
      },
    });

    this.register({
      id: 'token',
      label: 'Alphanumeric Token',
      category: 'system_crypto',
      description: 'Short random alphanumeric code',
      targetTypes: 'text',
      generate: (ctx) => randomAlnum(ctx.prng, Math.max(2, ctx.plan.minLen ?? 6), Math.max(2, ctx.plan.maxLen ?? 12)),
    });

    this.register({
      id: 'hash',
      label: 'Hex Hash (MD5 / SHA)',
      category: 'system_crypto',
      description: 'Hexadecimal hash digest',
      targetTypes: 'text',
      generate: (ctx) => {
        const len = ctx.prng.int(Math.max(8, ctx.plan.minLen ?? 32), Math.max(8, ctx.plan.maxLen ?? 64));
        return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
      },
    });

    this.register({
      id: 'json',
      label: 'Valid JSON Object',
      category: 'system_crypto',
      description: 'Structured JSON document',
      targetTypes: 'text',
      generate: (ctx) => makeJsonObject(ctx.prng, ctx.plan.jsonKeys, ctx.plan.jsonValues),
    });

    this.register({
      id: 'color',
      label: 'Color (Hex or Name)',
      category: 'system_crypto',
      description: 'Color hex code (#rrggbb) or CSS name',
      targetTypes: 'text',
      generate: (ctx) => makeColor(ctx.prng, ctx.plan.format),
    });

    this.register({
      id: 'mac',
      label: 'MAC Network Address',
      category: 'system_crypto',
      description: 'Hardware ethernet MAC address',
      targetTypes: 'text',
      generate: (ctx) => makeMacAddress(ctx.prng),
    });

    // Relational & Database-Aware
    this.register({
      id: 'fk',
      label: 'Foreign Key (Sample from Parent)',
      category: 'relational',
      description: 'Draw valid foreign keys from generated or existing parent records',
      targetTypes: 'all',
      generate: (ctx) => {
        const pool = ctx.fkPool;
        if (!pool || pool.length === 0) return null;
        return ctx.prng.pick(pool);
      },
    });

    this.register({
      id: 'sequentialFk',
      label: 'Sequential Foreign Key',
      category: 'relational',
      description: 'Distribute foreign keys sequentially across available parents',
      targetTypes: 'all',
      generate: (ctx) => {
        const pool = ctx.fkPool;
        if (!pool || pool.length === 0) return null;
        return pool[ctx.rowIndex % pool.length];
      },
    });

    this.register({
      id: 'sampleExisting',
      label: 'Sample Existing Values',
      category: 'database_aware',
      description: 'Pick from values already present in the database table',
      targetTypes: 'all',
      generate: (ctx) => {
        const pool = ctx.sampledPool || ctx.fkPool;
        if (!pool || pool.length === 0) return SKIP;
        return ctx.prng.pick(pool);
      },
    });
  }
}

export const GeneratorRegistry = new GeneratorRegistryClass();

/**
 * Generate a single value for a column according to its plan.
 */
export function generateColumnValue(
  col: ColumnInfo,
  plan: ColumnPlan,
  prng: RandomSource = createPrng(),
  rowIndex = 0,
  rowValues: Record<string, unknown> = {},
  fkPool?: unknown[],
  sampledPool?: unknown[],
): unknown {
  const type = (col.type || '').toUpperCase();

  // Null percentage check
  if (!col.pk && !col.notnull && plan.nullPct && plan.nullPct > 0) {
    if (prng.chance(plan.nullPct)) return null;
  }

  const def = GeneratorRegistry.get(plan.strategy);
  if (!def) return SKIP;

  const rawVal = def.generate({
    col,
    plan,
    prng,
    rowIndex,
    rowValues,
    fkPool,
    sampledPool,
  });

  if (rawVal === SKIP || rawVal === null) return rawVal;

  let val = rawVal;
  if (typeof val === 'string' && (plan.prefix || plan.suffix)) {
    val = `${plan.prefix || ''}${val}${plan.suffix || ''}`;
  }

  return coerceFormValue(val, type || 'TEXT');
}
