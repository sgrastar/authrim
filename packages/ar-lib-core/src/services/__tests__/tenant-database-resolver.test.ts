import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import type {
  TenantDatabaseActivePointer,
  TenantDatabaseRegistryRow,
} from '../../repositories/admin/tenant-database-registry';
import {
  clearTenantDatabaseResolverMemoryCache,
  resolveTenantDatabaseSourceFromControlRegistry,
  resolveTenantDatabaseSourceFromRegistry,
  TenantDatabaseResolverError,
} from '../tenant-database-resolver';
import { signTenantDatabaseRegistryRow } from '../tenant-database-registry-signature';
import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '../tenant-runtime-registry-snapshot';

function createD1Binding() {
  return {
    prepare: vi.fn(),
    batch: vi.fn(),
  } as unknown as D1Database;
}

function createAdminAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  let notificationLookupCount = 0;
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'event-1',
          tenant_id: 'tenant-a',
          category: 'storage_registry_security',
          event_type: 'tenant_runtime_registry_snapshot.verification_failed',
          severity: 'critical',
          status: 'pending',
          deduplication_key:
            'tenant_runtime_registry_snapshot:unsigned_snapshot:tenant-a:edge-a:8:no_key',
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: '2026-05-16T00:00:00.000Z',
          updated_at: '2026-05-16T00:00:00.000Z',
          delivered_at: null,
        });
      }
      return Promise.resolve(null);
    }),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      })
    ),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
    ...overrides,
  };
}

function createPointer(
  overrides: Partial<TenantDatabaseActivePointer> = {}
): TenantDatabaseActivePointer {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    shard_group: 'default',
    generation: 1,
    shard_count: 1,
    shard_key_strategy: 'none',
    runtime_generation: 2,
    status: 'active',
    updated_at: '2026-05-16T00:00:00.000Z',
    updated_by: null,
    metadata_json: null,
    ...overrides,
  };
}

function createRouteMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    control_data_role: 'tenant_core/default',
    control_residency_policy_id: 'builtin:residency:default',
    control_residency_partition: 'default',
    control_shard_id: 'shard-core-default',
    control_assignment_generation: 1,
    control_allocation_scope: 'tenant_exclusive',
    control_owner_tenant_id: 'tenant-a',
    control_placement_policy_generation: 1,
    ...overrides,
  });
}

function createRow(overrides: Partial<TenantDatabaseRegistryRow> = {}): TenantDatabaseRegistryRow {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 1,
    shard_group: 'default',
    shard_index: 0,
    provider: 'd1',
    database_id: 'database-id',
    database_name: 'authrim-dev-tenant-a-core',
    binding_ref: 'TDB_TENANT_A_123456_CORE',
    connection_ref: null,
    schema_version: 2,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'none',
    worker_shard: 'primary',
    deployment_target: null,
    region_hint: null,
    jurisdiction: null,
    signature: null,
    signature_key_id: null,
    metadata_json: createRouteMetadata(),
    created_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

function createRepository(options: {
  pointer?: TenantDatabaseActivePointer | null;
  row?: TenantDatabaseRegistryRow | null;
}) {
  return {
    getActivePointer: vi.fn(async () => options.pointer ?? null),
    getRegistryRow: vi.fn(async () => options.row ?? null),
  };
}

async function expectResolverCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: 'TenantDatabaseResolverError',
    code,
  });
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

