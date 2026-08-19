/**
 * Data generator / seeder engine.
 *
 * Given a table's schema, every column can be filled with realistic fake data
 * from a chosen "strategy" — first name, email, UUID, a random integer, a value
 * sampled from a referenced table's foreign key, a fixed value, and so on.
 *
 * Responsibilities:
 *  - auto-detect a sensible default strategy per column (column name + type +
 *    foreign key), so the "Seed data" page works with zero configuration;
 *  - generate N rows of concrete, type-coerced values (ready for SQLite
 *    binding via `db.insertRows`);
 *  - render the generated rows as a multi-row INSERT for the "preview SQL"
 *    mode that never executes.
 */

import { randomBytes } from 'node:crypto';
import type { SqliteDatabase, TableInfoData, ColumnInfo, ForeignKeyInfo, WhereClause, IndexInfo } from '../db/database';
import { coerceFormValue } from '../util';
import { quoteIdentifier, sqlValue } from '../sql/generator';

/** Hard cap on how many rows a single seed run may generate. */
export const MAX_SEED_ROWS = 5000;

export type GeneratorStrategyId =
  | 'skip' | 'null' | 'fixed' | 'list'
  | 'first' | 'last' | 'fullname'
  | 'email' | 'username' | 'phone'
  | 'city' | 'country' | 'postal' | 'address'
  | 'url' | 'domain' | 'ip' | 'uuid'
  | 'words' | 'sentence'
  | 'int' | 'decimal'
  | 'date' | 'datetime' | 'time'
  | 'bool' | 'bytes'
  | 'json' | 'hash' | 'token'
  | 'fk';

/** Per-column generator settings. Which options are meaningful depends on `strategy`. */
export interface ColumnPlan {
  strategy: GeneratorStrategyId;
  /** `fixed` / `list` and the string-ish options. */
  value?: string;
  /** `list` — random value picked from this set. */
  values?: string[];
  /** `int` / `decimal` range. */
  min?: number;
  max?: number;
  /** `decimal` — digits after the decimal point. */
  precision?: number;
  /** `date` / `datetime` bounds (ISO strings). */
  from?: string;
  to?: string;
  /** `words` / `bytes` / `hash` / `token` — length bounds. */
  minLen?: number;
  maxLen?: number;
  /** `json` — object keys to include (comma-separated in the UI). */
  jsonKeys?: string[];
  /** `json` — per-key allowed values, derived from CHECK constraints. */
  jsonValues?: Record<string, string[]>;
}

/** A strategy choice offered to the UI for a column. */
export interface StrategyDescriptor {
  id: GeneratorStrategyId;
  label: string;
}

/** Everything the "Seed data" page needs to render one column's controls. */
export interface ColumnGeneratorConfig {
  name: string;
  type: string;
  pk: boolean;
  notnull: boolean;
  hasDefault: boolean;
  /** True when a single-column UNIQUE index enforces uniqueness on this column. */
  unique: boolean;
  /** The foreign key this column participates in (as the child), if any. */
  fk: ForeignKeyInfo | null;
  strategies: StrategyDescriptor[];
  defaultPlan: ColumnPlan;
}

export interface GenerateResult {
  /** One entry per generated row: the columns/values to bind (skipped columns are absent). */
  rows: WhereClause[][];
  /** Non-fatal notes surfaced to the user (e.g. a NOT NULL column being skipped). */
  warnings: string[];
}

/** Sentinel returned by value generation when the column should be omitted from the row. */
const SKIP = Symbol('skip');

// ---- Static data sets ----------------------------------------------------
const FIRST_NAMES = [
  "Sombat", "Ting", "Rajan", "Minh", "Hiroshi", "William", "Made", "Ravi", "John", "Kiran",
  "Raj", "Wayan", "Chaiwat", "Aarav", "Sita", "Zara", "Ratna", "Ananya", "Ha-eun", "Siti",
  "Seo-yeon", "Mary", "Priyanka", "Xu", "Ali", "Priya", "Sakura", "Ken", "Ketut", "Soo-hyun",
  "Wang", "Guido", "Deepa", "Fang", "James", "Mei", "Binh", "Takeshi", "Leela", "Thuy",
  "Dewi", "Layla", "Vijay", "Samir", "Meera", "Jessica", "Linda", "Malee", "Qiang", "Yuna",
  "Richard", "Margaret", "Ming", "Vikram", "Mai", "Rahul", "Van", "Jennifer", "Suresh", "Yui",
  "Pan", "Barbara", "Tim", "Lu", "Liang", "Robert", "Fatima", "Imran", "Ajay", "Ren",
  "Liu", "Dennis", "Lin", "Kavya", "Agus", "Katherine", "Anita", "Grace", "Linus", "Jun",
  "Alan", "Tarun", "Omar", "Michael", "Dung", "Ahmad", "Hoa", "Hui", "Susan", "Shinji",
  "Zhou", "Linh", "Ngoc", "Xin", "Hassan", "Nisha", "Patricia", "Li", "Lei", "Sunita",
  "Chen", "Anh", "Jia", "Xiao", "Yang", "Ji-hoon", "Jing", "Hedy", "Elizabeth", "Zhang",
  "Arjun", "Yuki", "Ada", "Edsger", "Nong", "Lynn", "Anjali", "Nguyen", "Sora", "Mieko",
  "Nyoman", "Jin", "Aisha", "Bayu", "Tariq", "Daiki", "David", "Rani", "Tran", "Haruki",
  "Dae-hyun", "Dao", "Rama", "Aiko", "Min-jun", "Zhu", "Radia", "Wei"
];

