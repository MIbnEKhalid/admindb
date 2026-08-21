import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfoData } from '../db/database';
import {
  type ColumnGeneratorConfig,
  type ColumnPlan,
  type GeneratorStrategyId,
} from './types';
import { fallbackPlanFor, isTextishType, strategiesFor } from './strategies';

export interface OrderingConstraint {
  after?: { column: string; orEqual: boolean };
  before?: { column: string; orEqual: boolean };
}

export interface NumericConstraint {
  min?: number;
  max?: number;
}

export interface CheckInfo {
  columnAllowed: Map<string, string[]>;
  columnRange: Map<string, NumericConstraint>;
  jsonAllowed: Map<string, Map<string, string[]>>;
  ordering: Map<string, OrderingConstraint>;
}

export const normName = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function isTimestampName(name: string): boolean {
  return (
    /created|updated|modified|registered|joined|timestamp|lastused|lastseen|lastlogin|lastactivity|accessed|viewed|visited|^ts$/.test(name) ||
    /^(created|updated|deleted|archived|occurred|started|ended|expires|published|processed|completed|inserted|requested|resolved|used|seen|accessed|viewed|visited|logged|active)at$/.test(name)
  );
}

export function findInMap<T>(map: Map<string, T>, colName: string): T | undefined {
  if (map.has(colName)) return map.get(colName);
  const lower = colName.toLowerCase();
  for (const [k, v] of map.entries()) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function extractCheckExprs(sql: string): string[] {
  const out: string[] = [];
  const re = /CHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === "'") {
        i += 1;
        while (i < sql.length) {
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") i += 2;
            else { i += 1; break; }
          } else i += 1;
        }
        continue;
      }
      if (ch === '"' || ch === '`' || ch === '[') {
        const close = ch === '[' ? ']' : ch;
        i += 1;
        while (i < sql.length && sql[i] !== close) {
          if (sql[i] === close && sql[i + 1] === close) i += 2;
          else i += 1;
        }
        i += 1;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    out.push(sql.slice(start, i));
  }
  return out;
}

