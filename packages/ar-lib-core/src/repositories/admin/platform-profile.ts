import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';
import { AUTHENTICATION_METHOD_PROFILE_LIMIT } from './authentication-method-profile';

/**
 * The platform's authentication method and session profiles (admin migration 015): profiles
 * every tenant may use, defined once for the environment. They are not any tenant's data (a
 * tenant backup neither exports nor replaces them).
 *
 * `locked`: tenants may use the profile but not change it (a change they made before is set
 * aside, not deleted). `state` 'deleting': one delete operation (its token) is checking that no
 * tenant uses it, and no new reference to it is taken meanwhile; 'deleted': it found none. A
 * deleted profile keeps its row: it is not listed nor named anew, but `find` still returns it, so
 * a Flow that came to name it in a race keeps its profile rather than losing it.
 */
export interface PlatformProfile {
  id: string;
  name: string;
  values: Record<string, unknown>;
  version: number;
  locked: boolean;
  state: 'active' | 'deleting' | 'deleted';
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export type PlatformProfileKind = 'method' | 'session';

/** The id prefix of each kind: a platform profile's id never looks like a tenant's. */
export const PLATFORM_PROFILE_ID_PREFIX: Readonly<Record<PlatformProfileKind, string>> = {
  method: 'pmp_',
  session: 'psp_',
};

/** Whether an id is shaped like a platform profile's of the kind (it may still not exist). */
export function isPlatformProfileId(kind: PlatformProfileKind, id: unknown): id is string {
  return (
    typeof id === 'string' && id.startsWith(PLATFORM_PROFILE_ID_PREFIX[kind]) && id.length <= 200
  );
}

export type PlatformProfileCreateResult =
  | { status: 'created'; profile: PlatformProfile }
  | { status: 'name_taken' }
  | { status: 'limit_reached' };

export type PlatformProfileUpdateResult =
  | { status: 'updated'; profile: PlatformProfile }
  | { status: 'not_found' }
  | { status: 'name_taken' }
  | { status: 'conflict'; currentVersion: number };

/**
 * How long a delete may hold a profile before another may take it over (a delete searches every
 * tenant: it is given far longer than it takes).
 */
export const PLATFORM_PROFILE_DELETE_STALE_MS = 15 * 60 * 1000;

const TABLE: Readonly<Record<PlatformProfileKind, string>> = {
  method: 'platform_authentication_method_profiles',
  session: 'platform_session_profiles',
};

const nameKey = (name: string) => name.trim().toLowerCase();
const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint/i.test(error.message);

function fromRow(row: Record<string, unknown>): PlatformProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    values: JSON.parse(String(row.values_json)) as Record<string, unknown>,
    version: Number(row.version),
    locked: Number(row.locked) === 1,
    state: row.state === 'deleting' || row.state === 'deleted' ? row.state : 'active',
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class PlatformProfileRepository {
  private readonly table: string;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly kind: PlatformProfileKind
  ) {
    this.table = TABLE[kind];
  }

