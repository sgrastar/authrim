import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

export const AUTHENTICATION_METHOD_PROFILE_LIMIT = 50;

export interface AuthenticationMethodProfile {
  id: string;
  name: string;
  values: Record<string, unknown>;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AuthenticationMethodProfileInput {
  name: string;
  values: Record<string, unknown>;
}

export type AuthenticationMethodProfileCreateResult =
  | { status: 'created'; profile: AuthenticationMethodProfile }
  | { status: 'name_taken' }
  | { status: 'limit_reached' };

export type AuthenticationMethodProfileUpdateResult =
  | { status: 'updated'; profile: AuthenticationMethodProfile }
  | { status: 'not_found' }
  | { status: 'name_taken' }
  | { status: 'conflict'; currentVersion: number };

const nameKey = (name: string) => name.trim().toLowerCase();
const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint/i.test(error.message);

function fromRow(row: Record<string, unknown>): AuthenticationMethodProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    values: JSON.parse(String(row.values_json)) as Record<string, unknown>,
    version: Number(row.version),
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/**
 * Named profiles of a tenant kept as one JSON document each (authentication method profiles,
 * session profiles): the same columns and limits, in a table of their own.
 *
 * The same table holds the tenant's changes to the platform's profiles (a row with
 * `base_profile_id`, admin migration 015). Those are never profiles of the tenant: `list`,
 * `find`, `update`, `delete` and the limit only ever see the tenant's own rows (no base), and an
 * override is reached through its platform profile's id alone (`findOverride` …), so its own id
 * cannot be named to get round the platform's switches or lock.
 */
export class NamedProfileRepository {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly table: 'authentication_method_profiles' | 'session_profiles'
  ) {}