export function parseChecks(sql: string | null): CheckInfo {
  const info: CheckInfo = {
    columnAllowed: new Map(),
    columnRange: new Map(),
    jsonAllowed: new Map(),
    ordering: new Map(),
  };
  if (!sql) return info;

  const setOrdering = (col: string, other: string, key: 'after' | 'before', orEqual: boolean) => {
    const c = info.ordering.get(col) ?? {};
    c[key] = { column: other, orEqual };
    info.ordering.set(col, c);
  };

  const setColumnAllowed = (col: string, vals: string[]) => {
    if (!col || !vals.length) return;
    const existing = findInMap(info.columnAllowed, col);
    if (existing) {
      for (const v of vals) if (!existing.includes(v)) existing.push(v);
    } else {
      info.columnAllowed.set(col, [...vals]);
    }
  };

  for (const expr of extractCheckExprs(sql)) {
    // 1. JSON whitelists
    const jw1 = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*(?:->>|->)\s*'([^']+)'\s*\)*\s*IN\s*\(([^)]*)\)/gi;
    const jw2 = /json_extract\s*\(\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*'(?:\$\??|\.)?\.?([^']+)'\s*\)\s*\)*\s*IN\s*\(([^)]*)\)/gi;
    for (const re of [jw1, jw2]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(expr))) {
        const col = m[1] || m[2] || m[3] || m[4];
        const key = m[5];
        const inContent = m[6];
        const strValues = (inContent.match(/'(?:[^']|'')*'/g) ?? []).map((s) => s.slice(1, -1).replace(/''/g, "'"));
        const values = strValues.length ? strValues : (inContent.match(/-?\b\d+(?:\.\d+)?\b/g) ?? []);
        if (values.length && col && key) {
          const byCol = findInMap(info.jsonAllowed, col) ?? new Map<string, string[]>();
          byCol.set(key, values);
          info.jsonAllowed.set(col, byCol);
        }
      }
    }

    // 2. Direct column IN lists
    const colIn = /(?:^|[^(->>\w])(?:\(\s*)?(?:(?:lower|upper|trim|coalesce)\s*\(\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))(?:\s*,\s*[^)]+)?\s*\)?\s*\)?\s*IN\s*\(([^)]*)\)/gi;
    let mColIn: RegExpExecArray | null;
    while ((mColIn = colIn.exec(expr))) {
      const col = mColIn[1] || mColIn[2] || mColIn[3] || mColIn[4];
      if (!col || ['json_extract', 'strftime', 'datetime', 'date', 'length', 'typeof'].includes(col.toLowerCase())) continue;
      const matchPos = mColIn.index;
      if (expr.slice(Math.max(0, matchPos - 5), matchPos).includes('->')) continue;

      const inContent = mColIn[5];
      const strValues = (inContent.match(/'(?:[^']|'')*'/g) ?? []).map((s) => s.slice(1, -1).replace(/''/g, "'"));
      const values = strValues.length ? strValues : (inContent.match(/-?\b\d+(?:\.\d+)?\b/g) ?? []);
      if (values.length) setColumnAllowed(col, values);
    }

    // 3. Direct column equality
    const eqOr = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*'((?:[^']|'')*)'/gi;
    let mEq: RegExpExecArray | null;
    const eqByCol = new Map<string, string[]>();
    while ((mEq = eqOr.exec(expr))) {
      const col = mEq[1] || mEq[2] || mEq[3] || mEq[4];
      const val = mEq[5].replace(/''/g, "'");
      if (col && !['json_extract', 'lower', 'upper', 'trim', 'strftime', 'datetime'].includes(col.toLowerCase())) {
        const cur = eqByCol.get(col) ?? [];
        if (!cur.includes(val)) cur.push(val);
        eqByCol.set(col, cur);
      }
    }
    for (const [col, vals] of eqByCol.entries()) setColumnAllowed(col, vals);

    // 4. Numeric range constraints
    const numCmp1 = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)/g;
    let mNum1: RegExpExecArray | null;
    while ((mNum1 = numCmp1.exec(expr))) {
      const col = mNum1[1] || mNum1[2] || mNum1[3] || mNum1[4];
      const op = mNum1[5];
      const val = Number(mNum1[6]);
      if (col && Number.isFinite(val) && !['json_extract', 'length', 'strftime', 'datetime'].includes(col.toLowerCase())) {
        const cur = findInMap(info.columnRange, col) ?? {};
        if (op === '>=' || op === '>') cur.min = cur.min != null ? Math.max(cur.min, op === '>' ? val + 1 : val) : (op === '>' ? val + 1 : val);
        else cur.max = cur.max != null ? Math.min(cur.max, op === '<' ? val - 1 : val) : (op === '<' ? val - 1 : val);
        info.columnRange.set(col, cur);
      }
    }

    // 5. Column ordering
    const ord = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*(>=|<=|>|<)\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/g;
    let m2: RegExpExecArray | null;
    while ((m2 = ord.exec(expr))) {
      const a = m2[1] || m2[2] || m2[3] || m2[4];
      const op = m2[5];
      const b = m2[6] || m2[7] || m2[8] || m2[9];
      if (!a || !b || /^\d+$/.test(a) || /^\d+$/.test(b)) continue;
      if (['json_extract', 'strftime', 'datetime', 'date', 'length'].includes(a.toLowerCase())) continue;
      if (['json_extract', 'strftime', 'datetime', 'date', 'length'].includes(b.toLowerCase())) continue;
      if (op === '>' || op === '>=') {
        setOrdering(a, b, 'after', op === '>=');
        setOrdering(b, a, 'before', op === '>=');
      } else {
        setOrdering(a, b, 'before', op === '<=');
        setOrdering(b, a, 'after', op === '<=');
      }
    }
  }
  return info;
}

const isHashName = (name: string) => /^(hash|digest|secret|passphrase)$|tokenhash|passwordhash|passhash|accesskey|apikey|api_key|secretkey|clientsecret|appsecret|appid|privatekey|publickey/.test(name);
const isTokenName = (name: string) => /^prefix$|tokenprefix|(code|ref|reference|sku|ticketno|ticketnum|orderno|order_no|trackingno|trackingnum|invno|invoiceno|serialno)$/.test(name);

function isJsonColumn(col: ColumnInfo, hasJsonIndex: boolean): boolean {
  if (!isTextishType(col.type)) return false;
  if (hasJsonIndex) return true;
  const dflt = String(col.dflt_value ?? '').trim();
  if (dflt.startsWith('{') || dflt.startsWith("'{\"")) return true;
  const name = normName(col.name);
  return /^(permissions|settings|config|configuration|preferences|prefs|metadata|meta|attributes|payload|options|allowedapps|socialaccounts|positions|fcmtokens|fcm_tokens|scopes|profile|json|jsonb)$/.test(name) ||
    /(^|_)(settings|config|configuration|permissions|prefs|metadata|attributes|payload|options|allowedapps|scopes|profile)$/.test(name);
}