const LAST_NAMES = [
  "Chen", "Smith", "Thompson", "Shah", "Thai", "Perlman", "Brown", "Hsu", "Turing", "Sharma",
  "Purnama", "Lopez", "Williams", "Davis", "Liao", "Xu", "Martin", "Dhawan", "Yoon", "Tan",
  "Yamamoto", "Iyer", "Phung", "Gonzalez", "Huang", "Hu", "Vo", "Shetty", "Le", "Wijaya",
  "Jackson", "Ly", "Anderson", "Pratama", "Lovelace", "Martinez", "Dang", "Ma", "Hopper", "Naidu",
  "Goh", "Hamilton", "Duong", "Taylor", "Song", "Surya", "Singh", "Jiang", "Cho", "Zhang",
  "Pham", "Teo", "van Rossum", "Patel", "Lam", "Jang", "Rodriguez", "Miller", "Torvalds", "Hidayat",
  "Menon", "Thomas", "Hernandez", "Reddy", "Wong", "Tripathi", "Lim", "Kumar", "Bhaskar", "Rajan",
  "Chang", "Ong", "Vu", "Nair", "Sun", "Do", "Bhatia", "Garcia", "Mishra", "Rao",
  "Choi", "Phan", "Zhu", "Nguyen", "Kim", "Putra", "Malhotra", "Nakamura", "Kang", "Wilson",
  "Huynh", "Tanaka", "Kusuma", "Jung", "Mehta", "Perez", "Arora", "Chu", "Moore", "Li",
  "Yang", "Park", "Ko", "Watanabe", "Bui", "Liu", "Ninh", "Jones", "Johnson", "Guo",
  "Ngo", "Ito", "Takahashi", "Grover", "Shen", "Yeh", "Lee", "Gupta", "Wang", "Wu",
  "Verma", "Suzuki", "White", "Lu", "Pillai", "Lin", "Joshi", "Tran", "Chawla", "Zhou", "Desai"
];

const CITIES = [
  "Hyderabad", "Yangon", "Medan", "Minneapolis", "Faisalabad", "Yokohama", "Nha Trang",
  "Hong Kong", "Phoenix", "Delhi", "Chennai", "Denver", "Guangzhou", "Davao City",
  "Chiang Mai", "Atlanta", "Manila", "Naypyidaw", "Sylhet", "Phuket", "Incheon",
  "New York", "Daejeon", "Yogyakarta", "Colombo", "Kanpur", "Portland", "Vientiane",
  "Dublin", "Mandalay", "Hat Yai", "Chengdu", "Lisbon", "Paris", "Bandung",
  "Kathmandu", "Karachi", "Qingdao", "Da Nang", "Seoul", "Hanoi", "Berlin",
  "Chicago", "Sydney", "Quezon City", "Mumbai", "Vizag", "Coimbatore", "Lahore",
  "Dhaka", "Shenzhen", "Phnom Penh", "Navi Mumbai", "Fuzhou", "Kuala Lumpur", "Taipei",
  "Zurich", "Bangkok", "Makati", "Chittagong", "Daegu", "Jaipur", "Oslo",
  "Islamabad", "Dalian", "Kolkata", "Penang", "Johor Bahru", "Singapore", "Ulsan",
  "Macau", "Pune", "Pattaya", "Siem Reap", "Cebu City", "Lucknow", "Rome",
  "Surabaya", "Stockholm", "Los Angeles", "Osaka", "Sapporo", "Fukuoka", "Rajshahi",
  "Tokyo", "Vancouver", "San Francisco", "Nagoya", "Busan", "Jakarta", "Guangxi",
  "London", "Kaohsiung", "Xiamen", "Male", "Nashville", "Warsaw", "Madrid",
  "Indore", "Boston", "Amsterdam", "Shanghai", "Taichung", "Raleigh", "Miami",
  "Jeju", "Cheongju", "Bangalore", "Ahmedabad", "Haiphong", "Ho Chi Minh City", "Gwangju",
  "Rawalpindi", "Toronto", "Seville", "Kyoto", "Austin", "Suwon", "Seattle",
  "Beijing", "Nakhon Ratchasima", "Nagpur"
];

const COUNTRIES = [
  "Japan", "United States", "Bhutan", "Belgium", "Myanmar", "Kazakhstan", "Mexico",
  "Bangladesh", "United Kingdom", "South Africa", "Indonesia", "Vietnam", "South Korea", "Germany",
  "Romania", "Italy", "Spain", "China", "India", "Taiwan", "Philippines",
  "Singapore", "Canada", "Pakistan", "Hungary", "Maldives", "Switzerland", "Macau",
  "Portugal", "Sri Lanka", "Malaysia", "Netherlands", "Turkmenistan", "Brunei", "Brazil",
  "Greece", "Uzbekistan", "Cambodia", "France", "Australia", "Mongolia", "Poland",
  "Kyrgyzstan", "Tajikistan", "Norway", "Sweden", "Ireland", "Austria", "Denmark",
  "Laos", "Nepal", "Thailand", "Finland", "Hong Kong", "Czech Republic", "Timor-Leste", "New Zealand"
];

const DOMAINS = [
  "outlook.com", "nus.edu.sg", "ust.hk", "iitb.ac.in", "acme.io", "ac.sg", "mail.ru", "163.com",
  "outlook.kr", "tech.asia", "startup.io", "proton.me", "sohu.com", "gmail.com", "kyoto-u.ac.jp", 
  "example.com", "naver.com", "protonmail.com", "hanmail.net", "globex.org", "tudelft.nl", "company.com",
  "yahoo.com", "126.com", "daum.net", "initech.net", "hkbu.edu.hk", "yahoo.co.jp", "qq.com", "nthu.edu.tw",
  "sina.com", "innovate.sg", "zoho.com"
];

const LOREM_WORDS = [  
  "schema", "nu", "worker", "alpha", "cache", "edge", "async", "chi", "service", "packet",
  "scale", "upsilon", "scrum", "node", "peace", "deploy", "epsilon", "lambda", "record", "pi",
  "column", "module", "omicron", "query", "buffer", "persistence", "comet", "joy", "integrity", "galaxy",
  "token", "spirit", "socket", "devops", "harmony", "backup", "agile", "render", "await", "field",
  "aurora", "nature", "gamma", "cloud", "omega", "mu", "orbit", "delta", "kindness", "tau",
  "row", "compassion", "theta", "beta", "balance", "wisdom", "rho", "kanban", "kappa", "session",
  "compile", "phi", "stream", "queue", "event", "pixel", "resilience", "nebula", "iota", "index",
  "cluster", "xi", "eta", "signal", "zeta", "fetch", "sigma", "psi"
];

// ---- Random helpers -------------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

function slug(): string {
  return `${pick(LOREM_WORDS)}-${pick(LOREM_WORDS)}-${randInt(100, 999)}`;
}

function makeEmail(): string {
  return `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}${randInt(1, 99)}@${pick(DOMAINS)}`;
}

function makeUsername(): string {
  return `${pick(FIRST_NAMES).toLowerCase()}${pick(LAST_NAMES).toLowerCase()}${randInt(1, 9999)}`;
}

