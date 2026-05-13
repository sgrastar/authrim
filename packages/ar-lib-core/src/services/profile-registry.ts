import type { DatabaseAdapter } from '../db';
import type { InfrastructureSettings } from '../types/settings/infrastructure';
import type { TenantSettings } from '../types/settings/tenant';
import {
  BUILTIN_RUNTIME_PROFILES,
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
  type AuditProfile,
  type ResidencyProfile,
  type RuntimeProfile,
  type RuntimeProfileKind,
  type StorageProfile,
} from '../types/runtime-profile';

export interface ProfileRegistryBackend {
  get<T extends RuntimeProfile>(kind: T['kind'], id: string): Promise<T | null>;
  list<T extends RuntimeProfile>(kind: T['kind']): Promise<T[]>;
  put(profile: RuntimeProfile): Promise<void>;
  delete(kind: RuntimeProfileKind, id: string): Promise<boolean>;
}

export interface EnvironmentProfileDefaults {
  storageProfileId: string;
  auditProfileId: string;
  residencyProfileId: string;
}

export interface TenantProfileOverrides {
  storageProfileId?: string | null;
  auditProfileId?: string | null;
  residencyProfileId?: string | null;
}

export interface EffectiveProfileRefs extends EnvironmentProfileDefaults {
  inherited: {
    storage: boolean;
    audit: boolean;
    residency: boolean;
  };
}

export interface ResolvedRuntimeProfiles {
  refs: EffectiveProfileRefs;
  storageProfile: StorageProfile;
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

export class DatabaseProfileRegistryBackend implements ProfileRegistryBackend {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly tableName: string = 'profile_registry'
  ) {}

  async get<T extends RuntimeProfile>(kind: T['kind'], id: string): Promise<T | null> {
    const row = await this.adapter.queryOne<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.tableName} WHERE kind = ? AND id = ?`,
      [kind, id]
    );
    return row ? parseProfilePayload<T>(row.payload_json) : null;
  }

  async list<T extends RuntimeProfile>(kind: T['kind']): Promise<T[]> {
    const rows = await this.adapter.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.tableName} WHERE kind = ? ORDER BY id ASC`,
      [kind]
    );
    return rows.map((row) => parseProfilePayload<T>(row.payload_json));
  }

  async put(profile: RuntimeProfile): Promise<void> {
    const payload = JSON.stringify(profile);
    const now = new Date().toISOString();
    const updated = await this.adapter.execute(
      `UPDATE ${this.tableName} SET payload_json = ?, updated_at = ? WHERE kind = ? AND id = ?`,
      [payload, now, profile.kind, profile.id]
    );
    if (updated.rowsAffected > 0) {
      return;
    }

    try {
      await this.adapter.execute(
        `INSERT INTO ${this.tableName} (id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [profile.id, profile.kind, payload, now, now]
      );
    } catch (error) {
      const retried = await this.adapter.execute(
        `UPDATE ${this.tableName} SET payload_json = ?, updated_at = ? WHERE kind = ? AND id = ?`,
        [payload, now, profile.kind, profile.id]
      );
      if (retried.rowsAffected === 0) {
        throw error;
      }
    }
  }

  async delete(kind: RuntimeProfileKind, id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM ${this.tableName} WHERE kind = ? AND id = ?`,
      [kind, id]
    );
    return result.rowsAffected > 0;
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
    storageProfileId:
      normalizeProfileId(settings?.['infra.default_storage_profile_id']) ??
      DEFAULT_STORAGE_PROFILE_ID,
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
    storageProfileId: normalizeProfileId(settings?.['tenant.storage_profile_id']) ?? null,
    auditProfileId: normalizeProfileId(settings?.['tenant.audit_profile_id']) ?? null,
    residencyProfileId: normalizeProfileId(settings?.['tenant.residency_profile_id']) ?? null,
  };
}

export function resolveEffectiveProfileRefs(
  defaults: EnvironmentProfileDefaults,
  overrides?: TenantProfileOverrides
): EffectiveProfileRefs {
  const storageOverride = normalizeProfileId(overrides?.storageProfileId);
  const auditOverride = normalizeProfileId(overrides?.auditProfileId);
  const residencyOverride = normalizeProfileId(overrides?.residencyProfileId);

  return {
    storageProfileId: storageOverride ?? defaults.storageProfileId,
    auditProfileId: auditOverride ?? defaults.auditProfileId,
    residencyProfileId: residencyOverride ?? defaults.residencyProfileId,
    inherited: {
      storage: !storageOverride,
      audit: !auditOverride,
      residency: !residencyOverride,
    },
  };
}

export async function resolveRuntimeProfiles(
  registry: RuntimeProfileRegistry,
  refs: EffectiveProfileRefs
): Promise<ResolvedRuntimeProfiles> {
  const [storageProfile, auditProfile, residencyProfile] = await Promise.all([
    registry.get<StorageProfile>('storage', refs.storageProfileId),
    registry.get<AuditProfile>('audit', refs.auditProfileId),
    registry.get<ResidencyProfile>('residency', refs.residencyProfileId),
  ]);

  if (!storageProfile) {
    throw new Error(`storage_profile_not_found:${refs.storageProfileId}`);
  }
  if (!auditProfile) {
    throw new Error(`audit_profile_not_found:${refs.auditProfileId}`);
  }
  if (!residencyProfile) {
    throw new Error(`residency_profile_not_found:${refs.residencyProfileId}`);
  }

  return {
    refs,
    storageProfile,
    auditProfile,
    residencyProfile,
  };
}