function extractJsonColumns(sql: string): { col: string; keys: string[] }[] {
  const out: { col: string; keys: string[] }[] = [];
  const push = (col: string, key?: string) => {
    let entry = out.find((e) => e.col === col);
    if (!entry) { entry = { col, keys: [] }; out.push(entry); }
    if (key) {
      const last = key.split('.').pop()!.replace(/[\[\]"]/g, '');
      if (last && !entry.keys.includes(last)) entry.keys.push(last);
    }
  };
  const arrow = /"([^"]+)"\s*(?:->>|->)\s*'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)\s*(?:->>|->)\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = arrow.exec(sql))) push(m[1] || m[3], m[2] || m[4]);
  const jx = /json_extract\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*'(?:\$\??|\.)?\.?([^']+)'/g;
  while ((m = jx.exec(sql))) push(m[1] || m[2], m[3]);
  return out;
}

/** Name heuristics pattern table for text-ish columns. */
const TEXT_PATTERNS: [RegExp, (name: string) => ColumnPlan][] = [
  [/avatar|picture|photo|image|img|thumbnail|icon|logo/, () => ({ strategy: 'avatar' })],
  [/company|organization|org|firm|corp|employer|agency/, () => ({ strategy: 'company' })],
  [/job|title|role|position|occupation|profession/, () => ({ strategy: 'job' })],
  [/currency|curr|currencycode/, () => ({ strategy: 'currency' })],
  [/countrycode|countryiso|isocountry|cca2/, () => ({ strategy: 'countryCode' })],
  [/state|province|region/, (n) => (/status|statement/.test(n) ? { strategy: 'status' } : { strategy: 'state' })],
  [/status|stage|phase|state/, () => ({ strategy: 'status' })],
  [/color|colour|theme|hexcolor/, () => ({ strategy: 'color', format: 'hex' })],
  [/mac|macaddress|hwaddr/, () => ({ strategy: 'mac' })],
  [/creditcard|cardnumber|cardno|ccnumber|ccno/, () => ({ strategy: 'creditCard' })],
  [/slug|permalink|handle|alias/, () => ({ strategy: 'slug' })],
  [/(lastname|surname|familyname)/, () => ({ strategy: 'last' })],
  [/email|mail/, () => ({ strategy: 'email' })],
  [/(username|login|handle|nick|nickname|account|user)/, () => ({ strategy: 'username' })],
  [/(phone|mobile|telephone|cell|fax)/, () => ({ strategy: 'phone' })],
  [/city|town/, () => ({ strategy: 'city' })],
  [/country|nation/, () => ({ strategy: 'country' })],
  [/postal|zip/, () => ({ strategy: 'postal' })],
  [/address|street|addr/, () => ({ strategy: 'address' })],
  [/url|website|site|link|homepage|href/, () => ({ strategy: 'url' })],
  [/domain|host/, () => ({ strategy: 'domain' })],
  [/^ip$|ipaddr|ipv4|ip_address/, () => ({ strategy: 'ip' })],
  [/bio|about|overview|article|body|post|story/, () => ({ strategy: 'paragraph' })],
  [/description|content|comment|message|note|summary|details|remarks/, () => ({ strategy: 'sentence', minLen: 1, maxLen: 2 })],
  [/title|subject|category|type|tag|label/, () => ({ strategy: 'words', minLen: 1, maxLen: 3 })],
];

