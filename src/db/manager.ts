import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from './database';
import { PostgresDatabase } from './postgres';
import type { IDatabase } from './types';

import { createLogger, type Logger } from '../utils/logger';
import { errorMessage, isPostgresConnectionString, sanitizeConnectionString } from '../utils/common';

const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];

export interface DbManagerOptions {
  /** Directory of database files. Scanned for known extensions; new DBs are created here. */
  dir?: string;
  /** Explicit database file paths or connection strings. */
  files?: string[];
  /** Named database connections map (e.g. { "mydb": "postgresql://...", "name1": "postgresql://..." }). */
  connections?: Record<string, string>;
  /** Open every managed database read-only (no writes, no create/delete of files). */
  readonly?: boolean;
}

export interface DatabaseEntry {
  /** Stable, URL-safe id (usually the file name or connection name, deduped on collision). */
  id: string;
  /** Name for display. */
  name: string;
  /** Path on disk or sanitized connection URI. */
  path: string;
  /** Database dialect (sqlite or postgres). */
  dialect: 'sqlite' | 'postgres';
  size: number;
  modified: string;
  /** Whether this specific database is opened in read-only mode. */
  readonly: boolean;
}

/**
 * Manages multiple SQLite database files and PostgreSQL database connections.
 *
 * Databases come from three sources:
 * - a `connections` map — named PostgreSQL or SQLite connection strings (e.g. from JSON config),
 * - a `dir` — every SQLite file with a known extension is scanned in,
 * - an explicit `files[]` array — specific file locations or connection strings.
 */
export class DbManager {
  private logger: Logger;
  private dir?: string;
  private createDir: string;
  private readonly readonlyMode: boolean;
  private files: string[] = []; // targets (paths or URIs), registry order
  private idByPath = new Map<string, string>(); // target -> id
  private pathById = new Map<string, string>(); // id -> target
  private nameById = new Map<string, string>(); // id -> display name
  private readonlyById = new Map<string, boolean>(); // id -> readonly override
  private openDbs = new Map<string, IDatabase>(); // id -> db


  constructor(options: DbManagerOptions | string, logger?: Logger) {
    const opts = typeof options === 'string' ? { dir: options } : (options ?? {});
    this.logger = logger ?? createLogger('info', 'admindb');
    this.dir = opts.dir ? path.resolve(opts.dir) : undefined;
    this.createDir = this.dir ?? process.cwd();
    this.readonlyMode = !!opts.readonly;
    if (this.dir) mkdirSync(this.dir, { recursive: true });

    if (opts.connections) {
      this.registerConnections(opts.connections);
    }
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

  private registerConnections(conns: Record<string, string>): void {
    for (const [name, target] of Object.entries(conns ?? {})) {
      if (!name || !target) continue;
      const cleanTarget = String(target).trim();
      if (!cleanTarget) continue;
      this.addNamedTarget(name.trim(), cleanTarget);
    }
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
      const raw = String(f ?? '').trim();
      if (!raw) continue;
      if (isPostgresConnectionString(raw)) {
        let name = 'postgres';
        try {
          const u = new URL(raw);
          name = u.pathname.replace(/^\//, '') || 'postgres';
        } catch {
          name = 'postgres';
        }
        this.addNamedTarget(name, raw);
        continue;
      }
      const abs = path.resolve(raw);
      if (!existsSync(abs)) {
        this.logger.warn(`Skipping missing database file: ${f}`);
        continue;
      }
      this.addFile(abs);
    }
  }

  private addNamedTarget(name: string, target: string): void {
    let id = name;
    let n = 2;
    while (this.pathById.has(id)) {
      id = `${name}__${n}`;
      n += 1;
    }
    this.files.push(target);
    this.idByPath.set(target, id);
    this.pathById.set(id, target);
    this.nameById.set(id, name);
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
    this.nameById.set(id, base);
  }

  /** List all managed databases (metadata only — does not open them). */
  list(): DatabaseEntry[] {
    const entries: DatabaseEntry[] = [];
    const seen = new Set<string>();

    for (const [id, target] of this.pathById.entries()) {
      if (seen.has(id)) continue;
      seen.add(id);

      if (isPostgresConnectionString(target)) {
        entries.push({
          id,
          name: this.nameById.get(id) ?? id,
          path: sanitizeConnectionString(target),
          dialect: 'postgres',
          size: 0,
          modified: 'Connected',
          readonly: this.isDbReadOnly(id),
        });
      } else {
        let size = 0;
        let modified = '';
        try {
          const st = statSync(target);
          size = st.size;
          modified = st.mtime.toISOString();
        } catch {
          /* ignore */
        }
        entries.push({
          id,
          name: this.nameById.get(id) ?? path.basename(target),
          path: target,
          dialect: 'sqlite',
          size,
          modified,
          readonly: this.isDbReadOnly(id),
        });
      }
    }
    return entries;
  }

  has(id: string): boolean {
    return this.pathById.has(id);
  }

  /** True if global manager is in readonly mode or this database is explicitly marked read-only. */
  isDbReadOnly(id: string): boolean {
    return this.readonlyMode || (this.readonlyById.get(id) ?? false);
  }

  /** Set or toggle read-only mode for a specific database id. */
  setReadonly(id: string, readonly: boolean): void {
    if (this.readonlyMode && !readonly) {
      throw new Error('Manager is in global read-only mode — databases cannot be made writable.');
    }
    const current = this.readonlyById.get(id);
    if (current === readonly) return;
    this.readonlyById.set(id, readonly);
    // Close existing connection instance so it is re-opened with new readonly mode on next use
    const db = this.openDbs.get(id);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      this.openDbs.delete(id);
    }
  }

