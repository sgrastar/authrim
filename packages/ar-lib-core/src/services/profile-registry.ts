import type { DatabaseAdapter } from '../db';
import type { InfrastructureSettings } from '../types/settings/infrastructure';
import type { TenantSettings } from '../types/settings/tenant';
import {
  BUILTIN_RUNTIME_PROFILES,
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  type AuditProfile,
  type ResidencyProfile,
  type RuntimeProfile,
  type RuntimeProfileKind,
} from '../types/runtime-profile';

export interface ProfileRegistryBackend {
  get<T extends RuntimeProfile>(kind: T['kind'], id: string): Promise<T | null>;
  list<T extends RuntimeProfile>(kind: T['kind']): Promise<T[]>;
  put(profile: RuntimeProfile): Promise<void>;
  delete(kind: RuntimeProfileKind, id: string): Promise<boolean>;
}

/**
 * A stored profile with the exact payload text it was read as. Conditional writes compare this
 * text, so a change made after the read (even one that leaves the profile equal in value) is not
 * overwritten by a decision made on the older read.
 */
export interface StoredRuntimeProfile<T extends RuntimeProfile = RuntimeProfile> {
  /** Null for a deleted profile (its tombstone row). */
  profile: T | null;
  /** The payload as stored; pass it back as `expected` to a conditional write. */
  payload: string;
}

/**
 * The payload a deleted profile's row keeps. The row stays so a stale copy of the profile (a KV
 * projection not yet expired at another location) is never adopted back into D1; reads treat it
 * as absent, and creating the profile again replaces it conditionally.
 */
export const PROFILE_REGISTRY_TOMBSTONE = '{"__authrim_profile_deleted":true}';

/**
 * A backend that can write only if the stored profile is still the one a decision was made on.
 * `expectedPayload` is null for "no such profile" (a create). Returns false when the stored
 * profile is no longer that one, and writes nothing.
 */
export interface ProfileWriteGuard {
  kind: RuntimeProfileKind;
  id: string;
  /** The payload that must still be stored (null: the profile must still not exist). */
  expectedPayload: string | null;
}

export interface ConditionalProfileRegistryBackend extends ProfileRegistryBackend {
  getStored(kind: RuntimeProfileKind, id: string): Promise<StoredRuntimeProfile | null>;
  /** Every stored row, tombstones included (for reconciling the KV projection). */
  listStored(): Promise<Array<{ kind: RuntimeProfileKind; id: string; payload: string }>>;
  /**
   * `guards`: other profiles the decision was made on; the write happens only if each is still
   * stored as it was read, in the same statement.
   */
  putIfUnchanged(
    profile: RuntimeProfile,
    expectedPayload: string | null,
    guards?: ProfileWriteGuard[]
  ): Promise<boolean>;
  /** Insert a payload exactly as given unless the profile exists (adopting a KV-only profile). */
  insertRawIfAbsent(kind: RuntimeProfileKind, id: string, payload: string): Promise<boolean>;
  deleteIfUnchanged(
    kind: RuntimeProfileKind,
    id: string,
    expectedPayload: string
  ): Promise<boolean>;
}

export interface EnvironmentProfileDefaults {
  auditProfileId: string;
  residencyProfileId: string;
}

export interface TenantProfileOverrides {
  auditProfileId?: string | null;
  residencyProfileId?: string | null;
}

export interface EffectiveProfileRefs extends EnvironmentProfileDefaults {
  inherited: {
    audit: boolean;
    residency: boolean;
  };
}

export interface ResolvedRuntimeProfiles {
  refs: EffectiveProfileRefs;
  auditProfile: AuditProfile;
  residencyProfile: ResidencyProfile;
}

const DEFAULT_PREFIX = 'profile-registry';

function normalizeProfileId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function makeRegistryKey(prefix: string, kind: RuntimeProfileKind, id: string): string {
  return `${prefix}:${kind}:${id}`;
}

function parseProfilePayload<T extends RuntimeProfile>(raw: string): T {
  return JSON.parse(raw) as T;
}

export class KVProfileRegistryBackend implements ProfileRegistryBackend {
  constructor(
    private readonly kv: KVNamespace,
    private readonly prefix: string = DEFAULT_PREFIX
  ) {}

  async get<T extends RuntimeProfile>(kind: T['kind'], id: string): Promise<T | null> {
    const raw = await this.kv.get(makeRegistryKey(this.prefix, kind, id));
    return raw ? parseProfilePayload<T>(raw) : null;
  }

  async list<T extends RuntimeProfile>(kind: T['kind']): Promise<T[]> {
    const prefix = makeRegistryKey(this.prefix, kind, '');
    const listed = await this.kv.list({ prefix });
    const profiles = await Promise.all(
      listed.keys.map(async ({ name }) => {
        const raw = await this.kv.get(name);
        return raw ? parseProfilePayload<T>(raw) : null;
      })
    );
    const resolved: T[] = [];
    for (const profile of profiles) {
      if (profile) {
        resolved.push(profile);
      }
    }
    return resolved;
  }