function createRuntimeRegistrySnapshot(
  overrides: Partial<TenantRuntimeRegistrySnapshot> = {}
): TenantRuntimeRegistrySnapshot {
  return {
    version: 4,
    tenantId: 'tenant-a',
    snapshotScope: 'tenant',
    deploymentTarget: 'edge-a',
    runtimeGeneration: 8,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
    publishedAt: '2026-05-16T00:00:00.000Z',
    expiresAt: '2099-05-16T00:30:00.000Z',
    stores: [
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'builtin:residency:default',
        residencyPartition: 'default',
        shardId: 'shard-core-default',
        assignmentGeneration: 1,
        bindingRouteGeneration: 3,
        placementPolicyGeneration: 1,
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-a',
        generation: 3,
        runtimeGeneration: 8,
        schemaVersion: 2,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: 'd1',
        driver: 'd1',
        bindingRef: 'TDB_TENANT_A_SNAPSHOT_CORE',
        connectionRef: null,
        deploymentTarget: 'edge-a',
        status: 'active',
        healthStatus: 'active',
        databaseId: 'snapshot-db-id',
        databaseName: 'authrim-dev-tenant-a-core',
        regionHint: null,
        jurisdiction: null,
      },
    ],
    metadata: {
      storeCount: 1,
      roles: ['tenant_core'],
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
    ...overrides,
  };
}

function createRuntimeGenerationDocument(
  runtimeGeneration = 8,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    runtimeGeneration,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    publishedAt: '2026-05-16T00:00:00.000Z',
    expiresAt: '2099-05-23T00:00:00.000Z',
    ...overrides,
  });
}