  /** Open (and cache) a database by id; creates the file if it is new SQLite database. */
  open(id: string, readonlyOverride?: boolean): IDatabase {
    const target = this.pathById.get(id);
    if (!target) throw new Error(`Database "${id}" is not registered.`);
    const isRo = this.readonlyMode || (readonlyOverride !== undefined ? readonlyOverride : (this.readonlyById.get(id) ?? false));
    let db = this.openDbs.get(id);
    if (db && db.isReadOnly !== isRo) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      this.openDbs.delete(id);
      db = undefined;
    }
    if (!db) {
      if (isPostgresConnectionString(target)) {
        db = new PostgresDatabase(target, this.logger.child(`db:${id}`), { readonly: isRo });
      } else {
        db = new SqliteDatabase(target, this.logger.child(`db:${id}`), { readonly: isRo });
      }
      this.openDbs.set(id, db);
    }
    return db;
  }

  /**
   * Register and open an existing database file by path, returning its id.
   * Used by the "Open an existing database" file browser. Validates that the
   * file is a readable SQLite database before keeping it registered.
   */
  openFile(absPath: string, readonly?: boolean): string {
    const abs = path.resolve(String(absPath ?? '').trim());
    if (!abs) throw new Error('Database path is required.');
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`Not a file: ${abs}`);
    }
    const existing = this.idByPath.get(abs);
    if (existing) {
      if (readonly !== undefined) this.setReadonly(existing, readonly);
      return existing;
    }
    this.addFile(abs);
    const id = this.idByPath.get(abs);
    if (!id) throw new Error('Failed to register database file.');
    if (readonly !== undefined) this.readonlyById.set(id, readonly);
    try {
      this.open(id); // throws if the file is not a readable SQLite database
    } catch (err) {
      // Roll the registration back so a bad file doesn't linger in the list.
      this.pathById.delete(id);
      this.idByPath.delete(abs);
      this.nameById.delete(id);
      this.readonlyById.delete(id);
      this.files = this.files.filter((p) => p !== abs);
      throw err;
    }
    return id;
  }

  get(id: string): IDatabase | undefined {
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

  /** Create a new (empty) SQLite database. Returns its id. */
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

  /** Dynamically register a named PostgreSQL or SQLite connection string. Returns its id. */
  addConnection(name: string, connectionString: string, readonly?: boolean): string {
    if (this.readonlyMode) throw new Error('Read-only mode — adding connections is disabled.');
    const raw = String(connectionString ?? '').trim();
    if (!raw) throw new Error('Connection string is required.');
    let cleanName = String(name ?? '').trim();
    if (!cleanName) {
      try {
        const u = new URL(raw);
        cleanName = u.pathname.replace(/^\//, '') || 'postgres';
      } catch {
        cleanName = 'postgres';
      }
    }
    this.addNamedTarget(cleanName, raw);
    const id = this.idByPath.get(raw);
    if (!id) throw new Error('Failed to register connection.');
    if (readonly !== undefined) this.readonlyById.set(id, readonly);
    return id;
  }

  /** Close and delete a database file (including WAL/SHM sidecars). */
  remove(id: string): void {
    if (this.readonlyMode) throw new Error('Read-only mode — deleting databases is disabled.');
    const target = this.pathById.get(id);
    if (!target) return;
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
    this.idByPath.delete(target);
    this.nameById.delete(id);
    this.readonlyById.delete(id);
    this.files = this.files.filter((p) => p !== target);

    if (!isPostgresConnectionString(target)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(target + suffix);
        } catch {
          /* ignore */
        }
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
