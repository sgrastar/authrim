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

vi.mock('../tenant-database-resolver', async () => {
  const actual = await vi.importActual<typeof import('../tenant-database-resolver')>(
    '../tenant-database-resolver'
  );
  return {
    TenantDatabaseResolverError: actual.TenantDatabaseResolverError,
    resolveTenantDatabaseSourceFromRegistry: mocks.resolveStore,
  };
});

import { listEnvironmentTenantDefaultStores } from '../environment-tenant-directory';
import { TenantDatabaseResolverError } from '../tenant-database-resolver';

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
  queryOne = vi.fn(async () => ({ id: tenantId, lifecycle_state: 'active' }))
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

  it('rejects a missing or cross-tenant destination row', async () => {
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

  describe('non-active tenants', () => {
    const alias = (tenantId: string) => ({ tenantId, routeProjection: projection });
    const stateOf =
      (states: Record<string, string>) => async (_env: unknown, input: { tenantId: string }) =>
        store(
          input.tenantId,
          {},
          vi.fn(async () => ({ id: input.tenantId, lifecycle_state: states[input.tenantId] }))
        );

    it('returns an active tenant with its lifecycle state', async () => {
      await expect(listEnvironmentTenantDefaultStores(env(), { limit: 1 })).resolves.toMatchObject([
        { tenantId: 'tenant-a', lifecycleState: 'active' },
      ]);
    });

    it('queries the row without filtering on the lifecycle state', async () => {
      const queryOne = vi.fn(async () => ({ id: 'tenant-a', lifecycle_state: 'active' }));
      mocks.resolveStore.mockResolvedValue(store('tenant-a', {}, queryOne));
      await listEnvironmentTenantDefaultStores(env(), { limit: 1 });
      expect(String((queryOne.mock.calls[0] as unknown[])[0])).not.toContain('lifecycle_state =');
    });

    it.each(['deleting', 'suspended', 'frozen', 'deleted'])(
      'omits a %s tenant by default and does not throw',
      async (state) => {
        mocks.resolveAliases.mockResolvedValue([alias('tenant-a'), alias('tenant-b')]);
        mocks.resolveStore.mockImplementation(stateOf({ 'tenant-a': state, 'tenant-b': 'active' }));
        const result = await listEnvironmentTenantDefaultStores(env(), { limit: 8 });
        expect(result.map((entry) => entry.tenantId)).toEqual(['tenant-b']);
      }
    );

    it('returns non-active tenants when asked to include them', async () => {
      mocks.resolveAliases.mockResolvedValue([alias('tenant-a'), alias('tenant-b')]);
      mocks.resolveStore.mockImplementation(
        stateOf({ 'tenant-a': 'deleting', 'tenant-b': 'suspended' })
      );
      const result = await listEnvironmentTenantDefaultStores(env(), {
        limit: 8,
        includeInactive: true,
      });
      expect(result.map((entry) => [entry.tenantId, entry.lifecycleState])).toEqual([
        ['tenant-a', 'deleting'],
        ['tenant-b', 'suspended'],
      ]);
    });

    it('still throws for a missing row when inactive tenants are included', async () => {
      mocks.resolveStore.mockResolvedValue(
        store(
          'tenant-a',
          {},
          vi.fn(async () => null)
        )
      );
      await expect(
        listEnvironmentTenantDefaultStores(env(), { limit: 1, includeInactive: true })
      ).rejects.toThrow('environment_tenant_alias_destination_revalidation_failed');
    });

    it('refills a full alias page that skipped tenants so a short page means the end', async () => {
      const states: Record<string, string> = {
        a: 'deleting',
        b: 'deleting',
        c: 'active',
        d: 'active',
      };
      mocks.resolveStore.mockImplementation(stateOf(states));
      const universe = ['a', 'b', 'c', 'd'];
      mocks.resolveAliases.mockImplementation(
        async (input: { maximumResults: number; afterTenantId?: string }) =>
          universe
            .filter((id) => !input.afterTenantId || id > input.afterTenantId)
            .slice(0, input.maximumResults)
            .map(alias)
      );

      const first = await listEnvironmentTenantDefaultStores(env(), { limit: 2 });
      expect(first.map((entry) => entry.tenantId)).toEqual(['c', 'd']);
      // The page is full, so the caller continues after its last id and finds the end.
      const second = await listEnvironmentTenantDefaultStores(env(), {
        limit: 2,
        afterTenantId: 'd',
      });
      expect(second).toEqual([]);
    });

    it('returns a short page only when the aliases are exhausted', async () => {
      mocks.resolveStore.mockImplementation(stateOf({ a: 'deleting', b: 'active', c: 'deleting' }));
      const universe = ['a', 'b', 'c'];
      mocks.resolveAliases.mockImplementation(
        async (input: { maximumResults: number; afterTenantId?: string }) =>
          universe
            .filter((id) => !input.afterTenantId || id > input.afterTenantId)
            .slice(0, input.maximumResults)
            .map(alias)
      );
      const result = await listEnvironmentTenantDefaultStores(env(), { limit: 2 });
      expect(result.map((entry) => entry.tenantId)).toEqual(['b']);
    });

    const universeResolver = (universe: string[], calls: number[] = []) =>
      mocks.resolveAliases.mockImplementation(
        async (input: { maximumResults: number; afterTenantId?: string }) => {
          calls.push(input.maximumResults);
          return universe
            .filter((id) => !input.afterTenantId || id > input.afterTenantId)
            .slice(0, input.maximumResults)
            .map(alias);
        }
      );

    it('does not throw on a long run of inactive tenants and returns the next active ones', async () => {
      const universe = Array.from({ length: 100 }, (_, i) => `d-${String(i).padStart(3, '0')}`);
      const active = ['e-1', 'e-2'];
      const states: Record<string, string> = {};
      for (const id of universe) states[id] = 'deleting';
      for (const id of active) states[id] = 'active';
      mocks.resolveStore.mockImplementation(stateOf(states));
      const calls: number[] = [];
      universeResolver([...universe, ...active], calls);
      const result = await listEnvironmentTenantDefaultStores(env(), { limit: 8 });
      expect(result.map((entry) => entry.tenantId)).toEqual(active);
      expect(new Set(calls)).toEqual(new Set([8]));
    });

    it('stops mid-page at exactly limit entries and continues from the last id without skips or duplicates', async () => {
      const universe = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      mocks.resolveStore.mockImplementation(
        stateOf({
          a: 'active',
          b: 'deleting',
          c: 'active',
          d: 'active',
          e: 'deleting',
          f: 'active',
          g: 'active',
        })
      );
      universeResolver(universe);
      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 5; i += 1) {
        const page = await listEnvironmentTenantDefaultStores(env(), {
          limit: 2,
          afterTenantId: after,
        });
        expect(page.length).toBeLessThanOrEqual(2);
        seen.push(...page.map((entry) => entry.tenantId));
        if (page.length < 2) break;
        after = page[page.length - 1].tenantId;
      }
      expect(seen).toEqual(['a', 'c', 'd', 'f', 'g']);
    });

    it('reads exactly one alias page with includeInactive', async () => {
      const calls: number[] = [];
      mocks.resolveStore.mockImplementation(
        stateOf({ a: 'deleting', b: 'deleting', c: 'deleting' })
      );
      universeResolver(['a', 'b', 'c'], calls);
      const result = await listEnvironmentTenantDefaultStores(env(), {
        limit: 3,
        includeInactive: true,
      });
      expect(result).toHaveLength(3);
      expect(calls).toEqual([3]);
    });

    it('fails closed rather than return a misleading short page after too many skipped pages', async () => {
      let next = 0;
      mocks.resolveAliases.mockImplementation(async () => [
        alias(`t-${String(next++).padStart(4, '0')}`),
      ]);
      mocks.resolveStore.mockImplementation(async (_env, input: { tenantId: string }) =>
        store(
          input.tenantId,
          {},
          vi.fn(async () => ({ id: input.tenantId, lifecycle_state: 'deleting' }))
        )
      );
      await expect(listEnvironmentTenantDefaultStores(env(), { limit: 1 })).rejects.toThrow(
        'environment_tenant_directory_inactive_run_too_long'
      );
    });
  });

  describe('tenants whose route is not servable', () => {
    const alias = (tenantId: string) => ({ tenantId, routeProjection: projection });
    const failFor =
      (failing: Record<string, unknown>) => async (_env: unknown, input: { tenantId: string }) => {
        if (input.tenantId in failing) throw failing[input.tenantId];
        return store(input.tenantId);
      };
    const quarantined = () =>
      new TenantDatabaseResolverError('quarantined_route', 'Tenant database route is unavailable');

    it('skips a quarantined tenant and returns the others', async () => {
      mocks.resolveAliases.mockResolvedValue([alias('t-a'), alias('t-b'), alias('t-c')]);
      mocks.resolveStore.mockImplementation(failFor({ 't-b': quarantined() }));
      const result = await listEnvironmentTenantDefaultStores(env(), { limit: 8 });
      expect(result.map((entry) => entry.tenantId)).toEqual(['t-a', 't-c']);
    });

    it('skips them for includeInactive callers too', async () => {
      mocks.resolveAliases.mockResolvedValue([alias('t-a'), alias('t-b')]);
      mocks.resolveStore.mockImplementation(failFor({ 't-a': quarantined() }));
      const result = await listEnvironmentTenantDefaultStores(env(), {
        limit: 8,
        includeInactive: true,
      });
      expect(result.map((entry) => entry.tenantId)).toEqual(['t-b']);
    });

    it.each([
      new TenantDatabaseResolverError('missing_snapshot', 'bad'),
      new TenantDatabaseResolverError('invalid_snapshot_signature', 'bad'),
      new TenantDatabaseResolverError('missing_binding', 'bad'),
      new TenantDatabaseResolverError('snapshot_generation_propagating', 'bad'),
      new TenantDatabaseResolverError('route_generation_mismatch', 'bad'),
      new Error('quarantined_route:look-alike plain error'),
    ])('still throws for %s', async (error) => {
      mocks.resolveAliases.mockResolvedValue([alias('t-a'), alias('t-b')]);
      mocks.resolveStore.mockImplementation(failFor({ 't-b': error }));
      await expect(listEnvironmentTenantDefaultStores(env(), { limit: 8 })).rejects.toBe(error);
    });

    it("propagates the resolver error with unservableTenants: 'throw'", async () => {
      const error = quarantined();
      mocks.resolveAliases.mockResolvedValue([alias('t-a'), alias('t-b')]);
      mocks.resolveStore.mockImplementation(failFor({ 't-b': error }));
      await expect(
        listEnvironmentTenantDefaultStores(env(), { limit: 8, unservableTenants: 'throw' })
      ).rejects.toBe(error);
    });

    it('advances the cursor past a full page of skipped tenants and terminates', async () => {
      const pages: Record<string, string[]> = {
        '': ['t-1', 't-2'],
        't-2': ['t-3', 't-4'],
        't-4': ['t-5'],
      };
      mocks.resolveAliases.mockImplementation(async (input: { afterTenantId?: string }) =>
        (pages[input.afterTenantId ?? ''] ?? []).map(alias)
      );
      mocks.resolveStore.mockImplementation(
        failFor({ 't-1': quarantined(), 't-2': quarantined(), 't-3': quarantined() })
      );
      const result = await listEnvironmentTenantDefaultStores(env(), { limit: 2 });
      expect(result.map((entry) => entry.tenantId)).toEqual(['t-4', 't-5']);
      expect(mocks.resolveAliases).toHaveBeenCalledTimes(3);
    });

    it('stays bounded when every page is skipped', async () => {
      let next = 0;
      mocks.resolveAliases.mockImplementation(async () => [
        alias(`t-${String(next++).padStart(4, '0')}`),
      ]);
      mocks.resolveStore.mockRejectedValue(quarantined());
      await expect(listEnvironmentTenantDefaultStores(env(), { limit: 1 })).rejects.toThrow(
        'environment_tenant_directory_inactive_run_too_long'
      );
      expect(mocks.resolveAliases).toHaveBeenCalledTimes(64);
    });
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
