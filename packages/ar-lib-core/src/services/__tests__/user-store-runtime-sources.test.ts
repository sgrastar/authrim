import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../db';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
  EXTERNAL_DURABLE_STORAGE_PROFILE_ID,
  SINGLE_DB_STORAGE_PROFILE_ID,
  TENANT_D1_STORAGE_PROFILE_ID,
} from '../../types/runtime-profile';
import {
  clearTenantDatabaseResolverMemoryCache,
  TenantDatabaseResolverError,
} from '../tenant-database-resolver';
import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '../tenant-runtime-registry-snapshot';
import { resolveUserStoreRuntimeSourcesFromEnv } from '../user-store-runtime-sources';

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

async function generateEd25519Jwks(kid = 'runtime-registry-key-1') {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  privateJwk.alg = 'EdDSA';
  privateJwk.use = 'sig';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
  return { privateJwk, publicJwk };
}

describe('resolveUserStoreRuntimeSourcesFromEnv', () => {
  beforeEach(() => {
    clearTenantDatabaseResolverMemoryCache();
  });

  it('resolves the builtin split profile to DB and DB_PII by default', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.coreDb).toBe(env.DB);
    expect(resolved.piiDb).toBe(env.DB_PII);
    expect(resolved.policyDb).toBe(env.DB);
    expect(resolved.piiCacheMode).toBe('encrypted_short_ttl');
    expect(resolved.userCacheScope).toEqual({
      storageProfileId: DEFAULT_STORAGE_PROFILE_ID,
      sourceGeneration: 'core:0:pii:0',
      schemaVersion: 'core:1:pii:1',
    });
  });

  it('supports the builtin single-db profile when DB_PII is absent', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DEFAULT_STORAGE_PROFILE_ID: SINGLE_DB_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(SINGLE_DB_STORAGE_PROFILE_ID);
    expect(resolved.coreDb).toBe(env.DB);
    expect(resolved.piiDb).toBe(env.DB);
    expect(resolved.policyDb).toBe(env.DB);
    expect(resolved.piiCacheMode).toBe('encrypted_short_ttl');
  });

  it('applies deployment storage profiles for identity_core and identity_pii slices', async () => {
    const extraCore = createMockAdapter('extra-core');
    const extraPii = createMockAdapter('extra-pii');
    const extraPolicy = createMockAdapter('extra-policy');
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      EXTRA_CORE_DB: extraCore,
      EXTRA_PII_DB: extraPii,
      EXTRA_POLICY_DB: extraPolicy,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A User Store',
          logicalSources: {
            policy: {
              driver: 'postgres',
              bindingRef: 'EXTRA_POLICY_DB',
              role: 'policy',
              logicalSource: 'policy',
            },
          },
          slices: {
            identity_core: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
            identity_pii: {
              driver: 'postgres',
              bindingRef: 'EXTRA_PII_DB',
              role: 'pii',
            },
          },
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID: 'tenant-a-storage',
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe('tenant-a-storage');
    expect(resolved.coreDb).toBe(extraCore);
    expect(resolved.piiDb).toBe(extraPii);
    expect(resolved.policyDb).toBe(extraPolicy);
  });

  it('resolves postgres storage connectionRef through Hyperdrive bindings', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A External User Store',
          slices: {
            identity_core: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
            identity_pii: {
              driver: 'postgres',
              connectionRef: 'pii-primary',
              role: 'pii',
            },
          },
        }),
      }),
      HYPERDRIVE_CORE_PRIMARY: {
        connectionString: 'postgres://core-primary',
      } as Hyperdrive,
      HYPERDRIVE_PII_PRIMARY: {
        connectionString: 'postgres://pii-primary',
      } as Hyperdrive,
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID: 'tenant-a-storage',
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe('tenant-a-storage');
    expect((resolved.coreDb as DatabaseAdapter).getType()).toBe('postgres');
    expect((resolved.piiDb as DatabaseAdapter)?.getType()).toBe('postgres');
    expect((resolved.policyDb as DatabaseAdapter).getType()).toBe('postgres');
  });

  it('resolves the builtin external-durable profile to separate core and PII adapters', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_ADMIN: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      HYPERDRIVE_CORE_PRIMARY: {
        connectionString: 'postgres://core-primary',
      } as Hyperdrive,
      HYPERDRIVE_PII_PRIMARY: {
        connectionString: 'postgres://pii-primary',
      } as Hyperdrive,
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID: EXTERNAL_DURABLE_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(EXTERNAL_DURABLE_STORAGE_PROFILE_ID);
    expect((resolved.coreDb as DatabaseAdapter).getType()).toBe('postgres');
    expect((resolved.piiDb as DatabaseAdapter)?.getType()).toBe('postgres');
    expect((resolved.policyDb as DatabaseAdapter).getType()).toBe('postgres');
    expect(resolved.coreDb).not.toBe(resolved.piiDb);
    expect(resolved.userCacheScope).toEqual({
      storageProfileId: EXTERNAL_DURABLE_STORAGE_PROFILE_ID,
      sourceGeneration: 'core:0:pii:0',
      schemaVersion: 'core:1:pii:1',
    });
  });

  it('resolves tenant-d1 user stores from the control database registry', async () => {
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

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(TENANT_D1_STORAGE_PROFILE_ID);
    expect(resolved.coreDb).toBe(tenantCore);
    expect(resolved.piiDb).toBe(tenantPii);
    expect(resolved.policyDb).toBe(tenantCore);
    expect(resolved.piiCacheMode).toBe('encrypted_short_ttl');
    expect(resolved.userCacheScope).toEqual({
      storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
      sourceGeneration: 'core:1:pii:1',
      schemaVersion: 'core:1:pii:1',
    });
  });

  it('does not fall back to shared DB bindings when tenant-d1 generated bindings are missing', async () => {
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
      });
    const controlDb = createMockAdapter('admin');
    controlDb.queryOne = queryOne as DatabaseAdapter['queryOne'];
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_ADMIN: controlDb,
      DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    await expect(resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a')).rejects.toMatchObject({
      name: 'TenantDatabaseResolverError',
      code: 'missing_binding',
    } satisfies Partial<TenantDatabaseResolverError>);
  });

  it('requires tenant runtime registry snapshots for tenant-d1 when the KV binding is configured', async () => {
    const tenantCore = createMockAdapter('tenant-core');
    const tenantPii = createMockAdapter('tenant-pii');
    const controlDb = createMockAdapter('admin');
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const snapshot = await signTenantRuntimeRegistrySnapshot(
      {
        version: 2,
        tenantId: 'tenant-a',
        snapshotScope: 'tenant',
        deploymentTarget: 'default',
        runtimeGeneration: 7,
        routeStatus: 'active',
        quarantineDenyGeneration: 0,
        storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
        publishedAt: '2026-05-16T00:00:00.000Z',
        expiresAt: '2099-05-16T00:30:00.000Z',
        stores: [
          {
            tenantId: 'tenant-a',
            role: 'tenant_core',
            generation: 2,
            runtimeGeneration: 7,
            schemaVersion: 2,
            shardGroup: 'default',
            shardIndex: 0,
            shardCount: 1,
            shardKeyStrategy: 'none',
            provider: 'd1',
            driver: 'd1',
            bindingRef: 'TDB_TENANT_A_CORE',
            connectionRef: null,
            deploymentTarget: null,
            status: 'active',
            healthStatus: 'active',
            databaseId: 'core-id',
            databaseName: 'authrim-dev-tenant-a-core',
            regionHint: null,
            jurisdiction: null,
          },
          {
            tenantId: 'tenant-a',
            role: 'tenant_pii',
            generation: 2,
            runtimeGeneration: 7,
            schemaVersion: 2,
            shardGroup: 'default',
            shardIndex: 0,
            shardCount: 1,
            shardKeyStrategy: 'none',
            provider: 'd1',
            driver: 'd1',
            bindingRef: 'TDB_TENANT_A_PII',
            connectionRef: null,
            deploymentTarget: null,
            status: 'active',
            healthStatus: 'active',
            databaseId: 'pii-id',
            databaseName: 'authrim-dev-tenant-a-pii',
            regionHint: null,
            jurisdiction: null,
          },
        ],
        metadata: {
          storeCount: 2,
          roles: ['tenant_core', 'tenant_pii'],
          signature: null,
          signatureKeyId: null,
          signatureAlgorithm: null,
          signedAt: null,
        },
      } satisfies TenantRuntimeRegistrySnapshot,
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_ADMIN: controlDb,
      TDB_TENANT_A_CORE: tenantCore,
      TDB_TENANT_A_PII: tenantPii,
      TENANT_RUNTIME_REGISTRY: createMockKV({
        'tenant:tenant-a:runtime-registry:generation:tenant:default': JSON.stringify({
          runtimeGeneration: 7,
          routeStatus: 'active',
          quarantineDenyGeneration: 0,
          publishedAt: '2026-05-16T00:00:00.000Z',
          expiresAt: '2099-05-16T00:30:00.000Z',
        }),
        'tenant:tenant-a:runtime-registry:snapshot:tenant:default': JSON.stringify(snapshot),
      }),
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.coreDb).toBe(tenantCore);
    expect(resolved.piiDb).toBe(tenantPii);
    expect(resolved.policyDb).toBe(tenantCore);
    expect(resolved.userCacheScope).toEqual({
      storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
      sourceGeneration: 'core:7:pii:7',
      schemaVersion: 'core:2:pii:2',
    });
    expect(controlDb.queryOne).not.toHaveBeenCalled();
  });

  it('allows operator config to force no cross-request PII cache', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
      PII_CACHE_MODE: 'no_cross_request_pii',
    };

    const resolved = await resolveUserStoreRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.piiCacheMode).toBe('no_cross_request_pii');
  });
});
