/**
 * Command-line argument parsing for the standalone `admindb` server.
 *
 * The CLI supports flags to pick the port/host, open a single database file,
 * manage a folder of databases, or pass a JSON config file with multiple connections.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../utils/logger';
import { parseConfigFile } from './config';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface CliArgs {
  help: boolean;
  version: boolean;
  /** Bind host/interface (`--host`, `-H`). */
  host?: string;
  /** Port to listen on (`--port`, `-p`). */
  port?: number;
  /** A single database file to open directly (`--open`/`--db`/`--file`/`--db-path`). */
  dbPath?: string;
  /** PostgreSQL or database connection string (`--connection`/`--conn`/`--pg`). */
  connection?: string;
  /** Database connections map (from JSON config file). */
  connections?: Record<string, string>;
  /** Path to a JSON configuration file (`--config`, `-C`). */
  configPath?: string;
  /** Directory of database files to manage (`--dir`/`--folder`/`--db-dir`, `-d`). */
  dbDir?: string;
  /** Explicit database file paths (`--files`/`--db-files`). */
  dbFiles?: string[];
  /** URL prefix to serve under (`--base-path`/`--base`, `-b`). */
  basePath?: string;
  /** Log level filter (`--log-level`, `-l`). */
  logLevel?: LogLevel;
  /** Open databases read-only (`--readonly`, `-r`). */
  readonly: boolean;
  /** Serverless mode (enforces read-only database operations) (`--serverless`). */
  serverless?: boolean;
  /** Whether authentication is enabled (defaults to true). Set to false via `--no-auth`. */
  auth?: boolean;
  /** Custom admin username (`--username`/`--user`/`--auth-username`, `-u`). */
  authUsername?: string;
  /** Custom admin password (`--password`/`--pass`/`--auth-password`, `-P`). */
  authPassword?: string;
  /** Secret key for session cookie signing (`--auth-secret`/`--secret`). */
  authSecret?: string;
}

export function helpText(): string {
  return [
    'AdminDB — browser-based SQLite & PostgreSQL administration tool.',
    '',
    'Usage:',
    '  admindb [options] [path|connection_url|config.json]',
    '',
    'Starts a local server and opens a web UI where you can browse, select and',
    'manage SQLite databases (.db / .sqlite / .sqlite3) and PostgreSQL databases.',
    '',
    'With no path or options it runs in "manager" mode: the landing page lets',
    'you browse the filesystem and open any database file, or create new ones.',
    '',
    'Arguments:',
    '  path                           Path to a database file, PostgreSQL connection URL, or',
    '                                 JSON configuration file containing database credentials.',
    '',
    'Options & Environment Variables:',
    '  -C, --config <file.json>       Load database credentials & settings from a JSON file',
    '  -p, --port <port>              Port to listen on (default: 45531) [PORT / ADMINDB_PORT]',
    '  -H, --host <host>              Host/interface to bind (default: 0.0.0.0) [HOST / ADMINDB_HOST]',
    '  -c, --connection, --pg <uri>   Open a PostgreSQL database directly [DATABASE_URL / ADMINDB_CONNECTION]',
    '  -o, --open, --db-path <file>   Open a single database file directly [DB_PATH / ADMINDB_DB_PATH]',
    '  -d, --dir, --db-dir <dir>      Folder of database files to manage [DB_DIR / ADMINDB_DB_DIR]',
    '      --files, --db-files <list> Comma-separated database file paths [DB_FILES / ADMINDB_DB_FILES]',
    '  -b, --base-path, --base <p>    URL prefix to serve under (default: /) [BASE_PATH / ADMINDB_BASE_PATH]',
    '  -r, --readonly, --read-only    Open databases read-only (writes disabled) [READONLY / ADMINDB_READONLY]',
    '      --serverless               Enable serverless mode (enforces read-only, disables writes) [SERVERLESS / ADMINDB_SERVERLESS]',
    '      --auth                     Enable authentication (default: on) [ADMINDB_AUTH=true]',
    '      --no-auth, --disable-auth  Disable authentication completely [ADMINDB_NO_AUTH=1 / ADMINDB_AUTH=false]',
    '  -u, --username, --user <user>  Admin username (default: admin) [ADMINDB_USERNAME / ADMINDB_USER]',
    '  -P, --password, --pass <pass>  Admin password or hash [ADMINDB_PASSWORD / ADMINDB_PASS]',
    '      --auth-secret <sec>        Secret key used to sign session cookies [ADMINDB_SECRET / SESSION_SECRET]',
    '  -l, --log-level <level>        debug | info | warn | error (default: info) [LOG_LEVEL / ADMINDB_LOG_LEVEL]',
    '  -h, --help                     Show this help message',
    '  -v, --version                  Show version',
    '',
    'Examples:',
    '  admindb name.postgres.json                   # load database connections from a JSON file',
    '  admindb postgresql://user:pass@host:5432/db  # open a PostgreSQL database directly',
    '  admindb ./data/app.db                        # open a SQLite database file',
    '  admindb --no-auth                            # run with authentication turned off',
    '  admindb -C ./connections.json                # run with JSON connections config',
    '',
    'See docs/EXAMPLES.md for full configuration reference and deployment recipes.',
  ].join('\n');
}

