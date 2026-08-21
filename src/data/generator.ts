/**
 * Data generator / seeder engine.
 *
 * Given a table's schema, every column can be filled with realistic fake data
 * from a chosen "strategy" — first name, email, UUID, job title, company,
 * avatar, currency, sequential numbering, pattern template, foreign key sampling,
 * and many more.
 *
 * Responsibilities:
 *  - auto-detect a sensible default strategy per column (column name + type +
 *    foreign key), so the "Seed data" page works with zero configuration;
 *  - generate N rows of concrete, type-coerced values (ready for SQLite
 *    binding via `db.insertRows`);
 *  - render the generated rows as a multi-row INSERT for the "preview SQL"
 *    mode that never executes;
 *  - generate structured preview rows for the interactive preview grid.
 */

import { randomBytes } from 'node:crypto';
import type { SqliteDatabase, TableInfoData, ColumnInfo, ForeignKeyInfo, WhereClause, IndexInfo } from '../db/database';
import { coerceFormValue } from '../util';
import { quoteIdentifier, sqlValue } from '../sql/generator';

/** Hard cap on how many rows a single seed run may generate. */
export const MAX_SEED_ROWS = 5000;

export type StrategyCategory =
  | 'identity'
  | 'contact_web'
  | 'commerce'
  | 'location'
  | 'numeric'
  | 'datetime'
  | 'system_crypto'
  | 'custom_control'
  | 'relational';

export type GeneratorStrategyId =
  // Control / Custom
  | 'skip' | 'null' | 'fixed' | 'list' | 'pattern'
  // Identity & People
  | 'first' | 'last' | 'fullname' | 'username' | 'job'
  // Contact & Web
  | 'email' | 'phone' | 'url' | 'domain' | 'ip' | 'avatar'
  // Commerce & Business
  | 'company' | 'currency' | 'status' | 'creditCard'
  // Location
  | 'city' | 'country' | 'state' | 'postal' | 'address' | 'countryCode' | 'latitude' | 'longitude'
  // Text & Content
  | 'words' | 'sentence' | 'paragraph' | 'slug'
  // Numbers & Math
  | 'int' | 'decimal' | 'sequence'
  // Date & Time
  | 'date' | 'datetime' | 'time' | 'timestampUnix'
  // System, Crypto & Tech
  | 'bool' | 'bytes' | 'json' | 'hash' | 'token' | 'uuid' | 'color' | 'mac'
  // Relational
  | 'fk';

/** Per-column generator settings. Which options are meaningful depends on `strategy`. */
export interface ColumnPlan {
  strategy: GeneratorStrategyId;
  /** `fixed` / `list` and the string-ish options. */
  value?: string;
  /** `list` — random value picked from this set. */
  values?: string[];
  /** `int` / `decimal` / `latitude` / `longitude` range. */
  min?: number;
  max?: number;
  /** `decimal` — digits after the decimal point. */
  precision?: number;
  /** `date` / `datetime` / `timestampUnix` bounds (ISO strings). */
  from?: string;
  to?: string;
  /** `words` / `bytes` / `hash` / `token` / `sentence` — length bounds. */
  minLen?: number;
  maxLen?: number;
  /** `json` — object keys to include (comma-separated in the UI). */
  jsonKeys?: string[];
  /** `json` — per-key allowed values, derived from CHECK constraints. */
  jsonValues?: Record<string, string[]>;
  /** Percentage chance (0 to 100) to generate NULL for nullable columns. */
  nullPct?: number;
  /** Optional string prefix to prepend to generated string/text values. */
  prefix?: string;
  /** Optional string suffix to append to generated string/text values. */
  suffix?: string;
  /** Sequence start (for `sequence` strategy). */
  start?: number;
  /** Sequence step increment (for `sequence` strategy). */
  step?: number;
  /** Custom pattern template with tokens (for `pattern` strategy). */
  pattern?: string;
  /** Format variation (e.g. 'hex' | 'name' for color, 'sec' | 'ms' for unix timestamp). */
  format?: string;
}

/** A strategy choice offered to the UI for a column. */
export interface StrategyDescriptor {
  id: GeneratorStrategyId;
  label: string;
  category: StrategyCategory;
  description?: string;
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
  /** Structured row records for interactive UI table preview. */
  previewRows: Record<string, unknown>[];
  /** Non-fatal notes surfaced to the user (e.g. a NOT NULL column being skipped). */
  warnings: string[];
}

/** Sentinel returned by value generation when the column should be omitted from the row. */
export const SKIP = Symbol('skip');

// ---- Static data sets ----------------------------------------------------

export const FIRST_NAMES = [
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
  "Dae-hyun", "Dao", "Rama", "Aiko", "Min-jun", "Zhu", "Radia", "Wei", "Sophia", "Lucas",
  "Emma", "Liam", "Olivia", "Noah", "Elena", "Mateo", "Chloe", "Alexander", "Aria", "Leo"
];

