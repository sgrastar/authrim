import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  loadTenantProfileOverridesFromEnv,
  resolveTenantRuntimeProfilesFromEnv,
} from '../runtime-profile-resolver';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
  EXTERNAL_DURABLE_STORAGE_PROFILE_ID,
  SHARED_D1_STORAGE_PROFILE_ID,
  TENANT_D1_STORAGE_PROFILE_ID,
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

describe('runtime-profile-resolver', () => {
  it('reads environment defaults from env-backed infrastructure settings', async () => {
    const defaults = await loadEnvironmentProfileDefaultsFromEnv({
      DB: createMockAdapter(),
      DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:external-postgres',
      DEFAULT_AUDIT_PROFILE_ID: DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID: 'builtin:residency:eu',
    });

    expect(defaults).toEqual({
      storageProfileId: 'builtin:storage:external-postgres',
      auditProfileId: DEFAULT_AUDIT_PROFILE_ID,
      residencyProfileId: 'builtin:residency:eu',
    });
  });

  it('reads tenant overrides from AUTHRIM_CONFIG first', async () => {
    const overrides = await loadTenantProfileOverridesFromEnv(
      {
        DB: createMockAdapter(),
        AUTHRIM_CONFIG: createMockKV({
          'settings:tenant:tenant-a:tenant': JSON.stringify({
            'tenant.storage_profile_id': 'tenant-a-storage',
            'tenant.audit_profile_id': '',
            'tenant.residency_profile_id': 'builtin:residency:eu',
          }),
        }),
      },
      'tenant-a'
    );

    expect(overrides).toEqual({
      storageProfileId: 'tenant-a-storage',
      auditProfileId: null,
      residencyProfileId: 'builtin:residency:eu',
    });
  });

  it('builds a database-backed registry when PROFILE_REGISTRY_BACKEND=database', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValue(null);

    const registry = createRuntimeProfileRegistryFromEnv({
      DB: adapter,
      PROFILE_REGISTRY_BACKEND: 'database',
    });

    const builtin = await registry.get('storage', DEFAULT_STORAGE_PROFILE_ID);
    expect(builtin?.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
  });

  it('falls back to built-in profiles when no kv registry backend is configured', async () => {
    const registry = createRuntimeProfileRegistryFromEnv({
      DB: createMockAdapter(),
    });

    const builtin = await registry.get('storage', DEFAULT_STORAGE_PROFILE_ID);
    const listed = await registry.list('storage');

    expect(builtin?.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(listed.some((profile) => profile.id === DEFAULT_STORAGE_PROFILE_ID)).toBe(true);
  });

  it('exposes deployment-level storage profiles with logical sources', async () => {
    const registry = createRuntimeProfileRegistryFromEnv({
      DB: createMockAdapter(),
    });

    const [shared, tenantD1, externalDurable] = await Promise.all([
      registry.get('storage', SHARED_D1_STORAGE_PROFILE_ID),
      registry.get('storage', TENANT_D1_STORAGE_PROFILE_ID),
      registry.get('storage', EXTERNAL_DURABLE_STORAGE_PROFILE_ID),
    ]);

    expect(DEFAULT_STORAGE_PROFILE_ID).toBe(SHARED_D1_STORAGE_PROFILE_ID);
    expect(shared).toMatchObject({
      deploymentProfile: 'shared-d1',
      scope: 'deployment',
      logicalSources: {
        users_core: { bindingRef: 'DB' },
        users_pii: { bindingRef: 'DB_PII' },
        passkeys: { bindingRef: 'DB' },
        linked_identities: { bindingRef: 'DB_PII' },
        consent: { bindingRef: 'DB' },
        authorization: { bindingRef: 'DB' },
      },
    });
    expect(tenantD1).toMatchObject({
      deploymentProfile: 'tenant-d1',
      scope: 'deployment',
      logicalSources: {
        users_core: { resolverRef: 'tenant-database-registry', role: 'tenant_core' },
        users_pii: { resolverRef: 'tenant-database-registry', role: 'tenant_pii' },
        passkeys: { resolverRef: 'tenant-database-registry', role: 'tenant_core' },
        linked_identities: { resolverRef: 'tenant-database-registry', role: 'tenant_pii' },
        consent: { resolverRef: 'tenant-database-registry', role: 'tenant_core' },
        authorization: { resolverRef: 'tenant-database-registry', role: 'tenant_core' },
      },
    });
    expect(externalDurable).toMatchObject({
      deploymentProfile: 'external-durable',
      scope: 'deployment',
      logicalSources: {
        users_core: { driver: 'postgres', connectionRef: 'core-primary' },
        users_pii: { driver: 'postgres', connectionRef: 'pii-primary' },
        passkeys: { driver: 'postgres', connectionRef: 'core-primary' },
        linked_identities: { driver: 'postgres', connectionRef: 'pii-primary' },
        consent: { driver: 'postgres', connectionRef: 'core-primary' },
        authorization: { driver: 'postgres', connectionRef: 'core-primary' },
      },
    });
  });

  it('resolves tenant-specific storage profile overrides during runtime resolution', async () => {
    const authrimConfig = createMockKV({
      'settings:tenant:tenant-a:tenant': JSON.stringify({
        'tenant.storage_profile_id': 'tenant-a-storage',
      }),
      'profile-registry:storage:tenant-a-storage': JSON.stringify({
        id: 'tenant-a-storage',
        kind: 'storage',
        label: 'Tenant A Storage',
        residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
        slices: {
          custom_claims: {
            driver: 'postgres',
            connectionRef: 'tenant-a-core',
            role: 'core',
          },
        },
      }),
    });

    const resolved = await resolveTenantRuntimeProfilesFromEnv(
      {
        DB: createMockAdapter(),
        AUTHRIM_CONFIG: authrimConfig,
        DEFAULT_STORAGE_PROFILE_ID,
        DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID,
      },
      'tenant-a'
    );

    expect(resolved.refs.storageProfileId).toBe('tenant-a-storage');
    expect(resolved.refs.inherited.storage).toBe(false);
    expect(resolved.storageProfile.id).toBe('tenant-a-storage');
  });

  it('resolves effective runtime profiles with deployment storage and tenant residency override', async () => {
    const authrimConfig = createMockKV({
      'settings:tenant:tenant-a:tenant': JSON.stringify({
        'tenant.residency_profile_id': 'builtin:residency:eu',
      }),
    });

    const resolved = await resolveTenantRuntimeProfilesFromEnv(
      {
        DB: createMockAdapter(),
        AUTHRIM_CONFIG: authrimConfig,
        DEFAULT_STORAGE_PROFILE_ID,
        DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID,
      },
      'tenant-a'
    );

    expect(resolved.refs.storageProfileId).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.refs.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.storageProfile.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.auditProfile.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfile.id).toBe('builtin:residency:eu');
  });
});
