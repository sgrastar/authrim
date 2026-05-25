import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  DatabaseProfileRegistryBackend,
  KVProfileRegistryBackend,
  RuntimeProfileRegistry,
  readEnvironmentProfileDefaults,
  readTenantProfileOverrides,
  resolveEffectiveProfileRefs,
  resolveRuntimeProfiles,
} from '../profile-registry';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
  type RuntimeProfile,
  type StorageProfile,
} from '../../types/runtime-profile';

function createMockKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: Array.from(store.keys())
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
}

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

const CUSTOM_STORAGE_PROFILE: StorageProfile = {
  id: 'tenant-a-storage',
  kind: 'storage',
  label: 'Tenant A Storage',
  slices: {
    custom_claims: { driver: 'postgres', connectionRef: 'tenant-a-core', role: 'core' },
  },
};

describe('KVProfileRegistryBackend', () => {
  it('round-trips runtime profiles by kind and id', async () => {
    const kv = createMockKV();
    const backend = new KVProfileRegistryBackend(kv);

    await backend.put(CUSTOM_STORAGE_PROFILE);

    const profile = await backend.get('storage', CUSTOM_STORAGE_PROFILE.id);
    const listed = await backend.list('storage');

    expect(profile).toEqual(CUSTOM_STORAGE_PROFILE);
    expect(listed).toEqual([CUSTOM_STORAGE_PROFILE]);
  });
});

describe('DatabaseProfileRegistryBackend', () => {
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  it('updates first and falls back to insert for new rows', async () => {
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const backend = new DatabaseProfileRegistryBackend(adapter);
    await backend.put(CUSTOM_STORAGE_PROFILE);

    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      'UPDATE profile_registry SET payload_json = ?, updated_at = ? WHERE kind = ? AND id = ?',
      [JSON.stringify(CUSTOM_STORAGE_PROFILE), expect.any(String), 'storage', 'tenant-a-storage']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO profile_registry (id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [
        'tenant-a-storage',
        'storage',
        JSON.stringify(CUSTOM_STORAGE_PROFILE),
        expect.any(String),
        expect.any(String),
      ]
    );
  });

  it('reads stored profiles from payload_json rows', async () => {
    vi.mocked(adapter.queryOne).mockResolvedValue({
      payload_json: JSON.stringify(CUSTOM_STORAGE_PROFILE),
    });

    const backend = new DatabaseProfileRegistryBackend(adapter);
    const profile = await backend.get('storage', CUSTOM_STORAGE_PROFILE.id);

    expect(profile).toEqual(CUSTOM_STORAGE_PROFILE);
  });
});

describe('RuntimeProfileRegistry', () => {
  it('merges builtin profiles with backend-defined profiles', async () => {
    const kv = createMockKV({
      'profile-registry:storage:tenant-a-storage': JSON.stringify(CUSTOM_STORAGE_PROFILE),
    });
    const registry = new RuntimeProfileRegistry(new KVProfileRegistryBackend(kv));

    const builtin = await registry.get('storage', DEFAULT_STORAGE_PROFILE_ID);
    const listed = await registry.list('storage');

    expect(builtin?.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(listed.some((profile) => profile.id === CUSTOM_STORAGE_PROFILE.id)).toBe(true);
    expect(listed.some((profile) => profile.id === DEFAULT_STORAGE_PROFILE_ID)).toBe(true);
  });

  it('refuses to overwrite builtin profiles through the mutable backend path', async () => {
    const registry = new RuntimeProfileRegistry(new KVProfileRegistryBackend(createMockKV()));

    await expect(
      registry.put({
        ...(await registry.get('storage', DEFAULT_STORAGE_PROFILE_ID))!,
      } as RuntimeProfile)
    ).rejects.toThrow('builtin_runtime_profiles_are_read_only');
  });
});

describe('profile resolution helpers', () => {
  it('applies tenant storage, audit, and residency overrides', () => {
    const defaults = readEnvironmentProfileDefaults({
      'infra.default_storage_profile_id': DEFAULT_STORAGE_PROFILE_ID,
      'infra.default_audit_profile_id': DEFAULT_AUDIT_PROFILE_ID,
      'infra.default_residency_profile_id': DEFAULT_RESIDENCY_PROFILE_ID,
    });
    const overrides = readTenantProfileOverrides({
      'tenant.storage_profile_id': 'tenant-a-storage',
      'tenant.audit_profile_id': '',
      'tenant.residency_profile_id': 'builtin:residency:eu',
    });

    const resolved = resolveEffectiveProfileRefs(defaults, overrides);

    expect(resolved.storageProfileId).toBe('tenant-a-storage');
    expect(resolved.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfileId).toBe('builtin:residency:eu');
    expect(resolved.inherited).toEqual({
      storage: false,
      audit: true,
      residency: false,
    });
  });

  it('uses deployment storage defaults with tenant audit and residency overrides', () => {
    const defaults = readEnvironmentProfileDefaults({
      'infra.default_storage_profile_id': DEFAULT_STORAGE_PROFILE_ID,
      'infra.default_audit_profile_id': DEFAULT_AUDIT_PROFILE_ID,
      'infra.default_residency_profile_id': DEFAULT_RESIDENCY_PROFILE_ID,
    });
    const overrides = readTenantProfileOverrides({
      'tenant.audit_profile_id': '',
      'tenant.residency_profile_id': 'builtin:residency:eu',
    });

    const resolved = resolveEffectiveProfileRefs(defaults, overrides);

    expect(resolved.storageProfileId).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfileId).toBe('builtin:residency:eu');
    expect(resolved.inherited).toEqual({
      storage: true,
      audit: true,
      residency: false,
    });
  });

  it('resolves concrete builtin profiles from effective refs', async () => {
    const registry = new RuntimeProfileRegistry(new KVProfileRegistryBackend(createMockKV()));

    const resolved = await resolveRuntimeProfiles(registry, {
      storageProfileId: DEFAULT_STORAGE_PROFILE_ID,
      auditProfileId: DEFAULT_AUDIT_PROFILE_ID,
      residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
      inherited: { storage: true, audit: true, residency: true },
    });

    expect(resolved.storageProfile.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.auditProfile.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfile.id).toBe(DEFAULT_RESIDENCY_PROFILE_ID);
  });
});
