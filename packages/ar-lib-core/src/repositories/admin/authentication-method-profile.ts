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
 */
export class NamedProfileRepository {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly table: 'authentication_method_profiles' | 'session_profiles'
  ) {}

  async list(tenantId: string): Promise<AuthenticationMethodProfile[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE tenant_id = ?
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
      [tenantId, AUTHENTICATION_METHOD_PROFILE_LIMIT]
    );
    return rows.map(fromRow);
  }

  async find(tenantId: string, id: string): Promise<AuthenticationMethodProfile | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE tenant_id = ? AND id = ?`,
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
          WHERE (SELECT COUNT(*) FROM ${this.table} WHERE tenant_id = ?) < ?`,
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
          WHERE tenant_id = ? AND id = ? AND version = ?`,
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
      `DELETE FROM ${this.table} WHERE tenant_id = ? AND id = ?`,
      [tenantId, id]
    );
    return result.rowsAffected > 0;
  }
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
