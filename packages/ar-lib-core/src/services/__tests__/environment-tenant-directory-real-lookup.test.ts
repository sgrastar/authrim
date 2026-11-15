import { describe, expect, it, vi } from 'vitest';
import { sqliteAliasD1 } from '../lookup-directory/__tests__/sqlite-alias-d1';

/**
 * The tenant directory over the real lookup resolver and repository (a real SQLite alias table):
 * only the blind index, the verified bucket assignment and the Registry store resolution are
 * replaced. A page boundary must come back as a full page, not as an error.
 */
const ALIAS_INDEX = { aliasKind: 'environment_tenant', digest: 'c'.repeat(64), virtualBucket: 7 };
const projection = {
  schemaVersion: 1,
  tenantRouteGeneration: 1,
  residencyPolicyId: 'p',
  target: {
    dataRole: 'tenant_core/default',
    residencyPartition: 'r',
    shardId: 'tenant-default-1',
    bindingRef: 'TEST_TDB_TENANT_DEFAULT_0001',
    requiredBindingRouteGeneration: 1,
  },
};
const state = vi.hoisted(() => ({ inactive: new Set<string>() }));

vi.mock('../lookup-directory/blind-index', () => ({
  createLookupAliasIndex: async () => ({
    aliasKind: 'environment_tenant',
    digest: 'c'.repeat(64),
    virtualBucket: 7,
  }),
}));
vi.mock('../lookup-directory/shard-registry', () => ({
  loadVerifiedLookupBucketAssignmentProvider: async () => ({
    resolveActiveAssignment: async () => ({
      virtualBucket: 7,
      assignmentGeneration: 1,
      lookupShardId: 'lookup-1',
      bindingRef: 'LOOKUP_SHARD_0001',
      state: 'active',
    }),
  }),
}));
vi.mock('../tenant-database-resolver', () => ({
  resolveTenantDatabaseSourceFromRegistry: async (_env: unknown, input: { tenantId: string }) => ({
    bindingRouteGeneration: 1,
    residencyPolicyId: 'p',
    residencyPartition: 'r',
    shardId: 'tenant-default-1',
    bindingRef: 'TEST_TDB_TENANT_DEFAULT_0001',
    source: {
      query: async () => [],
      queryOne: async () => ({
        id: input.tenantId,
        lifecycle_state: state.inactive.has(input.tenantId) ? 'deleting' : 'active',
      }),
      execute: async () => ({ success: true, rowsAffected: 0 }),
      transaction: async () => undefined,
      batch: async () => [],
      isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
      getType: () => 'test',
      close: async () => undefined,
    },
  }),
}));

import { listEnvironmentTenantDefaultStores } from '../environment-tenant-directory';

const ids = Array.from({ length: 9 }, (_, i) => `tenant-${i}`);

function env() {
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY: {},
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
    LOOKUP_SHARD_0001: sqliteAliasD1(
      ids.map((tenantId) => ({
        tenantId,
        virtualBucket: ALIAS_INDEX.virtualBucket,
        aliasKind: ALIAS_INDEX.aliasKind,
        digest: ALIAS_INDEX.digest,
        projectionJson: JSON.stringify(projection),
      }))
    ),
  } as never;
}

async function walk(options: { limit: number; includeInactive?: boolean }) {
  const e = env();
  const seen: string[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await listEnvironmentTenantDefaultStores(e, { ...options, afterTenantId: after });
    seen.push(...page.map((entry) => entry.tenantId));
    if (page.length < options.limit) return seen;
    after = page[page.length - 1].tenantId;
  }
  throw new Error('did not terminate');
}

describe('listEnvironmentTenantDefaultStores over the real lookup repository', () => {
  it('returns a full page when more aliases follow, and the cursor walks all of them', async () => {
    state.inactive = new Set();
    const first = await listEnvironmentTenantDefaultStores(env(), { limit: 8 });
    expect(first.map((entry) => entry.tenantId)).toEqual(ids.slice(0, 8));
    expect(await walk({ limit: 8 })).toEqual(ids);
  });

  it('skips inactive tenants across page boundaries without skipping or duplicating', async () => {
    state.inactive = new Set(['tenant-1', 'tenant-2', 'tenant-3', 'tenant-6']);
    expect(await walk({ limit: 2 })).toEqual([
      'tenant-0',
      'tenant-4',
      'tenant-5',
      'tenant-7',
      'tenant-8',
    ]);
    expect(await walk({ limit: 2, includeInactive: true })).toEqual(ids);
  });
});
