import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from './database';
import { PostgresDatabase } from './postgres';
import type { IDatabase } from './types';
import { createLogger, type Logger } from '../utils/logger';
import { errorMessage, isPostgresConnectionString, sanitizeConnectionString } from '../utils/common';
import { isServerlessEnvironment } from '../serverless';
import { getDialect } from './dialects/index';
import type { DatabaseContext } from '../core/context';

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
  /** Whether running in a serverless runtime (e.g. Vercel). */
  serverless?: boolean;
  /** Maximum number of concurrently open database connections in the cache. Defaults to 25. */
  maxOpenDbs?: number;
  /** Idle timeout in milliseconds after which unused connections can be pruned. Defaults to 0 (disabled). */
  idleTimeoutMs?: number;
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
 */
export class DbManager {
  private logger: Logger;
  private dir?: string;
  private createDir: string;
  private readonly readonlyMode: boolean;
  private readonly isServerless: boolean;
  private readonly maxOpenDbs: number;
  private readonly idleTimeoutMs: number;
  private files: string[] = [];
  private idByPath = new Map<string, string>();
  private pathById = new Map<string, string>();
  private nameById = new Map<string, string>();
  private readonlyById = new Map<string, boolean>();
  private openDbs = new Map<string, IDatabase>();
  private accessOrder: string[] = [];
  private lastAccessed = new Map<string, number>();

  constructor(options: DbManagerOptions | string, logger?: Logger) {
    const opts = typeof options === 'string' ? { dir: options } : (options ?? {});
    this.logger = logger ?? createLogger('info', 'admindb');
    this.dir = opts.dir ? path.resolve(opts.dir) : undefined;
    this.createDir = this.dir ?? process.cwd();
    this.readonlyMode = Boolean(opts.readonly);
    this.isServerless = opts.serverless !== undefined ? opts.serverless : isServerlessEnvironment();
    this.maxOpenDbs = Math.max(1, opts.maxOpenDbs ?? 25);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs ?? 0);
    if (this.dir) mkdirSync(this.dir, { recursive: true });