  async put(profile: RuntimeProfile): Promise<void> {
    await this.kv.put(
      makeRegistryKey(this.prefix, profile.kind, profile.id),
      JSON.stringify(profile)
    );
  }

  async delete(kind: RuntimeProfileKind, id: string): Promise<boolean> {
    await this.kv.delete(makeRegistryKey(this.prefix, kind, id));
    return true;
  }
}

export class DatabaseProfileRegistryBackend implements ConditionalProfileRegistryBackend {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly tableName: string = 'profile_registry'
  ) {}

  async get<T extends RuntimeProfile>(kind: T['kind'], id: string): Promise<T | null> {
    const row = await this.adapter.queryOne<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.tableName} WHERE kind = ? AND id = ?`,
      [kind, id]
    );
    return row && row.payload_json !== PROFILE_REGISTRY_TOMBSTONE
      ? parseProfilePayload<T>(row.payload_json)
      : null;
  }

  async list<T extends RuntimeProfile>(kind: T['kind']): Promise<T[]> {
    const rows = await this.adapter.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.tableName}
        WHERE kind = ? AND payload_json <> ? ORDER BY id ASC`,
      [kind, PROFILE_REGISTRY_TOMBSTONE]
    );
    return rows.map((row) => parseProfilePayload<T>(row.payload_json));
  }

  async put(profile: RuntimeProfile): Promise<void> {
    const payload = JSON.stringify(profile);
    const now = new Date().toISOString();
    // One statement: an update, then an insert, then an update again could overwrite a profile
    // created in between.
    await this.adapter.execute(
      `INSERT INTO ${this.tableName} (id, kind, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [profile.id, profile.kind, payload, now, now]
    );
  }

  async delete(kind: RuntimeProfileKind, id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM ${this.tableName} WHERE kind = ? AND id = ?`,
      [kind, id]
    );
    return result.rowsAffected > 0;
  }

  async getStored(kind: RuntimeProfileKind, id: string): Promise<StoredRuntimeProfile | null> {
    const row = await this.adapter.queryOne<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.tableName} WHERE kind = ? AND id = ?`,
      [kind, id]
    );
    if (!row) return null;
    return {
      profile:
        row.payload_json === PROFILE_REGISTRY_TOMBSTONE
          ? null
          : parseProfilePayload<RuntimeProfile>(row.payload_json),
      payload: row.payload_json,
    };
  }

  async listStored(): Promise<Array<{ kind: RuntimeProfileKind; id: string; payload: string }>> {
    const rows = await this.adapter.query<{
      kind: RuntimeProfileKind;
      id: string;
      payload_json: string;
    }>(`SELECT kind, id, payload_json FROM ${this.tableName} ORDER BY kind, id`);
    return rows.map((row) => ({ kind: row.kind, id: row.id, payload: row.payload_json }));
  }

  async putIfUnchanged(
    profile: RuntimeProfile,
    expectedPayload: string | null,
    guards: ProfileWriteGuard[] = []
  ): Promise<boolean> {
    const payload = JSON.stringify(profile);
    const now = new Date().toISOString();
    const guardSql = guards
      .map((guard) =>
        guard.expectedPayload === null
          ? `AND NOT EXISTS (SELECT 1 FROM ${this.tableName} WHERE kind = ? AND id = ?)`
          : `AND EXISTS (SELECT 1 FROM ${this.tableName} WHERE kind = ? AND id = ? AND payload_json = ?)`
      )
      .join(' ');
    const guardParams = guards.flatMap((guard) =>
      guard.expectedPayload === null
        ? [guard.kind, guard.id]
        : [guard.kind, guard.id, guard.expectedPayload]
    );
    const result =
      expectedPayload === null
        ? await this.adapter.execute(
            `INSERT INTO ${this.tableName} (id, kind, payload_json, created_at, updated_at)
             SELECT ?, ?, ?, ?, ? WHERE 1 = 1 ${guardSql} ON CONFLICT (kind, id) DO NOTHING`,
            [profile.id, profile.kind, payload, now, now, ...guardParams]
          )
        : await this.adapter.execute(
            `UPDATE ${this.tableName} SET payload_json = ?, updated_at = ?
             WHERE kind = ? AND id = ? AND payload_json = ? ${guardSql}`,
            [payload, now, profile.kind, profile.id, expectedPayload, ...guardParams]
          );
    return result.rowsAffected === 1;
  }

  async insertRawIfAbsent(kind: RuntimeProfileKind, id: string, payload: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.adapter.execute(
      `INSERT INTO ${this.tableName} (id, kind, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, id) DO NOTHING`,
      [id, kind, payload, now, now]
    );
    return result.rowsAffected === 1;
  }

  async deleteIfUnchanged(
    kind: RuntimeProfileKind,
    id: string,
    expectedPayload: string
  ): Promise<boolean> {
    // The row becomes a tombstone rather than going: see PROFILE_REGISTRY_TOMBSTONE.
    const result = await this.adapter.execute(
      `UPDATE ${this.tableName} SET payload_json = ?, updated_at = ?
        WHERE kind = ? AND id = ? AND payload_json = ? AND payload_json <> ?`,
      [
        PROFILE_REGISTRY_TOMBSTONE,
        new Date().toISOString(),
        kind,
        id,
        expectedPayload,
        PROFILE_REGISTRY_TOMBSTONE,
      ]
    );
    return result.rowsAffected === 1;
  }
}

export class RuntimeProfileRegistry {
  private readonly builtinMap = new Map<string, RuntimeProfile>();
  private readonly builtinProfiles: RuntimeProfile[];

  constructor(
    private readonly backend: ProfileRegistryBackend,
    builtinProfiles: RuntimeProfile[] = BUILTIN_RUNTIME_PROFILES
  ) {
    this.builtinProfiles = builtinProfiles;
    for (const profile of builtinProfiles) {
      this.builtinMap.set(`${profile.kind}:${profile.id}`, profile);
    }
  }

  async get<T extends RuntimeProfile>(kind: T['kind'], id: string): Promise<T | null> {
    const builtin = this.builtinMap.get(`${kind}:${id}`);
    if (builtin) {
      return builtin as T;
    }
    return this.backend.get<T>(kind, id);
  }

  async list<T extends RuntimeProfile>(
    kind: T['kind'],
    options: { includeBuiltins?: boolean } = {}
  ): Promise<T[]> {
    const includeBuiltins = options.includeBuiltins ?? true;
    const stored = await this.backend.list<T>(kind);
    if (!includeBuiltins) {
      return stored;
    }

    const ids = new Set(stored.map((profile) => profile.id));
    const builtins = this.builtinProfiles.filter(
      (profile): profile is T => profile.kind === kind && !ids.has(profile.id)
    );
    return [...builtins, ...stored];
  }

  async put(profile: RuntimeProfile): Promise<void> {
    if (profile.id.startsWith('builtin:')) {
      throw new Error('builtin_runtime_profiles_are_read_only');
    }
    await this.backend.put(profile);
  }

  async delete(kind: RuntimeProfileKind, id: string): Promise<boolean> {
    if (id.startsWith('builtin:')) {
      return false;
    }
    return this.backend.delete(kind, id);
  }
}

export function readEnvironmentProfileDefaults(
  settings?: Partial<InfrastructureSettings>
): EnvironmentProfileDefaults {
  return {
    auditProfileId:
      normalizeProfileId(settings?.['infra.default_audit_profile_id']) ?? DEFAULT_AUDIT_PROFILE_ID,
    residencyProfileId:
      normalizeProfileId(settings?.['infra.default_residency_profile_id']) ??
      DEFAULT_RESIDENCY_PROFILE_ID,
  };
}

export function readTenantProfileOverrides(
  settings?: Partial<TenantSettings>
): TenantProfileOverrides {
  return {
    auditProfileId: normalizeProfileId(settings?.['tenant.audit_profile_id']) ?? null,
    residencyProfileId: normalizeProfileId(settings?.['tenant.residency_profile_id']) ?? null,
  };
}

export function resolveEffectiveProfileRefs(
  defaults: EnvironmentProfileDefaults,
  overrides?: TenantProfileOverrides
): EffectiveProfileRefs {
  const auditOverride = normalizeProfileId(overrides?.auditProfileId);
  const residencyOverride = normalizeProfileId(overrides?.residencyProfileId);

  return {
    auditProfileId: auditOverride ?? defaults.auditProfileId,
    residencyProfileId: residencyOverride ?? defaults.residencyProfileId,
    inherited: {
      audit: !auditOverride,
      residency: !residencyOverride,
    },
  };
}

export async function resolveRuntimeProfiles(
  registry: RuntimeProfileRegistry,
  refs: EffectiveProfileRefs
): Promise<ResolvedRuntimeProfiles> {
  const [auditProfile, residencyProfile] = await Promise.all([
    registry.get<AuditProfile>('audit', refs.auditProfileId),
    registry.get<ResidencyProfile>('residency', refs.residencyProfileId),
  ]);

  if (!auditProfile) {
    throw new Error(`audit_profile_not_found:${refs.auditProfileId}`);
  }
  if (!residencyProfile) {
    throw new Error(`residency_profile_not_found:${refs.residencyProfileId}`);
  }

  return {
    refs,
    auditProfile,
    residencyProfile,
  };
}
