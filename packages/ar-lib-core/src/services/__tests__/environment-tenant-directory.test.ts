import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createIndex: vi.fn(),
  loadAssignments: vi.fn(),
  resolveAliases: vi.fn(),
  resolveStore: vi.fn(),
}));

vi.mock('../lookup-directory/blind-index', () => ({
  createLookupAliasIndex: mocks.createIndex,
}));

vi.mock('../lookup-directory/shard-registry', () => ({
  loadVerifiedLookupBucketAssignmentProvider: mocks.loadAssignments,
}));

vi.mock('../lookup-directory/resolver', () => ({
  LookupRouteResolver: class {
    resolveAliases(input: unknown) {
      return mocks.resolveAliases(input);
    }
  },
}));

vi.mock('../tenant-database-resolver', () => ({
  resolveTenantDatabaseSourceFromRegistry: mocks.resolveStore,
}));

import { listEnvironmentTenantDefaultStores } from '../environment-tenant-directory';

const projection = {
  schemaVersion: 1,
  tenantRouteGeneration: 7,
  residencyPolicyId: 'residency-default',
  target: {
    dataRole: 'tenant_core/default' as const,
    residencyPartition: 'default',
    shardId: 'tenant-default-1',
    bindingRef: 'TDB_TENANT_DEFAULT_0001',
    requiredBindingRouteGeneration: 7,
  },
};

function env() {
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY: {},
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
  } as never;
}

function store(
  tenantId: string,
  overrides: Record<string, unknown> = {},
  queryOne = vi.fn(async () => ({ id: tenantId }))
) {
  const source = {
    query: vi.fn(async () => []),
    queryOne,
    execute: vi.fn(async () => ({ success: true, rowsAffected: 0 })),
    transaction: vi.fn(),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async () => ({ healthy: true, latencyMs: 0, type: 'test' })),
    getType: vi.fn(() => 'test'),
    close: vi.fn(async () => undefined),
  };
  return {
    bindingRouteGeneration: 7,
    residencyPolicyId: 'residency-default',
    residencyPartition: 'default',
    shardId: 'tenant-default-1',
    bindingRef: 'TDB_TENANT_DEFAULT_0001',
    source,
    ...overrides,
  };
}

describe('listEnvironmentTenantDefaultStores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createIndex.mockResolvedValue({
      aliasKind: 'environment_tenant',
      digest: 'a'.repeat(64),
      virtualBucket: 1,
    });
    mocks.loadAssignments.mockResolvedValue({});
    mocks.resolveAliases.mockResolvedValue([{ tenantId: 'tenant-a', routeProjection: projection }]);
    mocks.resolveStore.mockImplementation(async (_env, input: { tenantId: string }) =>
      store(input.tenantId)
    );
  });

  it('forwards the bounded cursor and revalidates each exact tenant destination', async () => {
    await expect(
      listEnvironmentTenantDefaultStores(env(), {
        limit: 32,
        afterTenantId: 'tenant-previous',
        concurrency: 2,
      })
    ).resolves.toMatchObject([
      { tenantId: 'tenant-a', store: { bindingRef: 'TDB_TENANT_DEFAULT_0001' } },
    ]);

    expect(mocks.createIndex).toHaveBeenCalledWith('environment_tenant', 'test');
    expect(mocks.resolveAliases).toHaveBeenCalledWith(
      expect.objectContaining({ maximumResults: 32, afterTenantId: 'tenant-previous' })
    );
    expect(mocks.resolveStore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        shardGroup: 'default',
        shardIndex: 0,
      })
    );
  });

  it('fails closed when the signed directory configuration is unavailable', async () => {
    await expect(listEnvironmentTenantDefaultStores({} as never, { limit: 1 })).rejects.toThrow(
      'environment_tenant_directory_unavailable'
    );
    expect(mocks.resolveAliases).not.toHaveBeenCalled();
  });

  it.each([0, 129, 1.5])('rejects an invalid page limit %s', async (limit) => {
    await expect(listEnvironmentTenantDefaultStores(env(), { limit })).rejects.toThrow(
      'environment_tenant_directory_limit_invalid'
    );
  });

  it.each([0, 9, 1.5])('rejects an invalid fanout concurrency %s', async (concurrency) => {
    await expect(
      listEnvironmentTenantDefaultStores(env(), { limit: 1, concurrency })
    ).rejects.toThrow('environment_tenant_directory_concurrency_invalid');
  });

  it('rejects an alias route that is ahead of the signed Registry route', async () => {
    mocks.resolveAliases.mockResolvedValue([
      {
        tenantId: 'tenant-a',
        routeProjection: { ...projection, tenantRouteGeneration: 8 },
      },
    ]);

    await expect(listEnvironmentTenantDefaultStores(env(), { limit: 1 })).rejects.toThrow(
      'environment_tenant_alias_route_revalidation_failed'
    );
  });

  it('rejects an inactive or cross-tenant destination row', async () => {
    mocks.resolveStore.mockResolvedValue(
      store(
        'tenant-a',
        {},
        vi.fn(async () => null)
      )
    );

    await expect(listEnvironmentTenantDefaultStores(env(), { limit: 1 })).rejects.toThrow(
      'environment_tenant_alias_destination_revalidation_failed'
    );
  });

  it('never exceeds the requested destination fanout concurrency', async () => {
    const aliases = Array.from({ length: 7 }, (_, index) => ({
      tenantId: `tenant-${index}`,
      routeProjection: projection,
    }));
    mocks.resolveAliases.mockResolvedValue(aliases);
    let active = 0;
    let maximumActive = 0;
    mocks.resolveStore.mockImplementation(async (_env, input: { tenantId: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return store(input.tenantId);
    });

    const result = await listEnvironmentTenantDefaultStores(env(), {
      limit: 7,
      concurrency: 3,
    });
    expect(result).toHaveLength(7);
    expect(maximumActive).toBeLessThanOrEqual(3);
  });
});
