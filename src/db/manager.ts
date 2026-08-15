import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from './database';
import { createLogger, type Logger } from '../logger';
import { errorMessage } from '../util';

const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];

export interface DbManagerOptions {
  /** Directory of database files. Scanned for known extensions; new DBs are created here. */
  dir?: string;
  /** Explicit database file paths (absolute or relative). Any extension accepted. */
  files?: string[];
  /** Open every managed database read-only (no writes, no create/delete of files). */
  readonly?: boolean;
}

export interface DatabaseEntry {
  /** Stable, URL-safe id (usually the file name, deduped on collision). */
  id: string;
  /** File name for display. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  size: number;
  modified: string;
}

/**
 * Manages multiple SQLite database files.
 *
 * Databases come from up to two sources:
 * - a `dir` — every file with a known extension is scanned in,
 * - an explicit `files[]` array — specific file locations anywhere on disk.
 *
 * New databases created through `create()` land in `dir` (or the working
 * directory when no dir is configured). Each database gets a stable id (the
 * file name, or a deduped `name__2.ext` when names collide across sources).
 */
export class DbManager {
  private logger: Logger;
  private dir?: string;
  private createDir: string;
  private readonly readonlyMode: boolean;
  private files: string[] = []; // absolute paths, registry order
  private idByPath = new Map<string, string>(); // absPath -> id
  private pathById = new Map<string, string>(); // id -> absPath
  private openDbs = new Map<string, SqliteDatabase>(); // id -> db

  constructor(options: DbManagerOptions | string, logger?: Logger) {
    const opts = typeof options === 'string' ? { dir: options } : (options ?? {});
    this.logger = logger ?? createLogger('info', 'admindb');
    this.dir = opts.dir ? path.resolve(opts.dir) : undefined;
    this.createDir = this.dir ?? process.cwd();
    this.readonlyMode = !!opts.readonly;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
    this.registerDirFiles();
    this.registerExplicitFiles(opts.files ?? []);
  }

  get directory(): string {
    return this.dir ?? this.createDir;
  }

  /** True when this manager opens every database read-only. */
  get isReadOnly(): boolean {
    return this.readonlyMode;
  }

  isDbFile(name: string): boolean {
    const lower = String(name ?? '').toLowerCase();
    return DB_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  private registerDirFiles(): void {
    if (!this.dir) return;
    let names: string[] = [];
    try {
      names = readdirSync(this.dir)
        .filter((n) => this.isDbFile(n))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch (err) {
      this.logger.warn(`Failed to list database directory ${this.dir}: ${errorMessage(err)}`);
    }
    for (const name of names) this.addFile(path.join(this.dir, name));
  }

  private registerExplicitFiles(files: string[]): void {
    for (const f of files ?? []) {
      const abs = path.resolve(String(f ?? ''));
      if (!existsSync(abs)) {
        this.logger.warn(`Skipping missing database file: ${f}`);
        continue;
      }
      this.addFile(abs);
    }
  }

  private addFile(abs: string): void {
    if (this.idByPath.has(abs)) return;
    const base = path.basename(abs);
    let id = base;
    let n = 2;
    while (this.pathById.has(id)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      id = `${stem}__${n}${ext}`;
      n += 1;
    }
    this.files.push(abs);
    this.idByPath.set(abs, id);
    this.pathById.set(id, abs);
  }

  /** List all managed databases (metadata only — does not open them). */
  list(): DatabaseEntry[] {
    return this.files.map((p) => {
      let size = 0;
      let modified = '';
      try {
        const st = statSync(p);
        size = st.size;
        modified = st.mtime.toISOString();
      } catch {
        /* ignore */
      }
      return { id: this.idByPath.get(p) ?? path.basename(p), name: path.basename(p), path: p, size, modified };
    });
  }

  has(id: string): boolean {
    return this.pathById.has(id);
  }

  /** Open (and cache) a database by id; creates the file if it is new. */
  open(id: string): SqliteDatabase {
    const abs = this.pathById.get(id);
    if (!abs) throw new Error(`Database "${id}" is not registered.`);
    let db = this.openDbs.get(id);
    if (!db) {
      db = new SqliteDatabase(abs, this.logger.child(`db:${id}`), { readonly: this.readonlyMode });
      this.openDbs.set(id, db);
    }
    return db;
  }

  /**
   * Register and open an existing database file by path, returning its id.
   * Used by the "Open an existing database" file browser. Validates that the
   * file is a readable SQLite database before keeping it registered.
   */
  openFile(absPath: string): string {
    const abs = path.resolve(String(absPath ?? '').trim());
    if (!abs) throw new Error('Database path is required.');
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`Not a file: ${abs}`);
    }
    const existing = this.idByPath.get(abs);
    if (existing) return existing;
    this.addFile(abs);
    const id = this.idByPath.get(abs);
    if (!id) throw new Error('Failed to register database file.');
    try {
      this.open(id); // throws if the file is not a readable SQLite database
    } catch (err) {
      // Roll the registration back so a bad file doesn't linger in the list.
      this.pathById.delete(id);
      this.idByPath.delete(abs);
      this.files = this.files.filter((p) => p !== abs);
      throw err;
    }
    return id;
  }

  get(id: string): SqliteDatabase | undefined {
    return this.openDbs.get(id);
  }

  /** Count the tables in a database (opens it if necessary). */
  async countTables(id: string): Promise<number> {
    try {
      const db = this.open(id);
      const r = await db.listTables();
      return r.success ? (r.data?.length ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  /** Create a new (empty) database. Returns its id. */
  create(name: string): string {
    if (this.readonlyMode) throw new Error('Read-only mode — creating databases is disabled.');
    const fileName = sanitizeFileName(name);
    if (!fileName) throw new Error('Database name is required.');
    const abs = path.join(this.createDir, fileName);
    this.addFile(abs);
    const id = this.idByPath.get(abs);
    if (!id) throw new Error('Failed to register new database.');
    this.open(id); // better-sqlite3 creates the file on first open
    return id;
  }

  /** Close and delete a database file (including WAL/SHM sidecars). */
  remove(id: string): void {
    if (this.readonlyMode) throw new Error('Read-only mode — deleting databases is disabled.');
    const abs = this.pathById.get(id);
    if (!abs) return;
    const db = this.openDbs.get(id);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      this.openDbs.delete(id);
    }
    this.pathById.delete(id);
    this.idByPath.delete(abs);
    this.files = this.files.filter((p) => p !== abs);
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(abs + suffix);
      } catch {
        /* ignore */
      }
    }
  }

  closeAll(): void {
    for (const db of this.openDbs.values()) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    this.openDbs.clear();
  }
}

/** Turn a friendly name into a safe database file name (always ends in `.db`). */
function sanitizeFileName(name: string): string {
  let n = String(name ?? '').trim().replace(/[\\/]/g, '');
  if (!n) return '';
  if (!DB_EXTENSIONS.some((ext) => n.toLowerCase().endsWith(ext))) n += '.db';
  return n;
}