function makePhone(): string {
  return `+1 (${randInt(200, 999)}) ${randInt(200, 999)}-${String(randInt(0, 9999)).padStart(4, '0')}`;
}

function makeAddress(): string {
  return `${randInt(10, 9999)} ${pick(LOREM_WORDS)} ${pick(['St', 'Ave', 'Rd', 'Blvd', 'Ln', 'Dr'])}, ${pick(CITIES)}`;
}

function makeIp(): string {
  return `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;
}

function makeUuid(): string {
  const hex = () => randInt(0, 0xffffffff).toString(16).padStart(8, '0');
  return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-${['8', '9', 'a', 'b'][randInt(0, 3)]}${hex().slice(0, 3)}-${hex()}`;
}

function makeWords(minLen: number, maxLen: number): string {
  const n = randInt(minLen, maxLen);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(pick(LOREM_WORDS));
  return parts.join(' ');
}

function makeSentences(minLen: number, maxLen: number): string {
  const n = randInt(minLen, maxLen);
  const sentences: string[] = [];
  for (let i = 0; i < n; i++) {
    const words = makeWords(6, 14).split(' ');
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    sentences.push(words.join(' ') + '.');
  }
  return sentences.join(' ');
}

/**
 * Random date (or datetime) string inside [from, to]; bounds default to the
 * last ~2 years. Datetimes use the ISO-8601 UTC form (YYYY-MM-DDTHH:MM:SS.sssZ)
 * so TEXT timestamp columns — e.g. a strftime('%Y-%m-%dT%H:%M:%fZ','now')
 * default — get values consistent with their existing data.
 */
function randomDate(from?: string, to?: string, kind: 'date' | 'datetime' = 'date'): string {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const t = randInt(Number.isFinite(lo) ? lo : now - 730 * 86400_000, Number.isFinite(hi) ? hi : now);
  const d = new Date(t);
  if (kind === 'datetime') return d.toISOString();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function randomTime(): string {
  return `${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}`;
}

// ---- Column name / type detection ----------------------------------------

/** Lowercase, punctuation stripped — e.g. "first_name" → "firstname". */
function normName(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a (normalized, lowercase) column name looks like a timestamp /
 * datetime field — created_at, CreatedAt, UpdatedAt, DeletedAt, OccurredAt,
 * expires_at, LastUsed, modified, joined, ts, … (camelCase is normalized to one
 * lowercase token, so both "CreatedAt" and "created_at" match).
 */
function isTimestampName(name: string): boolean {
  return (
    /created|updated|modified|registered|joined|timestamp|lastused|lastseen|lastlogin|lastactivity|accessed|viewed|visited|^ts$/.test(name) ||
    /^(created|updated|deleted|archived|occurred|started|ended|expires|published|processed|completed|inserted|requested|resolved|used|seen|accessed|viewed|visited|logged|active)at$/.test(name)
  );
}

/** True when a declared type can reasonably hold text-ish values (incl. JSON). */
function isTextishType(type: string): boolean {
  const t = (type || '').toUpperCase();
  return t === 'TEXT' || t === '' || t.includes('JSON') || t.includes('CHAR') || t.includes('CLOB');
}

/** Ordering constraint between two columns derived from a CHECK (e.g. ExpiresAt > CreatedAt). */
interface OrderingConstraint {
  after?: { column: string; orEqual: boolean };
  before?: { column: string; orEqual: boolean };
}

/** CHECK-derived facts the generator can honor so generated rows actually insert. */
interface CheckInfo {
  /** column -> key -> allowed values (from `Permissions ->> 'scope' IN (...)`) */
  jsonAllowed: Map<string, Map<string, string[]>>;
  /** column -> ordering relative to another column */
  ordering: Map<string, OrderingConstraint>;
}

/** Extract balanced `CHECK(...)` bodies from a CREATE TABLE statement. */
function extractCheckExprs(sql: string): string[] {
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
            else {
              i += 1;
              break;
            }
          } else i += 1;
        }
        continue;
      }
      if (ch === '"') {
        i += 1;
        while (i < sql.length && sql[i] !== '"') i += 1;
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

/**
 * Parse a table's CHECK constraints for two common, seed-relevant shapes:
 *  - JSON value whitelists: `("Permissions" ->> 'scope') IN ('read-only','write')`
 *  - column ordering: `("ExpiresAt" > "CreatedAt")`
 */
function parseChecks(sql: string | null): CheckInfo {
  const info: CheckInfo = { jsonAllowed: new Map(), ordering: new Map() };
  if (!sql) return info;

  const setAfter = (col: string, other: string, orEqual: boolean) => {
    const c = info.ordering.get(col) ?? {};
    c.after = { column: other, orEqual };
    info.ordering.set(col, c);
  };
  const setBefore = (col: string, other: string, orEqual: boolean) => {
    const c = info.ordering.get(col) ?? {};
    c.before = { column: other, orEqual };
    info.ordering.set(col, c);
  };

  for (const expr of extractCheckExprs(sql)) {
    // JSON whitelists: ("col" ->> 'key') IN (...) / json_extract("col", '$.key') IN (...)
    // (the inner group wraps `('key')`, so allow optional `)` before IN)
    const jw = /"([^"]+)"\s*(?:->>|->)\s*'([^']+)'\s*\)*\s*IN\s*\(([^)]*)\)/g;
    const jw2 = /json_extract\s*\(\s*"([^"]+)"\s*,\s*'(?:\$\??|\.)?\.?([^']+)'\s*\)\s*\)*\s*IN\s*\(([^)]*)\)/g;
    for (const re of [jw, jw2]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(expr))) {
        const values = (m[3].match(/'([^']*)'/g) ?? []).map((s) => s.replace(/^'|'$/g, ''));
        if (!values.length) continue;
        const byCol = info.jsonAllowed.get(m[1]) ?? new Map<string, string[]>();
        byCol.set(m[2], values);
        info.jsonAllowed.set(m[1], byCol);
      }
    }

    // Column ordering: "A" > "B", "A" >= "B", "B" < "A", …
    const ord = /"([^"]+)"\s*(>=|<=|>|<)\s*"([^"]+)"/g;
    let m2: RegExpExecArray | null;
    while ((m2 = ord.exec(expr))) {
      const a = m2[1];
      const op = m2[2];
      const b = m2[3];
      if (op === '>' || op === '>=') {
        setAfter(a, b, op === '>=');
        setBefore(b, a, op === '>=');
      } else {
        setBefore(a, b, op === '<=');
        setAfter(b, a, op === '<=');
      }
    }
  }
  return info;
}