function packageVersion(): string {
  try {
    const candidates = [
      path.join(__dirname, '..', '..', 'package.json'),
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, 'package.json'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
    return '';
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
    } else if (isFlag(tok, '-C', '--config', '--json')) {
      const v = takeValue('--config');
      if (v === undefined) return invalid('Missing value for --config.');
      args.configPath = v;
      try {
        const fileConf = parseConfigFile(v);
        if (fileConf) {
          if (fileConf.connections) args.connections = fileConf.connections;
          if (fileConf.connection) args.connection = fileConf.connection;
          if (fileConf.port !== undefined) args.port = fileConf.port;
          if (fileConf.host !== undefined) args.host = fileConf.host;
          if (fileConf.basePath !== undefined) args.basePath = fileConf.basePath;
          if (fileConf.readonly !== undefined) args.readonly = fileConf.readonly;
          if (fileConf.serverless !== undefined) args.serverless = fileConf.serverless;
          if (fileConf.logLevel !== undefined) args.logLevel = fileConf.logLevel;
          if (typeof fileConf.auth === 'boolean') args.auth = fileConf.auth;
          else if (fileConf.auth && typeof fileConf.auth === 'object') {
            args.auth = true;
            if (fileConf.auth.username) args.authUsername = fileConf.auth.username;
            if (fileConf.auth.password) args.authPassword = fileConf.auth.password;
            if (fileConf.auth.secret) args.authSecret = fileConf.auth.secret;
          }
        }
      } catch (err) {
        return invalid((err as Error).message);
      }
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
    } else if (isFlag(tok, '-c', '--connection', '--conn', '--pg')) {
      const v = takeValue('--connection');
      if (v === undefined) return invalid('Missing value for --connection.');
      args.connection = v;
      args.dbPath = v;
    } else if (isFlag(tok, '-o', '--open', '--db', '-f', '--file', '--db-path', '--path')) {
      const v = takeValue('--open');
      if (v === undefined) return invalid('Missing value for --open / --db-path.');
      args.dbPath = v;
      if (v.startsWith('postgres://') || v.startsWith('postgresql://')) {
        args.connection = v;
      }
    } else if (isFlag(tok, '-d', '--dir', '--folder', '--db-dir')) {
      const v = takeValue('--dir');
      if (v === undefined) return invalid('Missing value for --dir / --db-dir.');
      args.dbDir = v;
    } else if (isFlag(tok, '--files', '--db-files')) {
      const v = takeValue('--files');
      if (v === undefined) return invalid('Missing value for --files / --db-files.');
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
    } else if (tok === '-r' || tok === '--readonly' || tok === '--read-only') {
      args.readonly = true;
    } else if (tok === '--serverless') {
      args.serverless = true;
      args.readonly = true;
    } else if (tok === '--no-auth' || tok === '--disable-auth') {
      args.auth = false;
    } else if (tok === '--auth') {
      args.auth = true;
    } else if (isFlag(tok, '-u', '--username', '--user', '--auth-username')) {
      const v = takeValue('--username');
      if (v === undefined) return invalid('Missing value for --username.');
      args.authUsername = v;
    } else if (isFlag(tok, '-P', '--password', '--pass', '--auth-password')) {
      const v = takeValue('--password');
      if (v === undefined) return invalid('Missing value for --password.');
      args.authPassword = v;
    } else if (isFlag(tok, '--auth-secret', '--secret', '--session-secret')) {
      const v = takeValue('--auth-secret');
      if (v === undefined) return invalid('Missing value for --auth-secret.');
      args.authSecret = v;
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
    if (p.startsWith('postgres://') || p.startsWith('postgresql://')) {
      args.connection = p;
      args.dbPath = p;
    } else if (p.endsWith('.json') || existsSync(p)) {
      try {
        const isJson = p.endsWith('.json');
        if (isJson || (statSync(p).isFile() && p.includes('.json'))) {
          args.configPath = p;
          const fileConf = parseConfigFile(p);
          if (fileConf) {
            if (fileConf.connections) args.connections = fileConf.connections;
            if (fileConf.connection) args.connection = fileConf.connection;
            if (fileConf.port !== undefined && args.port === undefined) args.port = fileConf.port;
            if (fileConf.host !== undefined && args.host === undefined) args.host = fileConf.host;
            if (fileConf.basePath !== undefined && args.basePath === undefined) args.basePath = fileConf.basePath;
            if (fileConf.readonly !== undefined) args.readonly = fileConf.readonly;
            if (fileConf.serverless !== undefined) args.serverless = fileConf.serverless;
            if (fileConf.logLevel !== undefined && args.logLevel === undefined) args.logLevel = fileConf.logLevel;
            if (args.auth === undefined) {
              if (typeof fileConf.auth === 'boolean') args.auth = fileConf.auth;
              else if (fileConf.auth && typeof fileConf.auth === 'object') {
                args.auth = true;
                if (fileConf.auth.username && !args.authUsername) args.authUsername = fileConf.auth.username;
                if (fileConf.auth.password && !args.authPassword) args.authPassword = fileConf.auth.password;
                if (fileConf.auth.secret && !args.authSecret) args.authSecret = fileConf.auth.secret;
              }
            }
          }
        } else if (statSync(p).isDirectory()) {
          args.dbDir = p;
        } else {
          args.dbPath = p;
        }
      } catch (err) {
        if (p.endsWith('.json')) {
          return invalid((err as Error).message);
        }
        args.dbPath = p;
      }
    } else {
      args.dbPath = p;
    }
  }

  return { args };
}