export const LAST_NAMES = [
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

export const CITIES = [
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

export const COUNTRIES = [
  "Japan", "United States", "Bhutan", "Belgium", "Myanmar", "Kazakhstan", "Mexico",
  "Bangladesh", "United Kingdom", "South Africa", "Indonesia", "Vietnam", "South Korea", "Germany",
  "Romania", "Italy", "Spain", "China", "India", "Taiwan", "Philippines",
  "Singapore", "Canada", "Pakistan", "Hungary", "Maldives", "Switzerland", "Macau",
  "Portugal", "Sri Lanka", "Malaysia", "Netherlands", "Turkmenistan", "Brunei", "Brazil",
  "Greece", "Uzbekistan", "Cambodia", "France", "Australia", "Mongolia", "Poland",
  "Kyrgyzstan", "Tajikistan", "Norway", "Sweden", "Ireland", "Austria", "Denmark",
  "Laos", "Nepal", "Thailand", "Finland", "Hong Kong", "Czech Republic", "Timor-Leste", "New Zealand"
];

export const DOMAINS = [
  "outlook.com", "nus.edu.sg", "ust.hk", "iitb.ac.in", "acme.io", "ac.sg", "mail.ru", "163.com",
  "outlook.kr", "tech.asia", "startup.io", "proton.me", "sohu.com", "gmail.com", "kyoto-u.ac.jp", 
  "example.com", "naver.com", "protonmail.com", "hanmail.net", "globex.org", "tudelft.nl", "company.com",
  "yahoo.com", "126.com", "daum.net", "initech.net", "hkbu.edu.hk", "yahoo.co.jp", "qq.com", "nthu.edu.tw",
  "sina.com", "innovate.sg", "zoho.com"
];

export const LOREM_WORDS = [  
  "schema", "nu", "worker", "alpha", "cache", "edge", "async", "chi", "service", "packet",
  "scale", "upsilon", "scrum", "node", "peace", "deploy", "epsilon", "lambda", "record", "pi",
  "column", "module", "omicron", "query", "buffer", "persistence", "comet", "joy", "integrity", "galaxy",
  "token", "spirit", "socket", "devops", "harmony", "backup", "agile", "render", "await", "field",
  "aurora", "nature", "gamma", "cloud", "omega", "mu", "orbit", "delta", "kindness", "tau",
  "row", "compassion", "theta", "beta", "balance", "wisdom", "rho", "kanban", "kappa", "session",
  "compile", "phi", "stream", "queue", "event", "pixel", "resilience", "nebula", "iota", "index",
  "cluster", "xi", "eta", "signal", "zeta", "fetch", "sigma", "psi", "prism", "nexus"
];

export const COMPANIES = [
  "Apex Solutions", "Vortex Digital", "Nexus Systems", "Horizon Labs", "Zenith Global",
  "Quantum Dynamics", "Starlight Media", "Alpha Robotics", "Pinnacle Financial", "BlueWave Tech",
  "Elevate Innovations", "Pulse Health", "Echo Stream", "Stratum Capital", "Beacon Analytics",
  "Solaris Energy", "Vertex Cloud", "Catalyst Corp", "Synergy Ventures", "Omega Group",
  "Hyperion Logic", "Aegis Security", "Terra Industries", "Prism Data", "Spectra Works",
  "Novus Labs", "Orbit Software", "Forge Interactive", "Crestline Global", "Ironclad Partners",
  "Acme Corp", "Globex Corporation", "Initech LLC", "Soylent Industries", "Umbrella Tech"
];

export const JOB_TITLES = [
  "Software Engineer", "Product Manager", "UX/UI Designer", "DevOps Specialist",
  "Data Scientist", "Engineering Manager", "Account Executive", "Marketing Director",
  "Content Strategist", "Customer Success Lead", "Financial Analyst", "Operations Lead",
  "HR Generalist", "QA Automation Engineer", "Solutions Architect", "Security Specialist",
  "Chief Technology Officer", "VP of Product", "Database Administrator", "Scrum Master",
  "Technical Writer", "Brand Manager", "Legal Counsel", "Research Scientist", "Sales Director"
];

export const US_STATES = [
  "California", "New York", "Texas", "Florida", "Washington", "Illinois", "Pennsylvania",
  "Ohio", "Georgia", "North Carolina", "Michigan", "New Jersey", "Virginia", "Colorado",
  "Arizona", "Massachusetts", "Tennessee", "Indiana", "Missouri", "Maryland", "Wisconsin",
  "Minnesota", "Oregon", "South Carolina", "Alabama", "Louisiana", "Kentucky", "Utah"
];

export const CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "SGD",
  "NZD", "BRL", "SEK", "KRW", "MXN", "ZAR", "HKD", "NOK", "AED", "SAR"
];

export const COUNTRY_CODES = [
  "US", "GB", "CA", "DE", "FR", "JP", "AU", "IN", "BR", "SG",
  "NL", "IT", "ES", "SE", "CH", "KR", "MX", "NZ", "ZA", "AE",
  "SA", "NO", "DK", "FI", "IE", "PL", "PT", "BE", "AT", "ID"
];

export const STATUSES = [
  "active", "inactive", "pending", "completed", "cancelled",
  "archived", "suspended", "draft", "processing", "approved", "rejected"
];

export const HEX_COLORS = [
  "#3b82f6", "#10b981", "#ef4444", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#6366f1", "#14b8a6", "#f97316",
  "#84cc16", "#a855f7", "#0ea5e9", "#64748b", "#d946ef",
  "#1e293b", "#047857", "#b91c1c", "#1d4ed8", "#4338ca"
];

export const NAMED_COLORS = [
  "Emerald", "Indigo", "Amber", "Rose", "Cyan", "Violet",
  "Sky", "Slate", "Teal", "Fuchsia", "Crimson", "Navy",
  "Coral", "Bronze", "Charcoal", "Mint", "Lavender", "Ruby", "Cobalt"
];

// ---- Random helpers -------------------------------------------------------

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

export function makeSlug(): string {
  return `${pick(LOREM_WORDS)}-${pick(LOREM_WORDS)}-${randInt(100, 999)}`;
}

export function makeEmail(): string {
  return `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}${randInt(1, 99)}@${pick(DOMAINS)}`;
}

export function makeUsername(): string {
  return `${pick(FIRST_NAMES).toLowerCase()}${pick(LAST_NAMES).toLowerCase()}${randInt(1, 9999)}`;
}

export function makePhone(): string {
  return `+1 (${randInt(200, 999)}) ${randInt(200, 999)}-${String(randInt(0, 9999)).padStart(4, '0')}`;
}

export function makeAddress(): string {
  return `${randInt(10, 9999)} ${pick(LOREM_WORDS)} ${pick(['St', 'Ave', 'Rd', 'Blvd', 'Ln', 'Dr'])}, ${pick(CITIES)}`;
}

export function makeIp(): string {
  return `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;
}

export function makeMacAddress(): string {
  const byte = () => randInt(0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `${byte()}:${byte()}:${byte()}:${byte()}:${byte()}:${byte()}`;
}

export function makeCreditCard(): string {
  const b = () => String(randInt(1000, 9999));
  return `4532-${b()}-${b()}-${b()}`;
}

export function makeAvatar(seedVal?: string): string {
  const seed = encodeURIComponent(seedVal || makeUsername());
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}`;
}

export function makeColor(format = 'hex'): string {
  return format === 'name' ? pick(NAMED_COLORS) : pick(HEX_COLORS);
}

export function makeUuid(): string {
  const hex = () => randInt(0, 0xffffffff).toString(16).padStart(8, '0');
  return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-${['8', '9', 'a', 'b'][randInt(0, 3)]}${hex().slice(0, 3)}-${hex()}`;
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

export function makeParagraph(): string {
  return makeSentences(3, 5);
}

/**
 * Replace pattern template placeholders:
 * - `#` with a random digit (0-9)
 * - `A` or `?` with a random uppercase letter (A-Z)
 * - `a` with a random lowercase letter (a-z)
 * - `{YYYY}` with current year
 * - `{YY}` with 2-digit year
 * - `{MM}` with random 2-digit month
 * - `{DD}` with random 2-digit day
 */
export function formatPattern(pattern: string): string {
  if (!pattern) return '';
  const now = new Date();
  const year = String(now.getFullYear());
  const yy = year.slice(-2);
  const mm = String(randInt(1, 12)).padStart(2, '0');
  const dd = String(randInt(1, 28)).padStart(2, '0');

  let s = pattern
    .replace(/\{YYYY\}/g, year)
    .replace(/\{YY\}/g, yy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd);

  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';

  let res = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '#') {
      res += String(randInt(0, 9));
    } else if (ch === 'A' || ch === '?') {
      res += uppercase[randInt(0, uppercase.length - 1)];
    } else if (ch === 'a') {
      res += lowercase[randInt(0, lowercase.length - 1)];
    } else {
      res += ch;
    }
  }
  return res;
}