describe('tenant-database-resolver', () => {
  beforeEach(() => {
    clearTenantDatabaseResolverMemoryCache();
  });

  it('resolves an active routed D1 binding through the registry', async () => {
    const binding = createD1Binding();
    const row = createRow();
    const repo = createRepository({ pointer: createPointer(), row });

    const resolved = await resolveTenantDatabaseSourceFromControlRegistry(
      {
        TDB_TENANT_A_123456_CORE: binding,
        AUTHRIM_DEPLOYMENT_TARGET: 'primary',
      },
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        minimumSchemaVersion: 2,
      },
      repo
    );

    expect(resolved.source).toBe(binding);
    expect(resolved.registryRow).toBe(row);
    expect(resolved.runtimeGeneration).toBe(2);
    expect(resolved).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        generation: 1,
        schemaVersion: 2,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        driver: 'd1',
        bindingRef: 'TDB_TENANT_A_123456_CORE',
        healthStatus: 'active',
      })
    );
    expect(repo.getActivePointer).toHaveBeenCalledWith('tenant-a', 'tenant_core', 'default');
  });

  it('resolves a slot-based routed D1 binding through the registry', async () => {
    const binding = createD1Binding();
    const row = createRow({
      database_name: 'authrim-dev-tdb-slot-0001-core',
      binding_ref: 'TDB_SLOT_0001_CORE',
      metadata_json: createRouteMetadata({ slot_id: 'tdb-slot-0001', slot_number: 1 }),
    });
    const repo = createRepository({ pointer: createPointer(), row });

    const resolved = await resolveTenantDatabaseSourceFromControlRegistry(
      {
        TDB_SLOT_0001_CORE: binding,
        AUTHRIM_DEPLOYMENT_TARGET: 'primary',
      },
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        minimumSchemaVersion: 2,
      },
      repo
    );

    expect(resolved.source).toBe(binding);
    expect(resolved.bindingRef).toBe('TDB_SLOT_0001_CORE');
    expect(resolved.registryRow.metadata_json).toContain('tdb-slot-0001');
  });

  it('uses request-local cache for repeated registry resolutions', async () => {
    const binding = createD1Binding();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });
    const requestCache = new Map();

    const first = await resolveTenantDatabaseSourceFromControlRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', requestCache },
      repo
    );
    const second = await resolveTenantDatabaseSourceFromControlRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', requestCache },
      repo
    );

    expect(second).toBe(first);
    expect(repo.getActivePointer).toHaveBeenCalledTimes(1);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(1);
  });

  it('uses worker metadata cache across requests without sharing the resolved source', async () => {
    const binding = createD1Binding();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });
    const env = { TDB_TENANT_A_123456_CORE: binding };

    const first = await resolveTenantDatabaseSourceFromControlRegistry(
      env,
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );
    const second = await resolveTenantDatabaseSourceFromControlRegistry(
      env,
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );

    expect(second).not.toBe(first);
    expect(second.source).toBe(binding);
    expect(repo.getActivePointer).toHaveBeenCalledTimes(1);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(1);
  });

  it('does not share route metadata or database sources across env objects', async () => {
    const firstBinding = createD1Binding();
    const secondBinding = createD1Binding();
    const firstRepo = createRepository({ pointer: createPointer(), row: createRow() });
    const secondRepo = createRepository({ pointer: createPointer(), row: createRow() });

    const first = await resolveTenantDatabaseSourceFromControlRegistry(
      { TDB_TENANT_A_123456_CORE: firstBinding },
      { tenantId: 'tenant-a', role: 'tenant_core' },
      firstRepo
    );
    const second = await resolveTenantDatabaseSourceFromControlRegistry(
      { TDB_TENANT_A_123456_CORE: secondBinding },
      { tenantId: 'tenant-a', role: 'tenant_core' },
      secondRepo
    );

    expect(first.source).toBe(firstBinding);
    expect(second.source).toBe(secondBinding);
    expect(secondRepo.getActivePointer).toHaveBeenCalledOnce();
    expect(secondRepo.getRegistryRow).toHaveBeenCalledOnce();
  });

  it('resolves from a valid signed runtime registry snapshot without reading the control DB', async () => {
    const binding = createD1Binding();
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot(),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const runtimeRegistry = {
      get: vi.fn(async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? createRuntimeGenerationDocument()
          : JSON.stringify(signedSnapshot)
      ),
    };
    const repo = {
      getActivePointer: vi.fn(async () => {
        throw new Error('control_db_unavailable');
      }),
      getRegistryRow: vi.fn(async () => null),
    };

    const resolved = await resolveTenantDatabaseSourceFromRegistry(
      {
        TDB_TENANT_A_SNAPSHOT_CORE: binding,
        TENANT_RUNTIME_REGISTRY: runtimeRegistry,
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
      },
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        minimumSchemaVersion: 2,
      },
      repo
    );

    expect(resolved.source).toBe(binding);
    expect(resolved.runtimeGeneration).toBe(8);
    expect(resolved.generation).toBe(3);
    expect(resolved.bindingRef).toBe('TDB_TENANT_A_SNAPSHOT_CORE');
    expect(repo.getActivePointer).not.toHaveBeenCalled();
    expect(repo.getRegistryRow).not.toHaveBeenCalled();
    expect(runtimeRegistry.get).toHaveBeenCalledWith(
      'tenant:tenant-a:runtime-registry:snapshot:tenant:edge-a'
    );
  });

  it('does not reuse request or worker caches when generation state disappears', async () => {
    const binding = createD1Binding();
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot(),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    let generationAvailable = true;
    const runtimeRegistry = {
      get: vi.fn(async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? generationAvailable
            ? createRuntimeGenerationDocument()
            : null
          : JSON.stringify(signedSnapshot)
      ),
    };
    const env = {
      TDB_TENANT_A_SNAPSHOT_CORE: binding,
      TENANT_RUNTIME_REGISTRY: runtimeRegistry,
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
    };
    const requestCache = new Map();

    await resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: 'tenant-a',
      role: 'tenant_core',
      requestCache,
      generationCacheTtlMs: 0,
    });
    generationAvailable = false;

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        requestCache,
        generationCacheTtlMs: 0,
      }),
      'missing_generation'
    );
  });

  it('resolves exact default, users, and PII bindings from multi-shard signed routing', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const baseStore = createRuntimeRegistrySnapshot().stores[0];
    const stores = [
      { role: 'tenant_core', shardGroup: 'default', shardIndex: 0 },
      { role: 'tenant_core', shardGroup: 'default', shardIndex: 1 },
      { role: 'tenant_core', shardGroup: 'users', shardIndex: 0 },
      { role: 'tenant_core', shardGroup: 'users', shardIndex: 1 },
      { role: 'tenant_pii', shardGroup: 'default', shardIndex: 0 },
      { role: 'tenant_pii', shardGroup: 'default', shardIndex: 1 },
    ].map((identity) => {
      const suffix = `${identity.role === 'tenant_pii' ? 'PII' : 'CORE'}_${identity.shardGroup.toUpperCase()}_${identity.shardIndex}`;
      return {
        ...baseStore,
        ...identity,
        dataRole:
          identity.role === 'tenant_pii'
            ? ('tenant_pii' as const)
            : identity.shardGroup === 'default'
              ? ('tenant_core/default' as const)
              : ('tenant_core/users' as const),
        shardId: `shard-${suffix.toLowerCase()}`,
        shardCount: 2,
        shardKeyStrategy: 'least_loaded_fixed',
        bindingRef: `TDB_${suffix}`,
        databaseId: `database-${suffix.toLowerCase()}`,
        databaseName: `authrim-test-${suffix.toLowerCase()}`,
      };
    });
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot({
        stores,
        metadata: {
          storeCount: stores.length,
          roles: ['tenant_core', 'tenant_pii'],
          signature: null,
          signatureKeyId: null,
          signatureAlgorithm: null,
          signedAt: null,
        },
      }),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const bindings = Object.fromEntries(
      stores.map((store) => [store.bindingRef, createD1Binding()])
    );
    const runtimeRegistry = {
      get: vi.fn(async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? createRuntimeGenerationDocument()
          : JSON.stringify(signedSnapshot)
      ),
    };
    const repository = {
      getActivePointer: vi.fn(async () => {
        throw new Error('control_db_unavailable');
      }),
      getRegistryRow: vi.fn(async () => null),
    };
    const env = {
      ...bindings,
      TENANT_RUNTIME_REGISTRY: runtimeRegistry,
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
    };

    for (const expected of [
      { role: 'tenant_core' as const, shardGroup: 'default', shardIndex: 1 },
      { role: 'tenant_core' as const, shardGroup: 'users', shardIndex: 0 },
      { role: 'tenant_pii' as const, shardGroup: 'default', shardIndex: 1 },
    ]) {
      const resolved = await resolveTenantDatabaseSourceFromRegistry(
        env,
        {
          tenantId: 'tenant-a',
          role: expected.role,
          shardGroup: expected.shardGroup,
          shardIndex: expected.shardIndex,
        },
        repository
      );
      expect(resolved).toMatchObject({
        role: expected.role,
        shardGroup: expected.shardGroup,
        shardIndex: expected.shardIndex,
        shardCount: 2,
        shardKeyStrategy: 'least_loaded_fixed',
      });
      expect(resolved.source).toBe(bindings[resolved.bindingRef]);
    }

    expect(repository.getActivePointer).not.toHaveBeenCalled();
    expect(repository.getRegistryRow).not.toHaveBeenCalled();
  });

  it('fails closed with distinct role, ownership, and generation route errors', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot(),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const env = {
      TDB_TENANT_A_SNAPSHOT_CORE: createD1Binding(),
      TENANT_RUNTIME_REGISTRY: {
        get: vi.fn(async (key: string) =>
          key.includes(':runtime-registry:generation:')
            ? createRuntimeGenerationDocument()
            : JSON.stringify(signedSnapshot)
        ),
      },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
    };

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/users',
      }),
      'route_role_residency_mismatch'
    );
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        residencyPartition: 'default',
        shardId: 'other-shard',
      }),
      'route_owner_mismatch'
    );
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        residencyPartition: 'default',
        shardId: 'shard-core-default',
        bindingRef: 'TDB_TENANT_A_SNAPSHOT_CORE',
        requiredBindingRouteGeneration: 4,
      }),
      'route_generation_mismatch'
    );
  });

  it('rejects a signed snapshot whose store contract crosses runtime generations', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const base = createRuntimeRegistrySnapshot();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      {
        ...base,
        stores: base.stores.map((store) => ({ ...store, runtimeGeneration: 7 })),
      },
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TDB_TENANT_A_SNAPSHOT_CORE: createD1Binding(),
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? createRuntimeGenerationDocument()
                : JSON.stringify(signedSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        { tenantId: 'tenant-a', role: 'tenant_core' }
      ),
      'invalid_route_contract'
    );
  });

  it('rejects a signed snapshot whose Core and PII routes share a physical D1 database', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const base = createRuntimeRegistrySnapshot();
    const coreStore = base.stores[0];
    const piiStore = {
      ...coreStore,
      role: 'tenant_pii' as const,
      dataRole: 'tenant_pii' as const,
      shardId: 'shard-pii-default',
      shardGroup: 'pii',
      bindingRef: 'TDB_TENANT_A_SNAPSHOT_PII',
      databaseName: 'authrim-dev-tenant-a-pii',
    };
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      {
        ...base,
        stores: [coreStore, piiStore],
        metadata: {
          ...base.metadata,
          storeCount: 2,
          roles: ['tenant_core', 'tenant_pii'],
        },
      },
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TDB_TENANT_A_SNAPSHOT_CORE: createD1Binding(),
          TDB_TENANT_A_SNAPSHOT_PII: createD1Binding(),
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? createRuntimeGenerationDocument()
                : JSON.stringify(signedSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        { tenantId: 'tenant-a', role: 'tenant_core' }
      ),
      'invalid_route_contract'
    );
  });

  it('resolves shared-pool and tenant-exclusive placements in the same runtime', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const exclusiveSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot(),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const sharedBase = createRuntimeRegistrySnapshot();
    const sharedSnapshot = await signTenantRuntimeRegistrySnapshot(
      {
        ...sharedBase,
        tenantId: 'tenant-b',
        placement: { isolationPolicy: 'shared_pool', policyGeneration: 2 },
        stores: sharedBase.stores.map((store) => ({
          ...store,
          tenantId: 'tenant-b',
          placementPolicyGeneration: 2,
          allocationScope: 'shared_pool',
          ownerTenantId: null,
          bindingRef: 'TDB_SHARED_POOL_CORE',
        })),
      },
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const exclusiveBinding = createD1Binding();
    const sharedBinding = createD1Binding();
    const env = {
      TDB_TENANT_A_SNAPSHOT_CORE: exclusiveBinding,
      TDB_SHARED_POOL_CORE: sharedBinding,
      TENANT_RUNTIME_REGISTRY: {
        get: vi.fn(async (key: string) => {
          if (key.includes(':runtime-registry:generation:')) {
            return createRuntimeGenerationDocument();
          }
          return JSON.stringify(
            key.includes('tenant:tenant-b:') ? sharedSnapshot : exclusiveSnapshot
          );
        }),
      },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
    };

    const [exclusive, shared] = await Promise.all([
      resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: 'tenant-a',
        role: 'tenant_core',
      }),
      resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId: 'tenant-b',
        role: 'tenant_core',
      }),
    ]);

    expect(exclusive.source).toBe(exclusiveBinding);
    expect(exclusive.placementPolicy).toEqual({
      isolationPolicy: 'tenant_exclusive',
      policyGeneration: 1,
    });
    expect(shared.source).toBe(sharedBinding);
    expect(shared.placementPolicy).toEqual({
      isolationPolicy: 'shared_pool',
      policyGeneration: 2,
    });
  });

  it('fails closed for runtime registry snapshots when verification keys are not configured', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? createRuntimeGenerationDocument()
                : JSON.stringify(createRuntimeRegistrySnapshot())
            ),
          },
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'invalid_snapshot_signature'
    );
  });

  it('fails closed when a signed runtime registry snapshot deployment target mismatches the requested target', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot({
        deploymentTarget: 'edge-b',
        stores: createRuntimeRegistrySnapshot().stores.map((store) => ({
          ...store,
          deploymentTarget: 'edge-b',
        })),
      }),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? createRuntimeGenerationDocument()
                : JSON.stringify(signedSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'invalid_snapshot_signature'
    );
  });

  it('verifies signed runtime registry snapshots when public keys are configured', async () => {
    const binding = createD1Binding();
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot(),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const runtimeRegistry = {
      get: vi.fn(async () => JSON.stringify(signedSnapshot)),
    };
    const repo = {
      getActivePointer: vi.fn(async () => {
        throw new Error('control_db_unavailable');
      }),
      getRegistryRow: vi.fn(async () => null),
    };

    const resolved = await resolveTenantDatabaseSourceFromRegistry(
      {
        TDB_TENANT_A_SNAPSHOT_CORE: binding,
        TENANT_RUNTIME_REGISTRY: runtimeRegistry,
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
      },
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
      },
      repo
    );

    expect(resolved.source).toBe(binding);
    expect(repo.getActivePointer).not.toHaveBeenCalled();
  });

  it('fails closed for unsigned snapshots when runtime verification keys are configured', async () => {
    const { publicJwk } = await generateEd25519Jwks();

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async () => JSON.stringify(createRuntimeRegistrySnapshot())),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'invalid_snapshot_signature'
    );
  });

  it('best-effort records security events when snapshot signature verification fails', async () => {
    const { publicJwk } = await generateEd25519Jwks();
    const adminAdapter = createAdminAdapter();

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          DB_ADMIN: adminAdapter,
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async () => JSON.stringify(createRuntimeRegistrySnapshot())),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'invalid_snapshot_signature'
    );

    expect(adminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.arrayContaining([
        'tenant_runtime_registry_snapshot.verification_failed',
        'tenant_runtime_registry_snapshot',
        'tenant:tenant-a:runtime-registry:snapshot:tenant:edge-a',
        'failure',
        'unsigned_snapshot',
      ])
    );
    expect(adminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        'tenant-a',
        'storage_registry_security',
        'tenant_runtime_registry_snapshot.verification_failed',
        'critical',
      ])
    );
  });

  it('fails closed when a required runtime registry snapshot is missing or expired', async () => {
    const repo = createRepository({ pointer: createPointer(), row: createRow() });
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const expiredSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot({
        deploymentTarget: 'default',
        runtimeGeneration: 1,
        expiresAt: '2000-01-01T00:00:00.000Z',
        stores: [],
        metadata: {
          storeCount: 0,
          roles: [],
          signature: null,
          signatureKeyId: null,
          signatureAlgorithm: null,
          signedAt: null,
        },
      }),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? createRuntimeGenerationDocument()
                : null
            ),
          },
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        repo
      ),
      'missing_snapshot'
    );
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? createRuntimeGenerationDocument(1)
                : JSON.stringify(expiredSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        repo
      ),
      'expired_snapshot'
    );
    expect(repo.getActivePointer).not.toHaveBeenCalled();
  });

  it('fails closed when lightweight runtime generation metadata is missing or mismatched', async () => {
    const repo = createRepository({ pointer: createPointer(), row: createRow() });
    const runtimeRegistry = {
      get: vi.fn(async (key: string) => {
        if (key.includes(':runtime-registry:snapshot:')) {
          return JSON.stringify(createRuntimeRegistrySnapshot());
        }
        return createRuntimeGenerationDocument(7);
      }),
    };

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: runtimeRegistry,
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        repo
      ),
      'invalid_snapshot_signature'
    );

    expect(runtimeRegistry.get).toHaveBeenCalledWith(
      'tenant:tenant-a:runtime-registry:generation:tenant:edge-a'
    );
    expect(repo.getActivePointer).not.toHaveBeenCalled();
  });

  it('invalidates worker memory cache when the lightweight runtime generation key changes', async () => {
    const firstBinding = createD1Binding();
    const secondBinding = createD1Binding();
    const firstPointer = createPointer({ generation: 1, runtime_generation: 4 });
    const secondPointer = createPointer({ generation: 2, runtime_generation: 5 });
    const firstRow = createRow({ generation: 1, binding_ref: 'TDB_TENANT_A_FIRST_CORE' });
    const secondRow = createRow({
      generation: 2,
      database_id: 'database-id-2',
      database_name: 'authrim-dev-tenant-a-core-v2',
      binding_ref: 'TDB_TENANT_A_SECOND_CORE',
    });
    const repo = {
      getActivePointer: vi
        .fn()
        .mockResolvedValueOnce(firstPointer)
        .mockResolvedValueOnce(secondPointer),
      getRegistryRow: vi.fn().mockResolvedValueOnce(firstRow).mockResolvedValueOnce(secondRow),
    };
    const runtimeRegistry = {
      get: vi.fn(async () => createRuntimeGenerationDocument(5)),
    };
    const env = {
      TDB_TENANT_A_FIRST_CORE: firstBinding,
      TDB_TENANT_A_SECOND_CORE: secondBinding,
      TENANT_RUNTIME_REGISTRY: runtimeRegistry,
    };

    const first = await resolveTenantDatabaseSourceFromControlRegistry(
      env,
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );
    const second = await resolveTenantDatabaseSourceFromControlRegistry(
      env,
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );
    const third = await resolveTenantDatabaseSourceFromControlRegistry(
      env,
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );

    expect(first.source).toBe(firstBinding);
    expect(second.source).toBe(secondBinding);
    expect(third.source).toBe(secondBinding);
    expect(second.runtimeGeneration).toBe(5);
    expect(repo.getActivePointer).toHaveBeenCalledTimes(2);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(2);
    expect(
      runtimeRegistry.get.mock.calls.filter(([key]) =>
        String(key).includes(':runtime-registry:generation:')
      )
    ).toHaveLength(1);
  });

  it('denies a quarantined generation before request and worker caches or control DB fallback', async () => {
    const binding = createD1Binding();
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot(),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    let routeStatus: 'active' | 'quarantining' = 'active';
    const runtimeRegistry = {
      get: vi.fn(async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? JSON.stringify({
              runtimeGeneration: 8,
              routeStatus,
              quarantineDenyGeneration: routeStatus === 'active' ? 0 : 1,
              publishedAt: '2026-05-16T00:00:00.000Z',
              expiresAt: '2099-05-23T00:00:00.000Z',
            })
          : JSON.stringify(signedSnapshot)
      ),
    };
    const requestCache = new Map();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });

    await resolveTenantDatabaseSourceFromRegistry(
      {
        TDB_TENANT_A_SNAPSHOT_CORE: binding,
        TENANT_RUNTIME_REGISTRY: runtimeRegistry,
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
      },
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        requestCache,
        generationCacheTtlMs: 0,
      },
      repo
    );
    routeStatus = 'quarantining';

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TDB_TENANT_A_SNAPSHOT_CORE: binding,
          TENANT_RUNTIME_REGISTRY: runtimeRegistry,
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          requestCache,
          generationCacheTtlMs: 0,
        },
        repo
      ),
      'quarantined_route'
    );
    expect(repo.getActivePointer).not.toHaveBeenCalled();
  });

  it('denies a signed quarantined snapshot even if lightweight metadata claims active', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot({
        routeStatus: 'quarantined',
        quarantineDenyGeneration: 2,
      }),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    const repo = createRepository({ pointer: createPointer(), row: createRow() });

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? JSON.stringify({
                    runtimeGeneration: 8,
                    routeStatus: 'active',
                    quarantineDenyGeneration: 0,
                    publishedAt: '2026-05-16T00:00:00.000Z',
                    expiresAt: '2099-05-23T00:00:00.000Z',
                  })
                : JSON.stringify(signedSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
        },
        repo
      ),
      'quarantined_route'
    );
    expect(repo.getActivePointer).not.toHaveBeenCalled();
  });

  it('can disable worker memory cache for tests and operator-sensitive reads', async () => {
    const binding = createD1Binding();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });

    await resolveTenantDatabaseSourceFromControlRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', memoryCacheTtlMs: 0 },
      repo
    );
    await resolveTenantDatabaseSourceFromControlRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', memoryCacheTtlMs: 0 },
      repo
    );

    expect(repo.getActivePointer).toHaveBeenCalledTimes(2);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(2);
  });

  it('fails closed when active pointer or binding is missing', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {},
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: null, row: null })
      ),
      'missing_active_pointer'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {},
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'missing_binding'
    );
  });

  it('records storage registry health alerts for missing bindings and schema gates', async () => {
    const missingBindingAdmin = createAdminAdapter();
    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        { DB_ADMIN: missingBindingAdmin },
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'missing_binding'
    );
    expect(missingBindingAdmin.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        'tenant-a',
        'storage_registry_health',
        'tenant_database.resolver.missing_binding',
        'critical',
      ])
    );
    expect(missingBindingAdmin.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO admin_jobs'),
      expect.arrayContaining(['tenant-a', expect.stringContaining('"reason":"missing_binding"')])
    );

    const schemaGateAdmin = createAdminAdapter();
    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {
          DB_ADMIN: schemaGateAdmin,
          TDB_TENANT_A_123456_CORE: createD1Binding(),
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          minimumSchemaVersion: 3,
        },
        createRepository({ pointer: createPointer(), row: createRow({ schema_version: 2 }) })
      ),
      'schema_version_too_old'
    );
    expect(schemaGateAdmin.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        'tenant-a',
        'storage_registry_health',
        'tenant_database.resolver.schema_version_too_old',
        'critical',
      ])
    );
  });

  it('fails closed without alerting while a new database binding is still provisioning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:05:00.000Z'));
    try {
      const adminAdapter = createAdminAdapter();
      await expectResolverCode(
        resolveTenantDatabaseSourceFromControlRegistry(
          { DB_ADMIN: adminAdapter },
          { tenantId: 'tenant-a', role: 'tenant_core' },
          createRepository({
            pointer: createPointer(),
            row: createRow({ created_at: '2026-05-16T00:00:00.000Z' }),
          })
        ),
        'missing_binding'
      );

      expect(adminAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO internal_notification_events'),
        expect.anything()
      );
      expect(adminAdapter.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR IGNORE INTO admin_jobs'),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the active pointer references a missing or inactive registry row', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {},
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: createPointer(), row: null })
      ),
      'missing_registry_row'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {},
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({
          pointer: createPointer(),
          row: createRow({ status: 'failed' }),
        })
      ),
      'inactive_registry_row'
    );
  });

  it('fails closed when registry row signature verification is configured and invalid', async () => {
    const signed = await signTenantDatabaseRegistryRow(createRow(), {
      keyId: 'registry-key-1',
      secret: 'registry-secret',
    });

    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {
          TDB_TENANT_A_123456_CORE: createD1Binding(),
          TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET: 'registry-secret',
          TENANT_DATABASE_REGISTRY_SIGNATURE_KEY_ID: 'registry-key-1',
        },
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({
          pointer: createPointer(),
          row: createRow({
            binding_ref: 'TDB_TAMPERED_CORE',
            signature: signed.signature,
            signature_key_id: signed.signatureKeyId,
          }),
        })
      ),
      'invalid_registry_signature'
    );
  });

  it('fails closed for old schema versions and wrong deployment target', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {
          TDB_TENANT_A_123456_CORE: createD1Binding(),
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          minimumSchemaVersion: 3,
        },
        createRepository({ pointer: createPointer(), row: createRow({ schema_version: 2 }) })
      ),
      'schema_version_too_old'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromControlRegistry(
        {
          TDB_TENANT_A_123456_CORE: createD1Binding(),
          AUTHRIM_DEPLOYMENT_TARGET: 'secondary',
        },
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({
          pointer: createPointer(),
          row: createRow({ deployment_target: 'primary' }),
        })
      ),
      'tenant_assigned_to_other_deployment_target'
    );
  });
});