export function detectPlan(col: ColumnInfo, fk: ForeignKeyInfo | null): ColumnPlan {
  const type = (col.type || '').toUpperCase();
  const rawName = col.name.toLowerCase();
  const name = normName(col.name);

  if (fk) return { strategy: 'fk' };
  if (col.pk) {
    if (type.startsWith('INTEGER')) return { strategy: 'skip' };
    if (type === 'TEXT' || type === 'BLOB') return { strategy: 'uuid' };
    return { strategy: 'skip' };
  }
  if (type === 'BOOLEAN') return { strategy: 'bool' };
  if (type.startsWith('INTEGER') && /(^|_)(is|has|can|should|did)_|_flag$|active|enabled|verified|published|deleted|archived|paid|completed|approved/.test(rawName)) {
    return { strategy: 'bool' };
  }
  if (type === 'DATE' || /^date|birthdate|dob|birthday/.test(rawName)) {
    return name.includes('birth') ? { strategy: 'date', from: '1950-01-01', to: '2000-12-31' } : { strategy: 'date', from: '2020-01-01', to: '2026-12-31' };
  }
  if (type === 'DATETIME' || type === 'TIMESTAMP' || isTimestampName(name)) {
    return { strategy: 'datetime', from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' };
  }
  if (type === 'TIME' || name === 'time') return { strategy: 'time' };
  if (type.startsWith('INTEGER') && /(timestamp|epoch|unix|createdtime|updatedtime)/.test(name)) {
    return { strategy: 'timestampUnix', format: 'sec' };
  }
  if (/^(lat|latitude)$/.test(name)) return { strategy: 'latitude' };
  if (/^(lng|lon|longitude)$/.test(name)) return { strategy: 'longitude' };

  if (type.startsWith('INTEGER')) {
    if (name.includes('year')) return { strategy: 'int', min: 1990, max: 2026 };
    if (name.includes('age')) return { strategy: 'int', min: 18, max: 90 };
    if (/(count|quantity|qty|stock|views|likes|total|num|number)$/.test(name)) return { strategy: 'int', min: 0, max: 100000 };
    if (name.includes('rating') || name.includes('score')) return { strategy: 'int', min: 1, max: 5 };
    if (/(order|rank|position|seq|sequence|priority|sort|step)$/.test(name)) return { strategy: 'sequence', start: 1, step: 1 };
    return { strategy: 'int', min: 1, max: 1000 };
  }

  if (type === 'REAL' || type.includes('DECIMAL') || type.includes('NUMERIC') || type.includes('FLOAT') || type.includes('DOUBLE')) {
    if (/(price|cost|amount|total|salary|balance|fee|charge|budget)/.test(name)) return { strategy: 'decimal', min: 1, max: 5000, precision: 2 };
    if (name.includes('rating')) return { strategy: 'decimal', min: 1, max: 5, precision: 1 };
    return { strategy: 'decimal', min: 1, max: 1000, precision: 2 };
  }

  if (type === 'BLOB') return { strategy: 'bytes', minLen: 8, maxLen: 32 };

  // Explicit text heuristics checked in exact order
  if (/currency|curr|currencycode/.test(name)) return { strategy: 'currency' };
  if (/countrycode|countryiso|isocountry|cca2/.test(name)) return { strategy: 'countryCode' };
  if (/state|province|region/.test(name) && !/status|statement/.test(name)) return { strategy: 'state' };
  if (/status|stage|phase|state/.test(name)) return { strategy: 'status' };
  if (/color|colour|theme|hexcolor/.test(name)) return { strategy: 'color', format: 'hex' };
  if (/mac|macaddress|hwaddr/.test(name)) return { strategy: 'mac' };
  if (/creditcard|cardnumber|cardno|ccnumber|ccno/.test(name)) return { strategy: 'creditCard' };
  if (/slug|permalink|handle|alias/.test(name)) return { strategy: 'slug' };

  if (isHashName(name)) return { strategy: 'hash', minLen: 32, maxLen: 64 };
  if (isTokenName(name)) return { strategy: 'token', minLen: 6, maxLen: 12 };
  if (/uuid|guid/.test(name) || name === 'id' || name === 'uid' || name === 'key') return { strategy: 'uuid' };
  if (name.includes('first') && name.includes('name')) return { strategy: 'first' };
  if (/(lastname|surname|familyname)/.test(name) || (name.includes('last') && name.includes('name'))) return { strategy: 'last' };
  if (name === 'name' || name === 'fullname' || (name.includes('full') && name.includes('name'))) return { strategy: 'fullname' };

  for (const [pattern, createPlan] of TEXT_PATTERNS) {
    if (pattern.test(name)) return createPlan(name);
  }

  return { strategy: 'words', minLen: 1, maxLen: 4 };
}

export function buildColumnConfigs(info: TableInfoData): ColumnGeneratorConfig[] {
  const fkByColumn = new Map<string, ForeignKeyInfo>(info.foreignKeys.map((fk) => [fk.from, fk]));
  const uniqueCols = new Set<string>();
  const jsonIndexKeys = new Map<string, string[]>();

  for (const ix of info.indexes ?? ([] as IndexInfo[])) {
    if (ix.unique && ix.columns.length === 1 && ix.columns[0]) uniqueCols.add(ix.columns[0]);
    if (ix.sql && /json_extract|->>|->\s*'|json_/i.test(ix.sql)) {
      for (const { col, keys } of extractJsonColumns(ix.sql)) {
        if (!col) continue;
        const merged = new Set([...(jsonIndexKeys.get(col) ?? []), ...keys]);
        if (merged.size) jsonIndexKeys.set(col, [...merged]);
      }
    }
  }

  const checkInfo = parseChecks(info.sql ?? null);

  return info.columns.map((col) => {
    const fk = fkByColumn.get(col.name) ?? null;
    const strategies = strategiesFor(col, fk);
    const unique = uniqueCols.has(col.name);
    let defaultPlan = detectPlan(col, fk);

    if (defaultPlan.strategy !== 'fk' && !col.pk && isJsonColumn(col, jsonIndexKeys.has(col.name))) {
      const keys = jsonIndexKeys.get(col.name);
      const useKeys = keys && keys.length ? keys : ['scope', 'enabled', 'allowedApps'];
      const allowed = findInMap(checkInfo.jsonAllowed, col.name);
      const jsonValues: Record<string, string[]> = {};
      if (allowed) {
        for (const k of useKeys) {
          const vals = allowed.get(k);
          if (vals && vals.length) jsonValues[k] = vals;
        }
      }
      defaultPlan = {
        strategy: 'json',
        jsonKeys: useKeys,
        ...(Object.keys(jsonValues).length ? { jsonValues } : {}),
      };
    }

    const colAllowed = findInMap(checkInfo.columnAllowed, col.name);
    if (colAllowed && colAllowed.length > 0 && defaultPlan.strategy !== 'fk' && !col.pk) {
      defaultPlan = colAllowed.length === 1 ? { strategy: 'fixed', value: colAllowed[0] } : { strategy: 'list', values: [...colAllowed] };
    }

    const colRange = findInMap(checkInfo.columnRange, col.name);
    if (colRange && (defaultPlan.strategy === 'int' || defaultPlan.strategy === 'decimal')) {
      if (colRange.min != null) defaultPlan.min = colRange.min;
      if (colRange.max != null) defaultPlan.max = colRange.max;
    }

    if (!strategies.some((s) => s.id === defaultPlan.strategy) || (!col.pk && col.notnull && col.dflt_value == null && (defaultPlan.strategy === 'skip' || defaultPlan.strategy === 'null'))) {
      defaultPlan = fallbackPlanFor(col);
    }

    return {
      name: col.name,
      type: col.type,
      pk: col.pk > 0,
      notnull: !!col.notnull,
      hasDefault: col.dflt_value != null,
      unique,
      fk,
      strategies,
      defaultPlan,
    };
  });
}

const STR_PLAN_KEYS = ['value', 'from', 'to', 'prefix', 'suffix', 'pattern', 'format'] as const;
const NUM_PLAN_KEYS = ['min', 'max', 'precision', 'minLen', 'maxLen', 'nullPct', 'start', 'step'] as const;

export function sanitizeColumnPlan(raw: unknown): ColumnPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.strategy !== 'string' || !r.strategy) return null;

  const out: ColumnPlan = { strategy: r.strategy as GeneratorStrategyId };
  if (r.values !== undefined && r.values !== null && Array.isArray(r.values)) {
    out.values = (r.values as unknown[]).map((x) => String(x));
  }
  if (r.jsonKeys !== undefined && r.jsonKeys !== null) {
    const rawKeys = Array.isArray(r.jsonKeys) ? (r.jsonKeys as unknown[]).map(String) : String(r.jsonKeys).split(/[,;]/);
    out.jsonKeys = rawKeys.map((s) => s.trim()).filter(Boolean);
  }
  for (const key of STR_PLAN_KEYS) {
    if (r[key] !== undefined && r[key] !== null) {
      out[key] = String(r[key]);
    }
  }
  for (const key of NUM_PLAN_KEYS) {
    if (r[key] !== undefined && r[key] !== null) {
      const n = Number(r[key]);
      if (Number.isFinite(n)) {
        out[key] = n;
      }
    }
  }

  if (r.jsonValues && typeof r.jsonValues === 'object' && !Array.isArray(r.jsonValues)) {
    const jv: Record<string, string[]> = {};
    for (const [k, vals] of Object.entries(r.jsonValues as Record<string, unknown>)) {
      if (Array.isArray(vals)) {
        const cleaned = vals.map((x) => String(x).trim()).filter(Boolean);
        if (cleaned.length) jv[k] = cleaned;
      }
    }
    if (Object.keys(jv).length) out.jsonValues = jv;
  }
  return out;
}