/** True when a (normalized) column name suggests a hash / secret / token value. */
function isHashName(name: string): boolean {
  return (
    /^(hash|digest|secret|token|passphrase)$/.test(name) ||
    /tokenhash|passwordhash|passhash|accesskey|apikey|api_key|secretkey|clientsecret|appsecret|appid|privatekey|publickey/.test(name)
  );
}

/** True when a (normalized) column name suggests a short opaque token / code. */
function isTokenName(name: string): boolean {
  return (
    /^prefix$/.test(name) ||
    /tokenprefix/.test(name) ||
    /(code|ref|reference|sku|ticketno|ticketnum|orderno|order_no|trackingno|trackingnum|invno|invoiceno|serialno)$/.test(name)
  );
}

/** Parse a column's DEFAULT expression; when it is a JSON value, return it. */
function jsonDefault(dflt: string | null): unknown {
  if (!dflt) return null;
  let s = String(dflt).trim();
  // Unwrap a single-quoted SQL string literal, e.g. '{"scope":"read-only"}'.
  const m = s.match(/^'((?:[^']|'')*)'$/);
  if (m) s = m[1].replace(/''/g, "'");
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * True when a TEXT-ish column must hold valid JSON: it is referenced by a
 * JSON-expression index (e.g. `Permissions ->> 'scope'`), its default is JSON,
 * or its name strongly implies a JSON document. Filling such a column with
 * random words throws "malformed JSON" at insert time.
 */
function isJsonColumn(col: ColumnInfo, hasJsonIndex: boolean): boolean {
  if (!isTextishType(col.type)) return false;
  if (hasJsonIndex) return true;
  if (jsonDefault(col.dflt_value) != null) return true;
  const name = normName(col.name);
  return (
    /^(permissions|settings|config|configuration|preferences|prefs|metadata|meta|attributes|payload|options|allowedapps|socialaccounts|positions|fcmtokens|fcm_tokens|scopes|profile|json|jsonb)$/.test(name) ||
    /(^|_)(settings|config|configuration|permissions|prefs|metadata|attributes|payload|options|allowedapps|scopes|profile)$/.test(name)
  );
}

/**
 * Columns + keys referenced by JSON operators in an index statement
 * (`->`, `->>`, `json_extract`). PRAGMA index_info reports expression-index
 * columns as null, so the SQL text is the reliable source.
 */
function extractJsonColumns(sql: string): { col: string; keys: string[] }[] {
  const out: { col: string; keys: string[] }[] = [];
  const push = (col: string, key?: string) => {
    let entry = out.find((e) => e.col === col);
    if (!entry) {
      entry = { col, keys: [] };
      out.push(entry);
    }
    if (key) {
      const last = key.split('.').pop()!.replace(/[\[\]"]/g, '');
      if (last && !entry.keys.includes(last)) entry.keys.push(last);
    }
  };
  // "col" ->> 'key' | col ->> 'key' | -> 'key'
  const arrow = /"([^"]+)"\s*(?:->>|->)\s*'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)\s*(?:->>|->)\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = arrow.exec(sql))) push(m[1] || m[3], m[2] || m[4]);
  // json_extract("col", '$.key') | json_extract(col, '$.key')
  const jx = /json_extract\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*'(?:\$\??|\.)?\.?([^']+)'/g;
  while ((m = jx.exec(sql))) push(m[1] || m[2], m[3]);
  return out;
}

/**
 * Pick a sensible default plan for a column. Order matters: foreign keys and
 * primary keys first, then explicit types, then name-based heuristics for TEXT.
 */
