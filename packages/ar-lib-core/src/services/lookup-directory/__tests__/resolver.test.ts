import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupAliasIndex, LookupBlindIndex } from '../blind-index';
import {
  clearLookupRouteMemoryCache,
  LookupRouteResolver,
  type ActiveLookupBucketAssignment,
} from '../resolver';

const INDEX: LookupBlindIndex = {
  indexKind: 'account_id',
  normalizationVersion: 1,
  hmacKeyGeneration: 2,
  digest: 'a'.repeat(64),
  virtualBucket: 42,
};

const PROJECTION = {
  schemaVersion: 1,
  accountRouteGeneration: 3,
  residencyPolicyId: 'default-policy',
  targets: [
    {
      dataRole: 'tenant_core/users' as const,
      residencyPartition: 'default',
      shardId: 'users-1',
      bindingRef: 'TEST_TDB_USERS_0001_CORE',
      requiredBindingRouteGeneration: 8,
    },
  ],
};

const ALIAS_INDEX: LookupAliasIndex = {
  aliasKind: 'tenant_code',
  digest: 'b'.repeat(64),
  virtualBucket: 42,
};

const ALIAS_PROJECTION = {
  schemaVersion: 1,
  tenantRouteGeneration: 8,
  residencyPolicyId: 'default-policy',
  target: {
    dataRole: 'tenant_core/default' as const,
    residencyPartition: 'default',
    shardId: 'default-1',
    bindingRef: 'TEST_TDB_DEFAULT_0001',
    requiredBindingRouteGeneration: 8,
  },
};

function row(index: LookupBlindIndex = INDEX): Record<string, unknown> {
  return {
    virtual_bucket: index.virtualBucket,
    index_kind: index.indexKind,
    normalization_version: index.normalizationVersion,
    hmac_key_generation: index.hmacKeyGeneration,
    identifier_blind_digest: index.digest,
    tenant_id: 'tenant-a',
    account_id: 'account-a',
    route_schema_version: 1,
    account_route_generation: 3,
    required_binding_route_generation: 8,
    residency_policy_id: 'default-policy',
    route_projection_json: JSON.stringify(PROJECTION),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

function aliasRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    virtual_bucket: ALIAS_INDEX.virtualBucket,
    alias_kind: ALIAS_INDEX.aliasKind,
    alias_sha256_digest: ALIAS_INDEX.digest,
    tenant_id: 'tenant-a',
    route_schema_version: 1,
    route_projection_json: JSON.stringify(ALIAS_PROJECTION),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
    ...overrides,
  };
}

function session(rows: unknown[]): D1DatabaseSession {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn(async () => ({ success: true, results: rows, meta: {} })),
    })),
    batch: vi.fn(),
    getBookmark: vi.fn(() => 'bookmark'),
  } as unknown as D1DatabaseSession;
}

function database(...sessions: D1DatabaseSession[]): {
  binding: D1Database;
  withSession: ReturnType<typeof vi.fn>;
} {
  const withSession = vi.fn();
  for (const value of sessions) withSession.mockReturnValueOnce(value);
  return {
    binding: {
      prepare: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
      withSession,
    } as unknown as D1Database,
    withSession,
  };
}

function assignment(
  overrides: Partial<ActiveLookupBucketAssignment> = {}
): ActiveLookupBucketAssignment {
  return {
    virtualBucket: 42,
    assignmentGeneration: 5,
    lookupShardId: 'lookup-1',
    bindingRef: 'LOOKUP_SHARD_0001',
    state: 'active',
    ...overrides,
  };
}

function provider(value: ActiveLookupBucketAssignment) {
  return { resolveActiveAssignment: vi.fn(async () => value) };
}

