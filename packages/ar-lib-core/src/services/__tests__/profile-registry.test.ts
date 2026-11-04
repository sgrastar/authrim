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
  type AuditProfile,
  type RuntimeProfile,
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

const CUSTOM_AUDIT_PROFILE: AuditProfile = {
  id: 'tenant-a-audit',
  kind: 'audit',
  label: 'Tenant A Audit',
  primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
  archive: null,
  sinks: [],
};

describe('KVProfileRegistryBackend', () => {
  it('round-trips runtime profiles by kind and id', async () => {
    const kv = createMockKV();
    const backend = new KVProfileRegistryBackend(kv);

    await backend.put(CUSTOM_AUDIT_PROFILE);

    const profile = await backend.get('audit', CUSTOM_AUDIT_PROFILE.id);
    const listed = await backend.list('audit');

    expect(profile).toEqual(CUSTOM_AUDIT_PROFILE);
    expect(listed).toEqual([CUSTOM_AUDIT_PROFILE]);
  });
});

describe('DatabaseProfileRegistryBackend', () => {
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  it('writes a profile with one upsert statement', async () => {
    vi.mocked(adapter.execute).mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const backend = new DatabaseProfileRegistryBackend(adapter);
    await backend.put(CUSTOM_AUDIT_PROFILE);

    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.execute).mock.calls[0][0]).toContain(
      'ON CONFLICT (kind, id) DO UPDATE'
    );
  });

  it('writes conditionally on the payload that was compared', async () => {
    const backend = new DatabaseProfileRegistryBackend(adapter);
    vi.mocked(adapter.execute).mockResolvedValue({ success: true, rowsAffected: 0 });

    expect(await backend.putIfUnchanged(CUSTOM_AUDIT_PROFILE, null)).toBe(false);
    expect(await backend.putIfUnchanged(CUSTOM_AUDIT_PROFILE, '{"old":1}')).toBe(false);
    expect(await backend.deleteIfUnchanged('audit', 'tenant-a-audit', '{"old":1}')).toBe(false);

    const calls = vi.mocked(adapter.execute).mock.calls;
    expect(calls[0][0]).toContain('ON CONFLICT (kind, id) DO NOTHING');
    expect(calls[1][0]).toContain('AND payload_json = ?');
    expect(calls[1][1]).toContain('{"old":1}');
    expect(calls[2][0]).toContain('AND payload_json = ?');
  });

  it('reads stored profiles from payload_json rows', async () => {
    vi.mocked(adapter.queryOne).mockResolvedValue({
      payload_json: JSON.stringify(CUSTOM_AUDIT_PROFILE),
    });

    const backend = new DatabaseProfileRegistryBackend(adapter);
    const profile = await backend.get('audit', CUSTOM_AUDIT_PROFILE.id);

    expect(profile).toEqual(CUSTOM_AUDIT_PROFILE);
  });
});

describe('RuntimeProfileRegistry', () => {
  it('merges builtin profiles with backend-defined profiles', async () => {
    const kv = createMockKV({
      'profile-registry:audit:tenant-a-audit': JSON.stringify(CUSTOM_AUDIT_PROFILE),
    });
    const registry = new RuntimeProfileRegistry(new KVProfileRegistryBackend(kv));

    const builtin = await registry.get('audit', DEFAULT_AUDIT_PROFILE_ID);
    const listed = await registry.list('audit');

    expect(builtin?.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(listed.some((profile) => profile.id === CUSTOM_AUDIT_PROFILE.id)).toBe(true);
    expect(listed.some((profile) => profile.id === DEFAULT_AUDIT_PROFILE_ID)).toBe(true);
  });

  it('refuses to overwrite builtin profiles through the mutable backend path', async () => {
    const registry = new RuntimeProfileRegistry(new KVProfileRegistryBackend(createMockKV()));

    await expect(
      registry.put({
        ...(await registry.get('audit', DEFAULT_AUDIT_PROFILE_ID))!,
      } as RuntimeProfile)
    ).rejects.toThrow('builtin_runtime_profiles_are_read_only');
  });
});

describe('profile resolution helpers', () => {
  it('applies tenant audit and residency overrides', () => {
    const defaults = readEnvironmentProfileDefaults({
      'infra.default_audit_profile_id': DEFAULT_AUDIT_PROFILE_ID,
      'infra.default_residency_profile_id': DEFAULT_RESIDENCY_PROFILE_ID,
    });
    const overrides = readTenantProfileOverrides({
      'tenant.audit_profile_id': '',
      'tenant.residency_profile_id': 'builtin:residency:eu',
    });

    const resolved = resolveEffectiveProfileRefs(defaults, overrides);

    expect(resolved.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfileId).toBe('builtin:residency:eu');
    expect(resolved.inherited).toEqual({
      audit: true,
      residency: false,
    });
  });

  it('uses deployment defaults with tenant audit and residency overrides', () => {
    const defaults = readEnvironmentProfileDefaults({
      'infra.default_audit_profile_id': DEFAULT_AUDIT_PROFILE_ID,
      'infra.default_residency_profile_id': DEFAULT_RESIDENCY_PROFILE_ID,
    });
    const overrides = readTenantProfileOverrides({
      'tenant.audit_profile_id': '',
      'tenant.residency_profile_id': 'builtin:residency:eu',
    });

    const resolved = resolveEffectiveProfileRefs(defaults, overrides);

    expect(resolved.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfileId).toBe('builtin:residency:eu');
    expect(resolved.inherited).toEqual({
      audit: true,
      residency: false,
    });
  });

  it('resolves concrete builtin profiles from effective refs', async () => {
    const registry = new RuntimeProfileRegistry(new KVProfileRegistryBackend(createMockKV()));

    const resolved = await resolveRuntimeProfiles(registry, {
      auditProfileId: DEFAULT_AUDIT_PROFILE_ID,
      residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
      inherited: { audit: true, residency: true },
    });

    expect(resolved.auditProfile.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfile.id).toBe(DEFAULT_RESIDENCY_PROFILE_ID);
  });
});
