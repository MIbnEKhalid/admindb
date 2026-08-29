import type { IDatabase } from '../db/index';
import type { GenerationPlan, SeedProfile } from './types';

const PROFILES_TABLE = '_admindb_seed_profiles';
const inMemoryProfiles = new Map<string, SeedProfile>();

/**
 * Ensures the internal seed profiles table exists.
 */
async function ensureProfilesTable(db: IDatabase): Promise<boolean> {
  try {
    const isPostgres = db.dialect === 'postgres';
    const sql = isPostgres
      ? `CREATE TABLE IF NOT EXISTS ${PROFILES_TABLE} (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          plan JSONB NOT NULL
        );`
      : `CREATE TABLE IF NOT EXISTS ${PROFILES_TABLE} (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          plan TEXT NOT NULL
        );`;
    await db.run(sql);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all saved Seed Profiles.
 */
export async function listSeedProfiles(db: IDatabase): Promise<SeedProfile[]> {
  try {
    const ok = await ensureProfilesTable(db);
    if (!ok) return Array.from(inMemoryProfiles.values());

    const res = await db.all(`SELECT id, name, description, created_at, updated_at, plan FROM ${PROFILES_TABLE} ORDER BY updated_at DESC`);
    if (!res.success || !res.data) return Array.from(inMemoryProfiles.values());

    const profiles: SeedProfile[] = [];
    for (const row of res.data as Record<string, unknown>[]) {
      try {
        const planObj = typeof row.plan === 'string' ? JSON.parse(row.plan) : (row.plan as GenerationPlan);
        profiles.push({
          id: String(row.id),
          name: String(row.name),
          description: row.description ? String(row.description) : undefined,
          createdAt: String(row.created_at || new Date().toISOString()),
          updatedAt: String(row.updated_at || new Date().toISOString()),
          plan: planObj,
        });
      } catch {}
    }
    return profiles;
  } catch {
    return Array.from(inMemoryProfiles.values());
  }
}

/**
 * Save or update a Seed Profile.
 */
export async function saveSeedProfile(
  db: IDatabase,
  name: string,
  plan: GenerationPlan,
  description?: string,
  id?: string,
): Promise<SeedProfile> {
  const profileId = id || `profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const profile: SeedProfile = {
    id: profileId,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    plan,
  };

  inMemoryProfiles.set(profileId, profile);

  try {
    const ok = await ensureProfilesTable(db);
    if (ok) {
      const planStr = JSON.stringify(plan);
      if (db.dialect === 'postgres') {
        await db.run(
          `INSERT INTO ${PROFILES_TABLE} (id, name, description, updated_at, plan)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             updated_at = CURRENT_TIMESTAMP,
             plan = EXCLUDED.plan`,
          [profileId, name, description || null, planStr],
        );
      } else {
        await db.run(
          `INSERT INTO ${PROFILES_TABLE} (id, name, description, updated_at, plan)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             updated_at = excluded.updated_at,
             plan = excluded.plan`,
          [profileId, name, description || null, now, planStr],
        );
      }
    }
  } catch {}

  return profile;
}

/**
 * Delete a Seed Profile by ID.
 */
export async function deleteSeedProfile(db: IDatabase, id: string): Promise<boolean> {
  inMemoryProfiles.delete(id);
  try {
    const ok = await ensureProfilesTable(db);
    if (ok) await db.run(`DELETE FROM ${PROFILES_TABLE} WHERE id = ?`, [id]);
    return true;
  } catch {
    return true;
  }
}
