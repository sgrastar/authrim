import { describe, expect, it, vi } from 'vitest';
import type {
  TenantDatabaseActivePointer,
  TenantDatabaseRegistryRepository,
  TenantDatabaseRegistryRow,
} from '../../repositories/admin/tenant-database-registry';
import {
  DEFAULT_RUNTIME_REGISTRY_GENERATION_TTL_SECONDS,
  DEFAULT_RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS,
  TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  publishTenantRuntimeRegistrySnapshot,
  purgeTenantRuntimeRegistrySnapshot,
  verifyTenantRuntimeRegistrySnapshotSignature,
  type RuntimeRegistrySnapshotStore,
} from '../tenant-runtime-registry-snapshot';

function createPointer(
  overrides: Partial<TenantDatabaseActivePointer> = {}
): TenantDatabaseActivePointer {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    shard_group: 'default',
    generation: 2,
    shard_count: 1,
    shard_key_strategy: 'none',
    runtime_generation: 7,
    status: 'active',
    updated_at: '2026-05-16T00:00:00.000Z',
    updated_by: null,
    metadata_json: null,
    ...overrides,
  };
}

function createRegistryRow(
  overrides: Partial<TenantDatabaseRegistryRow> = {}
): TenantDatabaseRegistryRow {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 2,
    shard_group: 'default',
    shard_index: 0,
    provider: 'd1',
    database_id: 'db-core-id',
    database_name: 'authrim-dev-tenant-a-core',
    binding_ref: 'TDB_TENANT_A_1234_CORE',
    connection_ref: null,
    schema_version: 2,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'none',
    worker_shard: null,
    deployment_target: 'edge-a',
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
  pointers?: TenantDatabaseActivePointer[];
  rows?: TenantDatabaseRegistryRow[];
}) {
  const pointers = options.pointers ?? [createPointer()];
  const rows = options.rows ?? [createRegistryRow()];

  return {
    listActivePointersForTenant: vi.fn(async () => pointers),
    getRegistryRow: vi.fn(async (key) => {
      return (
        rows.find(
          (row) =>
            row.tenant_id === key.tenant_id &&
            row.role === key.role &&
            row.generation === key.generation &&
            row.shard_group === key.shard_group &&
            row.shard_index === key.shard_index
        ) ?? null
      );
    }),
    updateActivePointerStatus: vi.fn(async () => undefined),
    updateRegistryStatusAndMetadata: vi.fn(async () => undefined),
    upsertRuntimeCacheGeneration: vi.fn(async () => ({
      tenant_id: 'tenant-a',
      cache_namespace: 'runtime_registry',
      generation: 7,
      updated_at: '2026-05-16T00:00:00.000Z',
      updated_by: 'system',
      metadata_json: null,
    })),
    upsertRuntimeRegistrySnapshot: vi.fn(async () => ({
      tenant_id: 'tenant-a',
      snapshot_scope: 'tenant',
      deployment_target: 'edge-a',
      runtime_generation: 7,
      storage_profile_id: 'builtin:storage:tenant-d1',
      snapshot_version: 1,
      status: 'active',
      object_ref: buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'edge-a'),
      published_at: '2026-05-16T00:00:00.000Z',
      expires_at: '2026-05-16T00:30:00.000Z',
      signature: null,
      signature_key_id: null,
      metadata_json: null,
    })),
  } as unknown as TenantDatabaseRegistryRepository & {
    listActivePointersForTenant: ReturnType<typeof vi.fn>;
    getRegistryRow: ReturnType<typeof vi.fn>;
    updateActivePointerStatus: ReturnType<typeof vi.fn>;
    updateRegistryStatusAndMetadata: ReturnType<typeof vi.fn>;
    upsertRuntimeCacheGeneration: ReturnType<typeof vi.fn>;
    upsertRuntimeRegistrySnapshot: ReturnType<typeof vi.fn>;
  };
}

function createSnapshotStore(): RuntimeRegistrySnapshotStore & { put: ReturnType<typeof vi.fn> } {
  return {
    put: vi.fn(async () => undefined),
  };
}

async function generateEd25519Jwks(kid = 'runtime-registry-key-1') {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  return { privateJwk, publicJwk };
}