/**
 * Random date (or datetime) string inside [from, to]; bounds default to the
 * last ~2 years. Datetimes use the ISO-8601 UTC form (YYYY-MM-DDTHH:MM:SS.sssZ).
 */
export function randomDate(from?: string, to?: string, kind: 'date' | 'datetime' = 'date'): string {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const t = randInt(Number.isFinite(lo) ? lo : now - 730 * 86400_000, Number.isFinite(hi) ? hi : now);
  const d = new Date(t);
  if (kind === 'datetime') return d.toISOString();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function randomTime(): string {
  return `${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}`;
}

export function randomUnixTimestamp(format = 'sec', from?: string, to?: string): number {
  const now = Date.now();
  const lo = from ? Date.parse(from) : now - 730 * 86400_000;
  const hi = to ? Date.parse(to) : now;
  const t = randInt(Number.isFinite(lo) ? lo : now - 730 * 86400_000, Number.isFinite(hi) ? hi : now);
  return format === 'ms' ? t : Math.floor(t / 1000);
}

// ---- Column name / type detection ----------------------------------------

/** Lowercase, punctuation stripped — e.g. "first_name" → "firstname". */
export function normName(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a (normalized, lowercase) column name looks like a timestamp / datetime field.
 */
export function isTimestampName(name: string): boolean {
  return (
    /created|updated|modified|registered|joined|timestamp|lastused|lastseen|lastlogin|lastactivity|accessed|viewed|visited|^ts$/.test(name) ||
    /^(created|updated|deleted|archived|occurred|started|ended|expires|published|processed|completed|inserted|requested|resolved|used|seen|accessed|viewed|visited|logged|active)at$/.test(name)
  );
}

/** True when a declared type can reasonably hold text-ish values (incl. JSON). */
export function isTextishType(type: string): boolean {
  const t = (type || '').toUpperCase();
  return t === 'TEXT' || t === '' || t.includes('JSON') || t.includes('CHAR') || t.includes('CLOB') || t.includes('VARCHAR');
}

/** Ordering constraint between two columns derived from a CHECK (e.g. ExpiresAt > CreatedAt). */
interface OrderingConstraint {
  after?: { column: string; orEqual: boolean };
  before?: { column: string; orEqual: boolean };
}

/** Numeric range constraints on a column derived from a CHECK. */
interface NumericConstraint {
  min?: number;
  max?: number;
}

/** CHECK-derived facts the generator can honor so generated rows actually insert. */
interface CheckInfo {
  columnAllowed: Map<string, string[]>;
  columnRange: Map<string, NumericConstraint>;
  jsonAllowed: Map<string, Map<string, string[]>>;
  ordering: Map<string, OrderingConstraint>;
}

function findInMap<T>(map: Map<string, T>, colName: string): T | undefined {
  if (map.has(colName)) return map.get(colName);
  const lower = colName.toLowerCase();
  for (const [k, v] of map.entries()) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
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

/**
 * Parse a table's CHECK constraints for seed-relevant shapes.
 */
function parseChecks(sql: string | null): CheckInfo {
  const info: CheckInfo = {
    columnAllowed: new Map(),
    columnRange: new Map(),
    jsonAllowed: new Map(),
    ordering: new Map(),
  };
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
  const setColumnAllowed = (col: string, vals: string[]) => {
    if (!col || !vals.length) return;
    const existing = findInMap(info.columnAllowed, col);
    if (existing) {
      for (const v of vals) {
        if (!existing.includes(v)) existing.push(v);
      }
    } else {
      info.columnAllowed.set(col, [...vals]);
    }
  };

  for (const expr of extractCheckExprs(sql)) {
    // 1. JSON whitelists: ("col" ->> 'key') IN (...) / json_extract("col", '$.key') IN (...)
    const jw = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*(?:->>|->)\s*'([^']+)'\s*\)*\s*IN\s*\(([^)]*)\)/gi;
    const jw2 = /json_extract\s*\(\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*'(?:\$\??|\.)?\.?([^']+)'\s*\)\s*\)*\s*IN\s*\(([^)]*)\)/gi;
    for (const re of [jw, jw2]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(expr))) {
        const col = m[1] || m[2] || m[3] || m[4];
        const key = m[5];
        const inContent = m[6];
        const strValues = (inContent.match(/'(?:[^']|'')*'/g) ?? []).map((s) => s.slice(1, -1).replace(/''/g, "'"));
        const numValues = !strValues.length ? (inContent.match(/-?\b\d+(?:\.\d+)?\b/g) ?? []) : [];
        const values = strValues.length ? strValues : numValues;
        if (!values.length || !col || !key) continue;
        const byCol = findInMap(info.jsonAllowed, col) ?? new Map<string, string[]>();
        byCol.set(key, values);
        info.jsonAllowed.set(col, byCol);
      }
    }

    // 2. Direct column whitelists: "col" IN ('a', 'b') / col IN ('a', 'b')
    const colIn = /(?:^|[^(->>\w])(?:\(\s*)?(?:(?:lower|upper|trim|coalesce)\s*\(\s*)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))(?:\s*,\s*[^)]+)?\s*\)?\s*\)?\s*IN\s*\(([^)]*)\)/gi;
    let mColIn: RegExpExecArray | null;
    while ((mColIn = colIn.exec(expr))) {
      const col = mColIn[1] || mColIn[2] || mColIn[3] || mColIn[4];
      const inContent = mColIn[5];
      if (!col || ['json_extract', 'strftime', 'datetime', 'date', 'length', 'typeof'].includes(col.toLowerCase())) continue;
      const matchPos = mColIn.index;
      const preceding = expr.slice(Math.max(0, matchPos - 5), matchPos);
      if (preceding.includes('->') || preceding.includes('extract')) continue;

      const strValues = (inContent.match(/'(?:[^']|'')*'/g) ?? []).map((s) => s.slice(1, -1).replace(/''/g, "'"));
      const numValues = !strValues.length ? (inContent.match(/-?\b\d+(?:\.\d+)?\b/g) ?? []) : [];
      const values = strValues.length ? strValues : numValues;
      if (values.length) setColumnAllowed(col, values);
    }

    // 3. Direct column equality OR chains
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
    for (const [col, vals] of eqByCol.entries()) {
      if (vals.length > 0) setColumnAllowed(col, vals);
    }

    // 4. Numeric range constraints
    const numCmp1 = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)/g;
    let mNum1: RegExpExecArray | null;
    while ((mNum1 = numCmp1.exec(expr))) {
      const col = mNum1[1] || mNum1[2] || mNum1[3] || mNum1[4];
      const op = mNum1[5];
      const val = Number(mNum1[6]);
      if (col && Number.isFinite(val) && !['json_extract', 'length', 'strftime', 'datetime'].includes(col.toLowerCase())) {
        const cur = findInMap(info.columnRange, col) ?? {};
        if (op === '>=' || op === '>') {
          const minVal = op === '>' ? val + 1 : val;
          cur.min = cur.min != null ? Math.max(cur.min, minVal) : minVal;
        } else {
          const maxVal = op === '<' ? val - 1 : val;
          cur.max = cur.max != null ? Math.min(cur.max, maxVal) : maxVal;
        }
        info.columnRange.set(col, cur);
      }
    }

    const numCmp2 = /(-?\d+(?:\.\d+)?)\s*(>=|>|<=|<)\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/g;
    let mNum2: RegExpExecArray | null;
    while ((mNum2 = numCmp2.exec(expr))) {
      const val = Number(mNum2[1]);
      const op = mNum2[2];
      const col = mNum2[3] || mNum2[4] || mNum2[5] || mNum2[6];
      if (col && Number.isFinite(val) && !['json_extract', 'length', 'strftime', 'datetime'].includes(col.toLowerCase())) {
        const cur = findInMap(info.columnRange, col) ?? {};
        if (op === '<=' || op === '<') {
          const minVal = op === '<' ? val + 1 : val;
          cur.min = cur.min != null ? Math.max(cur.min, minVal) : minVal;
        } else {
          const maxVal = op === '>' ? val - 1 : val;
          cur.max = cur.max != null ? Math.min(cur.max, maxVal) : maxVal;
        }
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
    /^(hash|digest|secret|passphrase)$/.test(name) ||
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
 * True when a TEXT-ish column must hold valid JSON.
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
 * Columns + keys referenced by JSON operators in an index statement.
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
  const arrow = /"([^"]+)"\s*(?:->>|->)\s*'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)\s*(?:->>|->)\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = arrow.exec(sql))) push(m[1] || m[3], m[2] || m[4]);
  const jx = /json_extract\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*'(?:\$\??|\.)?\.?([^']+)'/g;
  while ((m = jx.exec(sql))) push(m[1] || m[2], m[3]);
  return out;
}

