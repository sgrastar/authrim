import { describe, expect, it, vi } from 'vitest';
import { decodeProtectedHeader } from 'jose';
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
  signRuntimeRegistrySnapshotPayloadJws,
  transitionTenantRuntimeRegistryRouteState,
  reactivateTenantRuntimeRegistryRouteState,
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
  const role = overrides.role ?? 'tenant_core';
  const shardGroup = overrides.shard_group ?? 'default';
  return {
    tenant_id: 'tenant-a',
    role,
    generation: 2,
    shard_group: shardGroup,
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
    metadata_json: JSON.stringify({
      control_data_role:
        role === 'tenant_pii'
          ? 'tenant_pii'
          : shardGroup === 'default'
            ? 'tenant_core/default'
            : 'tenant_core/users',
      control_residency_policy_id: 'builtin:residency:default',
      control_residency_partition: 'default',
      control_shard_id: `shard-${role}-${shardGroup}`,
      control_assignment_generation: 7,
      control_allocation_scope: 'tenant_exclusive',
      control_owner_tenant_id: 'tenant-a',
      control_placement_policy_generation: 7,
    }),
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
  runtimeCacheGeneration?: {
    generation: number;
    metadata_json: string | null;
  } | null;
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
    getRuntimeCacheGeneration: vi.fn(async () => {
      if (options.runtimeCacheGeneration === undefined) return null;
      if (options.runtimeCacheGeneration === null) return null;
      return {
        tenant_id: 'tenant-a',
        cache_namespace: 'runtime_registry' as const,
        generation: options.runtimeCacheGeneration.generation,
        updated_at: '2026-05-16T00:00:00.000Z',
        updated_by: 'system',
        metadata_json: options.runtimeCacheGeneration.metadata_json,
      };
    }),
    commitRuntimeCacheGenerationPublication: vi.fn(async () => true),
    compareAndSetRuntimeCacheGeneration: vi.fn(async () => true),
    upsertRuntimeRegistrySnapshot: vi.fn(async () => ({
      tenant_id: 'tenant-a',
      snapshot_scope: 'tenant',
      deployment_target: 'edge-a',
      runtime_generation: 7,
      backend_provider: 'd1',
      placement_policy: 'tenant_exclusive',
      placement_policy_generation: 7,
      snapshot_version: 4,
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
    getRuntimeCacheGeneration: ReturnType<typeof vi.fn>;
    commitRuntimeCacheGenerationPublication: ReturnType<typeof vi.fn>;
    compareAndSetRuntimeCacheGeneration: ReturnType<typeof vi.fn>;
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
  privateJwk.alg = 'EdDSA';
  privateJwk.use = 'sig';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
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
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
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
        routeStatus: 'active',
        quarantineDenyGeneration: 0,
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        expiresAt: '2026-05-16T00:30:00.000Z',
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
        routeStatus: 'active',
        quarantineDenyGeneration: 0,
        publishedAt: '2026-05-16T00:00:00.000Z',
        expiresAt: '2026-05-23T00:00:00.000Z',
      }),
      { expirationTtl: DEFAULT_RUNTIME_REGISTRY_GENERATION_TTL_SECONDS }
    );
    expect(repository.commitRuntimeCacheGenerationPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        cache_namespace: 'runtime_registry',
        generation: 7,
      }),
      null
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

  it('publishes shared-pool ownership metadata and rejects placement drift', async () => {
    const sharedMetadata = JSON.stringify({
      control_data_role: 'tenant_core/default',
      control_residency_policy_id: 'builtin:residency:default',
      control_residency_partition: 'default',
      control_shard_id: 'shared-core-default',
      control_assignment_generation: 7,
      control_allocation_scope: 'shared_pool',
      control_owner_tenant_id: null,
      control_placement_policy_generation: 9,
    });
    const repository = createRepository({
      rows: [createRegistryRow({ metadata_json: sharedMetadata })],
    });
    const { privateJwk } = await generateEd25519Jwks();

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      placement: { isolationPolicy: 'shared_pool', policyGeneration: 9 },
      deploymentTarget: 'edge-a',
      repository,
      now: new Date('2026-05-16T00:00:00.000Z'),
      signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
    });

    expect(result.snapshot.stores[0]).toMatchObject({
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      placementPolicyGeneration: 9,
    });
    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 9 },
        deploymentTarget: 'edge-a',
        repository,
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
      })
    ).rejects.toThrow('tenant_runtime_registry_snapshot_placement_mismatch');
  });

  it('rejects a snapshot assembled from mixed active runtime generations', async () => {
    const repository = createRepository({
      pointers: [
        createPointer({ role: 'tenant_core', runtime_generation: 7 }),
        createPointer({ role: 'tenant_pii', generation: 3, runtime_generation: 8 }),
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
    const { privateJwk } = await generateEd25519Jwks();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        deploymentTarget: 'edge-a',
        repository,
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
      })
    ).rejects.toThrow('tenant_runtime_registry_snapshot_generation_mismatch');
  });

  it('rejects a snapshot whose Core and PII routes share a physical D1 database', async () => {
    const repository = createRepository({
      pointers: [
        createPointer({ role: 'tenant_core', runtime_generation: 7 }),
        createPointer({ role: 'tenant_pii', generation: 3, runtime_generation: 7 }),
      ],
      rows: [
        createRegistryRow({ role: 'tenant_core', database_id: 'shared-physical-db-id' }),
        createRegistryRow({
          role: 'tenant_pii',
          generation: 3,
          database_id: 'shared-physical-db-id',
          database_name: 'authrim-dev-tenant-a-pii',
          binding_ref: 'TDB_TENANT_A_1234_PII',
        }),
      ],
    });
    const { privateJwk } = await generateEd25519Jwks();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        deploymentTarget: 'edge-a',
        repository,
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
      })
    ).rejects.toThrow('tenant_runtime_registry_snapshot_pii_isolation_violation');
  });

  it('transitions active routes to quarantining with a monotonic deny generation', async () => {
    const repository = createRepository({
      runtimeCacheGeneration: {
        generation: 7,
        metadata_json: JSON.stringify({
          route_status: 'active',
          quarantine_deny_generation: 0,
        }),
      },
    });

    await expect(
      transitionTenantRuntimeRegistryRouteState(repository, {
        tenantId: 'tenant-a',
        routeStatus: 'quarantining',
        operationId: 'tenant-delete:job-1',
        actorId: 'job-1',
        now: new Date('2026-05-16T00:00:00.000Z'),
      })
    ).resolves.toEqual({
      routeStatus: 'quarantining',
      quarantineDenyGeneration: 1,
      runtimeGeneration: 8,
      changed: true,
    });
    expect(repository.compareAndSetRuntimeCacheGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 8,
        metadata_json: expect.stringContaining('tenant-delete:job-1'),
      }),
      expect.objectContaining({ generation: 7 })
    );
  });

  it('rejects route-state takeover by a different operation', async () => {
    const repository = createRepository({
      runtimeCacheGeneration: {
        generation: 8,
        metadata_json: JSON.stringify({
          route_status: 'quarantining',
          quarantine_deny_generation: 1,
          route_state_operation_id: 'tenant-delete:job-1',
        }),
      },
    });

    await expect(
      transitionTenantRuntimeRegistryRouteState(repository, {
        tenantId: 'tenant-a',
        routeStatus: 'quarantining',
        operationId: 'tenant-delete:job-2',
        actorId: 'job-2',
      })
    ).rejects.toThrow('runtime_registry_route_state_operation_conflict');
    expect(repository.compareAndSetRuntimeCacheGeneration).not.toHaveBeenCalled();
  });

  it('reactivates only the same DR operation and preserves the deny generation', async () => {
    const repository = createRepository({
      runtimeCacheGeneration: {
        generation: 12,
        metadata_json: JSON.stringify({
          route_status: 'quarantined',
          quarantine_deny_generation: 4,
          route_state_operation_id: 'tenant-dr:operation-1',
        }),
      },
    });

    await expect(
      reactivateTenantRuntimeRegistryRouteState(repository, {
        tenantId: 'tenant-a',
        operationId: 'tenant-dr:operation-1',
        actorId: 'admin-a',
        expectedQuarantineDenyGeneration: 4,
        now: new Date('2026-05-16T00:30:00.000Z'),
      })
    ).resolves.toEqual({
      routeStatus: 'active',
      quarantineDenyGeneration: 4,
      runtimeGeneration: 13,
      changed: true,
    });
    expect(repository.compareAndSetRuntimeCacheGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 13,
        metadata_json: expect.stringContaining('route_state_reactivated_at'),
      }),
      expect.objectContaining({ generation: 12 })
    );
  });

  it('rejects DR reactivation with another operation or deny generation', async () => {
    const repository = createRepository({
      runtimeCacheGeneration: {
        generation: 12,
        metadata_json: JSON.stringify({
          route_status: 'quarantined',
          quarantine_deny_generation: 4,
          route_state_operation_id: 'tenant-dr:operation-1',
        }),
      },
    });

    await expect(
      reactivateTenantRuntimeRegistryRouteState(repository, {
        tenantId: 'tenant-a',
        operationId: 'tenant-dr:operation-2',
        actorId: 'admin-a',
        expectedQuarantineDenyGeneration: 4,
      })
    ).rejects.toThrow('runtime_registry_route_state_reactivation_not_allowed');
    await expect(
      reactivateTenantRuntimeRegistryRouteState(repository, {
        tenantId: 'tenant-a',
        operationId: 'tenant-dr:operation-1',
        actorId: 'admin-a',
        expectedQuarantineDenyGeneration: 5,
      })
    ).rejects.toThrow('runtime_registry_route_state_reactivation_not_allowed');
    expect(repository.compareAndSetRuntimeCacheGeneration).not.toHaveBeenCalled();
  });

  it('marks active pointers and registry rows degraded when snapshot publication fails', async () => {
    const pointerMetadata = JSON.stringify({ operator_note: 'keep-pointer-metadata' });
    const row = createRegistryRow();
    const repository = createRepository({
      pointers: [createPointer({ metadata_json: pointerMetadata })],
      rows: [row],
    });
    const { privateJwk } = await generateEd25519Jwks();
    const snapshotStore = {
      put: vi.fn(async () => {
        throw new Error('kv_unavailable');
      }),
    };

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
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
    const pointerUpdate = repository.updateActivePointerStatus.mock.calls[0];
    expect(JSON.parse(pointerUpdate[5] as string)).toEqual(
      expect.objectContaining({
        operator_note: 'keep-pointer-metadata',
        snapshot_publish_error: 'kv_unavailable',
      })
    );
    const registryUpdate = repository.updateRegistryStatusAndMetadata.mock.calls[0];
    expect(JSON.parse(registryUpdate[2] as string)).toEqual(
      expect.objectContaining({
        control_data_role: 'tenant_core/default',
        control_shard_id: 'shard-tenant_core-default',
        snapshot_publish_error: 'kv_unavailable',
      })
    );
    expect(repository.commitRuntimeCacheGenerationPublication).not.toHaveBeenCalled();
    expect(repository.upsertRuntimeRegistrySnapshot).not.toHaveBeenCalled();
  });

  it('clears degraded pending snapshot state after a successful retry', async () => {
    const rowMetadata = {
      ...JSON.parse(createRegistryRow().metadata_json as string),
      snapshot_publish_error: 'kv_unavailable',
      snapshot_publish_failed_at: '2026-05-15T23:59:00.000Z',
    };
    const repository = createRepository({
      pointers: [
        createPointer({
          status: 'degraded_pending_snapshot',
          metadata_json: JSON.stringify({
            operator_note: 'keep-pointer-metadata',
            snapshot_publish_error: 'kv_unavailable',
            snapshot_publish_failed_at: '2026-05-15T23:59:00.000Z',
          }),
        }),
      ],
      rows: [
        createRegistryRow({
          status: 'degraded_pending_snapshot',
          metadata_json: JSON.stringify(rowMetadata),
        }),
      ],
    });
    const snapshotStore = createSnapshotStore();
    const { privateJwk } = await generateEd25519Jwks();

    await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
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
      JSON.stringify({ operator_note: 'keep-pointer-metadata' })
    );
    expect(repository.updateRegistryStatusAndMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
      }),
      'active',
      expect.any(String),
      'system'
    );
    const registryUpdate = repository.updateRegistryStatusAndMetadata.mock.calls[0];
    expect(JSON.parse(registryUpdate[2] as string)).toEqual(
      expect.objectContaining({
        control_data_role: 'tenant_core/default',
        control_shard_id: 'shard-tenant_core-default',
      })
    );
    expect(JSON.parse(registryUpdate[2] as string)).not.toHaveProperty('snapshot_publish_error');
    expect(JSON.parse(registryUpdate[2] as string)).not.toHaveProperty(
      'snapshot_publish_failed_at'
    );
  });

  it('marks registry state degraded when the Control DB snapshot record fails after publication', async () => {
    const repository = createRepository({});
    repository.upsertRuntimeRegistrySnapshot.mockRejectedValueOnce(
      new Error('control_snapshot_record_unavailable')
    );
    const { privateJwk } = await generateEd25519Jwks();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        deploymentTarget: 'edge-a',
        repository,
        snapshotStore: createSnapshotStore(),
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
      })
    ).rejects.toThrow('control_snapshot_record_unavailable');
    expect(repository.updateActivePointerStatus).toHaveBeenCalledWith(
      'tenant-a',
      'tenant_core',
      'default',
      'degraded_pending_snapshot',
      null,
      expect.stringContaining('control_snapshot_record_unavailable')
    );
    expect(repository.updateRegistryStatusAndMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-a', role: 'tenant_core' }),
      'degraded_pending_snapshot',
      expect.stringContaining('control_snapshot_record_unavailable'),
      null
    );
  });

  it('signs runtime registry snapshots with Ed25519 and verifies with public JWKS', async () => {
    const repository = createRepository({});
    const snapshotStore = createSnapshotStore();
    const { privateJwk, publicJwk } = await generateEd25519Jwks();

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
      repository,
      snapshotStore,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
      signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
    });

    expect(result.snapshot.metadata).toEqual(
      expect.objectContaining({
        signatureKeyId: 'runtime-registry-key-1',
        signatureAlgorithm: 'EdDSA',
        signedAt: '2026-05-16T00:00:00.000Z',
      })
    );
    expect(result.snapshot.metadata.signature).toEqual(expect.any(String));
    expect(decodeProtectedHeader(result.snapshot.metadata.signature!)).toEqual({
      alg: 'EdDSA',
      typ: 'authrim-runtime-registry+jws',
      kid: 'runtime-registry-key-1',
    });
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
    const { privateJwk } = await generateEd25519Jwks('kms-key-1');
    const sign = vi.fn((payload: Uint8Array) =>
      signRuntimeRegistrySnapshotPayloadJws({ payload, privateJwk, keyId: 'kms-key-1' })
    );

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
      repository,
      snapshotStore,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
      externalSigner: {
        keyId: 'kms-key-1',
        algorithm: 'EdDSA',
        type: 'authrim-runtime-registry+jws',
        sign,
      },
    });

    expect(sign).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(result.snapshot.metadata).toEqual(
      expect.objectContaining({
        signature: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/u),
        signatureKeyId: 'kms-key-1',
        signatureAlgorithm: 'EdDSA',
        signedAt: '2026-05-16T00:00:00.000Z',
      })
    );
  });

  it('rejects private, duplicate, and malformed runtime verification JWKS', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();

    expect(() =>
      loadTenantRuntimeRegistryVerificationKeysFromEnv({
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [privateJwk] }),
      })
    ).toThrow('runtime_registry_snapshot_verification_jwk_invalid');
    expect(() =>
      loadTenantRuntimeRegistryVerificationKeysFromEnv({
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({
          keys: [publicJwk, publicJwk],
        }),
      })
    ).toThrow('runtime_registry_snapshot_verification_jwk_duplicate');
    expect(() =>
      loadTenantRuntimeRegistryVerificationKeysFromEnv({
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: 'null',
      })
    ).toThrow('runtime_registry_snapshot_verification_jwks_invalid');
  });

  it('refuses to publish runtime snapshots to KV without a signer', async () => {
    const repository = createRepository({});
    const snapshotStore = createSnapshotStore();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
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
    expect(repository.commitRuntimeCacheGenerationPublication).not.toHaveBeenCalled();
    expect(repository.upsertRuntimeRegistrySnapshot).not.toHaveBeenCalled();
  });

  it('rejects a raw external signature instead of accepting a non-JWS fallback', async () => {
    const repository = createRepository({});
    const snapshotStore = createSnapshotStore();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        repository,
        snapshotStore,
        externalSigner: {
          keyId: 'kms-key-1',
          algorithm: 'EdDSA',
          type: 'authrim-runtime-registry+jws',
          sign: vi.fn(async () => 'raw-signature'),
        },
      })
    ).rejects.toThrow('runtime_registry_snapshot_jws_invalid');
    expect(snapshotStore.put).not.toHaveBeenCalled();
  });

  it('rejects ambiguous snapshot signer configuration', async () => {
    const repository = createRepository({});
    const { privateJwk } = await generateEd25519Jwks();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        repository,
        actorId: 'system',
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
        externalSigner: {
          keyId: 'kms-key-1',
          algorithm: 'EdDSA',
          type: 'authrim-runtime-registry+jws',
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
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        repository,
        now: new Date('2026-05-16T00:00:00.000Z'),
      })
    ).rejects.toThrow('tenant_runtime_registry_snapshot_no_active_stores:tenant-a');
  });

  it('publishes a signed deny snapshot without active stores for quarantined tenants', async () => {
    const repository = createRepository({
      pointers: [],
      rows: [],
      runtimeCacheGeneration: {
        generation: 9,
        metadata_json: JSON.stringify({
          route_status: 'quarantined',
          quarantine_deny_generation: 3,
          quarantine_reason: 'tenant_delete',
        }),
      },
    });
    const snapshotStore = createSnapshotStore();
    const { privateJwk } = await generateEd25519Jwks();

    const result = await publishTenantRuntimeRegistrySnapshot({
      tenantId: 'tenant-a',
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
      repository,
      snapshotStore,
      now: new Date('2026-05-16T00:00:00.000Z'),
      signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
    });

    expect(result.snapshot).toEqual(
      expect.objectContaining({
        version: 4,
        runtimeGeneration: 9,
        routeStatus: 'quarantined',
        quarantineDenyGeneration: 3,
        stores: [],
      })
    );
    expect(snapshotStore.put.mock.calls[0]?.[0]).toBe(result.generationKey);
    expect(snapshotStore.put.mock.calls[1]?.[0]).toBe(result.snapshotKey);
    expect(repository.commitRuntimeCacheGenerationPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 9,
        metadata_json: expect.stringContaining('tenant_delete'),
      }),
      expect.objectContaining({ generation: 9 })
    );
  });

  it('refuses malformed persisted route state instead of silently reactivating it', async () => {
    const repository = createRepository({
      runtimeCacheGeneration: {
        generation: 9,
        metadata_json: JSON.stringify({
          route_status: 'quarantined',
          quarantine_deny_generation: 0,
        }),
      },
    });

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        repository,
      })
    ).rejects.toThrow('runtime_registry_quarantine_deny_generation_invalid');
    expect(repository.commitRuntimeCacheGenerationPublication).not.toHaveBeenCalled();
  });

  it('repairs lightweight deny state when an active publication loses its state CAS', async () => {
    const repository = createRepository({});
    const quarantinedRow = {
      tenant_id: 'tenant-a',
      cache_namespace: 'runtime_registry' as const,
      generation: 8,
      updated_at: '2026-05-16T00:00:01.000Z',
      updated_by: 'admin-1',
      metadata_json: JSON.stringify({
        route_status: 'quarantining',
        quarantine_deny_generation: 1,
      }),
    };
    repository.getRuntimeCacheGeneration
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(quarantinedRow);
    repository.commitRuntimeCacheGenerationPublication.mockResolvedValueOnce(false);
    const snapshotStore = createSnapshotStore();
    const { privateJwk } = await generateEd25519Jwks();

    await expect(
      publishTenantRuntimeRegistrySnapshot({
        tenantId: 'tenant-a',
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        deploymentTarget: 'edge-a',
        repository,
        snapshotStore,
        now: new Date('2026-05-16T00:00:00.000Z'),
        signingKey: { privateJwk, keyId: 'runtime-registry-key-1' },
      })
    ).rejects.toThrow('tenant_runtime_registry_snapshot_stale_publication');

    const repairedGeneration = JSON.parse(String(snapshotStore.put.mock.calls[2]?.[1]));
    expect(repairedGeneration).toEqual(
      expect.objectContaining({
        runtimeGeneration: 8,
        routeStatus: 'quarantining',
        quarantineDenyGeneration: 1,
      })
    );
    expect(repository.upsertRuntimeRegistrySnapshot).not.toHaveBeenCalled();
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