    if (opts.connections) this.registerConnections(opts.connections);
    this.registerDirFiles();
    this.registerExplicitFiles(opts.files ?? []);
  }

  get directory(): string {
    return this.dir ?? this.createDir;
  }

  get isReadOnly(): boolean {
    return this.readonlyMode;
  }

  isDbFile(name: string): boolean {
    const lower = String(name ?? '').toLowerCase();
    return DB_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  private registerConnections(conns: Record<string, string>): void {
    for (const [name, target] of Object.entries(conns ?? {})) {
      const cleanTarget = String(target ?? '').trim();
      if (name && cleanTarget) this.addNamedTarget(name.trim(), cleanTarget);
    }
  }

  private registerDirFiles(): void {
    if (!this.dir) return;
    try {
      const names = readdirSync(this.dir)
        .filter((n) => this.isDbFile(n))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      for (const name of names) this.addFile(path.join(this.dir, name));
    } catch (err) {
      this.logger.warn(`Failed to list database directory ${this.dir}: ${errorMessage(err)}`);
    }
  }

  private registerExplicitFiles(files: string[]): void {
    for (const f of files ?? []) {
      const raw = String(f ?? '').trim();
      if (!raw) continue;
      if (isPostgresConnectionString(raw)) {
        let name = 'postgres';
        try {
          name = new URL(raw).pathname.replace(/^\//, '') || 'postgres';
        } catch {}
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
    while (this.pathById.has(id)) id = `${name}__${n++}`;
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
      id = `${path.basename(base, ext)}__${n++}${ext}`;
    }
    this.files.push(abs);
    this.idByPath.set(abs, id);
    this.pathById.set(id, abs);
    this.nameById.set(id, base);
  }

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
        } catch {}
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

  isDbReadOnly(id: string): boolean {
    if (this.readonlyMode) return true;
    if (this.readonlyById.has(id)) return Boolean(this.readonlyById.get(id));
    if (this.isServerless) {
      const target = this.pathById.get(id);
      const isPg = target ? isPostgresConnectionString(target) : false;
      return !isPg;
    }
    return false;
  }

  private touch(id: string): void {
    const idx = this.accessOrder.indexOf(id);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(id);
    this.lastAccessed.set(id, Date.now());
  }

  private evictLru(): boolean {
    while (this.accessOrder.length > 0) {
      const oldestId = this.accessOrder.shift()!;
      const db = this.openDbs.get(oldestId);
      if (db) {
        this.logger.debug?.(`Evicting idle database connection "${oldestId}" from pool.`);
        try {
          db.close();
        } catch (err) {
          this.logger.warn(`Error closing evicted database "${oldestId}": ${errorMessage(err)}`);
        }
        this.openDbs.delete(oldestId);
        this.lastAccessed.delete(oldestId);
        return true;
      }
    }
    return false;
  }

  /**
   * Prune database connections that have been idle longer than maxIdleAgeMs (or the configured idleTimeoutMs).
   * Returns the count of pruned connections.
   */
  pruneIdle(maxIdleAgeMs?: number): number {
    const maxAge = maxIdleAgeMs ?? this.idleTimeoutMs;
    if (maxAge <= 0) return 0;
    const now = Date.now();
    let pruned = 0;
    for (const [id, lastTime] of Array.from(this.lastAccessed.entries())) {
      if (now - lastTime > maxAge) {
        this.closeDb(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Close and evict a specific open database connection from the pool.
   */
  closeDb(id: string): void {
    const db = this.openDbs.get(id);
    if (db) {
      try {
        db.close();
      } catch (err) {
        this.logger.warn(`Error closing database "${id}": ${errorMessage(err)}`);
      }
      this.openDbs.delete(id);
    }
    const idx = this.accessOrder.indexOf(id);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.lastAccessed.delete(id);
  }

  /**
   * Returns diagnostic stats regarding the current database connection pool.
   */
  getPoolStats(): { openConnections: number; maxOpenDbs: number; lruOrder: string[] } {
    return {
      openConnections: this.openDbs.size,
      maxOpenDbs: this.maxOpenDbs,
      lruOrder: [...this.accessOrder],
    };
  }

  setReadonly(id: string, readonly: boolean): void {
    if (this.readonlyMode && !readonly) {
      throw new Error('Manager is in global read-only mode — databases cannot be made writable.');
    }
    if (this.isServerless && !readonly) {
      const target = this.pathById.get(id);
      const isPg = target ? isPostgresConnectionString(target) : false;
      if (!isPg) {
        throw new Error('SQLite database cannot be made writable in a serverless environment.');
      }
    }
    if (this.readonlyById.get(id) === readonly) return;
    this.readonlyById.set(id, readonly);
    this.closeDb(id);
  }

  open(id: string, readonlyOverride?: boolean): IDatabase {
    const target = this.pathById.get(id);
    if (!target) throw new Error(`Database "${id}" is not registered.`);
    const isRo = readonlyOverride !== undefined ? readonlyOverride : this.isDbReadOnly(id);

    let db = this.openDbs.get(id);
    if (db && db.isReadOnly !== isRo) {
      this.closeDb(id);
      db = undefined;
    }
    if (!db) {
      if (this.idleTimeoutMs > 0) {
        this.pruneIdle();
      }
      while (this.openDbs.size >= this.maxOpenDbs) {
        if (!this.evictLru()) break;
      }

      const childLogger = this.logger.child(`db:${id}`);
      db = isPostgresConnectionString(target)
        ? new PostgresDatabase(target, childLogger, { readonly: isRo })
        : new SqliteDatabase(target, childLogger, { readonly: isRo });
      this.openDbs.set(id, db);
    }
    this.touch(id);
    return db;
  }

  /**
   * Resolve a full DatabaseContext for the given database ID.
   * Bundles the IDatabase instance with the correct IDialect, capabilities,
   * identity metadata, and a scoped logger.
   */
  getContext(id: string, readonlyOverride?: boolean): DatabaseContext {
    const db = this.open(id, readonlyOverride);
    const target = this.pathById.get(id)!;
    const isPg = isPostgresConnectionString(target);
    const schema = isPg ? (db as any).schema || 'public' : undefined;
    const dialect = getDialect(isPg ? 'postgres' : 'sqlite', schema);
    return {
      id,
      name: this.nameById.get(id) ?? id,
      path: db.path,
      db,
      dialect,
      capabilities: dialect.capabilities,
      isReadOnly: db.isReadOnly,
      logger: this.logger.child(`db:${id}`),
    };
  }

  openFile(absPath: string, readonly?: boolean): string {
    const abs = path.resolve(String(absPath ?? '').trim());
    if (!abs) throw new Error('Database path is required.');
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Not a file: ${abs}`);

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
      this.open(id);
    } catch (err) {
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

  async countTables(id: string): Promise<number> {
    try {
      const r = await this.open(id).listTables();
      return r.success ? (r.data?.length ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  create(name: string): string {
    if (this.readonlyMode) throw new Error('Read-only mode — creating databases is disabled.');
    const fileName = sanitizeFileName(name);
    if (!fileName) throw new Error('Database name is required.');
    const abs = path.join(this.createDir, fileName);
    this.addFile(abs);
    const id = this.idByPath.get(abs);
    if (!id) throw new Error('Failed to register new database.');
    this.open(id);
    return id;
  }

  addConnection(name: string, connectionString: string, readonly?: boolean): string {
    if (this.readonlyMode) throw new Error('Read-only mode — adding connections is disabled.');
    const raw = String(connectionString ?? '').trim();
    if (!raw) throw new Error('Connection string is required.');

    let cleanName = String(name ?? '').trim();
    if (!cleanName) {
      try {
        cleanName = new URL(raw).pathname.replace(/^\//, '') || 'postgres';
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

  remove(id: string): void {
    if (this.readonlyMode) throw new Error('Read-only mode — deleting databases is disabled.');
    const target = this.pathById.get(id);
    if (!target) return;

    this.closeDb(id);
    this.pathById.delete(id);
    this.idByPath.delete(target);
    this.nameById.delete(id);
    this.readonlyById.delete(id);
    this.files = this.files.filter((p) => p !== target);

    if (!isPostgresConnectionString(target)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(target + suffix); } catch {}
      }
    }
  }

  closeAll(): void {
    for (const db of this.openDbs.values()) {
      try { db.close(); } catch {}
    }
    this.openDbs.clear();
    this.accessOrder = [];
    this.lastAccessed.clear();
  }
}

function sanitizeFileName(name: string): string {
  let n = String(name ?? '').trim().replace(/[\\/]/g, '');
  if (!n) return '';
  if (!DB_EXTENSIONS.some((ext) => n.toLowerCase().endsWith(ext))) n += '.db';
  return n;
}