/**
 * Pick a sensible default plan for a column.
 */
export function detectPlan(col: ColumnInfo, fk: ForeignKeyInfo | null): ColumnPlan {
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

  // UNIX timestamps
  if (type.startsWith('INTEGER') && /(timestamp|epoch|unix|createdtime|updatedtime)/.test(name)) {
    return { strategy: 'timestampUnix', format: 'sec' };
  }

  // Coordinates
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

  // TEXT / untyped → name-based heuristics.
  if (/avatar|picture|photo|image|img|thumbnail|icon|logo/.test(name)) return { strategy: 'avatar' };
  if (/company|organization|org|firm|corp|employer|agency/.test(name)) return { strategy: 'company' };
  if (/job|title|role|position|occupation|profession/.test(name)) return { strategy: 'job' };
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
  if (/(bio|about|overview|article|body|post|story)/.test(name)) return { strategy: 'paragraph' };
  if (/(description|content|comment|message|note|summary|details|remarks)/.test(name)) return { strategy: 'sentence', minLen: 1, maxLen: 2 };
  if (/(title|subject|category|type|tag|label)/.test(name)) return { strategy: 'words', minLen: 1, maxLen: 3 };
  return { strategy: 'words', minLen: 1, maxLen: 4 };
}

/** The strategies a column may use, organized by category for the UI. */
export function strategiesFor(col: ColumnInfo, fk: ForeignKeyInfo | null): StrategyDescriptor[] {
  const type = (col.type || '').toUpperCase();
  const out: StrategyDescriptor[] = [];
  const add = (id: GeneratorStrategyId, label: string, category: StrategyCategory, description?: string) => {
    out.push({ id, label, category, description });
  };

  // Custom & Control
  add('skip', 'Skip (DB default or NULL applies)', 'custom_control');
  add('null', 'Set NULL explicitly', 'custom_control');
  add('fixed', 'Fixed constant value', 'custom_control');
  add('list', 'Random item from custom list', 'custom_control');
  add('pattern', 'Custom pattern template (e.g. INV-####)', 'custom_control');

  // Relational
  if (fk) {
    add('fk', `Foreign Key: Sample from ${fk.table}${fk.to ? `.${fk.to}` : ''}`, 'relational');
  }

  // Identity & People
  if (isTextishType(type)) {
    add('fullname', 'Full name (e.g. John Smith)', 'identity');
    add('first', 'First name', 'identity');
    add('last', 'Last name / Surname', 'identity');
    add('username', 'Username handle', 'identity');
    add('job', 'Job title / Profession', 'identity');
  }

  // Contact & Web
  if (isTextishType(type)) {
    add('email', 'Email address', 'contact_web');
    add('phone', 'Phone number', 'contact_web');
    add('url', 'Website URL', 'contact_web');
    add('domain', 'Domain name', 'contact_web');
    add('ip', 'IPv4 address', 'contact_web');
    add('avatar', 'Avatar image URL', 'contact_web');
  }

  // Commerce & Business
  if (isTextishType(type)) {
    add('company', 'Company / Organization name', 'commerce');
    add('currency', 'Currency code (USD, EUR...)', 'commerce');
    add('status', 'Status badge (active, pending...)', 'commerce');
    add('creditCard', 'Masked test credit card', 'commerce');
  }

  // Location
  if (isTextishType(type)) {
    add('address', 'Street address', 'location');
    add('city', 'City name', 'location');
    add('state', 'State / Province', 'location');
    add('country', 'Country name', 'location');
    add('countryCode', 'Country code (ISO-2 e.g. US)', 'location');
    add('postal', 'Postal / Zip code', 'location');
  }
  add('latitude', 'Latitude (-90 to 90)', 'location');
  add('longitude', 'Longitude (-180 to 180)', 'location');

  // Numbers & Math
  if (type.startsWith('INTEGER') || type === 'REAL' || type.includes('DECIMAL') || type.includes('NUMERIC') || isTextishType(type)) {
    add('int', 'Random integer in range', 'numeric');
    add('decimal', 'Random decimal / price', 'numeric');
    add('sequence', 'Sequential numbering (1, 2, 3...)', 'numeric');
  }

  // Date & Time
  add('date', 'Random date (YYYY-MM-DD)', 'datetime');
  add('datetime', 'Random datetime (ISO-8601)', 'datetime');
  add('time', 'Random time (HH:MM:SS)', 'datetime');
  add('timestampUnix', 'Unix timestamp (epoch)', 'datetime');

  // Text & Content
  if (isTextishType(type)) {
    add('words', 'Short words / Tags', 'system_crypto');
    add('sentence', 'Sentences', 'system_crypto');
    add('paragraph', 'Paragraph (multi-sentence text)', 'system_crypto');
    add('slug', 'URL slug (e.g. tech-news-402)', 'system_crypto');
  }

  // System, Crypto & Tech
  add('bool', 'Boolean flag (1/0 or true/false)', 'system_crypto');
  if (type === 'BLOB' || isTextishType(type)) {
    add('bytes', 'Random hex bytes (BLOB)', 'system_crypto');
  }
  if (isTextishType(type)) {
    add('uuid', 'UUID v4', 'system_crypto');
    add('token', 'Short alphanumeric token', 'system_crypto');
    add('hash', 'Hexadecimal hash (MD5/SHA)', 'system_crypto');
    add('json', 'Valid JSON object', 'system_crypto');
    add('color', 'Color (Hex code or name)', 'system_crypto');
    add('mac', 'MAC network address', 'system_crypto');
  }

  return out;
}

