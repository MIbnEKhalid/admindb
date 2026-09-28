import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DbManager } from '../../db/manager';
import type { DatabaseRow, FsEntry } from '../../types/api';
import { errorMessage, isPathWithinRoot, formatBytes, isPostgresConnectionString } from '../../utils/common';
export type { DatabaseRow, FsEntry };

const BLOCKED_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'System Volume Information',
  '$RECYCLE.BIN',
  '.env',
  '.aws',
  '.ssh',
]);

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export class DatabasesService {
  static async getDatabaseRows(manager: DbManager): Promise<DatabaseRow[]> {
    const entries = manager.list();
    return Promise.all(
      entries.map(async (e) => ({
        ...e,
        isPostgres: e.dialect === 'postgres',
        isSqlite: e.dialect === 'sqlite',
        sizeLabel: e.dialect === 'postgres' ? 'Remote' : formatBytes(e.size),
        modifiedLabel: e.dialect === 'postgres' ? 'Connected' : (e.modified ? formatDate(e.modified) : '—'),
        tables: await manager.countTables(e.id),
      })),
    );
  }

  static listDirectory(base: string, manager: DbManager, browseRoot?: string): { path: string; name: string; parent: string | null; entries: FsEntry[] } {
    if (base.includes('\0')) throw new Error('Invalid path.');
    if (browseRoot && !isPathWithinRoot(browseRoot, base)) {
      throw new Error(`Path is outside the allowed folder: ${browseRoot}`);
    }
    if (!existsSync(base)) throw new Error(`Path does not exist: ${base}`);
    if (!statSync(base).isDirectory()) throw new Error(`Not a directory: ${base}`);

    const entries: FsEntry[] = [];
    for (const name of readdirSync(base)) {
      if (name.startsWith('.') || BLOCKED_NAMES.has(name) || name.toLowerCase().startsWith('.env')) continue;
      const full = path.join(base, name);
      let isDir = false;
      let size = 0;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = isDir ? 0 : st.size;
      } catch {
        continue;
      }
      if (!isDir && !manager.isDbFile(name)) continue;
      if (browseRoot && !isPathWithinRoot(browseRoot, full)) continue;
      entries.push({ name, path: full, isDir, isDb: !isDir, size });
    }
    entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1,
    );

    const parent = path.dirname(base) === base ? null : path.dirname(base);
    const effectiveParent = parent && (!browseRoot || isPathWithinRoot(browseRoot, parent)) ? parent : null;

    return {
      path: base,
      name: path.basename(base) || base,
      parent: effectiveParent,
      entries,
    };
  }

  static openDatabaseFile(manager: DbManager, filePath: string, isRo?: boolean, browseRoot?: string): string {
    const p = String(filePath ?? '').trim();
    if (!p || p.includes('\0')) throw new Error('Valid database path is required.');
    const abs = path.resolve(p);
    if (browseRoot && !isPathWithinRoot(browseRoot, abs)) {
      throw new Error(`Cannot open a database outside the allowed folder: ${browseRoot}`);
    }
    return manager.openFile(p, isRo);
  }

  static async connectPostgres(manager: DbManager, name: string, connectionString: string, isRo?: boolean): Promise<string> {
    const conn = String(connectionString ?? '').trim();
    if (!conn) {
      throw new Error('PostgreSQL connection string is required (e.g. postgresql://user:password@localhost:5432/dbname).');
    }
    if (!isPostgresConnectionString(conn)) {
      throw new Error('Invalid connection protocol. Connection string must start with postgres:// or postgresql://');
    }
    let id: string | undefined;
    try {
      id = manager.addConnection(name, conn, isRo);
      const db = manager.open(id);
      await db.listTables();
      return id;
    } catch (err) {
      if (id) manager.remove(id);
      throw new Error(`Failed to connect to PostgreSQL: ${errorMessage(err)}`);
    }
  }

  static createDatabase(manager: DbManager, name: string): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('Database name is required.');
    return manager.create(trimmed);
  }

  static setDatabaseMode(manager: DbManager, id: string, readonly: boolean, invalidate?: (id: string) => void): void {
    if (!manager.has(id)) throw new Error(`Database "${id}" does not exist.`);
    manager.setReadonly(id, readonly);
    if (invalidate) invalidate(id);
  }

  static removeDatabase(manager: DbManager, id: string, invalidate?: (id: string) => void): void {
    if (!manager.has(id)) throw new Error(`Database "${id}" does not exist.`);
    if (invalidate) invalidate(id);
    manager.remove(id);
  }
}
