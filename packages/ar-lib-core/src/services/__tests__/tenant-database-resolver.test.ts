import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import type {
  TenantDatabaseActivePointer,
  TenantDatabaseRegistryRow,
} from '../../repositories/admin/tenant-database-registry';
import {
  clearTenantDatabaseResolverMemoryCache,
  mapStorageTargetToTenantDatabaseRole,
  resolveTenantDatabaseSourceForTarget,
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
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue({
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
    metadata_json: null,
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
  return { privateJwk, publicJwk };
}

function createRuntimeRegistrySnapshot(
  overrides: Partial<TenantRuntimeRegistrySnapshot> = {}
): TenantRuntimeRegistrySnapshot {
  return {
    version: 1,
    tenantId: 'tenant-a',
    snapshotScope: 'tenant',
    deploymentTarget: 'edge-a',
    runtimeGeneration: 8,
    storageProfileId: 'builtin:storage:tenant-d1',
    publishedAt: '2026-05-16T00:00:00.000Z',
    expiresAt: '2099-05-16T00:30:00.000Z',
    stores: [
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
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

describe('tenant-database-resolver', () => {
  beforeEach(() => {
    clearTenantDatabaseResolverMemoryCache();
  });

  it('maps storage target tenant roles', () => {
    expect(mapStorageTargetToTenantDatabaseRole({ driver: 'd1', role: 'tenant_core' })).toBe(
      'tenant_core'
    );
    expect(mapStorageTargetToTenantDatabaseRole({ driver: 'd1', role: 'core' })).toBeNull();
  });

  it('resolves an active tenant D1 binding through the registry', async () => {
    const binding = createD1Binding();
    const row = createRow();
    const repo = createRepository({ pointer: createPointer(), row });

    const resolved = await resolveTenantDatabaseSourceFromRegistry(
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

  it('resolves a slot-based tenant D1 binding through the registry', async () => {
    const binding = createD1Binding();
    const row = createRow({
      database_name: 'authrim-dev-tdb-slot-0001-core',
      binding_ref: 'TDB_SLOT_0001_CORE',
      metadata_json: JSON.stringify({ slot_id: 'tdb-slot-0001', slot_number: 1 }),
    });
    const repo = createRepository({ pointer: createPointer(), row });

    const resolved = await resolveTenantDatabaseSourceFromRegistry(
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

    const first = await resolveTenantDatabaseSourceFromRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', requestCache },
      repo
    );
    const second = await resolveTenantDatabaseSourceFromRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', requestCache },
      repo
    );

    expect(second).toBe(first);
    expect(repo.getActivePointer).toHaveBeenCalledTimes(1);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(1);
  });

  it('uses worker memory cache for repeated registry resolutions across request caches', async () => {
    const binding = createD1Binding();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });

    const first = await resolveTenantDatabaseSourceFromRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );
    const second = await resolveTenantDatabaseSourceFromRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );

    expect(second).toBe(first);
    expect(repo.getActivePointer).toHaveBeenCalledTimes(1);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(1);
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
          ? JSON.stringify({ runtimeGeneration: 8 })
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

  it('fails closed for runtime registry snapshots when verification keys are not configured', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? JSON.stringify({ runtimeGeneration: 8 })
                : JSON.stringify(createRuntimeRegistrySnapshot())
            ),
          },
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          runtimeSnapshotMode: 'required',
        },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'invalid_snapshot_signature'
    );
  });

  it('fails closed when a signed runtime registry snapshot deployment target mismatches the requested target', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
      createRuntimeRegistrySnapshot({ deploymentTarget: 'edge-b' }),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async (key: string) =>
              key.includes(':runtime-registry:generation:')
                ? JSON.stringify({ runtimeGeneration: 8 })
                : JSON.stringify(signedSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          runtimeSnapshotMode: 'required',
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
        runtimeSnapshotMode: 'required',
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
          runtimeSnapshotMode: 'required',
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
          runtimeSnapshotMode: 'required',
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
      expect.stringContaining('INSERT OR IGNORE INTO internal_notification_events'),
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
      }),
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {
          TENANT_RUNTIME_REGISTRY: {
            get: vi.fn(async () => null),
          },
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          runtimeSnapshotMode: 'required',
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
                ? JSON.stringify({ runtimeGeneration: 1 })
                : JSON.stringify(expiredSnapshot)
            ),
          },
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        },
        {
          tenantId: 'tenant-a',
          role: 'tenant_core',
          runtimeSnapshotMode: 'required',
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
        return JSON.stringify({ runtimeGeneration: 7 });
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
          runtimeSnapshotMode: 'required',
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
      get: vi.fn(async () => JSON.stringify({ runtimeGeneration: 5 })),
    };

    const first = await resolveTenantDatabaseSourceFromRegistry(
      {
        TDB_TENANT_A_FIRST_CORE: firstBinding,
        TDB_TENANT_A_SECOND_CORE: secondBinding,
        TENANT_RUNTIME_REGISTRY: runtimeRegistry,
      },
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );
    const second = await resolveTenantDatabaseSourceFromRegistry(
      {
        TDB_TENANT_A_FIRST_CORE: firstBinding,
        TDB_TENANT_A_SECOND_CORE: secondBinding,
        TENANT_RUNTIME_REGISTRY: runtimeRegistry,
      },
      { tenantId: 'tenant-a', role: 'tenant_core' },
      repo
    );
    const third = await resolveTenantDatabaseSourceFromRegistry(
      {
        TDB_TENANT_A_FIRST_CORE: firstBinding,
        TDB_TENANT_A_SECOND_CORE: secondBinding,
        TENANT_RUNTIME_REGISTRY: runtimeRegistry,
      },
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

  it('can disable worker memory cache for tests and operator-sensitive reads', async () => {
    const binding = createD1Binding();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });

    await resolveTenantDatabaseSourceFromRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', memoryCacheTtlMs: 0 },
      repo
    );
    await resolveTenantDatabaseSourceFromRegistry(
      { TDB_TENANT_A_123456_CORE: binding },
      { tenantId: 'tenant-a', role: 'tenant_core', memoryCacheTtlMs: 0 },
      repo
    );

    expect(repo.getActivePointer).toHaveBeenCalledTimes(2);
    expect(repo.getRegistryRow).toHaveBeenCalledTimes(2);
  });

  it('fails closed when active pointer or binding is missing', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {},
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: null, row: null })
      ),
      'missing_active_pointer'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
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
      resolveTenantDatabaseSourceFromRegistry(
        { DB_ADMIN: missingBindingAdmin },
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: createPointer(), row: createRow() })
      ),
      'missing_binding'
    );
    expect(missingBindingAdmin.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO internal_notification_events'),
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
      resolveTenantDatabaseSourceFromRegistry(
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
      expect.stringContaining('INSERT OR IGNORE INTO internal_notification_events'),
      expect.arrayContaining([
        'tenant-a',
        'storage_registry_health',
        'tenant_database.resolver.schema_version_too_old',
        'critical',
      ])
    );
  });

  it('fails closed when the active pointer references a missing or inactive registry row', async () => {
    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
        {},
        { tenantId: 'tenant-a', role: 'tenant_core' },
        createRepository({ pointer: createPointer(), row: null })
      ),
      'missing_registry_row'
    );

    await expectResolverCode(
      resolveTenantDatabaseSourceFromRegistry(
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
      resolveTenantDatabaseSourceFromRegistry(
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
      resolveTenantDatabaseSourceFromRegistry(
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
      resolveTenantDatabaseSourceFromRegistry(
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

  it('resolves from a storage target with tenant database registry resolverRef', async () => {
    const binding = createD1Binding();
    const repo = createRepository({ pointer: createPointer(), row: createRow() });
    const resolved = await resolveTenantDatabaseSourceForTarget(
      { TDB_TENANT_A_123456_CORE: binding },
      'tenant-a',
      {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
      },
      {},
      repo
    );

    expect(resolved.source).toBe(binding);
  });

  it('uses typed resolver errors for unsupported target resolvers', async () => {
    await expect(
      resolveTenantDatabaseSourceForTarget({}, 'tenant-a', {
        driver: 'd1',
        resolverRef: 'other',
        role: 'tenant_core',
      })
    ).rejects.toBeInstanceOf(TenantDatabaseResolverError);
  });
});