/**
 * A safe, value-generating default plan for a column's declared type.
 */
export function fallbackPlanFor(col: ColumnInfo): ColumnPlan {
  const type = (col.type || '').toUpperCase();
  if (type === 'BOOLEAN') return { strategy: 'bool' };
  if (type.startsWith('INTEGER')) return { strategy: 'int', min: 1, max: 1000 };
  if (type === 'REAL' || type.includes('DECIMAL')) return { strategy: 'decimal', min: 1, max: 1000, precision: 2 };
  if (type === 'DATE') return { strategy: 'date', from: '2020-01-01', to: '2026-12-31' };
  if (type === 'DATETIME' || type === 'TIMESTAMP') return { strategy: 'datetime', from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' };
  if (type === 'TIME') return { strategy: 'time' };
  if (type === 'BLOB') return { strategy: 'bytes', minLen: 8, maxLen: 32 };
  return { strategy: 'words', minLen: 1, maxLen: 4 };
}

/**
 * Compute per-column generator configuration for a table.
 */
export function buildColumnConfigs(info: TableInfoData): ColumnGeneratorConfig[] {
  const fkByColumn = new Map<string, ForeignKeyInfo>();
  for (const fk of info.foreignKeys) fkByColumn.set(fk.from, fk);

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

    const colAllowed = findInMap(checkInfo.columnAllowed, col.name);
    if (colAllowed && colAllowed.length > 0 && defaultPlan.strategy !== 'fk' && !col.pk) {
      if (colAllowed.length === 1) {
        defaultPlan = { strategy: 'fixed', value: colAllowed[0] };
      } else {
        defaultPlan = { strategy: 'list', values: [...colAllowed] };
      }
    }

    const colRange = findInMap(checkInfo.columnRange, col.name);
    if (colRange && (defaultPlan.strategy === 'int' || defaultPlan.strategy === 'decimal')) {
      if (colRange.min != null) defaultPlan.min = colRange.min;
      if (colRange.max != null) defaultPlan.max = colRange.max;
    }

    if (!strategies.some((s) => s.id === defaultPlan.strategy)) {
      defaultPlan = fallbackPlanFor(col);
    }

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

const PLAN_KEYS = [
  'value', 'values', 'min', 'max', 'precision', 'from', 'to',
  'minLen', 'maxLen', 'jsonKeys', 'nullPct', 'prefix', 'suffix',
  'start', 'step', 'pattern', 'format'
] as const;

/**
 * Validate/normalize a client-supplied per-column plan.
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
    } else if (key === 'value' || key === 'from' || key === 'to' || key === 'prefix' || key === 'suffix' || key === 'pattern' || key === 'format') {
      out[key] = String(v);
    } else {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
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

/**
 * Generate a single value for a column from its plan.
 */
export function generateOne(
  col: ColumnInfo,
  p: ColumnPlan,
  fkPool?: unknown[],
  rowIndex = 0,
): unknown {
  const type = (col.type || '').toUpperCase();

  // Handle null percentage for nullable columns
  if (!col.pk && !col.notnull && p.nullPct && p.nullPct > 0) {
    if (Math.random() * 100 < p.nullPct) return null;
  }

  let rawVal: unknown;

  switch (p.strategy) {
    case 'skip':
      return SKIP;
    case 'null':
      return null;
    case 'fixed':
      rawVal = p.value ?? '';
      break;
    case 'list': {
      const vals = (p.values ?? []).filter((v) => String(v).trim() !== '');
      if (!vals.length) return SKIP;
      rawVal = pick(vals);
      break;
    }
    case 'pattern':
      rawVal = formatPattern(p.pattern || 'INV-2026-####');
      break;
    case 'first':
      rawVal = pick(FIRST_NAMES);
      break;
    case 'last':
      rawVal = pick(LAST_NAMES);
      break;
    case 'fullname':
      rawVal = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
      break;
    case 'email':
      rawVal = makeEmail();
      break;
    case 'username':
      rawVal = makeUsername();
      break;
    case 'job':
      rawVal = pick(JOB_TITLES);
      break;
    case 'company':
      rawVal = pick(COMPANIES);
      break;
    case 'currency':
      rawVal = pick(CURRENCIES);
      break;
    case 'status':
      rawVal = pick(STATUSES);
      break;
    case 'creditCard':
      rawVal = makeCreditCard();
      break;
    case 'avatar':
      rawVal = makeAvatar();
      break;
    case 'color':
      rawVal = makeColor(p.format);
      break;
    case 'phone':
      rawVal = makePhone();
      break;
    case 'city':
      rawVal = pick(CITIES);
      break;
    case 'state':
      rawVal = pick(US_STATES);
      break;
    case 'country':
      rawVal = pick(COUNTRIES);
      break;
    case 'countryCode':
      rawVal = pick(COUNTRY_CODES);
      break;
    case 'postal':
      rawVal = String(randInt(10000, 99999));
      break;
    case 'address':
      rawVal = makeAddress();
      break;
    case 'url':
      rawVal = `https://www.${pick(DOMAINS)}/${makeSlug()}`;
      break;
    case 'domain':
      rawVal = pick(DOMAINS);
      break;
    case 'ip':
      rawVal = makeIp();
      break;
    case 'mac':
      rawVal = makeMacAddress();
      break;
    case 'uuid':
      rawVal = makeUuid();
      break;
    case 'slug':
      rawVal = makeSlug();
      break;
    case 'words':
      rawVal = makeWords(p.minLen ?? 1, p.maxLen ?? 4);
      break;
    case 'sentence':
      rawVal = makeSentences(p.minLen ?? 1, p.maxLen ?? 2);
      break;
    case 'paragraph':
      rawVal = makeParagraph();
      break;
    case 'latitude': {
      const min = p.min ?? -90;
      const max = p.max ?? 90;
      rawVal = Number(randFloat(min, max).toFixed(6));
      break;
    }
    case 'longitude': {
      const min = p.min ?? -180;
      const max = p.max ?? 180;
      rawVal = Number(randFloat(min, max).toFixed(6));
      break;
    }
    case 'sequence': {
      const start = p.start ?? 1;
      const step = p.step ?? 1;
      rawVal = start + rowIndex * step;
      break;
    }
    case 'int': {
      const min = p.min ?? 1;
      const max = Math.max(min, p.max ?? 1000);
      rawVal = randInt(min, max);
      break;
    }
    case 'decimal': {
      const min = p.min ?? 1;
      const max = Math.max(min, p.max ?? 1000);
      const prec = Math.max(0, Math.min(10, p.precision ?? 2));
      rawVal = randFloat(min, max).toFixed(prec);
      break;
    }
    case 'date':
      rawVal = randomDate(p.from, p.to, 'date');
      break;
    case 'datetime':
      rawVal = randomDate(p.from, p.to, 'datetime');
      break;
    case 'time':
      rawVal = randomTime();
      break;
    case 'timestampUnix':
      rawVal = randomUnixTimestamp(p.format, p.from, p.to);
      break;
    case 'bool':
      rawVal = pick(['1', '0']);
      break;
    case 'bytes': {
      const len = randInt(Math.max(0, p.minLen ?? 8), Math.max(1, p.maxLen ?? 32));
      const buf = Buffer.alloc(len);
      for (let i = 0; i < len; i++) buf[i] = randInt(0, 255);
      return coerceFormValue(`0x${buf.toString('hex')}`, type || 'BLOB');
    }
    case 'json':
      rawVal = makeJsonObject(p.jsonKeys, p.jsonValues);
      break;
    case 'hash': {
      const min = Math.max(8, p.minLen ?? 32);
      const max = Math.max(min, p.maxLen ?? 64);
      const len = randInt(min, max);
      rawVal = randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
      break;
    }
    case 'token':
      rawVal = randomAlnum(Math.max(2, p.minLen ?? 6), Math.max(2, p.maxLen ?? 12));
      break;
    case 'fk': {
      if (!fkPool || !fkPool.length) return null;
      return fkPool[randInt(0, fkPool.length - 1)];
    }
    default:
      return SKIP;
  }

  // Apply string prefix & suffix
  if (rawVal != null && (p.prefix || p.suffix) && typeof rawVal === 'string') {
    rawVal = `${p.prefix || ''}${rawVal}${p.suffix || ''}`;
  }

  return coerceFormValue(String(rawVal), type || 'TEXT');
}

/**
 * Generate a single representative sample value for UI cards.
 */
export function generateSampleValue(col: ColumnInfo, plan: ColumnPlan, fkPool?: unknown[]): unknown {
  const v = generateOne(col, plan, fkPool || ['[FK sample]'], 0);
  if (v === SKIP) return '(omitted / default)';
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `0x${Buffer.from(v).toString('hex').slice(0, 16)}...`;
  return v;
}

function stringifyKey(v: unknown): string {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `buf:${Buffer.from(v).toString('hex')}`;
  return `${typeof v}:${String(v)}`;
}

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

/**
 * Generate `count` rows for a table with structured previews.
 */
export async function generateRows(
  db: SqliteDatabase,
  info: TableInfoData,
  configs: ColumnGeneratorConfig[],
  count: number,
  plan: Record<string, ColumnPlan> = {},
): Promise<GenerateResult> {
  const fkByColumn = new Map<string, ForeignKeyInfo>();
  for (const fk of info.foreignKeys) fkByColumn.set(fk.from, fk);

  const uniqueCols = new Set<string>();
  for (const cfg of configs) if (cfg.unique) uniqueCols.add(cfg.name);

  const checkInfo = parseChecks(info.sql ?? null);

  const warnings: string[] = [];
  const prepared: { col: ColumnInfo; plan: ColumnPlan }[] = [];
  const fkPools = new Map<string, unknown[]>();
  const fkOmit = new Set<string>();

  for (const col of info.columns) {
    const cfg = configs.find((c) => c.name === col.name);
    const raw = plan[col.name];
    const p = raw && raw.strategy ? raw : (cfg?.defaultPlan ?? { strategy: 'skip' });

    if (p.strategy === 'list' && (!p.values || !p.values.length)) {
      const allowed = findInMap(checkInfo.columnAllowed, col.name);
      if (allowed && allowed.length) {
        p.values = [...allowed];
      }
    }

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
  const previewRows: Record<string, unknown>[] = [];
  const uniqueSeen = new Map<string, Set<string>>();

  for (let i = 0; i < count; i++) {
    const fields: WhereClause[] = [];
    const previewRow: Record<string, unknown> = {};

    for (const { col, plan: p } of prepared) {
      if (p.strategy === 'fk' && fkOmit.has(col.name)) {
        previewRow[col.name] = null;
        continue;
      }
      let v = generateOne(col, p, fkPools.get(col.name), i);
      if (v === SKIP) {
        previewRow[col.name] = '(default)';
        continue;
      }

      if (uniqueCols.has(col.name)) {
        const seen = uniqueSeen.get(col.name) ?? new Set<string>();
        let attempts = 0;
        while (seen.has(stringifyKey(v)) && attempts < 20) {
          v = generateOne(col, p, fkPools.get(col.name), i);
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
      previewRow[col.name] = v;
    }
    // Honor CHECK ordering constraints
    applyOrdering(fields, checkInfo.ordering);
    for (const f of fields) {
      previewRow[f.column] = f.value;
    }

    rows.push(fields);
    if (previewRows.length < 50) {
      previewRows.push(previewRow);
    }
  }

  return { rows, previewRows, warnings };
}

/**
 * Render generated rows as a sequence of INSERT statements for preview.
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
