import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  getRegistryRow: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => ({})),
    resolveTenantDatabaseSourceFromRegistry: mocks.resolve,
    TenantDatabaseRegistryRepository: vi.fn(function MockRegistryRepository() {
      return { getRegistryRow: mocks.getRegistryRow };
    }),
  };
});

import { resolveActiveTenantRuntimeRouteObservation } from '../admin-tenants';

const targets = [
  {
    role: 'tenant_core',
    shardGroup: 'default',
    dataRole: 'tenant_core/default',
    bindingRef: 'TDB_DEFAULT_ROUTE',
    shardId: 'shard-default',
  },
  {
    role: 'tenant_core',
    shardGroup: 'users',
    dataRole: 'tenant_core/users',
    bindingRef: 'TDB_USERS_ROUTE',
    shardId: 'shard-users',
  },
  {
    role: 'tenant_pii',
    shardGroup: 'default',
    dataRole: 'tenant_pii',
    bindingRef: 'TDB_PII_ROUTE',
    shardId: 'shard-pii',
  },
] as const;

interface RuntimeRouteInput {
  tenantId: string;
  role: 'tenant_core' | 'tenant_pii';
  shardGroup: 'default' | 'users';
}

interface RegistryRouteKey {
  tenant_id: string;
  role: 'tenant_core' | 'tenant_pii';
  generation: number;
  shard_group: 'default' | 'users';
  shard_index: number;
}

describe('active tenant runtime route observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockImplementation(async (_env: unknown, input: RuntimeRouteInput) => {
      const target = targets.find(
        (candidate) => candidate.role === input.role && candidate.shardGroup === input.shardGroup
      );
      if (!target) throw new Error('unexpected_target');
      return {
        tenantId: input.tenantId,
        role: input.role,
        generation: 7,
        runtimeGeneration: 7,
        schemaVersion: 1,
        shardGroup: input.shardGroup,
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        driver: 'd1',
        bindingRef: target.bindingRef,
        deploymentTarget: 'test',
        healthStatus: 'active',
        registryRow: { metadata_json: null },
      };
    });
    mocks.getRegistryRow.mockImplementation(async (key: RegistryRouteKey) => {
      const target = targets.find(
        (candidate) => candidate.role === key.role && candidate.shardGroup === key.shard_group
      );
      if (!target) return null;
      return {
        tenant_id: key.tenant_id,
        role: key.role,
        generation: key.generation,
        shard_group: key.shard_group,
        shard_index: key.shard_index,
        status: 'active',
        binding_ref: target.bindingRef,
        metadata_json: JSON.stringify({
          control_data_role: target.dataRole,
          control_shard_id: target.shardId,
        }),
      };
    });
  });

  it('combines signed runtime binding evidence with the matching authoritative registry row', async () => {
    await expect(
      resolveActiveTenantRuntimeRouteObservation({} as never, 'tenant-route')
    ).resolves.toEqual({
      runtimeGeneration: 7,
      registryPublicationGeneration: 7,
      tenantLifecycleState: 'active',
      routeStatus: 'active',
      targets: targets.map((target) => ({
        dataRole: target.dataRole,
        shardId: target.shardId,
        bindingRef: target.bindingRef,
        generation: 7,
      })),
    });
  });

  it('fails closed when the authoritative row does not match the signed binding', async () => {
    mocks.getRegistryRow.mockResolvedValueOnce({
      tenant_id: 'tenant-route',
      role: 'tenant_core',
      generation: 7,
      shard_group: 'default',
      shard_index: 0,
      status: 'active',
      binding_ref: 'TDB_WRONG_ROUTE',
      metadata_json: JSON.stringify({
        control_data_role: 'tenant_core/default',
        control_shard_id: 'shard-default',
      }),
    });

    await expect(
      resolveActiveTenantRuntimeRouteObservation({} as never, 'tenant-route')
    ).rejects.toThrow('tenant_runtime_registry_route_observation_registry_mismatch');
  });
});
