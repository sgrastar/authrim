import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../../db';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
  TENANT_D1_STORAGE_PROFILE_ID,
} from '../../../types/runtime-profile';
import { clearTenantDatabaseResolverMemoryCache } from '../../tenant-database-resolver';
import {
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveCustomClaimRuntimeSourcesFromHono,
} from '../runtime-sources';

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
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: Array.from(store.keys())
        .filter((key) => !prefix || key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
}

function createMockAdapter(name: string): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue(name),
    close: vi.fn(),
  };
}

describe('resolveCustomClaimRuntimeSourcesFromEnv', () => {
  beforeEach(() => {
    clearTenantDatabaseResolverMemoryCache();
  });

  it('resolves builtin D1 split bindings for custom claims by default', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV(),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.schemaDb).toBe(env.DB);
    expect(resolved.nonPiiDb).toBe(env.DB);
    expect(resolved.piiDb).toBe(env.DB_PII);
  });

  it('applies tenant override profiles and resolves arbitrary binding refs', async () => {
    const extraCore = createMockAdapter('extra-core');
    const extraPii = createMockAdapter('extra-pii');
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      EXTRA_CORE_DB: extraCore,
      EXTRA_PII_DB: extraPii,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
            registration_fields: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
            custom_pii: {
              driver: 'postgres',
              bindingRef: 'EXTRA_PII_DB',
              role: 'pii',
            },
          },
        }),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.storage_profile_id': 'tenant-a-storage',
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe('tenant-a-storage');
    expect(resolved.schemaDb).toBe(extraCore);
    expect(resolved.nonPiiDb).toBe(extraCore);
    expect(resolved.piiDb).toBe(extraPii);
  });

  it('fails when a profile points at an unresolved external connection', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
          },
        }),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.storage_profile_id': 'tenant-a-storage',
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    await expect(resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a')).rejects.toThrow(
      'storage_profile_connection_not_resolved:core-primary'
    );
  });

  it('resolves storage connectionRef through Hyperdrive bindings', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
            registration_fields: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
            custom_pii: {
              driver: 'postgres',
              connectionRef: 'pii-primary',
              role: 'pii',
            },
          },
        }),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.storage_profile_id': 'tenant-a-storage',
        }),
      }),
      HYPERDRIVE_CORE_PRIMARY: {
        connectionString: 'postgres://core-primary',
      } as Hyperdrive,
      HYPERDRIVE_PII_PRIMARY: {
        connectionString: 'postgres://pii-primary',
      } as Hyperdrive,
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect((resolved.schemaDb as DatabaseAdapter).getType()).toBe('postgres');
    expect((resolved.nonPiiDb as DatabaseAdapter).getType()).toBe('postgres');
    expect((resolved.piiDb as DatabaseAdapter)?.getType()).toBe('postgres');
  });

  it('resolves tenant-d1 custom claim sources through the tenant database registry', async () => {
    const tenantCore = createMockAdapter('tenant-core');
    const tenantPii = createMockAdapter('tenant-pii');
    const queryOne = vi
      .fn()
      .mockResolvedValueOnce({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        shard_group: 'default',
        generation: 1,
        shard_count: 1,
        shard_key_strategy: 'none',
        runtime_generation: 1,
        status: 'active',
        updated_at: '2026-05-16T00:00:00.000Z',
        updated_by: null,
        metadata_json: null,
      })
      .mockResolvedValueOnce({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 1,
        shard_group: 'default',
        shard_index: 0,
        provider: 'd1',
        database_id: 'core-id',
        database_name: 'authrim-dev-tenant-a-core',
        binding_ref: 'TDB_TENANT_A_CORE',
        connection_ref: null,
        schema_version: 1,
        status: 'active',
        shard_count: 1,
        shard_key_strategy: 'none',
        worker_shard: 'primary',
        deployment_target: null,
        region_hint: null,
        jurisdiction: null,
        signature: null,
        signature_key_id: null,
        metadata_json: null,
        created_at: '2026-05-16T00:00:00.000Z',
        updated_at: '2026-05-16T00:00:00.000Z',
        created_by: null,
        updated_by: null,
      })
      .mockResolvedValueOnce({
        tenant_id: 'tenant-a',
        role: 'tenant_pii',
        shard_group: 'default',
        generation: 1,
        shard_count: 1,
        shard_key_strategy: 'none',
        runtime_generation: 1,
        status: 'active',
        updated_at: '2026-05-16T00:00:00.000Z',
        updated_by: null,
        metadata_json: null,
      })
      .mockResolvedValueOnce({
        tenant_id: 'tenant-a',
        role: 'tenant_pii',
        generation: 1,
        shard_group: 'default',
        shard_index: 0,
        provider: 'd1',
        database_id: 'pii-id',
        database_name: 'authrim-dev-tenant-a-pii',
        binding_ref: 'TDB_TENANT_A_PII',
        connection_ref: null,
        schema_version: 1,
        status: 'active',
        shard_count: 1,
        shard_key_strategy: 'none',
        worker_shard: 'primary',
        deployment_target: null,
        region_hint: null,
        jurisdiction: null,
        signature: null,
        signature_key_id: null,
        metadata_json: null,
        created_at: '2026-05-16T00:00:00.000Z',
        updated_at: '2026-05-16T00:00:00.000Z',
        created_by: null,
        updated_by: null,
      });
    const controlDb = createMockAdapter('admin');
    controlDb.queryOne = queryOne as DatabaseAdapter['queryOne'];
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_ADMIN: controlDb,
      TDB_TENANT_A_CORE: tenantCore,
      TDB_TENANT_A_PII: tenantPii,
      DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(TENANT_D1_STORAGE_PROFILE_ID);
    expect(resolved.schemaDb).toBe(tenantCore);
    expect(resolved.nonPiiDb).toBe(tenantCore);
    expect(resolved.piiDb).toBe(tenantPii);
  });

  it('separates tenant-D1 schema, account core, and account PII sources in Hono', async () => {
    const metadataCore = createMockAdapter('metadata-core');
    const accountCore = createMockAdapter('account-core');
    const accountPii = createMockAdapter('account-pii');
    const c = {
      env: {
        DB: metadataCore,
        DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
        DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID,
      },
      get(key: string) {
        if (key === 'tenantMetadataContext') {
          return {
            tenantId: 'tenant-a',
            storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
            coreDb: metadataCore,
          };
        }
        if (key === 'accountDataContext') {
          return { tenantId: 'tenant-a', coreDb: accountCore, piiDb: accountPii };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof resolveCustomClaimRuntimeSourcesFromHono>[0];

    const resolved = await resolveCustomClaimRuntimeSourcesFromHono(c, 'tenant-a');
    expect(resolved.schemaDb).toBe(metadataCore);
    expect(resolved.nonPiiDb).toBe(accountCore);
    expect(resolved.piiDb).toBe(accountPii);
  });

  it('requires an account context for tenant-D1 custom claim values', async () => {
    const metadataCore = createMockAdapter('metadata-core');
    const c = {
      env: {},
      get(key: string) {
        return key === 'tenantMetadataContext'
          ? {
              tenantId: 'tenant-a',
              storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
              coreDb: metadataCore,
            }
          : undefined;
      },
    } as unknown as Parameters<typeof resolveCustomClaimRuntimeSourcesFromHono>[0];

    await expect(resolveCustomClaimRuntimeSourcesFromHono(c, 'tenant-a')).rejects.toThrow(
      'account_data_context_required'
    );
  });
});