describe('LookupRouteResolver', () => {
  beforeEach(() => clearLookupRouteMemoryCache());

  it('uses one physical Lookup D1 and a positive isolate cache keyed by assignment generation', async () => {
    const lookup = database(session([row()]));
    const assignments = provider(assignment());
    let now = 1_000;
    const resolver = new LookupRouteResolver({ LOOKUP_SHARD_0001: lookup.binding }, assignments, {
      now: () => now,
    });

    const first = await resolver.resolveMemberships({ indexes: [INDEX] });
    now += 60_000;
    const second = await resolver.resolveMemberships({ indexes: [INDEX] });

    expect(first).toEqual(second);
    expect(lookup.withSession).toHaveBeenCalledTimes(1);
    expect(assignments.resolveActiveAssignment).toHaveBeenCalledTimes(2);
  });

  it('does not create a cross-request negative cache', async () => {
    const lookup = database(session([]), session([]), session([]), session([]));
    const resolver = new LookupRouteResolver(
      { LOOKUP_SHARD_0001: lookup.binding },
      provider(assignment())
    );

    expect(await resolver.resolveMemberships({ indexes: [INDEX] })).toEqual([]);
    expect(await resolver.resolveMemberships({ indexes: [INDEX] })).toEqual([]);
    expect(lookup.withSession.mock.calls).toEqual([
      ['first-unconstrained'],
      ['first-primary'],
      ['first-unconstrained'],
      ['first-primary'],
    ]);
  });

  it('resolves tenant aliases from one physical Lookup D1 and caches only positive results', async () => {
    const positive = database(session([aliasRow()]));
    const positiveResolver = new LookupRouteResolver(
      { LOOKUP_SHARD_0001: positive.binding },
      provider(assignment())
    );
    const first = await positiveResolver.resolveAlias({ index: ALIAS_INDEX });
    const second = await positiveResolver.resolveAlias({ index: ALIAS_INDEX });
    expect(first).toEqual({ tenantId: 'tenant-a', routeProjection: ALIAS_PROJECTION });
    expect(second).toEqual(first);
    expect(positive.withSession).toHaveBeenCalledTimes(1);

    clearLookupRouteMemoryCache();
    const negative = database(session([]), session([]), session([]), session([]));
    const negativeResolver = new LookupRouteResolver(
      { LOOKUP_SHARD_0001: negative.binding },
      provider(assignment())
    );
    expect(await negativeResolver.resolveAlias({ index: ALIAS_INDEX })).toBeNull();
    expect(await negativeResolver.resolveAlias({ index: ALIAS_INDEX })).toBeNull();
    expect(negative.withSession.mock.calls).toEqual([
      ['first-unconstrained'],
      ['first-primary'],
      ['first-unconstrained'],
      ['first-primary'],
    ]);
  });

  it('returns a bounded multi-tenant alias set without cross-request caching', async () => {
    const lookup = database(
      session([aliasRow(), aliasRow({ tenant_id: 'tenant-b' })]),
      session([aliasRow(), aliasRow({ tenant_id: 'tenant-b' })])
    );
    const resolver = new LookupRouteResolver(
      { LOOKUP_SHARD_0001: lookup.binding },
      provider(assignment())
    );

    await expect(
      resolver.resolveAliases({ index: ALIAS_INDEX, maximumResults: 2 })
    ).resolves.toEqual([
      { tenantId: 'tenant-a', routeProjection: ALIAS_PROJECTION },
      { tenantId: 'tenant-b', routeProjection: ALIAS_PROJECTION },
    ]);
    await expect(
      resolver.resolveAliases({ index: ALIAS_INDEX, maximumResults: 1 })
    ).rejects.toThrow('lookup_alias_result_limit_exceeded');
  });

  it('passes an environment tenant pagination cursor to the repository', async () => {
    const lookup = database(session([aliasRow({ tenant_id: 'tenant-b' })]));
    const resolver = new LookupRouteResolver(
      { LOOKUP_SHARD_0001: lookup.binding },
      provider(assignment())
    );

    await expect(
      resolver.resolveAliases({
        index: ALIAS_INDEX,
        maximumResults: 2,
        afterTenantId: 'tenant-a',
      })
    ).resolves.toEqual([{ tenantId: 'tenant-b', routeProjection: ALIAS_PROJECTION }]);
    expect(lookup.withSession).toHaveBeenCalledWith('first-unconstrained');
  });

  it('reads both current and previous key buckets during rotation and deduplicates', async () => {
    const previous: LookupBlindIndex = {
      ...INDEX,
      hmacKeyGeneration: 1,
      digest: 'b'.repeat(64),
      virtualBucket: 84,
    };
    const currentDb = database(session([row()]));
    const previousDb = database(session([row(previous)]));
    const assignments = {
      resolveActiveAssignment: vi.fn(async (bucket: number) =>
        bucket === 42
          ? assignment()
          : assignment({
              virtualBucket: 84,
              assignmentGeneration: 6,
              lookupShardId: 'lookup-2',
              bindingRef: 'LOOKUP_SHARD_0002',
            })
      ),
    };
    const resolver = new LookupRouteResolver(
      { LOOKUP_SHARD_0001: currentDb.binding, LOOKUP_SHARD_0002: previousDb.binding },
      assignments
    );

    const result = await resolver.resolveMemberships({ indexes: [INDEX, previous] });
    expect(result).toHaveLength(1);
    expect(result[0].hmacKeyGeneration).toBe(2);
    expect(currentDb.withSession).toHaveBeenCalledTimes(1);
    expect(previousDb.withSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed for invalid assignment or unavailable physical binding', async () => {
    await expect(
      new LookupRouteResolver({}, provider(assignment())).resolveMemberships({ indexes: [INDEX] })
    ).rejects.toThrow('lookup_physical_binding_unavailable');

    await expect(
      new LookupRouteResolver({}, provider(assignment({ virtualBucket: 41 }))).resolveMemberships({
        indexes: [INDEX],
      })
    ).rejects.toThrow('lookup_bucket_assignment_invalid');
  });

  it('requires binding generation and destination revalidation even after lookup caching', async () => {
    const lookup = database(session([row()]));
    const tenant = database();
    const resolver = new LookupRouteResolver(
      {
        LOOKUP_SHARD_0001: lookup.binding,
        TEST_TDB_USERS_0001_CORE: tenant.binding,
      },
      provider(assignment())
    );
    const membership = (await resolver.resolveMemberships({ indexes: [INDEX] }))[0];

    expect(() =>
      resolver.resolveTarget({
        membership,
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        observedBindingRouteGenerations: { TEST_TDB_USERS_0001_CORE: 7 },
      })
    ).toThrow('lookup_route_binding_generation_stale');

    const verifier = vi.fn(async () => true);
    await resolver.resolveTargetAndRevalidate({
      membership,
      dataRole: 'tenant_core/users',
      residencyPartition: 'default',
      observedBindingRouteGenerations: { TEST_TDB_USERS_0001_CORE: 8 },
      verifyAtDestination: verifier,
    });
    expect(verifier).toHaveBeenCalledTimes(1);

    await expect(
      resolver.resolveTargetAndRevalidate({
        membership,
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        observedBindingRouteGenerations: { TEST_TDB_USERS_0001_CORE: 9 },
        verifyAtDestination: async () => false,
      })
    ).rejects.toThrow('lookup_destination_revalidation_failed');
  });
});