describe('tenant-runtime-registry-snapshot', () => {
  it('publishes normalized runtime snapshots and generation keys', async () => {
    const repository = createRepository({
      pointers: [
        createPointer({ role: 'tenant_core', runtime_generation: 7 }),
        createPointer({
          role: 'tenant_pii',
          generation: 3,
          runtime_generation: 7,
        }),
      ],
      rows: [
        createRegistryRow({ role: 'tenant_core' }),
        createRegistryRow({
          role: 'tenant_pii',
          generation: 3,
          database_id: 'db-pii-id',
          database_name: 'authrim-dev-tenant-a-pii',
          binding_ref: 'TDB_TENANT_A_1234_PII',
        }),
      ],
    });
    const snapshotStore = createSnapshotStore();
    const { privateJwk } = await generateEd25519Jwks();

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      storageProfileId: 'builtin:storage:tenant-d1',
      deploymentTarget: 'edge-a',
      repository,
      snapshotStore,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
      signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
    });

    expect(result.snapshotKey).toBe(buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'edge-a'));
    expect(result.generationKey).toBe(
      buildTenantRuntimeRegistryGenerationKey('tenant-a', 'edge-a')
    );
    expect(result.snapshot).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        deploymentTarget: 'edge-a',
        runtimeGeneration: 7,
        storageProfileId: 'builtin:storage:tenant-d1',
        expiresAt: '2026-05-23T00:00:00.000Z',
      })
    );
    expect(result.snapshot.metadata.roles).toEqual(['tenant_core', 'tenant_pii']);
    expect(result.snapshot.stores).toHaveLength(2);
    expect(result.snapshot.stores[0]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        role: 'tenant_core',
        driver: 'd1',
        bindingRef: 'TDB_TENANT_A_1234_CORE',
        healthStatus: 'active',
      })
    );
    expect(result.snapshot.stores[0]).not.toHaveProperty('source');

    expect(snapshotStore.put).toHaveBeenNthCalledWith(
      1,
      result.snapshotKey,
      JSON.stringify(result.snapshot),
      { expirationTtl: DEFAULT_RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS }
    );
    expect(snapshotStore.put).toHaveBeenNthCalledWith(
      2,
      result.generationKey,
      JSON.stringify({
        runtimeGeneration: 7,
        publishedAt: '2026-05-16T00:00:00.000Z',
        expiresAt: '2026-05-23T00:00:00.000Z',
      }),
      { expirationTtl: DEFAULT_RUNTIME_REGISTRY_GENERATION_TTL_SECONDS }
    );
    expect(repository.upsertRuntimeCacheGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        cache_namespace: 'runtime_registry',
        generation: 7,
      })
    );
    expect(repository.upsertRuntimeRegistrySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        snapshot_scope: 'tenant',
        deployment_target: 'edge-a',
        runtime_generation: 7,
        object_ref: result.snapshotKey,
        signature: result.snapshot.metadata.signature,
        signature_key_id: 'runtime-registry-key-1',
      })
    );
    expect(repository.updateActivePointerStatus).not.toHaveBeenCalled();
    expect(repository.updateRegistryStatusAndMetadata).not.toHaveBeenCalled();
  });

  it('marks active pointers and registry rows degraded when snapshot publication fails', async () => {
    const repository = createRepository({});
    const { privateJwk } = await generateEd25519Jwks();
    const snapshotStore = {
      put: vi.fn(async () => {
        throw new Error('kv_unavailable');
      }),
    };

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        storageProfileId: 'builtin:storage:tenant-d1',
        repository,
        snapshotStore,
        actorId: 'system',
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
      })
    ).rejects.toThrow('kv_unavailable');

    expect(repository.updateActivePointerStatus).toHaveBeenCalledWith(
      'tenant-a',
      'tenant_core',
      'default',
      'degraded_pending_snapshot',
      'system',
      expect.stringContaining('kv_unavailable')
    );
    expect(repository.updateRegistryStatusAndMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
      }),
      'degraded_pending_snapshot',
      expect.stringContaining('kv_unavailable'),
      'system'
    );
    expect(repository.upsertRuntimeCacheGeneration).not.toHaveBeenCalled();
    expect(repository.upsertRuntimeRegistrySnapshot).not.toHaveBeenCalled();
  });

  it('clears degraded pending snapshot state after a successful retry', async () => {
    const repository = createRepository({
      pointers: [createPointer({ status: 'degraded_pending_snapshot' })],
      rows: [createRegistryRow({ status: 'degraded_pending_snapshot' })],
    });
    const snapshotStore = createSnapshotStore();
    const { privateJwk } = await generateEd25519Jwks();

    await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      storageProfileId: 'builtin:storage:tenant-d1',
      repository,
      snapshotStore,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
      signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
    });

    expect(repository.updateActivePointerStatus).toHaveBeenCalledWith(
      'tenant-a',
      'tenant_core',
      'default',
      'active',
      'system',
      null
    );
    expect(repository.updateRegistryStatusAndMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
      }),
      'active',
      null,
      'system'
    );
  });

  it('signs runtime registry snapshots with Ed25519 and verifies with public JWKS', async () => {
    const repository = createRepository({});
    const snapshotStore = createSnapshotStore();
    const { privateJwk, publicJwk } = await generateEd25519Jwks();

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      storageProfileId: 'builtin:storage:tenant-d1',
      repository,
      snapshotStore,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
      signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
    });

    expect(result.snapshot.metadata).toEqual(
      expect.objectContaining({
        signatureKeyId: 'runtime-registry-key-1',
        signatureAlgorithm: 'Ed25519',
        signedAt: '2026-05-16T00:00:00.000Z',
      })
    );
    expect(result.snapshot.metadata.signature).toEqual(expect.any(String));
    const keys = loadTenantRuntimeRegistryVerificationKeysFromEnv({
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    });
    await expect(verifyTenantRuntimeRegistrySnapshotSignature(result.snapshot, keys)).resolves.toBe(
      'valid'
    );

    const tampered = {
      ...result.snapshot,
      stores: [
        {
          ...result.snapshot.stores[0],
          bindingRef: 'TDB_TAMPERED_CORE',
        },
      ],
    };
    await expect(verifyTenantRuntimeRegistrySnapshotSignature(tampered, keys)).resolves.toBe(
      'invalid'
    );
  });

  it('supports an external snapshot signer contract for future KMS-backed signing', async () => {
    const repository = createRepository({});
    const snapshotStore = createSnapshotStore();
    const sign = vi.fn(async () => 'external-signature');

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      storageProfileId: 'builtin:storage:tenant-d1',
      repository,
      snapshotStore,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
      externalSigner: {
        keyId: 'kms-key-1',
        algorithm: 'Ed25519',
        sign,
      },
    });

    expect(sign).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(result.snapshot.metadata).toEqual(
      expect.objectContaining({
        signature: 'external-signature',
        signatureKeyId: 'kms-key-1',
        signatureAlgorithm: 'Ed25519',
        signedAt: '2026-05-16T00:00:00.000Z',
      })
    );
  });

  it('refuses to publish runtime snapshots to KV without a signer', async () => {
    const repository = createRepository({});
    const snapshotStore = createSnapshotStore();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        storageProfileId: 'builtin:storage:tenant-d1',
        repository,
        snapshotStore,
        actorId: 'system',
        now: new Date('2026-05-16T00:00:00.000Z'),
      })
    ).rejects.toThrow('runtime_registry_snapshot_signer_required');
    expect(snapshotStore.put).not.toHaveBeenCalled();
    expect(repository.updateActivePointerStatus).toHaveBeenCalledWith(
      'tenant-a',
      'tenant_core',
      'default',
      'degraded_pending_snapshot',
      'system',
      expect.stringContaining('runtime_registry_snapshot_signer_required')
    );
    expect(repository.updateRegistryStatusAndMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
      }),
      'degraded_pending_snapshot',
      expect.stringContaining('runtime_registry_snapshot_signer_required'),
      'system'
    );
    expect(repository.upsertRuntimeCacheGeneration).not.toHaveBeenCalled();
    expect(repository.upsertRuntimeRegistrySnapshot).not.toHaveBeenCalled();
  });

  it('rejects ambiguous snapshot signer configuration', async () => {
    const repository = createRepository({});
    const { privateJwk } = await generateEd25519Jwks();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        storageProfileId: 'builtin:storage:tenant-d1',
        repository,
        actorId: 'system',
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
        externalSigner: {
          keyId: 'kms-key-1',
          algorithm: 'Ed25519',
          sign: vi.fn(async () => 'external-signature'),
        },
      })
    ).rejects.toThrow('runtime_registry_snapshot_multiple_signers_configured');
  });

  it('fails when no active stores exist for a tenant snapshot', async () => {
    const repository = createRepository({ pointers: [], rows: [] });

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        storageProfileId: 'builtin:storage:tenant-d1',
        repository,
        now: new Date('2026-05-16T00:00:00.000Z'),
      })
    ).rejects.toThrow('tenant_runtime_registry_snapshot_no_active_stores:tenant-a');
  });

  it('purges runtime snapshot keys only with system admin break-glass confirmation', async () => {
    const snapshotStore = {
      delete: vi.fn(async () => undefined),
    };

    const result = await purgeTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      deploymentTarget: 'edge-a',
      snapshotStore,
      actorId: 'admin-1',
      actorRoles: ['system_admin'],
      breakGlassConfirmation: TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
      reason: 'stale generated binding after emergency rollback',
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    expect(snapshotStore.delete).toHaveBeenNthCalledWith(
      1,
      buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'edge-a')
    );
    expect(snapshotStore.delete).toHaveBeenNthCalledWith(
      2,
      buildTenantRuntimeRegistryGenerationKey('tenant-a', 'edge-a')
    );
    expect(result.auditEvent).toEqual(
      expect.objectContaining({
        action: 'tenant_runtime_registry_snapshot.emergency_purge',
        resourceType: 'tenant_runtime_registry_snapshot',
        resourceId: buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'edge-a'),
        result: 'success',
      })
    );
    expect(result.auditEvent.metadata).toEqual(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        actor_id: 'admin-1',
        break_glass: true,
      })
    );
  });

  it('rejects runtime snapshot purge without system admin or confirmation', async () => {
    const snapshotStore = {
      delete: vi.fn(async () => undefined),
    };

    await expect(
      purgeTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        snapshotStore,
        actorId: 'admin-1',
        actorRoles: ['org_admin'],
        breakGlassConfirmation: TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
        reason: 'operator requested',
      })
    ).rejects.toThrow('tenant_runtime_registry_purge_requires_system_admin');
    await expect(
      purgeTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        snapshotStore,
        actorId: 'admin-1',
        actorRoles: ['system_admin'],
        breakGlassConfirmation: 'PURGE',
        reason: 'operator requested',
      })
    ).rejects.toThrow('tenant_runtime_registry_purge_requires_break_glass_confirmation');
    expect(snapshotStore.delete).not.toHaveBeenCalled();
  });
});