function detectPlan(col: ColumnInfo, fk: ForeignKeyInfo | null): ColumnPlan {
  const type = (col.type || '').toUpperCase();
  const rawName = col.name.toLowerCase();
  const name = normName(col.name);

  if (fk) return { strategy: 'fk' };

  if (col.pk) {
    if (type.startsWith('INTEGER')) return { strategy: 'skip' }; // autoincrement / rowid
    if (type === 'TEXT' || type === 'BLOB') return { strategy: 'uuid' };
    return { strategy: 'skip' };
  }

  if (type === 'BOOLEAN') return { strategy: 'bool' };

  // Integer flags (is_active, has_badge, …) are booleans in disguise.
  if (
    type.startsWith('INTEGER') &&
    /(^|_)(is|has|can|should|did)_|_flag$|active|enabled|verified|published|deleted|archived|paid|completed|approved/.test(rawName)
  ) {
    return { strategy: 'bool' };
  }

  if (type === 'DATE' || /^date|birthdate|dob|birthday/.test(rawName)) {
    return name.includes('birth')
      ? { strategy: 'date', from: '1950-01-01', to: '2000-12-31' }
      : { strategy: 'date', from: '2020-01-01', to: '2026-12-31' };
  }
  if (type === 'DATETIME' || type === 'TIMESTAMP' || isTimestampName(name)) {
    return { strategy: 'datetime', from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' };
  }
  if (type === 'TIME' || name === 'time') return { strategy: 'time' };

  if (type.startsWith('INTEGER')) {
    if (name.includes('year')) return { strategy: 'int', min: 1990, max: 2026 };
    if (name.includes('age')) return { strategy: 'int', min: 18, max: 90 };
    if (/(count|quantity|qty|stock|views|likes|total|num|number)$/.test(name)) return { strategy: 'int', min: 0, max: 100000 };
    if (name.includes('rating') || name.includes('score')) return { strategy: 'int', min: 1, max: 5 };
    return { strategy: 'int', min: 1, max: 1000 };
  }

  if (type === 'REAL') {
    if (/(price|cost|amount|total|salary|balance)/.test(name)) return { strategy: 'decimal', min: 1, max: 5000, precision: 2 };
    if (name.includes('rating')) return { strategy: 'decimal', min: 1, max: 5, precision: 1 };
    return { strategy: 'decimal', min: 1, max: 1000, precision: 2 };
  }

  if (type === 'BLOB') return { strategy: 'bytes', minLen: 8, maxLen: 32 };

  // TEXT / untyped → name-based heuristics.
  if (isHashName(name)) return { strategy: 'hash', minLen: 32, maxLen: 64 };
  if (isTokenName(name)) return { strategy: 'token', minLen: 6, maxLen: 12 };
  if (/uuid|guid/.test(name)) return { strategy: 'uuid' };
  if (name === 'id' || name === 'uid' || name === 'key') return { strategy: 'uuid' };
  if (name.includes('first') && name.includes('name')) return { strategy: 'first' };
  if (/(lastname|surname|familyname)/.test(name) || (name.includes('last') && name.includes('name'))) return { strategy: 'last' };
  if (name === 'name' || name === 'fullname' || (name.includes('full') && name.includes('name'))) return { strategy: 'fullname' };
  if (name.includes('email') || name.includes('mail')) return { strategy: 'email' };
  if (/(username|login|handle|nick|nickname|account|user)/.test(name)) return { strategy: 'username' };
  if (/(phone|mobile|telephone|cell|fax)/.test(name)) return { strategy: 'phone' };
  if (name.includes('city') || name.includes('town')) return { strategy: 'city' };
  if (name.includes('country') || name.includes('nation')) return { strategy: 'country' };
  if (/(postal|zip)/.test(name)) return { strategy: 'postal' };
  if (/(address|street|addr)/.test(name)) return { strategy: 'address' };
  if (/(url|website|site|link|homepage|href)/.test(name)) return { strategy: 'url' };
  if (/(domain|host)/.test(name)) return { strategy: 'domain' };
  if (name === 'ip' || /(ipaddr|ipv4|ip_address)/.test(name)) return { strategy: 'ip' };
  if (/(description|content|body|comment|message|note|bio|summary|details)/.test(name)) return { strategy: 'sentence', minLen: 1, maxLen: 2 };
  if (/(title|subject|category|status|type|tag|label|color|role)/.test(name)) return { strategy: 'words', minLen: 1, maxLen: 3 };
  return { strategy: 'words', minLen: 1, maxLen: 4 };
}

/** The strategies a column may use, in UI order. */
function strategiesFor(col: ColumnInfo, fk: ForeignKeyInfo | null): StrategyDescriptor[] {
  const type = (col.type || '').toUpperCase();
  const rawName = col.name.toLowerCase();
  const name = normName(col.name);
  const out: StrategyDescriptor[] = [];
  const add = (id: GeneratorStrategyId, label: string) => out.push({ id, label });

  add('skip', 'Skip — let the DB default apply');
  add('null', 'Set NULL');
  add('fixed', 'Fixed value');
  add('list', 'Random from list');
  if (fk) add('fk', `Random from ${fk.table}${fk.to ? `.${fk.to}` : ''}`);

  if (type === 'BOOLEAN' || (type.startsWith('INTEGER') && /flag|active|enabled|status/.test(col.name.toLowerCase()))) {
    add('bool', 'Random boolean');
  }
  if (type.startsWith('INTEGER')) add('int', 'Random integer');
  if (type === 'REAL') add('decimal', 'Random decimal');
  if (type === 'DATE') add('date', 'Random date');
  if (type === 'DATETIME' || type === 'TIMESTAMP') add('datetime', 'Random datetime');
  if (type === 'TIME') add('time', 'Random time');
  if (type === 'BLOB') add('bytes', 'Random bytes');

  if (isTextishType(type)) {
    // Date-ish TEXT columns usually hold ISO timestamps (e.g. a
    // strftime('%Y-%m-%dT%H:%M:%fZ','now') default). Offer the matching
    // generators so a detected date/datetime/time default stays valid for them.
    if (/^date|birthdate|dob|birthday/.test(rawName)) add('date', 'Random date');
    if (isTimestampName(name)) add('datetime', 'Random datetime');
    if (name === 'time') add('time', 'Random time');

    add('json', 'Valid JSON object');
    add('hash', 'Random hash (hex)');
    add('token', 'Random token');
    add('words', 'A few words');
    add('sentence', 'Sentence(s)');
    add('first', 'First name');
    add('last', 'Last name');
    add('fullname', 'Full name');
    add('email', 'Email');
    add('username', 'Username');
    add('phone', 'Phone number');
    add('city', 'City');
    add('country', 'Country');
    add('postal', 'Postal code');
    add('address', 'Street address');
    add('url', 'URL');
    add('domain', 'Domain');
    add('ip', 'IP address');
    add('uuid', 'UUID');
  }
  return out;
}

/**
 * A safe, value-generating default plan for a column's declared type. Used as a
 * fallback whenever the name/type heuristic would pick a strategy the column
 * does not actually support, or a NOT NULL column cannot be skipped.
 */
function fallbackPlanFor(col: ColumnInfo): ColumnPlan {
  const type = (col.type || '').toUpperCase();
  if (type === 'BOOLEAN') return { strategy: 'bool' };
  if (type.startsWith('INTEGER')) return { strategy: 'int', min: 1, max: 1000 };
  if (type === 'REAL') return { strategy: 'decimal', min: 1, max: 1000, precision: 2 };
  if (type === 'DATE') return { strategy: 'date', from: '2020-01-01', to: '2026-12-31' };
  if (type === 'DATETIME' || type === 'TIMESTAMP') return { strategy: 'datetime', from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' };
  if (type === 'TIME') return { strategy: 'time' };
  if (type === 'BLOB') return { strategy: 'bytes', minLen: 8, maxLen: 32 };
  return { strategy: 'words', minLen: 1, maxLen: 4 };
}

/**
 * Compute per-column generator configuration for a table (default strategies,
 * available strategies, FK metadata). Pure — no DB access — so the page route
 * and the API can share it.
 */
export function buildColumnConfigs(info: TableInfoData): ColumnGeneratorConfig[] {
  const fkByColumn = new Map<string, ForeignKeyInfo>();
  for (const fk of info.foreignKeys) fkByColumn.set(fk.from, fk);

  // Which columns are covered by a single-column UNIQUE index (their generated
  // values must be unique) and which columns are referenced by a JSON-expression
  // index (their generated values must be valid JSON).
  const uniqueCols = new Set<string>();
  const jsonIndexKeys = new Map<string, string[]>();
  for (const ix of info.indexes ?? ([] as IndexInfo[])) {
    // Single-column UNIQUE indexes (PRAGMA index_info reports real names for
    // regular indexes; expression indexes have name=null and are skipped).
    if (ix.unique && ix.columns.length === 1 && ix.columns[0]) uniqueCols.add(ix.columns[0]);
    // JSON-expression indexes: columns must be filled with valid JSON.
    if (ix.sql && /json_extract|->>|->\s*'|json_/i.test(ix.sql)) {
      for (const { col, keys } of extractJsonColumns(ix.sql)) {
        if (!col) continue;
        const merged = new Set([...(jsonIndexKeys.get(col) ?? []), ...keys]);
        if (merged.size) jsonIndexKeys.set(col, [...merged]);
      }
    }
  }

  // CHECK constraints (JSON value whitelists + column ordering) the generator
  // can honor so generated rows pass the table's CHECKs.
  const checkInfo = parseChecks(info.sql ?? null);

  return info.columns.map((col) => {
    const fk = fkByColumn.get(col.name) ?? null;
    const strategies = strategiesFor(col, fk);
    const unique = uniqueCols.has(col.name);
    let defaultPlan = detectPlan(col, fk);

    // A column referenced by a JSON-expression index (or with a JSON default /
    // JSON-like name) must hold valid JSON — filling it with random words throws
    // "malformed JSON" at insert time because the index evaluates the JSON path.
    if (defaultPlan.strategy !== 'fk' && !col.pk && isJsonColumn(col, jsonIndexKeys.has(col.name))) {
      const keys = jsonIndexKeys.get(col.name);
      const useKeys = keys && keys.length ? keys : ['scope', 'enabled', 'allowedApps'];
      const allowed = checkInfo.jsonAllowed.get(col.name);
      const jsonValues: Record<string, string[]> = {};
      if (allowed) for (const k of useKeys) {
        const vals = allowed.get(k);
        if (vals && vals.length) jsonValues[k] = vals;
      }
      defaultPlan = {
        strategy: 'json',
        jsonKeys: useKeys,
        ...(Object.keys(jsonValues).length ? { jsonValues } : {}),
      };
    }

    // The detected default must always be a strategy the column actually
    // supports (e.g. TEXT "CreatedAt" detects as datetime, so datetime must be
    // offered to TEXT columns — see strategiesFor). Any remaining mismatch
    // falls back to a type-appropriate value generator so the default can never
    // be rejected by generateRows.
    if (!strategies.some((s) => s.id === defaultPlan.strategy)) {
      defaultPlan = fallbackPlanFor(col);
    }

    // A NOT NULL column without a default cannot fall back on skip/NULL (unless
    // it is a primary key, which SQLite fills for us).
    if (!col.pk && col.notnull && col.dflt_value == null && (defaultPlan.strategy === 'skip' || defaultPlan.strategy === 'null')) {
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

// ---- Plan sanitization (from untrusted client input) ----------------------

const PLAN_KEYS = ['value', 'values', 'min', 'max', 'precision', 'from', 'to', 'minLen', 'maxLen', 'jsonKeys'] as const;

/**
 * Validate/normalize a client-supplied per-column plan. Returns null when the
 * payload is not a usable plan. Strategy validity against the column's allowed
 * set is enforced later by `generateRows`.
 */
export function sanitizeColumnPlan(raw: unknown): ColumnPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.strategy !== 'string' || !r.strategy) return null;

  const out: ColumnPlan = { strategy: r.strategy as GeneratorStrategyId };
  for (const key of PLAN_KEYS) {
    const v = r[key];
    if (v === undefined || v === null) continue;
    if (key === 'values') {
      if (Array.isArray(v)) out.values = (v as unknown[]).map((x) => String(x));
    } else if (key === 'jsonKeys') {
      const raw = Array.isArray(v) ? (v as unknown[]).map(String) : String(v).split(/[,;]/);
      out.jsonKeys = raw.map((s) => s.trim()).filter(Boolean);
    } else if (key === 'value' || key === 'from' || key === 'to') {
      out[key] = String(v);
    } else {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    }
  }

  // Per-key allowed JSON values (derived from CHECK constraints on the server;
  // passed through untouched so a generated plan keeps them).
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

// ---- Value generation -----------------------------------------------------

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const JSON_SCOPES = ['read-only', 'read-write', 'admin', 'user', 'internal'];
const JSON_APPS = ['portal', 'api', 'dashboard', 'worker', 'admin', 'web', 'mobile'];

function randomAlnum(min: number, max: number): string {
  const len = randInt(min, max);
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[randInt(0, ALNUM.length - 1)];
  return s;
}

/** Pick a plausible JSON value for a key (key-name aware, but always valid JSON). */
function jsonValueForKey(key: string): unknown {
  const k = key.toLowerCase();
  if (k.includes('scope') || k === 'role' || k === 'access') return pick(JSON_SCOPES);
  if (/(enabled|active|flag|locked|verified|required|readonly|is_)/.test(k)) return Math.random() < 0.6;
  if (/(count|limit|max|min|ttl|expires|duration|port|timeout|attempts)/.test(k)) return randInt(0, 10000);
  if (/(apps|app|tags|roles|scopes|permissions|names|ids|items|keys)/.test(k)) {
    if (Math.random() < 0.3) return null;
    const n = randInt(1, 4);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(pick(JSON_APPS));
    return out;
  }
  const roll = Math.random();
  if (roll < 0.45) return pick(['alpha', 'beta', 'stable', 'draft', 'on', 'off', 'default', 'custom']);
  if (roll < 0.6) return randInt(0, 1000);
  if (roll < 0.75) return Math.random() < 0.5;
  if (roll < 0.9) return null;
  return makeUuid();
}

/** Build a valid JSON object from a set of keys (or a small sensible default). */
function makeJsonObject(keys?: string[], jsonValues?: Record<string, string[]>): string {
  const k = (keys && keys.length ? keys : ['scope', 'enabled', 'flags']).slice(0, 16);
  const obj: Record<string, unknown> = {};
  for (const key of k) {
    const allowed = jsonValues ? jsonValues[key] : undefined;
    obj[key] = allowed && allowed.length ? pick(allowed) : jsonValueForKey(key);
  }
  return JSON.stringify(obj);
}

/** Distinct non-null values of a foreign key's referenced column. */
async function sampleFkValues(db: SqliteDatabase, fk: ForeignKeyInfo | null): Promise<unknown[]> {
  if (!fk) return [];
  try {
    const ref = await db.getTableInfo(fk.table);
    if (!ref.success || !ref.data || !ref.data.columns.length) return [];
    const refCol = fk.to || ref.data.primaryKey[0] || ref.data.columns[0].name;
    if (!refCol) return [];
    const r = await db.all(
      `SELECT DISTINCT ${quoteIdentifier(refCol)} AS v FROM ${quoteIdentifier(fk.table)} WHERE ${quoteIdentifier(refCol)} IS NOT NULL LIMIT 1000`,
    );
    return ((r.data ?? []) as { v?: unknown }[]).map((row) => row.v).filter((v) => v != null);
  } catch {
    return [];
  }
}

/** Generate a single value for a column from its plan (or SKIP to omit it). */
function generateOne(col: ColumnInfo, p: ColumnPlan, fkPool?: unknown[]): unknown {
  const type = (col.type || '').toUpperCase();

  switch (p.strategy) {
    case 'skip':
      return SKIP;
    case 'null':
      return null;
    case 'fixed':
      return coerceFormValue(p.value ?? '', col.type);
    case 'list': {
      const vals = (p.values ?? []).filter((v) => String(v).trim() !== '');
      if (!vals.length) return SKIP;
      return coerceFormValue(pick(vals), col.type);
    }
    case 'first':
      return coerceFormValue(pick(FIRST_NAMES), col.type);
    case 'last':
      return coerceFormValue(pick(LAST_NAMES), col.type);
    case 'fullname':
      return coerceFormValue(`${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, col.type);
    case 'email':
      return coerceFormValue(makeEmail(), col.type);
    case 'username':
      return coerceFormValue(makeUsername(), col.type);
    case 'phone':
      return coerceFormValue(makePhone(), col.type);
    case 'city':
      return coerceFormValue(pick(CITIES), col.type);
    case 'country':
      return coerceFormValue(pick(COUNTRIES), col.type);
    case 'postal':
      return coerceFormValue(String(randInt(10000, 99999)), col.type);
    case 'address':
      return coerceFormValue(makeAddress(), col.type);
    case 'url':
      return coerceFormValue(`https://www.${pick(DOMAINS)}/${slug()}`, col.type);
    case 'domain':
      return coerceFormValue(pick(DOMAINS), col.type);
    case 'ip':
      return coerceFormValue(makeIp(), col.type);
    case 'uuid':
      return coerceFormValue(makeUuid(), col.type);
    case 'words':
      return coerceFormValue(makeWords(p.minLen ?? 1, p.maxLen ?? 4), col.type);
    case 'sentence':
      return coerceFormValue(makeSentences(p.minLen ?? 1, p.maxLen ?? 2), col.type);
    case 'int': {
      const min = p.min ?? 1;
      const max = Math.max(min, p.max ?? 1000);
      return coerceFormValue(String(randInt(min, max)), type || 'INTEGER');
    }
    case 'decimal': {
      const min = p.min ?? 1;
      const max = Math.max(min, p.max ?? 1000);
      const prec = Math.max(0, Math.min(10, p.precision ?? 2));
      return coerceFormValue(randFloat(min, max).toFixed(prec), type || 'REAL');
    }
    case 'date':
      return coerceFormValue(randomDate(p.from, p.to, 'date'), type || 'TEXT');
    case 'datetime':
      return coerceFormValue(randomDate(p.from, p.to, 'datetime'), type || 'TEXT');
    case 'time':
      return coerceFormValue(randomTime(), type || 'TEXT');
    case 'bool':
      return coerceFormValue(pick(['1', '0']), type || 'BOOLEAN');
    case 'bytes': {
      const len = randInt(Math.max(0, p.minLen ?? 8), Math.max(1, p.maxLen ?? 32));
      const buf = Buffer.alloc(len);
      for (let i = 0; i < len; i++) buf[i] = randInt(0, 255);
      return coerceFormValue(`0x${buf.toString('hex')}`, type || 'BLOB');
    }
    case 'json':
      return coerceFormValue(makeJsonObject(p.jsonKeys, p.jsonValues), type || 'TEXT');
    case 'hash': {
      const min = Math.max(8, p.minLen ?? 32);
      const max = Math.max(min, p.maxLen ?? 64);
      const len = randInt(min, max);
      return coerceFormValue(randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len), type || 'TEXT');
    }
    case 'token':
      return coerceFormValue(randomAlnum(Math.max(2, p.minLen ?? 6), Math.max(2, p.maxLen ?? 12)), type || 'TEXT');
    case 'fk': {
      if (!fkPool || !fkPool.length) return null;
      return fkPool[randInt(0, fkPool.length - 1)];
    }
    default:
      return SKIP;
  }
}

/**
 * Generate `count` rows for a table. `plan` is a per-column override map;
 * columns without an entry use their detected default plan. Values are coerced
 * to the column's declared type for SQLite binding.
 *
 * Throws when a plan uses a strategy that the column does not support.
 */
function stringifyKey(v: unknown): string {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `buf:${Buffer.from(v).toString('hex')}`;
  return `${typeof v}:${String(v)}`;
}

/** Append a unique suffix to a colliding value (numeric columns stay numeric). */
function uniqueSuffix(base: unknown, seen: Set<string>): unknown {
  if (typeof base === 'number' && Number.isFinite(base)) {
    let n = Number(base);
    while (seen.has(stringifyKey(n))) n += 1;
    return n;
  }
  let i = 1;
  let cand = `${String(base)}-${i}`;
  while (seen.has(stringifyKey(cand))) {
    i += 1;
    cand = `${String(base)}-${i}`;
  }
  return cand;
}

/**
 * Move `value` so it is strictly after / before `base` (or equal when
 * `orEqual`), for datetime/date strings and numbers. Unrecognized types are
 * returned unchanged.
 */
function orderedValue(value: unknown, base: unknown, dir: 'after' | 'before', orEqual: boolean): unknown {
  const v = value;
  const b = base;
  if (typeof v === 'string' && typeof b === 'string') {
    const tv = Date.parse(v);
    const tb = Date.parse(b);
    if (Number.isFinite(tv) && Number.isFinite(tb)) {
      if (dir === 'after') {
        if (orEqual ? tv < tb : tv <= tb) return new Date(tb + 1000).toISOString();
      } else if (orEqual ? tv > tb : tv >= tb) {
        return new Date(tb - 1000).toISOString();
      }
      return v;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && /^\d{4}-\d{2}-\d{2}$/.test(b)) {
      const dv = Date.parse(`${v}T00:00:00Z`);
      const db = Date.parse(`${b}T00:00:00Z`);
      if (dir === 'after') {
        if (orEqual ? dv < db : dv <= db) return new Date(db + 86400_000).toISOString().slice(0, 10);
      } else if (orEqual ? dv > db : dv >= db) {
        return new Date(db - 86400_000).toISOString().slice(0, 10);
      }
      return v;
    }
  }
  if (typeof v === 'number' && typeof b === 'number') {
    if (dir === 'after') return orEqual ? Math.max(v, b) : Math.max(v, b + 1);
    return orEqual ? Math.min(v, b) : Math.min(v, b - 1);
  }
  return v;
}

/** Apply per-row ordering CHECKs (e.g. ExpiresAt > CreatedAt) in place. */
function applyOrdering(fields: WhereClause[], ordering: Map<string, OrderingConstraint>): void {
  if (!ordering.size) return;
  const byCol = new Map(fields.map((f) => [f.column, f]));
  for (const f of fields) {
    const rel = ordering.get(f.column);
    if (!rel) continue;
    if (rel.after && f.value != null) {
      const other = byCol.get(rel.after.column);
      if (other && other.value != null) f.value = orderedValue(f.value, other.value, 'after', rel.after.orEqual);
    }
    if (rel.before && f.value != null) {
      const other = byCol.get(rel.before.column);
      if (other && other.value != null) f.value = orderedValue(f.value, other.value, 'before', rel.before.orEqual);
    }
  }
}

export async function generateRows(
  db: SqliteDatabase,
  info: TableInfoData,
  configs: ColumnGeneratorConfig[],
  count: number,
  plan: Record<string, ColumnPlan> = {},
): Promise<GenerateResult> {
  const fkByColumn = new Map<string, ForeignKeyInfo>();
  for (const fk of info.foreignKeys) fkByColumn.set(fk.from, fk);

  // Columns with a single-column UNIQUE index must get distinct values.
  const uniqueCols = new Set<string>();
  for (const cfg of configs) if (cfg.unique) uniqueCols.add(cfg.name);

  // CHECK constraints (JSON whitelists + column ordering).
  const checkInfo = parseChecks(info.sql ?? null);

  const warnings: string[] = [];
  const prepared: { col: ColumnInfo; plan: ColumnPlan }[] = [];
  const fkPools = new Map<string, unknown[]>();
  // A NOT NULL FK whose referenced table is empty cannot be satisfied (SQLite
  // enforces FKs) — the column is omitted from generated rows with a clear
  // warning so the user knows to seed the referenced table first.
  const fkOmit = new Set<string>();

  for (const col of info.columns) {
    const cfg = configs.find((c) => c.name === col.name);
    const raw = plan[col.name];
    const p = raw && raw.strategy ? raw : (cfg?.defaultPlan ?? { strategy: 'skip' });

    if (!cfg || !cfg.strategies.some((s) => s.id === p.strategy)) {
      throw new Error(`Unsupported generator strategy "${p.strategy}" for column "${col.name}".`);
    }

    if (p.strategy === 'list' && !(p.values ?? []).some((v) => String(v).trim() !== '')) {
      warnings.push(`Column "${col.name}": the list is empty, so it will be skipped (DB default applies).`);
    }
    if ((p.strategy === 'skip' || p.strategy === 'null') && !col.pk && col.notnull && col.dflt_value == null) {
      warnings.push(`Column "${col.name}" is NOT NULL without a default — "${p.strategy}" rows may fail to insert.`);
    }
    if (p.strategy === 'fk') {
      const pool = await sampleFkValues(db, fkByColumn.get(col.name) ?? null);
      fkPools.set(col.name, pool);
      const refTable = fkByColumn.get(col.name)?.table ?? '?';
      if (!pool.length) {
        if (col.notnull && !col.pk) {
          fkOmit.add(col.name);
          warnings.push(
            `Column "${col.name}" is a NOT NULL foreign key to "${refTable}", which has no rows. It is omitted from generated rows — seed "${refTable}" first so the insert can reference real values.`,
          );
        } else {
          warnings.push(`Column "${col.name}": "${refTable}" is empty, so NULL will be inserted.`);
        }
      }
    }

    prepared.push({ col, plan: p });
  }

  const rows: WhereClause[][] = [];
  const uniqueSeen = new Map<string, Set<string>>();
  for (let i = 0; i < count; i++) {
    const fields: WhereClause[] = [];
    for (const { col, plan: p } of prepared) {
      if (p.strategy === 'fk' && fkOmit.has(col.name)) continue;
      let v = generateOne(col, p, fkPools.get(col.name));
      if (v === SKIP) continue;

      if (uniqueCols.has(col.name)) {
        const seen = uniqueSeen.get(col.name) ?? new Set<string>();
        let attempts = 0;
        while (seen.has(stringifyKey(v)) && attempts < 20) {
          v = generateOne(col, p, fkPools.get(col.name));
          attempts += 1;
        }
        if (seen.has(stringifyKey(v))) {
          warnings.push(`Column "${col.name}" is UNIQUE but the generator kept colliding — appended a suffix to keep rows insertable.`);
          v = uniqueSuffix(v, seen);
        }
        seen.add(stringifyKey(v));
        uniqueSeen.set(col.name, seen);
      }

      fields.push({ column: col.name, value: v });
    }
    // Honor CHECK ordering constraints (e.g. ExpiresAt > CreatedAt) so rows pass.
    applyOrdering(fields, checkInfo.ordering);
    rows.push(fields);
  }

  return { rows, warnings };
}

/**
 * Render generated rows as a sequence of INSERT statements for preview
 * ("generate but never execute"). Each row is its own statement so per-row
 * column lists (with skips) stay valid.
 */
export function buildSeedInsertSql(table: string, rows: WhereClause[][]): string {
  return rows
    .map((fields) => {
      const cols = fields.map((f) => quoteIdentifier(f.column));
      const vals = fields.map((f) => sqlValue(f.value));
      return `INSERT INTO ${quoteIdentifier(table)} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
    })
    .join('\n');
}
