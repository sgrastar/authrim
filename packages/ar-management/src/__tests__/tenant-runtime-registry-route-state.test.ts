import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRepository,
  mockTransitionTenantRuntimeRegistryRouteState,
  mockPublishTenantRuntimeRegistrySnapshot,
  mockVerifyTenantRuntimeRegistrySnapshotSignature,
  mockCreateControlRuntimeRegistrySigner,
} = vi.hoisted(() => ({
  mockRepository: {},
  mockTransitionTenantRuntimeRegistryRouteState: vi.fn(),
  mockPublishTenantRuntimeRegistrySnapshot: vi.fn(),
  mockVerifyTenantRuntimeRegistrySnapshotSignature: vi.fn(),
  mockCreateControlRuntimeRegistrySigner: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: vi.fn(() => ({})),
    TenantDatabaseRegistryRepository: class {
      constructor() {
        return mockRepository;
      }
    },
    transitionTenantRuntimeRegistryRouteState: mockTransitionTenantRuntimeRegistryRouteState,
    publishTenantRuntimeRegistrySnapshot: mockPublishTenantRuntimeRegistrySnapshot,
    loadTenantRuntimeRegistryVerificationKeysFromEnv: vi.fn(() => []),
    verifyTenantRuntimeRegistrySnapshotSignature: mockVerifyTenantRuntimeRegistrySnapshotSignature,
  };
});

vi.mock('../control-runtime-registry-signer', () => ({
  createControlRuntimeRegistrySigner: mockCreateControlRuntimeRegistrySigner,
}));

import { publishTenantRuntimeRegistryRouteState } from '../tenant-runtime-registry-route-state';

describe('tenant runtime registry route state', () => {
  const now = new Date('2026-05-16T00:00:00.000Z');
  const snapshot = {
    version: 2,
    tenantId: 'tenant-a',
    snapshotScope: 'tenant',
    deploymentTarget: 'edge-a',
    runtimeGeneration: 8,
    routeStatus: 'quarantining',
    quarantineDenyGeneration: 1,
    storageProfileId: 'builtin:storage:tenant-d1',
    publishedAt: now.toISOString(),
    expiresAt: '2026-05-16T00:30:00.000Z',
    stores: [],
    metadata: {
      storeCount: 0,
      roles: [],
      signature: 'header.payload.signature',
      signatureKeyId: 'runtime-key-1',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransitionTenantRuntimeRegistryRouteState.mockResolvedValue({
      runtimeGeneration: 8,
      routeStatus: 'quarantining',
      quarantineDenyGeneration: 1,
      changed: true,
    });
    mockPublishTenantRuntimeRegistrySnapshot.mockResolvedValue({
      snapshot,
      snapshotKey: 'snapshot-key',
      generationKey: 'generation-key',
    });
    mockVerifyTenantRuntimeRegistrySnapshotSignature.mockResolvedValue('valid');
    mockCreateControlRuntimeRegistrySigner.mockResolvedValue({ sign: vi.fn() });
  });

  it('requires matching generation and signed snapshot read-back', async () => {
    const store = {
      get: vi.fn(async (key: string) =>
        key.includes(':generation:')
          ? JSON.stringify({
              runtimeGeneration: 8,
              routeStatus: 'quarantining',
              quarantineDenyGeneration: 1,
              publishedAt: now.toISOString(),
              expiresAt: '2026-05-23T00:00:00.000Z',
            })
          : JSON.stringify(snapshot)
      ),
    };

    await expect(
      publishTenantRuntimeRegistryRouteState(
        {
          DB_ADMIN: {},
          TENANT_RUNTIME_REGISTRY: store,
          TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        } as never,
        {
          tenantId: 'tenant-a',
          routeStatus: 'quarantining',
          operationId: 'job-1',
          actorId: 'job-1',
          now,
        }
      )
    ).resolves.toEqual({
      runtimeGeneration: 8,
      routeStatus: 'quarantining',
      quarantineDenyGeneration: 1,
      changed: true,
      publishedAt: now.toISOString(),
    });
    expect(mockVerifyTenantRuntimeRegistrySnapshotSignature).toHaveBeenCalledOnce();
  });

  it('fails closed when KV read-back does not expose the expected deny generation', async () => {
    const store = {
      get: vi.fn(async (key: string) =>
        key.includes(':generation:')
          ? JSON.stringify({
              runtimeGeneration: 8,
              routeStatus: 'active',
              quarantineDenyGeneration: 0,
            })
          : JSON.stringify(snapshot)
      ),
    };

    await expect(
      publishTenantRuntimeRegistryRouteState(
        {
          DB_ADMIN: {},
          TENANT_RUNTIME_REGISTRY: store,
          AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
        } as never,
        {
          tenantId: 'tenant-a',
          routeStatus: 'quarantining',
          operationId: 'job-1',
          actorId: 'job-1',
          now,
        }
      )
    ).rejects.toThrow('tenant_runtime_registry_route_state_generation_invalid');
  });
});