  async list(): Promise<PlatformProfile[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE state <> 'deleted'
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
      [AUTHENTICATION_METHOD_PROFILE_LIMIT]
    );
    return rows.map(fromRow);
  }

  /**
   * The profile in any state (a deleted one too: Flows that name it still read it), or null when
   * the id is not one of this kind's (shape or row).
   */
  async find(id: string): Promise<PlatformProfile | null> {
    if (!isPlatformProfileId(this.kind, id)) return null;
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE id = ?`,
      [id]
    );
    return row ? fromRow(row) : null;
  }

  async create(
    input: { name: string; values: Record<string, unknown> },
    createdBy: string | null,
    now: number = getCurrentTimestamp()
  ): Promise<PlatformProfileCreateResult> {
    const id = `${PLATFORM_PROFILE_ID_PREFIX[this.kind]}${generateId()}`;
    try {
      const result = await this.adapter.execute(
        `INSERT INTO ${this.table}
           (id, name, name_key, values_json, version, locked, state, created_by, created_at,
            updated_at)
         SELECT ?, ?, ?, ?, 1, 0, 'active', ?, ?, ?
          WHERE (SELECT COUNT(*) FROM ${this.table} WHERE state <> 'deleted') < ?`,
        [
          id,
          input.name,
          nameKey(input.name),
          JSON.stringify(input.values),
          createdBy,
          now,
          now,
          AUTHENTICATION_METHOD_PROFILE_LIMIT,
        ]
      );
      if (result.rowsAffected === 0) return { status: 'limit_reached' };
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'name_taken' };
      throw error;
    }
    const profile = await this.find(id);
    if (!profile) throw new Error(`${this.table}_row_missing_after_insert`);
    return { status: 'created', profile };
  }

  /** Changes the name and values (`expectedVersion`: the version the change was made from). */
  async update(
    id: string,
    input: { name: string; values: Record<string, unknown> },
    expectedVersion: number,
    now: number = getCurrentTimestamp()
  ): Promise<PlatformProfileUpdateResult> {
    return this.change(
      id,
      expectedVersion,
      `name = ?, name_key = ?, values_json = ?`,
      [input.name, nameKey(input.name), JSON.stringify(input.values)],
      now
    );
  }

  /** Locks or unlocks it (a new version: tenants see the change). */
  async setLocked(
    id: string,
    locked: boolean,
    expectedVersion: number,
    now: number = getCurrentTimestamp()
  ): Promise<PlatformProfileUpdateResult> {
    return this.change(id, expectedVersion, `locked = ?`, [locked ? 1 : 0], now);
  }

  /**
   * Starts deleting it for one operation (`token`): from active, so a second delete while one is
   * under way is refused; or from a delete that has held it longer than `staleAfterMs` (one that
   * died half way leaves no other way out). True when this operation now holds it.
   */
  async claimDeleting(
    id: string,
    token: string,
    now: number = getCurrentTimestamp(),
    staleAfterMs: number = PLATFORM_PROFILE_DELETE_STALE_MS
  ): Promise<boolean> {
    if (!isPlatformProfileId(this.kind, id)) return false;
    const result = await this.adapter.execute(
      `UPDATE ${this.table} SET state = 'deleting', state_token = ?, updated_at = ?
        WHERE id = ? AND (state = 'active' OR (state = 'deleting' AND updated_at < ?))`,
      [token, now, id, now - staleAfterMs]
    );
    return result.rowsAffected > 0;
  }

  /** Gives it back as active (the operation found it in use, or failed): only its own operation. */
  async releaseDeleting(id: string, token: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE ${this.table} SET state = 'active', state_token = NULL
        WHERE id = ? AND state = 'deleting' AND state_token = ?`,
      [id, token]
    );
    return result.rowsAffected > 0;
  }

  /** Marks it deleted (its operation found it unused): only its own operation. */
  async finishDeleting(
    id: string,
    token: string,
    now: number = getCurrentTimestamp()
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE ${this.table} SET state = 'deleted', state_token = NULL, updated_at = ?
        WHERE id = ? AND state = 'deleting' AND state_token = ?`,
      [now, id, token]
    );
    return result.rowsAffected > 0;
  }

  private async change(
    id: string,
    expectedVersion: number,
    set: string,
    params: unknown[],
    now: number
  ): Promise<PlatformProfileUpdateResult> {
    if (!isPlatformProfileId(this.kind, id)) return { status: 'not_found' };
    try {
      const result = await this.adapter.execute(
        `UPDATE ${this.table} SET ${set}, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
        [...params, now, id, expectedVersion]
      );
      if (result.rowsAffected === 0) {
        const current = await this.find(id);
        return current
          ? { status: 'conflict', currentVersion: current.version }
          : { status: 'not_found' };
      }
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'name_taken' };
      throw error;
    }
    const profile = await this.find(id);
    return profile ? { status: 'updated', profile } : { status: 'not_found' };
  }
}
