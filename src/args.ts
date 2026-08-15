/**
 * Command-line argument parsing for the standalone `admindb` server.
 *
 * The CLI supports flags to pick the port/host, open a single database file,
 * manage a folder of databases, and more. Every flag has a matching
 * environment variable; flags always win over the environment.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './logger';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface CliArgs {
  help: boolean;
  version: boolean;
  /** Bind host/interface. */
  host?: string;
  /** Port to listen on. */
  port?: number;
  /** A single database file to open directly (`--open`/`--db`/`--file`). */
  dbPath?: string;
  /** Directory of database files to manage (`--dir`). */
  dbDir?: string;
  /** Explicit database file paths (`--files a.db,b.db`). */
  dbFiles?: string[];
  /** URL prefix to serve under (`--base-path`). */
  basePath?: string;
  logLevel?: LogLevel;
  /** Open databases read-only (`--readonly`). */
  readonly: boolean;
}

export function helpText(): string {
  return [
    'AdminDB — browser-based SQLite administration tool.',
    '',
    'Usage:',
    '  admindb [options] [path]',
    '',
    'Starts a local server and opens a web UI where you can browse, select and',
    'manage SQLite databases (.db / .sqlite / .sqlite3).',
    '',
    'With no path or options it runs in "manager" mode: the landing page lets',
    'you browse the filesystem and open any database file, or create new ones.',
    '',
    'Arguments:',
    '  path                 Path to a database file (opens it directly) or to a',
    '                       folder of databases (lists them). Default: the',
    '                       current directory.',
    '',
    'Options:',
    '  -p, --port <port>     Port to listen on (default: 3000)',
    '  -H, --host <host>     Host/interface to bind (default: 0.0.0.0)',
    '  -o, --open <file>     Open a single database file',
    '  -d, --dir <dir>       Folder of database files to manage',
    '      --files <list>    Comma-separated database file paths',
    '  -b, --base-path <p>   URL prefix to serve under (default: /)',
    '  -r, --readonly        Open databases read-only (all writes disabled)',
    '  -l, --log-level <l>   debug | info | warn | error (default: info)',
    '  -h, --help            Show this help',
    '  -v, --version         Show the version',
    '',
    'Environment variables (used when the matching flag is not given):',
    '  PORT, HOST, DB_PATH, DB_DIR, DB_FILES, BASE_PATH, READONLY, LOG_LEVEL',
    '',
    'Examples:',
    '  admindb                          # manager UI on http://localhost:3000',
    '  admindb -p 8080                  # same, on port 8080',
    '  admindb ./data/app.db            # open a single database file',
    '  admindb --open ~/notes.sqlite    # open a file (direct)',
    '  admindb -d ./dbs                 # manage a folder of databases',
    '  admindb --files a.db,b.db -r     # open two files read-only',
  ].join('\n');
}

function packageVersion(): string {
  try {
    const raw = readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

/** The installed `admindb` package version (from package.json), or '' when unknown. */
export function getPackageVersion(): string {
  return packageVersion();
}

export function versionText(): string {
  const v = packageVersion();
  return v ? `admindb v${v}` : 'admindb';
}

/** True when a token is exactly a flag or `flag=value` (for long flags). */
function isFlag(tok: string, ...names: string[]): boolean {
  return names.includes(tok) || names.some((n) => n.length > 2 && tok.startsWith(n + '='));
}

export function parseArgs(argv: string[]): { args: CliArgs; error?: string } {
  const args: CliArgs = { help: false, version: false, readonly: false };
  const positional: string[] = [];
  let i = 0;

  const invalid = (error: string): { args: CliArgs; error?: string } => ({ args, error });

  // Read the value for the current flag token; supports `--flag=value` and
  // `--flag value`. Leaves `i` pointing at the value token so the loop can
  // advance past it.
  const takeValue = (flag: string): string | undefined => {
    const eq = argv[i].indexOf('=');
    if (eq !== -1) return argv[i].slice(eq + 1);
    i += 1;
    return argv[i];
  };

  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      args.help = true;
    } else if (tok === '-v' || tok === '--version') {
      args.version = true;
    } else if (isFlag(tok, '-p', '--port')) {
      const v = takeValue('--port');
      if (v === undefined) return invalid('Missing value for --port.');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return invalid(`Invalid port: "${v}".`);
      args.port = n;
    } else if (isFlag(tok, '-H', '--host')) {
      const v = takeValue('--host');
      if (v === undefined) return invalid('Missing value for --host.');
      args.host = v;
    } else if (isFlag(tok, '-o', '--open', '--db', '-f', '--file')) {
      const v = takeValue('--open');
      if (v === undefined) return invalid('Missing value for --open.');
      args.dbPath = v;
    } else if (isFlag(tok, '-d', '--dir', '--folder')) {
      const v = takeValue('--dir');
      if (v === undefined) return invalid('Missing value for --dir.');
      args.dbDir = v;
    } else if (isFlag(tok, '--files')) {
      const v = takeValue('--files');
      if (v === undefined) return invalid('Missing value for --files.');
      args.dbFiles = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (isFlag(tok, '-b', '--base-path', '--base')) {
      const v = takeValue('--base-path');
      if (v === undefined) return invalid('Missing value for --base-path.');
      args.basePath = v;
    } else if (isFlag(tok, '-l', '--log-level')) {
      const v = takeValue('--log-level');
      if (v === undefined) return invalid('Missing value for --log-level.');
      if (!LOG_LEVELS.includes(v as LogLevel)) {
        return invalid(`Invalid log level: "${v}". Expected one of: ${LOG_LEVELS.join(', ')}.`);
      }
      args.logLevel = v as LogLevel;
    } else if (tok === '-r' || tok === '--readonly') {
      args.readonly = true;
    } else if (tok.startsWith('-') && tok.length > 1) {
      return invalid(`Unknown option: "${tok}".`);
    } else {
      positional.push(tok);
    }
    i += 1;
  }

  if (positional.length > 1) {
    return invalid(`Unexpected extra arguments: ${positional.slice(1).join(' ')}.`);
  }
  const p = positional[0];
  if (p) {
    const abs = path.resolve(p);
    try {
      if (statSync(abs).isDirectory()) args.dbDir = p;
      else args.dbPath = p;
    } catch {
      args.dbPath = p;
    }
  }

  return { args };
}