  async list(tenantId: string): Promise<AuthenticationMethodProfile[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE tenant_id = ? AND base_profile_id IS NULL
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
      [tenantId, AUTHENTICATION_METHOD_PROFILE_LIMIT]
    );
    return rows.map(fromRow);
  }

  async find(tenantId: string, id: string): Promise<AuthenticationMethodProfile | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE tenant_id = ? AND id = ? AND base_profile_id IS NULL`,
      [tenantId, id]
    );
    return row ? fromRow(row) : null;
  }

  async create(
    tenantId: string,
    input: AuthenticationMethodProfileInput,
    createdBy: string | null,
    now: number = getCurrentTimestamp()
  ): Promise<AuthenticationMethodProfileCreateResult> {
    const id = generateId();
    try {
      const result = await this.adapter.execute(
        `INSERT INTO ${this.table}
           (id, tenant_id, name, name_key, values_json, version, created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM ${this.table}
                  WHERE tenant_id = ? AND base_profile_id IS NULL) < ?`,
        [
          id,
          tenantId,
          input.name,
          nameKey(input.name),
          JSON.stringify(input.values),
          createdBy,
          now,
          now,
          tenantId,
          AUTHENTICATION_METHOD_PROFILE_LIMIT,
        ]
      );
      if (result.rowsAffected === 0) return { status: 'limit_reached' };
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'name_taken' };
      throw error;
    }
    const profile = await this.find(tenantId, id);
    if (!profile) throw new Error(`${this.table}_row_missing_after_insert`);
    return { status: 'created', profile };
  }

  async update(
    tenantId: string,
    id: string,
    input: AuthenticationMethodProfileInput,
    expectedVersion: number,
    now: number = getCurrentTimestamp()
  ): Promise<AuthenticationMethodProfileUpdateResult> {
    try {
      const result = await this.adapter.execute(
        `UPDATE ${this.table}
            SET name = ?, name_key = ?, values_json = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND version = ? AND base_profile_id IS NULL`,
        [
          input.name,
          nameKey(input.name),
          JSON.stringify(input.values),
          now,
          tenantId,
          id,
          expectedVersion,
        ]
      );
      if (result.rowsAffected === 0) {
        const current = await this.find(tenantId, id);
        return current
          ? { status: 'conflict', currentVersion: current.version }
          : { status: 'not_found' };
      }
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'name_taken' };
      throw error;
    }
    const profile = await this.find(tenantId, id);
    if (!profile) return { status: 'not_found' };
    return {
      status: 'updated',
      profile: {
        ...profile,
        name: input.name,
        values: input.values,
        version: expectedVersion + 1,
        updated_at: now,
      },
    };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM ${this.table} WHERE tenant_id = ? AND id = ? AND base_profile_id IS NULL`,
      [tenantId, id]
    );
    return result.rowsAffected > 0;
  }

  /** The tenant's change to a platform profile (a full copy made then), or null. */
  async findOverride(tenantId: string, baseId: string): Promise<ProfileOverride | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE tenant_id = ? AND base_profile_id = ?`,
      [tenantId, baseId]
    );
    return row ? overrideFromRow(row) : null;
  }

  /** The platform profiles a tenant has changed, by platform id. */
  async listOverrides(tenantId: string): Promise<ProfileOverride[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE tenant_id = ? AND base_profile_id IS NOT NULL
       ORDER BY updated_at DESC, id ASC`,
      [tenantId]
    );
    return rows.map(overrideFromRow);
  }

  /**
   * Makes or changes the tenant's copy of a platform profile. `expectedVersion` is the copy's
   * version (null: there is none yet); a copy made or changed meanwhile is a conflict. The name is
   * the platform profile's (overrides are not named apart, and do not count toward the limit).
   */
  async saveOverride(
    tenantId: string,
    base: { id: string; name: string; version: number },
    values: Record<string, unknown>,
    expectedVersion: number | null,
    actor: string | null,
    now: number = getCurrentTimestamp()
  ): Promise<OverrideSaveResult> {
    if (expectedVersion === null) {
      try {
        await this.adapter.execute(
          `INSERT INTO ${this.table}
             (id, tenant_id, name, name_key, values_json, version, created_by, created_at,
              updated_at, base_profile_id, base_version)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          [
            generateId(),
            tenantId,
            base.name,
            nameKey(base.name),
            JSON.stringify(values),
            actor,
            now,
            now,
            base.id,
            base.version,
          ]
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          const current = await this.findOverride(tenantId, base.id);
          return { status: 'conflict', currentVersion: current?.version ?? null };
        }
        throw error;
      }
    } else {
      const result = await this.adapter.execute(
        `UPDATE ${this.table}
            SET values_json = ?, name = ?, name_key = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND base_profile_id = ? AND version = ?`,
        [
          JSON.stringify(values),
          base.name,
          nameKey(base.name),
          now,
          tenantId,
          base.id,
          expectedVersion,
        ]
      );
      if (result.rowsAffected === 0) {
        const current = await this.findOverride(tenantId, base.id);
        return { status: 'conflict', currentVersion: current?.version ?? null };
      }
    }
    const saved = await this.findOverride(tenantId, base.id);
    if (!saved) throw new Error(`${this.table}_override_missing_after_save`);
    return { status: 'saved', override: saved };
  }

  /** Removes the tenant's copy (the platform profile applies again). False when there was none. */
  async deleteOverride(tenantId: string, baseId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM ${this.table} WHERE tenant_id = ? AND base_profile_id = ?`,
      [tenantId, baseId]
    );
    return result.rowsAffected > 0;
  }

  /** How many tenants have changed a platform profile (for what turning a switch off affects). */
  async countOverridingTenants(baseId: string): Promise<number> {
    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT tenant_id) AS count FROM ${this.table} WHERE base_profile_id = ?`,
      [baseId]
    );
    return Number(row?.count ?? 0);
  }
}

/** A tenant's change to a platform profile: a full copy of its values, made from `baseVersion`. */
export interface ProfileOverride {
  id: string;
  baseProfileId: string;
  baseVersion: number;
  values: Record<string, unknown>;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export type OverrideSaveResult =
  | { status: 'saved'; override: ProfileOverride }
  | { status: 'conflict'; currentVersion: number | null };

function overrideFromRow(row: Record<string, unknown>): ProfileOverride {
  return {
    id: String(row.id),
    baseProfileId: String(row.base_profile_id),
    baseVersion: Number(row.base_version ?? 0),
    values: JSON.parse(String(row.values_json)) as Record<string, unknown>,
    version: Number(row.version),
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class AuthenticationMethodProfileRepository extends NamedProfileRepository {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, 'authentication_method_profiles');
  }
}

/** Session profiles: how long a session lasts and whether single sign-on is on, by name. */
export class SessionProfileRepository extends NamedProfileRepository {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, 'session_profiles');
  }
}
